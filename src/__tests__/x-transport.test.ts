// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from "vitest";

// The transport is a business-logic layer on top of the vendor client, so it
// is tested against a mocked client — bluesky-transport.test.ts's own pattern
// for bluesky.ts, pinterest-transport.test.ts's for pinterest.ts. XError stays
// real: isXNotFound's `instanceof` + status check is exactly the thing under
// test in the delete/postFacts not-found cases.
vi.mock("../x.js", async (importActual) => {
  const actual = await importActual<typeof import("../x.js")>();
  return {
    ...actual,
    createTweet: vi.fn(),
    deleteTweet: vi.fn(),
    getTweetsBatch: vi.fn(),
    uploadImage: vi.fn(),
    uploadVideo: vi.fn(),
    uploadGif: vi.fn(),
    setMediaAltText: vi.fn(),
    getMe: vi.fn(),
  };
});

import {
  XError,
  createTweet,
  deleteTweet,
  getTweetsBatch,
  uploadImage,
  uploadVideo,
  uploadGif,
  setMediaAltText,
  getMe,
} from "../x.js";
import { xTransport } from "../x-transport.js";
import { PublishPreflightError } from "../publish.js";
import type { DirectPublishInput, DirectQueuedReply, PublishDestination } from "../transport.js";
import type { MediaAsset, PlatformRender } from "../types.js";

const createTweetMock = createTweet as unknown as ReturnType<typeof vi.fn>;
const deleteTweetMock = deleteTweet as unknown as ReturnType<typeof vi.fn>;
const getTweetsBatchMock = getTweetsBatch as unknown as ReturnType<typeof vi.fn>;
const uploadImageMock = uploadImage as unknown as ReturnType<typeof vi.fn>;
const uploadVideoMock = uploadVideo as unknown as ReturnType<typeof vi.fn>;
const uploadGifMock = uploadGif as unknown as ReturnType<typeof vi.fn>;
const getMeMock = getMe as unknown as ReturnType<typeof vi.fn>;

function notFound(): XError {
  return new XError(404, JSON.stringify({ title: "Not Found Error" }), "DELETE", "/tweets/x");
}

function render(overrides: Partial<PlatformRender> = {}): PlatformRender {
  return { platform: "twitter", content: "hello from Acme", mediaIndices: [], ...overrides };
}

function image(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    path: "/tmp/card.png",
    type: "image",
    mimeType: "image/png",
    size: 900_000,
    url: "https://cdn.example.com/card.png",
    altText: "a screenshot of the Acme dashboard",
    ...overrides,
  };
}

function destination(overrides: Partial<PublishDestination> = {}): PublishDestination {
  return { ...overrides };
}

function input(overrides: Partial<DirectPublishInput> = {}): DirectPublishInput {
  return { render: render(), media: [], draftId: "draft-1", destination: destination(), ...overrides };
}

beforeEach(() => {
  createTweetMock.mockReset();
  deleteTweetMock.mockReset();
  getTweetsBatchMock.mockReset();
  uploadImageMock.mockReset();
  uploadVideoMock.mockReset();
  uploadGifMock.mockReset();
  getMeMock.mockReset();
  vi.stubGlobal("fetch", vi.fn());
});

