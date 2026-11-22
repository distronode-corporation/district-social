import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Every vendor client's 2xx answers, attacked field by field.
 *
 * Each endpoint below has a VALID fixture (the documented shape) that must
 * read cleanly. Then every field of that fixture, at every depth, is replaced
 * in turn with a hostile value (removed, null, a number, a boolean, a huge
 * string carrying a secret, a nested array, an object) and the whole body is
 * replaced the same way. For each mutation the client must either read it
 * (a field it treats as optional, or one it does not read) or refuse it with a
 * ResponseShapeError or its own error class, and never:
 *   - crash with something else (a TypeError from reading into the wrong type),
 *   - echo the hostile value into the error message.
 * Fields listed as `required` must be refused whenever they are removed,
 * nulled or mistyped.
 */

const mockGetAccessToken = vi.hoisted(() => vi.fn());
vi.mock("google-auth-library", () => ({
  GoogleAuth: class {
    getAccessToken = mockGetAccessToken;
  },
}));

import { ResponseShapeError } from "../http/shape.js";
import { setEngineDeployment } from "../settings.js";
import * as x from "../x.js";
import * as reddit from "../reddit.js";
import * as pinterest from "../pinterest.js";
import * as linkedin from "../linkedin.js";
import * as threads from "../threads.js";
import * as meta from "../meta-graph.js";
import * as tiktok from "../tiktok.js";
import * as youtube from "../youtube.js";
import * as zernio from "../zernio.js";
import * as veo from "../veo.js";
import { FIXTURE_GCP_PROJECT, FIXTURE_REDDIT_USER_AGENT } from "./helpers/fixtures.js";

const SECRET = "SECRET_FROM_THE_BODY";
const HUGE = `${SECRET}${"x".repeat(300_000)}`;

/** The hostile replacements for one field. `undefined` removes it. */
const HOSTILE: Array<[string, unknown]> = [
  ["removed", undefined],
  ["null", null],
  ["a number", 7],
  ["a boolean", true],
  ["a huge string", HUGE],
  ["a nested array", [[SECRET]]],
  ["an object", { [SECRET]: SECRET }],
];

/** The vendor-specific error classes a refusal may also arrive as. */
const CLIENT_ERRORS = [
  x.XError,
  reddit.RedditError,
  pinterest.PinterestError,
  linkedin.LinkedInError,
  threads.ThreadsError,
  meta.MetaGraphError,
  tiktok.TikTokError,
  youtube.YouTubeError,
  zernio.ZernioError,
  veo.VeoError,
];

type Path = Array<string | number>;

interface Endpoint {
  name: string;
  call: () => Promise<unknown>;
  /** Bodies served before the one under attack (an id lookup, a lease). */
  before?: unknown[];
  /** The body under attack, as the vendor documents it. */
  body: unknown;
  /** Bodies served after it (later steps of a multi-call flow). */
  after?: unknown[];
  /** Paths that must be refused when removed, nulled or mistyped. */
  required?: string[];
  /** Wrap every body in TikTok's `{code, message, data}` envelope. */
  envelope?: boolean;
  /** A client's own documented refusal (a plain Error), accepted alongside the error classes. */
  refusal?: RegExp;
}

function leafPaths(value: unknown, at: Path = []): Path[] {
  if (Array.isArray(value)) return [at, ...value.flatMap((v, i) => leafPaths(v, [...at, i]))];
  if (value && typeof value === "object") {
    return [at, ...Object.entries(value).flatMap(([k, v]) => leafPaths(v, [...at, k]))];
  }
  return [at];
}

function withValue(root: unknown, path: Path, replacement: unknown): unknown {
  if (!path.length) return replacement;
  const copy: unknown = structuredClone(root);
  let node = copy as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) node = node[key] as Record<string | number, unknown>;
  const last = path[path.length - 1];
  if (replacement === undefined && !Array.isArray(node)) delete node[last];
  else node[last] = replacement;
  return copy;
}

function respond(body: unknown, envelope?: boolean): Response {
  if (body === "") return new Response("", { status: 200 });
  const wire = envelope ? { code: 0, message: "OK", data: body } : body;
  return new Response(JSON.stringify(wire) ?? "", { status: 200, headers: { "content-type": "application/json" } });
}

let fetchMock: ReturnType<typeof vi.fn>;

