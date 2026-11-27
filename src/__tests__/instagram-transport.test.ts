// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from "vitest";

// The transport is a business-logic layer on top of the shared Meta client,
// so it is tested against a mocked `graphRequest`/`metaCredentials` —
// pinterest-transport.test.ts's own pattern for its vendor client.
// MetaGraphError stays real: isNotFoundError's `instanceof` + code check is
// exactly the thing under test in the delete/postFacts not-found cases.
vi.mock("../meta-graph.js", async (importActual) => {
  const actual = await importActual<typeof import("../meta-graph.js")>();
  return {
    ...actual,
    graphRequest: vi.fn(),
    metaCredentials: vi.fn(),
  };
});

import { graphRequest, metaCredentials, MetaGraphError } from "../meta-graph.js";
import { REELS_POLL, instagramTransport, isAiGeneratedAsset } from "../instagram-transport.js";
import { PublishPreflightError } from "../publish.js";
import type { DirectPublishInput } from "../transport.js";
import type { MediaAsset, PlatformRender } from "../types.js";

const graphRequestMock = graphRequest as unknown as ReturnType<typeof vi.fn>;
const metaCredentialsMock = metaCredentials as unknown as ReturnType<typeof vi.fn>;

const CREDS = { appSecret: "app-secret-xyz", pageToken: "page-token-abc", pageId: "page-1", igUserId: "ig-user-1" };

function notFound(): MetaGraphError {
  return new MetaGraphError(
    "Unsupported get request. Object with ID '123' does not exist, cannot be loaded due to missing permissions, " +
      "or does not support this operation.",
    400,
    100,
    33,
    "GraphMethodException",
    "trace-1",
  );
}

function render(overrides: Partial<PlatformRender> = {}): PlatformRender {
  return { platform: "instagram", content: "caption copy", mediaIndices: [], ...overrides };
}

function image(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    path: "/tmp/photo.jpg",
    type: "image",
    mimeType: "image/jpeg",
    size: 900_000,
    url: "https://cdn.example.com/photo.jpg",
    altText: "a photo of the Acme dashboard",
    ...overrides,
  };
}

function input(overrides: Partial<DirectPublishInput> = {}): DirectPublishInput {
  return {
    render: render(),
    media: [image()],
    draftId: "draft-1",
    destination: {},
    ...overrides,
  };
}

beforeEach(() => {
  graphRequestMock.mockReset();
  metaCredentialsMock.mockReset();
  metaCredentialsMock.mockResolvedValue(CREDS);
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("no real network calls allowed in this suite"))));
});

