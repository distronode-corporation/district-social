import { describe, it, expect, vi, beforeEach } from "vitest";

// The transport is a business-logic layer on top of the vendor client, so it
// is tested against a mocked client -- pinterest-transport.test.ts's own
// pattern for pinterest.ts, x-transport.test.ts's for x.ts. RedditError /
// RedditApiError / isRedditNotFound stay real: they are exactly what the
// error-shape tests below are checking.
vi.mock("../reddit.js", async (importActual) => {
  const actual = await importActual<typeof import("../reddit.js")>();
  return {
    ...actual,
    submitPost: vi.fn(),
    deleteThing: vi.fn(),
    getInfo: vi.fn(),
    getMe: vi.fn(),
    getSubredditAbout: vi.fn(),
    getPostRequirements: vi.fn(),
    getLinkFlair: vi.fn(),
    getPostStats: vi.fn(),
  };
});

import {
  RedditError,
  submitPost,
  deleteThing,
  getInfo,
  getMe,
  getSubredditAbout,
  getPostRequirements,
  getLinkFlair,
  getPostStats,
} from "../reddit.js";
import { redditTransport } from "../reddit-transport.js";
import type { DirectPublishInput, PublishDestination } from "../transport.js";
import type { MediaAsset, PlatformRender } from "../types.js";

const submitPostMock = submitPost as unknown as ReturnType<typeof vi.fn>;
const deleteThingMock = deleteThing as unknown as ReturnType<typeof vi.fn>;
const getInfoMock = getInfo as unknown as ReturnType<typeof vi.fn>;
const getMeMock = getMe as unknown as ReturnType<typeof vi.fn>;
const getPostStatsMock = getPostStats as unknown as ReturnType<typeof vi.fn>;
const getSubredditAboutMock = getSubredditAbout as unknown as ReturnType<typeof vi.fn>;
const getPostRequirementsMock = getPostRequirements as unknown as ReturnType<typeof vi.fn>;
const getLinkFlairMock = getLinkFlair as unknown as ReturnType<typeof vi.fn>;

function render(overrides: Partial<PlatformRender> = {}): PlatformRender {
  return { platform: "reddit", content: "genuinely useful post body", title: "A useful title", mediaIndices: [], ...overrides };
}

function destination(overrides: Partial<PublishDestination> = {}): PublishDestination {
  return { subreddit: "saas", ...overrides };
}

