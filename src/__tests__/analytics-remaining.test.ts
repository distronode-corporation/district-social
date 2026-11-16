import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Coverage for the last five analytics implementations: Instagram, Facebook,
 * LinkedIn, Pinterest and X. Bluesky, YouTube, Reddit and Threads are covered
 * by their own client tests.
 *
 * One file rather than five because the interesting assertions are the SHARED
 * contract every platform in this family has to honour, and keeping them
 * adjacent is what makes a platform that quietly breaks one of them obvious:
 *
 *   1. an unreadable metric is ABSENT, never 0
 *   2. a vendor-reported 0 IS kept, because that is a real datum
 *   3. followerStats THROWS when the count is missing, rather than fabricating
 *      a 0 that reads as an account which lost its entire audience
 *   4. metric keys stay the vendor's own names, unrenamed
 *
 * Rules 1 and 2 are tested against each other on purpose: collapsing them is
 * the easy mistake, and it is invisible on a dashboard.
 */

import { setMetaCredentialsResolver, IG_MEDIA_METRICS, FB_POST_METRICS, FB_PAGE_METRICS } from "../meta-graph.js";
import { instagramTransport } from "../instagram-transport.js";
import { FB_REEL_METRICS, facebookTransport } from "../facebook-transport.js";
import { LinkedInError, setLinkedInTokenResolver, setLinkedInOrganizationId } from "../linkedin.js";
import { linkedinTransport } from "../linkedin-transport.js";
import { setPinterestTokenResolver, PINTEREST_PIN_METRICS } from "../pinterest.js";
import { pinterestTransport } from "../pinterest-transport.js";
import { setXTokenResolver } from "../x.js";
import { xTransport } from "../x-transport.js";
import { FIXTURE_LINKEDIN_ORG, FIXTURE_LINKEDIN_POST_ID, FIXTURE_LINKEDIN_SHARE_URN } from "./helpers/fixtures.js";

const PAGE_ID = "1122334455";
const IG_USER_ID = "17841400000000000";
const ORG_ID = FIXTURE_LINKEDIN_ORG;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => jsonResponse({}));
  vi.stubGlobal("fetch", fetchMock);
  setMetaCredentialsResolver(async () => ({
    appSecret: "meta-secret",
    pageToken: "page-token",
    pageId: PAGE_ID,
    igUserId: IG_USER_ID,
  }));
  setLinkedInTokenResolver(async () => "li-token");
  setLinkedInOrganizationId(ORG_ID);
  setPinterestTokenResolver(async () => "pin-token");
  setXTokenResolver(async () => "x-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  setMetaCredentialsResolver(null);
  setLinkedInTokenResolver(null);
  setLinkedInOrganizationId(null);
  setPinterestTokenResolver(null);
  setXTokenResolver(null);
});

const lastUrl = () => String(fetchMock.mock.calls.at(-1)![0]);

/* -------------------------------------------------------------------------- */
/*  Instagram                                                                  */
/* -------------------------------------------------------------------------- */

