// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ResponseShapeError } from "../http/shape.js";
import { isUnknownOutcome } from "../http/retry.js";

/**
 * The half of threads.ts a caller only meets when something went wrong, and the
 * two decisions above it that are made from what this file returns.
 *
 * threads-client.test.ts pins the happy paths. This file pins the parts where
 * being wrong is silent:
 *
 *   - `rateLimited` is the ONLY thing that lets retry.ts re-send a CREATE.
 *     `isRejection` consults it, and `withRetry(..., "rejected-only", ...)`
 *     wraps every publishNow. Widening it to cover API_UNKNOWN (1) or
 *     API_SERVICE (2) would re-send a container create whose first attempt may
 *     already have posted, which on a brand account is a visible duplicate that
 *     nobody can undo. Narrowing it below the four rate-limit codes fails the
 *     leg outright on a limit that would have lifted in seconds.
 *   - `publishContainer` refusing an id-less response is what keeps a THREAD a
 *     thread. threads-transport.ts's chain loop does `parentId = published.id`
 *     and hands that straight to the next `createContainer({ replyToId })`.
 *     `request()` drops undefined params, so an undefined id would silently
 *     erase `reply_to_id` and the follow-up would post as a brand new top-level
 *     post rather than a reply, with `selfRef: { id: undefined }` poisoning
 *     every later release. Same family as the publish-due bug where a draft was
 *     called published while its replies were still queued: the damage is not an
 *     exception, it is a chain that quietly is not one.
 *   - `getContainerStatus` defaulting to IN_PROGRESS is a refusal to guess.
 *     Defaulting the other way would call `threads_publish` on a container
 *     Threads had not finished fetching the image for.
 *
 * The other theme is what an operator reads at 3am. status 0 means the request
 * never reached Threads; a real HTTP status means Threads answered. The message
 * is the only thing separating "our 15s budget expired" from "the connection
 * dropped", and both are status 0.
 */

import {
  ThreadsError,
  setThreadsCredentialsResolver,
  createContainer,
  publishContainer,
  getContainerStatus,
  pollContainerUntilFinished,
  getPermalink,
  getMediaInsights,
  getUserInsights,
  ALT_TEXT_MAX_CHARS,
} from "../threads.js";
import { isRejection } from "../retry.js";

const TOKEN = "threads-user-token-abc";
const SECRET = "threads-app-secret-xyz";
const USER_ID = "17841400000000000";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A timeout as `AbortSignal.timeout` raises it: an Error whose NAME is the signal. */
function timeoutError(): Error {
  const err = new Error("The operation was aborted due to timeout");
  err.name = "TimeoutError";
  return err;
}

let fetchMock: ReturnType<typeof vi.fn>;

/** The form body of the nth fetch call, parsed. */
function bodyOfCall(index: number): URLSearchParams {
  return new URLSearchParams(String((fetchMock.mock.calls[index][1] as RequestInit).body));
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  setThreadsCredentialsResolver(async () => ({ appSecret: SECRET, accessToken: TOKEN, userId: USER_ID }));
});