function serve(e: Endpoint, body: unknown): void {
  fetchMock.mockReset();
  for (const b of [...(e.before ?? []), body, ...(e.after ?? [])]) {
    fetchMock.mockImplementationOnce(async () => respond(b, e.envelope));
  }
  // A flow that calls more often than planned gets an empty 200, which the
  // reader under test must refuse or tolerate like any other answer.
  fetchMock.mockImplementation(async () => respond({}, e.envelope));
}

async function outcome(e: Endpoint, body: unknown): Promise<{ ok: true } | { ok: false; err: unknown }> {
  // A fresh resolver clears linkedin.ts's cached organization urn, so every
  // mutation runs the same calls in the same order (beforeEach runs once per
  // test, not once per mutation in the loop).
  linkedin.setLinkedInTokenResolver(async () => "tok");
  serve(e, body);
  try {
    await e.call();
    return { ok: true };
  } catch (err) {
    return { ok: false, err };
  }
}

function expectCleanRefusal(err: unknown, label: string, refusal?: RegExp): void {
  const known =
    err instanceof ResponseShapeError ||
    CLIENT_ERRORS.some((C) => err instanceof C) ||
    (refusal !== undefined && err instanceof Error && refusal.test(err.message));
  expect(known, `${label}: refused with ${String(err)}`).toBe(true);
  // A RedditApiError is Reddit's own rejection (a 200 carrying `json.errors`),
  // and its message is the vendor's error text by design, like any client's
  // non-2xx error; only a READ of a successful answer must never echo it.
  if (err instanceof reddit.RedditApiError) return;
  expect((err as Error).message, `${label}: echoed the body`).not.toContain(SECRET);
}

const T0 = "2026-11-22T09:40:00.000Z";
const ORG_ACL = { elements: [{ organization: "urn:li:organization:100000001" }] };

