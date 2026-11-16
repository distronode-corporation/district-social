import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  aggregatorEntry,
  parseProviderPostIds,
  registerAggregator,
  resetTransports,
  resolveRoute,
  routeTransportFor,
  setTransportOverridesResolver,
  transportForEntry,
  type Aggregator,
  type Platform,
  type ProviderPostEntry,
} from "../index.js";

/**
 * Replacing one aggregator with another, without stranding what the first one
 * published.
 *
 * ⛔ THIS IS THE SCENARIO THE ID-KEYED REGISTRY EXISTS FOR, and it is the one
 * that has already gone wrong once in this codebase's history. Postiz legs were
 * written as bare cuids, so every historical aggregator post became permanently
 * undeletable the day that account went away — `provider-post-id.ts` still
 * answers "no longer reachable" for all of them. The `via:<id>:` namespace and
 * `transportForEntry` exist so the SECOND time this happens it is survivable.
 *
 * There is one aggregator today. These rows prove the second one is possible
 * before anybody is depending on it, which is the only time it is cheap to fix.
 */

const REDDIT: Platform = "reddit";

/**
 * The vendor ref off a leg that is supposed to be live.
 *
 * `aggregatorEntry` is declared as returning the whole `ProviderPostEntry`
 * union, and the `legacy` arm carries no `ref` at all, so `entry.ref` does not
 * typecheck on the union. Narrowing here rather than asserting non-null keeps
 * the assertion honest: if the codec ever stopped producing a live entry for
 * these arguments the test says so instead of reading `undefined`.
 */
function liveRef(entry: ProviderPostEntry): string {
  if (entry.kind === "legacy" || entry.ref === null) {
    throw new Error(`expected a live leg, got ${entry.raw}`);
  }
  return entry.ref;
}

function fake(id: string, deleted: string[]): Aggregator {
  return {
    id,
    platforms: () => [REDDIT],
    channelRules: () => ({ maxLength: 40_000, countMode: "utf16" }),
    connectStatus: async () => ({ connected: true, accountId: `acc_${id}`, displayName: id }),
    publishNow: async () => ({ ref: `${id}_post` }),
    deletePost: async (_p, ref) => {
      deleted.push(`${id}:${ref}`);
    },
    postFacts: async (p, refs) =>
      new Map(refs.map((r) => [r, { state: "PUBLISHED" as const, released: true, platform: p }])),
    postUrl: (_p, ref) => `https://${id}.test/${ref}`,
  };
}

let deletedByZernio: string[];
let deletedByAyrshare: string[];

beforeEach(() => {
  resetTransports();
  deletedByZernio = [];
  deletedByAyrshare = [];
  delete process.env.SOCIALMETA_TRANSPORT_OVERRIDES;
  registerAggregator(fake("zernio", deletedByZernio));
});

afterEach(() => {
  resetTransports();
  delete process.env.SOCIALMETA_TRANSPORT_OVERRIDES;
});