afterEach(() => {
  setThreadsCredentialsResolver(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/**
 * ⛔ `retryable` and `rateLimited` ARE NOT THE SAME QUESTION, and the gap
 * between them is exactly two error codes.
 *
 * `retryable` asks "might this succeed later". `rateLimited` asks "is Threads
 * telling us it did nothing", which is the only honest reason to re-send a
 * create. API_UNKNOWN (1) and API_SERVICE (2) answer yes to the first and no to
 * the second: the call may have landed and only the answer was lost.
 */
describe("ThreadsError.rateLimited, the gate on re-sending a create", () => {
  const make = (code: number | null, status = 400) => new ThreadsError("x", status, code, null, null, null);

  it("reports the four rate-limit codes as a definitive refusal, so the create can be re-sent", () => {
    for (const code of [4, 17, 32, 613]) {
      expect(make(code).rateLimited).toBe(true);
      // The consumer, named so a future reader can see why this getter exists
      // at all: retry.ts is the only caller and it gates `rejected-only` on it.
      expect(isRejection(make(code))).toBe(true);
    }
  });

  it("⛔ excludes API_UNKNOWN and API_SERVICE, whose call may have already posted", () => {
    for (const code of [1, 2]) {
      expect(make(code).retryable).toBe(true);
      expect(make(code).rateLimited).toBe(false);
      expect(isRejection(make(code))).toBe(false);
    }
  });

  it("is false when Threads sent no error code at all, rather than treating absence as a limit", () => {
    // A 503 with no envelope: retryable on status alone, but nothing was said
    // about a rate limit, so a create must not be repeated on this evidence.
    const err = make(null, 503);
    expect(err.retryable).toBe(true);
    expect(err.rateLimited).toBe(false);
  });

  it("does not treat a permission or validation code as a refusal to be repeated", () => {
    for (const code of [100, 190, 200, 368]) expect(make(code).rateLimited).toBe(false);
  });
});

describe("what a failure that never reached Threads looks like", () => {
  /**
   * ⚠️ Our budget, not the vendor's. The number in the message is
   * REQUEST_TIMEOUT_MS, and it is the only way a log line distinguishes "we
   * gave up" from "Threads refused".
   */
  it("names our own 15s budget when Threads never answers, as a ThreadsError not a raw DOMException", async () => {
    fetchMock.mockRejectedValue(timeoutError());

    const err = await createContainer({ mediaType: "TEXT", text: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(ThreadsError);
    expect(err.message).toMatch(/no response after 15s/);
    // A create that timed out may still have posted: Threads had dropped this
    // clause when every client hand-copied the wrap.
    expect(err.message).toContain("check before retrying a publish");
    expect(err.status).toBe(0);
    expect(err.retryAfter).toBeNull();
  });

  /**
   * ⚠️ A dropped connection is NOT a timeout and the two must not read the
   * same. Both are status 0, so the message carries the whole distinction: this
   * one is the operating system's reason, the one above is our budget.
   */
  it("reports a dropped connection with the underlying reason rather than as a timeout", async () => {
    fetchMock.mockRejectedValue(new Error("read ECONNRESET"));

    const err = await getPermalink("post-1").catch((e) => e);
    expect(err).toBeInstanceOf(ThreadsError);
    expect(err.message).toBe("read ECONNRESET");
    expect(err.message).not.toMatch(/no response after/);
    expect(err.status).toBe(0);
  });

  /**
   * ⚠️ fetch can reject with something that is not an Error at all (a polyfill,
   * an SDK, a `throw "..."` deep in a stack). Stringifying it keeps a readable
   * message instead of the literal "[object Object]" or an empty one.
   */
  it("keeps a non-Error rejection readable instead of losing it", async () => {
    fetchMock.mockRejectedValue("socket hang up");

    const err = await getPermalink("post-1").catch((e) => e);
    expect(err).toBeInstanceOf(ThreadsError);
    expect(err.message).toBe("socket hang up");
    expect(err.status).toBe(0);
  });
});

describe("responses that are technically valid and carry nothing", () => {
  /**
   * A 200 with an EMPTY body. `JSON.parse("")` throws, so without the guard
   * this would surface as the "non-JSON response" error and a permalink lookup
   * would fail the whole postFacts sweep instead of reporting "no permalink".
   */
  it("reads an empty 200 body as an empty object rather than a parse failure", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 200 }));
    await expect(getPermalink("post-1")).resolves.toBeUndefined();
  });

  /**
   * ⛔ A FAILURE WITH NO ERROR ENVELOPE STILL HAS TO CARRY THE STATUS. Threads
   * is Graph-family infrastructure and the envelope is this client's own
   * best-available assumption (see ThreadsError's docblock), so an edge or a
   * load balancer answering `{}` with a 5xx is entirely plausible. If the
   * status were lost here, `retryable` would read false and a transient 500
   * would fail the leg permanently.
   */
  it("falls back to an HTTP-shaped message when a failure carries no error envelope", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 500));

    const err = await createContainer({ mediaType: "TEXT", text: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(ThreadsError);
    expect(err.message).toBe("Threads request failed with HTTP 500");
    expect(err.status).toBe(500);
    expect(err.code).toBeNull();
    expect(err.subcode).toBeNull();
    expect(err.type).toBeNull();
    expect(err.traceId).toBeNull();
    expect(err.retryable).toBe(true);
  });
});

/**
 * ⚠️ Threads caps alt_text at 1,000 characters and the caller is a draft
 * editor, not a validator. Sending 1,200 characters would be refused by the
 * vendor and the whole post would be lost; dropping the field silently would
 * publish an image with no description at all. Truncation is the deliberate
 * third answer, and it is the one an accessibility reviewer would pick.
 */
describe("createContainer alt text", () => {
  it("sends alt_text on the container so an image is not published undescribed", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "container-1" }));
    await createContainer({
      mediaType: "IMAGE",
      imageUrl: "https://cdn.example.com/card.png",
      altText: "a screenshot of the Acme dashboard",
    });
    expect(bodyOfCall(0).get("alt_text")).toBe("a screenshot of the Acme dashboard");
  });

  it("truncates an over-long alt text at the vendor cap rather than dropping it or failing the post", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "container-1" }));
    const long = "d".repeat(ALT_TEXT_MAX_CHARS + 200);

    await createContainer({ mediaType: "IMAGE", imageUrl: "https://cdn.example.com/a.png", altText: long });

    const sent = bodyOfCall(0).get("alt_text");
    expect(sent).not.toBeNull();
    expect(sent!.length).toBe(ALT_TEXT_MAX_CHARS);
    expect(sent).toBe(long.slice(0, ALT_TEXT_MAX_CHARS));
    expect(ALT_TEXT_MAX_CHARS).toBe(1000);
  });

  it("omits alt_text entirely when the draft has none, rather than sending an empty label", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "container-1" }));
    await createContainer({ mediaType: "IMAGE", imageUrl: "https://cdn.example.com/a.png" });
    expect(bodyOfCall(0).has("alt_text")).toBe(false);
  });
});

