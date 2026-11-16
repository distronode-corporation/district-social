import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * What pinterest.ts does when the vendor does not answer, answers with
 * something that is not JSON, or answers with a shape the happy path never
 * meets. pinterest-client.test.ts pins the happy paths and the base-URL
 * override; this file pins the refusals.
 *
 * Why the refusals are the interesting half here specifically: this app spent
 * months on Trial access, where every READ succeeded on production and only the
 * CREATE was refused (403 code 29). The lesson that outlived the tier upgrade is
 * that a green read proves nothing about a publish, so the thing worth pinning
 * is what an operator is TOLD when a publish does not happen.
 *
 *   - Two timeout budgets, deliberately different. A create carries the encoded
 *     image bytes in its own body and gets 120s; every read gets 15s. The
 *     number is in the message, so a log line saying "no response after 15s"
 *     during a publish means a lookup stalled, not the pin creation. Flattening
 *     them would erase the only evidence of which call hung.
 *   - ⛔ A create that times out may still have created the pin. The message
 *     says so in words, because the operator's next instinct is to retry and
 *     that is how an account ends up with two identical pins. retry.ts will not
 *     repeat it either (createPin runs under `rejected-only`).
 *   - A non-JSON body is a PinterestError, not a SyntaxError. Every transport
 *     above this file branches on `instanceof PinterestError`; a raw
 *     SyntaxError escapes all of it as an unclassified crash, which is how a
 *     proxy interstitial turns into a red monitor with no vendor detail.
 *   - An unreadable metric is ABSENT, never 0. On a dashboard a fabricated 0
 *     reads as a pin nobody engaged with, which is a real and wrong conclusion.
 */

import {
  PinterestError,
  setPinterestTokenResolver,
  createPin,
  getPin,
  deletePin,
  listBoards,
  getPinAnalytics,
} from "../pinterest.js";

const TOKEN = "test-access-token";

/** A fetch-mock-shaped Response carrying a raw, not-necessarily-JSON body. */
function textResponse(status: number, body: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    text: async () => body,
  } as unknown as Response;
}

function jsonResponse(status: number, body: unknown): Response {
  return textResponse(status, JSON.stringify(body));
}

/** A timeout as `AbortSignal.timeout` raises it: an Error whose NAME is the signal. */
function timeoutError(): Error {
  const err = new Error("The operation was aborted due to timeout");
  err.name = "TimeoutError";
  return err;
}

const ONE_IMAGE = [{ contentType: "image/png" as const, data: "YmFzZTY0" }];

let fetchMock: ReturnType<typeof vi.fn>;

/** The JSON body of the nth fetch call, parsed. */
function bodyOfCall(index: number): Record<string, unknown> {
  return JSON.parse(String((fetchMock.mock.calls[index][1] as RequestInit).body));
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  setPinterestTokenResolver(async () => TOKEN);
});

afterEach(() => {
  setPinterestTokenResolver(null);
  vi.unstubAllGlobals();
});

