// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Opt-in LIVE proof that the Instagram transport can PUBLISH and DELETE.
 * Skipped unless RUN_INSTAGRAM_PUBLISH_PROOF=1, so CI never posts.
 *
 * ⚠️ THIS WRITES TO A REAL ACCOUNT: the Instagram business account behind
 * META_IG_USER_ID (linked to the Page behind META_PAGE_ID). It creates an image
 * post, reads it back from Meta, deletes it, and confirms it is gone. Anything
 * a failed assertion leaves behind is deleted by the sweep in `afterAll`
 * (helpers/proof-artifacts.ts).
 *
 * ⛔ INSTAGRAM CANNOT POST WITHOUT MEDIA, and the image must be a PUBLIC JPEG
 * URL that Meta fetches server-side, unauthenticated: there is no bytes-upload
 * path for this transport. That makes this a proof with an external
 * dependency: if PROOF_IMAGE_URL is not reachable from Meta's crawlers the
 * container fails with an error about the media, not about the credential, and
 * the two read almost identically. Set it explicitly rather than debugging that
 * distinction under time pressure.
 *
 * Also two calls, not one: create a container, then publish it. A container can
 * report FINISHED and still fail to publish, so only the second id is a post.
 *
 * Environment (all required, no defaults; export them from your own secret
 * store):
 *   RUN_INSTAGRAM_PUBLISH_PROOF=1   the gate
 *   META_APP_SECRET                 the Meta app's secret (for appsecret_proof)
 *   META_SYSTEM_USER_TOKEN          a System User token with access to the Page
 *   META_PAGE_ID                    the Page the IG account is linked to
 *   META_IG_USER_ID                 the IG business account to post to
 *   PROOF_IMAGE_URL                 a public .jpg
 *
 *   npx vitest run src/__tests__/instagram.live.proof.test.ts
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { graphRequest, setMetaCredentialsResolver, META_GRAPH_VERSION, appsecretProof } from "../meta-graph.js";
import { instagramTransport } from "../instagram-transport.js";
import { useLiveNetwork } from "./helpers/live-network.js";
import { proofArtifacts } from "./helpers/proof-artifacts.js";
import { requireEnv } from "./helpers/proof-env.js";
import type { MediaAsset, PlatformRender } from "../types.js";

const enabled = process.env.RUN_INSTAGRAM_PUBLISH_PROOF === "1";

const STAMP = new Date().toISOString();

const REQUIRED = [
  "META_APP_SECRET",
  "META_SYSTEM_USER_TOKEN",
  "META_PAGE_ID",
  "META_IG_USER_ID",
  "PROOF_IMAGE_URL",
] as const;

/**
 * Derives the PAGE token, as a deployment's credential resolver should.
 *
 * ⚠️ Instagram publishing also works with the raw System User token, which is
 * exactly why passing that in would be a weaker proof: Facebook is the strict
 * one (`POST /{page-id}/feed` demands a Page token), and both platforms resolve
 * through ONE Meta credential resolver. A green Instagram run on the raw token
 * makes the shared resolver look proven while Facebook fails on it.
 *
 * This test therefore uses the Page token deliberately: it is the thing a
 * deployment sends, and a proof run on a credential production does not use
 * proves nothing about production.
 */
async function creds() {
  const env = requireEnv(REQUIRED);
  const appSecret = env.META_APP_SECRET;
  const systemUserToken = env.META_SYSTEM_USER_TOKEN;
  const pageId = env.META_PAGE_ID;
  const res = await fetch(
    `https://graph.facebook.com/${META_GRAPH_VERSION}/${pageId}` +
      `?fields=access_token&access_token=${encodeURIComponent(systemUserToken)}` +
      `&appsecret_proof=${appsecretProof(systemUserToken, appSecret)}`,
  );
  const body = (await res.json()) as { access_token?: string; error?: { message?: string } };
  if (!body.access_token) {
    throw new Error(`could not derive Page token: ${body.error?.message ?? `HTTP ${res.status}`}`);
  }
  return {
    appSecret,
    pageToken: body.access_token,
    pageId,
    igUserId: env.META_IG_USER_ID,
  };
}

