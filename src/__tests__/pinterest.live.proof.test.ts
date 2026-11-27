// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Opt-in LIVE proof that the Pinterest transport can PUBLISH and DELETE.
 * Skipped unless RUN_PINTEREST_PUBLISH_PROOF=1, so CI never posts anything.
 *
 * ⚠️ THIS WRITES TO A REAL ACCOUNT: the account behind PINTEREST_TOKEN, which
 * must be PINTEREST_EXPECTED_ACCOUNT, on the board PINTEREST_BOARD_ID. It
 * creates a pin, reads it back from Pinterest, deletes it, and confirms what
 * the vendor says afterwards. The pin is live for the few seconds in between.
 * That is not a side effect to tolerate: it IS the proof, and there is no other
 * way to obtain it. Anything a failed assertion leaves behind is deleted by the
 * sweep in `afterAll` (helpers/proof-artifacts.ts).
 *
 * ⛔ WHY READ-SHAPED CHECKS PROVE NOTHING HERE. An app on Pinterest's Trial
 * access tier cannot create pins on production at all:
 *
 *     POST https://api.pinterest.com/v5/pins
 *     403 {"code":29,"message":"Apps with Trial access may not create Pins in
 *          production ... use API Sandbox https://api-sandbox.pinterest.com"}
 *
 * while `/user_account` and `/boards` answer 200. So every read-shaped signal
 * an integration has (a green connect, a correct board list, a populated
 * settings panel) can be true and meaningless. A create, read back, DELETE and
 * re-read (404, code 50) is the only check that tells a working Pinterest
 * integration from a broken one, and this test makes it repeatable.
 *
 * ⚠️ FIDELITY GAP, STATED PLAINLY. A deployment normally reads the token from
 * its own (encrypted) token store. This proof injects a RAW bearer from env,
 * which exercises the client and the transport but NOT the storage path.
 *
 * Environment (all required, no defaults; export them from your own secret
 * store):
 *   RUN_PINTEREST_PUBLISH_PROOF=1   the gate
 *   PINTEREST_TOKEN                 a raw ACCESS token (see the warning below)
 *   PINTEREST_EXPECTED_ACCOUNT      the account id the token must belong to
 *   PINTEREST_BOARD_ID              a board on that account to pin to
 *   PROOF_IMAGE_URL                 a public .png or .jpg
 *   PROOF_LINK_URL                  the pin's click-through URL
 *
 *   npx vitest run src/__tests__/pinterest.live.proof.test.ts
 *
 * ⛔ DO NOT OBTAIN THE BEARER BY REDEEMING THE REFRESH TOKEN. Pinterest ROTATES
 * the refresh token on every redemption, so a manual refresh outside the
 * deployment's own compare-and-swap invalidates the stored one and takes the
 * live integration down until somebody re-consents in a browser. Use the
 * ACCESS token the deployment already holds, as-is (valid for 30 days from
 * when it was obtained), and keep it out of any file under the repository.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setPinterestTokenResolver } from "../pinterest.js";
import { pinterestTransport } from "../pinterest-transport.js";
import { useLiveNetwork } from "./helpers/live-network.js";
import { proofArtifacts } from "./helpers/proof-artifacts.js";
import { requireEnv } from "./helpers/proof-env.js";
import type { MediaAsset, PlatformRender } from "../types.js";

const enabled = process.env.RUN_PINTEREST_PUBLISH_PROOF === "1";

const STAMP = new Date().toISOString();

const REQUIRED = [
  "PINTEREST_TOKEN",
  "PINTEREST_EXPECTED_ACCOUNT",
  "PINTEREST_BOARD_ID",
  "PROOF_IMAGE_URL",
  "PROOF_LINK_URL",
] as const;

/**
 * An image with a public URL. Pinterest's `image_base64` media source takes
 * only image/jpeg and image/png (openapi.yaml `ContentType`), and the transport
 * FETCHES this URL to get the bytes, so an unreachable URL fails the publish,
 * not the assertion.
 */
function proofImage(): MediaAsset {
  const url = process.env.PROOF_IMAGE_URL ?? "";
  return {
    path: "/proof/card.png",
    type: "image",
    mimeType: /\.jpe?g(\?|$)/i.test(url) ? "image/jpeg" : "image/png",
    size: 0,
    url,
    altText: "district-social transport self-test image.",
  };
}