describe("instagram analytics", () => {
  it("parses the values[] shape media insights actually return", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: [{ name: "reach", values: [{ value: 41 }] }, { name: "likes", values: [{ value: 7 }] }] }),
    );
    await expect(instagramTransport.analyticsPost!("m1")).resolves.toEqual({ reach: 41, likes: 7 });
  });

  it("parses the total_value shape account insights return", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [{ name: "views", total_value: { value: 900 } }] }));
    await expect(instagramTransport.analyticsChannel!()).resolves.toEqual({ views: 900 });
  });

  it("⛔ never asks for the deprecated `impressions` metric", () => {
    // On v22.0+ `impressions` returns an ERROR for media created after
    // 2024-07-02, and Meta fails the WHOLE call on one bad metric, so
    // including it would take every other counter down with it, not just drop a
    // field. It is still the metric the public docs example shows.
    expect(IG_MEDIA_METRICS).not.toContain("impressions");
  });

  it("⛔ never asks Facebook for a retired impressions metric (any one fails the whole call)", () => {
    // Retired for every API version (Meta deprecated-metrics page, 2025-06-15 and
    // 2025-11-15; v25.0 announcement for video_insights). Asking for one made
    // Graph reject the call, which blanked every Facebook number.
    const retired = [
      "post_impressions",
      "post_impressions_unique",
      "post_engaged_users",
      "page_impressions",
      "page_impressions_unique",
    ];
    for (const list of [FB_POST_METRICS, FB_PAGE_METRICS, FB_REEL_METRICS]) {
      for (const name of retired) expect(list).not.toContain(name);
    }
    // The documented replacements (each list verified live as one call).
    expect(FB_POST_METRICS).toEqual(["post_media_view", "post_total_media_view_unique", "post_clicks"]);
    expect(FB_PAGE_METRICS).toEqual(["page_media_view", "page_total_media_view_unique", "page_post_engagements"]);
  });

  it("keeps a vendor-reported zero but drops an unreadable value", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: [
          { name: "likes", values: [{ value: 0 }] },
          { name: "shares", values: [{ value: null }] },
          { name: "saved" },
        ],
      }),
    );
    // 0 survives (a real datum); null and missing are absent, NOT coerced to 0.
    await expect(instagramTransport.analyticsPost!("m1")).resolves.toEqual({ likes: 0 });
  });

  it("reads followers from the user FIELD, not the daily-delta insight", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ followers_count: 5120 }));
    await expect(instagramTransport.followerStats!()).resolves.toEqual({ followers: 5120 });
    // follower_count (singular) is a per-day change on the insights edge and
    // would report a day's movement as the whole audience.
    expect(lastUrl()).toContain("fields=followers_count");
    expect(lastUrl()).not.toContain("/insights");
  });

  it("throws rather than reporting 0 followers when the field is missing", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    await expect(instagramTransport.followerStats!()).rejects.toThrow(/Refusing to report 0/);
  });
});

/* -------------------------------------------------------------------------- */
/*  Facebook                                                                   */
/* -------------------------------------------------------------------------- */

describe("facebook analytics", () => {
  it("requests page-post metrics under their own post_ namespace", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [{ name: "post_media_view", values: [{ value: 88 }] }] }));
    await expect(facebookTransport.analyticsPost!(`${PAGE_ID}_999`)).resolves.toEqual({ post_media_view: 88 });
    expect(lastUrl()).toContain(`/${PAGE_ID}_999/insights?`);
    expect(lastUrl()).toContain(`metric=${encodeURIComponent(FB_POST_METRICS.join(","))}`);
  });

  it("reads a Reel's counters from its video node, under the Reels metric names", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: [
          { name: "blue_reels_play_count", values: [{ value: 41 }] },
          { name: "fb_reels_replay_count", values: [{ value: 0 }] },
          { name: "post_video_retention_graph", values: [{ value: { "0": 1 } }] },
        ],
      }),
    );
    // 0 is kept (a real datum); the non-scalar row is absent, never 0.
    await expect(facebookTransport.analyticsPost!("reel:778899")).resolves.toEqual({
      blue_reels_play_count: 41,
      fb_reels_replay_count: 0,
    });
    expect(lastUrl()).toContain("/778899/video_insights?");
    expect(lastUrl()).toContain(`metric=${encodeURIComponent(FB_REEL_METRICS.join(","))}`);
    expect(lastUrl()).toContain("appsecret_proof=");
    expect(lastUrl()).not.toContain("post_media_view");
  });

  it("returns an empty bag when a Reel's insights carry no data array", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    await expect(facebookTransport.analyticsPost!("reel:778899")).resolves.toEqual({});
  });

  it("sends period=day for page insights, which Meta requires", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));
    await facebookTransport.analyticsChannel!();
    expect(lastUrl()).toContain("period=day");
    expect(lastUrl()).toContain(`metric=${encodeURIComponent(FB_PAGE_METRICS.join(","))}`);
  });

  it("reads followers_count, not fan_count", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ followers_count: 77 }));
    await expect(facebookTransport.followerStats!()).resolves.toEqual({ followers: 77 });
    // Fans (Page likes) and followers diverged once following became separate;
    // falling back to fan_count would silently answer a different question.
    expect(lastUrl()).toContain("fields=followers_count");
    expect(lastUrl()).not.toContain("fan_count");
  });

  it("throws rather than reporting 0 followers when the field is missing", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    await expect(facebookTransport.followerStats!()).rejects.toThrow(/Refusing to report 0/);
  });
});

/* -------------------------------------------------------------------------- */
/*  LinkedIn                                                                   */
/* -------------------------------------------------------------------------- */

