// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setEngineDeployment } from "../settings.js";
import { ResponseShapeError } from "../http/shape.js";
import { FIXTURE_REDDIT_USER_AGENT } from "./helpers/fixtures.js";

/**
 * The parts of the reddit.ts vendor client that reddit-client.test.ts and
 * reddit-media.test.ts do not reach: getPostStats, uploadMediaAsset called
 * directly (its lease validation and SSRF refusals), the karma fields on getMe,
 * and the remaining request-plumbing branches.
 *
 * ⛔ MOCK ONLY. Reddit API access is unapproved (both requests rejected), so
 * nothing here may be proofed against the live API — and a green run here is
 * evidence about THIS CLIENT'S behaviour, never about Reddit's agreement with
 * it. Same rule reddit.ts's own docblock states.
 */

import {
  RedditError,
  RedditApiError,
  setRedditTokenResolver,
  getInfo,
  getPostStats,
  getMe,
  getLinkFlair,
  getSubredditAbout,
  getPostRequirements,
  submitPost,
  redditMediaUploadEnabled,
  uploadMediaAsset,
} from "../reddit.js";

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

function fetchMock(): ReturnType<typeof vi.fn<FetchFn>> {
  return fetch as unknown as ReturnType<typeof vi.fn<FetchFn>>;
}

function textResponse(status: number, body: string, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => body,
  } as unknown as Response;
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return textResponse(status, JSON.stringify(body), headers);
}

/** The S3 leg answers a bare 2xx with no JSON body of interest. */
function s3Response(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => "",
  } as unknown as Response;
}

const TOKEN = "test-access-token";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn<FetchFn>());
  setRedditTokenResolver(async () => TOKEN);
  setEngineDeployment({ redditUserAgent: FIXTURE_REDDIT_USER_AGENT });
});

