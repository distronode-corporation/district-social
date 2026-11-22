/**
 * The LinkedIn Community Management API calls: Page comments read and
 * reply, time-bound follower and share statistics, the single-post GET the
 * Development tier's no-BATCH_GET rule needs, the write guard that keeps a
 * read-only grant from publishing, and the one log line per call the
 * Standard-tier review asks for.
 *
 * Every response shape below is transcribed from the li-lms-2026-10 pages
 * (comments-api, follower-statistics, share-statistics, posts-api). No real
 * LinkedIn call is made: fetch is mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  LINKEDIN_VERSION,
  LINKEDIN_WINDOW_SUMMABLE_FIELDS,
  LinkedInError,
  assertLinkedInToken,
  createPost,
  deletePost,
  encodeUrnPathSegment,
  getComments,
  getFollowerGains,
  getPost,
  getShareStatisticsWindow,
  getSocialActions,
  initializeImageUpload,
  linkedInCommentPermalink,
  linkedInStatsWindow,
  listOrganizationPosts,
  logLinkedInCall,
  parseLinkedInCommentPermalink,
  replyToComment,
  setLinkedInCallSink,
  setLinkedInOrganizationId,
  setLinkedInTokenResolver,
  setLinkedInWriteGuard,
  uploadImageBytes,
  withLinkedInCallContext,
  withLinkedInCallLog,
  type LinkedInCallRecord,
  type LinkedInLedgerRecord,
} from "../linkedin.js";
import { FIXTURE_LINKEDIN_ORG, FIXTURE_LINKEDIN_ORG_URN, FIXTURE_LINKEDIN_POST_ID_2, FIXTURE_LINKEDIN_UGC_URN } from "./helpers/fixtures.js";
import { ResponseShapeError } from "../http/shape.js";

const TOKEN = "SECRET-ACCESS-TOKEN-abcdefghijklmnopqrstuvwxyz0123456789";
const ORG = FIXTURE_LINKEDIN_ORG_URN;
const POST = "urn:li:share:7380000000000000001";
const COMMENT = "urn:li:comment:(urn:li:activity:7380000000000000000,7380000000000000999)";

function response(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
    headers: new Headers(headers),
  } as unknown as Response;
}

const fetchMock = () => fetch as unknown as ReturnType<typeof vi.fn>;
const calledUrls = () => fetchMock().mock.calls.map((c) => String(c[0]));
const calledInit = (i: number) => fetchMock().mock.calls[i][1] as RequestInit & { headers: Record<string, string> };

let info: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  setLinkedInTokenResolver(async () => TOKEN);
  setLinkedInOrganizationId(FIXTURE_LINKEDIN_ORG);
  setLinkedInWriteGuard(null);
  info = vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  setLinkedInCallSink(null);
  setLinkedInTokenResolver(null);
  setLinkedInOrganizationId(null);
  setLinkedInWriteGuard(null);
  vi.unstubAllGlobals();
  info.mockRestore();
});

const logLines = () => info.mock.calls.map((c: unknown[]) => String(c[0])).filter((l: string) => l.startsWith("[linkedin-api]"));

describe("the version pin", () => {
  it("is 202610, the li-lms-2026-10 moniker every CMA page documents", () => {
    expect(LINKEDIN_VERSION).toBe("202610");
  });
});

describe("one log line per LinkedIn call", () => {
  const LINE = /^\[linkedin-api\] \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z [A-Z]+ \S+ status=(\d{3}|none) x-li-uuid=\S+$/;

  it("logs UTC time, method, the PATH only, status and x-li-uuid", async () => {
    fetchMock().mockResolvedValue(response(200, { elements: [] }, { "x-li-uuid": "AAYxyz123" }));
    await getComments(POST);

    const [line] = logLines();
    expect(line).toMatch(LINE);
    expect(line).toContain(`GET /rest/socialActions/${encodeURIComponent(POST)}/comments status=200 x-li-uuid=AAYxyz123`);
    // The query (start/count here; an author or a window elsewhere) is cut off whole.
    expect(line).not.toContain("?");
    expect(line).not.toContain("count=");
  });

  it("⛔ never carries the token, the Authorization header, or a request body", async () => {
    fetchMock().mockResolvedValue(response(201, { commentUrn: "urn:li:comment:(urn:li:activity:1,2)" }));
    await replyToComment({ postUrn: POST, commentUrn: COMMENT, text: "PRIVATE-REPLY-TEXT" });

    // The token really was sent, so its absence from the line means something.
    expect(calledInit(0).headers.Authorization).toBe(`Bearer ${TOKEN}`);
    const lines = logLines();
    expect(lines).toHaveLength(1);
    for (const forbidden of [TOKEN, "Bearer", "Authorization", "PRIVATE-REPLY-TEXT"]) {
      expect(lines[0]).not.toContain(forbidden);
    }
  });

  it("writes `-` when LinkedIn sends no x-li-uuid", async () => {
    fetchMock().mockResolvedValue(response(404, { message: "Not Found" }));
    await expect(getPost(POST)).rejects.toThrow(LinkedInError);
    expect(logLines()[0]).toMatch(/status=404 x-li-uuid=-$/);
  });

  it("logs a call that got no response as status=none, and still throws the LinkedInError", async () => {
    fetchMock().mockRejectedValue(new Error("ECONNRESET"));
    await expect(getPost(POST)).rejects.toThrow(LinkedInError);
    expect(logLines()[0]).toMatch(LINE);
    expect(logLines()[0]).toMatch(/GET \/rest\/posts\/\S+ status=none x-li-uuid=-$/);
  });

  it("⛔ logs an image upload WITHOUT its pre-signed URL, whose query is a credential", async () => {
    const signed = "https://www.linkedin.com/dms-uploads/abc?sig=SIGNED-CREDENTIAL";
    fetchMock().mockResolvedValue(response(201, undefined, { "x-li-uuid": "up-1" }));
    await uploadImageBytes(signed, new Uint8Array([1]), "image/png");
    expect(logLines()[0]).toMatch(/PUT \(image upload URL\) status=201 x-li-uuid=up-1$/);
    expect(logLines()[0]).not.toContain("SIGNED-CREDENTIAL");
    expect(logLines()[0]).not.toContain("dms-uploads");
  });

  it("logs an upload that got no response as status=none", async () => {
    fetchMock().mockRejectedValue(new Error("socket hang up"));
    await expect(uploadImageBytes("https://www.linkedin.com/dms-uploads/abc", new Uint8Array([1]), "image/png")).rejects.toThrow(
      LinkedInError,
    );
    expect(logLines()[0]).toMatch(/PUT \(image upload URL\) status=none x-li-uuid=-$/);
  });

  it("cuts a fragment off a path handed to it directly, and upper-cases the method", () => {
    logLinkedInCall({ method: "post", path: "/oauth/v2/accessToken#frag", status: 400, liUuid: "" });
    expect(logLines()[0]).toMatch(/ POST \/oauth\/v2\/accessToken status=400 x-li-uuid=-$/);
  });
});

describe("withLinkedInCallLog (the agent publish's evidence)", () => {
  it("keeps every call made inside it, in order, with the log line's fields", async () => {
    fetchMock()
      .mockResolvedValueOnce(response(200, { elements: [] }, { "x-li-uuid": "first" }))
      .mockResolvedValueOnce(response(404, { message: "Not Found" }));
    const calls: LinkedInCallRecord[] = [];
    await withLinkedInCallLog(calls, async () => {
      await getComments(POST);
      await expect(getPost(POST)).rejects.toThrow(LinkedInError);
    });
    expect(calls).toEqual([
      { at: expect.stringMatching(/Z$/), method: "GET", path: `/rest/socialActions/${encodeURIComponent(POST)}/comments`, status: 200, liUuid: "first" },
      { at: expect.stringMatching(/Z$/), method: "GET", path: `/rest/posts/${encodeURIComponent(POST)}`, status: 404, liUuid: null },
    ]);
    // The record carries the same time as its line.
    expect(logLines()[0]).toContain(calls[0]!.at);
  });

  it("keeps the calls made before a throw, and nothing outside its scope", async () => {
    fetchMock().mockRejectedValue(new Error("ECONNRESET"));
    const calls: LinkedInCallRecord[] = [];
    await expect(withLinkedInCallLog(calls, () => getPost(POST))).rejects.toThrow(LinkedInError);
    logLinkedInCall({ method: "GET", path: "/rest/outside", status: 200, liUuid: "x" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ status: null, liUuid: null });
  });

  it("gives two concurrent scopes their own calls", async () => {
    const a: LinkedInCallRecord[] = [];
    const b: LinkedInCallRecord[] = [];
    await Promise.all([
      withLinkedInCallLog(a, async () => {
        await Promise.resolve();
        logLinkedInCall({ method: "POST", path: "/rest/posts", status: 201, liUuid: "a" });
      }),
      withLinkedInCallLog(b, async () => {
        logLinkedInCall({ method: "POST", path: "/rest/posts", status: 201, liUuid: "b" });
      }),
    ]);
    expect(a.map((c) => c.liUuid)).toEqual(["a"]);
    expect(b.map((c) => c.liUuid)).toEqual(["b"]);
  });
});

describe("the write guard", () => {
  it("⛔ refuses a post, an image upload, a delete and a reply BEFORE anything is sent", async () => {
    const guard = vi.fn(async (kind: string) => {
      throw new Error(`refused ${kind}`);
    });
    setLinkedInWriteGuard(guard);

    await expect(createPost({ commentary: "x" })).rejects.toThrow("refused post");
    await expect(initializeImageUpload()).rejects.toThrow("refused post");
    await expect(deletePost(POST)).rejects.toThrow("refused post");
    await expect(replyToComment({ postUrn: POST, commentUrn: COMMENT, text: "hi" })).rejects.toThrow("refused comment");
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it("resolves the token BEFORE asking the guard, so a seed adoption has written the row", async () => {
    const order: string[] = [];
    setLinkedInTokenResolver(async () => {
      order.push("token");
      return TOKEN;
    });
    setLinkedInWriteGuard(async () => {
      order.push("guard");
    });
    fetchMock().mockResolvedValue(response(204, undefined));
    await deletePost(POST);
    expect(order.slice(0, 2)).toEqual(["token", "guard"]);
  });

  it("lets a write through when the guard allows it, and when none is registered", async () => {
    setLinkedInWriteGuard(async () => {});
    fetchMock().mockResolvedValue(response(204, undefined));
    await expect(deletePost(POST)).resolves.toBeUndefined();
    setLinkedInWriteGuard(null);
    await expect(deletePost(POST)).resolves.toBeUndefined();
  });

  it("assertLinkedInToken surfaces a resolver's refusal and costs no call", async () => {
    setLinkedInTokenResolver(async () => {
      throw new Error("linkedin needs re-consent");
    });
    await expect(assertLinkedInToken()).rejects.toThrow("re-consent");
    setLinkedInTokenResolver(async () => TOKEN);
    await expect(assertLinkedInToken()).resolves.toBeUndefined();
    expect(fetchMock()).not.toHaveBeenCalled();
  });
});

describe("getPost (the Development tier's stand-in for BATCH_GET)", () => {
  it("GETs one encoded post urn and answers true", async () => {
    fetchMock().mockResolvedValue(response(200, { id: POST, lifecycleState: "PUBLISHED" }));
    await expect(getPost(POST)).resolves.toBe(true);
    expect(calledUrls()[0]).toBe(`https://api.linkedin.com/rest/posts/${encodeURIComponent(POST)}`);
  });

  it("surfaces LinkedIn's 404 as a LinkedInError carrying the status", async () => {
    fetchMock().mockResolvedValue(response(404, { message: "NOT_FOUND" }));
    const err = await getPost(POST).catch((e: unknown) => e);
    expect((err as LinkedInError).status).toBe(404);
  });
});

describe("listOrganizationPosts", () => {
  it("uses the author FINDER, newest created first, and maps the documented elements", async () => {
    fetchMock().mockResolvedValue(
      response(200, {
        paging: { start: 0, count: 10, links: [] },
        elements: [
          { id: POST, commentary: "Launch day", createdAt: 1700000000000, publishedAt: 1700000000500 },
          { id: "urn:li:ugcPost:2", publishedAt: 1690000000000 },
          { id: "urn:li:share:3", commentary: null, createdAt: null },
        ],
      }),
    );
    const posts = await listOrganizationPosts(10);
    expect(posts).toEqual([
      { id: POST, commentary: "Launch day", createdAt: 1700000000000 },
      { id: "urn:li:ugcPost:2", commentary: "", createdAt: 1690000000000 },
      { id: "urn:li:share:3", commentary: "", createdAt: 0 },
    ]);
    const url = calledUrls()[0];
    expect(url).toBe(
      `https://api.linkedin.com/rest/posts?author=${encodeURIComponent(ORG)}&q=author&count=10&sortBy=CREATED`,
    );
    expect(calledInit(0).headers["X-RestLi-Method"]).toBe("FINDER");
  });

  it.each([
    ["a numeric commentary", { id: POST, commentary: 42 }, /elements\[0\]\.commentary: expected a string, got a number/],
    ["a createdAt that is a string", { id: POST, createdAt: "yesterday" }, /elements\[0\]\.createdAt: expected a finite number, got a string/],
    ["an empty id", { id: "", commentary: "no id" }, /elements\[0\]\.id: expected a non-empty string, got an empty string/],
    ["no id at all", { commentary: "no id at all" }, /elements\[0\]\.id: expected a non-empty string, got missing/],
  ])("refuses an element with %s", async (_label, element, why) => {
    fetchMock().mockResolvedValue(response(200, { elements: [element] }));
    const err = await listOrganizationPosts(10).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResponseShapeError);
    expect((err as Error).message).toMatch(why);
  });

  it("clamps count to LinkedIn's 1..100", async () => {
    fetchMock().mockResolvedValue(response(200, { elements: [] }));
    await listOrganizationPosts(500);
    await listOrganizationPosts(0);
    expect(calledUrls()[0]).toContain("count=100");
    expect(calledUrls()[1]).toContain("count=1&");
  });

  it("reads a body with no elements as no posts", async () => {
    fetchMock().mockResolvedValue(response(200, undefined));
    await expect(listOrganizationPosts(5)).resolves.toEqual([]);
  });
});

describe("getComments", () => {
  function comment(id: number, over: Record<string, unknown> = {}) {
    return {
      actor: "urn:li:person:EXAMPLE001",
      commentUrn: `urn:li:comment:(urn:li:activity:7380000000000000000,${id})`,
      created: { actor: "urn:li:person:EXAMPLE001", time: 1700000000000 + id },
      id: String(id),
      message: { attributes: [], text: `comment ${id}` },
      object: "urn:li:activity:7380000000000000000",
      ...over,
    };
  }

  it("maps the documented element shape", async () => {
    fetchMock().mockResolvedValue(
      response(200, { elements: [comment(1), comment(2, { parentComment: COMMENT })], paging: { start: 0, count: 50 } }),
    );
    const out = await getComments(POST);
    expect(out).toEqual([
      {
        commentUrn: "urn:li:comment:(urn:li:activity:7380000000000000000,1)",
        actor: "urn:li:person:EXAMPLE001",
        text: "comment 1",
        createdAt: 1700000000001,
      },
      {
        commentUrn: "urn:li:comment:(urn:li:activity:7380000000000000000,2)",
        actor: "urn:li:person:EXAMPLE001",
        text: "comment 2",
        createdAt: 1700000000002,
        parentComment: COMMENT,
      },
    ]);
    expect(calledUrls()[0]).toBe(
      `https://api.linkedin.com/rest/socialActions/${encodeURIComponent(POST)}/comments?start=0&count=50`,
    );
  });

  it("answers an empty list for a post nobody has commented on", async () => {
    fetchMock().mockResolvedValue(response(200, { elements: [], paging: { start: 0, count: 50, total: 0 } }));
    await expect(getComments(POST, { maxPages: 3 })).resolves.toEqual([]);
    expect(fetchMock()).toHaveBeenCalledTimes(1);
  });

  it("reads an empty body as no comments", async () => {
    fetchMock().mockResolvedValue(response(200, undefined));
    await expect(getComments(POST)).resolves.toEqual([]);
  });

  it("skips an element with no words, and tolerates missing actor and time", async () => {
    fetchMock().mockResolvedValue(
      response(200, {
        elements: [
          comment(2, { message: { text: "   " } }),
          comment(3, { message: undefined }),
          comment(4, { actor: undefined, created: undefined }),
        ],
      }),
    );
    const out = await getComments(POST);
    expect(out).toEqual([
      { commentUrn: "urn:li:comment:(urn:li:activity:7380000000000000000,4)", actor: "", text: "comment 4", createdAt: 0 },
    ]);
  });

  it.each([
    ["no comment urn", { commentUrn: undefined }, /elements\[0\]\.commentUrn: expected a non-empty string, got missing/],
    ["a numeric actor", { actor: 7 }, /elements\[0\]\.actor: expected a string, got a number/],
    ["a message that is a string", { message: "hi" }, /elements\[0\]\.message: expected an object, got a string/],
    ["a time that is a string", { created: { time: "now" } }, /elements\[0\]\.created\.time: expected a finite number, got a string/],
  ])("refuses a comment with %s", async (_label, over, why) => {
    fetchMock().mockResolvedValue(response(200, { elements: [comment(1, over)] }));
    const err = await getComments(POST).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResponseShapeError);
    expect((err as Error).message).toMatch(why);
  });

  it("pages on start/count while pages come back full and paging.total says there is more", async () => {
    fetchMock()
      .mockResolvedValueOnce(response(200, { elements: [comment(1), comment(2)], paging: { start: 0, count: 2, total: 5 } }))
      .mockResolvedValueOnce(response(200, { elements: [comment(3), comment(4)], paging: { start: 2, count: 2, total: 5 } }))
      .mockResolvedValueOnce(response(200, { elements: [comment(5)], paging: { start: 4, count: 2, total: 5 } }));
    const out = await getComments(POST, { pageSize: 2, maxPages: 10 });
    expect(out.map((c) => c.text)).toEqual(["comment 1", "comment 2", "comment 3", "comment 4", "comment 5"]);
    expect(calledUrls().map((u) => new URL(u).searchParams.get("start"))).toEqual(["0", "2", "4"]);
  });

  it("stops when paging.total is reached even on a full page", async () => {
    fetchMock().mockResolvedValue(response(200, { elements: [comment(1), comment(2)], paging: { total: 2 } }));
    await getComments(POST, { pageSize: 2, maxPages: 5 });
    expect(fetchMock()).toHaveBeenCalledTimes(1);
  });

  it("keeps paging on a full page with no total, up to maxPages and no further", async () => {
    fetchMock().mockResolvedValue(response(200, { elements: [comment(1), comment(2)] }));
    const out = await getComments(POST, { pageSize: 2, maxPages: 3 });
    expect(fetchMock()).toHaveBeenCalledTimes(3);
    expect(out).toHaveLength(6);
  });

  it("clamps a hostile page size and page count", async () => {
    fetchMock().mockResolvedValue(response(200, { elements: [] }));
    await getComments(POST, { pageSize: 10_000, maxPages: 0 });
    expect(calledUrls()[0]).toContain("count=100");
    expect(fetchMock()).toHaveBeenCalledTimes(1);
  });

  it("surfaces a 403 for a missing scope as a LinkedInError carrying 403", async () => {
    fetchMock().mockResolvedValue(response(403, { status: 403, serviceErrorCode: 100, message: "ACCESS_DENIED" }));
    const err = await getComments(POST).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LinkedInError);
    expect((err as LinkedInError).status).toBe(403);
  });
});

describe("replyToComment", () => {
  it("POSTs a nested comment as the organization, to the parent comment's thread", async () => {
    fetchMock().mockResolvedValue(
      response(201, { commentUrn: "urn:li:comment:(urn:li:activity:7380000000000000000,555)" }, { "x-restli-id": "555" }),
    );
    const out = await replyToComment({ postUrn: POST, commentUrn: COMMENT, text: "Thanks for asking!" });

    expect(out).toEqual({ commentUrn: "urn:li:comment:(urn:li:activity:7380000000000000000,555)" });
    expect(calledUrls()[0]).toBe(
      "https://api.linkedin.com/rest/socialActions/" +
        "urn%3Ali%3Acomment%3A%28urn%3Ali%3Aactivity%3A7380000000000000000%2C7380000000000000999%29/comments",
    );
    const init = calledInit(0);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      actor: ORG,
      object: POST,
      message: { text: "Thanks for asking!" },
      parentComment: COMMENT,
    });
    expect(init.headers["LinkedIn-Version"]).toBe("202610");
  });

  it("falls back to the x-restli-id header, then to null, when the body names no urn", async () => {
    fetchMock().mockResolvedValueOnce(response(201, {}, { "x-restli-id": "777" }));
    await expect(replyToComment({ postUrn: POST, commentUrn: COMMENT, text: "a" })).resolves.toEqual({
      commentUrn: "777",
    });
    fetchMock().mockResolvedValueOnce(response(201, undefined));
    await expect(replyToComment({ postUrn: POST, commentUrn: COMMENT, text: "a" })).resolves.toEqual({
      commentUrn: null,
    });
  });

  it("surfaces LinkedIn's per-minute create throttle as a 429 LinkedInError", async () => {
    fetchMock().mockResolvedValue(response(429, { message: "Comment create throttled" }, { "retry-after": "60" }));
    const err = await replyToComment({ postUrn: POST, commentUrn: COMMENT, text: "a" }).catch((e: unknown) => e);
    expect((err as LinkedInError).status).toBe(429);
    expect((err as LinkedInError).retryAfter).toBe("60");
  });
});

describe("comment permalinks", () => {
  it("round-trips a post and comment urn through the permalink", () => {
    const url = linkedInCommentPermalink(POST, COMMENT);
    expect(url).toBe(`https://www.linkedin.com/feed/update/${POST}/?commentUrn=${encodeURIComponent(COMMENT)}`);
    expect(parseLinkedInCommentPermalink(url)).toEqual({ postUrn: POST, commentUrn: COMMENT });
    const ugc = linkedInCommentPermalink("urn:li:ugcPost:12", COMMENT);
    expect(parseLinkedInCommentPermalink(ugc)).toEqual({ postUrn: "urn:li:ugcPost:12", commentUrn: COMMENT });
  });

  it.each([
    ["another host", `https://evil.example/feed/update/${POST}/?commentUrn=${encodeURIComponent(COMMENT)}`],
    ["a non-post urn", `https://www.linkedin.com/feed/update/urn:li:activity:1/?commentUrn=${encodeURIComponent(COMMENT)}`],
    ["no comment", `https://www.linkedin.com/feed/update/${POST}/`],
    ["an extra parameter", `https://www.linkedin.com/feed/update/${POST}/?commentUrn=${encodeURIComponent(COMMENT)}&x=1`],
    ["broken percent-encoding", `https://www.linkedin.com/feed/update/${POST}/?commentUrn=%E0%A4%A`],
    ["a comment urn of the wrong shape", `https://www.linkedin.com/feed/update/${POST}/?commentUrn=urn%3Ali%3Acomment%3A1`],
    ["a Reddit thread", "https://www.reddit.com/r/smallbusiness/comments/abc/"],
  ])("refuses %s", (_label, url) => {
    expect(parseLinkedInCommentPermalink(url)).toBeNull();
  });
});

describe("time-bound statistics", () => {
  const NOW = new Date("2026-10-28T17:42:00Z");
  const DAY = 86_400_000;

  it("windows the newest reportable whole UTC days, ending two days before today", () => {
    const w = linkedInStatsWindow(NOW, 7);
    expect(new Date(w.end).toISOString()).toBe("2026-10-27T00:00:00.000Z");
    expect(new Date(w.start).toISOString()).toBe("2026-10-20T00:00:00.000Z");
    expect(linkedInStatsWindow(NOW, 0).end - linkedInStatsWindow(NOW, 0).start).toBe(DAY);
  });

  it("sums the daily follower gains under LinkedIn's names, with the Rest.li 2.0 window", async () => {
    fetchMock().mockResolvedValue(
      response(200, {
        paging: { count: 10, start: 0 },
        elements: [
          { timeRange: { start: 1, end: 2 }, followerGains: { organicFollowerGain: 223, paidFollowerGain: 12 } },
          { timeRange: { start: 2, end: 3 }, followerGains: { organicFollowerGain: -1, paidFollowerGain: 2 } },
          { timeRange: { start: 3, end: 4 } },
          { followerGains: { organicFollowerGain: "9" } },
        ],
      }),
    );
    const w = linkedInStatsWindow(NOW, 7);
    await expect(getFollowerGains(w)).resolves.toEqual({ organicFollowerGain: 222, paidFollowerGain: 14 });
    expect(calledUrls()[0]).toBe(
      "https://api.linkedin.com/rest/organizationalEntityFollowerStatistics?q=organizationalEntity" +
        `&organizationalEntity=${encodeURIComponent(ORG)}` +
        `&timeIntervals=(timeRange:(start:${w.start},end:${w.end}),timeGranularityType:DAY)`,
    );
  });

  it("reports zero gains for a quiet week LinkedIn answered with no days", async () => {
    fetchMock().mockResolvedValue(response(200, { elements: [] }));
    await expect(getFollowerGains(linkedInStatsWindow(NOW, 7))).resolves.toEqual({
      organicFollowerGain: 0,
      paidFollowerGain: 0,
    });
  });

  it("⛔ refuses to report 0 new followers from a body with no elements array", async () => {
    fetchMock().mockResolvedValue(response(200, {}));
    await expect(getFollowerGains(linkedInStatsWindow(NOW, 7))).rejects.toThrow(/refusing to report 0/);
  });

  it("⛔ reads `elements: null` as no elements array too, for both windowed reads", async () => {
    fetchMock().mockImplementation(async () => response(200, { elements: null }));
    await expect(getFollowerGains(linkedInStatsWindow(NOW, 7))).rejects.toThrow(/refusing to report 0 new followers/);
    await expect(getShareStatisticsWindow(linkedInStatsWindow(NOW, 7))).rejects.toThrow(/refusing to report 0 activity/);
  });

  it("sums only the share counters that add across days, and only those reported", async () => {
    fetchMock().mockResolvedValue(
      response(200, {
        elements: [
          {
            timeRange: { start: 1, end: 2 },
            totalShareStatistics: { impressionCount: 331, clickCount: 3, engagement: 0.5, uniqueImpressionsCount: 203 },
          },
          { timeRange: { start: 2, end: 3 }, totalShareStatistics: { impressionCount: 9, clickCount: 1, likeCount: -1 } },
          { timeRange: { start: 3, end: 4 } },
        ],
      }),
    );
    const w = linkedInStatsWindow(NOW, 7);
    await expect(getShareStatisticsWindow(w)).resolves.toEqual({ impressionCount: 340, clickCount: 4, likeCount: -1 });
    expect(calledUrls()[0]).toContain("/organizationalEntityShareStatistics?q=organizationalEntity");
    expect(calledUrls()[0]).toContain(`timeIntervals=(timeRange:(start:${w.start},end:${w.end}),timeGranularityType:DAY)`);
    expect(LINKEDIN_WINDOW_SUMMABLE_FIELDS).not.toContain("engagement");
    expect(LINKEDIN_WINDOW_SUMMABLE_FIELDS).not.toContain("uniqueImpressionsCount");
  });

  it("⛔ refuses to report 0 activity from a body with no elements array", async () => {
    fetchMock().mockResolvedValue(response(200, undefined));
    await expect(getShareStatisticsWindow(linkedInStatsWindow(NOW, 7))).rejects.toThrow(/refusing to report 0/);
  });
});

describe("the call ledger: setLinkedInCallSink and withLinkedInCallContext", () => {
  const AT = expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  let error: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    error = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => error.mockRestore());

  function ledger() {
    const rows: LinkedInLedgerRecord[] = [];
    setLinkedInCallSink((r) => {
      rows.push(r);
    });
    return rows;
  }

  it("gets every field for a real request() call, tagged by the context it ran in", async () => {
    const rows = ledger();
    fetchMock().mockResolvedValue(response(200, { id: POST }, { "x-li-uuid": "AAY-req" }));
    await withLinkedInCallContext({ context: "agent", draftId: "d1" }, () => getPost(POST));
    expect(rows).toEqual([
      { at: AT, method: "GET", path: `/rest/posts/${encodeURIComponent(POST)}`, status: 200, liUuid: "AAY-req", context: "agent", draftId: "d1" },
    ]);
    expect(logLines()[0]).toContain(rows[0]!.at);
  });

  it("records a call that got no response as status null, and an untagged call with context and draftId null", async () => {
    const rows = ledger();
    fetchMock().mockRejectedValue(new Error("ECONNRESET"));
    await expect(getPost(POST)).rejects.toThrow(LinkedInError);
    expect(rows).toEqual([
      { at: AT, method: "GET", path: `/rest/posts/${encodeURIComponent(POST)}`, status: null, liUuid: null, context: null, draftId: null },
    ]);
  });

  it("records an image upload under its fixed label, and a context given no draft as draftId null", async () => {
    const rows = ledger();
    fetchMock().mockResolvedValue(response(201, undefined, { "x-li-uuid": "up-9" }));
    await withLinkedInCallContext({ context: "ring" }, () =>
      uploadImageBytes("https://www.linkedin.com/dms-uploads/abc?sig=SIGNED", new Uint8Array([1]), "image/png"),
    );
    expect(rows).toEqual([
      { at: AT, method: "PUT", path: "(image upload URL)", status: 201, liUuid: "up-9", context: "ring", draftId: null },
    ]);
  });

  it("records the token endpoint's call as oauth-connect.ts reports it (path only)", () => {
    const rows = ledger();
    logLinkedInCall({ method: "POST", path: "/oauth/v2/accessToken", status: 200, liUuid: "tok-1" });
    expect(rows).toEqual([
      { at: AT, method: "POST", path: "/oauth/v2/accessToken", status: 200, liUuid: "tok-1", context: null, draftId: null },
    ]);
  });

  it("⛔ a sink that throws is only logged, and the call still succeeds", async () => {
    setLinkedInCallSink(() => {
      throw new Error("ledger down");
    });
    fetchMock().mockResolvedValue(response(200, { id: POST }));
    await expect(getPost(POST)).resolves.toBe(true);
    expect(error).toHaveBeenCalledWith("[linkedin-api] the call ledger write failed:", expect.objectContaining({ message: "ledger down" }));
  });

  it("⛔ a sink that rejects is only logged, and the call still succeeds", async () => {
    setLinkedInCallSink(async () => {
      throw new Error("db down");
    });
    fetchMock().mockResolvedValue(response(200, { id: POST }));
    await expect(getPost(POST)).resolves.toBe(true);
    await new Promise((r) => setImmediate(r));
    expect(error).toHaveBeenCalledWith("[linkedin-api] the call ledger write failed:", expect.objectContaining({ message: "db down" }));
  });

  it("gives two concurrent contexts their own tags", async () => {
    const rows = ledger();
    await Promise.all([
      withLinkedInCallContext({ context: "agent", draftId: "a" }, async () => {
        await Promise.resolve();
        await Promise.resolve();
        logLinkedInCall({ method: "POST", path: "/rest/posts", status: 201, liUuid: "A" });
      }),
      withLinkedInCallContext({ context: "autopilot", draftId: "b" }, async () => {
        logLinkedInCall({ method: "POST", path: "/rest/posts", status: 201, liUuid: "B" });
      }),
    ]);
    const tags = Object.fromEntries(rows.map((r) => [r.liUuid, [r.context, r.draftId]]));
    expect(tags).toEqual({ A: ["agent", "a"], B: ["autopilot", "b"] });
  });

  it("stops recording once the sink is cleared with null", () => {
    const rows = ledger();
    logLinkedInCall({ method: "GET", path: "/rest/x", status: 200, liUuid: null });
    setLinkedInCallSink(null);
    logLinkedInCall({ method: "GET", path: "/rest/y", status: 200, liUuid: null });
    expect(rows.map((r) => r.path)).toEqual(["/rest/x"]);
  });

  it("⛔ no query, token or header reaches the sink, the evidence array or the log line", async () => {
    // The token is named SECRET on purpose: it really goes out as the bearer.
    setLinkedInTokenResolver(async () => "SECRET-bearer-token");
    const rows = ledger();
    const calls: LinkedInCallRecord[] = [];
    fetchMock().mockResolvedValue(response(200, { elements: [] }, { "x-li-uuid": "q-1" }));
    await withLinkedInCallLog(calls, async () => {
      // A real request() whose URL carries a query (?author=...&q=author...).
      await listOrganizationPosts(5);
      // And one handed a credential in its query, as a caller might.
      logLinkedInCall({ method: "GET", path: "/rest/posts?access_token=SECRET&q=author", status: 200, liUuid: null });
    });
    expect(calledUrls()[0]).toContain("?author=");
    expect(calledInit(0).headers.Authorization).toBe("Bearer SECRET-bearer-token");
    expect(rows.map((r) => r.path)).toEqual(["/rest/posts", "/rest/posts"]);
    const surfaces = [JSON.stringify(rows), JSON.stringify(calls), ...logLines()];
    expect(logLines()).toHaveLength(2);
    for (const text of surfaces) {
      for (const forbidden of ["SECRET", "access_token", "?", "Bearer"]) {
        expect(text, `${forbidden} in ${text}`).not.toContain(forbidden);
      }
    }
  });
});

/**
 * Rest.li 2.0 wants the WHOLE resource key percent-encoded in a path, `(` as
 * `%28` and `)` as `%29` included (learn.microsoft.com/en-us/linkedin/shared/
 * api-guide/concepts/protocol-version, "Single Resource Key"). The raw parens
 * encodeURIComponent leaves make a reply to a nested comment come back
 * 400 "Syntax exception in path variables".
 */
