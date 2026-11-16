import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setEngineDeployment } from "../settings.js";
import { FIXTURE_REDDIT_USER_AGENT } from "./helpers/fixtures.js";
import {
  RedditError,
  RedditApiError,
  isRedditNotFound,
  setRedditTokenResolver,
  submitPost,
  deleteThing,
  getInfo,
  getSubredditAbout,
  getPostRequirements,
  getLinkFlair,
  getMe,
} from "../reddit.js";

/**
 * Reddit coverage at the vendor-client layer. This is FIRST-TIME ENABLEMENT
 * (see reddit.ts's own docblock) -- there is no prior working Reddit publish
 * to regress-test against, so the load-bearing cases here are the ones the
 * task's briefing called out as the likely real failure modes: a 200 OK
 * response from /api/submit that actually rejected the post
 * (json.errors), and a 200 with no errors but also no usable post id.
 */

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function textResponse(status: number, body: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  } as unknown as Response;
}

function fetchMock() {
  return fetch as unknown as ReturnType<typeof vi.fn>;
}

const TOKEN = "test-access-token";

describe("reddit client", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    setRedditTokenResolver(async () => TOKEN);
    setEngineDeployment({ redditUserAgent: FIXTURE_REDDIT_USER_AGENT });
    delete process.env.SOCIALMETA_REDDIT_USER_AGENT;
  });

  afterEach(() => {
    setRedditTokenResolver(null);
    vi.unstubAllGlobals();
  });

  describe("auth / request plumbing", () => {
    it("throws a clear RedditError when no resolver is registered", async () => {
      setRedditTokenResolver(null);
      await expect(getMe()).rejects.toThrow(/no Reddit token resolver/);
    });

    it("throws when the resolver returns an empty token", async () => {
      setRedditTokenResolver(async () => "");
      await expect(getMe()).rejects.toThrow(/empty token/);
    });

    it("sends the bearer token and a User-Agent header on every call", async () => {
      fetchMock().mockResolvedValue(jsonResponse(200, { id: "abc", name: "examplebrand" }));
      await getMe();
      const [, init] = fetchMock().mock.calls[0];
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(headers["User-Agent"]).toBeTruthy();
    });

    it("uses SOCIALMETA_REDDIT_USER_AGENT when set, over the deployment's", async () => {
      process.env.SOCIALMETA_REDDIT_USER_AGENT = "web:com.examplebrand.real:v2.0.0 (by /u/realaccount)";
      fetchMock().mockResolvedValue(jsonResponse(200, { id: "abc", name: "examplebrand" }));
      await getMe();
      const [, init] = fetchMock().mock.calls[0];
      const headers = init.headers as Record<string, string>;
      expect(headers["User-Agent"]).toBe("web:com.examplebrand.real:v2.0.0 (by /u/realaccount)");
    });

    it("adds raw_json=1 to a GET request's query string", async () => {
      fetchMock().mockResolvedValue(jsonResponse(200, { id: "abc", name: "examplebrand" }));
      await getMe();
      const [url] = fetchMock().mock.calls[0];
      expect(String(url)).toContain("raw_json=1");
    });

    it("adds raw_json=1 to a POST request's form body", async () => {
      fetchMock().mockResolvedValue(jsonResponse(200, {}));
      await deleteThing("t3_x");
      const [, init] = fetchMock().mock.calls[0];
      expect(String(init.body)).toContain("raw_json=1");
    });

    it("sends application/x-www-form-urlencoded for a POST, and no Content-Type for a GET", async () => {
      fetchMock().mockResolvedValue(jsonResponse(200, {}));
      await deleteThing("t3_x");
      const postHeaders = fetchMock().mock.calls[0][1].headers as Record<string, string>;
      expect(postHeaders["Content-Type"]).toBe("application/x-www-form-urlencoded");

      fetchMock().mockClear();
      fetchMock().mockResolvedValue(jsonResponse(200, { id: "a", name: "b" }));
      await getMe();
      const getHeaders = fetchMock().mock.calls[0][1].headers as Record<string, string>;
      expect(getHeaders["Content-Type"]).toBeUndefined();
    });

    it("throws a RedditError carrying the real status on a non-2xx response", async () => {
      fetchMock().mockResolvedValue(textResponse(401, JSON.stringify({ message: "invalid_token" })));
      await expect(getMe()).rejects.toMatchObject({ status: 401 });
    });

    it("wraps a fetch-level timeout into a clear RedditError", async () => {
      const timeoutErr = new Error("aborted");
      timeoutErr.name = "TimeoutError";
      fetchMock().mockRejectedValue(timeoutErr);
      await expect(getMe()).rejects.toThrow(/no response after/);
    });
  });

  describe("submitPost", () => {
    it("submits a self post with api_type=json, sr, kind, title, text", async () => {
      fetchMock().mockResolvedValue(jsonResponse(200, { json: { errors: [], data: { id: "1abcde", name: "t3_1abcde" } } }));

      const post = await submitPost({ subreddit: "test", title: "hello", kind: "self", text: "body copy" });

      expect(post).toEqual({ id: "1abcde", name: "t3_1abcde" });
      const [, init] = fetchMock().mock.calls[0];
      const form = new URLSearchParams(init.body as string);
      expect(form.get("api_type")).toBe("json");
      expect(form.get("sr")).toBe("test");
      expect(form.get("kind")).toBe("self");
      expect(form.get("title")).toBe("hello");
      expect(form.get("text")).toBe("body copy");
      expect(form.get("url")).toBeNull();
    });

    it("sends the subreddit BARE, never with a /r/ prefix (that was a Postiz artifact, not Reddit's requirement)", async () => {
      fetchMock().mockResolvedValue(jsonResponse(200, { json: { errors: [], data: { id: "1", name: "t3_1" } } }));
      await submitPost({ subreddit: "SaaS", title: "t", kind: "self" });
      const [, init] = fetchMock().mock.calls[0];
      const form = new URLSearchParams(init.body as string);
      expect(form.get("sr")).toBe("SaaS");
      expect(String(init.body)).not.toContain("%2Fr%2F");
    });

    it("submits a link post with url instead of text, and never sends a text field", async () => {
      fetchMock().mockResolvedValue(jsonResponse(200, { json: { errors: [], data: { id: "2", name: "t3_2" } } }));

      await submitPost({ subreddit: "test", title: "hello", kind: "link", url: "https://example.com/blog" });

      const [, init] = fetchMock().mock.calls[0];
      const form = new URLSearchParams(init.body as string);
      expect(form.get("kind")).toBe("link");
      expect(form.get("url")).toBe("https://example.com/blog");
      expect(form.has("text")).toBe(false);
    });

    it("throws locally, with no network call, when kind is link and no url is given", async () => {
      await expect(submitPost({ subreddit: "test", title: "t", kind: "link" })).rejects.toThrow(/requires a url/);
      expect(fetchMock()).not.toHaveBeenCalled();
    });

    it("sends flair_id and flair_text when a flair is given", async () => {
      fetchMock().mockResolvedValue(jsonResponse(200, { json: { errors: [], data: { id: "1", name: "t3_1" } } }));
      await submitPost({ subreddit: "test", title: "t", kind: "self", flairId: "f1", flairText: "Discussion" });
      const [, init] = fetchMock().mock.calls[0];
      const form = new URLSearchParams(init.body as string);
      expect(form.get("flair_id")).toBe("f1");
      expect(form.get("flair_text")).toBe("Discussion");
    });

    /**
     * THE load-bearing case. Reddit's submit endpoint answers HTTP 200 even
     * when it rejects the post, with the real failure embedded in
     * `json.errors` -- exactly the failure mode the task's briefing flagged
     * as most likely here, and the one no prior Reddit code in this repo
     * has ever handled (the one real attempt came back a bare `state:
     * ERROR` with nothing else recorded). A client checking only `res.ok`
     * would report this as success.
     */
    it("throws RedditApiError when the vendor answers 200 OK with errors embedded in the body", async () => {
      fetchMock().mockResolvedValue(
        jsonResponse(200, {
          json: { errors: [["SUBREDDIT_NOEXIST", "that subreddit doesn't exist", "sr"]], data: {} },
        }),
      );
      const err = await submitPost({ subreddit: "doesnotexist", title: "t", kind: "self" }).catch((e) => e);
      expect(err).toBeInstanceOf(RedditApiError);
      expect(err).toBeInstanceOf(RedditError);
      expect(err.errors).toEqual([{ code: "SUBREDDIT_NOEXIST", message: "that subreddit doesn't exist", field: "sr" }]);
      expect(err.message).toContain("SUBREDDIT_NOEXIST");
    });

    it("throws a RedditError (not RedditApiError) for a 200 with no errors but no usable id either", async () => {
      fetchMock().mockResolvedValue(jsonResponse(200, { json: { errors: [], data: {} } }));
      const err = await submitPost({ subreddit: "test", title: "t", kind: "self" }).catch((e) => e);
      expect(err).toBeInstanceOf(RedditError);
      expect(err).not.toBeInstanceOf(RedditApiError);
      expect(err.message).toMatch(/no usable post id/);
    });

    it("still throws a plain RedditError for an HTTP-level failure (e.g. 401)", async () => {
      fetchMock().mockResolvedValue(textResponse(401, "invalid_token"));
      await expect(submitPost({ subreddit: "test", title: "t", kind: "self" })).rejects.toMatchObject({ status: 401 });
    });
  });

  describe("deleteThing", () => {
    it("posts the fullname to /api/del", async () => {
      fetchMock().mockResolvedValue(jsonResponse(200, {}));
      await deleteThing("t3_1abcde");
      const [url, init] = fetchMock().mock.calls[0];
      expect(String(url)).toContain("/api/del");
      const form = new URLSearchParams(init.body as string);
      expect(form.get("id")).toBe("t3_1abcde");
    });

    it("still throws for a real HTTP failure", async () => {
      fetchMock().mockResolvedValue(textResponse(403, "forbidden"));
      await expect(deleteThing("t3_1")).rejects.toMatchObject({ status: 403 });
    });
  });

  describe("isRedditNotFound", () => {
    it("is true only for a RedditError with status 404", () => {
      expect(isRedditNotFound(new RedditError(404, "", "GET", "/x"))).toBe(true);
      expect(isRedditNotFound(new RedditError(403, "", "GET", "/x"))).toBe(false);
      expect(isRedditNotFound(new Error("plain"))).toBe(false);
    });
  });

  describe("getInfo", () => {
    it("returns the set of fullnames the vendor confirmed exist", async () => {
      fetchMock().mockResolvedValue(
        jsonResponse(200, { kind: "Listing", data: { children: [{ kind: "t3", data: { id: "1", name: "t3_1" } }] } }),
      );
      const found = await getInfo(["t3_1", "t3_2"]);
      expect(found).toEqual(new Set(["t3_1"]));
    });

    it("returns an empty set for an empty input without calling the vendor", async () => {
      const found = await getInfo([]);
      expect(found.size).toBe(0);
      expect(fetchMock()).not.toHaveBeenCalled();
    });

    it("chunks a large batch at 100 fullnames per call", async () => {
      fetchMock().mockImplementation(async (url: string) => {
        const ids = new URL(url).searchParams.get("id")!.split(",");
        return jsonResponse(200, {
          data: { children: ids.map((id) => ({ kind: "t3", data: { id, name: id } })) },
        });
      });
      const refs = Array.from({ length: 150 }, (_, i) => `t3_${i}`);
      const found = await getInfo(refs);
      expect(found.size).toBe(150);
      expect(fetchMock()).toHaveBeenCalledTimes(2);
    });

    it("treats a lookup failure as a real thrown error, not a silent empty set", async () => {
      fetchMock().mockResolvedValue(textResponse(503, "upstream unavailable"));
      await expect(getInfo(["t3_1"])).rejects.toMatchObject({ status: 503 });
    });
  });

  describe("getSubredditAbout", () => {
    it("reads submission_type and display_name", async () => {
      fetchMock().mockResolvedValue(
        jsonResponse(200, { kind: "t5", data: { display_name: "SaaS", submission_type: "any", over18: false } }),
      );
      await expect(getSubredditAbout("saas")).resolves.toEqual({
        displayName: "SaaS",
        submissionType: "any",
        over18: false,
      });
    });

    it("drops an unrecognised submission_type value rather than guessing", async () => {
      fetchMock().mockResolvedValue(jsonResponse(200, { data: { submission_type: "something-new" } }));
      const about = await getSubredditAbout("saas");
      expect(about.submissionType).toBeUndefined();
    });
  });

  describe("getPostRequirements", () => {
    it("reads is_flair_required, body_restriction_policy, and title length bounds", async () => {
      fetchMock().mockResolvedValue(
        jsonResponse(200, {
          is_flair_required: true,
          body_restriction_policy: "notAllowed",
          title_text_min_length: 10,
          title_text_max_length: 100,
        }),
      );
      await expect(getPostRequirements("saas")).resolves.toEqual({
        isFlairRequired: true,
        bodyRestrictionPolicy: "notAllowed",
        titleMinLength: 10,
        titleMaxLength: 100,
      });
    });
  });

  describe("getLinkFlair", () => {
    it("reads the v2 id/text shape", async () => {
      fetchMock().mockResolvedValue(jsonResponse(200, [{ id: "f1", text: "Discussion" }]));
      await expect(getLinkFlair("saas")).resolves.toEqual([{ id: "f1", text: "Discussion" }]);
    });

    it("also reads the legacy flair_template_id/flair_text shape", async () => {
      fetchMock().mockResolvedValue(jsonResponse(200, [{ flair_template_id: "f2", flair_text: "Question" }]));
      await expect(getLinkFlair("saas")).resolves.toEqual([{ id: "f2", text: "Question" }]);
    });

    it("drops an entry matching neither shape rather than guessing", async () => {
      fetchMock().mockResolvedValue(jsonResponse(200, [{ somethingElse: true }, { id: "f1", text: "ok" }]));
      await expect(getLinkFlair("saas")).resolves.toEqual([{ id: "f1", text: "ok" }]);
    });

    it("returns [] when the response is not an array, rather than throwing", async () => {
      fetchMock().mockResolvedValue(jsonResponse(200, { unexpected: "shape" }));
      await expect(getLinkFlair("saas")).resolves.toEqual([]);
    });
  });

  describe("getMe", () => {
    it("returns id/name", async () => {
      fetchMock().mockResolvedValue(jsonResponse(200, { id: "t2_abc", name: "examplebrand" }));
      await expect(getMe()).resolves.toEqual({ id: "t2_abc", name: "examplebrand" });
    });

    it("throws when the response has no id/name", async () => {
      fetchMock().mockResolvedValue(jsonResponse(200, {}));
      await expect(getMe()).rejects.toThrow(/no id\/name/);
    });
  });
});
