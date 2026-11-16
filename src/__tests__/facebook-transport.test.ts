import { describe, it, expect, vi, beforeEach } from "vitest";

// The transport is a business-logic layer on top of the shared Meta Graph
// client, so it is tested against a mocked client — bluesky-transport.test.ts's
// own pattern for bluesky.ts, applied here to meta-graph.ts since there is no
// separate low-level facebook.ts (see facebook-transport.ts's module header).
// MetaGraphError stays real: isMetaNotFound's `instanceof` + code + message
// check is exactly the thing under test in the delete/postFacts not-found cases.
vi.mock("../meta-graph.js", async (importActual) => {
  const actual = await importActual<typeof import("../meta-graph.js")>();
  return {
    ...actual,
    graphRequest: vi.fn(),
    metaCredentials: vi.fn(),
    ruploadHostedVideo: vi.fn(),
  };
});

import { MetaGraphError, graphRequest, metaCredentials, ruploadHostedVideo } from "../meta-graph.js";
import { REEL_POLL, facebookTransport } from "../facebook-transport.js";
import { PublishPreflightError } from "../publish.js";
import type { DirectPublishInput } from "../transport.js";
import type { MediaAsset, PlatformRender } from "../types.js";

const graphRequestMock = graphRequest as unknown as ReturnType<typeof vi.fn>;
const metaCredentialsMock = metaCredentials as unknown as ReturnType<typeof vi.fn>;
const ruploadMock = ruploadHostedVideo as unknown as ReturnType<typeof vi.fn>;

const CREDS = { appSecret: "app-secret-xyz", pageToken: "page-token-abc", pageId: "page-1" };

function notFound(): MetaGraphError {
  return new MetaGraphError(
    "Unsupported request. Object with ID 'x' does not exist, cannot be loaded due to missing permissions, or does not support this operation.",
    400,
    100,
    null,
    "GraphMethodException",
    "trace-1",
  );
}

