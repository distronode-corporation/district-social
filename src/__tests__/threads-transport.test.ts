import { describe, it, expect, vi, beforeEach } from "vitest";

// The transport is a business-logic layer on top of the vendor client, so it
// is tested against a mocked client — same pattern bluesky-transport.test.ts
// and pinterest-transport.test.ts use for their own vendor modules.
// ThreadsError and isThreadsNotFound stay real: isThreadsNotFound's
// `instanceof` check is exactly the thing under test in the delete/postFacts
// idempotency cases.
vi.mock("../threads.js", async (importActual) => {
  const actual = await importActual<typeof import("../threads.js")>();
  return {
    ...actual,
    createContainer: vi.fn(),
    publishContainer: vi.fn(),
    getContainerStatus: vi.fn(),
    pollContainerUntilFinished: vi.fn(),
    deleteThread: vi.fn(),
    getPermalink: vi.fn(),
    getProfile: vi.fn(),
    getMediaInsights: vi.fn(),
    getUserInsights: vi.fn(),
  };
});

import {
  createContainer,
  publishContainer,
  pollContainerUntilFinished,
  deleteThread,
  getPermalink,
  getProfile,
  getMediaInsights,
  getUserInsights,
  ThreadsError,
} from "../threads.js";
import { threadsTransport, liftTopicTag, VIDEO_POLL } from "../threads-transport.js";
import { PublishPreflightError } from "../publish.js";
import type { DirectPublishInput, DirectQueuedReply } from "../transport.js";
import type { MediaAsset, PlatformRender } from "../types.js";

const getMediaInsightsMock = getMediaInsights as unknown as ReturnType<typeof vi.fn>;
const getUserInsightsMock = getUserInsights as unknown as ReturnType<typeof vi.fn>;
const createContainerMock = createContainer as unknown as ReturnType<typeof vi.fn>;
const publishContainerMock = publishContainer as unknown as ReturnType<typeof vi.fn>;
const pollMock = pollContainerUntilFinished as unknown as ReturnType<typeof vi.fn>;
const deleteThreadMock = deleteThread as unknown as ReturnType<typeof vi.fn>;
const getPermalinkMock = getPermalink as unknown as ReturnType<typeof vi.fn>;
const getProfileMock = getProfile as unknown as ReturnType<typeof vi.fn>;

function render(overrides: Partial<PlatformRender> = {}): PlatformRender {
  return { platform: "threads", content: "hello from Acme", mediaIndices: [], ...overrides };
}