function input(overrides: Partial<DirectPublishInput> = {}): DirectPublishInput {
  return { render: render(), media: [], draftId: "draft-1", destination: destination(), ...overrides };
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

beforeEach(() => {
  submitPostMock.mockReset();
  deleteThingMock.mockReset();
  getInfoMock.mockReset();
  getMeMock.mockReset();
  getPostStatsMock.mockReset();
  getSubredditAboutMock.mockReset();
  getPostRequirementsMock.mockReset();
  getLinkFlairMock.mockReset();
});

describe("reddit transport", () => {
  it("declares the real vendor limits (self-post body cap, title constraints not part of this interface)", () => {
    expect(redditTransport.channelRules()).toMatchObject({
      maxLength: 40_000,
      countMode: "utf16",
      maxImages: 20,
    });
  });

  describe("connectStatus", () => {
    it("reports connected with the account's id/username", async () => {
      getMeMock.mockResolvedValue({ id: "t2_abc", name: "examplebrand" });
      const status = await redditTransport.connectStatus();
      expect(status).toEqual({ connected: true, accountId: "t2_abc", displayName: "examplebrand" });
    });

    it("resolves with connected:false and a reason instead of rejecting on a bad credential", async () => {
      getMeMock.mockRejectedValue(new RedditError(401, "invalid_token", "GET", "/api/v1/me"));
      const status = await redditTransport.connectStatus();
      expect(status.connected).toBe(false);
      expect(status.accountId).toBe("");
      expect(status.reason).toMatch(/invalid_token/);
    });

    /**
     * ⚠️ Not every rejection is an Error. An aborted timeout deep in the fetch
     * stack, or any dependency that rejects with a bare value, has no
     * `.message`, and reading one yields `undefined`. The connections screen
     * shows `reason` verbatim, so an undefined reason renders as a disconnected
     * account with no explanation at all, which is the least actionable thing
     * this surface can say. ⛔ Reddit is aggregator-only until API access is
     * approved (the application has been rejected twice), so a broken
     * credential here is the EXPECTED steady state and its message is the only
     * thing distinguishing "not approved yet" from "something else broke".
     */
    it("states a non-Error rejection as text rather than reporting an empty reason", async () => {
      getMeMock.mockRejectedValue("socket hang up");
      const status = await redditTransport.connectStatus();
      expect(status.connected).toBe(false);
      expect(status.reason).toBe("socket hang up");
    });
  });

  describe("postUrl", () => {
    it("builds the redd.it short link from a fullname, stripping the t3_ prefix", () => {
      expect(redditTransport.postUrl("t3_1abcde")).toBe("https://redd.it/1abcde");
    });

    it("works even if given a bare id with no prefix", () => {
      expect(redditTransport.postUrl("1abcde")).toBe("https://redd.it/1abcde");
    });
  });

  describe("publishNow", () => {
    it("posts a SELF post when destination has no link: sends render.content as text, no url", async () => {
      submitPostMock.mockResolvedValue({ id: "1abcde", name: "t3_1abcde" });

      const result = await redditTransport.publishNow(input());

      expect(submitPostMock).toHaveBeenCalledWith(
        expect.objectContaining({
          subreddit: "saas",
          title: "A useful title",
          kind: "self",
          text: "genuinely useful post body",
        }),
      );
      expect(submitPostMock.mock.calls[0][0]).not.toHaveProperty("url");
      expect(result).toEqual({ ref: "t3_1abcde", url: "https://redd.it/1abcde" });
    });

    /**
     * The valuable case the aggregator path never produced (publish.ts's
     * platformSettings always sent Reddit as a self/media post, never link --
     * see reddit-transport.ts's own header docblock). destination.link
     * present means "post this as a link", and render.content must NOT be
     * sent, because Reddit's link kind has no body field at all.
     */
    /**
     * ⛔ A LINK IS NOT ENOUGH TO CHOOSE A LINK POST.
     *
     * Reddit's link kind has no body field, so selecting it merely because a
     * link exists would discard render.content — the entire post — silently, on
     * the one platform where the body IS the value. Reddit renders links
     * clickably inside a self post, so keeping the copy costs nothing.
     */
    it("stays a SELF post when there is copy, even with a link present", async () => {
      submitPostMock.mockResolvedValue({ id: "2", name: "t3_2" });

      await redditTransport.publishNow(input({ destination: destination({ link: "https://example.com/blog" }) }));

      expect(submitPostMock).toHaveBeenCalledWith(expect.objectContaining({ kind: "self" }));
      expect(submitPostMock.mock.calls[0][0]).not.toHaveProperty("url");
      expect(submitPostMock.mock.calls[0][0].text).toBeTruthy();
    });

    it("falls back to a LINK post only when there is no copy to lose", async () => {
      submitPostMock.mockResolvedValue({ id: "2", name: "t3_2" });

      await redditTransport.publishNow(
        input({
          render: render({ content: "   " }),
          destination: destination({ link: "https://example.com/blog" }),
        }),
      );

      expect(submitPostMock).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "link", url: "https://example.com/blog" }),
      );
      expect(submitPostMock.mock.calls[0][0]).not.toHaveProperty("text");
    });

    it("sends flair id/name from destination.flair", async () => {
      submitPostMock.mockResolvedValue({ id: "1", name: "t3_1" });
      await redditTransport.publishNow(
        input({ destination: destination({ flair: { id: "f1", name: "Discussion" } }) }),
      );
      expect(submitPostMock).toHaveBeenCalledWith(
        expect.objectContaining({ flairId: "f1", flairText: "Discussion" }),
      );
    });

    it("falls back to render.flair when destination carries none", async () => {
      submitPostMock.mockResolvedValue({ id: "1", name: "t3_1" });
      await redditTransport.publishNow(
        input({ render: render({ flair: { id: "f2", name: "Question" } }) }),
      );
      expect(submitPostMock).toHaveBeenCalledWith(
        expect.objectContaining({ flairId: "f2", flairText: "Question" }),
      );
    });

    it("throws before calling the vendor when no subreddit is resolvable", async () => {
      await expect(
        redditTransport.publishNow(input({ destination: destination({ subreddit: undefined }), render: render({ subreddit: undefined }) })),
      ).rejects.toThrow(/no destination subreddit/);
      expect(submitPostMock).not.toHaveBeenCalled();
    });

    it("throws before calling the vendor when no title is set", async () => {
      await expect(
        redditTransport.publishNow(input({ render: render({ title: undefined }) })),
      ).rejects.toThrow(/needs a title/);
      expect(submitPostMock).not.toHaveBeenCalled();
    });

    /**
     * Reddit's own media submission flow needs an S3-presigned upload this
     * migration did not build (reddit.ts / reddit-transport.ts docblocks) --
     * refused loudly, before any network call, rather than silently posting
     * a text-only submission that drops the attachment.
     */
    /**
     * ⚠️ THIS USED TO BE A HARD REFUSAL, and that made the transport dead on
     * arrival: pickMediaForPlatform attaches the generated card to EVERY
     * platform's render including Reddit, and Social HQ generates a card for
     * essentially every draft, so refusing on attached media would have failed
     * every Reddit publish forever while looking like a per-draft problem.
     *
     * Reddit's media upload genuinely is not implemented (its flow appears
     * nowhere in Reddit's public API reference), so the asset really is
     * dropped. It is dropped LOUDLY, and the copy — which is the payload on
     * this platform — still goes out.
     */
    it("warns and posts the copy anyway when media is attached, rather than refusing", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      submitPostMock.mockResolvedValue({ id: "1", name: "t3_1" });

      await redditTransport.publishNow(input({ media: [image()] }));

      expect(submitPostMock).toHaveBeenCalledWith(expect.objectContaining({ kind: "self" }));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("will NOT be uploaded"));
      warn.mockRestore();
    });

    it("normalizes a /r/-prefixed subreddit on the render (defensive, mirrors publishDestination's own normalizeSubreddit call)", async () => {
      submitPostMock.mockResolvedValue({ id: "1", name: "t3_1" });
      await redditTransport.publishNow(
        input({ destination: destination({ subreddit: undefined }), render: render({ subreddit: "/r/SaaS" }) }),
      );
      expect(submitPostMock).toHaveBeenCalledWith(expect.objectContaining({ subreddit: "saas" }));
    });
  });

  describe("deletePost", () => {
    it("deletes normally when the post still exists", async () => {
      deleteThingMock.mockResolvedValue(undefined);
      await expect(redditTransport.deletePost("t3_1abcde")).resolves.toBeUndefined();
    });

    /**
     * Reddit's own POST /api/del documents no error shape at all for an
     * already-gone id (reddit.ts's deleteThing docblock) -- so idempotency
     * here is the vendor's own behaviour, not a branch this transport adds.
     * Modelled by having the mock simply resolve, exactly as the real
     * endpoint is documented (and, per the docblock, observed) to do.
     */
    it("treats a redelete of an already-gone post as SUCCESS, not a failure", async () => {
      deleteThingMock.mockResolvedValue(undefined);
      await expect(redditTransport.deletePost("t3_gone")).resolves.toBeUndefined();
    });

    it("still throws for a real failure (e.g. auth), not just swallowing everything", async () => {
      deleteThingMock.mockRejectedValue(new RedditError(401, "token expired", "POST", "/api/del"));
      await expect(redditTransport.deletePost("t3_1")).rejects.toThrow(/token expired/);
    });
  });

  describe("postFacts", () => {
    it("maps a found post to PUBLISHED/released", async () => {
      getInfoMock.mockResolvedValue(new Set(["t3_1"]));
      const facts = await redditTransport.postFacts(["t3_1"]);
      expect(facts.get("t3_1")).toEqual({ state: "PUBLISHED", released: true, platform: "reddit" });
    });

    /**
     * Reddit's api/info gives no unambiguous "this does not exist" signal
     * (reddit.ts's getInfo docblock) -- unlike Pinterest's confirmed 404 or
     * X's confirmed resource-not-found, an omission here could mean deleted,
     * never existed, or simply invisible to this token for an unrelated
     * reason. `absent` must stay unset.
     */
    it("maps a post NOT in the result to QUEUE WITHOUT absent (unlike pinterest/x's confirmed-not-found cases)", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      getInfoMock.mockResolvedValue(new Set());
      const facts = await redditTransport.postFacts(["t3_gone"]);
      expect(facts.get("t3_gone")).toEqual({ state: "QUEUE", released: false, platform: "reddit" });
      expect(facts.get("t3_gone")).not.toHaveProperty("absent");
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it("maps an unreachable vendor (lookup throws) to QUEUE for the whole batch, never ERROR", async () => {
      getInfoMock.mockRejectedValue(new RedditError(503, "upstream unavailable", "GET", "/api/info"));
      const facts = await redditTransport.postFacts(["t3_a", "t3_b"]);
      expect(facts.get("t3_a")).toEqual({ state: "QUEUE", released: false, platform: "reddit" });
      expect(facts.get("t3_b")).toEqual({ state: "QUEUE", released: false, platform: "reddit" });
    });

    /**
     * ⛔ QUEUE, NOT ERROR, EVEN WHEN THE FAILURE NEVER REACHED REDDIT. A DNS
     * failure or an aborted socket rejects with something that is not a
     * RedditError, and it is the LEAST informative kind of failure about whether
     * the post exists. Narrowing the catch to RedditError would let one escape
     * postFacts and surface as a thrown reconcile, which reads as a broken leg;
     * ERROR is terminal and loses the post. The reason still has to be legible,
     * which is what the String() arm is for.
     */
    it("maps a transport-level failure (not even a vendor error) to QUEUE, with the reason still legible", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      getInfoMock.mockRejectedValue(new TypeError("fetch failed"));

      const facts = await redditTransport.postFacts(["t3_a"]);

      expect(facts.get("t3_a")).toEqual({ state: "QUEUE", released: false, platform: "reddit" });
      expect(facts.get("t3_a")).not.toHaveProperty("absent");
      expect(String(warn.mock.calls[0]?.[0])).toContain("TypeError: fetch failed");
      warn.mockRestore();
    });

    it("returns an empty map for an empty ref list without calling the vendor", async () => {
      const facts = await redditTransport.postFacts([]);
      expect(facts.size).toBe(0);
      expect(getInfoMock).not.toHaveBeenCalled();
    });

    /**
     * The partial-failure case, and the reason postFacts chunks at
     * INFO_BATCH_LIMIT itself instead of handing getInfo the whole list.
     *
     * getInfo chunks internally with no per-chunk try/catch, so ONE failing
     * request rejected the entire call and the catch marked every ref QUEUE —
     * including posts an earlier chunk had already confirmed exist. On a large
     * outstanding-legs list, one flaky request discarded every confirmation in
     * the sweep and sent all of them round again.
     *
     * 101 refs is the smallest input that crosses the 100 boundary, so this
     * fails against the old single-call implementation and passes now.
     */
    it("keeps confirmations from a batch that succeeded when a LATER batch fails", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const refs = Array.from({ length: 101 }, (_, i) => `t3_${i}`);

      getInfoMock
        .mockResolvedValueOnce(new Set(refs.slice(0, 100))) // first 100: all confirmed live
        .mockRejectedValueOnce(new RedditError(503, "upstream unavailable", "GET", "/api/info"));

      const facts = await redditTransport.postFacts(refs);

      expect(getInfoMock).toHaveBeenCalledTimes(2);
      // Confirmed posts survive the unrelated failure.
      expect(facts.get("t3_0")).toEqual({ state: "PUBLISHED", released: true, platform: "reddit" });
      expect(facts.get("t3_99")).toEqual({ state: "PUBLISHED", released: true, platform: "reddit" });
      // Only the batch we genuinely could not ask about is unknown.
      expect(facts.get("t3_100")).toEqual({ state: "QUEUE", released: false, platform: "reddit" });
      expect([...facts.values()].filter((f) => f.state === "PUBLISHED")).toHaveLength(100);
      warn.mockRestore();
    });

    /**
     * A ref settled by a FAILED batch must not fall through to the omission
     * branch, which reports the same verdict for a different reason and would
     * log "was not in the api/info result" for a post nobody managed to ask
     * about. Same state, wrong explanation, and the log is the only thing an
     * operator has to tell the two apart.
     */
    it("does not relabel a failed batch's refs as vendor omissions", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      getInfoMock.mockRejectedValue(new RedditError(503, "down", "GET", "/api/info"));

      await redditTransport.postFacts(["t3_a"]);

      const messages = warn.mock.calls.map((c) => String(c[0]));
      expect(messages.some((m) => m.includes("lookup failed"))).toBe(true);
      expect(messages.some((m) => m.includes("was not in the api/info result"))).toBe(false);
      warn.mockRestore();
    });
  });

  describe("destinationRules", () => {
    it("merges about + post_requirements + flair into one result", async () => {
      getSubredditAboutMock.mockResolvedValue({ displayName: "SaaS", submissionType: "any" });
      getPostRequirementsMock.mockResolvedValue({ isFlairRequired: true, bodyRestrictionPolicy: "none" });
      getLinkFlairMock.mockResolvedValue([{ id: "f1", text: "Discussion" }]);

      const rules = await redditTransport.destinationRules!("saas");

      expect(rules).toMatchObject({
        subreddit: "saas",
        submissionType: "any",
        allowSelf: true,
        allowLink: true,
        isFlairRequired: true,
        flairs: [{ id: "f1", text: "Discussion" }],
      });
    });

    it("derives allowSelf/allowLink from a restrictive submission_type", async () => {
      getSubredditAboutMock.mockResolvedValue({ submissionType: "self" });
      getPostRequirementsMock.mockResolvedValue({});
      getLinkFlairMock.mockResolvedValue([]);
      const rules = await redditTransport.destinationRules!("saas");
      expect(rules).toMatchObject({ allowSelf: true, allowLink: false });
    });

    /**
     * ⛔ The title-length rules are the whole reason a preflight would call this,
     * and they are OPTIONAL on the vendor's own response. Copying them
     * unconditionally would put `titleMinLength: undefined` into the result,
     * which a caller comparing `title.length < rules.titleMinLength` reads as
     * "no minimum" in exactly the same way a genuinely absent key does, right
     * up until someone writes `"titleMinLength" in rules` and gets the wrong
     * answer. Present means present.
     */
    it("carries the subreddit's title length limits through when post_requirements states them", async () => {
      getSubredditAboutMock.mockResolvedValue({ submissionType: "any" });
      getPostRequirementsMock.mockResolvedValue({
        isFlairRequired: false,
        bodyRestrictionPolicy: "none",
        titleMinLength: 12,
        titleMaxLength: 300,
      });
      getLinkFlairMock.mockResolvedValue([]);

      const rules = await redditTransport.destinationRules!("saas");

      expect(rules.titleMinLength).toBe(12);
      expect(rules.titleMaxLength).toBe(300);
    });

    /**
     * ⚠️ The mirror of the case above, and the reason both `if`s exist: a
     * subreddit that states no title limits must leave the KEYS off entirely
     * rather than setting them to undefined.
     */
    it("leaves the title length keys off entirely when the subreddit states no limits", async () => {
      getSubredditAboutMock.mockResolvedValue({ submissionType: "any" });
      getPostRequirementsMock.mockResolvedValue({ isFlairRequired: false, bodyRestrictionPolicy: "none" });
      getLinkFlairMock.mockResolvedValue([]);

      const rules = await redditTransport.destinationRules!("saas");

      expect(rules).not.toHaveProperty("titleMinLength");
      expect(rules).not.toHaveProperty("titleMaxLength");
    });

    /**
     * ⛔ Refused before any network call. `normalizeSubreddit` strips the `/r/`
     * prefix and the slashes, so a caller passing `"/r/"` (or an empty string,
     * or a non-string out of loosely validated input) leaves nothing behind. A
     * request built on that would ask Reddit about a blank subreddit and come
     * back with a far less specific error than the caller's own bad argument.
     */
    it("refuses an unusable subreddit name without asking the vendor", async () => {
      await expect(redditTransport.destinationRules!("/r/")).rejects.toThrow(/not a usable subreddit name/);
      expect(getSubredditAboutMock).not.toHaveBeenCalled();
    });

    it("propagates a genuinely nonexistent subreddit (about lookup 404s) rather than reporting empty rules", async () => {
      getSubredditAboutMock.mockRejectedValue(new RedditError(404, "not found", "GET", "/r/x/about"));
      await expect(redditTransport.destinationRules!("doesnotexist")).rejects.toThrow(/does not exist/);
    });

    /**
     * ⚠️ Only a 404 means "no such subreddit". A 401, a 429 or a socket failure
     * says nothing about whether r/saas exists, and rewriting one into "does not
     * exist" would send an operator off to check a subreddit name that was never
     * the problem. The original error has to survive the catch intact.
     */
    it("rethrows a non-404 about failure unchanged rather than calling the subreddit missing", async () => {
      const thrown = new RedditError(429, "rate limited", "GET", "/r/saas/about");
      getSubredditAboutMock.mockRejectedValue(thrown);

      // The SAME error object, not a rewritten one: the status and endpoint are
      // what tell an operator this was a rate limit rather than a bad name.
      await expect(redditTransport.destinationRules!("saas")).rejects.toBe(thrown);
    });

    it("still returns the about-derived rules when post_requirements fails (needs a scope this token may lack)", async () => {
      getSubredditAboutMock.mockResolvedValue({ submissionType: "any" });
      getPostRequirementsMock.mockRejectedValue(new RedditError(403, "insufficient scope", "GET", "/api/v1/saas/post_requirements"));
      getLinkFlairMock.mockResolvedValue([]);
      const rules = await redditTransport.destinationRules!("saas");
      expect(rules).toMatchObject({ subreddit: "saas", submissionType: "any" });
      expect(rules).not.toHaveProperty("isFlairRequired");
    });

    it("still returns the about-derived rules when the flair lookup fails", async () => {
      getSubredditAboutMock.mockResolvedValue({ submissionType: "any" });
      getPostRequirementsMock.mockResolvedValue({});
      getLinkFlairMock.mockRejectedValue(new RedditError(403, "insufficient scope", "GET", "/r/saas/api/link_flair_v2"));
      const rules = await redditTransport.destinationRules!("saas");
      expect(rules).not.toHaveProperty("flairs");
    });

    /**
     * ⚠️ Both best-effort lookups log `err instanceof Error ? err.message : err`,
     * and the second arm is not decoration: a rejection that is not an Error has
     * no `.message`, so without it the warning would read "... leaving
     * flair/body-policy unknown: undefined" and throw away the only description
     * of what went wrong. These two lookups are the ones expected to fail in
     * normal operation (they need `submit` and `flair` scopes the injected token
     * may not carry), so their warning is the whole diagnostic.
     */
    it("logs a non-Error lookup failure as itself rather than as undefined", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      getSubredditAboutMock.mockResolvedValue({ submissionType: "any" });
      getPostRequirementsMock.mockRejectedValue("scope missing");
      getLinkFlairMock.mockRejectedValue("scope missing too");

      const rules = await redditTransport.destinationRules!("saas");

      // Degraded, not failed: the about-derived rules still come back.
      expect(rules).toMatchObject({ subreddit: "saas", submissionType: "any" });
      expect(rules).not.toHaveProperty("isFlairRequired");
      expect(rules).not.toHaveProperty("flairs");

      const secondArgs = warn.mock.calls.map((c) => c[1]);
      expect(secondArgs).toContain("scope missing");
      expect(secondArgs).toContain("scope missing too");
      expect(secondArgs).not.toContain(undefined);
      warn.mockRestore();
    });
  });
});

