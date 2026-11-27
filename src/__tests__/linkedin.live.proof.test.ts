// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Opt-in LIVE proof that the LinkedIn transport can PUBLISH and, more
 * importantly, DELETE. Skipped unless RUN_LINKEDIN_PUBLISH_PROOF=1, so CI never
 * posts anything.
 *
 * ⚠️ THIS WRITES TO A REAL COMPANY PAGE: `urn:li:organization:<LINKEDIN_ORG_ID>`.
 * It creates a text post, reads it back from LinkedIn, deletes it, and confirms
 * what the vendor says afterwards. The post is live for the few seconds in
 * between. That is not a side effect to tolerate: it IS the proof, and there
 * is no other way to obtain it. Anything a failed assertion leaves behind is
 * deleted by the sweep in `afterAll` (helpers/proof-artifacts.ts).
 *
 * ⛔ THE HAZARD THIS PLATFORM SPECIFICALLY HAS. A LinkedIn token can be
 * perfectly valid and still administer the WRONG PAGE. A member who
 * administers several organizations gets all of them from `organizationAcls`,
 * in an order LinkedIn chooses, so an unpinned integration is one ordering flip
 * away from publishing to an unrelated company page while reporting itself
 * healthy the whole time: the credential IS valid, only the audience is wrong.
 * Every publishing test below therefore re-asserts the org as its FIRST
 * statement. vitest does not bail on a previously failed `it`, so ordering is
 * not a guarantee and the guard cannot live in a `beforeEach` assertion alone.
 *
 * ⚠️ FIDELITY GAP, STATED PLAINLY. A deployment normally reads the token from
 * its own (encrypted) token store. This proof injects a RAW bearer from env,
 * which exercises the client and the transport but NOT the storage path. A
 * green run here says nothing about whether the deployment can read its row.
 *
 * Environment (all required, no defaults; export them from your own secret
 * store):
 *   RUN_LINKEDIN_PUBLISH_PROOF=1   the gate
 *   LINKEDIN_TOKEN                 a raw access token for a Page admin
 *   LINKEDIN_ORG_ID                numeric id of the ONE organization this
 *                                  proof may post to
 *
 *   npx vitest run src/__tests__/linkedin.live.proof.test.ts
 *
 * ⛔ The access token is a live publish credential. Keep it out of any file
 * under the repository (editor history and backup tools shadow-copy those) and
 * pass it inline for the one invocation.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  getOrganizationUrn,
  getPostsBatch,
  setLinkedInOrganizationId,
  setLinkedInTokenResolver,
} from "../linkedin.js";
import { linkedinTransport } from "../linkedin-transport.js";
import { useLiveNetwork } from "./helpers/live-network.js";
import { proofArtifacts } from "./helpers/proof-artifacts.js";
import { requireEnv } from "./helpers/proof-env.js";
import type { PlatformRender } from "../types.js";

const enabled = process.env.RUN_LINKEDIN_PUBLISH_PROOF === "1";

const STAMP = new Date().toISOString();