function media(overrides: Partial<MediaAsset> = {}): MediaAsset {
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

function input(overrides: Partial<DirectPublishInput> = {}): DirectPublishInput {
  return { render: render(), media: [], draftId: "draft-1", destination: {}, ...overrides };
}

beforeEach(() => {
  createContainerMock.mockReset();
  publishContainerMock.mockReset();
  pollMock.mockReset().mockResolvedValue(undefined);
  deleteThreadMock.mockReset();
  getPermalinkMock.mockReset().mockResolvedValue(undefined);
  getProfileMock.mockReset();
});

describe("threads transport", () => {
  it("declares the REAL vendor limits: 500 chars (utf16), 20-image carousels, 8MB per image", () => {
    // All three verified against developers.facebook.com/docs/threads
    // directly, not inherited from an aggregator's schema. maxImageBytes
    // matters specifically because QA's image-too-large gate has no aggregator
    // feed and falls back to whatever the transport declares here.
    expect(threadsTransport.channelRules()).toEqual({
      maxLength: 500,
      countMode: "utf16",
      maxImages: 20,
      maxImageBytes: 8 * 1024 * 1024,
      // Wider than Instagram's JPEG-only, which is why this is a list. A PNG
      // card reaches Threads untouched and is re-encoded only for Instagram.
      imageFormats: ["image/jpeg", "image/png"],
      // Video posts: "5 minutes maximum", "1 GB maximum" (posts doc), the
      // same figures SPECS.threads carries.
      maxVideoBytes: 1024 * 1024 * 1024,
      maxVideoSec: 300,
    });
  });

  describe("connectStatus", () => {
    it("reports connected with the account's id/username", async () => {
      getProfileMock.mockResolvedValue({ id: "999", username: "examplebrand" });
      const status = await threadsTransport.connectStatus();
      expect(status).toEqual({ connected: true, accountId: "999", displayName: "examplebrand" });
    });

    it("resolves (never rejects) connected:false with a reason on a bad credential", async () => {
      getProfileMock.mockRejectedValue(new ThreadsError("Invalid OAuth access token", 401, 190, null, "OAuthException", null));
      await expect(threadsTransport.connectStatus()).resolves.toMatchObject({
        connected: false,
        accountId: "",
        displayName: "",
        reason: expect.stringContaining("Invalid OAuth access token"),
      });
    });
  });

  describe("publishNow: text post", () => {
    it("creates a TEXT container, polls, publishes, and fetches the real permalink", async () => {
      createContainerMock.mockResolvedValueOnce({ id: "container-1" });
      publishContainerMock.mockResolvedValueOnce({ id: "post-1" });
      getPermalinkMock.mockResolvedValueOnce("https://www.threads.net/@examplebrand/post/abc");

      const result = await threadsTransport.publishNow(input());

      expect(createContainerMock).toHaveBeenCalledWith({ mediaType: "TEXT", text: "hello from Acme" });
      expect(pollMock).toHaveBeenCalledWith("container-1");
      expect(publishContainerMock).toHaveBeenCalledWith("container-1");
      expect(result).toEqual({ ref: "post-1", url: "https://www.threads.net/@examplebrand/post/abc" });
    });

    it("falls back to a best-effort URL when the permalink lookup fails, without failing the publish", async () => {
      createContainerMock.mockResolvedValueOnce({ id: "container-1" });
      publishContainerMock.mockResolvedValueOnce({ id: "post-1" });
      getPermalinkMock.mockRejectedValueOnce(new ThreadsError("timeout", 0, null, null, null, null));

      const result = await threadsTransport.publishNow(input());
      expect(result.ref).toBe("post-1");
      expect(result.url).toBe("https://www.threads.net/post/post-1");
    });
  });

  describe("publishNow: image post", () => {
    it("creates an IMAGE container with image_url and the render's text as caption", async () => {
      createContainerMock.mockResolvedValueOnce({ id: "container-1" });
      publishContainerMock.mockResolvedValueOnce({ id: "post-1" });

      await threadsTransport.publishNow(input({ media: [media()] }));

      expect(createContainerMock).toHaveBeenCalledWith({
        mediaType: "IMAGE",
        text: "hello from Acme",
        imageUrl: "https://cdn.example.com/card.png",
        // The draft's alt text was always present on the asset and was simply
        // never sent — Threads accepts `alt_text` on the container.
        altText: "a screenshot of the Acme dashboard",
      });
    });

    it("builds a CAROUSEL with a polled, is_carousel_item child container per image, for 2+ images", async () => {
      createContainerMock
        .mockResolvedValueOnce({ id: "child-1" })
        .mockResolvedValueOnce({ id: "child-2" })
        .mockResolvedValueOnce({ id: "carousel-1" });
      publishContainerMock.mockResolvedValueOnce({ id: "post-1" });

      const images = [media({ url: "https://cdn.example.com/1.png" }), media({ url: "https://cdn.example.com/2.png" })];
      await threadsTransport.publishNow(input({ media: images }));

      // PER-CHILD alt text: each carousel slide is its own container, so each
      // carries the alt for the image it actually holds.
      expect(createContainerMock).toHaveBeenNthCalledWith(1, {
        mediaType: "IMAGE",
        imageUrl: "https://cdn.example.com/1.png",
        isCarouselItem: true,
        altText: "a screenshot of the Acme dashboard",
      });
      expect(createContainerMock).toHaveBeenNthCalledWith(2, {
        mediaType: "IMAGE",
        imageUrl: "https://cdn.example.com/2.png",
        isCarouselItem: true,
        altText: "a screenshot of the Acme dashboard",
      });
      expect(createContainerMock).toHaveBeenNthCalledWith(3, {
        mediaType: "CAROUSEL",
        text: "hello from Acme",
        children: ["child-1", "child-2"],
      });
      // each child polled before the carousel parent, plus the parent itself
      expect(pollMock).toHaveBeenCalledTimes(3);
      expect(publishContainerMock).toHaveBeenCalledWith("carousel-1");
    });

    // A urlless asset is REFUSED, not skipped. See "publishNow: media
    // refusals" below, which replaced the earlier silent-skip behaviour:
    // posting text only, when the draft attached an image, is content loss
    // with no error attached to it.
  });

  describe("publishNow: video", () => {
    function clip(overrides: Partial<MediaAsset> = {}): MediaAsset {
      return media({
        path: "veo-clip.mp4",
        type: "video",
        mimeType: "video/mp4",
        size: 4_000_000,
        durationSec: 8,
        url: "https://media.example.com/social-hq/assets/v1/clip.mp4",
        altText: "a phone answering itself",
        ...overrides,
      });
    }

    it("publishes one video as a VIDEO container on the video poll budget, with the image result shape", async () => {
      createContainerMock.mockResolvedValueOnce({ id: "video-container" });
      publishContainerMock.mockResolvedValueOnce({ id: "post-v1" });
      getPermalinkMock.mockResolvedValueOnce("https://www.threads.net/@examplebrand/post/Cv1");

      const result = await threadsTransport.publishNow(input({ media: [clip()] }));

      expect(result).toEqual({ ref: "post-v1", url: "https://www.threads.net/@examplebrand/post/Cv1" });
      expect(createContainerMock).toHaveBeenCalledTimes(1);
      expect(createContainerMock).toHaveBeenCalledWith({
        mediaType: "VIDEO",
        text: "hello from Acme",
        videoUrl: "https://media.example.com/social-hq/assets/v1/clip.mp4",
        altText: "a phone answering itself",
        topicTag: undefined,
        crossShareToIgStory: undefined,
      });
      expect(pollMock).toHaveBeenCalledWith("video-container", VIDEO_POLL);
      expect(VIDEO_POLL).toEqual({ maxAttempts: 36, intervalMs: 5_000 });
      expect(publishContainerMock).toHaveBeenCalledWith("video-container");
    });

    it("carries the topic tag and the Instagram Story cross-share on a video post too", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      createContainerMock.mockResolvedValueOnce({ id: "video-container" });
      publishContainerMock.mockResolvedValueOnce({ id: "post-v1", crossShareToIgStatus: "SUCCESS" });

      await threadsTransport.publishNow(
        input({
          render: render({ content: "Answered in region #VoiceAI", threadsCrossShareToIgStory: true }),
          media: [clip({ mimeType: "video/quicktime", durationSec: undefined })],
        }),
      );

      expect(createContainerMock).toHaveBeenCalledWith(
        expect.objectContaining({ mediaType: "VIDEO", text: "Answered in region", topicTag: "VoiceAI", crossShareToIgStory: true }),
      );
      warn.mockRestore();
    });

    it("does not publish when the video container fails processing", async () => {
      createContainerMock.mockResolvedValueOnce({ id: "video-container" });
      pollMock.mockRejectedValueOnce(
        new ThreadsError("container video-container failed processing: FAILED_DOWNLOADING_VIDEO", 0, null, null, null, null),
      );

      await expect(threadsTransport.publishNow(input({ media: [clip()] }))).rejects.toThrow(/FAILED_DOWNLOADING_VIDEO/);
      expect(publishContainerMock).not.toHaveBeenCalled();
    });

    it.each([
      ["a video mixed with an image", () => [media(), clip()], /exactly one video/],
      ["two videos", () => [clip(), clip({ path: "b.mp4" })], /video inside a Threads carousel is not built/],
      ["a webm", () => [clip({ mimeType: "video/webm" })], /MP4 or MOV video only/],
      ["a video with no public url", () => [clip({ url: undefined })], /has no public url/],
      ["a video over 5 minutes", () => [clip({ durationSec: 301 })], /at most 300s/],
    ])("refuses %s with a PublishPreflightError before any network call", async (_label, list, message) => {
      await expect(threadsTransport.publishNow(input({ media: list() }))).rejects.toBeInstanceOf(PublishPreflightError);
      await expect(threadsTransport.publishNow(input({ media: list() }))).rejects.toThrow(message);
      expect(createContainerMock).not.toHaveBeenCalled();
      expect(publishContainerMock).not.toHaveBeenCalled();
    });

    it("keeps image legs on the client's default poll budget", async () => {
      createContainerMock.mockResolvedValueOnce({ id: "image-container" });
      publishContainerMock.mockResolvedValueOnce({ id: "post-1" });
      await threadsTransport.publishNow(input({ media: [media()] }));
      expect(pollMock).toHaveBeenCalledWith("image-container");
      expect(pollMock.mock.calls[0]).toHaveLength(1);
    });
  });

  /**
   * Unsendable media is LOUD, never quietly filtered out. Both of these used to
   * be a `.filter()` that dropped the asset and posted text only, which gives
   * an operator who attached an image no error to read and no reason to look.
   */
  describe("publishNow: media refusals", () => {
    it("refuses a GIF, because Threads documents JPEG and PNG as its only image formats", async () => {
      await expect(
        threadsTransport.publishNow(input({ media: [media({ type: "gif", mimeType: "image/gif" })] })),
      ).rejects.toThrow(/JPEG and PNG/);
      expect(createContainerMock).not.toHaveBeenCalled();
    });

    it("refuses an asset with no public url instead of posting text only", async () => {
      await expect(
        threadsTransport.publishNow(input({ media: [media({ url: undefined })] })),
      ).rejects.toThrow(/no public url/);
      expect(createContainerMock).not.toHaveBeenCalled();
    });

    it("still accepts PNG, which Threads takes and Instagram does not", async () => {
      createContainerMock.mockResolvedValueOnce({ id: "container-1" });
      publishContainerMock.mockResolvedValueOnce({ id: "post-1" });

      await expect(
        threadsTransport.publishNow(input({ media: [media({ mimeType: "image/png" })] })),
      ).resolves.toMatchObject({ ref: "post-1" });
    });
  });

  /**
   * Threads is the ONLY platform where supportsThreads and supportsFirstComment
   * are both true, and on it a first comment IS a reply in the same chain, so
   * a transport that only read `threadItems` would silently lose it.
   */
  describe("publishNow: firstComment", () => {
    it("posts a lone firstComment as a reply in the chain", async () => {
      createContainerMock
        .mockResolvedValueOnce({ id: "root-container" })
        .mockResolvedValueOnce({ id: "comment-container" });
      publishContainerMock
        .mockResolvedValueOnce({ id: "post-1" })
        .mockResolvedValueOnce({ id: "post-2" });

      const result = await threadsTransport.publishNow(
        input({ render: render({ firstComment: "More at https://example.com" }) }),
      );

      expect(createContainerMock).toHaveBeenCalledTimes(2);
      expect(createContainerMock).toHaveBeenLastCalledWith({
        mediaType: "TEXT",
        text: "More at https://example.com",
        replyToId: "post-1",
      });
      expect(result.ref).toBe("post-1");
    });

    it("keeps BOTH: thread items first, then the first comment closing the chain", async () => {
      createContainerMock
        .mockResolvedValueOnce({ id: "root-container" })
        .mockResolvedValueOnce({ id: "item-container" })
        .mockResolvedValueOnce({ id: "comment-container" });
      publishContainerMock
        .mockResolvedValueOnce({ id: "post-1" })
        .mockResolvedValueOnce({ id: "post-2" })
        .mockResolvedValueOnce({ id: "post-3" });

      await threadsTransport.publishNow(
        input({
          render: render({ threadItems: ["the second beat"], firstComment: "Link: https://example.com" }),
        }),
      );

      expect(createContainerMock.mock.calls.map((c) => c[0].text)).toEqual([
        "hello from Acme",
        "the second beat",
        "Link: https://example.com",
      ]);
    });

    it("defers the firstComment with the rest of the chain when a delay is set", async () => {
      createContainerMock.mockResolvedValueOnce({ id: "root-container" });
      publishContainerMock.mockResolvedValueOnce({ id: "post-1" });

      const result = await threadsTransport.publishNow(
        input({
          render: render({
            threadItems: ["the second beat"],
            firstComment: "Link: https://example.com",
            followupDelayMinutes: 30,
          }),
        }),
      );

      expect(result.queued?.map((q) => q.text)).toEqual(["the second beat", "Link: https://example.com"]);
      expect(result.queued?.map((q) => q.position)).toEqual([1, 2]);
    });
  });

  describe("publishNow: threads", () => {
    it("with no threadItems, returns just the root ref and url", async () => {
      createContainerMock.mockResolvedValueOnce({ id: "container-1" });
      publishContainerMock.mockResolvedValueOnce({ id: "post-1" });

      const result = await threadsTransport.publishNow(input());
      expect(result.queued).toBeUndefined();
      expect(result.threadRoot).toBeUndefined();
    });

    it("with no delay, chains every reply inline, each reply's reply_to_id targeting the immediately prior post", async () => {
      createContainerMock
        .mockResolvedValueOnce({ id: "root-container" })
        .mockResolvedValueOnce({ id: "reply1-container" })
        .mockResolvedValueOnce({ id: "reply2-container" });
      publishContainerMock
        .mockResolvedValueOnce({ id: "root-post" })
        .mockResolvedValueOnce({ id: "reply1-post" })
        .mockResolvedValueOnce({ id: "reply2-post" });

      const result = await threadsTransport.publishNow(
        input({ render: render({ threadItems: ["first follow-up", "second follow-up"], followupDelayMinutes: 0 }) }),
      );

      expect(createContainerMock).toHaveBeenNthCalledWith(2, { mediaType: "TEXT", text: "first follow-up", replyToId: "root-post" });
      expect(createContainerMock).toHaveBeenNthCalledWith(3, { mediaType: "TEXT", text: "second follow-up", replyToId: "reply1-post" });
      // The result is the ROOT's ref, not the last reply's.
      expect(result.ref).toBe("root-post");
      expect(result.queued).toBeUndefined();
      // Every reply's own ref, so a delete can remove them.
      expect(result.replyRefs).toEqual(["reply1-post", "reply2-post"]);
    });

    /**
     * ⛔ ONCE THE ROOT IS LIVE, A FAILED REPLY MUST NOT FAIL publishNow: a throw
     * sent the whole publishNow again, posting the root a second time. The chain
     * here also carries the first comment, so it is covered by the same rule.
     */
    it.each([
      ["a vendor error", new ThreadsError("rate limited", 429, 4, null, "OAuthException", null), "rate limited"],
      ["a non-Error rejection", "socket hang up", "socket hang up"],
    ])("stops the inline chain at a failed reply (%s) and returns the root with a warning", async (_label, failure, reason) => {
      createContainerMock
        .mockResolvedValueOnce({ id: "root-container" })
        .mockResolvedValueOnce({ id: "reply1-container" })
        .mockRejectedValueOnce(failure);
      publishContainerMock.mockResolvedValueOnce({ id: "root-post" }).mockResolvedValueOnce({ id: "reply1-post" });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      const result = await threadsTransport.publishNow(
        input({ render: render({ threadItems: ["one", "two"], firstComment: "link", followupDelayMinutes: 0 }) }),
      );

      // Root, reply one, the failed reply two; the first comment is never attempted.
      expect(createContainerMock).toHaveBeenCalledTimes(3);
      expect(publishContainerMock).toHaveBeenCalledTimes(2);
      expect(result.ref).toBe("root-post");
      expect(result.warnings).toEqual([expect.stringContaining("thread stopped at reply 2 of 3")]);
      expect(result.warnings![0]).toContain(reason);
      // The reply that landed before the failure is still recorded.
      expect(result.replyRefs).toEqual(["reply1-post"]);
      warn.mockRestore();
    });

    it("with a delay, posts only the root and returns threadRoot + queued replies parented on the root, due at position*delay", async () => {
      createContainerMock.mockResolvedValueOnce({ id: "root-container" });
      publishContainerMock.mockResolvedValueOnce({ id: "root-post" });
      const now = Date.parse("2026-08-02T12:00:00.000Z");
      vi.useFakeTimers();
      vi.setSystemTime(now);

      const result = await threadsTransport.publishNow(
        input({ render: render({ threadItems: ["a", "b"], followupDelayMinutes: 10 }) }),
      );

      expect(createContainerMock).toHaveBeenCalledTimes(1); // only the root — replies are deferred, not created inline
      expect(result.threadRoot).toEqual({ id: "root-post" });
      expect(result.queued).toEqual([
        { position: 1, text: "a", dueAt: new Date(now + 10 * 60_000).toISOString(), parent: { id: "root-post" } },
        { position: 2, text: "b", dueAt: new Date(now + 20 * 60_000).toISOString(), parent: { id: "root-post" } },
      ]);
      vi.useRealTimers();
    });
  });

  describe("publishReply", () => {
    it("posts one queued reply with reply_to_id = its own parent, and returns selfRef for the NEXT reply to chain onto", async () => {
      createContainerMock.mockResolvedValueOnce({ id: "reply-container" });
      publishContainerMock.mockResolvedValueOnce({ id: "reply-post" });
      getPermalinkMock.mockResolvedValueOnce("https://www.threads.net/@examplebrand/post/def");

      const root = { id: "root-post" };
      const reply: DirectQueuedReply = {
        position: 1,
        text: "deferred follow-up",
        dueAt: new Date().toISOString(),
        parent: { id: "root-post" },
      };

      const result = await threadsTransport.publishReply!(reply, root);

      expect(createContainerMock).toHaveBeenCalledWith({ mediaType: "TEXT", text: "deferred follow-up", replyToId: "root-post" });
      expect(result.ref).toBe("reply-post");
      expect(result.selfRef).toEqual({ id: "reply-post" });
    });

    it("chains reply N+1 onto reply N's selfRef, not onto the root, when a caller (drainReplies) supplies it as parent", async () => {
      createContainerMock.mockResolvedValueOnce({ id: "reply2-container" });
      publishContainerMock.mockResolvedValueOnce({ id: "reply2-post" });

      const root = { id: "root-post" };
      // publish-due.ts's drainReplies overwrites `parent` with the previous
      // reply's selfRef before calling publishReply — simulated here directly.
      const reply: DirectQueuedReply = {
        position: 2,
        text: "second deferred follow-up",
        dueAt: new Date().toISOString(),
        parent: { id: "reply1-post" },
      };

      await threadsTransport.publishReply!(reply, root);

      expect(createContainerMock).toHaveBeenCalledWith({
        mediaType: "TEXT",
        text: "second deferred follow-up",
        replyToId: "reply1-post",
      });
    });

    it("falls back to the root's id when the reply carries no parent", async () => {
      createContainerMock.mockResolvedValueOnce({ id: "reply-container" });
      publishContainerMock.mockResolvedValueOnce({ id: "reply-post" });

      const root = { id: "root-post" };
      const reply = { position: 1, text: "x", dueAt: new Date().toISOString(), parent: {} } as DirectQueuedReply;

      await threadsTransport.publishReply!(reply, root);
      expect(createContainerMock).toHaveBeenCalledWith({ mediaType: "TEXT", text: "x", replyToId: "root-post" });
    });

    it("throws when neither the reply nor the root carries an id", async () => {
      const reply = { position: 1, text: "x", dueAt: new Date().toISOString(), parent: {} } as DirectQueuedReply;
      await expect(threadsTransport.publishReply!(reply, {})).rejects.toThrow(/missing an "id" handle/);
      expect(createContainerMock).not.toHaveBeenCalled();
    });
  });

  describe("postFacts", () => {
    it("maps a found post to PUBLISHED/released", async () => {
      getPermalinkMock.mockResolvedValue("https://www.threads.net/@examplebrand/post/abc");
      const facts = await threadsTransport.postFacts(["post-1"]);
      expect(facts.get("post-1")).toEqual({ state: "PUBLISHED", released: true, platform: "threads" });
    });

    it("maps a CONFIRMED 404 to QUEUE, never ERROR", async () => {
      getPermalinkMock.mockRejectedValue(new ThreadsError("gone", 404, null, null, null, null));
      const facts = await threadsTransport.postFacts(["post-gone"]);
      expect(facts.get("post-gone")).toEqual({ state: "QUEUE", released: false, platform: "threads" });
    });

    it("maps an unreachable-vendor failure to QUEUE, never ERROR", async () => {
      getPermalinkMock.mockRejectedValue(new ThreadsError("no response after 15s", 0, null, null, null, null));
      const facts = await threadsTransport.postFacts(["post-1", "post-2"]);
      expect(facts.get("post-1")).toEqual({ state: "QUEUE", released: false, platform: "threads" });
      expect(facts.get("post-2")).toEqual({ state: "QUEUE", released: false, platform: "threads" });
    });

    it("returns an empty map for an empty ref list", async () => {
      const facts = await threadsTransport.postFacts([]);
      expect(facts.size).toBe(0);
      expect(getPermalinkMock).not.toHaveBeenCalled();
    });
  });

  describe("deletePost", () => {
    it("deletes normally when the post still exists", async () => {
      deleteThreadMock.mockResolvedValue(undefined);
      await expect(threadsTransport.deletePost("post-1")).resolves.toBeUndefined();
    });

    it("treats an already-gone post (404) as SUCCESS, not a failure", async () => {
      deleteThreadMock.mockRejectedValue(new ThreadsError("gone", 404, null, null, null, null));
      await expect(threadsTransport.deletePost("post-gone")).resolves.toBeUndefined();
    });

    it("still throws for a real failure (e.g. auth), not just swallowing everything", async () => {
      deleteThreadMock.mockRejectedValue(new ThreadsError("Invalid OAuth access token", 401, 190, null, "OAuthException", null));
      await expect(threadsTransport.deletePost("post-1")).rejects.toThrow(/Invalid OAuth access token/);
    });
  });
});