describe("what a failure that never reached Pinterest looks like", () => {
  /**
   * ⛔ THE WORDING IS THE POINT. An aborted create says nothing about whether
   * Pinterest made the pin, so the message pushes the operator to CHECK rather
   * than retry. A blind retry here is how a brand account gets two identical
   * pins, which nothing above this file can undo.
   */
  it("names the 120s create budget and warns the pin may exist anyway when a create times out", async () => {
    fetchMock.mockRejectedValue(timeoutError());

    const err = await createPin({ boardId: "board-1", images: ONE_IMAGE }).catch((e) => e);
    expect(err).toBeInstanceOf(PinterestError);
    expect(err.message).toMatch(/no response after 120s/);
    expect(err.message).toMatch(/may still complete server-side; check before retrying a publish/);
    expect(err.status).toBe(0);
    expect(err.retryAfter).toBeNull();
  });

  /**
   * ⚠️ The SAME code path, a different budget. 15s in a log line means a light
   * call stalled (a lookup, a delete, a board list); 120s means the create did.
   * Collapsing the two constants into one would make a stalled publish
   * indistinguishable from a stalled read.
   */
  it("names the 15s read budget when a lighter call times out, so the log says which call hung", async () => {
    fetchMock.mockRejectedValue(timeoutError());

    const err = await getPin("pin-1").catch((e) => e);
    expect(err).toBeInstanceOf(PinterestError);
    expect(err.message).toMatch(/no response after 15s/);
    expect(err.message).not.toMatch(/120s/);
    expect(err.status).toBe(0);
  });

  /**
   * ⚠️ A dropped connection is NOT a timeout. Both are status 0, so the message
   * carries the whole distinction: this one has the operating system's reason,
   * the ones above have our budget. The method and path stay in it either way,
   * which is the only way to tell from a log which endpoint died.
   */
  it("reports a dropped connection with the underlying reason rather than as a timeout", async () => {
    fetchMock.mockRejectedValue(new Error("read ECONNRESET"));

    const err = await getPin("pin-1").catch((e) => e);
    expect(err).toBeInstanceOf(PinterestError);
    expect(err.message).toBe("Pinterest GET /pins/pin-1 -> 0: read ECONNRESET");
    expect(err.message).not.toMatch(/no response after/);
    expect(err.status).toBe(0);
  });

  /**
   * ⚠️ fetch can reject with something that is not an Error at all (a polyfill,
   * an SDK, a bare `throw`). Stringifying keeps a readable message instead of an
   * empty one or "[object Object]".
   */
  it("keeps a non-Error rejection readable instead of losing it", async () => {
    fetchMock.mockRejectedValue("socket hang up");

    const err = await deletePin("pin-1").catch((e) => e);
    expect(err).toBeInstanceOf(PinterestError);
    expect(err.message).toBe("Pinterest DELETE /pins/pin-1 -> 0: socket hang up");
    expect(err.status).toBe(0);
  });
});

describe("bodies that are not what the endpoint documents", () => {
  /**
   * The documented success for a delete is 204 with no body, and that is
   * already pinned. This is the OTHER empty answer: a 200 (or a proxy's 200)
   * with an empty body. `JSON.parse("")` throws, so without the empty-body
   * check an already-successful delete would surface as a parse failure and the
   * transport would report a delete that actually happened as failed.
   */
  it("treats an ok response with an empty body as no content rather than a parse failure", async () => {
    fetchMock.mockResolvedValueOnce(textResponse(200, ""));
    await expect(deletePin("pin-1")).resolves.toBeUndefined();
  });

  /**
   * ⛔ A PROXY INTERSTITIAL ANSWERED WITH 200 IS THE LIKELY CASE, and it must
   * still arrive as a PinterestError. Everything above this file branches on
   * `instanceof PinterestError`; a raw SyntaxError from JSON.parse slips past
   * all of it, so the publish leg would crash unclassified instead of being
   * reported against the endpoint that produced it.
   */
  it("turns a non-JSON 200 into a PinterestError naming the method, the path and the body", async () => {
    fetchMock.mockResolvedValueOnce(textResponse(200, "<html><body>Access denied</body></html>"));

    const err = await getPin("pin-1").catch((e) => e);
    expect(err).toBeInstanceOf(PinterestError);
    expect(err.message).toMatch(/expected JSON, got: <html>/);
    expect(err.message).toMatch(/Pinterest GET \/pins\/pin-1 -> 200/);
    expect(err.status).toBe(200);
  });
});

/**
 * ⛔ THE VENDOR'S FIELD NAMES, NOT OURS. Pinterest calls the destination `link`
 * (not `url`) and the accessibility label `alt_text`. Pinterest ignores unknown
 * POST fields rather than rejecting them, so getting either name wrong creates
 * the pin successfully with no destination and no description, and nothing
 * anywhere reports it. That is the same failure shape as the Facebook
 * `alt_text_custom` trap in alt-text-remaining.test.ts.
 */
