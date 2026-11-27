// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The TikTok transport over the REAL client (tiktok.ts), with only `fetch`
 * stubbed, so every answer below passes through the same envelope parsing
 * production does. Each answer is one the TikTok API for Business docs print
 * for that endpoint (video publish, publish status, account profile and
 * video list).
 *
 * ⛔ The property under test above all: once the publish call has succeeded,
 * only TikTok's own FAILED may fail the leg. Anything uncertain returns the leg
 * live on its share_id, because a leg marked failed whose video then goes live
 * is how a retry posts it twice.
 */

import {
  setTikTokProfileUrl,
  tiktokTransport,
  TikTokPublishFailedError,
  TIKTOK_PUBLISH_POLL,
} from "../tiktok-transport.js";
import { setTikTokCredentialsResolver, type TikTokCredentials } from "../tiktok.js";
import { PublishPreflightError } from "../publish.js";
import type { DirectPublishInput } from "../transport.js";
import type { MediaAsset, PlatformRender } from "../types.js";

const SHARE = "v_pub_url~v1.0000000000000000001";
const POST = "7430000000000000001";
/** What the app injects from its profile registry (transport-wiring.ts). */
const PROFILE = "https://www.tiktok.com/@example-brand";

let creds: TikTokCredentials;
const fetchMock = vi.fn();

function ok(data: unknown): Response {
  return new Response(JSON.stringify({ code: 0, message: "OK", request_id: "r", data }), { status: 200 });
}

function refused(code: number, message: string): Response {
  return new Response(JSON.stringify({ code, message, request_id: "r", data: {} }), { status: 200 });
}

/** Answer each request by its path, from a queue per path. */
function route(answers: Record<string, Array<Response | Error>>): void {
  fetchMock.mockImplementation(async (url: string) => {
    const path = new URL(url).pathname.replace("/open_api/v1.3", "");
    const next = answers[path]?.shift();
    if (!next) throw new Error(`unexpected request ${path}`);
    if (next instanceof Error) throw next;
    return next;
  });
}

function calls(path: string): Array<{ url: URL; body: unknown }> {
  return (fetchMock.mock.calls as Array<[string, RequestInit]>)
    .map(([url, init]) => ({ url: new URL(url), body: init.body ? JSON.parse(init.body as string) : undefined }))
    .filter((c) => c.url.pathname.endsWith(path));
}

function video(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    path: "clip.mp4",
    type: "video",
    mimeType: "video/mp4",
    size: 12_000_000,
    url: "https://media.example.com/social-hq/assets/v/clip.mp4",
    ...overrides,
  };
}

function input(render: Partial<PlatformRender> = {}, media: MediaAsset[] = [video()]): DirectPublishInput {
  return {
    render: { platform: "tiktok", content: "Calls, answered. #smallbusiness", mediaIndices: [0], ...render },
    media,
    draftId: "draft-1",
    destination: {},
  };
}

/** Run a publish while advancing the poll's timers. */
async function publish(i: DirectPublishInput) {
  const run = tiktokTransport.publishNow(i);
  // Attach a handler now so a rejection is not reported as unhandled while
  // the timers are still being advanced.
  run.catch(() => {});
  await vi.advanceTimersByTimeAsync(TIKTOK_PUBLISH_POLL.intervalMs * (TIKTOK_PUBLISH_POLL.maxAttempts + 1));
  return run;
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  creds = { accessToken: "act.token", businessId: "open-id-1", scopes: ["user.info.basic", "video.publish"] };
  setTikTokCredentialsResolver(async () => creds);
  setTikTokProfileUrl(PROFILE);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setTikTokCredentialsResolver(null);
  setTikTokProfileUrl(null);
});

describe("channelRules", () => {
  it("declares the publish reference's limits", () => {
    expect(tiktokTransport.channelRules()).toEqual({
      maxLength: 2_200,
      countMode: "utf16",
      maxVideoBytes: 1_000_000_000,
      maxVideoSec: 600,
    });
  });
});

describe("connectStatus", () => {
  it("reports the account by its open_id and display name", async () => {
    route({ "/business/get/": [ok({ display_name: "examplebrand", profile_image: "https://p16.test/a.jpeg" })] });

    await expect(tiktokTransport.connectStatus()).resolves.toEqual({
      connected: true,
      accountId: "open-id-1",
      displayName: "examplebrand",
    });
  });

  it("reports a refusal as not connected, with TikTok's reason, instead of throwing", async () => {
    route({ "/business/get/": [refused(40105, "Invalid or incorrect access token.")] });

    const status = await tiktokTransport.connectStatus();

    expect(status.connected).toBe(false);
    expect(status.reason).toMatch(/code 40105: Invalid or incorrect access token/);
  });
});