describe("threads analytics", () => {
  it("passes the vendor's own metric names through unrenamed", async () => {
    getMediaInsightsMock.mockResolvedValue({ views: 900, likes: 12, replies: 3, reposts: 1, quotes: 0 });
    await expect(threadsTransport.analyticsPost!("m1")).resolves.toEqual({
      views: 900,
      likes: 12,
      replies: 3,
      reposts: 1,
      // A vendor-reported zero is a real datum and IS kept — the "omit" rule is
      // about counters the vendor never sent, not ones it sent as 0.
      quotes: 0,
    });
  });

  it("reports account insights as channel analytics", async () => {
    getUserInsightsMock.mockResolvedValue({ views: 5000, followers_count: 250 });
    await expect(threadsTransport.analyticsChannel!()).resolves.toEqual({ views: 5000, followers_count: 250 });
  });

  it("reads followers from followers_count", async () => {
    getUserInsightsMock.mockResolvedValue({ followers_count: 250 });
    await expect(threadsTransport.followerStats!()).resolves.toEqual({ followers: 250 });
  });

  /**
   * The metric can be missing because the token lacks permission for it. A
   * fabricated 0 there reads as an account that lost every follower.
   */
  it("THROWS rather than reporting 0 followers when followers_count is absent", async () => {
    getUserInsightsMock.mockResolvedValue({ views: 5000 });
    await expect(threadsTransport.followerStats!()).rejects.toThrow(/followers_count/i);
  });
});

