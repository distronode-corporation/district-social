/**
 * Opt-in LIVE proof that the Bluesky transport can actually PUBLISH and, more
 * importantly, actually DELETE. Skipped unless RUN_BLUESKY_PUBLISH_PROOF=1, so
 * CI never posts anything.
 *
 * ⚠️ THIS WRITES TO A REAL ACCOUNT: the account behind BLUESKY_IDENTIFIER. It
 * creates a text post, verifies it exists, deletes it, and verifies it is gone.
 * The post is live on the public timeline for the few seconds between those
 * steps. That is not a side effect to be tolerated: it IS the proof, and it
 * cannot be obtained any other way. Anything a failed assertion leaves behind
 * is deleted by the sweep in `afterAll` (helpers/proof-artifacts.ts).
 *
 * Why it exists: a publishing API can answer a FAILED delete with a 2xx and
 * leave the post live. Unit tests with a mocked fetch prove the code handles
 * the responses we imagine; only this proves the responses are real.
 *
 * Environment (all required, no defaults; export them from your own secret
 * store):
 *   RUN_BLUESKY_PUBLISH_PROOF=1   the gate
 *   BLUESKY_IDENTIFIER            handle or DID of the account to post as (a
 *                                 leading "@" is stripped by the engine)
 *   BLUESKY_APP_PASSWORD          an app password for that account
 *
 *   npx vitest run src/__tests__/bluesky.live.proof.test.ts
 *
 * ⛔ BEFORE RUNNING, KNOW THE BUDGET: createSession is capped at 10 per 24h per
 * account, and if this is the account a live deployment also publishes with, an
 * expensive run can lock that deployment out for the day. This run costs ONE
 * login (zero on a same-day re-run); see SESSION_FILE below for why, and do not
 * remove that store to "simplify" the setup.
 */
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AtpSessionData } from "../bluesky-xrpc.js";
import { getPosts, setBlueskyCredentialsResolver, setBlueskySessionStore } from "../bluesky.js";
import { blueskyTransport } from "../bluesky-transport.js";
import type { PlatformRender } from "../types.js";
import { useLiveNetwork } from "./helpers/live-network.js";
import { proofArtifacts } from "./helpers/proof-artifacts.js";
import { requireEnv } from "./helpers/proof-env.js";

const enabled = process.env.RUN_BLUESKY_PUBLISH_PROOF === "1";

const STAMP = new Date().toISOString();

/**
 * ⛔ THIS FILE HAS A HARD BUDGET OF TEN LOGINS PER DAY PER ACCOUNT.
 *
 * `com.atproto.server.createSession` is capped at 10 per 24h per account
 * (`RateLimit-Policy: 10;w=86400` on the response), and the budget is shared
 * with anything else that logs in as the same account, so a wasteful test run
 * does not just fail, it can lock a live deployment out for the rest of the day.
 *
 * Both `setBlueskySessionStore` and `setBlueskyCredentialsResolver` drop the
 * in-process agent, so with a `beforeEach` that registers them, each `it` would
 * otherwise open its own session: **3 logins per run, 6 after one retry**.
 *
 * Persisting the session to a temp file fixes that at the source. Test 1 logs
 * in, tests 2-3 resume via `refreshSession` (a different, far more generous
 * limit), and a re-run on the same day costs **zero** logins because the file
 * is still there. Delete the file to force a clean login.
 *
 * Two things this buys beyond the budget:
 *  - it is the only LIVE exercise of the resume path in bluesky.ts, which unit
 *    tests can only cover with a mocked CredentialSession; and
 *  - it behaves like a deployment that persists its session the same way; a
 *    proof that logs in fresh every time is not testing that code path.
 */
const SESSION_FILE = join(tmpdir(), "district-social-bsky-proof-session.json");

function fileSessionStore() {
  return {
    load: async (): Promise<AtpSessionData | null> => {
      if (!existsSync(SESSION_FILE)) return null;
      try {
        return JSON.parse(readFileSync(SESSION_FILE, "utf8")) as AtpSessionData;
      } catch {
        // A truncated or hand-edited file must cost one login, not the run.
        return null;
      }
    },
    save: async (session: AtpSessionData | null): Promise<void> => {
      if (!session) {
        rmSync(SESSION_FILE, { force: true });
        return;
      }
      writeFileSync(SESSION_FILE, JSON.stringify(session), { mode: 0o600 });
    },
  };
}

