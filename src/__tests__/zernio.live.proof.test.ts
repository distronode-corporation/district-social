import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { zernioAggregator, resetZernioAccounts } from "../zernio-aggregator.js";
import { setZernioTokenResolver, listAccounts } from "../zernio.js";
import type { DirectPublishInput } from "../transport.js";
import { useLiveNetwork } from "./helpers/live-network.js";
import { requireEnv } from "./helpers/proof-env.js";

/**
 * Opt-in LIVE proof that the Zernio aggregator can PUBLISH and, more
 * importantly, DELETE, on Reddit. Skipped unless RUN_ZERNIO_PUBLISH_PROOF=1, so
 * CI never posts anything.
 *
 * ⚠️ THIS WRITES TO A REAL ACCOUNT: the Reddit account connected to the Zernio
 * key, which must be ZERNIO_REDDIT_EXPECTED_ACCOUNT (re-checked inside the
 * publishing test, right before the post). It creates a text post in
 * ZERNIO_REDDIT_SUBREDDIT, reads it back, deletes it (in a `finally`, so a
 * failed assertion still cleans up), reads it back again to confirm the vendor
 * no longer reports it published, and deletes it a second time to prove the
 * delete is idempotent. The post is live for the few seconds in between. That
 * is not a side effect to tolerate: it IS the proof, and there is no other way
 * to get it.
 *
 * ⛔ A SUBREDDIT YOU MODERATE, AND THAT IS LOAD-BEARING. A test post in your
 * own subreddit is not spam and cannot draw a community's mod action. In any
 * other community it is exactly what Reddit's spam and Responsible Builder
 * rules are written against, and an account flagged there can lose API access.
 * Never point it at a real community.
 *
 * ⛔ THIS FILE IS REDDIT ONLY. Other platforms can be connected on the same
 * key, and some (X) bill per post through Zernio's pass-through. Every call in
 * this file names "reddit" as a literal; X has its own file and its own flag.
 *
 * ⚠️ FIDELITY GAP, STATED PLAINLY. This injects the key raw from env, which
 * exercises the client and the aggregator but NOT however a deployment stores
 * and reads `ZERNIO_API_KEY`.
 *
 * Environment (all required, no defaults; export them from your own secret
 * store):
 *   RUN_ZERNIO_PUBLISH_PROOF=1        the gate
 *   ZERNIO_API_KEY                    the Zernio API key
 *   ZERNIO_REDDIT_SUBREDDIT           a subreddit you moderate, without "r/"
 *   ZERNIO_REDDIT_EXPECTED_ACCOUNT    the Reddit username the key posts as
 *
 *   npx vitest run src/lib/social-hq/engine/__tests__/zernio.live.proof.test.ts \
 *     --project=node
 *
 * ⚠️ Zernio dedupes on a content hash of (platform, accountId, content+media)
 * over a 24-HOUR window and answers 409. Every post below is stamped, so a
 * re-run inside the same day does not collide with the previous one.
 */

const RUN = process.env.RUN_ZERNIO_PUBLISH_PROOF === "1";

const REQUIRED = ["ZERNIO_API_KEY", "ZERNIO_REDDIT_SUBREDDIT", "ZERNIO_REDDIT_EXPECTED_ACCOUNT"] as const;

const STAMP = `${Date.now().toString(36)}`;

function input(subreddit: string): DirectPublishInput {
  return {
    render: {
      platform: "reddit",
      content:
        `Automated integration check from a district-social publishing pipeline (${STAMP}). ` +
        `Posted to the operator's own subreddit and deleted immediately.`,
      mediaIndices: [],
    },
    media: [],
    draftId: `proof-${STAMP}`,
    destination: { subreddit, title: `Publishing pipeline check ${STAMP}` },
  } as DirectPublishInput;
}