describe.runIf(enabled)("pinterest transport live proof", () => {
  // Deletes anything a failed assertion left live on the real account. See
  // helpers/proof-artifacts.ts: without it, a throw between publish and delete
  // leaves a permanent public pin and reports only as a failed expectation.
  const artifacts = proofArtifacts("pinterest", pinterestTransport);

  // Real network for the whole file, including wherever PROOF_IMAGE_URL lives
  // (the transport fetches the bytes itself), with the sweep run BEFORE fetch
  // is handed back to the suite's interceptor (see helpers/live-network.ts).
  useLiveNetwork(() => artifacts.sweep());

  let env: Record<(typeof REQUIRED)[number], string>;
  beforeAll(() => {
    env = requireEnv(REQUIRED);
  });

  beforeEach(() => {
    setPinterestTokenResolver(async () => env.PINTEREST_TOKEN);
  });

  /**
   * Re-assert the account. Called as the FIRST statement of every test that
   * publishes: vitest does not bail after a failed `it`, so the connect row
   * above failing on the wrong account would not stop a pin going to it.
   */
  async function requireAccount(): Promise<void> {
    const status = await pinterestTransport.connectStatus();
    expect(status.reason ?? "").toBe("");
    expect(status.accountId).toBe(env.PINTEREST_EXPECTED_ACCOUNT);
  }

  it("has an image to pin", () => {
    // Asserted separately and first, so a malformed PROOF_IMAGE_URL fails as
    // itself rather than as an opaque vendor error two tests later. Pinterest
    // requires media on EVERY pin, so there is no text-only fallback here.
    expect(proofImage().url, "set PROOF_IMAGE_URL to a public .png or .jpg").toMatch(
      /^https:\/\/.+\.(png|jpe?g)/i,
    );
  });

  it("reports the expected account as connected", async () => {
    const status = await pinterestTransport.connectStatus();
    // Asserted on the reason string FIRST, not the boolean: connectStatus never
    // throws by contract (publish must be able to skip one dead platform and
    // still send the rest), so a bare `connected === false` assertion hides the
    // vendor's message, which is the only thing that says what to fix.
    expect(status.reason ?? "").toBe("");
    expect(status.connected).toBe(true);
    expect(status.accountId).toBe(env.PINTEREST_EXPECTED_ACCOUNT);
    console.log(`[proof] connected as ${status.displayName} (${status.accountId})`);
  });

  /**
   * ⛔ A green connectStatus is NOT evidence the board exists. `/boards` answers
   * 200 even on Trial access, and a publish to an id that is not on this
   * account fails at create time with a vendor error that reads like a
   * permissions problem. Assert the configured board is really there.
   */
  it("can see the configured board", async () => {
    const boards = await pinterestTransport.listBoards!();
    expect(boards.length).toBeGreaterThan(0);
    const match = boards.find((b) => b.id === env.PINTEREST_BOARD_ID);
    expect(
      match,
      `board ${env.PINTEREST_BOARD_ID} is not on this account; available: ${boards
        .map((b) => `${b.id}=${b.name}`)
        .join(", ")}`,
    ).toBeTruthy();
    console.log(`[proof] board ${match!.id} = ${match!.name}`);
  });

  it("publishes a pin, then deletes it and reports what Pinterest says after", async () => {
    await requireAccount();

    const render: PlatformRender = {
      platform: "pinterest",
      // No URL in the copy on purpose: Pinterest carries the destination as its
      // own field and the playbook strips links out of the description, so a URL
      // here would be inert text. `destination.link` below is the clickable one.
      content: `district-social transport self-test ${STAMP}: this pin is deleted automatically within seconds.`,
      mediaIndices: [0],
    };

    const posted = await pinterestTransport.publishNow({
      render,
      media: [proofImage()],
      draftId: "live-proof",
      // ⛔ `board` is DEREFERENCED by this transport, and a missing one throws
      // before any vendor call. `link` is the pin's click-through URL: a pin
      // published without it succeeds, returns a real id, reports analytics,
      // and goes NOWHERE when clicked, which is most of the point of a pin.
      destination: { board: env.PINTEREST_BOARD_ID, link: env.PROOF_LINK_URL },
    });
    artifacts.track(posted.ref, posted.url);
    expect(posted.ref).toBeTruthy();

    // Step 1: it exists, read back from Pinterest, not from the publish response.
    const factsBefore = await pinterestTransport.postFacts([posted.ref]);
    expect(factsBefore.get(posted.ref)).toMatchObject({ state: "PUBLISHED", released: true });

    // Step 2: delete it.
    await pinterestTransport.deletePost(posted.ref);
    artifacts.untrack(posted.ref);
    console.log(`[proof] deleted ${posted.ref}`);

    // Step 3: the vendor confirms it is gone. Pinterest's single-object GET
    // answers a definitive 404, which is strictly more than Bluesky's batch
    // getPosts or LinkedIn's BATCH_GET can say, so `absent` is asserted here
    // where the LinkedIn proof deliberately stops at "not PUBLISHED".
    //
    // ⚠️ `state` stays QUEUE even so, and that is the transport working as
    // designed rather than a weak assertion: the grace period on "ref not
    // found" belongs to the caller, not to a transport that receives bare refs
    // and no timestamps. See pinterest-transport.ts's postFacts docblock.
    const factsAfter = await pinterestTransport.postFacts([posted.ref]);
    expect(factsAfter.get(posted.ref)).toMatchObject({
      state: "QUEUE",
      released: false,
      absent: true,
    });
  });

  /**
   * Deleting twice must succeed. A scheduler can retry a delete after a
   * partial failure, and someone can remove a pin by hand on pinterest.com; if
   * "already gone" threw, both cases would strand the leg forever.
   */
  it("treats deleting an already-deleted pin as success", async () => {
    await requireAccount();

    const render: PlatformRender = {
      platform: "pinterest",
      content: `district-social idempotent-delete self-test ${STAMP}: deleted automatically.`,
      mediaIndices: [0],
    };
    const posted = await pinterestTransport.publishNow({
      render,
      media: [proofImage()],
      draftId: "live-proof",
      destination: { board: env.PINTEREST_BOARD_ID, link: env.PROOF_LINK_URL },
    });
    artifacts.track(posted.ref, posted.url);
    await pinterestTransport.deletePost(posted.ref);
    artifacts.untrack(posted.ref);
    await expect(pinterestTransport.deletePost(posted.ref)).resolves.toBeUndefined();
  });
});