describe.runIf(enabled)("bluesky transport live proof", () => {
  // Deletes anything a failed assertion left live on the real account. See
  // helpers/proof-artifacts.ts: without it, a throw between publish and delete
  // leaves a permanent public post and reports only as a failed expectation.
  const artifacts = proofArtifacts("bluesky", blueskyTransport);

  // Real network for the whole file, with the sweep run BEFORE the network is
  // handed back to the suite's interceptor (see helpers/live-network.ts). The
  // credential resolvers are module-scoped state and need no re-arming for the
  // sweep; re-registering them there would be actively harmful, because
  // setBlueskyCredentialsResolver drops the cached agent and costs a login.
  useLiveNetwork(() => artifacts.sweep());

  let env: Record<"BLUESKY_IDENTIFIER" | "BLUESKY_APP_PASSWORD", string>;
  beforeAll(() => {
    env = requireEnv(["BLUESKY_IDENTIFIER", "BLUESKY_APP_PASSWORD"]);
  });

  beforeEach(() => {
    // Registered BEFORE the credentials resolver, so that when the resolver
    // drops the cached agent there is already somewhere to resume from. See the
    // SESSION_FILE note above: without this the run costs 3 of 10 daily logins
    // instead of 1.
    setBlueskySessionStore(fileSessionStore());
    setBlueskyCredentialsResolver(async () => ({
      identifier: env.BLUESKY_IDENTIFIER,
      password: env.BLUESKY_APP_PASSWORD,
    }));
  });

  it("reports the real account as connected", async () => {
    const status = await blueskyTransport.connectStatus();
    // Asserted FIRST and on the reason string, not on the boolean: connectStatus
    // deliberately never throws (publish must be able to skip one unreachable
    // platform and still send the rest), so a bare `connected === false`
    // assertion reports "expected true, got false" and hides the vendor's actual
    // message, which is the only thing that tells you what to fix.
    expect(status.reason ?? "").toBe("");
    expect(status.connected).toBe(true);
    // A DID, not a handle: the transport keys on the immutable identifier.
    expect(status.accountId).toMatch(/^did:/);
    console.log(`[proof] connected as ${status.displayName} (${status.accountId})`);
  });

  /**
   * The whole point. Publish, confirm the post is really there, delete it,
   * confirm it is really gone. Each assertion is a separate round trip to the
   * PDS, because "the call returned 200" is what we are refusing to trust.
   */
  it("publishes a post, then deletes it and proves it is gone", async () => {
    const render: PlatformRender = {
      platform: "bluesky",
      mediaIndices: [],
      content: `district-social transport self-test ${STAMP}: this post is deleted automatically within seconds.`,
    };

    const posted = await blueskyTransport.publishNow({ render, media: [], draftId: "live-proof", destination: {} });
    artifacts.track(posted.ref, posted.url);
    expect(posted.ref).toMatch(/^at:\/\/did:/);

    // Step 1: it exists. Read back from the PDS, not from the publish response.
    const before = await getPosts([posted.ref]);
    expect(before.map((p) => p.uri)).toContain(posted.ref);

    // ...and the transport's own fact-mapping agrees it is live.
    const factsBefore = await blueskyTransport.postFacts([posted.ref]);
    expect(factsBefore.get(posted.ref)).toMatchObject({ state: "PUBLISHED", released: true });

    // Step 2: delete it.
    await blueskyTransport.deletePost(posted.ref);
    artifacts.untrack(posted.ref);
    console.log(`[proof] deleted ${posted.ref}`);

    // Step 3: it is REALLY gone.
    //
    // ⚠️ POLLED, NOT IMMEDIATE. `deleteRecord` is applied to the PDS, which is
    // authoritative, but `getPosts` is served by the APPVIEW, a downstream
    // index that trails it. Asserting straight after the delete can fail at
    // under a second while the record is already gone from the repo: a race in
    // the test, not a failed delete. The AppView typically catches up within a
    // few seconds; polling to 20s leaves a wide margin without hiding a real
    // failure, since a delete that never applied still fails here.
    let after = await getPosts([posted.ref]);
    for (let i = 0; i < 10 && after.some((p) => p.uri === posted.ref); i++) {
      await new Promise((r) => setTimeout(r, 2000));
      after = await getPosts([posted.ref]);
    }
    expect(after.map((p) => p.uri)).not.toContain(posted.ref);

    // getPosts silently omits URIs it cannot resolve rather than 404ing, so an
    // absent post maps to QUEUE. The caller's overdue sweep owns the terminal
    // call; a transport must never answer ERROR from a lookup.
    const factsAfter = await blueskyTransport.postFacts([posted.ref]);
    expect(factsAfter.get(posted.ref)).toMatchObject({ state: "QUEUE", released: false });
  });

  /**
   * Deleting twice must succeed. A scheduler can retry a delete after a
   * partial failure, and someone can remove a post by hand on bsky.app; if
   * "already gone" threw, both cases would strand a leg forever.
   */
  it("treats deleting an already-deleted post as success", async () => {
    const render: PlatformRender = {
      platform: "bluesky",
      mediaIndices: [],
      content: `district-social idempotent-delete self-test ${STAMP}: deleted automatically.`,
    };

    const posted = await blueskyTransport.publishNow({ render, media: [], draftId: "live-proof", destination: {} });
    artifacts.track(posted.ref, posted.url);
    await blueskyTransport.deletePost(posted.ref);
    artifacts.untrack(posted.ref);
    await expect(blueskyTransport.deletePost(posted.ref)).resolves.toBeUndefined();
  });
});
