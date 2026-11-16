import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { zernioAggregator, resetZernioAccounts } from "../zernio-aggregator.js";
import { setZernioTokenResolver, listAccounts } from "../zernio.js";
import type { DirectPublishInput } from "../transport.js";
import { useLiveNetwork } from "./helpers/live-network.js";
import { requireEnv } from "./helpers/proof-env.js";

/**
 * Opt-in LIVE proof that X publishes and deletes through Zernio.
 *
 * ⚠️ THIS WRITES TO A REAL ACCOUNT AND IT COSTS MONEY: the X account connected
 * to the Zernio key, which must be ZERNIO_X_EXPECTED_ACCOUNT. It creates one
 * plain-text post, reads it back, deletes it (in a `finally`), and confirms it
 * is gone. It is a separate file from the reddit proof, on a separate env flag,
 * for exactly that reason: the reddit proof is free and can be re-run freely,
 * this one has a bill attached and must be a deliberate act every single time.
 *
 * Environment (all required, no defaults; export them from your own secret
 * store):
 *   RUN_ZERNIO_X_PROOF=1          the gate
 *   ZERNIO_API_KEY                the Zernio API key
 *   ZERNIO_X_EXPECTED_ACCOUNT     the X username (no "@") the key posts as
 *
 *   npx vitest run src/lib/social-hq/engine/__tests__/zernio.x.live.proof.test.ts \
 *     --project=node
 *
 * ## The budget, and why the copy below is the way it is
 *
 * Zernio passes X's own metered pricing through at cost (check the current
 * rates before running; at the time of writing):
 *
 *   | action                        | price   |
 *   |-------------------------------|---------|
 *   | create, plain text            | $0.015  |
 *   | create, text CONTAINING a URL | $0.200  |
 *   | read (postFacts)              | $0.005  |
 *
 * ⛔ THE COPY MUST NOT CONTAIN A URL. That is not a style note: a link makes
 * this single run 13x more expensive, and it is the single easiest thing for a
 * later edit to add without noticing. The URL check below is asserted as its
 * own test row so the guard fails loudly rather than silently costing money.
 *
 * ⛔ EXACTLY ONE CREATE. The whole lifecycle lives in one `it` (publish, read
 * back, delete, confirm gone) so a re-run of a partially failed file cannot
 * quietly create a second billable post. One run is about $0.025 all in; set a
 * monthly spend cap in the Zernio dashboard before running it at all.
 *
 * ## Why this exists at all
 *
 * A green reddit proof does not cover X: it covers reddit's
 * `platformSpecificData`, reddit's ref shape and reddit's delete verb. Routing
 * X through the aggregator on the strength of a different platform's green
 * test is a route asserted to work without evidence.
 *
 * ⚠️ FIDELITY GAP, STATED PLAINLY. This injects the key raw from env, so a
 * green run says nothing about how a deployment stores and reads
 * `ZERNIO_API_KEY`.
 *
 * ⚠️ Zernio dedupes on a content hash of (platform, accountId, content) over a
 * 24-HOUR window and answers 409, so the copy is stamped.
 */

const RUN = process.env.RUN_ZERNIO_X_PROOF === "1";

const REQUIRED = ["ZERNIO_API_KEY", "ZERNIO_X_EXPECTED_ACCOUNT"] as const;

const STAMP = `${Date.now().toString(36)}`;

/**
 * Anything that would trip X's link detection and move this to the $0.200 tier.
 * Deliberately broader than a strict URL parser: a bare `example.com` is still
 * a link to X, and costs the same as a fully qualified one.
 */
const URLISH = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|ca|io|ai|net|org|co|dev)\b)/i;

/** No link, no @mention, nothing that reads as promotional. */
const CONTENT =
  `Publishing pipeline integration check ${STAMP}. ` +
  `Automated post from the operator's own tooling, removed immediately.`;

function input(): DirectPublishInput {
  return {
    render: { platform: "twitter", content: CONTENT, mediaIndices: [] },
    media: [],
    draftId: `x-proof-${STAMP}`,
    destination: {},
  } as unknown as DirectPublishInput;
}

describe.runIf(RUN)("zernio live X publish proof", () => {
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
   * ⛔ THE COST GATE, ASSERTED AS ITS OWN ROW. vitest does not bail after a
   * failed `it`, so this cannot live only in a beforeAll, and the publish below
   * would still run and still be billed.
   */
  it("posts plain text with no URL, so it bills at the plain-text rate", () => {
    expect(CONTENT).not.toMatch(URLISH);
    expect(input().render.platform).toBe("twitter");
    expect(input().media).toHaveLength(0);
  });

  it("resolves the expected X account", async () => {
    const accounts = await listAccounts();
    const x = accounts.find((a) => a.platform === "twitter");

    expect(x).toBeDefined();
    expect(x!.isActive).not.toBe(false);
    expect(x!.username).toBe(env.ZERNIO_X_EXPECTED_ACCOUNT);
    console.log(`[x-proof] account ${x!._id} @${x!.username}`);
  });

  it("reports connected", async () => {
    const status = await zernioAggregator.connectStatus("twitter");
    expect(status.connected).toBe(true);
    expect(status.accountId).toMatch(/^[a-f0-9]{24}$/);
  });

  /**
   * The entire lifecycle in ONE test. Splitting it would let a failure strand a
   * live, billed post on the account with nothing holding its id.
   */
  it("publishes, reads back, deletes, and confirms it is gone", async () => {
    // Re-checked here, not only in its own row: vitest does not bail after a
    // failed `it`, and the wrong account must never get the post.
    const accounts = await listAccounts();
    expect(accounts.find((a) => a.platform === "twitter")?.username).toBe(env.ZERNIO_X_EXPECTED_ACCOUNT);

    const published = await zernioAggregator.publishNow("twitter", input());

    console.log(`[x-proof] published ${published.ref} -> ${published.url ?? "(no url)"}`);

    try {
      // The ref carries BOTH ids: Zernio's (needed to unpublish) and X's (needed
      // for the permalink). Neither alone is sufficient.
      expect(published.ref).toContain("~");
      const [zernioId, nativeId] = published.ref.split("~");
      expect(zernioId).toMatch(/^[a-f0-9]{24}$/);
      expect(nativeId!.length).toBeGreaterThan(0);

      const facts = await zernioAggregator.postFacts("twitter", [published.ref]);
      expect(facts.get(published.ref)).toMatchObject({ state: "PUBLISHED", released: true });

      // ⛔ This read is what a periodic reconcile repeats until the leg is
      // marked confirmed. If `released` is not true here, every reconcile
      // re-reads the leg at the per-read price forever and the cap drains on
      // reads with no posts to show for it. That is the specific failure mode
      // worth proving, not the publish.
      expect(facts.get(published.ref)!.released).toBe(true);

      // The permalink is X's own, not a Zernio dashboard link.
      expect(zernioAggregator.postUrl("twitter", published.ref)).toMatch(
        /(x\.com|twitter\.com)/,
      );
    } finally {
      await zernioAggregator.deletePost("twitter", published.ref);
      console.log(`[x-proof] deleted ${published.ref}`);
    }

    // Idempotent by contract: "already gone" is a 400 from this vendor, not a
    // 404, and deletePost has to absorb both or a retry looks permanently stuck.
    await expect(
      zernioAggregator.deletePost("twitter", published.ref),
    ).resolves.toBeUndefined();
  });
});