afterEach(() => {
  setRedditTokenResolver(null);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("request plumbing branches", () => {
  it("carries a Retry-After header verbatim onto the error", async () => {
    fetchMock().mockResolvedValue(jsonResponse(429, { error: "too many" }, { "retry-after": "600" }));

    const err = await getMe().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RedditError);
    expect((err as RedditError).retryAfter).toBe("600");
  });

  it("returns undefined rather than throwing when a 200 carries no body", async () => {
    // A DELETE-shaped no-content answer must not be reported as a parse failure.
    fetchMock().mockResolvedValue(textResponse(200, ""));
    await expect(getLinkFlair("test")).resolves.toEqual([]);
  });

  it("throws a parse error naming the first 200 characters of a non-JSON body", async () => {
    fetchMock().mockResolvedValue(textResponse(200, "<html>cloudflare</html>"));
    await expect(getMe()).rejects.toThrow(/expected JSON, got: <html>cloudflare<\/html>/);
  });

  it("stringifies a thrown non-Error from the transport", async () => {
    fetchMock().mockRejectedValue("socket hang up");

    const err = await getMe().catch((e: unknown) => e);
    expect((err as RedditError).body).toBe("socket hang up");
    expect((err as RedditError).status).toBe(0);
  });

  it("percent-encodes a subreddit name into the path", async () => {
    fetchMock().mockResolvedValue(jsonResponse(200, { data: {} }));

    await getSubredditAbout("weird name/../etc");

    expect(String(fetchMock().mock.calls[0][0])).toContain("/r/weird%20name%2F..%2Fetc/about");
  });

  it("sends the caller's query parameters alongside raw_json", async () => {
    fetchMock().mockResolvedValue(jsonResponse(200, { data: { children: [] } }));

    await getInfo(["t3_abc"]);

    const url = new URL(String(fetchMock().mock.calls[0][0]));
    expect(url.searchParams.get("id")).toBe("t3_abc");
    expect(url.searchParams.get("raw_json")).toBe("1");
  });
});

describe("RedditApiError message", () => {
  it("renders every embedded error, naming the offending field where the vendor gave one", async () => {
    fetchMock().mockResolvedValue(
      jsonResponse(200, {
        json: {
          errors: [
            ["SUBREDDIT_NOTALLOWED", "you aren't allowed to post there", "sr"],
            ["NO_TEXT", "we need something here", null],
          ],
        },
      }),
    );

    const err = await submitPost({ subreddit: "test", kind: "self", title: "hi", text: "x" }).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(RedditApiError);
    const msg = (err as RedditApiError).message;
    expect(msg).toContain("SUBREDDIT_NOTALLOWED: you aren't allowed to post there (field: sr)");
    expect(msg).toContain("NO_TEXT: we need something here");
    expect(msg).not.toContain("NO_TEXT: we need something here (field:");
  });

  it("substitutes placeholders for a malformed error tuple rather than rendering undefined", async () => {
    fetchMock().mockResolvedValue(jsonResponse(200, { json: { errors: [[]] } }));

    const err = await submitPost({ subreddit: "test", kind: "self", title: "hi" }).catch((e: unknown) => e);

    expect((err as RedditApiError).message).toContain("UNKNOWN: (no message)");
  });

  it("keeps the errors on the instance for a caller that wants to branch on the code", async () => {
    fetchMock().mockResolvedValue(
      jsonResponse(200, { json: { errors: [["RATELIMIT", "you are doing that too much", "ratelimit"]] } }),
    );

    const err = await submitPost({ subreddit: "test", kind: "self", title: "hi" }).catch((e: unknown) => e);

    expect((err as RedditApiError).errors).toEqual([
      { code: "RATELIMIT", message: "you are doing that too much", field: "ratelimit" },
    ]);
    expect((err as RedditApiError).status).toBe(200);
  });
});

describe("submitPost optional flags", () => {
  function submitOk(): Response {
    return jsonResponse(200, { json: { errors: [], data: { id: "abc", name: "t3_abc", url: "https://reddit.test/x" } } });
  }

  it("sends nsfw, sendreplies and resubmit only when the caller set them", async () => {
    fetchMock().mockResolvedValue(submitOk());

    await submitPost({
      subreddit: "test",
      kind: "self",
      title: "hi",
      text: "body",
      nsfw: true,
      sendReplies: false,
      resubmit: true,
    });

    const body = new URLSearchParams(String(fetchMock().mock.calls[0][1]?.body));
    expect(body.get("nsfw")).toBe("true");
    expect(body.get("sendreplies")).toBe("false");
    expect(body.get("resubmit")).toBe("true");
  });

  it("omits those fields entirely when unset, leaving the vendor's own defaults in force", async () => {
    fetchMock().mockResolvedValue(submitOk());

    await submitPost({ subreddit: "test", kind: "self", title: "hi", text: "body" });

    const body = new URLSearchParams(String(fetchMock().mock.calls[0][1]?.body));
    expect(body.has("nsfw")).toBe(false);
    expect(body.has("sendreplies")).toBe(false);
    expect(body.has("resubmit")).toBe(false);
  });

  it("omits an empty text on a self post rather than sending a blank field", async () => {
    fetchMock().mockResolvedValue(submitOk());

    await submitPost({ subreddit: "test", kind: "self", title: "title only", text: "" });

    const body = new URLSearchParams(String(fetchMock().mock.calls[0][1]?.body));
    expect(body.has("text")).toBe(false);
  });

  it("requires a url for an image post, refusing locally with no network call", async () => {
    await expect(submitPost({ subreddit: "test", kind: "image", title: "hi" })).rejects.toThrow(
      /kind "image" requires a url/,
    );
    expect(fetchMock()).not.toHaveBeenCalled();
  });
});

describe("getPostStats", () => {
  it("returns [] and makes no request for an empty list", async () => {
    await expect(getPostStats([])).resolves.toEqual([]);
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it("reads score, comment count and upvote ratio off the listing", async () => {
    fetchMock().mockResolvedValue(
      jsonResponse(200, {
        data: { children: [{ data: { name: "t3_a", score: 42, num_comments: 7, upvote_ratio: 0.93 } }] },
      }),
    );

    await expect(getPostStats(["t3_a"])).resolves.toEqual([
      { name: "t3_a", score: 42, comments: 7, upvoteRatio: 0.93 },
    ]);
  });

  it("leaves an omitted counter ABSENT rather than defaulting it to zero", async () => {
    // A missing counter and a genuine zero must not look the same on a dashboard.
    fetchMock().mockResolvedValue(
      jsonResponse(200, { data: { children: [{ data: { name: "t3_a", num_comments: 0 } }] } }),
    );

    const [row] = await getPostStats(["t3_a"]);
    expect(row).toEqual({ name: "t3_a", comments: 0 });
    expect("score" in row).toBe(false);
    expect("upvoteRatio" in row).toBe(false);
  });

  it("skips a child carrying no fullname, since there is nothing to key it to", async () => {
    fetchMock().mockResolvedValue(
      jsonResponse(200, {
        data: { children: [{ data: { score: 5 } }, { data: { name: "t3_b", score: 6 } }, {}] },
      }),
    );

    await expect(getPostStats(["t3_a", "t3_b"])).resolves.toEqual([{ name: "t3_b", score: 6 }]);
  });

  it("refuses a counter the vendor sent as a string rather than coercing or dropping it", async () => {
    fetchMock().mockResolvedValue(
      jsonResponse(200, { data: { children: [{ data: { name: "t3_a", score: "42" } }] } }),
    );

    const err = await getPostStats(["t3_a"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResponseShapeError);
    expect((err as Error).message).toBe(
      "reddit GET /api/info: unexpected response shape at data.children[0].data.score: expected a finite number, got a string",
    );
  });

  it("refuses a listing whose children or child data are the wrong type", async () => {
    for (const body of [{ data: { children: {} } }, { data: { children: ["x"] } }, { data: { children: [{ data: 1 }] } }, { data: [] }, []]) {
      fetchMock().mockResolvedValueOnce(jsonResponse(200, body));
      await expect(getPostStats(["t3_a"])).rejects.toBeInstanceOf(ResponseShapeError);
    }
  });

  it("tolerates a listing with no data or children key", async () => {
    fetchMock().mockResolvedValueOnce(jsonResponse(200, {}));
    await expect(getPostStats(["t3_a"])).resolves.toEqual([]);

    fetchMock().mockResolvedValueOnce(jsonResponse(200, { data: {} }));
    await expect(getPostStats(["t3_a"])).resolves.toEqual([]);
  });

  it("chunks at the same 100-fullname batch limit getInfo uses", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `t3_${i}`);
    fetchMock().mockResolvedValue(jsonResponse(200, { data: { children: [] } }));

    await getPostStats(ids);

    expect(fetchMock()).toHaveBeenCalledTimes(2);
    const first = new URL(String(fetchMock().mock.calls[0][0])).searchParams.get("id");
    const second = new URL(String(fetchMock().mock.calls[1][0])).searchParams.get("id");
    expect(first?.split(",")).toHaveLength(100);
    expect(second?.split(",")).toHaveLength(50);
  });

  it("propagates a vendor failure rather than reporting empty stats", async () => {
    fetchMock().mockResolvedValue(jsonResponse(403, { error: "forbidden" }));
    await expect(getPostStats(["t3_a"])).rejects.toBeInstanceOf(RedditError);
  });
});

describe("getMe karma fields", () => {
  it("surfaces the three karma counters when present", async () => {
    fetchMock().mockResolvedValue(
      jsonResponse(200, { id: "u1", name: "examplebrand", link_karma: 12, comment_karma: 34, total_karma: 46 }),
    );

    await expect(getMe()).resolves.toEqual({
      id: "u1",
      name: "examplebrand",
      linkKarma: 12,
      commentKarma: 34,
      totalKarma: 46,
    });
  });

  it("omits a karma field the endpoint did not return, degrading to no data", async () => {
    // The field names here are operational knowledge, not a documented schema;
    // a wrong guess must degrade to "absent", never to a fabricated zero.
    fetchMock().mockResolvedValue(jsonResponse(200, { id: "u1", name: "examplebrand", link_karma: 12 }));

    const profile = await getMe();
    expect(profile).toEqual({ id: "u1", name: "examplebrand", linkKarma: 12 });
    expect("commentKarma" in profile).toBe(false);
  });

  it("refuses a karma value that is not a number", async () => {
    fetchMock().mockResolvedValue(jsonResponse(200, { id: "u1", name: "d", link_karma: "12" }));

    await expect(getMe()).rejects.toThrow("reddit GET /api/v1/me: unexpected response shape at link_karma: expected a finite number, got a string");
  });

  it("refuses an id or name of the wrong type, and a body that is not an object", async () => {
    for (const body of [{ id: 1, name: "d" }, { id: "u1", name: false }, ["u1"]]) {
      fetchMock().mockResolvedValueOnce(jsonResponse(200, body));
      await expect(getMe()).rejects.toBeInstanceOf(ResponseShapeError);
    }
  });

  it("reports a zero karma count as zero", async () => {
    fetchMock().mockResolvedValue(jsonResponse(200, { id: "u1", name: "d", total_karma: 0 }));
    await expect(getMe()).resolves.toMatchObject({ totalKarma: 0 });
  });
});

describe("getPostRequirements policy narrowing", () => {
  it("carries each documented policy value through", async () => {
    for (const policy of ["required", "notAllowed", "none"] as const) {
      fetchMock().mockResolvedValueOnce(jsonResponse(200, { body_restriction_policy: policy }));
      await expect(getPostRequirements("test")).resolves.toMatchObject({ bodyRestrictionPolicy: policy });
    }
  });

  it("drops a policy value outside the documented set rather than passing it upward", async () => {
    fetchMock().mockResolvedValue(jsonResponse(200, { body_restriction_policy: "somethingElse" }));
    await expect(getPostRequirements("test")).resolves.toMatchObject({ bodyRestrictionPolicy: undefined });
  });
});

describe("getSubredditAbout", () => {
  it("carries over18 through and narrows each documented submission_type", async () => {
    for (const st of ["any", "link", "self"] as const) {
      fetchMock().mockResolvedValueOnce(
        jsonResponse(200, { data: { display_name: "test", submission_type: st, over18: true } }),
      );
      await expect(getSubredditAbout("test")).resolves.toEqual({
        displayName: "test",
        submissionType: st,
        over18: true,
      });
    }
  });

  it("tolerates a response with no data key", async () => {
    fetchMock().mockResolvedValue(jsonResponse(200, {}));
    await expect(getSubredditAbout("test")).resolves.toEqual({
      displayName: undefined,
      submissionType: undefined,
      over18: undefined,
    });
  });
});

describe("getLinkFlair hostile input", () => {
  it("refuses a null or primitive entry inside the array", async () => {
    for (const entry of [null, "flair", 7]) {
      fetchMock().mockResolvedValueOnce(jsonResponse(200, [entry, { id: "f1", text: "News" }]));
      await expect(getLinkFlair("test")).rejects.toThrow(
        "reddit GET /r/:subreddit/api/link_flair_v2: unexpected response shape at (body)[0]: expected an object",
      );
    }
  });

  it("refuses an entry whose id or text is the wrong type", async () => {
    fetchMock().mockResolvedValueOnce(jsonResponse(200, [{ id: 1, text: "News" }]));
    await expect(getLinkFlair("test")).rejects.toThrow("at (body)[0].id: expected a non-empty string, got a number");
    fetchMock().mockResolvedValueOnce(jsonResponse(200, [{ id: "f2", text: 2 }]));
    await expect(getLinkFlair("test")).rejects.toThrow("at (body)[0].text: expected a string, got a number");
  });

  it("reads an empty body as no flair", async () => {
    fetchMock().mockResolvedValue(new Response("", { status: 200 }));
    await expect(getLinkFlair("test")).resolves.toEqual([]);
  });
});

describe("redditMediaUploadEnabled", () => {
  it("is off by default, because the endpoint is undocumented", async () => {
    vi.stubEnv("SOCIALMETA_REDDIT_MEDIA_UPLOAD", "");
    expect(redditMediaUploadEnabled()).toBe(false);
  });

  it("is on only for the exact opt-in value", async () => {
    vi.stubEnv("SOCIALMETA_REDDIT_MEDIA_UPLOAD", "1");
    expect(redditMediaUploadEnabled()).toBe(true);

    vi.stubEnv("SOCIALMETA_REDDIT_MEDIA_UPLOAD", "true");
    expect(redditMediaUploadEnabled()).toBe(false);
  });
});

describe("uploadMediaAsset", () => {
  const bytes = new Uint8Array([1, 2, 3]);

  function lease(action: string | undefined, fields: Array<{ name?: string; value?: string }>, assetId?: string): Response {
    return jsonResponse(200, {
      args: { ...(action === undefined ? {} : { action }), fields },
      ...(assetId ? { asset: { asset_id: assetId } } : {}),
    });
  }

  const okFields = [
    { name: "policy", value: "abc" },
    { name: "key", value: "media/xyz.jpg" },
  ];

  it("asks for a lease with the filename and mime type, then PUTs the bytes to the named endpoint", async () => {
    fetchMock()
      .mockResolvedValueOnce(lease("https://bucket.s3.amazonaws.com/", okFields, "asset-1"))
      .mockResolvedValueOnce(s3Response(201));

    const result = await uploadMediaAsset(bytes, "card.jpg", "image/jpeg");

    const leaseBody = new URLSearchParams(String(fetchMock().mock.calls[0][1]?.body));
    expect(leaseBody.get("filepath")).toBe("card.jpg");
    expect(leaseBody.get("mimetype")).toBe("image/jpeg");
    expect(result).toEqual({ url: "https://bucket.s3.amazonaws.com/media/xyz.jpg", assetId: "asset-1" });
  });

  it("normalises a protocol-relative lease action to https", async () => {
    fetchMock()
      .mockResolvedValueOnce(lease("//bucket.s3.amazonaws.com/", okFields))
      .mockResolvedValueOnce(s3Response(204));

    const result = await uploadMediaAsset(bytes, "card.jpg", "image/jpeg");

    expect(String(fetchMock().mock.calls[1][0])).toBe("https://bucket.s3.amazonaws.com/");
    expect(result.url).toBe("https://bucket.s3.amazonaws.com/media/xyz.jpg");
  });

  it("sends every policy field BEFORE the file, which S3 requires", async () => {
    // S3 ignores anything sent after `file`; the ordering is not stylistic.
    fetchMock()
      .mockResolvedValueOnce(lease("https://bucket.s3.amazonaws.com/", okFields))
      .mockResolvedValueOnce(s3Response(201));

    await uploadMediaAsset(bytes, "card.jpg", "image/jpeg");

    const body = fetchMock().mock.calls[1][1]?.body as FormData;
    const keys = [...body.keys()];
    expect(keys).toEqual(["policy", "key", "file"]);
  });

  it("sends an empty string for a lease field the vendor gave no value for", async () => {
    fetchMock()
      .mockResolvedValueOnce(
        lease("https://bucket.s3.amazonaws.com/", [{ name: "acl" }, { name: "key", value: "k.jpg" }]),
      )
      .mockResolvedValueOnce(s3Response(201));

    await uploadMediaAsset(bytes, "card.jpg", "image/jpeg");

    const body = fetchMock().mock.calls[1][1]?.body as FormData;
    expect(body.get("acl")).toBe("");
  });

  it("drops a lease field with no name at all", async () => {
    fetchMock()
      .mockResolvedValueOnce(
        lease("https://bucket.s3.amazonaws.com/", [{ value: "orphan" }, { name: "key", value: "k.jpg" }]),
      )
      .mockResolvedValueOnce(s3Response(201));

    await uploadMediaAsset(bytes, "card.jpg", "image/jpeg");

    const body = fetchMock().mock.calls[1][1]?.body as FormData;
    expect([...body.keys()]).toEqual(["key", "file"]);
  });

  it("throws when the lease named no upload action", async () => {
    fetchMock().mockResolvedValue(lease(undefined, okFields));
    await expect(uploadMediaAsset(bytes, "c.jpg", "image/jpeg")).rejects.toThrow(/no upload action\/fields/);
  });

  it("throws when the lease carried no fields", async () => {
    fetchMock().mockResolvedValue(lease("https://bucket.s3.amazonaws.com/", []));
    await expect(uploadMediaAsset(bytes, "c.jpg", "image/jpeg")).rejects.toThrow(/no upload action\/fields/);
  });

  it("throws when the lease response has no args at all", async () => {
    fetchMock().mockResolvedValue(jsonResponse(200, {}));
    await expect(uploadMediaAsset(bytes, "c.jpg", "image/jpeg")).rejects.toThrow(/no upload action\/fields/);
  });

  it("refuses an unparseable upload action rather than handing it to fetch", async () => {
    fetchMock().mockResolvedValue(lease("not a url at all", okFields));
    await expect(uploadMediaAsset(bytes, "c.jpg", "image/jpeg")).rejects.toThrow(/unparseable upload action/);
  });

  it("refuses a non-https action, which is how a lease could aim bytes at the metadata service", async () => {
    // `http://169.254.169.254/...` is the concrete attack this closes.
    fetchMock().mockResolvedValue(lease("http://169.254.169.254/latest/meta-data/", okFields));

    await expect(uploadMediaAsset(bytes, "c.jpg", "image/jpeg")).rejects.toThrow(
      /non-https upload action \(http:\/\/\), refusing to upload/,
    );
    expect(fetchMock()).toHaveBeenCalledTimes(1);
  });

  it("refuses a file: action", async () => {
    fetchMock().mockResolvedValue(lease("file:///etc/passwd", okFields));
    await expect(uploadMediaAsset(bytes, "c.jpg", "image/jpeg")).rejects.toThrow(/non-https upload action/);
  });

  it("refuses an https action pointing at a private address, which https alone does not stop", async () => {
    // The protocol check is not the whole guard: the SSRF helper's literal-IP
    // check runs even under NODE_ENV=test, where DNS resolution is skipped.
    fetchMock().mockResolvedValue(lease("https://10.0.0.5/upload", okFields));

    await expect(uploadMediaAsset(bytes, "c.jpg", "image/jpeg")).rejects.toThrow();
    expect(fetchMock()).toHaveBeenCalledTimes(1);
  });

  it("throws when S3 rejects the bytes, carrying the real status", async () => {
    fetchMock()
      .mockResolvedValueOnce(lease("https://bucket.s3.amazonaws.com/", okFields))
      .mockResolvedValueOnce(s3Response(403));

    const err = await uploadMediaAsset(bytes, "c.jpg", "image/jpeg").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RedditError);
    expect((err as RedditError).status).toBe(403);
    expect((err as RedditError).message).toContain("S3 upload rejected the asset (HTTP 403)");
  });

  it("throws when the lease carried no `key`, since the asset URL cannot be built without it", async () => {
    fetchMock()
      .mockResolvedValueOnce(lease("https://bucket.s3.amazonaws.com/", [{ name: "policy", value: "p" }]))
      .mockResolvedValueOnce(s3Response(201));

    await expect(uploadMediaAsset(bytes, "c.jpg", "image/jpeg")).rejects.toThrow(/no `key` field/);
  });

  it("does not double the slash when the lease action already ends in one", async () => {
    fetchMock()
      .mockResolvedValueOnce(lease("https://bucket.s3.amazonaws.com///", okFields))
      .mockResolvedValueOnce(s3Response(201));

    await expect(uploadMediaAsset(bytes, "c.jpg", "image/jpeg")).resolves.toMatchObject({
      url: "https://bucket.s3.amazonaws.com/media/xyz.jpg",
    });
  });

  it("reports no assetId when the lease omitted one", async () => {
    fetchMock()
      .mockResolvedValueOnce(lease("https://bucket.s3.amazonaws.com/", okFields))
      .mockResolvedValueOnce(s3Response(201));

    await expect(uploadMediaAsset(bytes, "c.jpg", "image/jpeg")).resolves.toEqual({
      url: "https://bucket.s3.amazonaws.com/media/xyz.jpg",
      assetId: undefined,
    });
  });
});

describe("sparse vendor bodies and non-timeout transport errors", () => {
  it("keeps a transport Error's own message, distinct from the timeout wording", async () => {
    fetchMock().mockRejectedValue(new TypeError("fetch failed"));

    const err = (await getMe().catch((e: unknown) => e)) as RedditError;

    expect(err).toBeInstanceOf(RedditError);
    expect(err.status).toBe(0);
    expect(err.body).toBe("fetch failed");
  });

  it("refuses a submit answer with no json envelope at all as unusable, not as a success", async () => {
    fetchMock().mockResolvedValue(jsonResponse(200, {}));

    const err = await submitPost({ subreddit: "test", kind: "self", title: "hi" }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RedditError);
    expect(err).not.toBeInstanceOf(RedditApiError);
    expect((err as RedditError).message).toMatch(/no usable post id\/name/);
  });

  it("reads a getInfo answer with no data, and a child with no name, as not found", async () => {
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(200, {}))
      .mockResolvedValueOnce(jsonResponse(200, { data: { children: [{ data: {} }, { data: { name: "t3_b" } }, {}] } }));

    const many = Array.from({ length: 101 }, (_, i) => `t3_${i}`);
    const found = await getInfo(many);

    expect([...found]).toEqual(["t3_b"]);
    expect(fetchMock()).toHaveBeenCalledTimes(2);
  });

  it("a RedditApiError built with no entries keeps the plain RedditError message", () => {
    const err = new RedditApiError([], "POST", "/api/submit");
    expect(err.name).toBe("RedditApiError");
    expect(err.errors).toEqual([]);
    expect(err.message).toBe(new RedditError(200, "[]", "POST", "/api/submit").message);
  });
});