describe("linkedin analytics", () => {
  const SHARE = FIXTURE_LINKEDIN_SHARE_URN;

  /**
   * analyticsPost fires share statistics and socialActions concurrently, so
   * which fetch lands first is not something to assert on. Answer by URL.
   */
  function routeLinkedIn(answers: { stats: () => Response; actions: () => Response }): void {
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes("/organizationalEntityShareStatistics") ? answers.stats() : answers.actions(),
    );
  }

  const statsFor = (urn: string, totals: Record<string, unknown>) => () =>
    jsonResponse({ elements: [{ organizationalEntity: `urn:li:organization:${ORG_ID}`, share: urn, totalShareStatistics: totals }] });

  it("flattens socialActions summaries into vendor-named counters", async () => {
    routeLinkedIn({
      stats: () => jsonResponse({}),
      actions: () => jsonResponse({ likesSummary: { totalLikes: 12 }, commentsSummary: { aggregatedTotalComments: 3 } }),
    });
    await expect(linkedinTransport.analyticsPost!(SHARE)).resolves.toEqual({
      totalLikes: 12,
      aggregatedTotalComments: 3,
    });
  });

  /**
   * A post LinkedIn leaves out of the elements
   * reads as zeros on every documented field, next to the feed counts.
   */
  it("reports zeros for a post share statistics left out, beside its socialActions counts", async () => {
    routeLinkedIn({
      stats: () => jsonResponse({ elements: [] }),
      actions: () => jsonResponse({ likesSummary: { totalLikes: 0 }, commentsSummary: { aggregatedTotalComments: 0 } }),
    });
    await expect(linkedinTransport.analyticsPost!(SHARE)).resolves.toEqual({
      clickCount: 0,
      commentCount: 0,
      engagement: 0,
      impressionCount: 0,
      likeCount: 0,
      shareCount: 0,
      uniqueImpressionsCount: 0,
      totalLikes: 0,
      aggregatedTotalComments: 0,
    });
  });

  it("keeps a zero but drops a missing summary", async () => {
    routeLinkedIn({ stats: () => jsonResponse({}), actions: () => jsonResponse({ likesSummary: { totalLikes: 0 } }) });
    await expect(linkedinTransport.analyticsPost!(SHARE)).resolves.toEqual({ totalLikes: 0 });
  });

  /**
   * The point of the change: impressions, clicks and engagement per post, under
   * LinkedIn's own names, next to the feed counts from socialActions. Keys never
   * collide, so neither source overwrites the other.
   */
  it("merges the post's share statistics with its socialActions counts, unrenamed", async () => {
    routeLinkedIn({
      stats: statsFor(SHARE, {
        impressionCount: 5287,
        uniqueImpressionsCount: 4100,
        clickCount: 78,
        engagement: 0.022886324947985624,
        likeCount: 14,
        commentCount: 24,
        shareCount: 0,
      }),
      actions: () => jsonResponse({ likesSummary: { totalLikes: 15 }, commentsSummary: { aggregatedTotalComments: 24 } }),
    });
    await expect(linkedinTransport.analyticsPost!(SHARE)).resolves.toEqual({
      impressionCount: 5287,
      uniqueImpressionsCount: 4100,
      clickCount: 78,
      engagement: 0.022886324947985624,
      likeCount: 14,
      commentCount: 24,
      shareCount: 0,
      totalLikes: 15,
      aggregatedTotalComments: 24,
    });
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls).toContain(
      `https://api.linkedin.com/rest/organizationalEntityShareStatistics?q=organizationalEntity` +
        `&organizationalEntity=urn%3Ali%3Aorganization%3A${ORG_ID}&shares=List(urn%3Ali%3Ashare%3A${FIXTURE_LINKEDIN_POST_ID})`,
    );
    expect(urls).toContain(`https://api.linkedin.com/rest/socialActions/urn%3Ali%3Ashare%3A${FIXTURE_LINKEDIN_POST_ID}`);
  });

  // ⛔ The exact toEqual is the point: a failed share-statistics call adds no
  // zero-filled impressionCount or clickCount, only socialActions' own count.
  it("keeps socialActions' numbers when share statistics fail, and says so", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    routeLinkedIn({
      stats: () => jsonResponse({ message: "Not enough permissions" }, 403),
      actions: () => jsonResponse({ likesSummary: { totalLikes: 9 } }),
    });
    await expect(linkedinTransport.analyticsPost!(SHARE)).resolves.toEqual({ totalLikes: 9 });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/analyticsPost .*-> 403/));
    warn.mockRestore();
  });

  it("keeps the share statistics when socialActions fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    routeLinkedIn({ stats: statsFor(SHARE, { impressionCount: 40 }), actions: () => jsonResponse({}, 500) });
    await expect(linkedinTransport.analyticsPost!(SHARE)).resolves.toEqual({ impressionCount: 40 });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/socialActions.*-> 500/));
    warn.mockRestore();
  });

  /**
   * ⛔ "Could not be asked" must not read as "no figures". With one source down
   * and the other legitimately empty, returning `{}` would hide the failure, so
   * the failure itself is what the caller gets.
   */
  it("throws the one failure when the other source answered nothing", async () => {
    routeLinkedIn({ stats: () => jsonResponse({}, 429), actions: () => jsonResponse({}) });
    await expect(linkedinTransport.analyticsPost!(SHARE)).rejects.toMatchObject({ status: 429 });
  });

  it("names both failures when both sources fail", async () => {
    routeLinkedIn({ stats: () => jsonResponse({}, 403), actions: () => jsonResponse({}, 500) });
    const err = await linkedinTransport.analyticsPost!(SHARE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LinkedInError);
    expect((err as Error).message).toMatch(/organizationalEntityShareStatistics.*-> 403.* \/ .*socialActions.*-> 500/);
  });

  /**
   * The token resolver is injected app code, and getToken passes its rejection
   * through as-is, so a non-Error reason is a real input here, not a mock trick.
   */
  it("describes a non-Error failure rather than losing it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setLinkedInTokenResolver(vi.fn().mockRejectedValueOnce("token store unavailable").mockResolvedValue("li-token"));
    setLinkedInOrganizationId(ORG_ID);
    routeLinkedIn({ stats: statsFor(SHARE, { impressionCount: 3 }), actions: () => jsonResponse({}) });
    await expect(linkedinTransport.analyticsPost!(SHARE)).resolves.toEqual({ impressionCount: 3 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("token store unavailable"));
    warn.mockRestore();

    setLinkedInTokenResolver(() => Promise.reject("token store down"));
    await expect(linkedinTransport.analyticsPost!(SHARE)).rejects.toThrow("token store down / token store down");
  });

  it("refuses a ref that is neither a share nor a ugcPost URN before any call", async () => {
    for (const bad of [FIXTURE_LINKEDIN_POST_ID, "urn:li:comment:(urn:li:activity:1,2)", "urn:li:share:abc"]) {
      await expect(linkedinTransport.analyticsPost!(bad)).rejects.toThrow(/not a LinkedIn share or ugcPost URN/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks for LIFETIME share statistics by omitting timeIntervals, and keeps the week apart under a _7d suffix", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("organizationalEntityFollowerStatistics")) {
        return jsonResponse({ elements: [{ followerGains: { organicFollowerGain: 3, paidFollowerGain: 1 } }] });
      }
      if (url.includes("timeIntervals")) {
        return jsonResponse({ elements: [{ totalShareStatistics: { impressionCount: 40, clickCount: 2 } }] });
      }
      return jsonResponse({ elements: [{ totalShareStatistics: { impressionCount: 500 } }] });
    });
    await expect(linkedinTransport.analyticsChannel!()).resolves.toEqual({
      impressionCount: 500,
      organicFollowerGain_7d: 3,
      paidFollowerGain_7d: 1,
      impressionCount_7d: 40,
      clickCount_7d: 2,
    });
    // With timeIntervals, each element is a per-interval DELTA — taking the
    // first would report one window as the account's whole history. So the
    // lifetime call must not carry one.
    const lifetime = fetchMock.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes("organizationalEntityShareStatistics") && !u.includes("timeIntervals"));
    expect(lifetime).toHaveLength(1);
  });

  it("keeps the figures that came back when one channel source fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("organizationalEntityFollowerStatistics")) return jsonResponse({ message: "denied" }, 403);
      if (url.includes("timeIntervals")) return jsonResponse({ elements: [] });
      return jsonResponse({ elements: [{ totalShareStatistics: { impressionCount: 500 } }] });
    });
    await expect(linkedinTransport.analyticsChannel!()).resolves.toEqual({ impressionCount: 500 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("one source failed"));
    warn.mockRestore();
  });

  it("throws the first failure when every channel source fails", async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ message: "throttled" }, 429));
    await expect(linkedinTransport.analyticsChannel!()).rejects.toThrow(/429/);
  });

  it("uses the SCREAMING_SNAKE edgeType required by the pinned API version", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ firstDegreeSize: 219145 }));
    await expect(linkedinTransport.followerStats!()).resolves.toEqual({ followers: 219145 });
    // CompanyFollowedByMember is the <= v202304 spelling; this client pins
    // LINKEDIN_VERSION 202610, so the snake form is the correct one.
    expect(lastUrl()).toContain("edgeType=COMPANY_FOLLOWED_BY_MEMBER");
    expect(lastUrl()).toContain("networkSizes");
  });

  it("throws rather than reporting 0 followers when firstDegreeSize is absent", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    await expect(linkedinTransport.followerStats!()).rejects.toThrow(/refusing to report 0/i);
  });
});