describe.runIf(enabled)("linkedin transport live proof", () => {
  // Deletes anything a failed assertion left live on the real company page. See
  // helpers/proof-artifacts.ts: without it, a throw between publish and delete
  // leaves a permanent public post and reports only as a failed expectation.
  const artifacts = proofArtifacts("linkedin", linkedinTransport);

  // Real network for the whole file, with the sweep run BEFORE fetch is handed
  // back to the suite's interceptor (see helpers/live-network.ts).
  useLiveNetwork(() => artifacts.sweep());

  let env: Record<"LINKEDIN_TOKEN" | "LINKEDIN_ORG_ID", string>;
  /** The one page this proof is ever allowed to touch. */
  let expectedOrg: string;

  beforeAll(() => {
    env = requireEnv(["LINKEDIN_TOKEN", "LINKEDIN_ORG_ID"]);
    expectedOrg = `urn:li:organization:${env.LINKEDIN_ORG_ID}`;
  });

  beforeEach(() => {
    // Order matters: setLinkedInTokenResolver CLEARS the cached org URN, so
    // pinning the org first would be undone by it.
    setLinkedInTokenResolver(async () => env.LINKEDIN_TOKEN);
    setLinkedInOrganizationId(env.LINKEDIN_ORG_ID);
  });

  /**
   * Re-assert the audience. Called as the FIRST statement of every test that
   * publishes; see the header: a valid token administering the wrong page is
   * this platform's actual failure mode, and it presents as success.
   */
  async function requireOrg(): Promise<void> {
    const org = await getOrganizationUrn();
    expect(org).toBe(expectedOrg);
  }

  it("reports the real company page as connected", async () => {
    const status = await linkedinTransport.connectStatus();
    // Asserted on the reason string FIRST, not the boolean: connectStatus never
    // throws by contract (publish must be able to skip one dead platform and
    // still send the rest), so a bare `connected === false` assertion hides the
    // vendor's message, which is the only thing that says what to fix.
    expect(status.reason ?? "").toBe("");
    expect(status.connected).toBe(true);
    expect(status.accountId).toBe(expectedOrg);
    console.log(`[proof] connected as ${status.displayName} (${status.accountId})`);
  });

  it("publishes a post, then deletes it and reports what LinkedIn says after", async () => {
    await requireOrg();

    const render: PlatformRender = {
      platform: "linkedin",
      content: `district-social transport self-test ${STAMP}: this post is deleted automatically within seconds.`,
      mediaIndices: [],
    };

    const posted = await linkedinTransport.publishNow({
      render,
      media: [],
      draftId: "live-proof",
      // ⛔ Required. linkedin-transport does not dereference it, but transports
      // that DO (pinterest `.board`, reddit `.subreddit`) fail at runtime
      // without it, so every proof passes one.
      destination: {},
    });
    artifacts.track(posted.ref, posted.url);
    expect(posted.ref).toBeTruthy();

    // Step 1: it exists, read back from LinkedIn, not from the publish response.
    const factsBefore = await linkedinTransport.postFacts([posted.ref]);
    expect(factsBefore.get(posted.ref)).toMatchObject({ state: "PUBLISHED", released: true });

    // The byproduct this proof exists to capture. getPostsBatch's docblock and
    // linkedin-transport's postFacts both carry an UNVERIFIED note: LinkedIn's
    // BATCH_GET is described as returning a missing id in an `errors` map, but
    // every sample response in the docs shows `errors: {}` and there is no
    // worked example of a not-found entry. Because of that ambiguity postFacts
    // can only ever answer QUEUE for a deleted post, never `absent`, so a
    // caller cannot distinguish "deleted" from "lookup failed". Printing the RAW
    // response either side of a delete is the only way to settle it, and this
    // is the only place a genuinely deleted LinkedIn URN exists to ask about.
    console.log(`[proof] BATCH_GET raw BEFORE delete: ${JSON.stringify(await getPostsBatch([posted.ref]))}`);

    // Step 2: delete it.
    await linkedinTransport.deletePost(posted.ref);
    artifacts.untrack(posted.ref);
    console.log(`[proof] deleted ${posted.ref}`);

    const rawAfter = await getPostsBatch([posted.ref]);
    console.log(`[proof] BATCH_GET raw AFTER delete: ${JSON.stringify(rawAfter)}`);

    // Step 3: it is no longer positively confirmed as live. Deliberately NOT
    // asserted as `absent`: per the note above this client cannot yet tell
    // "gone" from "unrecognised response shape", and encoding the stronger claim
    // would be a test agreeing with a guess. Tighten this only once the logged
    // shapes above have been read.
    const factsAfter = await linkedinTransport.postFacts([posted.ref]);
    expect(factsAfter.get(posted.ref)?.released).toBe(false);
    expect(factsAfter.get(posted.ref)?.state).not.toBe("PUBLISHED");
  });

  /**
   * Deleting twice must succeed. A scheduler can retry a delete after a
   * partial failure, and someone can remove a post by hand in the app; if
   * "already gone" threw, both cases would strand the leg forever.
   */
  it("treats deleting an already-deleted post as success", async () => {
    await requireOrg();

    const render: PlatformRender = {
      platform: "linkedin",
      content: `district-social idempotent-delete self-test ${STAMP}: deleted automatically.`,
      mediaIndices: [],
    };
    const posted = await linkedinTransport.publishNow({
      render,
      media: [],
      draftId: "live-proof",
      destination: {},
    });
    artifacts.track(posted.ref, posted.url);
    await linkedinTransport.deletePost(posted.ref);
    artifacts.untrack(posted.ref);
    await expect(linkedinTransport.deletePost(posted.ref)).resolves.toBeUndefined();
  });
});