function render(overrides: Partial<PlatformRender> = {}): PlatformRender {
  return { platform: "facebook", content: "hello from Acme", mediaIndices: [], ...overrides };
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

function input(overrides: Partial<DirectPublishInput> = {}): DirectPublishInput {
  return { render: render(), media: [], draftId: "draft-1", destination: {}, ...overrides };
}

beforeEach(() => {
  graphRequestMock.mockReset();
  metaCredentialsMock.mockReset();
  metaCredentialsMock.mockResolvedValue(CREDS);
  ruploadMock.mockReset().mockResolvedValue(undefined);
});

describe("facebook transport", () => {
  it("declares the real 63,206-char limit with an explicit countMode", () => {
    expect(facebookTransport.channelRules()).toMatchObject({
      maxLength: 63206,
      countMode: "utf16",
      maxImages: 1,
    });
  });

  describe("connectStatus", () => {
    it("reports connected with the page's id/name", async () => {
      graphRequestMock.mockResolvedValue({ id: "page-1", name: "Acme" });
      const status = await facebookTransport.connectStatus();
      expect(status).toEqual({ connected: true, accountId: "page-1", displayName: "Acme" });
      expect(graphRequestMock).toHaveBeenCalledWith(
        "page-1",
        expect.objectContaining({ params: { fields: "id,name" }, accessToken: "page-token-abc", appSecret: "app-secret-xyz" }),
      );
    });

    it("resolves with connected:false and a reason instead of rejecting on a bad credential", async () => {
      graphRequestMock.mockRejectedValue(
        new MetaGraphError("Invalid OAuth access token", 401, 190, 460, "OAuthException", "t"),
      );
      const status = await facebookTransport.connectStatus();
      expect(status.connected).toBe(false);
      expect(status.accountId).toBe("");
      expect(status.reason).toMatch(/Invalid OAuth access token/);
    });

    it("never throws even when metaCredentials itself rejects (no resolver registered)", async () => {
      metaCredentialsMock.mockRejectedValue(new Error("no Meta credentials resolver registered"));
      const status = await facebookTransport.connectStatus();
      expect(status.connected).toBe(false);
      expect(status.reason).toMatch(/no Meta credentials resolver registered/);
    });
  });

  describe("postUrl", () => {
    it("builds the permalink.php redirect from a page-id_post-id ref", () => {
      expect(facebookTransport.postUrl("111111111_222222222")).toBe(
        "https://www.facebook.com/permalink.php?story_fbid=222222222&id=111111111",
      );
    });

    it("falls back to a bare-id redirect for a ref with no underscore", () => {
      expect(facebookTransport.postUrl("333333333")).toBe("https://www.facebook.com/333333333");
    });

    it("ignores the photo half of a composite ref", () => {
      // The permalink is a property of the STORY. Leaving the photo id in
      // would produce a link that 404s for every image post.
      expect(facebookTransport.postUrl("111111111_222222222:photo:999")).toBe(
        "https://www.facebook.com/permalink.php?story_fbid=222222222&id=111111111",
      );
    });
  });

  describe("publishNow: text-only", () => {
    it("posts to /{page-id}/feed with the render's content and returns the ref/url", async () => {
      graphRequestMock.mockResolvedValue({ id: "page-1_555" });

      const result = await facebookTransport.publishNow(input());

      expect(graphRequestMock).toHaveBeenCalledWith(
        "page-1/feed",
        expect.objectContaining({
          method: "POST",
          params: { message: "hello from Acme" },
          accessToken: "page-token-abc",
          appSecret: "app-secret-xyz",
        }),
      );
      expect(result).toEqual({
        ref: "page-1_555",
        url: "https://www.facebook.com/permalink.php?story_fbid=555&id=page-1",
      });
    });

    it("skips a library asset with no public url and still posts text-only", async () => {
      graphRequestMock.mockResolvedValue({ id: "page-1_556" });
      await facebookTransport.publishNow(input({ media: [image({ url: undefined })] }));
      expect(graphRequestMock).toHaveBeenCalledWith("page-1/feed", expect.any(Object));
    });
  });

  describe("publishNow: photo", () => {
    it("posts to /{page-id}/photos with the image url and caption, and returns BOTH ids as ref", async () => {
      graphRequestMock.mockResolvedValue({ id: "photo-1", post_id: "page-1_777" });

      const result = await facebookTransport.publishNow(input({ media: [image()] }));

      expect(graphRequestMock).toHaveBeenCalledWith(
        "page-1/photos",
        expect.objectContaining({
          method: "POST",
          // alt_text_custom is asserted exactly, not with objectContaining,
          // so a future change that drops it fails here: Graph ignores unknown
          // params, so a broken alt field is otherwise
          // silent.
          params: {
            url: "https://cdn.example.com/card.png",
            caption: "hello from Acme",
            alt_text_custom: "a screenshot of the Acme dashboard",
          },
        }),
      );
      // ⛔ The photo id is CARRIED, not discarded. It is the only handle that
      // can delete the photo node, Graph returns it exactly once, and dropping
      // it leaves an orphaned photo on the Page for every image post. The url
      // still resolves from the story half alone.
      expect(result).toEqual({
        ref: "page-1_777:photo:photo-1",
        url: "https://www.facebook.com/permalink.php?story_fbid=777&id=page-1",
      });
    });

    it("throws loudly when the photo response carries no post_id", async () => {
      graphRequestMock.mockResolvedValue({ id: "photo-1" });
      await expect(facebookTransport.publishNow(input({ media: [image()] }))).rejects.toThrow(/no post_id/);
    });

    it("degrades to the bare post ref, without throwing, when no photo id comes back", async () => {
      // ⚠️ Deliberately NOT symmetrical with the post_id case above. The photo
      // is already live by then, so throwing would discard the one id we do
      // have and leave an unreferenceable live post — worse than the orphan.
      graphRequestMock.mockResolvedValue({ post_id: "page-1_777" });

      const result = await facebookTransport.publishNow(input({ media: [image()] }));

      expect(result.ref).toBe("page-1_777");
    });

    it("throws a clear, named error rather than posting one of multiple attached images", async () => {
      const images = [image({ url: "https://cdn/1.png" }), image({ url: "https://cdn/2.png" })];
      await expect(facebookTransport.publishNow(input({ media: images }))).rejects.toThrow(
        PublishPreflightError,
      );
      await expect(facebookTransport.publishNow(input({ media: images }))).rejects.toThrow(
        /only publishes a single photo per post/,
      );
      expect(graphRequestMock).not.toHaveBeenCalled();
      expect(metaCredentialsMock).not.toHaveBeenCalled();
    });
  });

  describe("publishNow: Reels", () => {
    const CLIP_URL = "https://media.example.com/social-hq/assets/v1/clip.mp4";

    function clip(overrides: Partial<MediaAsset> = {}): MediaAsset {
      return {
        path: "veo-clip.mp4",
        type: "video",
        mimeType: "video/mp4",
        size: 4_000_000,
        durationSec: 8,
        url: CLIP_URL,
        ...overrides,
      };
    }

    const UPLOADED = { status: { video_status: "processing", uploading_phase: { status: "complete" } } };
    const PUBLISHED = {
      status: {
        video_status: "ready",
        uploading_phase: { status: "complete" },
        processing_phase: { status: "complete" },
        publishing_phase: { status: "complete" },
      },
    };

    /** start -> (rupload) -> uploaded -> finish -> published. */
    function happyReel(): void {
      graphRequestMock
        .mockResolvedValueOnce({ video_id: "v1", upload_url: "https://rupload.facebook.com/video-upload/v1" })
        .mockResolvedValueOnce(UPLOADED)
        .mockResolvedValueOnce({ success: true })
        .mockResolvedValueOnce(PUBLISHED);
    }

    it("starts a session, uploads by file_url, finishes PUBLISHED, and returns a reel: ref", async () => {
      happyReel();
      const result = await facebookTransport.publishNow(input({ media: [clip()] }));

      expect(result).toEqual({ ref: "reel:v1", url: "https://www.facebook.com/reel/v1" });
      const auth = { accessToken: "page-token-abc", appSecret: "app-secret-xyz" };
      expect(graphRequestMock).toHaveBeenNthCalledWith(1, "page-1/video_reels", {
        method: "POST",
        params: { upload_phase: "start" },
        ...auth,
      });
      expect(ruploadMock).toHaveBeenCalledWith("v1", CLIP_URL, auth);
      expect(graphRequestMock).toHaveBeenNthCalledWith(2, "v1", { params: { fields: "status" }, ...auth });
      expect(graphRequestMock).toHaveBeenNthCalledWith(3, "page-1/video_reels", {
        method: "POST",
        params: { upload_phase: "finish", video_id: "v1", video_state: "PUBLISHED", description: "hello from Acme" },
        ...auth,
      });
      expect(graphRequestMock).toHaveBeenCalledTimes(4);
    });

    it("polls the upload and the publish on REEL_POLL, accepting publish_status as published", async () => {
      vi.useFakeTimers();
      graphRequestMock
        .mockResolvedValueOnce({ video_id: "v1" })
        .mockResolvedValueOnce({}) // no status object yet
        .mockResolvedValueOnce({ status: { uploading_phase: { status: "in_progress" } } })
        .mockResolvedValueOnce(UPLOADED)
        .mockResolvedValueOnce({ success: true })
        .mockResolvedValueOnce(UPLOADED)
        .mockResolvedValueOnce({ status: { publishing_phase: { status: "in_progress", publish_status: "published" } } });

      const promise = facebookTransport.publishNow(input({ media: [clip({ mimeType: "video/quicktime", durationSec: undefined })] }));
      await vi.runAllTimersAsync();
      await expect(promise).resolves.toEqual({ ref: "reel:v1", url: "https://www.facebook.com/reel/v1" });
      expect(REEL_POLL).toEqual({ intervalMs: 5_000, maxAttempts: 24 });
      vi.useRealTimers();
    });

    it("throws with nothing published when the upload never completes, and never calls finish", async () => {
      vi.useFakeTimers();
      graphRequestMock.mockResolvedValueOnce({ video_id: "v1" });
      graphRequestMock.mockResolvedValue({ status: { uploading_phase: { status: "in_progress" } } });

      const promise = facebookTransport.publishNow(input({ media: [clip()] }));
      const assertion = expect(promise).rejects.toThrow(/still uploading after 24 status checks/);
      await vi.runAllTimersAsync();
      await assertion;
      expect(graphRequestMock).toHaveBeenCalledTimes(25); // start + 24 reads
      expect(graphRequestMock.mock.calls.some(([, opts]) => opts?.params?.upload_phase === "finish")).toBe(false);
      vi.useRealTimers();
    });

    it("refuses to go on when the start phase returns no video_id", async () => {
      graphRequestMock.mockResolvedValueOnce({});
      await expect(facebookTransport.publishNow(input({ media: [clip()] }))).rejects.toThrow(/returned no video_id/);
      expect(ruploadMock).not.toHaveBeenCalled();
    });

    it("propagates a failed rupload before any finish", async () => {
      graphRequestMock.mockResolvedValueOnce({ video_id: "v1" });
      ruploadMock.mockRejectedValueOnce(new MetaGraphError("unauthorized user request", 400, null, null, null, null));
      await expect(facebookTransport.publishNow(input({ media: [clip()] }))).rejects.toThrow(/unauthorized user request/);
      expect(graphRequestMock).toHaveBeenCalledTimes(1);
    });

    it.each([
      [
        "a phase error under a not_started status",
        { processing_phase: { status: "not_started", error: { message: "Resolution too low." } } },
        /failed uploading \(processing: Resolution too low\.\)/,
      ],
      ["a phase status of error", { uploading_phase: { status: "error", error: {} } }, /uploading phase reported an error/],
      ["video_status error", { video_status: "error" }, /video_status "error"/],
      ["video_status expired", { video_status: "expired" }, /video_status "expired"/],
    ])("fails before finish on %s", async (_label, status, message) => {
      graphRequestMock.mockResolvedValueOnce({ video_id: "v1" }).mockResolvedValueOnce({ status });
      await expect(facebookTransport.publishNow(input({ media: [clip()] }))).rejects.toThrow(message);
      expect(graphRequestMock).toHaveBeenCalledTimes(2);
    });

    it("fails the leg when Meta reports the Reel failed AFTER finish, since a failed Reel is not live", async () => {
      graphRequestMock
        .mockResolvedValueOnce({ video_id: "v1" })
        .mockResolvedValueOnce(UPLOADED)
        .mockResolvedValueOnce({ success: true })
        .mockResolvedValueOnce({ status: { publishing_phase: { status: "error", error: { message: "copyright" } } } });
      await expect(facebookTransport.publishNow(input({ media: [clip()] }))).rejects.toThrow(
        /Reel v1 failed publishing \(publishing: copyright\)/,
      );
    });

    it("returns the ref with a warning, never a throw, when the post-finish poll runs out", async () => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      graphRequestMock
        .mockResolvedValueOnce({ video_id: "v1" })
        .mockResolvedValueOnce(UPLOADED)
        .mockResolvedValueOnce({ success: true });
      graphRequestMock.mockResolvedValue(UPLOADED);

      const promise = facebookTransport.publishNow(input({ media: [clip()] }));
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.ref).toBe("reel:v1");
      expect(result.warnings).toEqual([expect.stringMatching(/had not finished publishing after 24 status checks/)]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("[facebook] Reel v1 was accepted"));
      warn.mockRestore();
      vi.useRealTimers();
    });

    it.each([
      ["a rate-limited status read", new MetaGraphError("(#4) Application request limit reached", 400, 4, null, "OAuthException", null), /request limit reached/],
      ["a non-Error rejection", "socket hang up", /socket hang up/],
    ])("returns the ref with a warning when %s follows finish (the Reel may be live)", async (_label, failure, reason) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      graphRequestMock
        .mockResolvedValueOnce({ video_id: "v1" })
        .mockResolvedValueOnce(UPLOADED)
        .mockResolvedValueOnce({ success: true })
        .mockRejectedValueOnce(failure);

      const result = await facebookTransport.publishNow(input({ media: [clip()] }));

      expect(result.ref).toBe("reel:v1");
      expect(result.warnings).toEqual([expect.stringMatching(reason)]);
      warn.mockRestore();
    });

    it("comments on the Reel's video id and keeps both warnings when the comment also fails", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      graphRequestMock
        .mockResolvedValueOnce({ video_id: "v1" })
        .mockResolvedValueOnce(UPLOADED)
        .mockResolvedValueOnce({ success: true })
        .mockRejectedValueOnce("status read dropped")
        .mockRejectedValueOnce(new Error("(#200) permissions"));

      const result = await facebookTransport.publishNow(
        input({ render: render({ firstComment: "https://example.com" }), media: [clip()] }),
      );

      expect(graphRequestMock).toHaveBeenNthCalledWith(5, "v1/comments", expect.objectContaining({ method: "POST" }));
      expect(result.warnings).toHaveLength(2);
      expect(result.warnings?.[1]).toBe("first comment failed: (#200) permissions");
      warn.mockRestore();
    });

    it.each([
      ["a video mixed with an image", () => [image(), clip()], /exactly one video and nothing else/],
      ["two videos", () => [clip(), clip({ path: "b.mp4" })], /2 video\(s\)/],
      ["a webm", () => [clip({ mimeType: "video/webm" })], /MP4 or MOV/],
      ["a video with no public url", () => [clip({ url: undefined })], /has no public url/],
      ["a clip under 3 s", () => [clip({ durationSec: 2 })], /3 to 90 seconds/],
      ["a clip over 90 s", () => [clip({ durationSec: 91 })], /3 to 90 seconds/],
    ])("refuses %s with a PublishPreflightError before any network call", async (_label, list, message) => {
      await expect(facebookTransport.publishNow(input({ media: list() }))).rejects.toThrow(PublishPreflightError);
      await expect(facebookTransport.publishNow(input({ media: list() }))).rejects.toThrow(message);
      expect(graphRequestMock).not.toHaveBeenCalled();
      expect(metaCredentialsMock).not.toHaveBeenCalled();
    });

    it("declares the Reels 90-second ceiling", () => {
      expect(facebookTransport.channelRules().maxVideoSec).toBe(90);
    });
  });

  describe("Reel refs", () => {
    it("builds the /reel/ permalink, and treats an empty reel: ref as a bare id", () => {
      expect(facebookTransport.postUrl("reel:v1")).toBe("https://www.facebook.com/reel/v1");
      expect(facebookTransport.postUrl("reel:")).toBe("https://www.facebook.com/reel:");
    });

    it("deletes a Reel with one DELETE on its video id", async () => {
      graphRequestMock.mockResolvedValueOnce({ success: true });
      await facebookTransport.deletePost("reel:v1");
      expect(graphRequestMock).toHaveBeenCalledTimes(1);
      expect(graphRequestMock).toHaveBeenCalledWith("v1", expect.objectContaining({ method: "DELETE" }));
    });

    it("reconciles a Reel by its publishing phase, not by the node existing", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      graphRequestMock.mockImplementation(async (id: string) =>
        id === "v-live"
          ? { status: { publishing_phase: { status: "complete" } } }
          : { status: { publishing_phase: { status: "not_started" } } },
      );

      const facts = await facebookTransport.postFacts(["reel:v-live", "reel:v-draft"]);

      expect(facts.get("reel:v-live")).toEqual({ state: "PUBLISHED", released: true, platform: "facebook" });
      expect(facts.get("reel:v-draft")).toEqual({ state: "QUEUE", released: false, platform: "facebook" });
      expect(graphRequestMock).toHaveBeenCalledWith("v-live", expect.objectContaining({ params: { fields: "status" } }));
      expect(warn).toHaveBeenCalledWith("[facebook] Reel reel:v-draft is not published yet; reporting QUEUE");
      warn.mockRestore();
    });
  });

  describe("publishNow: firstComment", () => {
    it("posts firstComment as a separate real comment call after the post succeeds", async () => {
      graphRequestMock.mockResolvedValueOnce({ id: "page-1_888" }); // the feed post
      graphRequestMock.mockResolvedValueOnce({ id: "comment-1" }); // the comment

      const result = await facebookTransport.publishNow(
        input({ render: render({ firstComment: "https://example.com/blog/post" }) }),
      );

      expect(graphRequestMock).toHaveBeenCalledTimes(2);
      expect(graphRequestMock).toHaveBeenNthCalledWith(
        2,
        "page-1_888/comments",
        expect.objectContaining({
          method: "POST",
          params: { message: "https://example.com/blog/post" },
        }),
      );
      expect(result.ref).toBe("page-1_888");
    });

    it("does not fail the whole publish when the first comment call fails — the post is already live", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      graphRequestMock.mockResolvedValueOnce({ id: "page-1_999" }); // the feed post succeeds
      graphRequestMock.mockRejectedValueOnce(new MetaGraphError("upstream unavailable", 503, 2, null, null, null)); // the comment fails

      const result = await facebookTransport.publishNow(
        input({ render: render({ firstComment: "link in comment" }) }),
      );

      expect(result.ref).toBe("page-1_999"); // publish still reports success
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("first comment failed"));
      // ...and says so on the result, which is what reaches lastError.
      expect(result.warnings).toEqual(["first comment failed: upstream unavailable"]);
      warn.mockRestore();
    });

    it("does not post a comment when the render carries no firstComment", async () => {
      graphRequestMock.mockResolvedValue({ id: "page-1_1000" });
      await facebookTransport.publishNow(input());
      expect(graphRequestMock).toHaveBeenCalledTimes(1);
    });

    it("comments on the STORY, not the composite ref, for a photo post", async () => {
      // ⛔ The regression this pins: publishNow hands its own freshly-built ref
      // to postComment, so an unparsed composite would POST to
      // `page-1_888:photo:photo-1/comments` and the link-in-comment strategy
      // would fail on every image post — warned about, never raised.
      graphRequestMock
        .mockResolvedValueOnce({ id: "photo-1", post_id: "page-1_888" })
        .mockResolvedValueOnce({ id: "comment-1" });

      const result = await facebookTransport.publishNow(
        input({
          media: [image()],
          render: render({ firstComment: "https://example.com/blog/post" }),
        }),
      );

      expect(graphRequestMock).toHaveBeenNthCalledWith(
        2,
        "page-1_888/comments",
        expect.objectContaining({ method: "POST" }),
      );
      expect(result.ref).toBe("page-1_888:photo:photo-1");
    });
  });

  describe("deletePost", () => {
    it("deletes normally when the post still exists", async () => {
      graphRequestMock.mockResolvedValue({ success: true });
      await expect(facebookTransport.deletePost("page-1_1")).resolves.toBeUndefined();
      expect(graphRequestMock).toHaveBeenCalledWith(
        "page-1_1",
        expect.objectContaining({ method: "DELETE", accessToken: "page-token-abc", appSecret: "app-secret-xyz" }),
      );
    });

    it("treats an already-gone post (confirmed \"does not exist\") as SUCCESS, not a failure", async () => {
      graphRequestMock.mockRejectedValue(notFound());
      await expect(facebookTransport.deletePost("page-1_gone")).resolves.toBeUndefined();
    });

    it("still throws for a real failure (e.g. auth), not just swallowing everything", async () => {
      graphRequestMock.mockRejectedValue(
        new MetaGraphError("Invalid OAuth access token", 401, 190, 460, "OAuthException", "t"),
      );
      await expect(facebookTransport.deletePost("page-1_1")).rejects.toThrow(/Invalid OAuth access token/);
    });

    /* ------------------------------------------------------------------ *
     *  The photo half. Facebook splits an image post into a feed story and
     *  a photo node; deleting the story alone leaves the photo live in the
     *  Page's Photos tab. See PHOTO_MARKER in facebook-transport.ts.
     * ------------------------------------------------------------------ */

    it("deletes BOTH the story and the photo node, story first", async () => {
      graphRequestMock.mockResolvedValue({ success: true });

      await facebookTransport.deletePost("page-1_777:photo:photo-1");

      expect(graphRequestMock).toHaveBeenCalledTimes(2);
      // Order is load-bearing: the story is what a visitor sees, so it is the
      // obligation that must land first.
      expect(graphRequestMock.mock.calls[0][0]).toBe("page-1_777");
      expect(graphRequestMock.mock.calls[1][0]).toBe("photo-1");
      for (const call of graphRequestMock.mock.calls) {
        expect(call[1]).toMatchObject({ method: "DELETE", accessToken: "page-token-abc" });
      }
    });

    it("makes exactly ONE call for a legacy ref that predates the photo id", async () => {
      // ⛔ Backward compatibility. A leg published before the photo id was
      // carried is a bare `{page-id}_{post-id}`; its photo id was never recorded, so there
      // is nothing to guess at and a second call would target the wrong object.
      graphRequestMock.mockResolvedValue({ success: true });

      await facebookTransport.deletePost("page-1_777");

      expect(graphRequestMock).toHaveBeenCalledTimes(1);
      expect(graphRequestMock.mock.calls[0][0]).toBe("page-1_777");
    });

    it("still deletes the photo when the story is already gone", async () => {
      // The retry path after a partial failure, and the case where Meta DOES
      // cascade: "already gone" on the story must not abort the photo cleanup.
      graphRequestMock.mockRejectedValueOnce(notFound()).mockResolvedValue({ success: true });

      await facebookTransport.deletePost("page-1_777:photo:photo-1");

      expect(graphRequestMock).toHaveBeenCalledTimes(2);
      expect(graphRequestMock.mock.calls[1][0]).toBe("photo-1");
    });

    it("is idempotent when BOTH objects are already gone", async () => {
      graphRequestMock.mockRejectedValue(notFound());
      await expect(
        facebookTransport.deletePost("page-1_777:photo:photo-1"),
      ).resolves.toBeUndefined();
    });

    it("propagates a failed photo delete rather than reporting a clean delete", async () => {
      // ⛔ A silent success here is exactly the orphan this change removes: the
      // story would be gone, the photo still live, and the leg recorded as
      // fully deleted with nothing anywhere to find it by.
      graphRequestMock.mockResolvedValueOnce({ success: true }).mockRejectedValue(
        new MetaGraphError("Invalid OAuth access token", 401, 190, 460, "OAuthException", "t"),
      );

      await expect(facebookTransport.deletePost("page-1_777:photo:photo-1")).rejects.toThrow(
        /Invalid OAuth access token/,
      );
    });

    it("treats a half-formed marker as a plain post id rather than deleting the Page", async () => {
      // `DELETE /` with an empty id resolves to the Page itself on Graph.
      graphRequestMock.mockResolvedValue({ success: true });

      await facebookTransport.deletePost("page-1_777:photo:");

      expect(graphRequestMock).toHaveBeenCalledTimes(1);
      expect(graphRequestMock.mock.calls[0][0]).toBe("page-1_777:photo:");
    });
  });

  describe("postFacts", () => {
    it("maps a found post to PUBLISHED/released", async () => {
      graphRequestMock.mockResolvedValue({ id: "page-1_1" });
      const facts = await facebookTransport.postFacts(["page-1_1"]);
      expect(facts.get("page-1_1")).toEqual({ state: "PUBLISHED", released: true, platform: "facebook" });
    });

    it("looks up the story but keys the result by the ORIGINAL composite ref", async () => {
      // ⛔ The caller matches this map against the `providerPostId` entry it
      // passed in. Re-keying on the parsed id would drop every photo leg out
      // of the reconcile, and they would read as never answered rather than
      // as missing.
      graphRequestMock.mockResolvedValue({ id: "page-1_777" });

      const facts = await facebookTransport.postFacts(["page-1_777:photo:photo-1"]);

      expect(graphRequestMock).toHaveBeenCalledWith("page-1_777", expect.any(Object));
      expect(facts.get("page-1_777:photo:photo-1")).toMatchObject({
        state: "PUBLISHED",
        released: true,
      });
    });

    /**
     * A confirmed "does not exist" tells us more than a generic failure, and
     * it STILL must not become ERROR. ERROR is a permanent verdict
     * (reconcile-verdict.ts turns it into a failed leg and never revisits
     * it), while the caller's grace window cannot be applied here because
     * postFacts receives no timestamps.
     */
    it("maps a confirmed-missing post to QUEUE, because ERROR is the caller's verdict to make", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      graphRequestMock.mockRejectedValue(notFound());
      const facts = await facebookTransport.postFacts(["page-1_gone"]);
      expect(facts.get("page-1_gone")).toEqual({ state: "QUEUE", released: false, platform: "facebook" });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("confirmed absent"));
      warn.mockRestore();
    });

    it("maps an unreachable vendor (non-not-found failure) to QUEUE, never ERROR", async () => {
      graphRequestMock.mockRejectedValue(new MetaGraphError("upstream unavailable", 503, 2, null, null, null));
      const facts = await facebookTransport.postFacts(["page-1_a", "page-1_b"]);
      expect(facts.get("page-1_a")).toEqual({ state: "QUEUE", released: false, platform: "facebook" });
      expect(facts.get("page-1_b")).toEqual({ state: "QUEUE", released: false, platform: "facebook" });
    });

    it("maps every ref to QUEUE when credentials cannot be resolved at all", async () => {
      metaCredentialsMock.mockRejectedValue(new Error("no Meta credentials resolver registered"));
      const facts = await facebookTransport.postFacts(["page-1_a", "page-1_b"]);
      expect(facts.get("page-1_a")).toEqual({ state: "QUEUE", released: false, platform: "facebook" });
      expect(facts.get("page-1_b")).toEqual({ state: "QUEUE", released: false, platform: "facebook" });
      expect(graphRequestMock).not.toHaveBeenCalled();
    });

    it("returns an empty map for an empty ref list without calling the vendor", async () => {
      const facts = await facebookTransport.postFacts([]);
      expect(facts.size).toBe(0);
      expect(graphRequestMock).not.toHaveBeenCalled();
      expect(metaCredentialsMock).not.toHaveBeenCalled();
    });

    it("handles a large batch by chunking concurrency rather than firing every request at once", async () => {
      let inFlight = 0;
      let maxInFlight = 0;
      graphRequestMock.mockImplementation(async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight -= 1;
        return { id: "x" };
      });
      const refs = Array.from({ length: 25 }, (_, i) => `page-1_${i}`);
      const facts = await facebookTransport.postFacts(refs);
      expect(facts.size).toBe(25);
      expect(graphRequestMock).toHaveBeenCalledTimes(25);
      expect(maxInFlight).toBeLessThanOrEqual(10);
    });
  });
});

