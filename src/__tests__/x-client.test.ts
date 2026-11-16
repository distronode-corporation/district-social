import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Coverage for the new x.ts vendor client (x-transport.ts's "how do we talk
 * to it" half). Named x-client.test.ts, NOT x.test.ts: that filename may
 * already be taken by unrelated coverage elsewhere in this suite, same reason
 * pinterest-client.test.ts is not named pinterest.test.ts (see that file's
 * own header comment).
 */

import {
  XError,
  isXNotFound,
  setXTokenResolver,
  createTweet,
  deleteTweet,
  getTweetsBatch,
  uploadImage,
  uploadMedia,
  getMe,
} from "../x.js";

/** Builds a fetch-mock-shaped Response for a JSON body. */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** Builds a fetch-mock-shaped Response with no body (APPEND typically answers this way). */
function emptyResponse(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => "",
  } as unknown as Response;
}

const TOKEN = "test-access-token";

describe("x client", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    setXTokenResolver(async () => TOKEN);
  });

  afterEach(() => {
    setXTokenResolver(null);
    vi.unstubAllGlobals();
  });

  describe("auth", () => {
    it("throws a clear XError when no resolver is registered", async () => {
      setXTokenResolver(null);
      await expect(getMe()).rejects.toThrow(/no X token resolver/);
    });

    it("throws when the resolver returns an empty token", async () => {
      setXTokenResolver(async () => "");
      await expect(getMe()).rejects.toThrow(/empty token/);
    });

    it("sends the bearer token on every call", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        jsonResponse(200, { data: { id: "1", username: "examplebrand" } }),
      );
      await getMe();
      const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    });

    /**
     * The whole point of NOT caching the resolver's output (x.ts's
     * setXTokenResolver docblock): a rotated token must be picked up on the
     * very next call, with no "clear the cache" step needed. Unlike
     * linkedin.ts's org urn, there is nothing here to invalidate.
     */
    it("calls the resolver fresh on every request rather than memoising the token", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        jsonResponse(200, { data: { id: "1", username: "examplebrand" } }),
      );
      let calls = 0;
      setXTokenResolver(async () => {
        calls += 1;
        return `token-${calls}`;
      });

      await getMe();
      await getMe();

      expect(calls).toBe(2);
      const first = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1];
      const second = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[1][1];
      expect((first.headers as Record<string, string>).Authorization).toBe("Bearer token-1");
      expect((second.headers as Record<string, string>).Authorization).toBe("Bearer token-2");
    });
  });

  describe("createTweet", () => {
    it("sends just text for a plain root tweet and parses the returned id/text", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        jsonResponse(201, { data: { id: "1700000000000000000", text: "hello from Acme" }, errors: [] }),
      );

      const result = await createTweet({ text: "hello from Acme" });
      expect(result).toEqual({ id: "1700000000000000000", text: "hello from Acme" });

      const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe("https://api.x.com/2/tweets");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body as string)).toEqual({ text: "hello from Acme" });
    });

    it("sends reply.in_reply_to_tweet_id when replying", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(jsonResponse(201, { data: { id: "2", text: "a reply" } }));

      await createTweet({ text: "a reply", inReplyToTweetId: "1" });

      const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = JSON.parse(init.body as string);
      expect(body.reply).toEqual({ in_reply_to_tweet_id: "1" });
    });

    it("sends media.media_ids when images are attached", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(jsonResponse(201, { data: { id: "3", text: "with images" } }));

      await createTweet({ text: "with images", mediaIds: ["m1", "m2"] });

      const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = JSON.parse(init.body as string);
      expect(body.media).toEqual({ media_ids: ["m1", "m2"] });
    });

    it("sends reply_settings only when explicitly given, never invents 'everyone' (not a valid enum value)", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(jsonResponse(201, { data: { id: "4", text: "t" } }));

      await createTweet({ text: "t", replySettings: "following" });

      const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = JSON.parse(init.body as string);
      expect(body.reply_settings).toBe("following");
    });

    it("throws when the response carries no id", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(jsonResponse(201, { data: {} }));
      await expect(createTweet({ text: "orphaned" })).rejects.toThrow(/no id was returned/);
    });

    it("wraps a vendor rejection in an XError", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(jsonResponse(422, { title: "Invalid Request" }));
      await expect(createTweet({ text: "x".repeat(1000) })).rejects.toBeInstanceOf(XError);
    });
  });

  describe("deleteTweet", () => {
    it("DELETEs the tweet by id", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(jsonResponse(200, { data: { deleted: true } }));
      await expect(deleteTweet("123")).resolves.toBeUndefined();
      const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe("https://api.x.com/2/tweets/123");
      expect(init.method).toBe("DELETE");
    });

    it("passes a genuine 404 through as an XError (idempotency is the transport's job)", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        jsonResponse(404, { type: "https://api.twitter.com/2/problems/resource-not-found", title: "Not Found Error" }),
      );
      await expect(deleteTweet("gone")).rejects.toThrow(XError);
    });
  });

  describe("isXNotFound", () => {
    it("is true for a 404 XError", () => {
      expect(isXNotFound(new XError(404, "gone", "DELETE", "/tweets/1"))).toBe(true);
    });

    it("is false for a non-404 XError", () => {
      expect(isXNotFound(new XError(500, "boom", "DELETE", "/tweets/1"))).toBe(false);
    });

    it("is false for a plain Error", () => {
      expect(isXNotFound(new Error("nope"))).toBe(false);
    });
  });

  describe("getTweetsBatch", () => {
    it("returns {data:[],errors:[]} for an empty id list without calling the vendor", async () => {
      const result = await getTweetsBatch([]);
      expect(result).toEqual({ data: [], errors: [] });
      expect(fetch).not.toHaveBeenCalled();
    });

    it("builds a comma-separated ids query param (each id individually encoded, the join comma left as the literal separator)", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(jsonResponse(200, { data: [{ id: "1", text: "a" }] }));

      await getTweetsBatch(["1", "2", "3"]);

      const [url] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe("https://api.x.com/2/tweets?ids=1,2,3");
    });

    it("returns both found posts and resource-not-found errors", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        jsonResponse(200, {
          data: [{ id: "1", text: "still here" }],
          errors: [
            {
              type: "https://api.twitter.com/2/problems/resource-not-found",
              title: "Not Found Error",
              resource_id: "2",
              resource_type: "tweet",
            },
          ],
        }),
      );

      const result = await getTweetsBatch(["1", "2"]);
      expect(result.data).toEqual([{ id: "1", text: "still here" }]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].resource_id).toBe("2");
    });
  });

  describe("uploadMedia chunking", () => {
    function initResponse(mediaId: string) {
      return jsonResponse(200, { data: { id: mediaId, media_key: `3_${mediaId}` } });
    }

    /** Reads segment_index off each APPEND call's multipart body. */
    function appendSegments(): string[] {
      const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
      return calls
        .map((c) => (c[1] as RequestInit | undefined)?.body)
        .filter((b): b is FormData => b instanceof FormData)
        .filter((f) => f.get("command") === "APPEND")
        .map((f) => String(f.get("segment_index")));
    }

    it("splits a payload larger than one chunk into ordered sequential segments", async () => {
      // ⚠️ This is the gap that made video unsendable: a single APPEND is
      // correct for a <=5MB image and silently truncates anything bigger.
      const nineMB = new Uint8Array(9 * 1024 * 1024) as Uint8Array<ArrayBuffer>;
      (fetch as unknown as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(initResponse("vid-1"))
        .mockResolvedValueOnce(emptyResponse(204))
        .mockResolvedValueOnce(emptyResponse(204))
        .mockResolvedValueOnce(emptyResponse(204))
        .mockResolvedValueOnce(jsonResponse(200, { data: { id: "vid-1" } }));

      await expect(uploadMedia(nineMB, "video/mp4", "tweet_video")).resolves.toBe("vid-1");

      // 9MB at 4MB per chunk is 3 segments. X assembles by segment_index, so
      // the ORDER is part of the contract, not an implementation detail.
      expect(appendSegments()).toEqual(["0", "1", "2"]);
    });

    it("still sends exactly one segment for a small asset", async () => {
      const small = new Uint8Array(1024) as Uint8Array<ArrayBuffer>;
      (fetch as unknown as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(initResponse("img-1"))
        .mockResolvedValueOnce(emptyResponse(204))
        .mockResolvedValueOnce(jsonResponse(200, { data: { id: "img-1" } }));

      await uploadMedia(small, "image/png", "tweet_image");
      expect(appendSegments()).toEqual(["0"]);
    });

    it("sends the media_category it was given, which changes X's processing path", async () => {
      const small = new Uint8Array(8) as Uint8Array<ArrayBuffer>;
      (fetch as unknown as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(initResponse("gif-1"))
        .mockResolvedValueOnce(emptyResponse(204))
        .mockResolvedValueOnce(jsonResponse(200, { data: { id: "gif-1" } }));

      await uploadMedia(small, "image/gif", "tweet_gif");

      const init = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
      expect((init.body as FormData).get("media_category")).toBe("tweet_gif");
    });

    it("refuses a zero-byte asset rather than finalizing an empty media id", async () => {
      const empty = new Uint8Array(0) as Uint8Array<ArrayBuffer>;
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(initResponse("empty-1"));
      // Without this guard the loop sends NO append, FINALIZE succeeds, and the
      // returned id fails only later when attached to a post.
      await expect(uploadMedia(empty, "image/png", "tweet_image")).rejects.toThrow(/zero-byte/);
    });
  });

  describe("uploadImage", () => {
    function initResponse(mediaId: string, processingInfo?: unknown) {
      return jsonResponse(200, { data: { id: mediaId, media_key: `3_${mediaId}`, ...(processingInfo ? { processing_info: processingInfo } : {}) } });
    }

    it("runs INIT -> APPEND -> FINALIZE and returns the media id from INIT", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(initResponse("media-1")) // INIT
        .mockResolvedValueOnce(emptyResponse(200)) // APPEND
        .mockResolvedValueOnce(jsonResponse(200, { data: { id: "media-1" } })); // FINALIZE, no processing_info

      const bytes = new Uint8Array([1, 2, 3]);
      const mediaId = await uploadImage(bytes as Uint8Array<ArrayBuffer>, "image/png");

      expect(mediaId).toBe("media-1");
      expect(fetch).toHaveBeenCalledTimes(3);

      const [initUrl, initInit] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(initUrl).toBe("https://api.x.com/2/media/upload");
      const initForm = initInit.body as FormData;
      expect(initForm.get("command")).toBe("INIT");
      expect(initForm.get("media_type")).toBe("image/png");
      expect(initForm.get("total_bytes")).toBe("3");
      expect(initForm.get("media_category")).toBe("tweet_image");
      // multipart/form-data: fetch sets the Content-Type/boundary itself.
      expect(initInit.headers as Record<string, string>).not.toHaveProperty("Content-Type");

      const [, appendInit] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[1];
      const appendForm = appendInit.body as FormData;
      expect(appendForm.get("command")).toBe("APPEND");
      expect(appendForm.get("media_id")).toBe("media-1");
      expect(appendForm.get("segment_index")).toBe("0");
      expect(appendForm.get("media")).toBeInstanceOf(Blob);

      const [, finalizeInit] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[2];
      const finalizeForm = finalizeInit.body as FormData;
      expect(finalizeForm.get("command")).toBe("FINALIZE");
      expect(finalizeForm.get("media_id")).toBe("media-1");
    });

    it("polls STATUS until processing succeeds when FINALIZE returns a pending processing_info", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(initResponse("media-2")) // INIT
        .mockResolvedValueOnce(emptyResponse(200)) // APPEND
        .mockResolvedValueOnce(jsonResponse(200, { data: { id: "media-2", processing_info: { state: "pending", check_after_secs: 0 } } })) // FINALIZE
        .mockResolvedValueOnce(jsonResponse(200, { data: { id: "media-2", processing_info: { state: "succeeded" } } })); // STATUS

      const mediaId = await uploadImage(new Uint8Array([9]) as Uint8Array<ArrayBuffer>, "image/jpeg");
      expect(mediaId).toBe("media-2");

      const [statusUrl, statusInit] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[3];
      expect(statusUrl).toBe("https://api.x.com/2/media/upload?command=STATUS&media_id=media-2");
      expect(statusInit.method).toBe("GET");
    });

    it("throws when processing_info reports a failure", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(initResponse("media-3"))
        .mockResolvedValueOnce(emptyResponse(200))
        .mockResolvedValueOnce(
          jsonResponse(200, { data: { id: "media-3", processing_info: { state: "failed", error: { message: "InvalidMedia" } } } }),
        );

      await expect(uploadImage(new Uint8Array([1]) as Uint8Array<ArrayBuffer>, "image/png")).rejects.toThrow(/InvalidMedia/);
    });

    it("gives up rather than looping forever when processing never leaves pending", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(initResponse("media-4"))
        .mockResolvedValueOnce(emptyResponse(200))
        .mockResolvedValueOnce(jsonResponse(200, { data: { id: "media-4", processing_info: { state: "pending", check_after_secs: 0 } } }))
        .mockResolvedValue(jsonResponse(200, { data: { id: "media-4", processing_info: { state: "pending", check_after_secs: 0 } } }));

      await expect(uploadImage(new Uint8Array([1]) as Uint8Array<ArrayBuffer>, "image/png")).rejects.toThrow(/still pending/);
    });

    it("throws when INIT returns no media id", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(jsonResponse(200, { data: {} }));
      await expect(uploadImage(new Uint8Array([1]) as Uint8Array<ArrayBuffer>, "image/png")).rejects.toThrow(/INIT returned no id/);
    });
  });

  describe("getMe", () => {
    it("returns id/username/name", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        jsonResponse(200, { data: { id: "1", username: "examplebrand", name: "Acme" } }),
      );
      await expect(getMe()).resolves.toEqual({ id: "1", username: "examplebrand", name: "Acme" });
      const [url] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe("https://api.x.com/2/users/me");
    });

    it("throws when the response is missing id/username", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(jsonResponse(200, { data: {} }));
      await expect(getMe()).rejects.toThrow(/no id\/username/);
    });
  });

  describe("request error handling", () => {
    it("wraps a fetch-level timeout in an XError", async () => {
      const timeoutErr = new Error("The operation was aborted");
      timeoutErr.name = "TimeoutError";
      (fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(timeoutErr);
      await expect(getMe()).rejects.toThrow(/no response after/);
    });

    it("throws an XError when a 200 response is not valid JSON", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => "<html>not json</html>",
      });
      await expect(getMe()).rejects.toThrow(/expected JSON/);
    });

    /**
     * ⛔ THE PLUMBING, NOT THE PARSER. retry.ts can only honour `Retry-After`
     * if a client actually puts it on the error, and the failure mode when one
     * forgets is silent: the header is simply absent, which is
     * indistinguishable from a vendor that did not send one. This asserts the
     * value survives the trip from the Response into the XError retry.ts reads.
     */
    it("carries the vendor's Retry-After onto the error", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        status: 429,
        headers: new Headers({ "retry-after": "17" }),
        text: async () => "Too Many Requests",
      });
      await expect(getMe()).rejects.toMatchObject({ status: 429, retryAfter: "17" });
    });

    it("leaves retryAfter null when the vendor sent no such header", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        status: 503,
        headers: new Headers(),
        text: async () => "unavailable",
      });
      await expect(getMe()).rejects.toMatchObject({ status: 503, retryAfter: null });
    });
  });
});
