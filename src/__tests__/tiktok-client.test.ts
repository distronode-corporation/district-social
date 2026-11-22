import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The TikTok Accounts API client (tiktok.ts). Every response below has the
 * shape the TikTok API for Business docs print for that endpoint; the one
 * property that matters most is that a refusal arrives as HTTP 200 with a
 * non-zero `code` (the Appendix - Return Codes doc).
 */

import {
  getPostMetrics,
  getProfile,
  publishStatus,
  publishVideo,
  setTikTokCredentialsResolver,
  TikTokError,
  TIKTOK_API_BASE_URL,
  TIKTOK_POST_METRIC_FIELDS,
} from "../tiktok.js";
import { isRejection, isUnknownOutcome } from "../retry.js";

const CREDS = { accessToken: "act.token", businessId: "open-id-1", scopes: ["video.publish"] };

const fetchMock = vi.fn();

function envelope(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init });
}

function ok(data: unknown): Response {
  return envelope({ code: 0, message: "OK", request_id: "req-1", data });
}

/** The URL and init of the most recent fetch. */
function lastCall(): { url: URL; init: RequestInit } {
  const call = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return { url: new URL(call[0]), init: call[1] };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  setTikTokCredentialsResolver(async () => CREDS);
});

afterEach(() => {
  vi.unstubAllGlobals();
  setTikTokCredentialsResolver(null);
});

describe("credentials", () => {
  it("refuses clearly when no resolver is registered", async () => {
    setTikTokCredentialsResolver(null);
    await expect(publishStatus("v_pub_url~v1.1")).rejects.toThrow(/no TikTok credentials resolver registered/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks the resolver on every request rather than caching a one-day token", async () => {
    const resolver = vi.fn(async () => CREDS);
    setTikTokCredentialsResolver(resolver);
    fetchMock.mockImplementation(async () => ok({ status: "PROCESSING_DOWNLOAD" }));

    await publishStatus("a");
    await publishStatus("b");

    expect(resolver).toHaveBeenCalledTimes(2);
  });
});

describe("publishVideo", () => {
  it("posts the documented body with every post_info flag explicit", async () => {
    fetchMock.mockResolvedValue(ok({ share_id: "v_pub_url~v1.0000000000000000001" }));

    const res = await publishVideo({
      videoUrl: "https://media.example.com/social-hq/assets/v/clip.mp4",
      caption: "Calls, answered. #smallbusiness",
      brandOrganic: true,
      disableComment: false,
      disableDuet: true,
      disableStitch: false,
      aiGenerated: true,
    });

    expect(res).toEqual({ shareId: "v_pub_url~v1.0000000000000000001" });
    const { url, init } = lastCall();
    expect(url.toString()).toBe(`${TIKTOK_API_BASE_URL}/business/video/publish/`);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Access-Token": "act.token", "Content-Type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual({
      business_id: "open-id-1",
      video_url: "https://media.example.com/social-hq/assets/v/clip.mp4",
      post_info: {
        caption: "Calls, answered. #smallbusiness",
        is_brand_organic: true,
        is_branded_content: false,
        disable_comment: false,
        disable_duet: true,
        disable_stitch: false,
        is_ai_generated: true,
      },
    });
  });

  it("raises an envelope refusal on HTTP 200 instead of reading it as success", async () => {
    fetchMock.mockResolvedValue(
      envelope({ code: 40001, message: "No permission to perform the related operation.", request_id: "r", data: {} }),
    );

    const err = (await publishVideo({
      videoUrl: "https://x.test/v.mp4",
      caption: "c",
      brandOrganic: true,
      disableComment: false,
      disableDuet: false,
      disableStitch: false,
      aiGenerated: false,
    }).catch((e: unknown) => e)) as TikTokError;

    expect(err).toBeInstanceOf(TikTokError);
    expect(err.status).toBe(200);
    expect(err.code).toBe(40001);
    expect(err.message).toBe("TikTok POST /business/video/publish/ -> code 40001: No permission to perform the related operation.");
    // A permission refusal is neither a rate limit nor an unknown outcome:
    // retry.ts repeats neither.
    expect(isRejection(err)).toBe(false);
    expect(isUnknownOutcome(err)).toBe(false);
  });

  it.each([40016, 40100])("marks code %i (too many requests) as a rejection retry.ts may repeat", async (code) => {
    fetchMock.mockResolvedValue(
      envelope({ code, message: "Requests made too frequently.", request_id: "r", data: {} }, { headers: { "Retry-After": "2" } }),
    );

    const err = (await publishStatus("s").catch((e: unknown) => e)) as TikTokError;

    expect(err.rateLimited).toBe(true);
    expect(err.retryAfter).toBe("2");
    expect(isRejection(err)).toBe(true);
  });
});

describe("request failures", () => {
  it("raises a non-2xx HTTP status with the body", async () => {
    fetchMock.mockResolvedValue(new Response("upstream error", { status: 502 }));

    const err = (await publishStatus("s").catch((e: unknown) => e)) as TikTokError;

    expect(err.status).toBe(502);
    expect(err.code).toBeNull();
    expect(err.message).toBe("TikTok GET /business/publish/status/ -> 502: upstream error");
    expect(isUnknownOutcome(err)).toBe(true);
  });

  it("raises a 200 that is not JSON rather than crashing on it", async () => {
    fetchMock.mockResolvedValue(new Response("<html>maintenance</html>", { status: 200 }));

    await expect(publishStatus("s")).rejects.toThrow(/expected JSON, got: <html>maintenance<\/html>/);
  });

  it("wraps a network failure as status 0, the engine's no-response sentinel", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));

    const err = (await publishStatus("s").catch((e: unknown) => e)) as TikTokError;

    expect(err).toBeInstanceOf(TikTokError);
    expect(err.status).toBe(0);
    expect(err.rateLimited).toBe(false);
    expect(isUnknownOutcome(err)).toBe(true);
  });
});