/* -------------------------------------------------------------------------- */
/*  Pinterest                                                                  */
/* -------------------------------------------------------------------------- */

describe("pinterest analytics", () => {
  it("sends the required date window and metric types", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ALL: { summary_metrics: { IMPRESSION: 300, SAVE: 4 } } }));
    await expect(pinterestTransport.analyticsPost!("pin-1")).resolves.toEqual({ IMPRESSION: 300, SAVE: 4 });
    const url = lastUrl();
    // All three are REQUIRED by the vendor; omitting any is a 400.
    expect(url).toContain("start_date=");
    expect(url).toContain("end_date=");
    expect(url).toContain("metric_types=");
    expect(PINTEREST_PIN_METRICS).toContain("IMPRESSION");
  });

  it("unwraps the app-type envelope and also accepts a flat body", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ IMPRESSION: 12 }));
    await expect(pinterestTransport.analyticsChannel!()).resolves.toEqual({ IMPRESSION: 12 });
  });

  it("reads followers from the account field, not the windowed analytics", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ follower_count: 61 }));
    await expect(pinterestTransport.followerStats!()).resolves.toEqual({ followers: 61 });
    // The analytics endpoints are windowed, so they would answer "followers
    // gained in 30 days" — a smaller number that still looks plausible.
    expect(lastUrl()).toContain("/user_account");
    expect(lastUrl()).not.toContain("analytics");
  });

  it("throws rather than reporting 0 followers when follower_count is absent", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ username: "examplebrand" }));
    await expect(pinterestTransport.followerStats!()).rejects.toThrow(/refusing to report 0/i);
  });
});