describe("switching from one aggregator to another", () => {
  it("sends NEW posts to the newly selected vendor", async () => {
    registerAggregator(fake("ayrshare", deletedByAyrshare));
    setTransportOverridesResolver(async () => ({ reddit: "aggregator:ayrshare" }));

    const routed = (await routeTransportFor(REDDIT))!;
    const published = await routed.transport.publishNow({} as never);

    expect(published.ref).toBe("ayrshare_post");
    expect(routed.entry(published.ref).raw).toBe("via:ayrshare:reddit:ayrshare_post");
  });

  /**
   * ⛔ THE ROW THAT MATTERS. A leg published by zernio must still reach zernio
   * after the operator moves the platform to ayrshare. Resolving by PLATFORM
   * would hand a zernio id to ayrshare, which does not recognise it — and
   * because deletePost is idempotent by contract, the resulting "not found"
   * would be recorded as a SUCCESSFUL delete and the id dropped from the
   * column. A live post, and nothing left that knows it exists.
   */
  it("still deletes an OLD leg through the vendor that published it", async () => {
    registerAggregator(fake("ayrshare", deletedByAyrshare));
    setTransportOverridesResolver(async () => ({ reddit: "aggregator:ayrshare" }));

    const old = aggregatorEntry("zernio", REDDIT, "zernio_post");
    await transportForEntry(old)!.deletePost(liveRef(old));

    expect(deletedByZernio).toEqual(["zernio:zernio_post"]);
    expect(deletedByAyrshare).toEqual([]);
  });

  it("still reconciles an OLD leg through the vendor that published it", async () => {
    registerAggregator(fake("ayrshare", deletedByAyrshare));
    setTransportOverridesResolver(async () => ({ reddit: "aggregator:ayrshare" }));

    const old = aggregatorEntry("zernio", REDDIT, "zernio_post");
    const facts = await transportForEntry(old)!.postFacts(["zernio_post"]);

    expect(facts.get("zernio_post")).toMatchObject({ state: "PUBLISHED" });
  });

  it("builds an OLD leg's permalink from the vendor that published it", () => {
    registerAggregator(fake("ayrshare", deletedByAyrshare));
    const old = aggregatorEntry("zernio", REDDIT, "zernio_post");

    expect(transportForEntry(old)!.postUrl("zernio_post")).toBe(
      "https://zernio.test/zernio_post",
    );
  });

  /**
   * Turning the platform OFF entirely is the same problem with a different
   * shape: the override says nothing publishes here any more, and the legs
   * already out there still have to be cleanable.
   */
  it("still resolves an OLD leg after the platform is switched OFF", async () => {
    setTransportOverridesResolver(async () => ({ reddit: "off" }));

    expect((await resolveRoute(REDDIT)).kind).toBe("no-route");

    const old = aggregatorEntry("zernio", REDDIT, "zernio_post");
    await transportForEntry(old)!.deletePost(liveRef(old));
    expect(deletedByZernio).toEqual(["zernio:zernio_post"]);
  });

  /**
   * The whole point of the namespace, restated as a round trip: a leg written
   * by one vendor must PARSE back as that vendor's, not as a bare id the way
   * every historical Postiz leg did.
   */
  it("round-trips the vendor id through the stored column", () => {
    const raw = aggregatorEntry("zernio", REDDIT, "zernio_post").raw;
    const [parsed] = parseProviderPostIds(raw);

    expect(parsed).toMatchObject({ kind: "aggregator", aggregatorId: "zernio" });
    // NOT legacy, which is what would make it permanently unreachable.
    expect(parsed.kind).not.toBe("legacy");
  });

  it("answers null, rather than the wrong vendor, when the old one is gone", async () => {
    // Zernio de-registered (removed from a deployment), ayrshare selected.
    resetTransports();
    registerAggregator(fake("ayrshare", deletedByAyrshare));
    setTransportOverridesResolver(async () => ({ reddit: "aggregator:ayrshare" }));

    const old = aggregatorEntry("zernio", REDDIT, "zernio_post");

    expect(transportForEntry(old)).toBeNull();
    expect(deletedByAyrshare).toEqual([]);
  });
});

describe("two aggregators holding the same platform", () => {
  beforeEach(() => registerAggregator(fake("ayrshare", deletedByAyrshare)));

  it("honours the operator's named choice", async () => {
    setTransportOverridesResolver(async () => ({ reddit: "aggregator:zernio" }));
    expect(await resolveRoute(REDDIT)).toMatchObject({
      kind: "aggregator",
      aggregator: { id: "zernio" },
    });

    setTransportOverridesResolver(async () => ({ reddit: "aggregator:ayrshare" }));
    expect(await resolveRoute(REDDIT)).toMatchObject({
      kind: "aggregator",
      aggregator: { id: "ayrshare" },
    });
  });

  it("refuses to guess when the mode names neither", async () => {
    setTransportOverridesResolver(async () => ({ reddit: "aggregator" }));
    expect(await resolveRoute(REDDIT)).toEqual({
      kind: "no-route",
      reason: "aggregator-ambiguous",
    });
  });

  it("keeps each vendor's legs separable within one draft", () => {
    const column = [
      aggregatorEntry("zernio", REDDIT, "a").raw,
      aggregatorEntry("ayrshare", REDDIT, "b").raw,
    ].join(",");

    const parsed = parseProviderPostIds(column);

    expect(parsed.map((e) => (e.kind === "aggregator" ? e.aggregatorId : null))).toEqual([
      "zernio",
      "ayrshare",
    ]);
  });
});
