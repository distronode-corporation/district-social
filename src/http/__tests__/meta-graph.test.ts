import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import {
  META_GRAPH_VERSION,
  MetaGraphError,
  appsecretProof,
  graphRequest,
  metaCredentials,
  setMetaCredentialsResolver,
  toMetricBag,
  fetchInsights,
  getInstagramUserInsights,
  getInstagramFollowers,
  ruploadHostedVideo,
  RUPLOAD_TIMEOUT_MS,
} from "../meta-graph.js";

const TOKEN = "page-token-abc";
const SECRET = "app-secret-xyz";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => jsonResponse({ id: "123" }));
  vi.stubGlobal("fetch", fetchMock);
  setMetaCredentialsResolver(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  setMetaCredentialsResolver(null);
});

describe("appsecretProof", () => {
  it("is HMAC-SHA256 of the token under the app secret, hex", () => {
    // Computed independently rather than by calling the function under test, so
    // a change to the algorithm fails here instead of agreeing with itself.
    const expected = createHmac("sha256", SECRET).update(TOKEN).digest("hex");
    expect(appsecretProof(TOKEN, SECRET)).toBe(expected);
    expect(appsecretProof(TOKEN, SECRET)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("graphRequest", () => {
  it("pins the API version in the path rather than calling unversioned", async () => {
    // The dashboard's "Upgrade all calls" setting only rewrites UNVERSIONED
    // requests, so this assertion is what stops a browser dropdown from
    // changing production behaviour.
    await graphRequest("me/feed", { accessToken: TOKEN, appSecret: SECRET });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url.startsWith(`https://graph.facebook.com/${META_GRAPH_VERSION}/me/feed?`)).toBe(true);
  });

  it("attaches appsecret_proof to a GET, in the query string", async () => {
    await graphRequest("me", { accessToken: TOKEN, appSecret: SECRET });
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get("appsecret_proof")).toBe(appsecretProof(TOKEN, SECRET));
    expect(url.searchParams.get("access_token")).toBe(TOKEN);
  });

  it("attaches appsecret_proof to a POST, in the body, not the request line", async () => {
    // Captions and image URLs are long; keeping them out of the URL is why
    // writes use a form body at all.
    await graphRequest("123/feed", {
      method: "POST",
      params: { message: "hello" },
      accessToken: TOKEN,
      appSecret: SECRET,
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).not.toContain("appsecret_proof");
    const body = new URLSearchParams(String((init as RequestInit).body));
    expect(body.get("appsecret_proof")).toBe(appsecretProof(TOKEN, SECRET));
    expect(body.get("message")).toBe("hello");
  });

  it("sends the proof even though 'Require app secret' is off, so the toggle is safe to flip", async () => {
    // The whole point of the unconditional implementation. If this ever becomes
    // conditional, flipping the dashboard toggle breaks publishing with no
    // deploy to blame.
    await graphRequest("me", { accessToken: TOKEN, appSecret: SECRET });
    expect(String(fetchMock.mock.calls[0][0])).toContain("appsecret_proof=");
  });

  it("omits undefined params instead of sending the string 'undefined'", async () => {
    await graphRequest("123/feed", {
      method: "POST",
      params: { message: "hi", link: undefined },
      accessToken: TOKEN,
      appSecret: SECRET,
    });
    const body = new URLSearchParams(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body.has("link")).toBe(false);
  });

  it("decodes Meta's error envelope even on an HTTP 200", async () => {
    // Graph does return errors with a 200 in some paths, so status alone is not
    // a sufficient success check.
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        error: {
          message: "Invalid OAuth access token",
          type: "OAuthException",
          code: 190,
          error_subcode: 460,
          fbtrace_id: "AbCd",
        },
      }),
    );
    await expect(
      graphRequest("me", { accessToken: TOKEN, appSecret: SECRET }),
    ).rejects.toMatchObject({
      name: "MetaGraphError",
      code: 190,
      subcode: 460,
      type: "OAuthException",
      traceId: "AbCd",
    });
  });

  it("turns a non-JSON body into a status-shaped error rather than throwing SyntaxError", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("<html>502 Bad Gateway</html>", { status: 502 }),
    );
    const err: unknown = await graphRequest("me", {
      accessToken: TOKEN,
      appSecret: SECRET,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MetaGraphError);
    // `toBeInstanceOf` does not narrow for the compiler, so the narrowing is
    // restated here. It cannot mask a wrong type: the assertion above already
    // failed the test if this is not a MetaGraphError.
    const graphErr = err as MetaGraphError;
    expect(graphErr.status).toBe(502);
    expect(graphErr.retryable).toBe(true);
  });
});