describe("x transport", () => {
  it("declares the real weighted 280-char limit and vendor media caps", () => {
    expect(xTransport.channelRules()).toEqual({
      maxLength: 280,
      countMode: "weighted",
      maxImages: 4,
      maxImageBytes: 5 * 1024 * 1024,
      // Post video, not DM video: 8 GB / 20 min on a default account
      // (docs.x.com/changelog, Sep 1 2026). 512 MB / 140 s was the DM figure.
      maxVideoBytes: 8 * 1024 * 1024 * 1024,
      maxVideoSec: 1200,
    });
  });

  describe("connectStatus", () => {
    it("reports connected with the account's id/username", async () => {
      getMeMock.mockResolvedValue({ id: "acct-1", username: "examplebrand" });
      const status = await xTransport.connectStatus();
      expect(status).toEqual({ connected: true, accountId: "acct-1", displayName: "examplebrand" });
    });

    it("resolves with connected:false and a reason instead of rejecting on a bad credential", async () => {
      getMeMock.mockRejectedValue(new XError(401, "invalid token", "GET", "/users/me"));
      const status = await xTransport.connectStatus();
      expect(status.connected).toBe(false);
      expect(status.accountId).toBe("");
      expect(status.reason).toMatch(/invalid token/);
    });
  });

  describe("postUrl", () => {
    it("builds the i/web/status permalink from the id", () => {
      expect(xTransport.postUrl("123456")).toBe("https://x.com/i/web/status/123456");
    });
  });

  describe("publishNow: media", () => {
    it("posts text-only with no media call at all", async () => {
      createTweetMock.mockResolvedValue({ id: "root-1", text: "hello from Acme" });

      const result = await xTransport.publishNow(input());

      expect(uploadImageMock).not.toHaveBeenCalled();
      expect(createTweetMock).toHaveBeenCalledWith({ text: "hello from Acme", mediaIds: undefined });
      expect(result).toEqual({ ref: "root-1", url: "https://x.com/i/web/status/root-1" });
    });

    it("fetches asset bytes, uploads via x.ts, and sends the returned media ids", async () => {
      // A real Response: the shared media fetch streams res.body under a byte
      // cap (media-fetch.ts), so a plain { ok, arrayBuffer } object can no
      // longer stand in for what fetch actually returns.
      (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => new Response(new Uint8Array([1, 2, 3])));
      uploadImageMock.mockResolvedValue("media-1");
      createTweetMock.mockResolvedValue({ id: "root-1", text: "with an image" });

      await xTransport.publishNow(input({ media: [image()] }));

      expect(fetch).toHaveBeenCalledWith("https://cdn.example.com/card.png", expect.any(Object));
      expect(uploadImageMock).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]), "image/png");
      expect(createTweetMock).toHaveBeenCalledWith(
        expect.objectContaining({ mediaIds: ["media-1"] }),
      );
    });

    it("caps uploads at 4 images even if more are attached", async () => {
      // mockImplementation, not mockResolvedValue: four fetches need four
      // bodies, and a Response body can only be consumed once.
      (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => new Response(new Uint8Array([1])));
      uploadImageMock.mockResolvedValue("m");
      createTweetMock.mockResolvedValue({ id: "root-1", text: "t" });

      const fiveImages = Array.from({ length: 5 }, (_, i) => image({ url: `https://cdn.example.com/${i}.png` }));
      await xTransport.publishNow(input({ media: fiveImages }));

      expect(uploadImageMock).toHaveBeenCalledTimes(4);
    });

    // ⚠️ VIDEO AND GIF MUST UPLOAD, NOT BE REFUSED. channelRules advertises X's
    // real 512MB/140s video limits, so a refusal here would leave the QA gate
    // validating against a ceiling the upload path cannot reach.
    it("uploads a video through the chunked path instead of refusing it", async () => {
      vi.mocked(globalThis.fetch).mockImplementation(async () => new Response(new Uint8Array([1])));
      uploadVideoMock.mockResolvedValue("vid-1");
      createTweetMock.mockResolvedValue({ id: "root-1", text: "t" });

      const video: MediaAsset = {
        path: "/tmp/clip.mp4",
        type: "video",
        mimeType: "video/mp4",
        size: 5_000_000,
        url: "https://cdn.example.com/clip.mp4",
      };
      await xTransport.publishNow(input({ media: [video] }));

      expect(uploadVideoMock).toHaveBeenCalledWith(expect.anything(), "video/mp4");
      expect(uploadImageMock).not.toHaveBeenCalled();
      expect(createTweetMock).toHaveBeenCalledWith(expect.objectContaining({ mediaIds: ["vid-1"] }));
    });

    it("uploads an animated GIF as tweet_gif, not as a video", async () => {
      vi.mocked(globalThis.fetch).mockImplementation(async () => new Response(new Uint8Array([1])));
      uploadGifMock.mockResolvedValue("gif-1");
      createTweetMock.mockResolvedValue({ id: "root-1", text: "t" });

      const gif: MediaAsset = {
        path: "/tmp/clip.gif",
        type: "gif",
        mimeType: "image/gif",
        size: 2_000_000,
        url: "https://cdn.example.com/clip.gif",
      };
      await xTransport.publishNow(input({ media: [gif] }));

      // media_category is not a label: a GIF uploaded as tweet_video is
      // accepted and then behaves as a video, losing the autoplay loop.
      expect(uploadGifMock).toHaveBeenCalled();
      expect(uploadVideoMock).not.toHaveBeenCalled();
    });

    it("refuses a video mixed with images BEFORE spending the upload", async () => {
      const video: MediaAsset = {
        path: "/tmp/clip.mp4",
        type: "video",
        mimeType: "video/mp4",
        size: 5_000_000,
        url: "https://cdn.example.com/clip.mp4",
      };
      // X rejects this combination at POST time, after every byte is uploaded.
      await expect(
        xTransport.publishNow(input({ media: [video, image()] })),
      ).rejects.toThrow(PublishPreflightError);
      expect(fetch).not.toHaveBeenCalled();
      expect(createTweetMock).not.toHaveBeenCalled();
    });

    it("refuses two videos, which X does not accept in one post", async () => {
      const video = (n: number): MediaAsset => ({
        path: `/tmp/clip${n}.mp4`,
        type: "video",
        mimeType: "video/mp4",
        size: 1_000,
        url: `https://cdn.example.com/clip${n}.mp4`,
      });
      await expect(xTransport.publishNow(input({ media: [video(1), video(2)] }))).rejects.toThrow(
        PublishPreflightError,
      );
      expect(fetch).not.toHaveBeenCalled();
    });

    it("refuses a video whose container X cannot take, rather than uploading 512MB to find out", async () => {
      const webm: MediaAsset = {
        path: "/tmp/clip.webm",
        type: "video",
        mimeType: "video/webm",
        size: 5_000_000,
        url: "https://cdn.example.com/clip.webm",
      };
      await expect(xTransport.publishNow(input({ media: [webm] }))).rejects.toThrow(/MP4 or MOV/);
      expect(fetch).not.toHaveBeenCalled();
    });

    it("throws a clear error for an unsupported image mime type rather than dropping it silently", async () => {
      const heic = image({ mimeType: "image/heic" });
      await expect(xTransport.publishNow(input({ media: [heic] }))).rejects.toThrow(/unsupported image mime type/);
      expect(createTweetMock).not.toHaveBeenCalled();
    });
  });

  describe("publishNow: threads", () => {
    it("with no threadItems, returns just the root ref and url", async () => {
      createTweetMock.mockResolvedValue({ id: "root-1", text: "t" });
      const result = await xTransport.publishNow(input());
      expect(result).toEqual({ ref: "root-1", url: "https://x.com/i/web/status/root-1" });
      expect(result.queued).toBeUndefined();
      expect(result.threadRoot).toBeUndefined();
    });

    it("with no delay, chains every reply inline, each in_reply_to the immediately prior tweet", async () => {
      createTweetMock
        .mockResolvedValueOnce({ id: "root-1", text: "root" })
        .mockResolvedValueOnce({ id: "reply-1", text: "first follow-up" })
        .mockResolvedValueOnce({ id: "reply-2", text: "second follow-up" });

      const result = await xTransport.publishNow(
        input({ render: render({ threadItems: ["first follow-up", "second follow-up"], followupDelayMinutes: 0 }) }),
      );

      expect(createTweetMock).toHaveBeenNthCalledWith(2, { text: "first follow-up", inReplyToTweetId: "root-1" });
      expect(createTweetMock).toHaveBeenNthCalledWith(3, { text: "second follow-up", inReplyToTweetId: "reply-1" });
      // The result is the ROOT's ref, not the last reply's.
      expect(result.ref).toBe("root-1");
      expect(result.queued).toBeUndefined();
      // Every reply's own ref, so a delete can remove them: deleting the root
      // does not delete its replies on X.
      expect(result.replyRefs).toEqual(["reply-1", "reply-2"]);
    });

    /**
     * ⛔ ONCE THE ROOT IS LIVE, A FAILED REPLY MUST NOT FAIL publishNow: a throw
     * sent the whole publishNow again (the retry wrapper on a 429, the ring on
     * anything else), and on X the second root draws a duplicate-content 403
     * that leaves the live root unrecorded.
     */
    it.each([
      ["a vendor error", new XError(503, "Service Unavailable", "POST", "/tweets"), "Service Unavailable"],
      ["a non-Error rejection", "socket hang up", "socket hang up"],
    ])("stops the inline chain at a failed reply (%s) and returns the root with a warning", async (_label, failure, reason) => {
      createTweetMock
        .mockResolvedValueOnce({ id: "root-1", text: "root" })
        .mockResolvedValueOnce({ id: "reply-1", text: "one" })
        .mockRejectedValueOnce(failure);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      const result = await xTransport.publishNow(input({ render: render({ threadItems: ["one", "two", "three"] }) }));

      // Root, reply one, the failed reply two; reply three is never attempted.
      expect(createTweetMock).toHaveBeenCalledTimes(3);
      expect(result.ref).toBe("root-1");
      expect(result.warnings).toEqual([expect.stringContaining("thread stopped at reply 2 of 3")]);
      expect(result.warnings![0]).toContain(reason);
      // The reply that landed before the failure is still recorded.
      expect(result.replyRefs).toEqual(["reply-1"]);
      warn.mockRestore();
    });

    it("with a delay, posts only the root and returns threadRoot + queued replies (each parented on the ROOT), due at position*delay", async () => {
      createTweetMock.mockResolvedValue({ id: "root-1", text: "root" });
      const now = Date.parse("2026-08-02T12:00:00.000Z");
      vi.useFakeTimers();
      vi.setSystemTime(now);

      const result = await xTransport.publishNow(input({ render: render({ threadItems: ["a", "b"], followupDelayMinutes: 10 }) }));

      expect(createTweetMock).toHaveBeenCalledTimes(1); // only the root — replies are deferred, not sent inline
      expect(result.threadRoot).toEqual({ id: "root-1" });
      expect(result.queued).toEqual([
        { position: 1, text: "a", dueAt: new Date(now + 10 * 60_000).toISOString(), parent: { id: "root-1" } },
        { position: 2, text: "b", dueAt: new Date(now + 20 * 60_000).toISOString(), parent: { id: "root-1" } },
      ]);
      vi.useRealTimers();
    });
  });

  describe("publishReply", () => {
    it("posts one queued reply in_reply_to its own persisted parent, and returns selfRef", async () => {
      createTweetMock.mockResolvedValue({ id: "deferred-1", text: "deferred follow-up" });

      const reply: DirectQueuedReply = {
        position: 1,
        text: "deferred follow-up",
        dueAt: new Date().toISOString(),
        parent: { id: "root-1" },
      };

      const result = await xTransport.publishReply!(reply, { id: "root-1" });

      expect(createTweetMock).toHaveBeenCalledWith({ text: "deferred follow-up", inReplyToTweetId: "root-1" });
      expect(result.ref).toBe("deferred-1");
      expect(result.selfRef).toEqual({ id: "deferred-1" });
    });

    it("throws rather than posting when the persisted root handle is malformed", async () => {
      const reply: DirectQueuedReply = { position: 1, text: "x", dueAt: new Date().toISOString(), parent: { id: "root-1" } };
      await expect(xTransport.publishReply!(reply, {})).rejects.toThrow(/threadRoot.*missing id/);
      expect(createTweetMock).not.toHaveBeenCalled();
    });

    it("throws rather than posting when the persisted reply parent is malformed", async () => {
      const reply: DirectQueuedReply = { position: 1, text: "x", dueAt: new Date().toISOString(), parent: {} };
      await expect(xTransport.publishReply!(reply, { id: "root-1" })).rejects.toThrow(/queued reply parent.*missing id/);
      expect(createTweetMock).not.toHaveBeenCalled();
    });
  });

  describe("deletePost", () => {
    it("deletes normally when the tweet still exists", async () => {
      deleteTweetMock.mockResolvedValue(undefined);
      await expect(xTransport.deletePost("1")).resolves.toBeUndefined();
    });

    it("treats an already-gone tweet (404) as SUCCESS, not a failure", async () => {
      deleteTweetMock.mockRejectedValue(notFound());
      await expect(xTransport.deletePost("gone")).resolves.toBeUndefined();
    });

    it("still throws for a real failure (e.g. auth), not just swallowing everything", async () => {
      deleteTweetMock.mockRejectedValue(new XError(401, "token expired", "DELETE", "/tweets/1"));
      await expect(xTransport.deletePost("1")).rejects.toThrow(/token expired/);
    });
  });

  describe("postFacts", () => {
    it("maps a found tweet to PUBLISHED/released", async () => {
      getTweetsBatchMock.mockResolvedValue({ data: [{ id: "1", text: "still here" }], errors: [] });
      const facts = await xTransport.postFacts(["1"]);
      expect(facts.get("1")).toEqual({ state: "PUBLISHED", released: true, platform: "twitter" });
    });

    /**
     * X's batch lookup STATES absence explicitly (a resource-not-found Problem
     * naming the id), unlike Bluesky's silent omission — but it still must not
     * become ERROR. ERROR is a permanent verdict the caller alone gets to make
     * (see pinterest-transport.ts's postFacts docblock for the full reasoning).
     */
    it("maps a confirmed resource-not-found error to QUEUE with absent:true", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      getTweetsBatchMock.mockResolvedValue({
        data: [],
        errors: [
          {
            type: "https://api.twitter.com/2/problems/resource-not-found",
            title: "Not Found Error",
            resource_id: "gone",
            resource_type: "tweet",
          },
        ],
      });
      const facts = await xTransport.postFacts(["gone"]);
      expect(facts.get("gone")).toEqual({ state: "QUEUE", released: false, platform: "twitter", absent: true });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("confirmed absent"));
      warn.mockRestore();
    });

    it("maps a ref that is neither found nor confirmed-not-found to QUEUE without absent", async () => {
      getTweetsBatchMock.mockResolvedValue({ data: [], errors: [] });
      const facts = await xTransport.postFacts(["ambiguous"]);
      expect(facts.get("ambiguous")).toEqual({ state: "QUEUE", released: false, platform: "twitter" });
    });

    it("maps an unreachable vendor (batch call throws) to QUEUE for the whole batch, never ERROR", async () => {
      getTweetsBatchMock.mockRejectedValue(new XError(503, "upstream unavailable", "GET", "/tweets"));
      const facts = await xTransport.postFacts(["a", "b"]);
      expect(facts.get("a")).toEqual({ state: "QUEUE", released: false, platform: "twitter" });
      expect(facts.get("b")).toEqual({ state: "QUEUE", released: false, platform: "twitter" });
    });

    it("returns an empty map for an empty ref list without calling the vendor", async () => {
      const facts = await xTransport.postFacts([]);
      expect(facts.size).toBe(0);
      expect(getTweetsBatchMock).not.toHaveBeenCalled();
    });

    it("chunks a large batch at the vendor's documented 100-id limit rather than one call per ref", async () => {
      getTweetsBatchMock.mockImplementation(async (ids: string[]) => ({
        data: ids.map((id) => ({ id, text: "" })),
        errors: [],
      }));
      const refs = Array.from({ length: 150 }, (_, i) => `t-${i}`);
      const facts = await xTransport.postFacts(refs);
      expect(facts.size).toBe(150);
      expect(getTweetsBatchMock).toHaveBeenCalledTimes(2);
      expect(getTweetsBatchMock.mock.calls[0][0]).toHaveLength(100);
      expect(getTweetsBatchMock.mock.calls[1][0]).toHaveLength(50);
    });
  });
});