/**
 * ⛔ THE CHAIN GUARD. threads-transport.ts publishes a chain by feeding this
 * function's return value into the NEXT container as `replyToId`, and
 * `request()` silently drops undefined params. So a publish that resolved with
 * an id-less response would not throw anywhere: the next reply would be created
 * with no `reply_to_id`, land as a separate top-level post, and every deferred
 * release after it would hang off `selfRef: { id: undefined }`. The operator
 * would see a draft marked published, a scattering of orphan posts, and no
 * error at all. Throwing here is what turns that into a visible failed leg.
 */
describe("publishContainer refuses an id-less success", () => {
  it("throws rather than handing the chain an undefined parent id", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    await expect(publishContainer("container-1")).rejects.toThrow(/threads_publish: unexpected response shape at id: expected a non-empty string, got missing/);
  });

  it("throws for a 200 that only echoes something unrelated", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true }));
    const err = await publishContainer("container-1").catch((e) => e);
    // A shape error, which retry.ts counts as an unknown outcome: the publish may have landed.
    expect(err).toBeInstanceOf(ResponseShapeError);
    expect(isUnknownOutcome(err)).toBe(true);
  });
});

describe("container status when the vendor says nothing useful", () => {
  /**
   * ⛔ IN_PROGRESS IS THE SAFE DEFAULT AND THE ONLY SAFE DEFAULT. A response
   * with no `status` field means we do not know whether Threads finished
   * downloading the image. Reading that as FINISHED would call
   * `threads_publish` on an unready container; reading it as IN_PROGRESS costs
   * one more poll and, at worst, a loud timeout.
   */
  it("reads a status-less response as IN_PROGRESS, never as ready to publish", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    await expect(getContainerStatus("c1")).resolves.toEqual({ status: "IN_PROGRESS", errorMessage: undefined });
  });

  it("gives up loudly instead of publishing when every status check comes back blank", async () => {
    // A fresh Response per call: a Response body reads once, so a shared
    // mockResolvedValue would hand back an already-consumed body on poll two.
    fetchMock.mockImplementation(async () => jsonResponse({}));
    await expect(pollContainerUntilFinished("c1", { maxAttempts: 2, intervalMs: 0 })).rejects.toThrow(
      /still IN_PROGRESS/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  /**
   * ⚠️ "failed processing: undefined" tells an operator nothing about what to
   * check. The vendor documents error_message values like
   * FAILED_DOWNLOADING_VIDEO, but the troubleshooting doc does not promise one
   * on every ERROR.
   */
  it("says 'unknown error' when an ERROR state carries no error_message", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: "ERROR" }));
    const err = await pollContainerUntilFinished("c1").catch((e) => e);
    expect(err).toBeInstanceOf(ThreadsError);
    expect(err.message).toMatch(/failed processing: unknown error/);
    expect(err.message).not.toMatch(/undefined/);
  });
});

/**
 * ⚠️ An insights response with no `data` key at all is not the same as a metric
 * with no value, and only the second one is covered in threads-client.test.ts.
 * `toMetricBag` iterates what it is given, so passing it `undefined` would
 * throw a TypeError out of the analytics sweep, failing every OTHER platform's
 * numbers in the same run. An empty bag is the honest answer: no metrics
 * reported, none fabricated.
 */
describe("insights with no data at all", () => {
  it("reports an empty metric bag for a media response that omits data entirely", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    await expect(getMediaInsights("m1")).resolves.toEqual({});
  });

  it("reports an empty metric bag for an account response that omits data entirely", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    await expect(getUserInsights()).resolves.toEqual({});
  });
});

describe("createContainer / publishContainer optional fields", () => {
  it("sends a trimmed topic tag without its leading #, a capped alt text, and the Story cross-share flag", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "c1" }));

    await createContainer({
      mediaType: "IMAGE",
      imageUrl: "https://cdn.example.com/card.png",
      altText: "a".repeat(ALT_TEXT_MAX_CHARS + 10),
      topicTag: `#${"t".repeat(60)}`,
      crossShareToIgStory: true,
    });

    const body = bodyOfCall(0);
    expect(body.get("topic_tag")).toBe("t".repeat(50));
    expect(body.get("alt_text")).toHaveLength(ALT_TEXT_MAX_CHARS);
    expect(body.get("crossreshare_to_ig")).toBe("true");
  });

  it("carries the vendor's cross-share status back when Threads reports one", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "p1", crossreshare_to_ig_status: "FAILED" }));
    await expect(publishContainer("c1")).resolves.toEqual({ id: "p1", crossShareToIgStatus: "FAILED" });
  });
});
