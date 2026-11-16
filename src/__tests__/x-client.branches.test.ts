import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The failure vocabulary of the X / Twitter vendor client, and the shapes it
 * quietly tolerates.
 *
 * x-client.test.ts pins the happy paths and the main INIT/APPEND/FINALIZE
 * dance. This file pins the half a caller only meets when something has gone
 * wrong, which on this platform is the half that matters most: X is where
 * "looks published, actually was not" lives. Everything above this file decides
 * whether to retry, whether to mark a draft published, and whether to charge
 * another billed read, purely from what an XError carries and from what a
 * resolved value contains. So the thing under test here is not "a fetch
 * happened", it is what a caller can CONCLUDE:
 *
 *   - status 0 means the request never reached X. A real HTTP status means it
 *     did, and the answer was a refusal. retry.ts and the transports branch on
 *     exactly this, so a client that flattened a connection failure into some
 *     other status would send a publish back around the retry loop that must
 *     not go around again.
 *   - retryAfter is null unless the VENDOR said so. Null from a timeout is not
 *     the same claim as null from a 429 that carried no header, and only the
 *     latter is a vendor statement.
 *   - the three network helpers (request, mediaUploadRequest,
 *     mediaStatusRequest) are near-identical by sight and are NOT
 *     interchangeable: each names its own method, path and timeout budget in
 *     the error text, which is the only way to tell from a log line whether the
 *     upload, the poll or the post itself is what stalled.
 *
 * The other theme is absence. A vendor field that is missing must not become a
 * fabricated number, and a vendor-reported zero must survive. Those two are the
 * same line of code and collapsing them is invisible on a dashboard.
 */

import {
  XError,
  setXTokenResolver,
  createTweet,
  deleteTweet,
  getTweetsBatch,
  uploadImage,
  uploadVideo,
  uploadGif,
  getTweetMetrics,
  getFollowerCount,
} from "../x.js";

/** Builds a fetch-mock-shaped Response for a JSON body. */
function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers ?? {}),
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** Builds a fetch-mock-shaped Response carrying a raw, not-necessarily-JSON body. */
function textResponse(status: number, body: string, headers?: Record<string, string>): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers ?? {}),
    text: async () => body,
  } as unknown as Response;
}

/** Builds a fetch-mock-shaped Response with no body at all (APPEND and DELETE answer this way). */
function emptyResponse(status: number): Response {
  return textResponse(status, "");
}

const TOKEN = "test-access-token";
const ONE_BYTE = new Uint8Array([7]) as Uint8Array<ArrayBuffer>;

let fetchMock: ReturnType<typeof vi.fn>;

/** Reads the FormData a given fetch call posted, for the multipart media endpoint. */
function formOfCall(index: number): FormData {
  return (fetchMock.mock.calls[index][1] as RequestInit).body as FormData;
}

/**
 * Drains the microtask queue so an in-flight upload reaches its first sleep()
 * before fake timers are advanced. The mocked fetches resolve as microtasks,
 * not timers, so advancing the clock alone would race them.
 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
}

/** Tracks settlement without consuming the promise (and without an unhandled rejection). */
function settlementFlag(p: Promise<unknown>): () => boolean {
  let settled = false;
  p.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return () => settled;
}