describe("x transport: non-Error failures, alt text, url-less assets and media host errors", () => {
  const fetchMock = () => fetch as unknown as ReturnType<typeof vi.fn>;
  const setAltMock = setMediaAltText as unknown as ReturnType<typeof vi.fn>;
  // A real Response per call: the shared media fetch streams res.body under a
  // byte cap (media-fetch.ts), and a body can only be consumed once.
  const okBytes = () => new Response(new Uint8Array([7]));

  // Braces matter: a function RETURNED from beforeEach is run as its teardown,
  // and mockReset() returns the mock itself.
  beforeEach(() => {
    setAltMock.mockReset();
  });

  it("connectStatus stringifies a thrown non-Error into the reason", async () => {
    getMeMock.mockRejectedValue("socket hang up");
    const status = await xTransport.connectStatus();
    expect(status).toEqual({ connected: false, accountId: "", displayName: "", reason: "socket hang up" });
  });

  it("refuses to post when the media host answers non-2xx", async () => {
    fetchMock().mockResolvedValue({ ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0) });
    await expect(xTransport.publishNow(input({ media: [image()] }))).rejects.toThrow(
      "x: failed to fetch media asset (500): https://cdn.example.com/card.png",
    );
    expect(createTweetMock).not.toHaveBeenCalled();
  });

  // The media asset fetch reads a response body into memory; with NO byte cap
  // a hostile or broken asset URL could buffer an unbounded body in the
  // process. This pins the
  // cap at the transport seam users actually hit: a response that DECLARES more
  // bytes than the fetch cap is refused before a byte is read, whatever its
  // real body holds.
  it("refuses a media response that declares more bytes than the fetch cap", async () => {
    fetchMock().mockImplementation(
      async () =>
        new Response(new Uint8Array([1]), {
          headers: { "content-length": "999999999999999" },
        }),
    );
    // Mocked so the pre-cap code path would publish happily: the refusal has to
    // come from the fetch cap, not from a later unmocked call.
    uploadImageMock.mockResolvedValue("media-1");
    createTweetMock.mockResolvedValue({ id: "root-1", text: "t" });
    await expect(xTransport.publishNow(input({ media: [image()] }))).rejects.toThrow(
      /x: media asset exceeds the fetch byte cap/,
    );
    expect(uploadImageMock).not.toHaveBeenCalled();
    expect(createTweetMock).not.toHaveBeenCalled();
  });

  it.each([
    ["an image", image({ path: "/lib/a.png", url: undefined })],
    ["a video", { path: "/lib/a.png", type: "video", mimeType: "video/mp4", size: 1 } as MediaAsset],
    ["a GIF", { path: "/lib/a.png", type: "gif", mimeType: "image/gif", size: 1 } as MediaAsset],
  ])("refuses %s with no public url instead of posting without it", async (_label, asset) => {
    fetchMock().mockImplementation(okBytes);
    uploadImageMock.mockResolvedValue("media-2");
    createTweetMock.mockResolvedValue({ id: "root-2", text: "t" });

    await expect(xTransport.publishNow(input({ media: [asset] }))).rejects.toMatchObject({
      name: "PublishPreflightError",
      message: expect.stringContaining("x: media asset /lib/a.png has no public url"),
    });
    expect(createTweetMock).not.toHaveBeenCalled();
  });

  it.each([
    ["video", { path: "/tmp/clip.mp4", type: "video", mimeType: "video/mp4", size: 1, url: "https://cdn.example.com/clip.mp4" }],
    ["GIF", { path: "/tmp/clip.gif", type: "gif", mimeType: "image/gif", size: 1, url: "https://cdn.example.com/clip.gif" }],
  ] as Array<[string, MediaAsset]>)("gives a %s's bytes the 120s fetch budget, not the 20s image one", async (_label, asset) => {
    fetchMock().mockImplementation(okBytes);
    uploadVideoMock.mockResolvedValue("v");
    uploadGifMock.mockResolvedValue("g");
    createTweetMock.mockResolvedValue({ id: "root-2", text: "t" });
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    try {
      await xTransport.publishNow(input({ media: [asset] }));
      expect(timeoutSpy).toHaveBeenCalledWith(120_000);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("still posts, and warns with the vendor's message, when alt text cannot be attached", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock().mockImplementation(okBytes);
    uploadImageMock.mockResolvedValue("media-3");
    setAltMock.mockRejectedValue(new XError(403, "forbidden", "POST", "/media/metadata"));
    createTweetMock.mockResolvedValue({ id: "root-3", text: "t" });

    const result = await xTransport.publishNow(input({ media: [image()] }));

    expect(result.ref).toBe("root-3");
    expect(setAltMock).toHaveBeenCalledWith("media-3", "a screenshot of the Acme dashboard");
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^\[x\] alt text could not be attached to media media-3: /));
    warn.mockRestore();
  });

  it("stringifies a non-Error alt-text failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock().mockImplementation(okBytes);
    uploadImageMock.mockResolvedValue("media-4");
    setAltMock.mockRejectedValue("ECONNRESET");
    createTweetMock.mockResolvedValue({ id: "root-4", text: "t" });

    await xTransport.publishNow(input({ media: [image()] }));

    expect(warn).toHaveBeenCalledWith("[x] alt text could not be attached to media media-4: ECONNRESET");
    warn.mockRestore();
  });

  it("chains thread items inline when the render carries no delay at all", async () => {
    createTweetMock
      .mockResolvedValueOnce({ id: "root-5", text: "root" })
      .mockResolvedValueOnce({ id: "reply-5", text: "more" });

    const result = await xTransport.publishNow(input({ render: render({ threadItems: ["more"] }) }));

    expect(createTweetMock).toHaveBeenNthCalledWith(2, { text: "more", inReplyToTweetId: "root-5" });
    expect(result.queued).toBeUndefined();
  });

  it("postFacts maps a batch to QUEUE with the stringified reason on a non-XError failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    getTweetsBatchMock.mockRejectedValue("ECONNRESET");
    const facts = await xTransport.postFacts(["1"]);
    expect(facts.get("1")).toEqual({ state: "QUEUE", released: false, platform: "twitter" });
    expect(warn).toHaveBeenCalledWith("[x] postFacts lookup failed for a batch of 1: ECONNRESET");
    warn.mockRestore();
  });
});