describe("reddit analytics", () => {
  it("reports score, comments and upvote ratio off /api/info", async () => {
    getPostStatsMock.mockResolvedValue([{ name: "t3_a", score: 42, comments: 7, upvoteRatio: 0.93 }]);
    await expect(redditTransport.analyticsPost!("t3_a")).resolves.toEqual({
      score: 42,
      comments: 7,
      upvoteRatio: 0.93,
    });
  });

  it("omits a counter the listing did not carry", async () => {
    getPostStatsMock.mockResolvedValue([{ name: "t3_a", score: 42 }]);
    const stats = await redditTransport.analyticsPost!("t3_a");
    expect(stats).toEqual({ score: 42 });
    expect("comments" in stats).toBe(false);
  });

  /**
   * ⛔ Score is not privileged either, and this one matters more than the other
   * counters: Reddit FUZZES vote counts by design, so a listing that omits
   * `score` is a real and expected shape. Defaulting it to 0 would put a
   * fabricated "no upvotes" on a post that may be doing fine, and a zero is
   * indistinguishable from a measurement on a chart.
   */
  it("omits score entirely when the listing carried the other counters but not that one", async () => {
    getPostStatsMock.mockResolvedValue([{ name: "t3_a", comments: 7, upvoteRatio: 0.91 }]);
    const stats = await redditTransport.analyticsPost!("t3_a");
    expect(stats).toEqual({ comments: 7, upvoteRatio: 0.91 });
    expect("score" in stats).toBe(false);
  });

  it("returns an empty bag for a post the vendor said nothing about", async () => {
    getPostStatsMock.mockResolvedValue([]);
    await expect(redditTransport.analyticsPost!("t3_gone")).resolves.toEqual({});
  });

  it("reports karma as channel analytics", async () => {
    getMeMock.mockResolvedValue({ id: "t2_a", name: "examplebrand", linkKarma: 10, commentKarma: 5, totalKarma: 15 });
    await expect(redditTransport.analyticsChannel!()).resolves.toEqual({
      linkKarma: 10,
      commentKarma: 5,
      totalKarma: 15,
    });
  });

  /**
   * The karma field NAMES are [unverified] — /dev/api publishes no response
   * schema for /api/v1/me. Reading them defensively means a wrong guess
   * degrades to "no data" rather than to a fabricated zero.
   */
  it("degrades to an empty bag when the profile carries no karma fields", async () => {
    getMeMock.mockResolvedValue({ id: "t2_a", name: "examplebrand" });
    await expect(redditTransport.analyticsChannel!()).resolves.toEqual({});
  });

  /**
   * ⛔ Deliberately absent. Reddit accounts have no follower count on /api/v1/me,
   * and deriving one from karma would be a fabricated metric wearing the name of
   * a real one. The interface marks the method optional so a platform can
   * decline it.
   */
  it("declines followerStats rather than inventing a number from karma", () => {
    expect(redditTransport.followerStats).toBeUndefined();
  });
});
