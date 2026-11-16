/**
 * Opt-in LIVE proof that the Threads transport can PUBLISH and, more
 * importantly, DELETE. Skipped unless RUN_THREADS_PUBLISH_PROOF=1, so CI never
 * posts anything.
 *
 * ⚠️ THIS WRITES TO A REAL ACCOUNT: the account behind THREADS_TOKEN
 * (THREADS_USER_ID). It creates a text post, reads it back from Meta, deletes
 * it, and confirms it is gone. The post is live for the few seconds between
 * those steps. That is not a side effect to tolerate: it IS the proof, and
 * there is no other way to obtain it. Anything a failed assertion leaves behind
 * is deleted by the sweep in `afterAll` (helpers/proof-artifacts.ts).
 *
 * ⛔ THREADS-SPECIFIC HAZARD: publishing here is TWO calls (create a container,
 * then publish it), and the container can report FINISHED and still fail at
 * publish. Only the second id is a real post. A test that stopped after
 * `createContainer` would prove nothing about whether anything was posted.
 *
 * Environment (no defaults; export them from your own secret store):
 *   RUN_THREADS_PUBLISH_PROOF=1   the gate
 *   THREADS_TOKEN                 a Threads user access token
 *   THREADS_USER_ID               the Threads user id that token belongs to
 *   THREADS_APP_SECRET            the app secret for appsecret_proof
 *                                 (META_APP_SECRET is read if this is unset)
 *
 *   npx vitest run src/__tests__/threads.live.proof.test.ts
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getPermalink, isThreadsNotFound, setThreadsCredentialsResolver } from "../threads.js";
import { threadsTransport } from "../threads-transport.js";
import { useLiveNetwork } from "./helpers/live-network.js";
import { proofArtifacts } from "./helpers/proof-artifacts.js";
import { requireEnv } from "./helpers/proof-env.js";
import type { PlatformRender } from "../types.js";

const enabled = process.env.RUN_THREADS_PUBLISH_PROOF === "1";

const STAMP = new Date().toISOString();

describe.runIf(enabled)("threads transport live proof", () => {
  // Deletes anything a failed assertion left live on the real account. See
  // helpers/proof-artifacts.ts: without it, a throw between publish and delete
  // leaves a permanent public post and reports only as a failed expectation.
  const artifacts = proofArtifacts("threads", threadsTransport);

  // Real network for the whole file, with the sweep run BEFORE fetch is handed
  // back to the suite's interceptor (see helpers/live-network.ts).
  useLiveNetwork(() => artifacts.sweep());

  let creds: { accessToken: string; userId: string; appSecret: string };
  beforeAll(() => {
    const env = requireEnv(["THREADS_TOKEN", "THREADS_USER_ID"]);
    const appSecret = process.env.THREADS_APP_SECRET || process.env.META_APP_SECRET;
    if (!appSecret) {
      throw new Error(
        "live proof: set THREADS_APP_SECRET (or META_APP_SECRET) (export them from your own secret store)",
      );
    }
    creds = { accessToken: env.THREADS_TOKEN, userId: env.THREADS_USER_ID, appSecret };
  });

  beforeEach(() => {
    setThreadsCredentialsResolver(async () => creds);
  });

  it("reports the real account as connected", async () => {
    const status = await threadsTransport.connectStatus();
    // Asserted on the reason string FIRST, not the boolean: connectStatus never
    // throws by contract (publish must be able to skip one dead platform and
    // still send the rest), so a bare `connected === false` assertion hides the
    // vendor's message, which is the only thing that says what to fix.
    expect(status.reason ?? "").toBe("");
    expect(status.connected).toBe(true);
    console.log(`[proof] connected as ${status.displayName} (${status.accountId})`);
  });

  it("publishes a post, then deletes it and proves it is gone", async () => {
    const render: PlatformRender = {
      platform: "threads",
      content: `district-social transport self-test ${STAMP}: this post is deleted automatically within seconds.`,
      mediaIndices: [],
    };

    const posted = await threadsTransport.publishNow({ render, media: [], draftId: "live-proof", destination: {} });
    artifacts.track(posted.ref, posted.url);
    expect(posted.ref).toBeTruthy();

    // Step 1: it exists, read back from Meta, not from the publish response. A
    // permalink only exists for a real, published thread.
    await expect(getPermalink(posted.ref)).resolves.toBeTruthy();
    const factsBefore = await threadsTransport.postFacts([posted.ref]);
    expect(factsBefore.get(posted.ref)).toMatchObject({ state: "PUBLISHED", released: true });

    // Step 2: delete it.
    await threadsTransport.deletePost(posted.ref);
    artifacts.untrack(posted.ref);
    console.log(`[proof] deleted ${posted.ref}`);

    // Step 3: it is REALLY gone, asserted on a direct read from the vendor
    // rather than on the delete call's status code or on postFacts (the
    // transport's own reading, and the thing under test). The read must fail
    // as not-found: a timeout or a rate limit also throws, and neither is
    // evidence of a deletion.
    const readErr = await getPermalink(posted.ref).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(isThreadsNotFound(readErr), `the read after delete did not fail as not-found: ${String(readErr)}`).toBe(
      true,
    );
  });

  /**
   * Deleting twice must succeed. A scheduler can retry a delete after a
   * partial failure, and someone can remove a post by hand in the app; if
   * "already gone" threw, both cases would strand the leg forever.
   */
  it("treats deleting an already-deleted post as success", async () => {
    const render: PlatformRender = {
      platform: "threads",
      content: `district-social idempotent-delete self-test ${STAMP}: deleted automatically.`,
      mediaIndices: [],
    };
    const posted = await threadsTransport.publishNow({ render, media: [], draftId: "live-proof", destination: {} });
    artifacts.track(posted.ref, posted.url);
    await threadsTransport.deletePost(posted.ref);
    artifacts.untrack(posted.ref);
    await expect(threadsTransport.deletePost(posted.ref)).resolves.toBeUndefined();
  });
});