const ENDPOINTS: Record<string, Endpoint[]> = {
  x: [
    { name: "createTweet", call: () => x.createTweet({ text: "hi" }), body: { data: { id: "1", text: "hi" } }, required: ["data.id"] },
    { name: "deleteTweet", call: () => x.deleteTweet("1"), body: { data: { deleted: true } } },
    {
      name: "getTweetsBatch",
      call: () => x.getTweetsBatch(["1", "2"]),
      body: { data: [{ id: "1", text: "a" }], errors: [{ resource_id: "2", title: "Not Found Error", status: 404 }] },
      required: ["data.0.id"],
    },
    { name: "getMe", call: () => x.getMe(), body: { data: { id: "9", username: "brand", name: "Brand" } }, required: ["data.id", "data.username"] },
    { name: "getTweetMetrics", call: () => x.getTweetMetrics("1"), body: { data: { public_metrics: { like_count: 3, reply_count: 0 } } } },
    { name: "getFollowerCount", call: () => x.getFollowerCount(), body: { data: { public_metrics: { followers_count: 5 } } }, required: ["data.public_metrics.followers_count"] },
    {
      name: "listRecentTweets",
      call: () => x.listRecentTweets(new Date(T0)),
      before: [{ data: { id: "9", username: "brand" } }],
      body: { data: [{ id: "1", text: "t", created_at: T0, note_tweet: { text: "long" } }], meta: { next_token: "n" } },
      required: ["data.0.id"],
    },
    {
      name: "uploadImage INIT",
      call: () => x.uploadImage(new Uint8Array([1]) as Uint8Array<ArrayBuffer>, "image/png"),
      body: { data: { id: "m1", media_key: "3_m1" } },
      after: ["", { data: { id: "m1" } }],
      required: ["data.id"],
    },
  ],
  reddit: [
    {
      name: "submitPost",
      call: () => reddit.submitPost({ subreddit: "test", title: "t", kind: "self", text: "b" }),
      body: { json: { errors: [], data: { id: "abc", name: "t3_abc" } } },
      required: ["json.data.id", "json.data.name"],
    },
    { name: "getInfo", call: () => reddit.getInfo(["t3_a"]), body: { kind: "Listing", data: { children: [{ kind: "t3", data: { name: "t3_a" } }] } } },
    {
      name: "getPostStats",
      call: () => reddit.getPostStats(["t3_a"]),
      body: { data: { children: [{ data: { name: "t3_a", score: 3, num_comments: 1, upvote_ratio: 0.9 } }] } },
    },
    {
      name: "getSubredditAbout",
      call: () => reddit.getSubredditAbout("test"),
      body: { kind: "t5", data: { display_name: "test", submission_type: "any", over18: false } },
    },
    {
      name: "getPostRequirements",
      call: () => reddit.getPostRequirements("test"),
      body: { is_flair_required: true, body_restriction_policy: "none", title_text_min_length: 1, title_text_max_length: 300 },
    },
    { name: "getLinkFlair", call: () => reddit.getLinkFlair("test"), body: [{ id: "f1", text: "News" }] },
    { name: "getMe", call: () => reddit.getMe(), body: { id: "u1", name: "brand", link_karma: 1, comment_karma: 2, total_karma: 3 }, required: ["id", "name"] },
  ],
  pinterest: [
    { name: "getPin", call: () => pinterest.getPin("p1"), body: { id: "p1", link: "https://example.com", title: "T", board_id: "b1" }, required: ["id"] },
    { name: "listBoards", call: () => pinterest.listBoards(), body: { items: [{ id: "b1", name: "Board" }], bookmark: null }, required: ["items.0.id", "items.0.name"] },
    { name: "getUserAccount", call: () => pinterest.getUserAccount(), body: { id: "u1", username: "brand" }, required: ["id", "username"] },
    { name: "getPinAnalytics", call: () => pinterest.getPinAnalytics("p1"), body: { all: { lifetime_metrics: { IMPRESSION: 4, SAVE: 1 } } } },
    { name: "getFollowerCount", call: () => pinterest.getFollowerCount(), body: { follower_count: 12 }, required: ["follower_count"] },
    {
      name: "listRecentPins",
      call: () => pinterest.listRecentPins(),
      body: { items: [{ id: "p1", description: "d", title: "t", created_at: "2026-11-22T09:40:00" }], bookmark: "bm" },
      required: ["items.0.id"],
    },
  ],
  linkedin: [
    { name: "getOrganizationUrn", call: () => linkedin.getOrganizationUrn(), body: ORG_ACL },
    { name: "createPost", call: () => linkedin.createPost({ commentary: "hi" }), before: [ORG_ACL], body: { id: "urn:li:share:1" }, required: ["id"] },
    {
      name: "initializeImageUpload",
      call: () => linkedin.initializeImageUpload(),
      before: [ORG_ACL],
      body: { value: { uploadUrl: "https://www.linkedin.com/dms-uploads/x", image: "urn:li:image:1" } },
      required: ["value.uploadUrl", "value.image"],
    },
    {
      name: "getPostsBatch",
      call: () => linkedin.getPostsBatch(["urn:li:share:1"]),
      body: { results: { "urn:li:share:1": { id: "urn:li:share:1" } }, statuses: { "urn:li:share:1": 200 }, errors: {} },
    },
    { name: "getSocialActions", call: () => linkedin.getSocialActions("urn:li:share:1"), body: { likesSummary: { totalLikes: 2 }, commentsSummary: { aggregatedTotalComments: 1 } } },
    { name: "getFollowerCount", call: () => linkedin.getFollowerCount(), before: [ORG_ACL], body: { firstDegreeSize: 40 }, required: ["firstDegreeSize"] },
    {
      name: "listOrganizationPosts",
      call: () => linkedin.listOrganizationPosts(5),
      before: [ORG_ACL],
      body: { elements: [{ id: "urn:li:share:1", commentary: "c", createdAt: 1700000000000 }] },
      required: ["elements.0.id"],
    },
    {
      name: "getComments",
      call: () => linkedin.getComments("urn:li:share:1"),
      body: {
        elements: [
          {
            commentUrn: "urn:li:comment:(urn:li:activity:1,2)",
            actor: "urn:li:person:A",
            message: { text: "hello" },
            created: { time: 1700000000000 },
          },
        ],
        paging: { start: 0, count: 50, total: 1 },
      },
      required: ["elements.0.commentUrn"],
    },
  ],
  threads: [
    { name: "createContainer", call: () => threads.createContainer({ mediaType: "TEXT", text: "hi" }), body: { id: "c1" }, required: ["id"] },
    { name: "publishContainer", call: () => threads.publishContainer("c1"), body: { id: "t1", crossreshare_to_ig_status: "SUCCESS" }, required: ["id"] },
    { name: "getContainerStatus", call: () => threads.getContainerStatus("c1"), body: { status: "FINISHED", error_message: "none" } },
    { name: "deleteThread", call: () => threads.deleteThread("t1"), body: { success: true, deleted_id: "t1" } },
    { name: "getPermalink", call: () => threads.getPermalink("t1"), body: { permalink: "https://www.threads.net/@b/post/x" } },
    {
      name: "getMediaInsights",
      call: () => threads.getMediaInsights("t1"),
      body: { data: [{ name: "likes", values: [{ value: 3 }] }, { name: "views", total_value: { value: 9 } }] },
    },
    { name: "getProfile", call: () => threads.getProfile(), body: { id: "u1", username: "brand" }, required: ["id", "username"] },
    {
      name: "listRecentThreads",
      call: () => threads.listRecentThreads(new Date(T0)),
      body: { data: [{ id: "t1", text: "t", timestamp: "2026-11-22T09:40:00+0000", permalink: "https://t/p" }], paging: { next: "n" } },
      required: ["data.0.id"],
    },
  ],
  meta: [
    { name: "getFacebookPostInsights", call: () => meta.getFacebookPostInsights("p_1"), body: { data: [{ name: "post_clicks", values: [{ value: 2 }] }] } },
    {
      name: "getInstagramFollowers",
      call: () => meta.getInstagramFollowers(),
      body: { followers_count: 10, id: "ig1" },
      required: ["followers_count"],
      refusal: /followers_count missing from the Graph response .* Refusing to report 0/,
    },
    {
      name: "getFacebookFollowers",
      call: () => meta.getFacebookFollowers(),
      body: { followers_count: 10, id: "page-1" },
      required: ["followers_count"],
      refusal: /followers_count missing from the Graph response .* Refusing to report 0/,
    },
    {
      name: "listRecentPagePosts",
      call: () => meta.listRecentPagePosts(new Date(T0)),
      body: { data: [{ id: "page-1_1", message: "m", created_time: "2026-11-22T09:40:00+0000", permalink_url: "https://fb/p" }], paging: { next: "n" } },
      required: ["data.0.id"],
    },
    {
      name: "listRecentInstagramMedia",
      call: () => meta.listRecentInstagramMedia(),
      body: { data: [{ id: "ig_1", caption: "c", timestamp: "2026-11-22T09:40:00+0000", permalink: "https://ig/p" }] },
      required: ["data.0.id"],
    },
  ],
  tiktok: [
    {
      name: "publishVideo",
      envelope: true,
      call: () =>
        tiktok.publishVideo({
          videoUrl: "https://example.com/v.mp4",
          caption: "c",
          brandOrganic: true,
          disableComment: false,
          disableDuet: false,
          disableStitch: false,
          aiGenerated: false,
        }),
      body: { share_id: "s1" },
      required: ["share_id"],
    },
    { name: "publishStatus", envelope: true, call: () => tiktok.publishStatus("s1"), body: { status: "PUBLISH_COMPLETE", post_ids: ["7"] }, required: ["status"] },
    { name: "getProfile", envelope: true, call: () => tiktok.getProfile(["followers_count"]), body: { display_name: "Brand", followers_count: 3 } },
    {
      name: "getPostMetrics",
      envelope: true,
      call: () => tiktok.getPostMetrics("7"),
      body: { videos: [{ item_id: "7", video_views: 10, likes: 2 }] },
      required: ["videos", "videos.0.item_id"],
    },
  ],
  youtube: [
    { name: "getVideos", call: () => youtube.getVideos(["v1"]), body: { items: [{ id: "v1", snippet: { title: "T" }, status: { privacyStatus: "public" } }] }, required: ["items.0.id"] },
    { name: "getVideoStats", call: () => youtube.getVideoStats(["v1"]), body: { items: [{ id: "v1", statistics: { viewCount: "10", likeCount: "2" } }] }, required: ["items.0.id"] },
    { name: "getMyChannelStats", call: () => youtube.getMyChannelStats(), body: { items: [{ statistics: { subscriberCount: "4", viewCount: "9", videoCount: "1" } }] } },
    { name: "getMyChannel", call: () => youtube.getMyChannel(), body: { items: [{ id: "UC1", snippet: { title: "Brand" } }] }, required: ["items.0.id"] },
    {
      name: "getVideoAnalytics",
      call: () => youtube.getVideoAnalytics("v1", new Date(T0)),
      body: { columnHeaders: [{ name: "shares", columnType: "METRIC" }], rows: [[3]] },
    },
  ],
  zernio: [
    { name: "listAccounts", call: () => zernio.listAccounts(), body: { accounts: [{ _id: "a1", platform: "reddit", username: "u", displayName: "U", profileUrl: "https://z/u", isActive: true }] }, required: ["accounts.0._id", "accounts.0.platform"] },
    {
      name: "createPost",
      call: () => zernio.createPost({ content: "c", platforms: [] }),
      body: { message: "ok", post: { _id: "zp1", status: "published", platforms: [{ platform: "reddit", status: "published", platformPostId: "abc" }] } },
      required: ["post.platforms.0.platform"],
    },
    { name: "getPost", call: () => zernio.getPost("zp1"), body: { post: { _id: "zp1", status: "published" } } },
    {
      name: "getAnalytics",
      call: () => zernio.getAnalytics(),
      body: {
        overview: { totalPosts: 1 },
        posts: [
          {
            _id: "zp1",
            status: "published",
            publishedAt: T0,
            analytics: { likes: 1 },
            platforms: [{ platform: "reddit", status: "published", analytics: { likes: 1 } }],
          },
        ],
      },
      required: ["posts.0._id"],
    },
    { name: "listRedditFlairs", call: () => zernio.listRedditFlairs("a1", "test"), body: { flairs: [{ id: "f1", text: "News" }] }, required: ["flairs.0.id", "flairs.0.text"] },
    { name: "listPinterestBoards", call: () => zernio.listPinterestBoards("a1"), body: { boards: [{ id: "b1", name: "Board" }] }, required: ["boards.0.id"] },
  ],
  veo: [
    {
      name: "startVideoGeneration",
      call: () => veo.startVideoGeneration({ prompt: "p" }),
      body: { name: "projects/p/locations/us-central1/publishers/google/models/veo/operations/1" },
      required: ["name"],
    },
    {
      name: "pollVideoOperation",
      call: () => veo.pollVideoOperation("projects/p/locations/us-central1/publishers/google/models/veo/operations/1"),
      body: { done: true, response: { videos: [{ gcsUri: "gs://b/v.mp4", mimeType: "video/mp4" }], raiMediaFilteredCount: 0 } },
    },
  ],
};

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  setEngineDeployment({ redditUserAgent: FIXTURE_REDDIT_USER_AGENT, vertexProject: FIXTURE_GCP_PROJECT });
  mockGetAccessToken.mockResolvedValue("adc-token");
  x.setXTokenResolver(async () => "tok");
  reddit.setRedditTokenResolver(async () => "tok");
  pinterest.setPinterestTokenResolver(async () => "tok");
  // A fresh resolver clears linkedin.ts's cached organization urn.
  linkedin.setLinkedInTokenResolver(async () => "tok");
  threads.setThreadsCredentialsResolver(async () => ({ appSecret: "s", accessToken: "tok", userId: "u1" }));
  meta.setMetaCredentialsResolver(async () => ({ appSecret: "s", pageToken: "tok", pageId: "page-1", igUserId: "ig1" }));
  tiktok.setTikTokCredentialsResolver(async () => ({ accessToken: "tok", businessId: "biz", scopes: [] }));
  youtube.setYouTubeTokenResolver(async () => "tok");
  zernio.setZernioTokenResolver(async () => "tok");
});