describe.runIf(RUN)("zernio live publish proof", () => {
  // Real network for the whole file (see helpers/live-network.ts).
  useLiveNetwork();

  let env: Record<(typeof REQUIRED)[number], string>;
  beforeAll(() => {
    env = requireEnv(REQUIRED);
    setZernioTokenResolver(async () => env.ZERNIO_API_KEY);
  });

  beforeEach(() => {
    resetZernioAccounts();
  });

  /**
   * A configuration check, asserted as its own row so a subreddit given as
   * `r/name` fails as itself rather than as a vendor error at publish time.
   */
  it("is configured with a bare subreddit name", () => {
    expect(env.ZERNIO_REDDIT_SUBREDDIT, "ZERNIO_REDDIT_SUBREDDIT is the bare name, without r/").not.toMatch(
      /^\/?r\//,
    );
  });

  it("resolves the connected reddit account", async () => {
    const accounts = await listAccounts();
    const reddit = accounts.find((a) => a.platform === "reddit");

    expect(reddit).toBeDefined();
    expect(reddit!.username).toBe(env.ZERNIO_REDDIT_EXPECTED_ACCOUNT);
    expect(reddit!.isActive).not.toBe(false);
  });

  it("reports connected", async () => {
    const status = await zernioAggregator.connectStatus("reddit");
    expect(status.connected).toBe(true);
    expect(status.accountId).toMatch(/^[a-f0-9]{24}$/);
  });

  /**
   * The whole lifecycle in one test, deliberately: a post that publishes and is
   * not deleted is a live post nobody cleaned up. Splitting these across `it`s
   * would let a failure in the middle strand it.
   */
  it("publishes, reads back, deletes, and confirms it is gone", async () => {
    // Re-checked here, not only in its own row: vitest does not bail after a
    // failed `it`, and the wrong account must never get the post.
    const accounts = await listAccounts();
    expect(accounts.find((a) => a.platform === "reddit")?.username).toBe(env.ZERNIO_REDDIT_EXPECTED_ACCOUNT);

    const published = await zernioAggregator.publishNow("reddit", input(env.ZERNIO_REDDIT_SUBREDDIT));

    console.log(`[proof] published ${published.ref} -> ${published.url ?? "(no url)"}`);

    try {
      // The ref carries BOTH ids, which is what makes it deletable AND linkable.
      expect(published.ref).toContain("~");
      const [zernioId, nativeId] = published.ref.split("~");
      expect(zernioId).toMatch(/^[a-f0-9]{24}$/);
      expect(nativeId.length).toBeGreaterThan(0);

      // Read back: the vendor agrees it is live.
      const facts = await zernioAggregator.postFacts("reddit", [published.ref]);
      expect(facts.get(published.ref)).toMatchObject({ state: "PUBLISHED", released: true });

      // The permalink is the NATIVE one, not a Zernio dashboard link.
      expect(zernioAggregator.postUrl("reddit", published.ref)).toContain("reddit.com");
    } finally {
      // Delete, in a finally so a failed assertion above still cleans up.
      await zernioAggregator.deletePost("reddit", published.ref);
      console.log(`[proof] deleted ${published.ref}`);
    }

    // Confirm gone: the vendor no longer reports it published. A delete that
    // resolved is not evidence on its own.
    const after = await zernioAggregator.postFacts("reddit", [published.ref]);
    expect(after.get(published.ref)).toMatchObject({ released: false });
    expect(after.get(published.ref)?.state).not.toBe("PUBLISHED");

    // Idempotent by contract, so a second delete must not throw.
    await expect(
      zernioAggregator.deletePost("reddit", published.ref),
    ).resolves.toBeUndefined();
  });

  it("reads flair requirements for the configured subreddit", async () => {
    // The proof sends no flairId, so the subreddit must require none. One that
    // DID require flair would fail the publish with a vendor error, and this
    // is the check that would explain it.
    const rules = await zernioAggregator.destinationRules!("reddit", env.ZERNIO_REDDIT_SUBREDDIT);
    expect(rules).toMatchObject({ subreddit: env.ZERNIO_REDDIT_SUBREDDIT });
  });

  it("reports channel analytics for reddit", async () => {
    const stats = await zernioAggregator.analyticsChannel!("reddit");

    // Counters are summed across published posts. `posts` is always present
    // (and nonzero once any post has gone out through the key); impressions is
    // 0 on Reddit because the vendor does not expose it here.
    expect(stats.posts).toBeGreaterThan(0);
    expect(typeof stats.likes).toBe("number");
    console.log(`[proof] reddit channel analytics: ${JSON.stringify(stats)}`);
  });
});