describe("MetaGraphError classification", () => {
  const make = (code: number | null, status = 400) =>
    new MetaGraphError("x", status, code, null, null, null);

  it("treats rate limits and transient service errors as retryable", () => {
    for (const code of [1, 2, 4, 17, 32, 613]) {
      expect(make(code).retryable).toBe(true);
    }
    expect(make(null, 503).retryable).toBe(true);
  });

  it("does NOT treat a permissions or validation error as retryable", () => {
    // Marking these retryable would let postFacts answer QUEUE forever on a post
    // that is never coming back.
    for (const code of [100, 200, 190, 368]) {
      expect(make(code).retryable).toBe(false);
    }
  });

  it("flags dead-token codes as needing a human, not a retry", () => {
    for (const code of [190, 102, 10, 200]) {
      expect(make(code).needsReauth).toBe(true);
    }
    expect(make(4).needsReauth).toBe(false);
  });
});

describe("metaCredentials", () => {
  it("refuses with a directive error when no resolver is registered", async () => {
    await expect(metaCredentials()).rejects.toThrow(/setMetaCredentialsResolver/);
  });

  it("returns whatever the app layer injected", async () => {
    setMetaCredentialsResolver(async () => ({
      appSecret: SECRET,
      pageToken: TOKEN,
      pageId: "page-1",
    }));
    await expect(metaCredentials()).resolves.toMatchObject({ pageId: "page-1" });
  });
});

/**
 * The request timeout.
 *
 * ⛔ graphRequest was the ONLY vendor client in the engine without one — every
 * other client (linkedin.ts, x.ts, pinterest.ts, reddit.ts, youtube.ts,
 * threads.ts, bluesky.ts) bounds its requests. A stalled connection to
 * graph.facebook.com therefore hung the caller forever instead of failing, and
 * the worst case is on the write path: a publish that hangs AFTER Meta accepted
 * the create leaves a live post on the Page whose id we never received, so
 * nothing downstream can find it to delete or reconcile.
 */