/* -------------------------------------------------------------------------- */
/*  X                                                                          */
/* -------------------------------------------------------------------------- */

describe("x analytics", () => {
  it("requests public_metrics and passes the vendor's own key names through", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: { public_metrics: { like_count: 9, impression_count: 1200, reply_count: 0 } } }),
    );
    await expect(xTransport.analyticsPost!("1750000000000000000")).resolves.toEqual({
      like_count: 9,
      impression_count: 1200,
      reply_count: 0, // a vendor-reported zero is a real datum
    });
    expect(lastUrl()).toContain("tweet.fields=public_metrics");
  });

  it("⛔ never requests non_public_metrics or organic_metrics", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { public_metrics: {} } }));
    await xTransport.analyticsPost!("1");
    // Both 403 for posts older than 30 days, which would fail the whole call
    // rather than returning the public numbers that ARE available.
    expect(lastUrl()).not.toContain("non_public_metrics");
    expect(lastUrl()).not.toContain("organic_metrics");
  });

  it("throws rather than reporting 0 followers, which on X looks like suspension", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { public_metrics: { tweet_count: 3 } } }));
    await expect(xTransport.followerStats!()).rejects.toThrow(/suspended account/);
  });

  it("surfaces a 402 as an error rather than as empty analytics", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ title: "Payment Required" }, 402));
    // gatherChannelAnalytics renders a throw as "(unavailable: ...)"; an empty
    // object would render as genuine zero engagement instead.
    await expect(xTransport.analyticsChannel!()).rejects.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/*  Fleet-wide                                                                 */
/* -------------------------------------------------------------------------- */

describe("analytics coverage", () => {
  it("every transport that publishes now reports analytics", () => {
    for (const t of [instagramTransport, facebookTransport, linkedinTransport, pinterestTransport, xTransport]) {
      expect(typeof t.analyticsPost, `${t.platform} analyticsPost`).toBe("function");
      expect(typeof t.analyticsChannel, `${t.platform} analyticsChannel`).toBe("function");
      expect(typeof t.followerStats, `${t.platform} followerStats`).toBe("function");
    }
  });
});
