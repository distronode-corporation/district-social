import { describe, it, expect, vi, beforeEach } from "vitest";

// The transport is a business-logic layer on top of the vendor client, so it
// is tested against a mocked client — pinterest-transport.test.ts's and
// x-transport.test.ts's own pattern for their clients. YouTubeError stays
// real: isYouTubeNotFound's `instanceof` + status check is exactly the thing
// under test in the delete/postFacts not-found cases.
vi.mock("../youtube.js", async (importActual) => {
  const actual = await importActual<typeof import("../youtube.js")>();
  return {
    ...actual,
    insertVideo: vi.fn(),
    deleteVideo: vi.fn(),
    getVideos: vi.fn(),
    getMyChannel: vi.fn(),
    getVideoStats: vi.fn(),
    getMyChannelStats: vi.fn(),
    getVideoAnalytics: vi.fn(),
    getChannelAnalytics: vi.fn(),
  };
});

import {
  YouTubeError,
  insertVideo,
  deleteVideo,
  getVideos,
  getMyChannel,
  getVideoStats,
  getMyChannelStats,
  getVideoAnalytics,
  getChannelAnalytics,
} from "../youtube.js";
import { youtubeTransport } from "../youtube-transport.js";
import { PublishPreflightError } from "../publish.js";
import type { DirectPublishInput, PublishDestination } from "../transport.js";
import type { MediaAsset, PlatformRender } from "../types.js";

const insertVideoMock = insertVideo as unknown as ReturnType<typeof vi.fn>;
const deleteVideoMock = deleteVideo as unknown as ReturnType<typeof vi.fn>;
const getVideosMock = getVideos as unknown as ReturnType<typeof vi.fn>;
const getMyChannelMock = getMyChannel as unknown as ReturnType<typeof vi.fn>;
const getVideoStatsMock = getVideoStats as unknown as ReturnType<typeof vi.fn>;
const getMyChannelStatsMock = getMyChannelStats as unknown as ReturnType<typeof vi.fn>;
const getVideoAnalyticsMock = getVideoAnalytics as unknown as ReturnType<typeof vi.fn>;
const getChannelAnalyticsMock = getChannelAnalytics as unknown as ReturnType<typeof vi.fn>;

function notFound(): YouTubeError {
  return new YouTubeError(404, JSON.stringify({ error: { message: "videoNotFound" } }), "DELETE", "/videos");
}

function render(overrides: Partial<PlatformRender> = {}): PlatformRender {
  return { platform: "youtube", content: "check this out", mediaIndices: [], ...overrides };
}

function video(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    path: "/tmp/clip.mp4",
    type: "video",
    mimeType: "video/mp4",
    size: 5_000_000,
    url: "https://cdn.example.com/clip.mp4",
    durationSec: 30,
    ...overrides,
  };
}

function image(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    path: "/tmp/card.png",
    type: "image",
    mimeType: "image/png",
    size: 900_000,
    url: "https://cdn.example.com/card.png",
    ...overrides,
  };
}

function destination(overrides: Partial<PublishDestination> = {}): PublishDestination {
  return { title: "A demo video", ...overrides };
}

function input(overrides: Partial<DirectPublishInput> = {}): DirectPublishInput {
  return { render: render(), media: [video()], draftId: "draft-1", destination: destination(), ...overrides };
}

beforeEach(() => {
  insertVideoMock.mockReset();
  deleteVideoMock.mockReset();
  getVideosMock.mockReset();
  getMyChannelMock.mockReset();
  getVideoStatsMock.mockReset();
  getMyChannelStatsMock.mockReset();
  // The Analytics half answers "no data yet" unless a test says otherwise, so
  // the Data API tests below read exactly as they did before it existed.
  getVideoAnalyticsMock.mockReset().mockResolvedValue({});
  getChannelAnalyticsMock.mockReset().mockResolvedValue({});
  vi.stubGlobal("fetch", vi.fn());
});