describe("graphRequest request timeout", () => {
  it("passes an abort signal on every call", async () => {
    await graphRequest("me", { accessToken: TOKEN, appSecret: SECRET });
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  /**
   * Surfacing it as MetaGraphError rather than a bare DOMException is the whole
   * point: callers branch on `instanceof MetaGraphError`, so an unwrapped abort
   * would slip past every one of them as an unclassified crash.
   */
  it("reports a timeout as a MetaGraphError, not a raw DOMException", async () => {
    fetchMock.mockImplementation(async () => {
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      throw err;
    });

    await expect(
      graphRequest("123/feed", { method: "POST", accessToken: TOKEN, appSecret: SECRET }),
    ).rejects.toBeInstanceOf(MetaGraphError);
  });

  /**
   * An aborted request says NOTHING about whether Meta processed it, so the
   * message has to push the operator to check rather than retry — retrying a
   * publish blindly is how you end up with two posts.
   */
  it("tells the operator the write may have landed anyway", async () => {
    fetchMock.mockImplementation(async () => {
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      throw err;
    });

    await expect(
      graphRequest("123/feed", { method: "POST", accessToken: TOKEN, appSecret: SECRET }),
    ).rejects.toThrow(
      "Meta POST 123/feed: no response after 15s (the request may still complete server-side; check before retrying a publish)",
    );
  });

  /**
   * ⛔ A non-timeout failure keeps its message but arrives TYPED, with status 0.
   * It used to be rethrown raw, so every caller's `instanceof MetaGraphError`
   * missed it, and retry.ts could not read it as an unknown outcome.
   */
  it("wraps an unrelated fetch error as a status-0 MetaGraphError", async () => {
    fetchMock.mockImplementation(async () => {
      throw new Error("ECONNREFUSED");
    });

    await expect(
      graphRequest("me", { accessToken: TOKEN, appSecret: SECRET }),
    ).rejects.toMatchObject({ name: "MetaGraphError", status: 0, message: "ECONNREFUSED" });
  });
});

/**
 * Graph bodies that omit the fields the happy path reads. Each one must still
 * produce either a usable value or a classifiable MetaGraphError.
 */
describe("graphRequest: sparse and empty bodies", () => {
  it("reads an empty 200 body as an empty object rather than a parse failure", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 200 }));
    await expect(graphRequest("123", { method: "DELETE", accessToken: TOKEN, appSecret: SECRET })).resolves.toEqual({});
  });

  it("builds a status-only error from a non-2xx with no error envelope", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 503 }));
    const err = (await graphRequest("me", { accessToken: TOKEN, appSecret: SECRET }).catch((e: unknown) => e)) as MetaGraphError;
    expect(err).toBeInstanceOf(MetaGraphError);
    expect(err.message).toBe("Meta request failed with HTTP 503");
    expect(err).toMatchObject({ status: 503, code: null, subcode: null, type: null, traceId: null });
  });

  it("drops a non-numeric code and subcode instead of passing strings through as codes", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: "odd", code: "190", error_subcode: "460" } }, 400));
    const err = (await graphRequest("me", { accessToken: TOKEN, appSecret: SECRET }).catch((e: unknown) => e)) as MetaGraphError;
    expect(err).toMatchObject({ message: "odd", status: 400, code: null, subcode: null });
    // A string "190" must not be read as the dead-token code.
    expect(err.needsReauth).toBe(false);
  });
});

describe("insights parsing", () => {
  it("skips a row with no metric name and keeps the named ones", () => {
    expect(
      toMetricBag([
        { values: [{ value: 7 }] },
        { name: "reach", total_value: { value: 12 } },
        { name: "views", values: [{ value: 3 }] },
        { name: "likes", values: [{ value: "n/a" }] },
      ]),
    ).toEqual({ reach: 12, views: 3 });
  });

  it("answers an empty bag when Meta returns no data array at all", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    await expect(
      fetchInsights("1/insights", { metric: "reach" }, { pageToken: TOKEN, appSecret: SECRET }),
    ).resolves.toEqual({});
  });
});

