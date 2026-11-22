/**
 * The recent-posts reads behind the agent publish's crash check, and the window
 * rule that decides whether a read may answer "not sent". Every network call is
 * a stubbed fetch; nothing here reaches a vendor.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { graphTime, postsSince, windowCovers, type RecentPostsPage } from "../recent-posts.js";
import {
  listRecentInstagramMedia,
  listRecentPagePosts,
  listRecentPageReels,
  META_GRAPH_VERSION,
  RECENT_POSTS_LIMIT,
  setMetaCredentialsResolver,
} from "../meta-graph.js";
import { listRecentThreads, setThreadsCredentialsResolver } from "../threads.js";
import { listRecentTweets, setXTokenResolver } from "../x.js";
import { listRecentPins, setPinterestTokenResolver } from "../pinterest.js";

const SINCE = new Date("2026-11-08T05:00:00.000Z");

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let fetchMock: ReturnType<typeof vi.fn>;

function calledUrl(i = 0): URL {
  return new URL(String(fetchMock.mock.calls[i]![0]));
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  setMetaCredentialsResolver(null);
  setThreadsCredentialsResolver(null);
  setXTokenResolver(null);
  setPinterestTokenResolver(null);
});

describe("graphTime", () => {
  it("reads Graph's colon-less offset, and keeps null for nothing or nonsense", () => {
    expect(graphTime("2026-11-08T05:00:00+0000")).toBe("2026-11-08T05:00:00.000Z");
    expect(graphTime("2026-11-08T01:00:00-0400")).toBe("2026-11-08T05:00:00.000Z");
    expect(graphTime("2026-11-08T05:00:00Z")).toBe("2026-11-08T05:00:00.000Z");
    expect(graphTime(undefined)).toBeNull();
    expect(graphTime(null)).toBeNull();
    expect(graphTime("")).toBeNull();
    expect(graphTime("not a time")).toBeNull();
  });
});

describe("windowCovers and postsSince", () => {
  const post = (id: string, createdAt: string | null) => ({ id, texts: [], createdAt });

  it("covers the window when the platform had no more pages", () => {
    expect(windowCovers({ posts: [], more: false }, SINCE)).toBe(true);
  });

  it("with more pages, covers it only when the posts are newest first and reach past the start", () => {
    const reached: RecentPostsPage = {
      posts: [post("a", "2026-11-08T05:10:00Z"), post("b", "2026-11-08T04:00:00Z")],
      more: true,
    };
    expect(windowCovers(reached, SINCE)).toBe(true);
    // Every post is inside the window: the next page may hold more of it.
    expect(windowCovers({ posts: [post("a", "2026-11-08T05:10:00Z")], more: true }, SINCE)).toBe(false);
    // Out of order: the times prove nothing about the pages not read.
    expect(
      windowCovers({ posts: [post("b", "2026-11-08T04:00:00Z"), post("a", "2026-11-08T05:10:00Z")], more: true }, SINCE),
    ).toBe(false);
    // A post with no time is read as now, so it never proves the start was reached.
    expect(windowCovers({ posts: [post("a", null)], more: true }, SINCE)).toBe(false);
    expect(windowCovers({ posts: [], more: true }, SINCE)).toBe(false);
  });

  it("never covers a paged window from a list with NO documented order, however the times line up", () => {
    // Pinterest's GET /pins documents no order: a page that happens to read
    // newest first says nothing about what the unread pages hold.
    const looksOrdered: RecentPostsPage = {
      posts: [post("a", "2026-11-08T05:10:00Z"), post("b", "2026-11-08T04:00:00Z")],
      more: true,
      unordered: true,
    };
    expect(windowCovers(looksOrdered, SINCE)).toBe(false);
    // With no more pages, the whole list was read, order or not.
    expect(windowCovers({ ...looksOrdered, more: false }, SINCE)).toBe(true);
  });

  it("keeps the posts at or after the start, and any post with no time", () => {
    const page: RecentPostsPage = {
      posts: [post("new", "2026-11-08T05:00:00Z"), post("none", null), post("old", "2026-11-08T04:59:59Z")],
      more: false,
    };
    expect(postsSince(page, SINCE).map((p) => p.id)).toEqual(["new", "none"]);
  });
});

describe("Meta Graph reads", () => {
  beforeEach(() => {
    setMetaCredentialsResolver(async () => ({ appSecret: "s", pageToken: "t", pageId: "PAGE", igUserId: "IG" }));
  });

  it("published_posts: since as unix time, the post's message and permalink, and the next page flagged", async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        data: [
          { id: "PAGE_1", message: "Hello", created_time: "2026-11-08T05:01:00+0000", permalink_url: "https://fb/p/1" },
          { id: "PAGE_2", created_time: "2026-11-08T05:02:00+0000" },
          { message: "no id is skipped" },
        ],
        paging: { next: "https://graph/next" },
      }),
    );
    const page = await listRecentPagePosts(SINCE);
    const url = calledUrl();
    expect(url.pathname).toBe(`/${META_GRAPH_VERSION}/PAGE/published_posts`);
    expect(url.searchParams.get("since")).toBe(String(SINCE.getTime() / 1000));
    expect(url.searchParams.get("limit")).toBe(String(RECENT_POSTS_LIMIT));
    expect(url.searchParams.get("fields")).toBe("id,message,created_time,permalink_url");
    expect(page).toEqual({
      posts: [
        { id: "PAGE_1", texts: ["Hello"], createdAt: "2026-11-08T05:01:00.000Z", url: "https://fb/p/1" },
        { id: "PAGE_2", texts: [], createdAt: "2026-11-08T05:02:00.000Z" },
      ],
      more: true,
    });
  });

  it("video_reels: the ids come back as the transport's reel refs, and no data is an empty last page", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ data: [{ id: "V1", description: "A reel", created_time: "2026-11-08T05:03:00+0000" }] }),
    );
    expect(await listRecentPageReels()).toEqual({
      posts: [{ id: "reel:V1", texts: ["A reel"], createdAt: "2026-11-08T05:03:00.000Z" }],
      more: false,
    });
    expect(calledUrl().pathname).toBe(`/${META_GRAPH_VERSION}/PAGE/video_reels`);
    fetchMock.mockResolvedValueOnce(json({}));
    expect(await listRecentPageReels()).toEqual({ posts: [], more: false });
  });

  it("instagram media: caption, timestamp and permalink", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ data: [{ id: "M1", caption: "Cap", timestamp: "2026-11-08T05:04:00+0000", permalink: "https://ig/p/x" }] }),
    );
    expect(await listRecentInstagramMedia()).toEqual({
      posts: [{ id: "M1", texts: ["Cap"], createdAt: "2026-11-08T05:04:00.000Z", url: "https://ig/p/x" }],
      more: false,
    });
    expect(calledUrl().pathname).toBe(`/${META_GRAPH_VERSION}/IG/media`);
  });

  it("instagram media refuses before any call when no account is linked", async () => {
    setMetaCredentialsResolver(async () => ({ appSecret: "s", pageToken: "t", pageId: "PAGE" }));
    await expect(listRecentInstagramMedia()).rejects.toThrow(/no Instagram account/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a Graph error throws, never an empty page", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { message: "(#10) permission", code: 10 } }, 403));
    await expect(listRecentPagePosts(SINCE)).rejects.toThrow(/permission/);
  });
});

describe("Threads read", () => {
  beforeEach(() => {
    setThreadsCredentialsResolver(async () => ({ appSecret: "s", accessToken: "t", userId: "TU" }));
  });

  it("the user's own threads since the start, text and permalink", async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        data: [
          { id: "T1", text: "Root", timestamp: "2026-11-08T05:05:00+0000", permalink: "https://threads/p/1" },
          { id: "T2", timestamp: "2026-11-08T05:06:00+0000" },
          { text: "no id" },
        ],
        paging: { next: "n" },
      }),
    );
    const page = await listRecentThreads(SINCE);
    const url = calledUrl();
    expect(url.pathname).toBe("/v1.0/TU/threads");
    expect(url.searchParams.get("since")).toBe(String(SINCE.getTime() / 1000));
    expect(url.searchParams.get("fields")).toBe("id,text,timestamp,permalink");
    expect(page).toEqual({
      posts: [
        { id: "T1", texts: ["Root"], createdAt: "2026-11-08T05:05:00.000Z", url: "https://threads/p/1" },
        { id: "T2", texts: [], createdAt: "2026-11-08T05:06:00.000Z" },
      ],
      more: true,
    });
    fetchMock.mockResolvedValueOnce(json({}));
    expect(await listRecentThreads(SINCE)).toEqual({ posts: [], more: false });
  });
});

describe("X read", () => {
  beforeEach(() => {
    setXTokenResolver(async () => "x-token");
  });

  it("the account's roots since the start, the long text first, and next_token flagged", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ data: { id: "U1", username: "examplebrand" } }))
      .mockResolvedValueOnce(
        json({
          data: [
            { id: "1", text: "Short…", note_tweet: { text: "Short and then the rest" }, created_at: "2026-11-08T05:07:00.000Z" },
            { id: "2", text: "Plain" },
          ],
          meta: { next_token: "nt" },
        }),
      );
    const page = await listRecentTweets(SINCE);
    const url = calledUrl(1);
    expect(url.pathname).toBe("/2/users/U1/tweets");
    expect(url.searchParams.get("start_time")).toBe(SINCE.toISOString());
    expect(url.searchParams.get("exclude")).toBe("replies,retweets");
    expect(url.searchParams.get("tweet.fields")).toBe("created_at,note_tweet");
    expect(page).toEqual({
      posts: [
        { id: "1", texts: ["Short and then the rest", "Short…"], createdAt: "2026-11-08T05:07:00.000Z" },
        { id: "2", texts: ["Plain"], createdAt: null },
      ],
      more: true,
    });
  });

  it("no posts in the window is an empty last page", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ data: { id: "U1", username: "examplebrand" } }))
      .mockResolvedValueOnce(json({ meta: { result_count: 0 } }));
    expect(await listRecentTweets(SINCE)).toEqual({ posts: [], more: false });
  });
});

describe("Pinterest read", () => {
  beforeEach(() => {
    setPinterestTokenResolver(async () => "p-token");
  });

  it("the account's pins: description then title, created_at read as UTC, the bookmark flagged", async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        items: [
          { id: "P1", description: "Desc", title: "Title", created_at: "2026-11-08T05:08:00" },
          { id: "P2", title: null, description: null, created_at: "2026-11-08T05:09:00+00:00" },
          { id: "P3", created_at: "garbage" },
          { id: "P4" },
        ],
        bookmark: "bm",
      }),
    );
    const page = await listRecentPins();
    expect(calledUrl().pathname).toMatch(/\/pins$/);
    expect(calledUrl().searchParams.get("page_size")).toBe("25");
    expect(page).toEqual({
      posts: [
        { id: "P1", texts: ["Desc", "Title"], createdAt: "2026-11-08T05:08:00.000Z" },
        { id: "P2", texts: [], createdAt: "2026-11-08T05:09:00.000Z" },
        { id: "P3", texts: [], createdAt: null },
        { id: "P4", texts: [], createdAt: null },
      ],
      more: true,
      unordered: true,
    });
    fetchMock.mockResolvedValueOnce(json({ bookmark: null }));
    expect(await listRecentPins()).toEqual({ posts: [], more: false, unordered: true });
  });
});