describe("youtube transport", () => {
  it("declares the real vendor limits, including maxVideoBytes/maxVideoSec so QA's video gates have something to check", () => {
    expect(youtubeTransport.channelRules()).toEqual({
      maxLength: 5000,
      // BYTES, not characters. "utf16" would give the same number for
      // ASCII, which is exactly why a wrong unit here goes unnoticed.
      countMode: "utf8bytes",
      maxVideoBytes: 256 * 1024 * 1024 * 1024,
      maxVideoSec: 900,
    });
  });

  describe("connectStatus", () => {
    it("reports connected with the channel's id/title", async () => {
      getMyChannelMock.mockResolvedValue({ id: "chan-1", title: "Acme" });
      const status = await youtubeTransport.connectStatus();
      expect(status).toEqual({ connected: true, accountId: "chan-1", displayName: "Acme" });
    });

    it("resolves with connected:false and a reason instead of rejecting on a bad credential", async () => {
      getMyChannelMock.mockRejectedValue(new YouTubeError(401, "invalid token", "GET", "/channels"));
      const status = await youtubeTransport.connectStatus();
      expect(status.connected).toBe(false);
      expect(status.accountId).toBe("");
      expect(status.reason).toMatch(/invalid token/);
    });
  });

  describe("postUrl", () => {
    it("builds the public watch URL from the id", () => {
      expect(youtubeTransport.postUrl("vid-1")).toBe("https://www.youtube.com/watch?v=vid-1");
    });
  });

  describe("publishNow", () => {
    it("uploads the video with title/description/tags/categoryId/privacyStatus and returns its id and url", async () => {
      // A real Response: the shared media fetch streams res.body under a byte
      // cap (media-fetch.ts), so a plain { ok, arrayBuffer } object can no
      // longer stand in for what fetch actually returns.
      (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => new Response(new Uint8Array([1, 2, 3])));
      insertVideoMock.mockResolvedValue({ id: "vid-1", title: "My Title", privacyStatus: "public" });

      const result = await youtubeTransport.publishNow(
        input({ render: render({ content: "Great launch #ai #demo", title: "My Title" }) }),
      );

      expect(result).toEqual({ ref: "vid-1", url: "https://www.youtube.com/watch?v=vid-1" });
      expect(insertVideoMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "My Title",
          description: "Great launch #ai #demo",
          tags: ["ai", "demo"],
          categoryId: "28",
          privacyStatus: "public",
          mimeType: "video/mp4",
        }),
      );
      const call = insertVideoMock.mock.calls[0][0] as { videoBytes: Uint8Array };
      expect(call.videoBytes).toEqual(new Uint8Array([1, 2, 3]));
    });

    /**
     * The central refusal this transport exists to add. YouTube's
     * videos.insert has no image-post equivalent, so a render carrying only
     * images/gifs must be refused loudly BEFORE any network call rather than
     * silently uploading nothing.
     */
    it("refuses before any network call when the render carries only images", async () => {
      await expect(youtubeTransport.publishNow(input({ media: [image()] }))).rejects.toThrow(
        PublishPreflightError,
      );
      await expect(youtubeTransport.publishNow(input({ media: [image()] }))).rejects.toThrow(/needs a video/);
      expect(insertVideoMock).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    });

    it("refuses when the render carries no media at all", async () => {
      await expect(youtubeTransport.publishNow(input({ media: [] }))).rejects.toThrow(PublishPreflightError);
      expect(insertVideoMock).not.toHaveBeenCalled();
    });

    it("refuses when the video asset has no fetchable URL", async () => {
      await expect(
        youtubeTransport.publishNow(input({ media: [video({ url: undefined })] })),
      ).rejects.toThrow(/no fetchable URL/);
      expect(insertVideoMock).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    });

    it("falls back from render.title to destination.title, then to the content, when no title is set", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => new Response(new Uint8Array([1])));
      insertVideoMock.mockResolvedValue({ id: "vid-2" });

      await youtubeTransport.publishNow(
        input({ render: render({ title: undefined }), destination: destination({ title: "Settings title" }) }),
      );

      expect(insertVideoMock).toHaveBeenCalledWith(expect.objectContaining({ title: "Settings title" }));
    });

    /**
     * videos.insert refuses < and > in snippet.title and snippet.description,
     * and only after the video bytes went up. They are swapped for single
     * guillemets before the upload.
     */
    it("swaps < and > out of the title and description before the upload", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => new Response(new Uint8Array([1])));
      insertVideoMock.mockResolvedValue({ id: "vid-ab" });

      await youtubeTransport.publishNow(
        input({ render: render({ title: "Calls <60s> to answer", content: "Answer in < 1 ring, > 90% of calls" }) }),
      );

      const call = insertVideoMock.mock.calls[0][0] as { title: string; description: string };
      expect(call.title).toBe("Calls \u203960s\u203A to answer");
      expect(call.description).toBe("Answer in \u2039 1 ring, \u203A 90% of calls");
    });

    it("measures the description's 5000 bytes AFTER the swap, which costs 3 bytes per bracket", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => new Response(new Uint8Array([1])));
      insertVideoMock.mockResolvedValue({ id: "vid-ab2" });

      await youtubeTransport.publishNow(input({ render: render({ content: "<".repeat(2000) }) }));

      const call = insertVideoMock.mock.calls[0][0] as { description: string };
      expect(new TextEncoder().encode(call.description).length).toBeLessThanOrEqual(5000);
      expect(call.description).not.toMatch(/[<>]/);
    });

    it("truncates an oversized title to 100 characters", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => new Response(new Uint8Array([1])));
      insertVideoMock.mockResolvedValue({ id: "vid-3" });

      const longTitle = "x".repeat(150);
      await youtubeTransport.publishNow(input({ render: render({ title: longTitle }) }));

      const call = insertVideoMock.mock.calls[0][0] as { title: string };
      expect(call.title).toHaveLength(100);
    });

    it("truncates an oversized description to 5000 BYTES without splitting a multi-byte character", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => new Response(new Uint8Array([1])));
      insertVideoMock.mockResolvedValue({ id: "vid-4" });

      // A multi-byte emoji repeated well past the 5000-byte cap.
      const longDescription = "🚀".repeat(2000);
      await youtubeTransport.publishNow(input({ render: render({ content: longDescription }) }));

      const call = insertVideoMock.mock.calls[0][0] as { description: string };
      const byteLength = new TextEncoder().encode(call.description).byteLength;
      expect(byteLength).toBeLessThanOrEqual(5000);
      // No lone surrogate / replacement character from a split code point.
      expect(call.description).not.toContain("�");
    });

    it("prefers an explicit platformSpecificData.tags over hashtags parsed from the content", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => new Response(new Uint8Array([1])));
      insertVideoMock.mockResolvedValue({ id: "vid-5" });

      await youtubeTransport.publishNow(
        input({
          render: render({
            content: "no hashtags here",
            platformSpecificData: { tags: ["explicit-one", "explicit-two"] },
          }),
        }),
      );

      expect(insertVideoMock).toHaveBeenCalledWith(
        expect.objectContaining({ tags: ["explicit-one", "explicit-two"] }),
      );
    });

    it("sends no tags when the content has no hashtags and platformSpecificData carries none", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => new Response(new Uint8Array([1])));
      insertVideoMock.mockResolvedValue({ id: "vid-6" });

      await youtubeTransport.publishNow(input({ render: render({ content: "plain text, no tags" }) }));

      expect(insertVideoMock).toHaveBeenCalledWith(expect.objectContaining({ tags: [] }));
    });

    it("fits as many tags as possible under the 500-combined-char vendor budget rather than sending an oversized array", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => new Response(new Uint8Array([1])));
      insertVideoMock.mockResolvedValue({ id: "vid-7" });

      // 60 tags of ~10 chars each (~660 combined) — over the 500-char budget.
      const manyTags = Array.from({ length: 60 }, (_, i) => `tagword${i}`);
      await youtubeTransport.publishNow(
        input({ render: render({ content: "x", platformSpecificData: { tags: manyTags } }) }),
      );

      const call = insertVideoMock.mock.calls[0][0] as { tags: string[] };
      const combined = call.tags.join(",").length;
      expect(combined).toBeLessThanOrEqual(500);
      expect(call.tags.length).toBeLessThan(manyTags.length);
    });
  });

  describe("deletePost", () => {
    it("deletes normally when the video still exists", async () => {
      deleteVideoMock.mockResolvedValue(undefined);
      await expect(youtubeTransport.deletePost("vid-1")).resolves.toBeUndefined();
    });

    it("treats an already-gone video (404) as SUCCESS, not a failure", async () => {
      deleteVideoMock.mockRejectedValue(notFound());
      await expect(youtubeTransport.deletePost("vid-gone")).resolves.toBeUndefined();
    });

    it("still throws for a real failure (e.g. auth), not just swallowing everything", async () => {
      deleteVideoMock.mockRejectedValue(new YouTubeError(401, "token expired", "DELETE", "/videos"));
      await expect(youtubeTransport.deletePost("vid-1")).rejects.toThrow(/token expired/);
    });
  });

  describe("postFacts", () => {
    it("maps a found video to PUBLISHED/released", async () => {
      getVideosMock.mockResolvedValue([{ id: "vid-1" }]);
      const facts = await youtubeTransport.postFacts(["vid-1"]);
      expect(facts.get("vid-1")).toEqual({ state: "PUBLISHED", released: true, platform: "youtube" });
    });

    /**
     * Unlike Pinterest's single-id 404 or X's per-ref resource-not-found
     * type, a missing id inside videos.list's batch `id=` is AMBIGUOUS from
     * official docs (see youtube-transport.ts's postFacts docblock), so
     * this NEVER sets `absent`, unlike pinterest-transport.ts's confirmed-404
     * case.
     */
    it("maps a video missing from the response to QUEUE without the absent flag", async () => {
      getVideosMock.mockResolvedValue([]);
      const facts = await youtubeTransport.postFacts(["vid-gone"]);
      expect(facts.get("vid-gone")).toEqual({ state: "QUEUE", released: false, platform: "youtube" });
    });

    it("maps an unreachable vendor (lookup failure) to QUEUE, never ERROR", async () => {
      getVideosMock.mockRejectedValue(new YouTubeError(503, "upstream unavailable", "GET", "/videos"));
      const facts = await youtubeTransport.postFacts(["vid-a", "vid-b"]);
      expect(facts.get("vid-a")).toEqual({ state: "QUEUE", released: false, platform: "youtube" });
      expect(facts.get("vid-b")).toEqual({ state: "QUEUE", released: false, platform: "youtube" });
    });

    it("returns an empty map for an empty ref list without calling the vendor", async () => {
      const facts = await youtubeTransport.postFacts([]);
      expect(facts.size).toBe(0);
      expect(getVideosMock).not.toHaveBeenCalled();
    });

    it("chunks a large batch at the 50-id limit rather than sending everything in one call", async () => {
      getVideosMock.mockImplementation(async (ids: string[]) => ids.map((id) => ({ id })));
      const refs = Array.from({ length: 120 }, (_, i) => `vid-${i}`);
      const facts = await youtubeTransport.postFacts(refs);
      expect(facts.size).toBe(120);
      // 120 refs at 50/batch -> 3 calls (50, 50, 20).
      expect(getVideosMock).toHaveBeenCalledTimes(3);
      expect(getVideosMock.mock.calls[0][0]).toHaveLength(50);
      expect(getVideosMock.mock.calls[1][0]).toHaveLength(50);
      expect(getVideosMock.mock.calls[2][0]).toHaveLength(20);
    });
  });
});