afterEach(() => {
  x.setXTokenResolver(null);
  reddit.setRedditTokenResolver(null);
  pinterest.setPinterestTokenResolver(null);
  linkedin.setLinkedInTokenResolver(null);
  threads.setThreadsCredentialsResolver(null);
  meta.setMetaCredentialsResolver(null);
  tiktok.setTikTokCredentialsResolver(null);
  youtube.setYouTubeTokenResolver(null);
  zernio.setZernioTokenResolver(null);
  setEngineDeployment({});
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A 2xx with a raw body and headers, for the cases `respond` cannot shape. */
function raw(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status: 200, headers: { "content-type": "application/json", ...headers } });
}

describe("review follow-ups (PR #18)", () => {
  it("linkedin: per-post statistics with `elements: null` are unavailable ({}), never zero counters", async () => {
    fetchMock.mockResolvedValueOnce(respond(ORG_ACL)).mockResolvedValueOnce(respond({ elements: null }));
    await expect(linkedin.getPostShareStatistics("urn:li:share:1")).resolves.toEqual({});
  });

  it("linkedin: a reply whose body is not an object still returns the header's id: the comment exists", async () => {
    fetchMock
      .mockResolvedValueOnce(respond(ORG_ACL))
      .mockResolvedValueOnce(raw("null", { "x-restli-id": "urn:li:comment:(urn:li:activity:1,9)" }));
    await expect(
      linkedin.replyToComment({ postUrn: "urn:li:share:1", commentUrn: "urn:li:comment:(urn:li:activity:1,2)", text: "hi" }),
    ).resolves.toEqual({ commentUrn: "urn:li:comment:(urn:li:activity:1,9)" });
  });

  it("linkedin: with the header, a mistyped body commentUrn falls back to the header's id", async () => {
    fetchMock
      .mockResolvedValueOnce(respond(ORG_ACL))
      .mockResolvedValueOnce(raw('{"commentUrn":7}', { "x-restli-id": "urn:li:comment:(urn:li:activity:1,9)" }));
    await expect(
      linkedin.replyToComment({ postUrn: "urn:li:share:1", commentUrn: "urn:li:comment:(urn:li:activity:1,2)", text: "hi" }),
    ).resolves.toEqual({ commentUrn: "urn:li:comment:(urn:li:activity:1,9)" });
  });

  it("linkedin: without the header, a reply body that is not an object is still refused", async () => {
    fetchMock.mockResolvedValueOnce(respond(ORG_ACL)).mockResolvedValueOnce(raw("[1]"));
    await expect(
      linkedin.replyToComment({ postUrn: "urn:li:share:1", commentUrn: "urn:li:comment:(urn:li:activity:1,2)", text: "hi" }),
    ).rejects.toBeInstanceOf(ResponseShapeError);
  });

  it("pinterest: an empty link or board_id reads as absent, never as an empty URL or id", async () => {
    fetchMock.mockResolvedValueOnce(respond({ id: "p1", link: "", board_id: "", title: "" }));
    await expect(pinterest.getPin("p1")).resolves.toEqual({ id: "p1", link: undefined, title: "", boardId: undefined });
  });

  it("reddit: a rejection is reported as RedditApiError even when the data beside it is malformed", async () => {
    fetchMock.mockResolvedValueOnce(
      respond({ json: { errors: [["SUBMIT_VALIDATION_FLAIR_REQUIRED", "Choose flair", "flair_id"]], data: { id: 7 } } }),
    );
    const err = await reddit.submitPost({ subreddit: "test", title: "t", kind: "self", text: "b" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(reddit.RedditApiError);
    expect((err as reddit.RedditApiError).flairRequired).toBe(true);
  });

  it.each([
    ["threads media", () => threads.getMediaInsights("t1")],
    ["meta (Facebook post)", () => meta.getFacebookPostInsights("p_1")],
  ])("%s insights: a counter that is a string is refused; a breakdown object and a null stay absent", async (_label, call) => {
    fetchMock.mockResolvedValueOnce(respond({ data: [{ name: "views", values: [{ value: "7" }] }] }));
    await expect(call()).rejects.toThrow(/at data\[0\]\.values\[0\]\.value: expected a finite number or a breakdown object, got a string/);
    fetchMock.mockResolvedValueOnce(
      respond({ data: [{ name: "views", values: [{ value: 7 }] }, { name: "by_type", total_value: { value: { like: 1 } } }, { name: "x", values: [{ value: null }] }] }),
    );
    await expect(call()).resolves.toEqual({ views: 7 });
  });

  it("veo: an empty gcsUri is refused", async () => {
    fetchMock.mockResolvedValueOnce(respond({ done: true, response: { videos: [{ gcsUri: "" }] } }));
    await expect(
      veo.pollVideoOperation("projects/p/locations/us-central1/publishers/google/models/veo/operations/1"),
    ).rejects.toThrow(/at response\.videos\[0\]\.gcsUri: expected a non-empty string, got an empty string/);
  });

  it("x: a processing state outside the documented four is refused, not read as finished", async () => {
    fetchMock
      .mockResolvedValueOnce(respond({ data: { id: "m1" } }))
      .mockResolvedValueOnce(raw(""))
      .mockResolvedValueOnce(respond({ data: { id: "m1", processing_info: { state: "unexpected" } } }));
    await expect(x.uploadImage(new Uint8Array([1]) as Uint8Array<ArrayBuffer>, "image/png")).rejects.toThrow(
      /at data\.processing_info\.state: expected one of pending, in_progress, succeeded, failed, got a string/,
    );
  });

  it("x: processing_info with no state reads as finished, as before", async () => {
    fetchMock
      .mockResolvedValueOnce(respond({ data: { id: "m1" } }))
      .mockResolvedValueOnce(raw(""))
      .mockResolvedValueOnce(respond({ data: { id: "m1", processing_info: { check_after_secs: 1 } } }));
    await expect(x.uploadImage(new Uint8Array([1]) as Uint8Array<ArrayBuffer>, "image/png")).resolves.toBe("m1");
  });

  it("x: a public metric that is not a number is refused, not dropped; null stays absent and 0 is kept", async () => {
    fetchMock.mockResolvedValueOnce(respond({ data: { public_metrics: { like_count: "invalid" } } }));
    await expect(x.getTweetMetrics("1")).rejects.toThrow(/at data\.public_metrics\[\?\]: expected a finite number, got a string/);
    fetchMock.mockResolvedValueOnce(respond({ data: { public_metrics: { like_count: 0, quote_count: null } } }));
    await expect(x.getTweetMetrics("1")).resolves.toEqual({ like_count: 0 });
  });

  it("youtube: a columnType outside DIMENSION and METRIC is refused", async () => {
    fetchMock.mockResolvedValueOnce(respond({ columnHeaders: [{ name: "shares", columnType: "METRIK" }], rows: [[10]] }));
    await expect(youtube.getVideoAnalytics("v1", new Date(T0))).rejects.toThrow(
      /at columnHeaders\[0\]\.columnType: expected one of DIMENSION, METRIC, got a string/,
    );
  });

  it("zernio: an empty platformPostId, platformPostUrl or profileUrl reads as absent", async () => {
    fetchMock.mockResolvedValueOnce(
      respond({ post: { _id: "zp1", platforms: [{ platform: "reddit", status: "published", platformPostId: "", platformPostUrl: "" }] } }),
    );
    await expect(zernio.getPost("zp1")).resolves.toEqual({ _id: "zp1", platforms: [{ platform: "reddit", status: "published" }] });
    fetchMock.mockResolvedValueOnce(respond({ accounts: [{ _id: "a1", platform: "reddit", profileUrl: "" }] }));
    await expect(zernio.listAccounts()).resolves.toEqual([{ _id: "a1", platform: "reddit" }]);
  });

  it("zernio: analytics ignore a non-counter field beside the counters, and still refuse a mistyped counter", async () => {
    fetchMock.mockResolvedValueOnce(
      respond({ posts: [{ _id: "zp1", analytics: { likes: 5, metadata: { source: "cached" }, note: "x" } }] }),
    );
    await expect(zernio.getAnalytics()).resolves.toEqual({ posts: [{ _id: "zp1", analytics: { likes: 5 } }] });
    // An extra numeric key is kept as a counter, unless JSON's 1e999 made it Infinity.
    fetchMock.mockResolvedValueOnce(raw('{"posts":[{"_id":"zp1","analytics":{"likes":1,"newCounter":3,"huge":1e999}}]}'));
    await expect(zernio.getAnalytics()).resolves.toEqual({ posts: [{ _id: "zp1", analytics: { likes: 1, newCounter: 3 } }] });
    fetchMock.mockResolvedValueOnce(respond({ posts: [{ _id: "zp1", analytics: { likes: "5" } }] }));
    await expect(zernio.getAnalytics()).rejects.toThrow(/at posts\[0\]\.analytics\.likes: expected a finite number, got a string/);
  });
});

describe("refusals a field mutation does not reach", () => {
  it("zernio: a post or leg state outside the common few (partial, processing, cancelled) is read, not refused", async () => {
    fetchMock.mockResolvedValue(
      respond({ post: { _id: "zp1", status: "partial", platforms: [{ platform: "reddit", status: "processing" }, { platform: "x", status: "cancelled" }] } }),
    );
    await expect(zernio.getPost("zp1")).resolves.toEqual({
      _id: "zp1",
      status: "partial",
      platforms: [
        { platform: "reddit", status: "processing" },
        { platform: "x", status: "cancelled" },
      ],
    });
  });

  it("x: a delete answering deleted: false is refused, and an empty answer is a delete", async () => {
    fetchMock.mockResolvedValueOnce(respond({ data: { deleted: false } })).mockResolvedValueOnce(respond(""));
    await expect(x.deleteTweet("1")).rejects.toThrow(/DELETE \/tweets\/:id: unexpected response shape at data\.deleted: expected true, got a boolean/);
    await expect(x.deleteTweet("1")).resolves.toBeUndefined();
  });

  it("threads: a delete answering success: false is refused, because the caller would report success", async () => {
    fetchMock.mockResolvedValue(respond({ success: false }));
    await expect(threads.deleteThread("t1")).rejects.toThrow(/DELETE \/:media-id: unexpected response shape at success: expected true, got a boolean/);
  });

  it("tiktok: a refusal whose message is not a string still reports the code", async () => {
    fetchMock.mockResolvedValue(respond({ code: 40001, message: [SECRET], data: {} }));
    const err = await tiktok.getProfile().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(tiktok.TikTokError);
    expect((err as Error).message).toMatch(/TikTok refused the request \(code 40001\)/);
    expect((err as Error).message).not.toContain(SECRET);
  });

  it("meta: an `error` that is not an object still fails the call on its HTTP status", async () => {
    fetchMock.mockResolvedValue(respond({ error: SECRET }));
    const err = await meta.getFacebookFollowers().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(meta.MetaGraphError);
    expect((err as Error).message).toBe("Meta request failed with HTTP 200");
  });

  it("meta rupload: a 2xx body that is not an object is a failure, not a success", async () => {
    fetchMock.mockResolvedValue(respond([SECRET]));
    const err = await meta.ruploadHostedVideo("v1", "https://example.com/v.mp4", { accessToken: "tok", appSecret: "s" }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(meta.MetaGraphError);
    expect((err as Error).message).toMatch(/Reels upload for video v1 failed with HTTP 200/);
  });

  it("linkedin: a BATCH_GET status that is not a number is refused without naming the key", async () => {
    fetchMock.mockResolvedValue(respond({ statuses: { [SECRET]: "200" } }));
    const err = await linkedin.getPostsBatch(["urn:li:share:1"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResponseShapeError);
    expect((err as Error).message).toMatch(/at statuses\[\?\]: expected a finite number, got a string/);
    expect((err as Error).message).not.toContain(SECRET);
  });
});

for (const [client, endpoints] of Object.entries(ENDPOINTS)) {
  describe(`${client} responses`, () => {
    for (const e of endpoints) {
      describe(e.name, () => {
        it("reads the valid fixture", async () => {
          const result = await outcome(e, e.body);
          expect(result, JSON.stringify(result)).toEqual({ ok: true });
        });

        it("refuses or reads every hostile field cleanly, and never echoes it", async () => {
          for (const path of leafPaths(e.body)) {
            for (const [label, value] of HOSTILE) {
              const result = await outcome(e, withValue(e.body, path, value));
              if (!result.ok) expectCleanRefusal(result.err, `${path.join(".") || "(body)"} ${label}`, e.refusal);
            }
          }
        });

        for (const required of e.required ?? []) {
          it(`refuses ${required} when it is removed, null, or mistyped`, async () => {
            const path = required.split(".").map((k) => (/^\d+$/.test(k) ? Number(k) : k));
            const original = path.reduce<unknown>((node, k) => (node as Record<string | number, unknown>)[k], e.body);
            // A huge string is a string, and a value of the field's own type is not a mistype.
            for (const [label, value] of HOSTILE.filter(([l, v]) => l !== "a huge string" && typeof v !== typeof original)) {
              const result = await outcome(e, withValue(e.body, path, value));
              expect(result.ok, `${required} ${label} was accepted`).toBe(false);
              if (!result.ok) expectCleanRefusal(result.err, `${required} ${label}`, e.refusal);
            }
          });
        }
      });
    }
  });
}
