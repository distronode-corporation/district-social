import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  directEntry,
  directStateEntry,
  directTransportFor,
  encodeProviderPostIds,
  joinProviderPostIds,
  isDirectEntry,
  isFullyDirect,
  isTerminalEntry,
  parseProviderPostIds,
  legacyEntry,
  legacyIds,
  registerTransport,
  registeredPlatforms,
  registeredTransportFor,
  resetTransports,
  setTransportOverridesResolver,
  aggregatorEntry,
  aggregatorStateEntry,
  stateEntryLike,
  liveEntryLike,
  registerAggregator,
  aggregatorById,
  registeredAggregatorFor,
  aggregatorsForPlatform,
  registeredAggregators,
  resolveRoute,
  routeTransportFor,
  transportForEntry,
  parseTransportMode,
  noRouteMessage,
  type Aggregator,
  type DirectTransport,
} from "../transport.js";
import type { Platform } from "../types.js";
import { FIXTURE_BLUESKY_AT_URI, FIXTURE_LINKEDIN_SHARE_URN, FIXTURE_PINTEREST_BOARD, FIXTURE_YOUTUBE_VIDEO } from "./helpers/fixtures.js";

/**
 * The codec is the reason this migration needed no schema change, and it is
 * load-bearing for all nine platforms at once: every entry it mis-parses is a
 * post this system can no longer find, cancel or reconcile. The cases below are
 * the ones where a plausible implementation gets it wrong.
 *
 * Realistic values throughout (a Bluesky AT URI, a LinkedIn URN, a 19-digit
 * Pinterest id, Postiz-style cuids), because the whole argument for splitting
 * on the first colon rests on what real ids look like.
 */

const CUID = "clexample0000000000000001";
const AT_URI = FIXTURE_BLUESKY_AT_URI;
const LI_URN = FIXTURE_LINKEDIN_SHARE_URN;

function fakeTransport(platform: Platform): DirectTransport {
  return {
    platform,
    channelRules: () => ({ maxLength: 300, countMode: "utf16" }),
    connectStatus: async () => ({ connected: true, accountId: "acct", displayName: "Test" }),
    publishNow: async () => ({ ref: "ref-1" }),
    deletePost: async () => undefined,
    postFacts: async () => new Map(),
    postUrl: (ref) => `https://example.test/${ref}`,
  };
}

beforeEach(() => {
  resetTransports();
  delete process.env.SOCIALMETA_TRANSPORT_OVERRIDES;
});

afterEach(() => {
  resetTransports();
  delete process.env.SOCIALMETA_TRANSPORT_OVERRIDES;
  vi.restoreAllMocks();
});

describe("providerPostId codec", () => {
  it("treats a bare cuid as an opaque aggregator id", () => {
    const [entry] = parseProviderPostIds(CUID);
    expect(entry).toEqual({ kind: "legacy", raw: CUID, id: CUID });
  });

  it("round-trips a mixed list without reordering or rewriting entries", () => {
    // A draft mid-migration genuinely looks like this: some legs already direct,
    // some still on the aggregator. Order matters because the delete and retry
    // paths iterate positionally.
    const stored = `${CUID},linkedin:${LI_URN},bluesky:pending`;
    const parsed = parseProviderPostIds(stored);
    expect(parsed).toHaveLength(3);
    expect(encodeProviderPostIds(parsed)).toBe(stored);
  });

  it("keeps colons and slashes inside a ref intact", () => {
    // The AT URI has four colons and three slashes. Splitting on every colon,
    // or on the last one, silently truncates it into an id that resolves to
    // nothing — and the post stays live with nothing able to find it.
    const [entry] = parseProviderPostIds(`bluesky:${AT_URI}`);
    expect(entry.kind).toBe("direct");
    if (entry.kind !== "direct") throw new Error("unreachable");
    expect(entry.platform).toBe("bluesky");
    expect(entry.state).toBe("live");
    expect(entry.ref).toBe(AT_URI);
  });

  it("parses a LinkedIn URN, a numeric pin id and a YouTube video id", () => {
    const entries = parseProviderPostIds(
      `linkedin:${LI_URN},pinterest:${FIXTURE_PINTEREST_BOARD},youtube:${FIXTURE_YOUTUBE_VIDEO}`,
    );
    expect(entries.map((e) => (e.kind === "direct" ? e.ref : null))).toEqual([
      LI_URN,
      FIXTURE_PINTEREST_BOARD,
      FIXTURE_YOUTUBE_VIDEO,
    ]);
  });

  it("distinguishes the pending states from a live ref", () => {
    const entries = parseProviderPostIds("bluesky:pending,linkedin:publishing,reddit:failed");
    expect(entries.map((e) => (e.kind === "direct" ? e.state : null))).toEqual([
      "pending",
      "publishing",
      "failed",
    ]);
    expect(entries.every((e) => e.kind === "direct" && e.ref === null)).toBe(true);
  });

  it("falls through to opaque on an unknown namespace instead of throwing", () => {
    // A rolling deploy can put a newer pod's namespace in front of an older one.
    // Throwing here would take down a publish or a whole reconcile run over an
    // id the old pod simply has no opinion about.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const [entry] = parseProviderPostIds("mastodon:109384756");
    expect(entry.kind).toBe("legacy");
    expect(warn).toHaveBeenCalledOnce();
  });

  it("falls through to opaque on a namespace with an empty ref", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const [entry] = parseProviderPostIds("linkedin:");
    expect(entry.kind).toBe("legacy");
    expect(warn).toHaveBeenCalledOnce();
  });

  it("ignores blanks and stray whitespace rather than emitting empty entries", () => {
    expect(parseProviderPostIds("")).toEqual([]);
    expect(parseProviderPostIds(null)).toEqual([]);
    expect(parseProviderPostIds(undefined)).toEqual([]);
    expect(parseProviderPostIds(` ${CUID} , , bluesky:pending `)).toHaveLength(2);
  });

  it("encodes an empty list as undefined, never an empty string", () => {
    // publish.ts writes this straight onto the draft, and the terminal guard
    // treats any truthy providerPostId as "already sent". An empty string would
    // make a never-published draft permanently unpublishable.
    expect(encodeProviderPostIds([])).toBeUndefined();
  });

  it("joins without an empty-list case, so a CAS writer always gets a string", () => {
    // publish-due's compare-and-swap writes this value; `undefined` there would
    // be read by Prisma as "leave the column alone" and fake a won claim.
    const entries = parseProviderPostIds(`bluesky:${AT_URI},${CUID}`);
    expect(joinProviderPostIds(entries)).toBe(`bluesky:${AT_URI},${CUID}`);
    expect(joinProviderPostIds(entries)).toBe(encodeProviderPostIds(entries));
    expect(joinProviderPostIds([])).toBe("");
  });

  it("refuses to build a ref containing a comma", () => {
    // A comma would split one leg into two on the next parse and orphan the
    // second half. No vendor here issues such an id, so this means the caller
    // passed something that is not an id.
    expect(() => directEntry("bluesky", "a,b")).toThrow(/comma/);
  });

  it("reports which entries are terminal", () => {
    expect(isTerminalEntry(legacyEntry(CUID))).toBe(true);
    expect(isTerminalEntry(directEntry("bluesky", AT_URI))).toBe(true);
    expect(isTerminalEntry(directStateEntry("bluesky", "failed"))).toBe(true);
    expect(isTerminalEntry(directStateEntry("bluesky", "pending"))).toBe(false);
    expect(isTerminalEntry(directStateEntry("bluesky", "publishing"))).toBe(false);
  });

  it("separates aggregator ids from direct entries", () => {
    const entries = parseProviderPostIds(`${CUID},bluesky:${AT_URI}`);
    expect(legacyIds(entries)).toEqual([CUID]);
    expect(isFullyDirect(entries)).toBe(false);
    expect(isFullyDirect(parseProviderPostIds(`bluesky:${AT_URI}`))).toBe(true);
    // An empty list is not "fully direct" — the reconcile uses this to decide
    // whether it can skip the aggregator call, and skipping on empty would be
    // wrong for a draft that simply has no ids yet.
    expect(isFullyDirect([])).toBe(false);
  });

  it("identifies a single raw string, which is what route params need", () => {
    expect(isDirectEntry(`bluesky:${AT_URI}`)).toBe(true);
    expect(isDirectEntry(CUID)).toBe(false);
    // A BARE AT URI is not one of ours. This is the case that made the
    // `contains:` lookup dangerous: it substring-matches the prefixed entry but
    // is not itself an entry we own.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(isDirectEntry(AT_URI)).toBe(false);
    warn.mockRestore();
  });
});