/**
 * ⛔ THE RULE UNDER TEST IS "UNKNOWN IS NOT ZERO".
 *
 * YouTube omits `likeCount` when a channel hides likes, and `subscriberCount`
 * when the owner hides subscribers. Defaulting either to 0 puts a real-looking
 * number on a dashboard that says the opposite of the truth — a video with
 * hidden likes would read as a video nobody liked, and a channel hiding its
 * count would read as one that lost every subscriber.
 */
describe("youtube analytics", () => {
  it("reports the counters the vendor sent", async () => {
    getVideoStatsMock.mockResolvedValue([{ id: "v1", views: 1200, likes: 34, comments: 5 }]);
    await expect(youtubeTransport.analyticsPost!("v1")).resolves.toEqual({
      views: 1200,
      likes: 34,
      comments: 5,
    });
  });

  it("OMITS a counter the vendor withheld rather than reporting zero", async () => {
    getVideoStatsMock.mockResolvedValue([{ id: "v1", views: 1200 }]); // likes hidden
    const stats = await youtubeTransport.analyticsPost!("v1");
    expect(stats).toEqual({ views: 1200 });
    expect("likes" in stats).toBe(false);
  });

  it("returns an empty bag for a video the vendor said nothing about", async () => {
    getVideoStatsMock.mockResolvedValue([]);
    await expect(youtubeTransport.analyticsPost!("gone")).resolves.toEqual({});
  });

  it("reports channel counters", async () => {
    getMyChannelStatsMock.mockResolvedValue({ subscribers: 42, views: 9001, videos: 7 });
    await expect(youtubeTransport.analyticsChannel!()).resolves.toEqual({
      subscribers: 42,
      views: 9001,
      videos: 7,
    });
  });

  it("THROWS rather than reporting 0 followers when the channel hides its count", async () => {
    getMyChannelStatsMock.mockResolvedValue({ views: 9001, videos: 7 });
    await expect(youtubeTransport.followerStats!()).rejects.toThrow(/subscriberCount/i);
  });

  it("reports followers when the count is public", async () => {
    getMyChannelStatsMock.mockResolvedValue({ subscribers: 42 });
    await expect(youtubeTransport.followerStats!()).resolves.toEqual({ followers: 42 });
  });
});