describe("Instagram account reads without a linked IG account", () => {
  beforeEach(() => {
    setMetaCredentialsResolver(async () => ({ appSecret: SECRET, pageToken: TOKEN, pageId: "page-1" }));
  });

  it("refuses user insights before calling Graph", async () => {
    await expect(getInstagramUserInsights()).rejects.toThrow(/no Instagram business account is linked/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses the follower count before calling Graph", async () => {
    await expect(getInstagramFollowers()).rejects.toThrow(/no Instagram business account is linked/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("ruploadHostedVideo", () => {
  const CLIP = "https://media.example.com/social-hq/assets/v1/clip.mp4";
  const AUTH = { accessToken: TOKEN, appSecret: SECRET };

  function textResponse(body: string, status: number, headers: Record<string, string> = {}): Response {
    return new Response(body, { status, headers });
  }

  it("POSTs to the version-pinned rupload path with the OAuth and file_url headers and the proof", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true }));
    await expect(ruploadHostedVideo("v1", CLIP, AUTH)).resolves.toBeUndefined();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsed = new URL(url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe(`https://rupload.facebook.com/video-upload/${META_GRAPH_VERSION}/v1`);
    expect(parsed.searchParams.get("appsecret_proof")).toBe(createHmac("sha256", SECRET).update(TOKEN).digest("hex"));
    // The token travels in the header only, never on the request line.
    expect(parsed.searchParams.has("access_token")).toBe(false);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ authorization: `OAuth ${TOKEN}`, file_url: CLIP });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.body).toBeUndefined();
    expect(RUPLOAD_TIMEOUT_MS).toBe(120_000);
  });

  it("encodes the video id into the path", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true }));
    await ruploadHostedVideo("a/b", CLIP, AUTH);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/video-upload/" + META_GRAPH_VERSION + "/a%2Fb?");
  });

  it("decodes rupload's own debug_info failure body", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ debug_info: { retriable: false, type: "ProcessingFailedError", message: "unauthorized user request" } }, 400),
    );
    const err = await ruploadHostedVideo("v1", CLIP, AUTH).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MetaGraphError);
    expect(err).toMatchObject({
      message: "unauthorized user request",
      status: 400,
      code: null,
      subcode: null,
      type: "ProcessingFailedError",
      traceId: null,
      retryAfter: null,
    });
  });

  it("decodes a Graph error envelope, Retry-After included", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { message: "(#4) limit", type: "OAuthException", code: 4, error_subcode: 2446079, fbtrace_id: "t1" } }),
        { status: 400, headers: { "retry-after": "30" } },
      ),
    );
    const err = (await ruploadHostedVideo("v1", CLIP, AUTH).catch((e: unknown) => e)) as MetaGraphError;
    expect(err).toMatchObject({ message: "(#4) limit", code: 4, subcode: 2446079, type: "OAuthException", traceId: "t1", retryAfter: "30" });
    expect(err.rateLimited).toBe(true);
  });

  it("treats a 200 without success:true as a failure, using its message when present", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: false, message: "Upload failed." }));
    await expect(ruploadHostedVideo("v1", CLIP, AUTH)).rejects.toThrow("Upload failed.");
  });

  it("falls back to a status-shaped message on an empty body", async () => {
    fetchMock.mockResolvedValueOnce(textResponse("", 502));
    const err = await ruploadHostedVideo("v1", CLIP, AUTH).catch((e: unknown) => e);
    expect(err).toMatchObject({ message: "Meta's Reels upload for video v1 failed with HTTP 502", status: 502, type: null });
    expect((err as MetaGraphError).retryable).toBe(true);
  });

  it("turns a non-JSON body into a status-shaped MetaGraphError", async () => {
    fetchMock.mockResolvedValueOnce(textResponse("<html>bad gateway</html>", 502));
    await expect(ruploadHostedVideo("v1", CLIP, AUTH)).rejects.toMatchObject({
      name: "MetaGraphError",
      status: 502,
      message: expect.stringContaining("non-JSON response (502): <html>bad gateway"),
    });
  });

  it("reports its own timeout as a MetaGraphError that says the upload may have landed", async () => {
    fetchMock.mockImplementation(async () => {
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      throw err;
    });
    const err = await ruploadHostedVideo("v1", CLIP, AUTH).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MetaGraphError);
    expect((err as Error).message).toBe(
      "Meta Reels upload for video v1: no response after 120s (the request may still complete server-side; check before retrying a publish)",
    );
  });

  it("⛔ wraps an unrelated fetch error as a status-0 MetaGraphError rather than rethrowing it raw", async () => {
    fetchMock.mockImplementation(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(ruploadHostedVideo("v1", CLIP, AUTH)).rejects.toMatchObject({
      name: "MetaGraphError",
      status: 0,
      message: "ECONNREFUSED",
    });
  });
});