describe("instagram transport", () => {
  it("declares the real 2200-char caption limit and 10-item carousel cap", () => {
    expect(instagramTransport.channelRules()).toMatchObject({
      maxLength: 2200,
      countMode: "utf16",
      maxImages: 10,
    });
  });

  describe("connectStatus", () => {
    it("reports connected with the ig user's id/username", async () => {
      graphRequestMock.mockResolvedValue({ id: "ig-user-1", username: "examplebrand" });
      const status = await instagramTransport.connectStatus();
      expect(status).toEqual({ connected: true, accountId: "ig-user-1", displayName: "examplebrand" });
      expect(graphRequestMock).toHaveBeenCalledWith(
        "ig-user-1",
        expect.objectContaining({ params: { fields: "id,username" } }),
      );
    });

    it("resolves connected:false (never rejects) when no Instagram account is linked", async () => {
      metaCredentialsMock.mockResolvedValue({ ...CREDS, igUserId: undefined });
      const status = await instagramTransport.connectStatus();
      expect(status.connected).toBe(false);
      expect(status.reason).toMatch(/no Instagram business account is linked/);
      expect(graphRequestMock).not.toHaveBeenCalled();
    });

    it("resolves connected:false with a reason instead of rejecting on a bad credential", async () => {
      graphRequestMock.mockRejectedValue(
        new MetaGraphError("Invalid OAuth access token", 401, 190, 460, "OAuthException", "trace-2"),
      );
      const status = await instagramTransport.connectStatus();
      expect(status.connected).toBe(false);
      expect(status.accountId).toBe("");
      expect(status.reason).toMatch(/Invalid OAuth access token/);
    });
  });

  describe("postUrl", () => {
    it("returns a string (best-effort; not guaranteed to resolve for a bare numeric ref)", () => {
      expect(instagramTransport.postUrl("17900000000000001")).toBe("https://www.instagram.com/p/17900000000000001/");
    });
  });

  describe("publishNow", () => {
    it("creates a single-image container, publishes it, and fetches the real permalink", async () => {
      graphRequestMock
        .mockResolvedValueOnce({ id: "container-1" }) // POST .../media
        .mockResolvedValueOnce({ status_code: "FINISHED" }) // GET status
        .mockResolvedValueOnce({ id: "media-1" }) // POST .../media_publish
        .mockResolvedValueOnce({ permalink: "https://www.instagram.com/p/Cabc123/" }); // GET permalink

      const result = await instagramTransport.publishNow(input());

      expect(result).toEqual({ ref: "media-1", url: "https://www.instagram.com/p/Cabc123/" });
      expect(graphRequestMock).toHaveBeenNthCalledWith(
        1,
        "ig-user-1/media",
        expect.objectContaining({
          method: "POST",
          params: expect.objectContaining({
            image_url: "https://cdn.example.com/photo.jpg",
            caption: "caption copy",
            alt_text: "a photo of the Acme dashboard",
          }),
        }),
      );
      expect(graphRequestMock).toHaveBeenNthCalledWith(
        3,
        "ig-user-1/media_publish",
        expect.objectContaining({ method: "POST", params: { creation_id: "container-1" } }),
      );
    });

    it("polls a container that starts IN_PROGRESS until it reaches FINISHED, then publishes", async () => {
      vi.useFakeTimers();
      graphRequestMock
        .mockResolvedValueOnce({ id: "container-1" })
        .mockResolvedValueOnce({ status_code: "IN_PROGRESS" })
        .mockResolvedValueOnce({ status_code: "IN_PROGRESS" })
        .mockResolvedValueOnce({ status_code: "FINISHED" })
        .mockResolvedValueOnce({ id: "media-1" })
        .mockResolvedValueOnce({ permalink: "https://www.instagram.com/p/Cxyz/" });

      const promise = instagramTransport.publishNow(input());
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toEqual({ ref: "media-1", url: "https://www.instagram.com/p/Cxyz/" });
      // 1 create + 3 status checks + 1 publish + 1 permalink
      expect(graphRequestMock).toHaveBeenCalledTimes(6);
      vi.useRealTimers();
    });

    it("throws a clear error rather than looping forever when a container never leaves IN_PROGRESS", async () => {
      vi.useFakeTimers();
      graphRequestMock.mockResolvedValueOnce({ id: "container-1" });
      graphRequestMock.mockResolvedValue({ status_code: "IN_PROGRESS" });

      const promise = instagramTransport.publishNow(input());
      const assertion = expect(promise).rejects.toThrow(/did not finish processing/);
      await vi.runAllTimersAsync();
      await assertion;
      vi.useRealTimers();
    });

    it("refuses a status_code outside the documented five rather than polling on it", async () => {
      graphRequestMock.mockResolvedValueOnce({ id: "container-1" }).mockResolvedValueOnce({ status_code: "DONE" });
      await expect(instagramTransport.publishNow(input())).rejects.toThrow(
        /meta GET :container-id\?fields=status_code,status: unexpected response shape at status_code: expected one of EXPIRED, ERROR, FINISHED, IN_PROGRESS, PUBLISHED, got a string/,
      );
    });

    it("throws a clear error when the container reaches ERROR", async () => {
      graphRequestMock
        .mockResolvedValueOnce({ id: "container-1" })
        .mockResolvedValueOnce({ status_code: "ERROR", status: "media processing failed" });

      await expect(instagramTransport.publishNow(input())).rejects.toThrow(/status_code "ERROR"/);
    });

    it("builds a carousel from 2+ images: children get no caption, parent does", async () => {
      graphRequestMock
        .mockResolvedValueOnce({ id: "child-1" })
        .mockResolvedValueOnce({ status_code: "FINISHED" })
        .mockResolvedValueOnce({ id: "child-2" })
        .mockResolvedValueOnce({ status_code: "FINISHED" })
        .mockResolvedValueOnce({ id: "parent-1" })
        .mockResolvedValueOnce({ status_code: "FINISHED" })
        .mockResolvedValueOnce({ id: "media-1" })
        .mockResolvedValueOnce({ permalink: "https://www.instagram.com/p/Ccar/" });

      const images = [image({ url: "https://cdn/1.jpg" }), image({ url: "https://cdn/2.jpg" })];
      const result = await instagramTransport.publishNow(input({ media: images }));

      expect(result.ref).toBe("media-1");
      expect(graphRequestMock).toHaveBeenNthCalledWith(
        1,
        "ig-user-1/media",
        expect.objectContaining({ params: expect.objectContaining({ is_carousel_item: true }) }),
      );
      expect(graphRequestMock.mock.calls[0][1].params).not.toHaveProperty("caption");
      expect(graphRequestMock).toHaveBeenNthCalledWith(
        5,
        "ig-user-1/media",
        expect.objectContaining({
          params: expect.objectContaining({ media_type: "CAROUSEL", caption: "caption copy", children: "child-1,child-2" }),
        }),
      );
    });

    it("caps a carousel at 10 images even if more are attached", async () => {
      graphRequestMock.mockImplementation(async (path: string) => {
        if (typeof path === "string" && path.endsWith("/media_publish")) return { id: "media-1" };
        if (typeof path === "string" && path === "media-1") return { permalink: undefined };
        if (typeof path === "string" && path === "ig-user-1/media") return { id: `container-${Math.random()}` };
        return { status_code: "FINISHED" };
      });
      const twelveImages = Array.from({ length: 12 }, (_, i) => image({ url: `https://cdn/${i}.jpg` }));

      await instagramTransport.publishNow(input({ media: twelveImages }));

      const childCreateCalls = graphRequestMock.mock.calls.filter(
        ([path, opts]) => path === "ig-user-1/media" && (opts as { params?: Record<string, unknown> }).params?.is_carousel_item,
      );
      expect(childCreateCalls).toHaveLength(10);
    });

    describe("Reels", () => {
      function clip(overrides: Partial<MediaAsset> = {}): MediaAsset {
        return {
          path: "veo-clip.mp4",
          type: "video",
          mimeType: "video/mp4",
          size: 4_000_000,
          durationSec: 8,
          url: "https://media.example.com/social-hq/assets/v1/clip.mp4",
          altText: "a phone answering itself",
          ...overrides,
        };
      }

      function happyReel(): void {
        graphRequestMock
          .mockResolvedValueOnce({ id: "reel-container-1" }) // POST .../media (REELS)
          .mockResolvedValueOnce({ status_code: "FINISHED" }) // GET status
          .mockResolvedValueOnce({ id: "reel-media-1" }) // POST .../media_publish
          .mockResolvedValueOnce({ permalink: "https://www.instagram.com/reel/Crl1/" }); // GET permalink
      }

      it("publishes one video as a REELS container, shared to feed, with the same result shape as an image", async () => {
        happyReel();
        const result = await instagramTransport.publishNow(input({ media: [clip()] }));

        expect(result).toEqual({ ref: "reel-media-1", url: "https://www.instagram.com/reel/Crl1/" });
        expect(graphRequestMock).toHaveBeenNthCalledWith(
          1,
          "ig-user-1/media",
          expect.objectContaining({
            method: "POST",
            params: {
              media_type: "REELS",
              video_url: "https://media.example.com/social-hq/assets/v1/clip.mp4",
              caption: "caption copy",
              share_to_feed: true,
              trial_params: undefined,
              is_ai_generated: undefined,
            },
          }),
        );
        expect(graphRequestMock).toHaveBeenNthCalledWith(
          2,
          "reel-container-1",
          expect.objectContaining({ params: { fields: "status_code,status" } }),
        );
        expect(graphRequestMock).toHaveBeenNthCalledWith(
          3,
          "ig-user-1/media_publish",
          expect.objectContaining({ method: "POST", params: { creation_id: "reel-container-1" } }),
        );
      });

      it("accepts a MOV, and a video with no known duration", async () => {
        happyReel();
        const mov = clip({ mimeType: "video/quicktime", durationSec: undefined });
        await expect(instagramTransport.publishNow(input({ media: [mov] }))).resolves.toMatchObject({
          ref: "reel-media-1",
        });
      });

      it("sends a Trial Reel's graduation strategy and keeps it out of the feed", async () => {
        happyReel();
        await instagramTransport.publishNow(
          input({ render: render({ instagramTrialReel: "SS_PERFORMANCE" }), media: [clip()] }),
        );
        const params = graphRequestMock.mock.calls[0][1].params;
        expect(params.trial_params).toBe('{"graduation_strategy":"SS_PERFORMANCE"}');
        expect(params.share_to_feed).toBeUndefined();
      });

      it.each([
        ["flat", { aiGenerated: true }],
        ["nested in genMeta", { genMeta: { aiGenerated: true, model: "veo" } }],
      ])("discloses an AI-generated video (%s) with is_ai_generated", async (_label, extra) => {
        happyReel();
        await instagramTransport.publishNow(input({ media: [{ ...clip(), ...extra } as MediaAsset] }));
        expect(graphRequestMock.mock.calls[0][1].params.is_ai_generated).toBe(true);
      });

      it("polls a Reel container on the video budget, not the 12 s image one", async () => {
        vi.useFakeTimers();
        // 20 IN_PROGRESS reads (~100 s) is far past the image budget of 8 checks
        // and well inside REELS_POLL's 36.
        graphRequestMock.mockResolvedValueOnce({ id: "reel-container-1" });
        for (let i = 0; i < 20; i++) graphRequestMock.mockResolvedValueOnce({ status_code: "IN_PROGRESS" });
        graphRequestMock
          .mockResolvedValueOnce({ status_code: "FINISHED" })
          .mockResolvedValueOnce({ id: "reel-media-1" })
          .mockResolvedValueOnce({ permalink: "https://www.instagram.com/reel/Crl1/" });

        const promise = instagramTransport.publishNow(input({ media: [clip()] }));
        await vi.runAllTimersAsync();
        await expect(promise).resolves.toMatchObject({ ref: "reel-media-1" });
        expect(REELS_POLL).toEqual({ intervalMs: 5_000, maxAttempts: 36 });
        vi.useRealTimers();
      });

      it("gives up after REELS_POLL with nothing published when the video never finishes", async () => {
        vi.useFakeTimers();
        graphRequestMock.mockResolvedValueOnce({ id: "reel-container-1" });
        graphRequestMock.mockResolvedValue({ status_code: "IN_PROGRESS" });

        const promise = instagramTransport.publishNow(input({ media: [clip()] }));
        const assertion = expect(promise).rejects.toThrow(/after 36 status checks \(~180s\)/);
        await vi.runAllTimersAsync();
        await assertion;
        // 1 create + 36 status reads, and never a media_publish.
        expect(graphRequestMock).toHaveBeenCalledTimes(37);
        expect(graphRequestMock.mock.calls.some(([path]) => String(path).endsWith("/media_publish"))).toBe(false);
        vi.useRealTimers();
      });

      it("fails before publishing when the Reel container reaches ERROR", async () => {
        graphRequestMock
          .mockResolvedValueOnce({ id: "reel-container-1" })
          .mockResolvedValueOnce({ status_code: "ERROR", status: "Error: 2207026 video format" });
        await expect(instagramTransport.publishNow(input({ media: [clip()] }))).rejects.toThrow(/2207026/);
        expect(graphRequestMock).toHaveBeenCalledTimes(2);
      });

      it.each([
        ["a video mixed with an image", () => [image(), clip()], /exactly one video and nothing else/],
        ["two videos", () => [clip(), clip({ path: "b.mp4" })], /cannot be a carousel child/],
        ["a webm", () => [clip({ mimeType: "video/webm" })], /MP4 or MOV only/],
        ["a video with no public url", () => [clip({ url: undefined })], /has no public url/],
        ["a clip under 3 s", () => [clip({ durationSec: 2 })], /at least 3s/],
      ])("refuses %s with a PublishPreflightError before any vendor call", async (_label, media, message) => {
        const attempt = instagramTransport.publishNow(input({ media: media() }));
        await expect(attempt).rejects.toThrow(PublishPreflightError);
        await expect(instagramTransport.publishNow(input({ media: media() }))).rejects.toThrow(message);
        expect(graphRequestMock).not.toHaveBeenCalled();
        expect(metaCredentialsMock).not.toHaveBeenCalled();
      });
    });

    describe("isAiGeneratedAsset", () => {
      const base = image({ type: "video", mimeType: "video/mp4" });
      it.each([
        ["no provenance", {}, false],
        ["aiGenerated: true", { aiGenerated: true }, true],
        ["aiGenerated as a string", { aiGenerated: "true" }, false],
        ["genMeta.aiGenerated: true", { genMeta: { aiGenerated: true } }, true],
        ["genMeta without the flag", { genMeta: { model: "veo" } }, false],
        ["genMeta null", { genMeta: null }, false],
        ["genMeta a string", { genMeta: "aiGenerated" }, false],
      ])("%s -> %s", (_label, extra, expected) => {
        expect(isAiGeneratedAsset({ ...base, ...extra } as MediaAsset)).toBe(expected);
      });
    });

    it("refuses an animated GIF leg with a clear error, without calling the vendor", async () => {
      const gif = image({ type: "gif", mimeType: "image/gif", url: "https://cdn/clip.gif" });
      await expect(instagramTransport.publishNow(input({ media: [gif] }))).rejects.toThrow(/GIFs are not supported/);
      expect(graphRequestMock).not.toHaveBeenCalled();
    });

    it("refuses a non-JPEG image with a clear error rather than posting it", async () => {
      const png = image({ mimeType: "image/png" });
      await expect(instagramTransport.publishNow(input({ media: [png] }))).rejects.toThrow(
        /unsupported image mime type/,
      );
      expect(graphRequestMock).not.toHaveBeenCalled();
    });

    it("accepts the JPEG the publish-time fit produces from a PNG card", async () => {
      // The other half of the case above. This transport does not re-encode
      // (`sharp` is a native binary and this folder must stay liftable), so a
      // PNG card reaching it means `fitForTransport` did not run — which is
      // exactly what happened to four production drafts whose Instagram leg
      // died naming an `ai-card-*.png`. What the fitter hands back is this, and
      // `image_url` must point at the CONVERTED object, not the original.
      const fitted = image({
        mimeType: "image/jpeg",
        path: "ai-card-1f4c2b9a77de.png",
        url: "https://media.example.com/social-hq/assets/abc/fit-1f4c2b9a77de.jpeg",
      });
      graphRequestMock
        .mockResolvedValueOnce({ id: "container-9" })
        .mockResolvedValueOnce({ status_code: "FINISHED" })
        .mockResolvedValueOnce({ id: "media-9" })
        .mockResolvedValueOnce({ permalink: "https://www.instagram.com/p/Cfit/" });

      const result = await instagramTransport.publishNow(input({ media: [fitted] }));

      expect(result.ref).toBe("media-9");
      expect(graphRequestMock).toHaveBeenNthCalledWith(
        1,
        "ig-user-1/media",
        expect.objectContaining({
          params: expect.objectContaining({
            image_url: "https://media.example.com/social-hq/assets/abc/fit-1f4c2b9a77de.jpeg",
          }),
        }),
      );
    });

    it("refuses a media asset with no public url, with a clear error", async () => {
      const noUrl = image({ url: undefined });
      await expect(instagramTransport.publishNow(input({ media: [noUrl] }))).rejects.toThrow(/has no public url/);
      expect(graphRequestMock).not.toHaveBeenCalled();
    });

    it("throws when no attached media resolves to a sendable image", async () => {
      await expect(instagramTransport.publishNow(input({ media: [] }))).rejects.toThrow(/needs at least one image/);
      expect(graphRequestMock).not.toHaveBeenCalled();
    });

    it("throws when no Instagram business account is linked, before doing any container work", async () => {
      metaCredentialsMock.mockResolvedValue({ ...CREDS, igUserId: undefined });
      await expect(instagramTransport.publishNow(input())).rejects.toThrow(/no Instagram business account/);
      expect(graphRequestMock).not.toHaveBeenCalled();
    });

    it("posts the first comment as a separate call after the post is live", async () => {
      graphRequestMock
        .mockResolvedValueOnce({ id: "container-1" })
        .mockResolvedValueOnce({ status_code: "FINISHED" })
        .mockResolvedValueOnce({ id: "media-1" })
        .mockResolvedValueOnce(undefined) // POST .../comments
        .mockResolvedValueOnce({ permalink: "https://www.instagram.com/p/Cabc/" });

      await instagramTransport.publishNow(input({ render: render({ firstComment: "link in bio!" }) }));

      expect(graphRequestMock).toHaveBeenNthCalledWith(
        4,
        "media-1/comments",
        expect.objectContaining({ method: "POST", params: { message: "link in bio!" } }),
      );
    });

    it("does not fail the publish when the first comment call fails", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      graphRequestMock
        .mockResolvedValueOnce({ id: "container-1" })
        .mockResolvedValueOnce({ status_code: "FINISHED" })
        .mockResolvedValueOnce({ id: "media-1" })
        .mockRejectedValueOnce(new MetaGraphError("comments disabled", 400, 200, null, "OAuthException", null))
        .mockResolvedValueOnce({ permalink: "https://www.instagram.com/p/Cabc/" });

      const result = await instagramTransport.publishNow(input({ render: render({ firstComment: "link in bio!" }) }));

      expect(result.ref).toBe("media-1"); // the publish itself is reported as a success
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("first comment failed"));
      expect(result.warnings).toEqual(["first comment failed: comments disabled"]);
      warn.mockRestore();
    });

    it("falls back to the best-effort postUrl when the permalink lookup fails", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      graphRequestMock
        .mockResolvedValueOnce({ id: "container-1" })
        .mockResolvedValueOnce({ status_code: "FINISHED" })
        .mockResolvedValueOnce({ id: "media-1" })
        .mockRejectedValueOnce(new MetaGraphError("temporarily unavailable", 500, 2, null, null, null));

      const result = await instagramTransport.publishNow(input());

      expect(result.ref).toBe("media-1");
      expect(result.url).toBe(instagramTransport.postUrl("media-1"));
      warn.mockRestore();
    });
  });

  describe("deletePost", () => {
    it("deletes normally when the post still exists", async () => {
      graphRequestMock.mockResolvedValue({ success: true });
      await expect(instagramTransport.deletePost("media-1")).resolves.toBeUndefined();
      expect(graphRequestMock).toHaveBeenCalledWith(
        "media-1",
        expect.objectContaining({ method: "DELETE", accessToken: CREDS.pageToken, appSecret: CREDS.appSecret }),
      );
    });

    it("treats an already-gone post (code 100, 'does not exist') as SUCCESS, not a failure", async () => {
      graphRequestMock.mockImplementation(async (_id: string, opts?: { method?: string }) => {
        if (opts?.method === "DELETE") throw notFound();
        return { id: CREDS.igUserId };
      });
      await expect(instagramTransport.deletePost("media-gone")).resolves.toBeUndefined();
      // The ownership probe: the configured token still reads its own IG account.
      expect(graphRequestMock).toHaveBeenCalledWith(CREDS.igUserId, expect.objectContaining({ params: { fields: "id" } }));
    });

    it("⛔ does NOT read code 100 as gone when the token cannot read its own Instagram account", async () => {
      // Meta's text also means "missing permissions": a switched or revoked
      // credential reads every live post this way.
      graphRequestMock.mockRejectedValue(notFound());
      await expect(instagramTransport.deletePost("media-1")).rejects.toThrow(
        /instagram: Meta answered "does not exist" for media-1, which cannot be read as deleted: the configured token cannot read its own Instagram account ig-user-1 \(/,
      );
    });

    it("⛔ does NOT read code 100 as gone with no Instagram account configured", async () => {
      metaCredentialsMock.mockResolvedValue({ ...CREDS, igUserId: undefined });
      graphRequestMock.mockRejectedValue(notFound());
      await expect(instagramTransport.deletePost("media-1")).rejects.toThrow(
        /cannot be read as deleted: no Instagram account is configured/,
      );
      expect(graphRequestMock).toHaveBeenCalledTimes(1);
    });

    it("still throws for a real failure (e.g. missing permission), not just swallowing everything", async () => {
      graphRequestMock.mockRejectedValue(
        new MetaGraphError("Missing permission instagram_manage_contents", 403, 200, null, "OAuthException", null),
      );
      await expect(instagramTransport.deletePost("media-1")).rejects.toThrow(/Missing permission/);
    });
  });

  describe("postFacts", () => {
    it("maps a found media object to PUBLISHED/released", async () => {
      graphRequestMock.mockResolvedValue({ id: "media-1" });
      const facts = await instagramTransport.postFacts(["media-1"]);
      expect(facts.get("media-1")).toEqual({ state: "PUBLISHED", released: true, platform: "instagram" });
    });

    it("maps a confirmed-gone media object to QUEUE, because ERROR is the caller's verdict to make", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      graphRequestMock.mockRejectedValue(notFound());
      const facts = await instagramTransport.postFacts(["media-gone"]);
      expect(facts.get("media-gone")).toEqual({ state: "QUEUE", released: false, platform: "instagram" });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("reads as gone"));
      warn.mockRestore();
    });

    it("maps an unreachable vendor (non-404-shaped failure) to QUEUE, never ERROR", async () => {
      graphRequestMock.mockRejectedValue(new MetaGraphError("upstream unavailable", 503, 2, null, null, null));
      const facts = await instagramTransport.postFacts(["media-a", "media-b"]);
      expect(facts.get("media-a")).toEqual({ state: "QUEUE", released: false, platform: "instagram" });
      expect(facts.get("media-b")).toEqual({ state: "QUEUE", released: false, platform: "instagram" });
    });

    it("maps every ref to QUEUE when credentials cannot be resolved at all", async () => {
      metaCredentialsMock.mockRejectedValue(new Error("no Meta credentials resolver registered"));
      const facts = await instagramTransport.postFacts(["media-a", "media-b"]);
      expect(facts.get("media-a")).toEqual({ state: "QUEUE", released: false, platform: "instagram" });
      expect(facts.get("media-b")).toEqual({ state: "QUEUE", released: false, platform: "instagram" });
      expect(graphRequestMock).not.toHaveBeenCalled();
    });

    it("returns an empty map for an empty ref list without calling the vendor", async () => {
      const facts = await instagramTransport.postFacts([]);
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
      const refs = Array.from({ length: 25 }, (_, i) => `media-${i}`);
      const facts = await instagramTransport.postFacts(refs);
      expect(facts.size).toBe(25);
      expect(graphRequestMock).toHaveBeenCalledTimes(25);
      expect(maxInFlight).toBeLessThanOrEqual(10);
    });
  });
});