describe("youtube transport: non-Error failures, sparse bodies and tag edge cases", () => {
  const fetchMock = () => fetch as unknown as ReturnType<typeof vi.fn>;
  // A real Response per call: the shared media fetch streams res.body under a
  // byte cap (media-fetch.ts), and a body can only be consumed once.
  const okBytes = () => new Response(new Uint8Array([1]));

  it("connectStatus stringifies a thrown non-Error into the reason", async () => {
    getMyChannelMock.mockRejectedValue("socket hang up");
    const status = await youtubeTransport.connectStatus();
    expect(status).toEqual({ connected: false, accountId: "", displayName: "", reason: "socket hang up" });
  });

  it("refuses to upload when the media host answers non-2xx", async () => {
    fetchMock().mockResolvedValue({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) });
    await expect(youtubeTransport.publishNow(input())).rejects.toThrow(
      "youtube: failed to fetch media asset (404): https://cdn.example.com/clip.mp4",
    );
    expect(insertVideoMock).not.toHaveBeenCalled();
  });

  it("titles the video with its content when neither the render nor the settings name one", async () => {
    fetchMock().mockImplementation(okBytes);
    insertVideoMock.mockResolvedValue({ id: "vid-3" });

    await youtubeTransport.publishNow(
      input({ render: render({ content: "The copy itself", title: undefined }), destination: destination({ title: undefined }) }),
    );

    expect(insertVideoMock).toHaveBeenCalledWith(expect.objectContaining({ title: "The copy itself" }));
  });

  it("sends each hashtag once, case-insensitively, keeping the first spelling", async () => {
    fetchMock().mockImplementation(okBytes);
    insertVideoMock.mockResolvedValue({ id: "vid-4" });

    await youtubeTransport.publishNow(input({ render: render({ content: "#Voice #AI #voice #ai demo" }) }));

    expect(insertVideoMock).toHaveBeenCalledWith(expect.objectContaining({ tags: ["Voice", "AI"] }));
  });

  it("counts the quotes the vendor adds around an explicit tag containing a space", async () => {
    fetchMock().mockImplementation(okBytes);
    insertVideoMock.mockResolvedValue({ id: "vid-5" });
    // 498 + 2 quotes = 500 fits exactly; the next tag (1 + comma) would not.
    const spaced = `${"a".repeat(248)} ${"b".repeat(249)}`;

    await youtubeTransport.publishNow(
      input({ render: render({ platformSpecificData: { tags: [spaced, "x"] } }) }),
    );

    expect(insertVideoMock).toHaveBeenCalledWith(expect.objectContaining({ tags: [spaced] }));
  });

  it("postFacts maps a batch to QUEUE with the stringified reason on a non-YouTubeError failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    getVideosMock.mockRejectedValue("ECONNRESET");
    const facts = await youtubeTransport.postFacts(["v1"]);
    expect(facts.get("v1")).toEqual({ state: "QUEUE", released: false, platform: "youtube" });
    expect(warn).toHaveBeenCalledWith("[youtube] postFacts lookup failed for a batch of 1: ECONNRESET");
    warn.mockRestore();
  });

  it("omits every video counter the vendor withheld", async () => {
    getVideoStatsMock.mockResolvedValue([{ id: "v1" }]);
    await expect(youtubeTransport.analyticsPost!("v1")).resolves.toEqual({});
  });

  it("omits every channel counter the vendor withheld", async () => {
    getMyChannelStatsMock.mockResolvedValue({});
    await expect(youtubeTransport.analyticsChannel!()).resolves.toEqual({});
  });
});