describe("topic_tag", () => {
  it("lifts a lone #tag out of the text into the container's topic tag", async () => {
    createContainerMock.mockResolvedValueOnce({ id: "container-1" });
    publishContainerMock.mockResolvedValueOnce({ id: "post-1" });

    await threadsTransport.publishNow(input({ render: { ...render(), content: "Six voix en français canadien.\n\n#DistrictAI" } }));

    // Threads shows one topic per post and prefers the parameter to an in-text
    // hashtag; the text goes out without the tag so it is not shown twice.
    expect(createContainerMock).toHaveBeenCalledWith({
      mediaType: "TEXT",
      text: "Six voix en français canadien.",
      topicTag: "DistrictAI",
    });
  });

  it("leaves the text alone when there are two hashtags or none", async () => {
    createContainerMock.mockResolvedValue({ id: "container-1" });
    publishContainerMock.mockResolvedValue({ id: "post-1" });

    await threadsTransport.publishNow(input({ render: { ...render(), content: "Two #tags here #too" } }));
    expect(createContainerMock).toHaveBeenLastCalledWith({ mediaType: "TEXT", text: "Two #tags here #too", topicTag: undefined });

    await threadsTransport.publishNow(input({ render: { ...render(), content: "No tag at all" } }));
    expect(createContainerMock).toHaveBeenLastCalledWith({ mediaType: "TEXT", text: "No tag at all", topicTag: undefined });
  });

  it("liftTopicTag refuses a tag Threads would reject and keeps the text intact", () => {
    expect(liftTopicTag("Read example.com #ai.voice")).toEqual({ text: "Read example.com #ai.voice" });
    expect(liftTopicTag("Hello #Québec world")).toEqual({ text: "Hello world", topicTag: "Québec" });
    expect(liftTopicTag("#Lead first line")).toEqual({ text: "first line", topicTag: "Lead" });
  });
});