describe("publishStatus", () => {
  it("asks for the task by business_id and publish_id", async () => {
    fetchMock.mockResolvedValue(ok({ status: "PROCESSING_DOWNLOAD" }));

    await expect(publishStatus("v_pub_url~v1.9")).resolves.toEqual({ status: "PROCESSING_DOWNLOAD", postIds: [] });

    const { url, init } = lastCall();
    expect(url.pathname).toBe("/open_api/v1.3/business/publish/status/");
    expect(url.searchParams.get("business_id")).toBe("open-id-1");
    expect(url.searchParams.get("publish_id")).toBe("v_pub_url~v1.9");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(init.headers).toEqual({ "Access-Token": "act.token" });
  });

  it("returns the post ids of a completed task", async () => {
    fetchMock.mockResolvedValue(ok({ post_ids: ["7430000000000000001"], status: "PUBLISH_COMPLETE" }));

    await expect(publishStatus("s")).resolves.toEqual({
      status: "PUBLISH_COMPLETE",
      postIds: ["7430000000000000001"],
    });
  });

  it("returns the reason of a failed task", async () => {
    fetchMock.mockResolvedValue(ok({ reason: "frame_rate_check_failed", status: "FAILED" }));

    await expect(publishStatus("s")).resolves.toEqual({
      status: "FAILED",
      postIds: [],
      reason: "frame_rate_check_failed",
    });
  });
});

describe("getProfile", () => {
  it("asks for the default fields when none are named", async () => {
    fetchMock.mockResolvedValue(ok({ display_name: "Acme", profile_image: "https://p16.test/a.jpeg" }));

    await expect(getProfile()).resolves.toEqual({
      businessId: "open-id-1",
      displayName: "Acme",
      followersCount: undefined,
    });
    expect(lastCall().url.searchParams.has("fields")).toBe(false);
  });

  it("passes named fields as a JSON array", async () => {
    fetchMock.mockResolvedValue(ok({ followers_count: 13 }));

    await expect(getProfile(["followers_count"])).resolves.toEqual({
      businessId: "open-id-1",
      displayName: undefined,
      followersCount: 13,
    });
    expect(lastCall().url.searchParams.get("fields")).toBe('["followers_count"]');
  });
});

describe("getPostMetrics", () => {
  it("filters the video list to the one post and returns its counters", async () => {
    const row = { item_id: "7430000000000000001", video_views: 603, likes: 243, comments: 10, shares: 10, cover: "x" };
    fetchMock.mockResolvedValue(ok({ cursor: 0, has_more: false, videos: [row] }));

    await expect(getPostMetrics("7430000000000000001")).resolves.toEqual({ video_views: 603, likes: 243, comments: 10, shares: 10 });

    const { url } = lastCall();
    expect(url.pathname).toBe("/open_api/v1.3/business/video/list/");
    expect(JSON.parse(url.searchParams.get("fields")!)).toEqual(["item_id", ...TIKTOK_POST_METRIC_FIELDS]);
    expect(JSON.parse(url.searchParams.get("filters")!)).toEqual({ video_ids: ["7430000000000000001"] });
  });

  it("returns null when TikTok lists no such post", async () => {
    fetchMock.mockResolvedValue(ok({ cursor: 0, has_more: false, videos: [] }));

    await expect(getPostMetrics("7430000000000000001")).resolves.toBeNull();
  });
});