/**
 * The Analytics API half. The two APIs overlap on views/likes/comments with
 * DIFFERENT figures, so the merge must never let one overwrite the other, and
 * one API failing must never discard what the other returned.
 */
describe("youtube analytics: Data API plus Analytics API", () => {
  const scopeError = () =>
    new YouTubeError(
      403,
      "the YouTube token lacks an Analytics scope (ACCESS_TOKEN_SCOPE_INSUFFICIENT); re-consent " +
        "YOUTUBE_REFRESH_TOKEN with https://www.googleapis.com/auth/yt-analytics.readonly",
      "GET",
      "/reports",
    );

  it("merges a video's Analytics totals next to its Data API counters, under YouTube's own names", async () => {
    getVideoStatsMock.mockResolvedValue([{ id: "v1", views: 7, likes: 1, comments: 0 }]);
    getVideoAnalyticsMock.mockResolvedValue({
      estimatedMinutesWatched: 13,
      averageViewDuration: 115,
      averageViewPercentage: 45.14,
      subscribersGained: 0,
      subscribersLost: 0,
      shares: 0,
    });

    await expect(youtubeTransport.analyticsPost!("v1")).resolves.toEqual({
      views: 7,
      likes: 1,
      comments: 0,
      estimatedMinutesWatched: 13,
      averageViewDuration: 115,
      averageViewPercentage: 45.14,
      subscribersGained: 0,
      subscribersLost: 0,
      shares: 0,
    });
    expect(getVideoAnalyticsMock).toHaveBeenCalledWith("v1");
  });

  it("suffixes every channel Analytics key with its 28-day window, so lifetime views keep their key", async () => {
    getMyChannelStatsMock.mockResolvedValue({ subscribers: 42, views: 9001, videos: 7 });
    getChannelAnalyticsMock.mockResolvedValue({ views: 1, estimatedMinutesWatched: 0, averageViewPercentage: 18.24 });

    await expect(youtubeTransport.analyticsChannel!()).resolves.toEqual({
      subscribers: 42,
      views: 9001,
      videos: 7,
      views_28d: 1,
      estimatedMinutesWatched_28d: 0,
      averageViewPercentage_28d: 18.24,
    });
  });

  it("keeps the Data API counters when the token lacks the Analytics scope, and logs the scope by name", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    getVideoStatsMock.mockResolvedValue([{ id: "v1", views: 7 }]);
    getVideoAnalyticsMock.mockRejectedValue(scopeError());

    await expect(youtubeTransport.analyticsPost!("v1")).resolves.toEqual({ views: 7 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/^\[youtube\] analytics for video v1 is partial.*Analytics API: .*yt-analytics\.readonly/);
    warn.mockRestore();
  });

  it("keeps the channel counters when the Analytics half fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    getMyChannelStatsMock.mockResolvedValue({ subscribers: 42 });
    getChannelAnalyticsMock.mockRejectedValue(scopeError());

    await expect(youtubeTransport.analyticsChannel!()).resolves.toEqual({ subscribers: 42 });
    expect(warn.mock.calls[0][0]).toMatch(/^\[youtube\] channel analytics is partial.*yt-analytics\.readonly/);
    warn.mockRestore();
  });

  it("keeps the Analytics totals when the Data API half fails (the reverse partial)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    getMyChannelStatsMock.mockRejectedValue("quota exceeded");
    getChannelAnalyticsMock.mockResolvedValue({ views: 3 });

    await expect(youtubeTransport.analyticsChannel!()).resolves.toEqual({ views_28d: 3 });
    expect(warn).toHaveBeenCalledWith(
      "[youtube] channel analytics is partial, returning the half that answered. Data API: quota exceeded",
    );
    warn.mockRestore();
  });

  it("throws naming BOTH failures when neither API answers, so the route shows a reason", async () => {
    getVideoStatsMock.mockRejectedValue(new YouTubeError(401, "invalid_grant", "GET", "/videos"));
    getVideoAnalyticsMock.mockRejectedValue(scopeError());

    await expect(youtubeTransport.analyticsPost!("v1")).rejects.toThrow(
      /^youtube analytics for video v1: Data API: YouTube GET \/videos -> 401: invalid_grant \/ Analytics API: .*yt-analytics\.readonly/,
    );
  });

  it("reports a brand-new video's empty Analytics answer as absent, not zero", async () => {
    getVideoStatsMock.mockResolvedValue([{ id: "v1", views: 0 }]);
    getVideoAnalyticsMock.mockResolvedValue({});
    const stats = await youtubeTransport.analyticsPost!("v1");
    expect(stats).toEqual({ views: 0 });
    expect("estimatedMinutesWatched" in stats).toBe(false);
  });
});