describe("x client failure vocabulary", () => {
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    setXTokenResolver(async () => TOKEN);
  });

  afterEach(() => {
    setXTokenResolver(null);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe("request(), the JSON path", () => {
    /**
     * ⛔ status 0 with retryAfter null is the client's way of saying "this never
     * reached X". A connection refused is not a vendor refusal, and the caller
     * is allowed to retry it in a way it must NOT retry a 4xx.
     */
    it("reports a connection failure as status 0 with no vendor instruction attached", async () => {
      fetchMock.mockRejectedValue(new Error("connect ECONNREFUSED 104.244.42.1:443"));

      await expect(getTweetsBatch(["1"])).rejects.toMatchObject({
        status: 0,
        retryAfter: null,
      });
      await expect(getTweetsBatch(["1"])).rejects.toThrow(/connect ECONNREFUSED 104\.244\.42\.1:443/);
    });

    /**
     * ⚠️ Not every rejection is an Error. A thrown string from a fetch polyfill
     * or an interceptor would otherwise reach the caller as "[object Object]"
     * or as an empty message, and the one clue about what happened would be
     * gone.
     */
    it("stringifies a rejection that is not an Error rather than losing the reason", async () => {
      fetchMock.mockRejectedValue("socket hang up");

      await expect(getTweetsBatch(["1"])).rejects.toThrow(/socket hang up/);
    });

    /**
     * ⛔ An empty body on a 2xx is SUCCESS, not a parse failure. deleteTweet
     * asks for `void`, and X answers a delete with no content; treating that as
     * "expected JSON, got: " would turn every successful delete into an error
     * and make the transport re-delete an id that is already gone.
     */
    it("treats an empty body on a 2xx as a successful void result", async () => {
      fetchMock.mockResolvedValue(emptyResponse(204));

      await expect(deleteTweet("1750000000000000000")).resolves.toBeUndefined();
    });
  });

  describe("createTweet's echo", () => {
    /**
     * ⚠️ The returned `text` is what the rest of the engine records as what was
     * published. When X answers with an id but no text, echoing back the text
     * WE sent is the honest answer; an empty string would record the post as
     * blank while a real, non-blank post sits on the timeline.
     */
    it("records the text we sent when the vendor echoes back an id but no text", async () => {
      fetchMock.mockResolvedValue(jsonResponse(201, { data: { id: "1750000000000000001" } }));

      await expect(createTweet({ text: "shipping today" })).resolves.toEqual({
        id: "1750000000000000001",
        text: "shipping today",
      });
    });
  });

  describe("getTweetsBatch's tolerance for a thin answer", () => {
    /**
     * ⚠️ A body with neither `data` nor `errors` must resolve empty, not throw.
     * postFacts chunks into this call and reads the two arrays; a throw here
     * would fail a whole batch of up to 100 posts over one malformed answer,
     * and every one of those reads is already billed.
     */
    it("resolves to empty arrays when the vendor answers with neither data nor errors", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, {}));

      await expect(getTweetsBatch(["1", "2"])).resolves.toEqual({ data: [], errors: [] });
    });

    /**
     * ⛔ Keep the row. The id is the fact the caller needs (this post still
     * exists); dropping the entry because the text was absent would read as
     * "deleted" to anything that reconciles refs against what came back.
     */
    it("keeps a post whose text the vendor omitted, with an empty string rather than dropping it", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { data: [{ id: "1750000000000000002" }] }));

      await expect(getTweetsBatch(["1750000000000000002"])).resolves.toEqual({
        data: [{ id: "1750000000000000002", text: "" }],
        errors: [],
      });
    });
  });

  describe("mediaUploadRequest(), the multipart path", () => {
    /**
     * ⛔ The media endpoint has its own 30s budget, and the error text says so.
     * The JSON path says 15s. A log line reading "no response after 15s" during
     * a publish therefore means the POST /2/tweets stalled, not the upload, and
     * flattening these two messages into one would erase that distinction.
     */
    it("names the media upload and its own 30s budget when INIT times out", async () => {
      const timeout = new Error("The operation was aborted due to timeout");
      timeout.name = "TimeoutError";
      fetchMock.mockRejectedValue(timeout);

      await expect(uploadImage(ONE_BYTE, "image/png")).rejects.toThrow(
        /media upload: no response after 30s/,
      );
      await expect(uploadImage(ONE_BYTE, "image/png")).rejects.toMatchObject({ status: 0, retryAfter: null });
    });

    /**
     * ⚠️ A dropped connection is NOT a timeout, and the two must not read the
     * same. This one carries the operating system's own reason; the timeout
     * above carries our budget. Both are status 0, so the message is the only
     * thing that tells them apart in a log.
     */
    it("reports a dropped connection during INIT with the underlying reason, not as a timeout", async () => {
      fetchMock.mockRejectedValue(new Error("read ECONNRESET"));

      await expect(uploadImage(ONE_BYTE, "image/png")).rejects.toThrow(
        /X POST \/media\/upload -> 0: read ECONNRESET/,
      );
      await expect(uploadImage(ONE_BYTE, "image/png")).rejects.not.toThrow(/no response after/);
    });

    it("stringifies a non-Error rejection from the media endpoint", async () => {
      fetchMock.mockRejectedValue("epipe");

      await expect(uploadImage(ONE_BYTE, "image/png")).rejects.toThrow(/X POST \/media\/upload -> 0: epipe/);
    });

    /**
     * ⛔ THE PLUMBING, NOT THE PARSER (same rule x-client.test.ts states for the
     * JSON path). Media upload is its own rate-limit bucket at X, so a 429 here
     * carries its own Retry-After, and retry.ts can only honour it if this
     * helper copies it onto the error too. Forgetting it on ONE of the three
     * helpers is silent: the header is simply absent, which looks exactly like
     * a vendor that did not send one.
     */
    it("carries the media endpoint's status and Retry-After onto the error", async () => {
      fetchMock.mockResolvedValue(textResponse(429, "Rate limit exceeded", { "retry-after": "42" }));

      await expect(uploadImage(ONE_BYTE, "image/png")).rejects.toMatchObject({
        status: 429,
        retryAfter: "42",
      });
    });

    /**
     * ⚠️ X answers an edge failure with an HTML page, not a Problem document.
     * The status is preserved on the error so the caller can still tell a 200
     * carrying junk from a 5xx carrying junk.
     */
    it("reports a non-JSON body from the media endpoint as such, keeping the HTTP status", async () => {
      fetchMock.mockResolvedValue(textResponse(200, "<html><body>Error 503</body></html>"));

      await expect(uploadImage(ONE_BYTE, "image/png")).rejects.toThrow(/expected JSON, got: <html>/);
      await expect(uploadImage(ONE_BYTE, "image/png")).rejects.toMatchObject({ status: 200 });
    });
  });

  describe("mediaStatusRequest(), the processing poll", () => {
    /** INIT, then APPEND, then a FINALIZE that reports processing is still pending. */
    function seedUploadUntilStatusPoll(mediaId: string, processingInfo: Record<string, unknown>): void {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(200, { data: { id: mediaId } }))
        .mockResolvedValueOnce(emptyResponse(204))
        .mockResolvedValueOnce(jsonResponse(200, { data: { id: mediaId, processing_info: processingInfo } }));
    }

    it("names the status poll and the 15s JSON budget when STATUS times out", async () => {
      const timeout = new Error("The operation was aborted due to timeout");
      timeout.name = "TimeoutError";
      seedUploadUntilStatusPoll("media-status-timeout", { state: "pending", check_after_secs: 0 });
      fetchMock.mockRejectedValueOnce(timeout);

      await expect(uploadImage(ONE_BYTE, "image/png")).rejects.toThrow(/media status: no response after 15s/);
    });

    it("reports a dropped connection during the status poll with the underlying reason", async () => {
      seedUploadUntilStatusPoll("media-status-reset", { state: "pending", check_after_secs: 0 });
      fetchMock.mockRejectedValueOnce(new Error("read ECONNRESET"));

      await expect(uploadImage(ONE_BYTE, "image/png")).rejects.toThrow(
        /X GET \/media\/upload -> 0: read ECONNRESET/,
      );
    });

    it("stringifies a non-Error rejection from the status poll", async () => {
      seedUploadUntilStatusPoll("media-status-weird", { state: "pending", check_after_secs: 0 });
      fetchMock.mockRejectedValueOnce({ toString: () => "opaque transport failure" });

      await expect(uploadImage(ONE_BYTE, "image/png")).rejects.toThrow(/opaque transport failure/);
    });

    it("carries the status poll's own status and Retry-After onto the error", async () => {
      seedUploadUntilStatusPoll("media-status-429", { state: "pending", check_after_secs: 0 });
      fetchMock.mockResolvedValueOnce(textResponse(429, "slow down", { "retry-after": "9" }));

      await expect(uploadImage(ONE_BYTE, "image/png")).rejects.toMatchObject({
        status: 429,
        retryAfter: "9",
      });
    });

    it("reports a non-JSON status body as such rather than crashing the poll", async () => {
      seedUploadUntilStatusPoll("media-status-html", { state: "pending", check_after_secs: 0 });
      fetchMock.mockResolvedValueOnce(textResponse(200, "not json at all"));

      await expect(uploadImage(ONE_BYTE, "image/png")).rejects.toThrow(/expected JSON, got: not json at all/);
    });

    /**
     * ⚠️ FAIL-OPEN, DELIBERATELY PINNED SO A CHANGE IS VISIBLE. An empty STATUS
     * body parses to `{}`, which carries no processing_info, which ends the
     * poll and hands the media id back as ready. That is the current behaviour
     * and it is defensible (the alternative, looping until the attempt cap,
     * would fail a publish over a body X is not documented to ever send), but
     * it is the one place in this file where "we could not tell" resolves as
     * "it is fine". If a future reader tightens it, this test is where the
     * decision is recorded, not an accident.
     */
    it("ends the poll and returns the media id when STATUS answers with an empty body", async () => {
      seedUploadUntilStatusPoll("media-status-empty", { state: "pending", check_after_secs: 0 });
      fetchMock.mockResolvedValueOnce(emptyResponse(200));

      await expect(uploadImage(ONE_BYTE, "image/png")).resolves.toBe("media-status-empty");
    });

    /**
     * ⚠️ A failed processing_info with no error.message must still say WHICH
     * media failed. Without the id the log line is unactionable.
     */
    it("says 'unknown error' but still names the media id when a failure carries no message", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(200, { data: { id: "media-nomsg" } }))
        .mockResolvedValueOnce(emptyResponse(204))
        .mockResolvedValueOnce(jsonResponse(200, { data: { id: "media-nomsg", processing_info: { state: "failed" } } }));

      await expect(uploadImage(ONE_BYTE, "image/png")).rejects.toThrow(
        /media media-nomsg failed processing: unknown error/,
      );
    });
  });

  describe("ensureProcessed's poll interval", () => {
    /**
     * ⛔ `check_after_secs: 0` IS A VALUE, NOT AN ABSENCE. The source tests for
     * the field's presence rather than its truthiness precisely so a vendor
     * saying "check again right away" is honoured. A `?? ` or a falsy check
     * would silently substitute the 2s default here and make every
     * fast-resolving upload two seconds slower, with nothing failing to show
     * it. This test and the next are a pair: change one and the other tells you
     * what you broke.
     */
    it("polls immediately when the vendor says check_after_secs 0", async () => {
      vi.useFakeTimers();
      fetchMock
        .mockResolvedValueOnce(jsonResponse(200, { data: { id: "media-fast" } }))
        .mockResolvedValueOnce(emptyResponse(204))
        .mockResolvedValueOnce(
          jsonResponse(200, { data: { id: "media-fast", processing_info: { state: "pending", check_after_secs: 0 } } }),
        )
        .mockResolvedValueOnce(
          jsonResponse(200, { data: { id: "media-fast", processing_info: { state: "succeeded" } } }),
        );

      const p = uploadImage(ONE_BYTE, "image/png");
      const isSettled = settlementFlag(p);
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(0);
      await flushMicrotasks();

      expect(isSettled()).toBe(true);
      await expect(p).resolves.toBe("media-fast");
    });

    it("falls back to a 2s interval only when the vendor omits check_after_secs", async () => {
      vi.useFakeTimers();
      fetchMock
        .mockResolvedValueOnce(jsonResponse(200, { data: { id: "media-slow" } }))
        .mockResolvedValueOnce(emptyResponse(204))
        .mockResolvedValueOnce(
          jsonResponse(200, { data: { id: "media-slow", processing_info: { state: "pending" } } }),
        )
        .mockResolvedValueOnce(
          jsonResponse(200, { data: { id: "media-slow", processing_info: { state: "succeeded" } } }),
        );

      const p = uploadImage(ONE_BYTE, "image/png");
      const isSettled = settlementFlag(p);
      await flushMicrotasks();

      await vi.advanceTimersByTimeAsync(1999);
      await flushMicrotasks();
      // ⚠️ Still waiting: the absent field means 2000ms, not 0.
      expect(isSettled()).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await flushMicrotasks();
      await expect(p).resolves.toBe("media-slow");
    });
  });

  describe("media_category, which changes X's processing path", () => {
    function seedThreeStepUpload(mediaId: string): void {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(200, { data: { id: mediaId } }))
        .mockResolvedValueOnce(emptyResponse(204))
        .mockResolvedValueOnce(jsonResponse(200, { data: { id: mediaId } }));
    }

    /**
     * ⛔ The category is not a label. tweet_video and tweet_gif take different
     * processing paths at X's end, and an animated GIF uploaded as tweet_video
     * is ACCEPTED and then behaves as a video (no autoplay loop) with nothing
     * reporting a problem. That is why these are separate entry points rather
     * than one call that guesses from the mime type, and why each one's
     * category is pinned here instead of trusting the shared uploadMedia test.
     */
    it("uploadVideo declares tweet_video, carrying the video mime type through INIT", async () => {
      seedThreeStepUpload("vid-9");

      await expect(uploadVideo(ONE_BYTE, "video/mp4")).resolves.toBe("vid-9");

      const initForm = formOfCall(0);
      expect(initForm.get("command")).toBe("INIT");
      expect(initForm.get("media_category")).toBe("tweet_video");
      expect(initForm.get("media_type")).toBe("video/mp4");
    });

    it("uploadGif declares tweet_gif, not tweet_video, so the post autoplays and loops", async () => {
      seedThreeStepUpload("gif-9");

      await expect(uploadGif(ONE_BYTE, "image/gif")).resolves.toBe("gif-9");

      const initForm = formOfCall(0);
      expect(initForm.get("media_category")).toBe("tweet_gif");
      expect(initForm.get("media_type")).toBe("image/gif");
    });
  });

  describe("metrics: absent is absent, zero is zero", () => {
    /**
     * ⛔ An unreadable metric is ABSENT, never 0. A dashboard renders a missing
     * key as "no data" and a 0 as "nobody engaged", and those are different
     * statements about the same post.
     */
    it("returns nothing at all when the post carries no public_metrics", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { data: { id: "1750000000000000003" } }));

      await expect(getTweetMetrics("1750000000000000003")).resolves.toEqual({});
    });

    /**
     * ⛔ The companion rule: a vendor-reported 0 IS a real datum and survives.
     * Both halves live on one line of the source, so they are asserted against
     * each other on purpose. A stringified count, a null and a non-finite
     * number are all dropped; the honest zero stays.
     */
    it("drops unreadable values but keeps a vendor-reported zero", async () => {
      fetchMock.mockResolvedValue(
        textResponse(
          200,
          JSON.stringify({
            data: {
              public_metrics: {
                like_count: "12",
                quote_count: null,
                bookmark_count: { count: 3 },
                reply_count: 0,
                impression_count: 4210,
              },
            },
          }),
        ),
      );

      await expect(getTweetMetrics("1750000000000000004")).resolves.toEqual({
        reply_count: 0,
        impression_count: 4210,
      });
    });
  });

  describe("getFollowerCount", () => {
    it("reports the vendor's followers_count when it is a real number", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { data: { public_metrics: { followers_count: 4210, tweet_count: 88 } } }));

      await expect(getFollowerCount()).resolves.toEqual({ followers: 4210 });
    });

    /**
     * ⛔ REFUSING TO GUESS IS THE FEATURE. On X a reported 0 followers is
     * indistinguishable from a suspended account, so anything that is not a
     * finite number throws instead of degrading to 0.
     *
     * ⚠️ A JSON number literal that overflows a double parses to Infinity, not
     * to a string and not to an error, so `typeof raw === "number"` is TRUE
     * here and only the Number.isFinite half catches it. That is why the source
     * checks both, and why this case is written as raw wire text rather than
     * through JSON.stringify (which turns Infinity into null and would test the
     * other branch by accident).
     */
    it("refuses a non-finite followers_count that arrives as a real number", async () => {
      fetchMock.mockResolvedValue(
        textResponse(200, '{"data":{"public_metrics":{"followers_count":1e999}}}'),
      );

      await expect(getFollowerCount()).rejects.toThrow(/refusing to report 0/);
      await expect(getFollowerCount()).rejects.toBeInstanceOf(XError);
    });

    it("refuses a followers_count the vendor sent as a string", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { data: { public_metrics: { followers_count: "4210" } } }));

      await expect(getFollowerCount()).rejects.toThrow(/indistinguishable from a suspended account/);
    });
  });
});