describe("transport registry", () => {
  it("requires BOTH registration and a direct override to route direct", async () => {
    registerTransport(fakeTransport("bluesky"));
    expect(await directTransportFor("bluesky")).toBeNull();

    setTransportOverridesResolver(async () => ({ bluesky: "direct" }));
    expect(await directTransportFor("bluesky")).not.toBeNull();
  });

  it("returns null for a platform with an override but no transport", async () => {
    setTransportOverridesResolver(async () => ({ linkedin: "direct" }));
    expect(await directTransportFor("linkedin")).toBeNull();
  });

  it("prefers the env override over the resolver", async () => {
    registerTransport(fakeTransport("bluesky"));
    setTransportOverridesResolver(async () => ({ bluesky: "postiz" }));
    process.env.SOCIALMETA_TRANSPORT_OVERRIDES = JSON.stringify({ bluesky: "direct" });
    expect(await directTransportFor("bluesky")).not.toBeNull();
  });

  it("ignores a malformed env override instead of failing the publish", async () => {
    registerTransport(fakeTransport("bluesky"));
    setTransportOverridesResolver(async () => ({ bluesky: "direct" }));
    process.env.SOCIALMETA_TRANSPORT_OVERRIDES = "{not json";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Falls through to the resolver rather than throwing or hard-defaulting.
    expect(await directTransportFor("bluesky")).not.toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it("drops unknown platforms and bogus modes from the env override", async () => {
    registerTransport(fakeTransport("bluesky"));
    process.env.SOCIALMETA_TRANSPORT_OVERRIDES = JSON.stringify({
      bluesky: "sideways",
      notaplatform: "direct",
    });
    expect(await directTransportFor("bluesky")).toBeNull();
  });

  /**
   * ⚠️ VALID JSON THAT IS NOT AN OBJECT IS THE SHAPE A CONFIG TEMPLATE PRODUCES.
   * A helm/CI template that renders an unset value writes the four characters
   * `null`, which `JSON.parse` accepts. Without the object guard, `Object.entries`
   * throws on it and the whole env branch is treated as a syntax error, so the
   * warning an operator reads says the JSON is malformed when it is not.
   *
   * What has to happen instead is the same as no env var at all: fall through to
   * the database resolver, so a rendered-empty override cannot silently unroute
   * every platform in the fleet.
   */
  it("falls through to the resolver when the env override is valid JSON but not an object", async () => {
    registerTransport(fakeTransport("bluesky"));
    setTransportOverridesResolver(async () => ({ bluesky: "direct" }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    for (const raw of ["null", "7", '"direct"']) {
      process.env.SOCIALMETA_TRANSPORT_OVERRIDES = raw;
      expect(await directTransportFor("bluesky")).not.toBeNull();
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it("degrades to the aggregator when the resolver throws", async () => {
    registerTransport(fakeTransport("bluesky"));
    setTransportOverridesResolver(async () => {
      throw new Error("db down");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await directTransportFor("bluesky")).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it("resolves a registered transport regardless of the override", async () => {
    // This is what makes rollback safe: flipping the override back must not
    // strand in-flight pending legs, so publish-due keys off registration only.
    registerTransport(fakeTransport("bluesky"));
    setTransportOverridesResolver(async () => ({ bluesky: "postiz" }));
    expect(await directTransportFor("bluesky")).toBeNull();
    expect(registeredTransportFor("bluesky")).not.toBeNull();
    expect(registeredPlatforms()).toEqual(["bluesky"]);
  });

  it("resetTransports clears registrations and the resolver", async () => {
    registerTransport(fakeTransport("bluesky"));
    setTransportOverridesResolver(async () => ({ bluesky: "direct" }));
    resetTransports();
    expect(registeredTransportFor("bluesky")).toBeNull();
    expect(registeredPlatforms()).toEqual([]);
    expect(await directTransportFor("bluesky")).toBeNull();
  });
});

/**
 * The aggregator seam (Phase 4). No aggregator implementation exists yet, so
 * these assert the SHAPE the first one has to fit — above all that its legs get
 * their own namespace instead of landing in `legacy`, which is what made every
 * historical Postiz post permanently undeletable.
 */
function fakeAggregator(id: string, platforms: Platform[]): Aggregator {
  return {
    id,
    platforms: () => platforms,
    channelRules: () => ({ maxLength: 300, countMode: "utf16" }),
    connectStatus: async () => ({ connected: true, accountId: id, displayName: id }),
    publishNow: async () => ({ ref: "x" }),
    deletePost: async () => {},
    postFacts: async () => new Map(),
    postUrl: (_p, ref) => `https://example.test/${ref}`,
  };
}

describe("aggregator codec", () => {
  it("round-trips a live aggregator leg without colliding with a direct one", () => {
    const entry = aggregatorEntry("holdingpen", "reddit", "t3_1abc2de");
    expect(entry.raw).toBe("via:holdingpen:reddit:t3_1abc2de");

    const [parsed] = parseProviderPostIds(entry.raw);
    expect(parsed).toMatchObject({
      kind: "aggregator",
      aggregatorId: "holdingpen",
      platform: "reddit",
      state: "live",
      ref: "t3_1abc2de",
    });
  });

  it("does NOT parse an aggregator leg as legacy, so it stays deletable", () => {
    // The whole point of the namespace. `provider-post-id.ts` answers "no longer
    // reachable" for every legacy entry, so a regression here silently makes a
    // future aggregator's posts unreachable from the product on day one.
    const raw = aggregatorEntry("holdingpen", "reddit", "t3_1abc2de").raw;
    expect(legacyIds(parseProviderPostIds(raw))).toEqual([]);
    expect(parseProviderPostIds(raw)[0].kind).toBe("aggregator");
  });

  it("keeps colon-bearing refs intact", () => {
    const entry = aggregatorEntry("holdingpen", "linkedin", LI_URN);
    const [parsed] = parseProviderPostIds(entry.raw);
    expect(parsed).toMatchObject({ kind: "aggregator", ref: LI_URN });
  });

  it("round-trips pending states rather than reading them as refs", () => {
    const entry = aggregatorStateEntry("holdingpen", "reddit", "publishing");
    const [parsed] = parseProviderPostIds(entry.raw);
    expect(parsed).toMatchObject({ kind: "aggregator", state: "publishing", ref: null });
  });

  it("degrades a malformed via: entry to opaque instead of throwing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // ⚠️ Every way a `via:` entry can be short or wrong, one per shape. Trimming
    // this list is what lets one of them start throwing unnoticed, and these run
    // inside publish and reconcile where a throw takes the whole batch with it.
    for (const raw of [
      "via:holdingpen", //                no platform and no ref
      "via:holdingpen:reddit", //         a platform but no ref separator (truncated write)
      "via:holdingpen:notaplatform:x", // a namespace this build does not know
      "via:BAD ID:reddit:x", //           an id the codec would refuse to encode
      "via:holdingpen:reddit:", //        the separator, but an empty ref
    ]) {
      const [parsed] = parseProviderPostIds(raw);
      expect(parsed.kind).toBe("legacy");
    }
    expect(warn).toHaveBeenCalled();
  });

  it("refuses to encode an id that would re-parse as a different aggregator", () => {
    expect(() => aggregatorEntry("bad:id", "reddit", "x")).toThrow(/must match/);
    expect(() => aggregatorStateEntry("bad:id", "reddit", "pending")).toThrow(/must match/);
  });

  it("refuses a ref that would round-trip as a pending state or split the column", () => {
    expect(() => aggregatorEntry("holdingpen", "reddit", "pending")).toThrow(/pending state/);
    expect(() => aggregatorEntry("holdingpen", "reddit", "a,b")).toThrow(/comma/);
  });

  it("treats an aggregator leg as not-fully-direct, and terminal only when settled", () => {
    const live = aggregatorEntry("holdingpen", "reddit", "t3_1abc2de");
    const pending = aggregatorStateEntry("holdingpen", "reddit", "pending");
    expect(isFullyDirect([live])).toBe(false);
    expect(isFullyDirect([directEntry("bluesky", AT_URI), live])).toBe(false);
    expect(isTerminalEntry(live)).toBe(true);
    expect(isTerminalEntry(pending)).toBe(false);
  });
});

/**
 * Rebuilding an entry from the ENTRY rather than from its platform.
 *
 * ⛔ This is the codec's answer to a failure with no symptom. `publish-due`
 * rewrites a leg's state seven times and every rewrite used to reconstruct the
 * entry from `entry.platform`, dropping the `via:<id>:` prefix. `swapEntry` is a
 * compare-and-swap on the whole column, so the resulting UPDATE matches zero
 * rows — which the caller reads as the perfectly normal "another pod won the
 * claim". The leg then never releases, never fails, and increments no counter.
 */
describe("stateEntryLike / liveEntryLike", () => {
  it("keeps an aggregator leg on its aggregator through a state change", () => {
    const live = aggregatorEntry("holdingpen", "reddit", "t3_1abc2de");

    const claiming = stateEntryLike(live, "publishing");
    expect(claiming.raw).toBe("via:holdingpen:reddit:publishing");
    expect(claiming).toMatchObject({ kind: "aggregator", aggregatorId: "holdingpen" });
  });

  it("keeps a direct leg direct, so nothing acquires a namespace it never had", () => {
    const live = directEntry("bluesky", AT_URI);
    expect(stateEntryLike(live, "failed").raw).toBe("bluesky:failed");
    expect(stateEntryLike(live, "failed").kind).toBe("direct");
  });

  /**
   * ⛔ THE PROMOTE THE OTHER EIGHT PLATFORMS ACTUALLY RUN. The aggregator
   * promote is pinned below and the legacy one after it, so this was the leg of
   * the matrix nothing held, and it is the one every direct publish takes as
   * the last write publish-due makes: claim, publish, promote.
   *
   * A promotion that produced anything but `<platform>:<ref>` breaks `swapEntry`,
   * which compares the WHOLE column string. The UPDATE matches zero rows, zero
   * rows reads as the ordinary "another pod won the claim", and the post is live
   * on the platform while the draft never learns its id.
   */
  it("promotes a claimed direct leg to live under its own platform namespace", () => {
    const claimed = stateEntryLike(directStateEntry("bluesky", "pending"), "publishing");
    const live = liveEntryLike(claimed, AT_URI);

    expect(live.raw).toBe(`bluesky:${AT_URI}`);
    // ⚠️ The round trip, not just the shape. What publish-due writes has to
    // parse back identically or the next pass's compare-and-swap silently stops
    // matching, and the AT URI's four colons are exactly what a careless split
    // would eat.
    expect(parseProviderPostIds(live.raw)[0]).toMatchObject({
      kind: "direct",
      platform: "bluesky",
      state: "live",
      ref: AT_URI,
    });
  });

  it("refuses a comma on the direct promote too, not only on the aggregator one", () => {
    // The direct branch must not be the lax one. A comma splits the leg in two
    // on the next parse and orphans the half that names the live post.
    expect(() => liveEntryLike(directStateEntry("bluesky", "publishing"), "a,b")).toThrow(/comma/);
  });

  it("promotes a pending aggregator leg to live on the SAME aggregator", () => {
    const pending = aggregatorStateEntry("holdingpen", "reddit", "pending");
    const live = liveEntryLike(pending, "t3_1abc2de");

    expect(live.raw).toBe("via:holdingpen:reddit:t3_1abc2de");
    // The round trip is the point: what publish-due writes must be what a later
    // pass parses back, or the CAS silently stops matching.
    expect(parseProviderPostIds(live.raw)[0]).toMatchObject({
      kind: "aggregator",
      aggregatorId: "holdingpen",
      platform: "reddit",
      state: "live",
      ref: "t3_1abc2de",
    });
  });

  it("survives a full claim -> publish cycle without losing the aggregator id", () => {
    const start = aggregatorStateEntry("holdingpen", "reddit", "pending");
    const claimed = stateEntryLike(start, "publishing");
    const published = liveEntryLike(claimed, "t3_1abc2de");

    expect(published.raw).toBe("via:holdingpen:reddit:t3_1abc2de");
  });

  it("leaves a legacy entry untouched, having no state to move it to", () => {
    const legacy = legacyEntry("clx123abc");
    expect(stateEntryLike(legacy, "failed")).toBe(legacy);
    expect(liveEntryLike(legacy, "anything")).toBe(legacy);
  });

  it("still refuses a ref the codec cannot round-trip", () => {
    const pending = aggregatorStateEntry("holdingpen", "reddit", "pending");
    expect(() => liveEntryLike(pending, "a,b")).toThrow(/comma/);
    expect(() => liveEntryLike(pending, "pending")).toThrow(/pending state/);
  });
});

describe("route resolution", () => {
  it("routes direct only when the mode says direct", async () => {
    registerTransport(fakeTransport("bluesky"));
    setTransportOverridesResolver(async () => ({ bluesky: "direct" }));
    const route = await resolveRoute("bluesky");
    expect(route.kind).toBe("direct");
  });

  it("routes to an aggregator only when the mode says aggregator", async () => {
    registerAggregator(fakeAggregator("holdingpen", ["reddit"]));
    // Registration alone must not route anything, same rule as direct.
    setTransportOverridesResolver(async () => ({}));
    expect((await resolveRoute("reddit")).kind).toBe("no-route");

    setTransportOverridesResolver(async () => ({ reddit: "aggregator" }));
    const route = await resolveRoute("reddit");
    expect(route.kind).toBe("aggregator");
  });

  it("NEVER falls back from direct to an aggregator", async () => {
    // Publishing from an account the operator did not choose is worse than not
    // publishing: it is found late, and from the wrong identity.
    registerAggregator(fakeAggregator("holdingpen", ["reddit"]));
    setTransportOverridesResolver(async () => ({ reddit: "direct" }));
    const route = await resolveRoute("reddit");
    expect(route).toEqual({ kind: "no-route", reason: "direct-unregistered" });
  });

  it("distinguishes the three no-route reasons", async () => {
    // "twitter", not "x": "x" is not a Platform, so the override lookup missed
    // entirely and this line reached `not-routed` as an UNKNOWN key rather than
    // through the "off" mode it means to exercise. Same assertion, real path.
    setTransportOverridesResolver(async () => ({ reddit: "aggregator", twitter: "off" }));
    expect(await resolveRoute("reddit")).toEqual({
      kind: "no-route",
      reason: "aggregator-unregistered",
    });
    expect(await resolveRoute("twitter")).toEqual({ kind: "no-route", reason: "not-routed" });
    expect(await resolveRoute("linkedin")).toEqual({ kind: "no-route", reason: "not-routed" });
  });

  it("accepts the aggregator mode from the env override", async () => {
    registerAggregator(fakeAggregator("holdingpen", ["reddit"]));
    process.env.SOCIALMETA_TRANSPORT_OVERRIDES = JSON.stringify({ reddit: "aggregator" });
    expect((await resolveRoute("reddit")).kind).toBe("aggregator");
  });

  it("resetTransports clears aggregators too", async () => {
    registerAggregator(fakeAggregator("holdingpen", ["reddit"]));
    resetTransports();
    expect(registeredAggregatorFor("reddit")).toBeNull();
  });

  it("names the platform in every no-route message", () => {
    for (const reason of [
      "direct-unregistered",
      "aggregator-unregistered",
      "aggregator-ambiguous",
      "not-routed",
    ] as const) {
      expect(noRouteMessage("reddit", reason)).toContain("reddit");
    }
  });
});

describe("parseTransportMode", () => {
  it("accepts the fixed modes and normalises the postiz alias to off", () => {
    expect(parseTransportMode("direct")).toEqual({ kind: "direct" });
    expect(parseTransportMode("off")).toEqual({ kind: "off" });
    // The value actually sitting in SocialSetting rows today. A rollback must
    // never be the thing that fails.
    expect(parseTransportMode("postiz")).toEqual({ kind: "off" });
    expect(parseTransportMode("aggregator")).toEqual({ kind: "aggregator" });
  });

  it("carries the vendor id when the mode names one", () => {
    expect(parseTransportMode("aggregator:zernio")).toEqual({ kind: "aggregator", id: "zernio" });
  });

  it("rejects anything that is not a mode, including a malformed vendor id", () => {
    for (const raw of ["", "nonsense", "aggregator:", "aggregator:BAD ID", "aggregator::x", 7, null, undefined, {}]) {
      expect(parseTransportMode(raw)).toBeNull();
    }
  });

  /**
   * The id grammar has to match the codec's, or a mode could name a vendor that
   * `aggregatorEntry` then refuses to encode — accepted at the settings layer
   * and fatal at publish time.
   */
  it("uses the same id grammar the providerPostId codec enforces", () => {
    expect(parseTransportMode("aggregator:a-b-9")).toEqual({ kind: "aggregator", id: "a-b-9" });
    expect(parseTransportMode("aggregator:-leading")).toBeNull();
    expect(() => aggregatorEntry("-leading", "reddit", "x")).toThrow(/must match/);
  });
});

/**
 * Selecting BETWEEN aggregators.
 *
 * The registry used to be keyed by platform with last-registration-wins, which
 * cannot express "Reddit goes to Zernio, Pinterest goes to Ayrshare" — the
 * second vendor silently stole every platform it declared. These are the rows
 * that keep the second aggregator possible before there is one.
 */
describe("multiple aggregators", () => {
  it("routes to the aggregator the mode names", async () => {
    registerAggregator(fakeAggregator("zernio", ["reddit"]));
    registerAggregator(fakeAggregator("ayrshare", ["reddit"]));
    setTransportOverridesResolver(async () => ({ reddit: "aggregator:ayrshare" }));

    const route = await resolveRoute("reddit");
    expect(route).toMatchObject({ kind: "aggregator", aggregator: { id: "ayrshare" } });
  });

  it("registering a second aggregator does not steal the first one's platforms", async () => {
    registerAggregator(fakeAggregator("zernio", ["reddit", "pinterest"]));
    registerAggregator(fakeAggregator("ayrshare", ["reddit"]));

    expect(aggregatorsForPlatform("reddit").map((a) => a.id).sort()).toEqual(["ayrshare", "zernio"]);
    expect(aggregatorsForPlatform("pinterest").map((a) => a.id)).toEqual(["zernio"]);
    expect(registeredAggregators().map((a) => a.id).sort()).toEqual(["ayrshare", "zernio"]);
  });

  /**
   * ⛔ REFUSING BEATS GUESSING. Publishing from an account the operator did not
   * choose is discovered late and from the wrong identity.
   */
  it("refuses bare 'aggregator' once more than one holds the platform", async () => {
    registerAggregator(fakeAggregator("zernio", ["reddit"]));
    setTransportOverridesResolver(async () => ({ reddit: "aggregator" }));
    // One holder: unambiguous, so the legacy bare value keeps working.
    expect((await resolveRoute("reddit")).kind).toBe("aggregator");

    registerAggregator(fakeAggregator("ayrshare", ["reddit"]));
    expect(await resolveRoute("reddit")).toEqual({
      kind: "no-route",
      reason: "aggregator-ambiguous",
    });
  });

  it("does not fall back to the other vendor when the named one lacks the platform", async () => {
    registerAggregator(fakeAggregator("zernio", ["reddit"]));
    setTransportOverridesResolver(async () => ({ reddit: "aggregator:ayrshare" }));

    expect(await resolveRoute("reddit")).toEqual({
      kind: "no-route",
      reason: "aggregator-ambiguous",
    });
  });

  it("lists the registered ids in the ambiguity message, so the operator can fix it", () => {
    registerAggregator(fakeAggregator("zernio", ["reddit"]));
    expect(noRouteMessage("reddit", "aggregator-ambiguous")).toContain("zernio");
  });
});

describe("routeTransportFor", () => {
  it("stamps a direct leg with the platform namespace", async () => {
    registerTransport(fakeTransport("bluesky"));
    setTransportOverridesResolver(async () => ({ bluesky: "direct" }));

    const routed = (await routeTransportFor("bluesky"))!;
    expect(routed.entry("abc").raw).toBe("bluesky:abc");
    expect(routed.stateEntry("pending").raw).toBe("bluesky:pending");
  });

  /**
   * ⛔ THE LOAD-BEARING ASSERTION OF THE WHOLE PHASE. If publish takes the
   * transport but encodes with `directEntry` by hand, the leg loses its
   * aggregator id and cleanup later dispatches it to our own vendor client.
   */
  it("stamps an aggregator leg with via:<id>, not with the bare platform", async () => {
    registerAggregator(fakeAggregator("zernio", ["reddit"]));
    setTransportOverridesResolver(async () => ({ reddit: "aggregator:zernio" }));

    const routed = (await routeTransportFor("reddit"))!;
    expect(routed.entry("t3_abc").raw).toBe("via:zernio:reddit:t3_abc");
    expect(routed.stateEntry("pending").raw).toBe("via:zernio:reddit:pending");
  });

  it("answers null when there is no route, so callers cannot publish by accident", async () => {
    setTransportOverridesResolver(async () => ({ reddit: "off" }));
    expect(await routeTransportFor("reddit")).toBeNull();
  });

  it("exposes the aggregator's own limits, which are not the vendor's", async () => {
    const agg = fakeAggregator("zernio", ["reddit"]);
    agg.channelRules = () => ({ maxLength: 42, countMode: "utf16" });
    registerAggregator(agg);
    setTransportOverridesResolver(async () => ({ reddit: "aggregator:zernio" }));

    const routed = (await routeTransportFor("reddit"))!;
    expect(routed.transport.channelRules().maxLength).toBe(42);
  });
});

/**
 * ⛔ CLEANUP RESOLVES FROM THE LEG, NEVER FROM THE SETTING.
 *
 * The override decides what new publishes PRODUCE. It must never decide what can
 * be cleaned up, or flipping a platform strands every post already out there.
 */
describe("transportForEntry", () => {
  it("resolves an aggregator leg by its embedded id even when the platform is now off", () => {
    registerAggregator(fakeAggregator("zernio", ["reddit"]));
    setTransportOverridesResolver(async () => ({ reddit: "off" }));

    const entry = aggregatorEntry("zernio", "reddit", "t3_abc");
    expect(transportForEntry(entry)).not.toBeNull();
    expect(transportForEntry(entry)!.postUrl("t3_abc")).toContain("t3_abc");
  });

  it("resolves a leg to the vendor that PUBLISHED it, not the one selected now", () => {
    registerAggregator(fakeAggregator("zernio", ["reddit"]));
    const ayrshare = fakeAggregator("ayrshare", ["reddit"]);
    ayrshare.postUrl = (_p, ref) => `https://ayrshare.test/${ref}`;
    registerAggregator(ayrshare);
    setTransportOverridesResolver(async () => ({ reddit: "aggregator:ayrshare" }));

    // The leg says zernio, so it must reach zernio however reddit is routed now.
    const old = aggregatorEntry("zernio", "reddit", "t3_abc");
    expect(transportForEntry(old)!.postUrl("t3_abc")).toBe("https://example.test/t3_abc");
  });

  it("resolves a direct leg through the registry, ignoring the override", () => {
    registerTransport(fakeTransport("bluesky"));
    setTransportOverridesResolver(async () => ({ bluesky: "off" }));

    expect(transportForEntry(directEntry("bluesky", AT_URI))).not.toBeNull();
  });

  it("answers null for an unregistered aggregator rather than reaching the direct transport", () => {
    // The highest-severity trap in the migration: a Zernio ref handed to our own
    // Reddit client, whose idempotent delete reports the 404 as success and drops
    // the id — leaving a live post nothing can name.
    registerTransport(fakeTransport("reddit"));
    expect(transportForEntry(aggregatorEntry("zernio", "reddit", "t3_abc"))).toBeNull();
  });

  it("answers null, not undefined, for a direct leg whose platform has no transport", () => {
    // The mirror of the case above, reachable the same way: a leg written by a
    // build that registered a transport this one does not, or a wiring
    // regression that drops one at boot. `provider-post-id.ts` branches on the
    // null to report the leg as no longer reachable rather than pretending a
    // delete succeeded.
    registerTransport(fakeTransport("reddit"));
    // ⚠️ `toBeNull`, never `toBeFalsy`: a bare `REGISTRY.get` hands back
    // `undefined`, which passes the loose check, and normalising that away is
    // the entire job of this line in the source.
    expect(transportForEntry(directEntry("bluesky", AT_URI))).toBeNull();
  });

  it("answers null for a legacy leg, which has no issuer left to call", () => {
    expect(transportForEntry(legacyEntry("clx123abc"))).toBeNull();
  });
});

/**
 * The bound view is where an aggregator gets the guarantees a direct transport
 * gets at registration. `registerAggregator` does not wrap, so without this
 * Zernio would be the first publisher in the engine with no bounded retry.
 */
describe("aggregator bound view", () => {
  class Unknown extends Error {
    readonly status = 503;
  }

  beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => {}));

  it("retries postFacts, like every direct transport", async () => {
    const postFacts = vi.fn().mockRejectedValueOnce(new Unknown("down")).mockResolvedValue(new Map());
    registerAggregator({ ...fakeAggregator("zernio", ["reddit"]), postFacts });
    setTransportOverridesResolver(async () => ({ reddit: "aggregator:zernio" }));

    await (await routeTransportFor("reddit"))!.transport.postFacts(["r1"]);
    expect(postFacts).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry publishNow on an unknown outcome, so nothing double-posts", async () => {
    const publishNow = vi.fn().mockRejectedValue(new Unknown("down"));
    registerAggregator({ ...fakeAggregator("zernio", ["reddit"]), publishNow });
    setTransportOverridesResolver(async () => ({ reddit: "aggregator:zernio" }));

    const routed = (await routeTransportFor("reddit"))!;
    await expect(routed.transport.publishNow({} as never)).rejects.toThrow("down");
    expect(publishNow).toHaveBeenCalledTimes(1);
  });

  it("passes the platform through to every method", async () => {
    const deletePost = vi.fn().mockResolvedValue(undefined);
    registerAggregator({ ...fakeAggregator("zernio", ["reddit", "pinterest"]), deletePost });
    setTransportOverridesResolver(async () => ({ pinterest: "aggregator:zernio" }));

    await (await routeTransportFor("pinterest"))!.transport.deletePost("pin-9");
    expect(deletePost).toHaveBeenCalledWith("pinterest", "pin-9");
  });

  /**
   * Optional methods must stay absent rather than becoming defined-but-throwing:
   * callers feature-detect them (`registeredTransportFor(p)?.analyticsChannel`).
   */
  it("does not invent optional methods the aggregator did not implement", async () => {
    registerAggregator(fakeAggregator("zernio", ["reddit"]));
    setTransportOverridesResolver(async () => ({ reddit: "aggregator:zernio" }));

    const { transport } = (await routeTransportFor("reddit"))!;
    expect(transport.analyticsChannel).toBeUndefined();
    expect(transport.followerStats).toBeUndefined();
    expect(transport.destinationRules).toBeUndefined();
    // ⛔ `publishReply` above all: the thread releaser feature-detects it to
    // decide whether a queued reply can go out at all. A bound view that defined
    // it unconditionally would answer "yes" for an aggregator that cannot thread,
    // and the reply would fail at the vendor instead of being reported unroutable.
    expect(transport.publishReply).toBeUndefined();
    expect(transport.postComment).toBeUndefined();
    expect(transport.analyticsPost).toBeUndefined();
    expect(transport.listBoards).toBeUndefined();
  });

  it("forwards optional methods that the aggregator DOES implement", async () => {
    const followerStats = vi.fn().mockResolvedValue({ followers: 3 });
    registerAggregator({ ...fakeAggregator("zernio", ["reddit"]), followerStats });
    setTransportOverridesResolver(async () => ({ reddit: "aggregator:zernio" }));

    const { transport } = (await routeTransportFor("reddit"))!;
    expect(await transport.followerStats!()).toEqual({ followers: 3 });
    expect(followerStats).toHaveBeenCalledWith("reddit");
  });

  /**
   * ⛔ EVERY OPTIONAL METHOD MUST ARRIVE AT THE AGGREGATOR WITH THE PLATFORM AS
   * ITS FIRST ARGUMENT, and this is the one place that can be got wrong silently.
   *
   * A `DirectTransport` is already scoped to one platform, so its methods take no
   * platform. An `Aggregator` holds several on one credential, so every one of its
   * methods takes the platform first. `bindAggregator` is the adapter between the
   * two shapes, and each forwarder re-states the argument order by hand. Drop the
   * platform from one of them and the aggregator does not fail: it acts on
   * whichever platform it treats as the default. A Reddit reply lands on
   * Pinterest, a subreddit's rules come back as a board list, and this month's
   * Reddit analytics are filed against another channel.
   *
   * The reply case is the expensive one. Thread replies are deferred and released
   * later by publish-due, so a misrouted reply is discovered when someone reads
   * the wrong account, not when the publish runs.
   */
  it("hands the platform to every optional method, so nothing acts on the wrong channel", async () => {
    const publishReply = vi.fn().mockResolvedValue({ ref: "t1_reply" });
    const postComment = vi.fn().mockResolvedValue(undefined);
    const analyticsPost = vi.fn().mockResolvedValue({ upvotes: 12 });
    const analyticsChannel = vi.fn().mockResolvedValue({ subscribers: 900 });
    const listBoards = vi.fn().mockResolvedValue([{ id: "b1", name: "Recipes" }]);
    const destinationRules = vi.fn().mockResolvedValue({ flairRequired: true });

    registerAggregator({
      ...fakeAggregator("zernio", ["reddit", "pinterest"]),
      publishReply,
      postComment,
      analyticsPost,
      analyticsChannel,
      listBoards,
      destinationRules,
    });
    setTransportOverridesResolver(async () => ({
      reddit: "aggregator:zernio",
      pinterest: "aggregator:zernio",
    }));

    const transport = (await routeTransportFor("reddit"))!.transport;

    const reply = {
      position: 1,
      text: "and one more thing",
      dueAt: "2026-08-27T12:00:00.000Z",
      parent: { id: "t3_1abc2de" },
    };
    expect(await transport.publishReply!(reply, { id: "t3_1abc2de" })).toEqual({ ref: "t1_reply" });
    expect(publishReply).toHaveBeenCalledWith("reddit", reply, { id: "t3_1abc2de" });

    await transport.postComment!("t3_1abc2de", "thanks for reading");
    expect(postComment).toHaveBeenCalledWith("reddit", "t3_1abc2de", "thanks for reading");

    expect(await transport.analyticsPost!("t3_1abc2de")).toEqual({ upvotes: 12 });
    expect(analyticsPost).toHaveBeenCalledWith("reddit", "t3_1abc2de");

    expect(await transport.analyticsChannel!()).toEqual({ subscribers: 900 });
    expect(analyticsChannel).toHaveBeenCalledWith("reddit");

    expect(await transport.destinationRules!("r/examplebrand")).toEqual({ flairRequired: true });
    expect(destinationRules).toHaveBeenCalledWith("reddit", "r/examplebrand");

    // ⛔ The SECOND bound view of the SAME aggregator, and the reason the whole
    // test is worth having. One credential holds both platforms, so the platform
    // cannot be captured once on the aggregator: it has to be captured per view.
    // A forwarder that closed over the wrong one would list Pinterest's boards
    // for a Reddit publish and be wrong only on the second platform, which is
    // the platform nobody adds until the first one is already working.
    const pinterest = (await routeTransportFor("pinterest"))!.transport;
    expect(await pinterest.listBoards!()).toEqual([{ id: "b1", name: "Recipes" }]);
    expect(listBoards).toHaveBeenCalledWith("pinterest");
    expect(listBoards).not.toHaveBeenCalledWith("reddit");
  });

  /**
   * The bound view is cached per `<aggregatorId>|<platform>`, and the cache is not
   * an optimisation. Callers compare transports by identity, and re-registering a
   * vendor (a fresh credential, a replacement instance) must not keep serving a
   * view onto the object that was replaced.
   */
  it("serves one bound view per platform, and a fresh one after the vendor is re-registered", async () => {
    const first = fakeAggregator("zernio", ["reddit"]);
    first.postUrl = (_p, ref) => `https://first.test/${ref}`;
    registerAggregator(first);
    setTransportOverridesResolver(async () => ({ reddit: "aggregator:zernio" }));

    const a = (await routeTransportFor("reddit"))!.transport;
    const b = (await routeTransportFor("reddit"))!.transport;
    expect(a).toBe(b);

    const replacement = fakeAggregator("zernio", ["reddit"]);
    replacement.postUrl = (_p, ref) => `https://replacement.test/${ref}`;
    registerAggregator(replacement);

    const c = (await routeTransportFor("reddit"))!.transport;
    expect(c).not.toBe(a);
    // ⚠️ The identity check alone would pass on a cache that never cleared but
    // rebuilt anyway. This is the assertion that fails if the stale instance is
    // still the one being called.
    expect(c.postUrl("t3_abc")).toBe("https://replacement.test/t3_abc");
  });
});

/**
 * The lookups that run on the CLEANUP path, where the answer must not depend on
 * what is routed today.
 */
describe("aggregator lookups by id and by platform", () => {
  it("answers null for an aggregator id nothing registered, rather than undefined", () => {
    registerAggregator(fakeAggregator("zernio", ["reddit"]));
    expect(aggregatorById("zernio")!.id).toBe("zernio");
    // A `via:ayrshare:reddit:…` leg written by a build that had Ayrshare
    // registered still parses fine on a build that does not. The lookup has to
    // say so in a shape callers already test for: `transportForEntry` returns
    // null there, and `provider-post-id.ts` reports the leg as unreachable
    // instead of pretending a delete succeeded.
    expect(aggregatorById("ayrshare")).toBeNull();
  });

  /**
   * ⚠️ REFUSING TO NAME ONE IS THE FEATURE. `registeredAggregatorFor` is the
   * unambiguous-single-holder lookup, and the moment a second vendor declares the
   * same platform there is no right answer. Returning either one would publish
   * from an account nobody chose, which is found late and from the wrong identity.
   */
  it("names the single aggregator holding a platform, and refuses once two do", () => {
    registerAggregator(fakeAggregator("zernio", ["reddit"]));
    expect(registeredAggregatorFor("reddit")!.id).toBe("zernio");

    registerAggregator(fakeAggregator("ayrshare", ["reddit"]));
    expect(registeredAggregatorFor("reddit")).toBeNull();
    // Still unambiguous for a platform only one of them holds.
    expect(registeredAggregatorFor("pinterest")).toBeNull();
  });
});

/**
 * Retry is applied AT REGISTRATION, so a transport cannot opt out by omission
 * and a tenth platform cannot be born without it.
 *
 * These assertions are the ones that fail if the wrapper is ever silently
 * dropped. Every other test in this repo would stay green without it: the fakes
 * throw plain Errors, which are deliberately NOT retryable, so nothing else
 * exercises the wrapping at all.
 */
describe("registration wraps transports in retry", () => {
  class Rejected extends Error {
    readonly status = 429;
  }
  class Unknown extends Error {
    readonly status = 503;
  }
  /**
   * The shape a client throws when NO HTTP RESPONSE HAPPENED AT ALL: a timeout,
   * a dropped connection, DNS. All eight vendor clients wrap those in their own
   * error class carrying `status: 0`, which is a sentinel and not a status.
   */
  class Unreachable extends Error {
    readonly status = 0;
  }

  beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => {}));

  /**
   * ⛔ THE 503s ABOVE COME FROM A SERVER THAT ANSWERED. THIS IS THE CASE WHERE
   * NOTHING ANSWERED.
   *
   * If `isUnknownOutcome` read the sentinel `0` as a real status it would return
   * false before its timeout arms could run, so every timed-out `deletePost` and
   * `postFacts` would silently never be retried, the exact case the `transient`
   * policy exists for, on the methods this seam registers with it.
   *
   * ⚠️ Both halves are asserted together on purpose, because the fix is only
   * correct as a pair: it must buy retries for the idempotent calls WITHOUT
   * buying one for the create. A timed-out publish may well have landed and only
   * the answer was lost, so repeating it posts twice to a real brand account,
   * and a duplicate is worse than a failed leg because a failed leg is visible.
   */
  it("retries an idempotent call but never a create when the vendor is unreachable", async () => {
    const postFacts = vi
      .fn<DirectTransport["postFacts"]>()
      .mockRejectedValueOnce(new Unreachable("connect ETIMEDOUT"))
      .mockResolvedValue(new Map());
    const publishNow = vi
      .fn<DirectTransport["publishNow"]>()
      .mockRejectedValue(new Unreachable("connect ETIMEDOUT"));
    registerTransport({ ...fakeTransport("bluesky"), postFacts, publishNow });

    await registeredTransportFor("bluesky")!.postFacts(["r1"]);
    expect(postFacts).toHaveBeenCalledTimes(2);

    await expect(
      registeredTransportFor("bluesky")!.publishNow({
        render: { platform: "bluesky", content: "hi" } as never,
        media: [],
        draftId: "draft-1",
        destination: {},
      }),
    ).rejects.toThrow("connect ETIMEDOUT");
    expect(publishNow).toHaveBeenCalledTimes(1);
  });

  it("retries postFacts through a transient failure", async () => {
    const postFacts = vi
      .fn<DirectTransport["postFacts"]>()
      .mockRejectedValueOnce(new Unknown("down"))
      .mockResolvedValue(new Map());
    registerTransport({ ...fakeTransport("bluesky"), postFacts });

    await registeredTransportFor("bluesky")!.postFacts(["r1"]);
    expect(postFacts).toHaveBeenCalledTimes(2);
  });

  it("retries deletePost, which every transport treats as idempotent", async () => {
    const deletePost = vi
      .fn<DirectTransport["deletePost"]>()
      .mockRejectedValueOnce(new Unknown("down"))
      .mockResolvedValue(undefined);
    registerTransport({ ...fakeTransport("bluesky"), deletePost });

    await registeredTransportFor("bluesky")!.deletePost("r1");
    expect(deletePost).toHaveBeenCalledTimes(2);
  });

  /**
   * ⛔ The duplicate-post guard, at the seam rather than in retry.ts's unit
   * tests: publishNow must be registered with the `rejected-only` policy. A
   * 5xx may mean the post landed and only the answer was lost, so a second
   * attempt would publish twice to a real brand account.
   */
  it("does NOT retry publishNow when the outcome is unknown", async () => {
    const publishNow = vi.fn<DirectTransport["publishNow"]>().mockRejectedValue(new Unknown("down"));
    registerTransport({ ...fakeTransport("bluesky"), publishNow });

    await expect(
      registeredTransportFor("bluesky")!.publishNow({
        platform: "bluesky",
        render: { platform: "bluesky", content: "hi" } as never,
        media: [],
        destination: {},
      } as never),
    ).rejects.toThrow("down");
    expect(publishNow).toHaveBeenCalledTimes(1);
  });

  it("DOES retry publishNow when the vendor definitively refused", async () => {
    const publishNow = vi
      .fn<DirectTransport["publishNow"]>()
      .mockRejectedValueOnce(new Rejected("rate limited"))
      .mockResolvedValue({ ref: "ref-1" });
    registerTransport({ ...fakeTransport("bluesky"), publishNow });

    await registeredTransportFor("bluesky")!.publishNow({
      platform: "bluesky",
      render: { platform: "bluesky", content: "hi" } as never,
      media: [],
      destination: {},
    } as never);
    expect(publishNow).toHaveBeenCalledTimes(2);
  });
});