describe("createPin optional fields", () => {
  it("sends the destination under the vendor's own `link` name, and never as `url`", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { id: "pin-1", board_id: "board-1" }));

    await createPin({
      boardId: "board-1",
      link: "https://example.com/pricing",
      images: ONE_IMAGE,
    });

    const body = bodyOfCall(0);
    expect(body.link).toBe("https://example.com/pricing");
    expect("url" in body).toBe(false);
  });

  it("sends alt text as alt_text so a pin is not published undescribed", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { id: "pin-1", board_id: "board-1" }));

    await createPin({
      boardId: "board-1",
      altText: "a screenshot of the Acme dashboard",
      images: ONE_IMAGE,
    });

    expect(bodyOfCall(0).alt_text).toBe("a screenshot of the Acme dashboard");
  });

  it("omits link and alt_text entirely when the draft has neither, rather than sending empty strings", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { id: "pin-1", board_id: "board-1" }));

    await createPin({ boardId: "board-1", images: ONE_IMAGE });

    const body = bodyOfCall(0);
    expect("link" in body).toBe(false);
    expect("alt_text" in body).toBe(false);
  });
});

/**
 * ⛔ PAGINATION IS NOT OPTIONAL HERE, and an itemless page is the case that
 * would quietly break it. Callers judge "does this board exist" by scanning the
 * whole returned list, so a board sitting behind a page that happened to carry
 * no `items` key would read as UNKNOWN and wrongly refuse a publish. Stopping
 * on a missing `items` (or crashing on it) is therefore the same bug as
 * stopping after page one.
 */
describe("listBoards against pages that are not the documented shape", () => {
  it("keeps following the cursor through a page that carries no items array", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { bookmark: "cursor-1" }))
      .mockResolvedValueOnce(jsonResponse(200, { items: [{ id: "b2", name: "Board Two" }], bookmark: null }));

    await expect(listBoards()).resolves.toEqual([{ id: "b2", name: "Board Two" }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain("bookmark=cursor-1");
  });

  it("returns an empty list, not a crash, when the only page has no items at all", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { bookmark: null }));
    await expect(listBoards()).resolves.toEqual([]);
  });
});

/**
 * ⚠️ ABSENT AND ZERO ARE DIFFERENT CLAIMS AND THEY ARE THE SAME LINE OF CODE.
 * A vendor-reported 0 is a real datum (nobody clicked). A value this client
 * cannot read is not a datum at all, and reporting it as 0 tells an operator
 * their pin failed to land when in fact the number was never received.
 */
describe("analytics values that cannot be read", () => {
  it("reports an empty metric bag when the analytics endpoint answers with no body", async () => {
    // Object.entries(undefined) would throw, failing the whole analytics sweep
    // for every other platform in the same run.
    fetchMock.mockResolvedValueOnce(textResponse(200, ""));
    await expect(getPinAnalytics("pin-1")).resolves.toEqual({});
  });

  it("reports an empty metric bag when the payload is JSON null rather than an object", async () => {
    fetchMock.mockResolvedValueOnce(textResponse(200, "null"));
    await expect(getPinAnalytics("pin-1")).resolves.toEqual({});
  });

  it("omits a metric that is not a finite number, while keeping a genuine zero", async () => {
    // ⚠️ `1e999` is built as RAW TEXT on purpose: JSON.stringify(Infinity)
    // emits `null`, so there is no way to reach the Number.isFinite half of the
    // guard through a stringified fixture.
    fetchMock.mockResolvedValueOnce(
      textResponse(
        200,
        '{"ALL":{"summary_metrics":{"IMPRESSION":5,"OUTBOUND_CLICK":0,"SAVE":"12","PIN_CLICK":null,"TOTAL":1e999}}}',
      ),
    );

    const bag = await getPinAnalytics("pin-1");
    expect(bag).toEqual({ IMPRESSION: 5, OUTBOUND_CLICK: 0 });
    for (const absent of ["SAVE", "PIN_CLICK", "TOTAL"]) {
      expect(absent in bag).toBe(false);
    }
  });
});