/**
 * Failures that arrive without the fields the happy path reads: a bare string
 * rejection (undici, worker threads) and a Meta status body with no `status`
 * detail. Each must still produce a readable reason, never a crash.
 */
describe("instagram transport: non-Error failures and sparse vendor bodies", () => {
  it("connectStatus stringifies a thrown non-Error into the reason", async () => {
    metaCredentialsMock.mockRejectedValue("socket hang up");
    const status = await instagramTransport.connectStatus();
    expect(status).toEqual({ connected: false, accountId: "", displayName: "", reason: "socket hang up" });
  });

  it("reports an EXPIRED container without a status detail rather than printing 'undefined'", async () => {
    graphRequestMock
      .mockResolvedValueOnce({ id: "container-1" })
      .mockResolvedValueOnce({ status_code: "EXPIRED" });

    const err = (await instagramTransport.publishNow(input()).catch((e: unknown) => e)) as Error;

    expect(err.message).toBe('instagram: container container-1 reached status_code "EXPIRED" and cannot be published');
  });

  it("logs a non-Error permalink failure and falls back to the convention url", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    graphRequestMock
      .mockResolvedValueOnce({ id: "container-1" })
      .mockResolvedValueOnce({ status_code: "FINISHED" })
      .mockResolvedValueOnce({ id: "media-1" })
      .mockRejectedValueOnce("ETIMEDOUT");

    const result = await instagramTransport.publishNow(input());

    expect(result).toEqual({ ref: "media-1", url: instagramTransport.postUrl("media-1") });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/permalink lookup failed .*: ETIMEDOUT$/));
    warn.mockRestore();
  });

  it("logs a non-Error first-comment failure and keeps the post", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    graphRequestMock
      .mockResolvedValueOnce({ id: "container-1" })
      .mockResolvedValueOnce({ status_code: "FINISHED" })
      .mockResolvedValueOnce({ id: "media-1" })
      .mockRejectedValueOnce("comment refused")
      .mockResolvedValueOnce({ permalink: "https://www.instagram.com/p/Cabc/" });

    const result = await instagramTransport.publishNow(input({ render: render({ firstComment: "hi" }) }));

    expect(result.ref).toBe("media-1");
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/first comment failed .*: comment refused$/));
    expect(result.warnings).toEqual(["first comment failed: comment refused"]);
    warn.mockRestore();
  });

  it("does not treat a plain Error with not-found wording as an idempotent delete", async () => {
    graphRequestMock.mockRejectedValue(new Error("Object does not exist"));
    await expect(instagramTransport.deletePost("media-1")).rejects.toThrow("Object does not exist");
  });

  it("postFacts defers the whole batch with the stringified reason when credentials reject with a non-Error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    metaCredentialsMock.mockRejectedValue("vault sealed");
    const facts = await instagramTransport.postFacts(["media-1"]);
    expect(facts.get("media-1")).toEqual({ state: "QUEUE", released: false, platform: "instagram" });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/reporting QUEUE for 1 ref\(s\): vault sealed$/));
    warn.mockRestore();
  });

  it("postFacts logs a non-Meta lookup failure and reports QUEUE", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    graphRequestMock.mockRejectedValue("ECONNRESET");
    const facts = await instagramTransport.postFacts(["media-1"]);
    expect(facts.get("media-1")).toEqual({ state: "QUEUE", released: false, platform: "instagram" });
    expect(warn).toHaveBeenCalledWith("[instagram] postFacts lookup failed for media-1: ECONNRESET");
    warn.mockRestore();
  });
});