describe("postUrl", () => {
  it("links the player once the post id is known", () => {
    expect(tiktokTransport.postUrl(`${SHARE}|${POST}`)).toBe(`https://www.tiktok.com/player/v1/${POST}`);
  });

  it("links the account's profile while it is not", () => {
    expect(tiktokTransport.postUrl(SHARE)).toBe(PROFILE);
  });

  it("links nothing, rather than guessing or throwing, when no profile URL was injected", () => {
    setTikTokProfileUrl(null);
    expect(tiktokTransport.postUrl(SHARE)).toBe("");
    expect(tiktokTransport.postUrl(`${SHARE}|${POST}`)).toBe(`https://www.tiktok.com/player/v1/${POST}`);
  });
});

describe("publishNow refusals before anything is sent", () => {
  it("refuses a render with no video", async () => {
    const image: MediaAsset = { path: "card.png", type: "image", mimeType: "image/png", size: 1, url: "https://x.test/c.png" };

    await expect(tiktokTransport.publishNow(input({}, [image]))).rejects.toBeInstanceOf(PublishPreflightError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a video with no public URL", async () => {
    await expect(tiktokTransport.publishNow(input({}, [video({ url: undefined })]))).rejects.toThrow(
      /no public URL/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a grant without video.publish rather than letting TikTok answer 40001", async () => {
    creds.scopes = ["user.info.basic", "video.list"];

    const err = await tiktokTransport.publishNow(input()).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PublishPreflightError);
    expect((err as Error).message).toMatch(/does not include video\.publish.*reconnect TikTok/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("publishNow", () => {
  it("sends the render's flags and returns the post once TikTok issues its id", async () => {
    route({
      "/business/video/publish/": [ok({ share_id: SHARE })],
      "/business/publish/status/": [
        ok({ status: "PROCESSING_DOWNLOAD" }),
        // Complete but not yet public: "Post IDs require up to three minutes".
        ok({ status: "PUBLISH_COMPLETE" }),
        ok({ status: "PUBLISH_COMPLETE", post_ids: [POST] }),
      ],
    });

    const res = await publish(
      input({ tiktokDisableDuet: true }, [video({ aiGenerated: true } as Partial<MediaAsset>)]),
    );

    expect(res).toEqual({ ref: `${SHARE}|${POST}`, url: `https://www.tiktok.com/player/v1/${POST}` });
    expect(calls("/business/video/publish/")[0]!.body).toEqual({
      business_id: "open-id-1",
      video_url: "https://media.example.com/social-hq/assets/v/clip.mp4",
      post_info: {
        caption: "Calls, answered. #smallbusiness",
        // Absent on the render means true: every post promotes the brand.
        is_brand_organic: true,
        is_branded_content: false,
        disable_comment: false,
        disable_duet: true,
        disable_stitch: false,
        is_ai_generated: true,
      },
    });
    expect(calls("/business/publish/status/")).toHaveLength(3);
  });

  it("honours an explicit opt-out of the brand label and the other toggles", async () => {
    route({
      "/business/video/publish/": [ok({ share_id: SHARE })],
      "/business/publish/status/": [ok({ status: "PUBLISH_COMPLETE", post_ids: [POST] })],
    });

    await publish(
      input({ tiktokBrandOrganic: false, tiktokDisableComment: true, tiktokDisableStitch: true }),
    );

    expect(calls("/business/video/publish/")[0]!.body).toMatchObject({
      post_info: { is_brand_organic: false, disable_comment: true, disable_stitch: true, is_ai_generated: false },
    });
  });

  it("fails the leg on TikTok's own FAILED, naming the reason: nothing went live", async () => {
    route({
      "/business/video/publish/": [ok({ share_id: SHARE })],
      "/business/publish/status/": [ok({ status: "FAILED", reason: "frame_rate_check_failed" })],
    });

    const err = await publish(input()).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TikTokPublishFailedError);
    expect((err as Error).message).toMatch(/reason frame_rate_check_failed\); nothing was published/);
  });

  it("⛔ returns the leg live on its share_id when a status read fails", async () => {
    route({
      "/business/video/publish/": [ok({ share_id: SHARE })],
      "/business/publish/status/": [new TypeError("fetch failed")],
    });

    await expect(publish(input())).resolves.toEqual({ ref: SHARE, url: PROFILE });
    expect(calls("/business/publish/status/")).toHaveLength(1);
  });

  it("⛔ returns the leg live on its share_id when the poll budget runs out", async () => {
    route({
      "/business/video/publish/": [ok({ share_id: SHARE })],
      "/business/publish/status/": Array.from({ length: TIKTOK_PUBLISH_POLL.maxAttempts }, () =>
        ok({ status: "PROCESSING_DOWNLOAD" }),
      ),
    });

    await expect(publish(input())).resolves.toEqual({ ref: SHARE, url: PROFILE });
    expect(calls("/business/publish/status/")).toHaveLength(TIKTOK_PUBLISH_POLL.maxAttempts);
  });

  it("stays inside publish-due's ten-minute claim", () => {
    expect(TIKTOK_PUBLISH_POLL.intervalMs * TIKTOK_PUBLISH_POLL.maxAttempts).toBeLessThanOrEqual(3 * 60_000);
  });
});

describe("deletePost", () => {
  it("refuses, because the Accounts API has no video delete", async () => {
    await expect(tiktokTransport.deletePost(`${SHARE}|${POST}`)).rejects.toThrow(
      `tiktok: TikTok's API cannot delete a video post (task ${SHARE}); delete it in the TikTok app`,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("postFacts", () => {
  it("maps each task's status, and a failed read to QUEUE rather than ERROR", async () => {
    route({
      "/business/publish/status/": [
        ok({ status: "PUBLISH_COMPLETE", post_ids: [POST] }),
        ok({ status: "FAILED", reason: "video_pull_failed" }),
        ok({ status: "PROCESSING_DOWNLOAD" }),
        new TypeError("fetch failed"),
      ],
    });
    const refs = [`${SHARE}|${POST}`, "v_pub_url~v1.2", "v_pub_url~v1.3", "v_pub_url~v1.4"];

    const facts = await tiktokTransport.postFacts(refs);

    expect([...facts.entries()]).toEqual([
      [refs[0], { state: "PUBLISHED", released: true, platform: "tiktok" }],
      [refs[1], { state: "ERROR", released: false, platform: "tiktok" }],
      [refs[2], { state: "QUEUE", released: false, platform: "tiktok" }],
      [refs[3], { state: "QUEUE", released: false, platform: "tiktok" }],
    ]);
    // The task id is what the status endpoint is asked for, never the post id.
    expect(calls("/business/publish/status/").map((c) => c.url.searchParams.get("publish_id"))).toEqual([
      SHARE,
      "v_pub_url~v1.2",
      "v_pub_url~v1.3",
      "v_pub_url~v1.4",
    ]);
  });
});

describe("analyticsPost", () => {
  it("reads the post's counters, keeping only numbers TikTok returned", async () => {
    route({
      "/business/video/list/": [
        ok({ videos: [{ item_id: POST, video_views: 603, likes: 243, comments: 10, shares: 4, favorites: 2 }] }),
      ],
    });

    // `reach` is absent: unavailable when a post has been inactive for a week.
    await expect(tiktokTransport.analyticsPost!(`${SHARE}|${POST}`)).resolves.toEqual({
      video_views: 603,
      likes: 243,
      comments: 10,
      shares: 4,
      favorites: 2,
    });
  });

  it("finds the post id through the task when the ref predates it", async () => {
    route({
      "/business/publish/status/": [ok({ status: "PUBLISH_COMPLETE", post_ids: [POST] })],
      "/business/video/list/": [ok({ videos: [{ item_id: POST, video_views: 5 }] })],
    });

    await expect(tiktokTransport.analyticsPost!(SHARE)).resolves.toEqual({ video_views: 5 });
    expect(JSON.parse(calls("/business/video/list/")[0]!.url.searchParams.get("filters")!)).toEqual({
      video_ids: [POST],
    });
  });

  it("is empty while the task has no public post", async () => {
    route({ "/business/publish/status/": [ok({ status: "PROCESSING_DOWNLOAD" })] });

    await expect(tiktokTransport.analyticsPost!(SHARE)).resolves.toEqual({});
  });

  it("is empty when TikTok lists no such post", async () => {
    route({ "/business/video/list/": [ok({ videos: [] })] });

    await expect(tiktokTransport.analyticsPost!(`${SHARE}|${POST}`)).resolves.toEqual({});
  });
});

describe("followerStats", () => {
  it("reads followers_count", async () => {
    route({ "/business/get/": [ok({ followers_count: 13 })] });

    await expect(tiktokTransport.followerStats!()).resolves.toEqual({ followers: 13 });
  });

  it("says why when TikTok returns no count", async () => {
    route({ "/business/get/": [ok({})] });

    await expect(tiktokTransport.followerStats!()).rejects.toThrow(/no followers_count .*user\.info\.stats/);
  });
});