describe("cross-share to Instagram Story", () => {
  it("sets crossreshare_to_ig on the root container when the render asks for a Story, and logs the vendor's status", async () => {
    createContainerMock.mockResolvedValueOnce({ id: "container-1" });
    publishContainerMock.mockResolvedValueOnce({ id: "post-1", crossShareToIgStatus: "SUCCESS" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await threadsTransport.publishNow(
      input({ render: { ...render(), threadsCrossShareToIgStory: true }, media: [media()] }),
    );

    expect(createContainerMock).toHaveBeenCalledWith(expect.objectContaining({ mediaType: "IMAGE", crossShareToIgStory: true }));
    expect(result.ref).toBe("post-1");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("cross-share to Instagram Story: SUCCESS"));
    warn.mockRestore();
  });

  it("a FAILED Story is a log line, never a failed leg: the Threads post is live by the vendor's contract", async () => {
    createContainerMock.mockResolvedValueOnce({ id: "container-1" });
    publishContainerMock.mockResolvedValueOnce({ id: "post-2", crossShareToIgStatus: "FAILED" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await threadsTransport.publishNow(input({ render: { ...render(), threadsCrossShareToIgStory: true } }));

    expect(result.ref).toBe("post-2");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("FAILED"));
    warn.mockRestore();
  });

  it("sends nothing about Stories when the render does not ask", async () => {
    createContainerMock.mockResolvedValueOnce({ id: "container-1" });
    publishContainerMock.mockResolvedValueOnce({ id: "post-3" });
    await threadsTransport.publishNow(input());
    expect(createContainerMock.mock.calls[0]![0].crossShareToIgStory).toBeUndefined();
  });
});

describe("threads transport: non-Error failures and sparse vendor answers", () => {
  it("connectStatus stringifies a thrown non-Error into the reason", async () => {
    getProfileMock.mockRejectedValue("socket hang up");
    const status = await threadsTransport.connectStatus();
    expect(status).toEqual({ connected: false, accountId: "", displayName: "", reason: "socket hang up" });
  });

  it("falls back to the best-effort URL when the vendor returns no permalink", async () => {
    createContainerMock.mockResolvedValueOnce({ id: "container-1" });
    publishContainerMock.mockResolvedValueOnce({ id: "post-9" });
    getPermalinkMock.mockResolvedValueOnce(undefined);

    const result = await threadsTransport.publishNow(input());

    expect(result.url).toBe("https://www.threads.net/post/post-9");
  });

  it("logs a non-Error permalink failure by value and keeps the post", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    createContainerMock.mockResolvedValueOnce({ id: "container-1" });
    publishContainerMock.mockResolvedValueOnce({ id: "post-1" });
    getPermalinkMock.mockRejectedValueOnce("ETIMEDOUT");

    const result = await threadsTransport.publishNow(input());

    expect(result.ref).toBe("post-1");
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/permalink lookup failed for post-1, .*: ETIMEDOUT$/));
    warn.mockRestore();
  });

  it("says so when a Story was requested and the vendor returned no cross-share status", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    createContainerMock.mockResolvedValueOnce({ id: "container-1" });
    publishContainerMock.mockResolvedValueOnce({ id: "post-4" });

    await threadsTransport.publishNow(input({ render: { ...render(), threadsCrossShareToIgStory: true } }));

    expect(warn).toHaveBeenCalledWith("[threads] post post-4 cross-share to Instagram Story: no status returned");
    warn.mockRestore();
  });

  it("postFacts logs a non-Threads lookup failure and reports QUEUE", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    getPermalinkMock.mockRejectedValue("ECONNRESET");
    const facts = await threadsTransport.postFacts(["post-1"]);
    expect(facts.get("post-1")).toEqual({ state: "QUEUE", released: false, platform: "threads" });
    expect(warn).toHaveBeenCalledWith("[threads] postFacts lookup failed for post-1: ECONNRESET");
    warn.mockRestore();
  });
});