/**
 * Vendor and runtime failures that do not arrive as an `Error`. Undici, worker
 * threads and some SDK paths reject with bare strings; each of these paths must
 * still carry the reason into the status/log line rather than losing it.
 */
describe("facebook transport: non-Error failures and plain errors", () => {
  it("connectStatus stringifies a thrown non-Error into the reason", async () => {
    metaCredentialsMock.mockRejectedValue("socket hang up");
    const status = await facebookTransport.connectStatus();
    expect(status).toEqual({ connected: false, accountId: "", displayName: "", reason: "socket hang up" });
  });

  it("drops an image with no public url from the photo count, so it does not trip the one-image cap", async () => {
    graphRequestMock.mockResolvedValue({ id: "photo-1", post_id: "page-1_42" });
    const result = await facebookTransport.publishNow(
      input({ media: [image(), image({ path: "/tmp/b.png", url: undefined })] }),
    );
    expect(graphRequestMock).toHaveBeenCalledWith(
      "page-1/photos",
      expect.objectContaining({ method: "POST" }),
    );
    expect(result.ref).toBe("page-1_42:photo:photo-1");
  });

  it("warns with the stringified reason when the first comment rejects with a non-Error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    graphRequestMock.mockResolvedValueOnce({ id: "page-1_5" }).mockRejectedValueOnce("comment refused");
    const result = await facebookTransport.publishNow(input({ render: render({ firstComment: "link" }) }));
    expect(result.ref).toBe("page-1_5");
    expect(warn).toHaveBeenCalledWith(
      "[facebook] first comment failed for post page-1_5, post itself is live: comment refused",
    );
    expect(result.warnings).toEqual(["first comment failed: comment refused"]);
    warn.mockRestore();
  });

  it("does not treat a plain Error with not-found wording as an idempotent delete", async () => {
    // Only a MetaGraphError is Meta's answer; a local Error that happens to say
    // "does not exist" must not be swallowed as an already-gone post.
    graphRequestMock.mockRejectedValue(new Error("Object does not exist"));
    await expect(facebookTransport.deletePost("page-1_1")).rejects.toThrow("Object does not exist");
  });

  it("postFacts defers the whole batch with the stringified reason when credentials reject with a non-Error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    metaCredentialsMock.mockRejectedValue("vault sealed");
    const facts = await facebookTransport.postFacts(["page-1_a"]);
    expect(facts.get("page-1_a")).toEqual({ state: "QUEUE", released: false, platform: "facebook" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("deferring the whole batch: vault sealed"));
    warn.mockRestore();
  });

  it("postFacts logs a non-Error lookup failure and reports QUEUE", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    graphRequestMock.mockRejectedValue("ECONNRESET");
    const facts = await facebookTransport.postFacts(["page-1_a"]);
    expect(facts.get("page-1_a")).toEqual({ state: "QUEUE", released: false, platform: "facebook" });
    expect(warn).toHaveBeenCalledWith("[facebook] postFacts lookup failed for page-1_a: ECONNRESET");
    warn.mockRestore();
  });
});

describe("facebook transport: GIF", () => {
  it("counts a GIF as the single photo and posts it through /photos", async () => {
    graphRequestMock.mockResolvedValue({ id: "photo-9", post_id: "page-1_9" });
    const result = await facebookTransport.publishNow(
      input({ media: [image({ type: "gif", mimeType: "image/gif", url: "https://cdn.example.com/a.gif" })] }),
    );
    expect(graphRequestMock).toHaveBeenCalledWith(
      "page-1/photos",
      expect.objectContaining({ params: expect.objectContaining({ url: "https://cdn.example.com/a.gif" }) }),
    );
    expect(result.ref).toBe("page-1_9:photo:photo-9");
  });
});