/** A JPEG with a public URL: the only media shape this transport accepts. */
function proofImage(): MediaAsset {
  const url = process.env.PROOF_IMAGE_URL ?? "";
  return {
    path: "/proof/card.jpg",
    type: "image",
    mimeType: "image/jpeg",
    size: 0,
    url,
    altText: "district-social transport self-test image.",
  };
}

describe.runIf(enabled)("instagram transport live proof", () => {
  // Deletes anything a failed assertion left live on the real account. See
  // helpers/proof-artifacts.ts: without it, a throw between publish and delete
  // leaves a permanent public post and reports only as a failed expectation.
  const artifacts = proofArtifacts("instagram", instagramTransport);

  // Real network for the whole file, with the sweep run BEFORE fetch is handed
  // back to the suite's interceptor (see helpers/live-network.ts).
  useLiveNetwork(() => artifacts.sweep());

  beforeAll(() => {
    requireEnv(REQUIRED);
  });

  beforeEach(() => {
    setMetaCredentialsResolver(creds);
  });

  it("has an image to post", () => {
    // Asserted separately and first, so a malformed PROOF_IMAGE_URL fails as
    // itself rather than as an opaque Meta container error two tests later.
    expect(proofImage().url, "set PROOF_IMAGE_URL to a public .jpg").toMatch(/^https:\/\/.+\.jpe?g/i);
  });

  it("reports the real IG business account as connected", async () => {
    const status = await instagramTransport.connectStatus();
    // Reason string first: connectStatus never throws by contract, so asserting
    // the boolean alone hides the vendor's own message.
    expect(status.reason ?? "").toBe("");
    expect(status.connected).toBe(true);
    console.log(`[proof] connected as ${status.displayName} (${status.accountId})`);
  });

  it("publishes a post, then deletes it and proves it is gone", async () => {
    const render: PlatformRender = {
      platform: "instagram",
      content: `district-social transport self-test ${STAMP}: deleted automatically within seconds.`,
      mediaIndices: [0],
    };

    const posted = await instagramTransport.publishNow({
      render,
      media: [proofImage()],
      draftId: "live-proof",
      destination: {},
    });
    artifacts.track(posted.ref, posted.url);
    expect(posted.ref).toBeTruthy();

    // Step 1: it exists, read back from Meta, not from the publish response.
    const { pageToken, appSecret } = await creds();
    const read = await graphRequest(posted.ref, {
      params: { fields: "id" },
      accessToken: pageToken,
      appSecret,
    });
    expect(read).toMatchObject({ id: posted.ref });
    const factsBefore = await instagramTransport.postFacts([posted.ref]);
    expect(factsBefore.get(posted.ref)).toMatchObject({ state: "PUBLISHED", released: true });

    // Step 2: delete it.
    await instagramTransport.deletePost(posted.ref);
    artifacts.untrack(posted.ref);
    console.log(`[proof] deleted ${posted.ref}`);

    // Step 3: it is REALLY gone, asserted on a direct read from Meta rather
    // than on postFacts (the transport's own reading, and the thing under
    // test). The read must fail with Meta's not-found wording: a timeout or a
    // rate limit also throws, and neither is evidence of a deletion.
    await expect(
      graphRequest(posted.ref, { params: { fields: "id" }, accessToken: pageToken, appSecret }),
    ).rejects.toThrow(/does not exist|cannot be loaded/i);
  });

  it("treats deleting an already-deleted post as success", async () => {
    const render: PlatformRender = {
      platform: "instagram",
      content: `district-social idempotent-delete self-test ${STAMP}: deleted automatically.`,
      mediaIndices: [0],
    };
    const posted = await instagramTransport.publishNow({
      render,
      media: [proofImage()],
      draftId: "live-proof",
      destination: {},
    });
    artifacts.track(posted.ref, posted.url);
    await instagramTransport.deletePost(posted.ref);
    artifacts.untrack(posted.ref);
    await expect(instagramTransport.deletePost(posted.ref)).resolves.toBeUndefined();
  });
});