describe("URN path segments", () => {
  const NESTED_PATH =
    "/rest/socialActions/urn%3Ali%3Acomment%3A%28urn%3Ali%3Aactivity%3A7380000000000000000%2C7380000000000000999%29";

  it("encodes a nested comment urn whole, parens included", () => {
    const out = encodeUrnPathSegment(COMMENT);
    expect(out).toBe("urn%3Ali%3Acomment%3A%28urn%3Ali%3Aactivity%3A7380000000000000000%2C7380000000000000999%29");
    expect(out).not.toMatch(/[()]/);
  });

  it("leaves a plain share or ugcPost urn exactly as encodeURIComponent had it", () => {
    expect(encodeUrnPathSegment(POST)).toBe("urn%3Ali%3Ashare%3A7380000000000000001");
    expect(encodeUrnPathSegment(FIXTURE_LINKEDIN_UGC_URN)).toBe(`urn%3Ali%3AugcPost%3A${FIXTURE_LINKEDIN_POST_ID_2}`);
    expect(encodeUrnPathSegment(ORG)).toBe(encodeURIComponent(ORG));
  });

  it("encodes the RFC 3986 sub-delims encodeURIComponent skips", () => {
    expect(encodeUrnPathSegment("a!b'c*d(e)")).toBe("a%21b%27c%2Ad%28e%29");
  });

  it("keeps a hostile urn inside ONE segment: no slash, query or fragment escapes", () => {
    const hostile = "urn:li:share:1/../../me?x=1#frag";
    const out = encodeUrnPathSegment(hostile);
    expect(out).toBe("urn%3Ali%3Ashare%3A1%2F..%2F..%2Fme%3Fx%3D1%23frag");
    expect(out).not.toMatch(/[/?#]/);
  });

  it("reads the replies under a nested comment at a fully encoded path", async () => {
    fetchMock().mockResolvedValue(response(200, { elements: [] }));
    await getComments(COMMENT);
    const url = new URL(calledUrls()[0]);
    expect(url.pathname).toBe(`${NESTED_PATH}/comments`);
    expect(url.search).toBe("?start=0&count=50");
    expect(calledUrls()[0]).not.toMatch(/[()]/);
  });

  it("POSTs a reply to a nested comment at a path with no raw parens", async () => {
    fetchMock().mockResolvedValue(response(201, {}, { "x-restli-id": "1" }));
    await replyToComment({ postUrn: POST, commentUrn: COMMENT, text: "a" });
    expect(new URL(calledUrls()[0]).pathname).toBe(`${NESTED_PATH}/comments`);
    expect(calledUrls()[0]).not.toMatch(/[()]/);
  });

  it("reads socialActions for a nested comment urn at a fully encoded path", async () => {
    fetchMock().mockResolvedValue(response(200, {}));
    await getSocialActions(COMMENT);
    expect(new URL(calledUrls()[0]).pathname).toBe(NESTED_PATH);
  });

  it("keeps a hostile ref inside one segment on every urn-keyed path", async () => {
    const hostile = "urn:li:share:1/../../me?x=1#frag";
    const segment = "urn%3Ali%3Ashare%3A1%2F..%2F..%2Fme%3Fx%3D1%23frag";
    fetchMock().mockImplementation(async () => response(200, { elements: [] }));
    await deletePost(hostile);
    await getPost(hostile);
    await getSocialActions(hostile);
    await getComments(hostile);
    await replyToComment({ postUrn: POST, commentUrn: hostile, text: "a" });
    const urls = calledUrls().map((u) => new URL(u));
    expect(urls.map((u) => u.pathname)).toEqual([
      `/rest/posts/${segment}`,
      `/rest/posts/${segment}`,
      `/rest/socialActions/${segment}`,
      `/rest/socialActions/${segment}/comments`,
      `/rest/socialActions/${segment}/comments`,
    ]);
    expect(urls.map((u) => u.hash)).toEqual(["", "", "", "", ""]);
    expect(urls.map((u) => u.search)).toEqual(["", "", "", "?start=0&count=50", ""]);
  });
});
