/**
 * Opt-in LIVE proof that the Facebook transport can PUBLISH and, above all,
 * DELETE. Skipped unless RUN_FACEBOOK_PUBLISH_PROOF=1, so CI never posts.
 *
 * ⚠️ THIS WRITES TO A REAL PAGE: the Page behind META_PAGE_ID. It creates a
 * text post (and, with PROOF_IMAGE_URL set, a photo post), reads each back from
 * Meta, deletes it, and confirms it is gone. The post is live for the seconds
 * between those steps; that is the proof, not a side effect to tolerate.
 * Anything a failed assertion leaves behind is deleted by the sweep in
 * `afterAll` (helpers/proof-artifacts.ts).
 *
 * ⛔ THE DELETE IS THE POINT, AND IT IS THE LEAST CERTAIN THING HERE. Meta's
 * documentation contradicts itself on whether a Page post can be deleted
 * through the API at all (see the deletePost notes in facebook-transport.ts).
 * If this test fails, the finding is not "the test is broken": it is that
 * Facebook posts published by this engine cannot be retracted by it.
 *
 * BOTH publish paths are covered. `publishNow` routes to /photos when an image
 * with a public URL is attached and to /feed otherwise, and the two are
 * genuinely different questions rather than one with a variation:
 *
 * ⛔ A PHOTO POST IS TWO OBJECTS. `POST /{page-id}/photos` returns `{ id,
 * post_id }`: a PHOTO node that lives in the Page's albums, and the feed story
 * about it. Meta documents nothing about whether deleting the story deletes the
 * photo, so a transport that records and deletes only the story leaves the
 * photo live on the Page with its id written down nowhere. The photo half of
 * this proof is the only thing that can settle the cascade question, and its
 * post-delete assertion on the PHOTO object is the assertion that matters. See
 * PHOTO_MARKER in facebook-transport.ts.
 *
 * ⚠️ The photo test needs PROOF_IMAGE_URL: a PUBLIC image URL that Meta fetches
 * server-side, unauthenticated. An unreachable URL fails with an error about
 * the media that reads almost exactly like a credential error. Without it that
 * one test skips and the /feed tests still run.
 *
 * Environment (no defaults; export them from your own secret store):
 *   RUN_FACEBOOK_PUBLISH_PROOF=1   the gate
 *   META_APP_SECRET                the Meta app's secret (for appsecret_proof)
 *   META_SYSTEM_USER_TOKEN         a System User token with access to the Page
 *   META_PAGE_ID                   the Page to post to
 *   PROOF_IMAGE_URL                optional: a public image, enables the photo test
 *
 *   npx vitest run src/lib/social-hq/engine/__tests__/facebook.live.proof.test.ts \
 *     --project=node
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { graphRequest, setMetaCredentialsResolver, META_GRAPH_VERSION, appsecretProof } from "../meta-graph.js";
import { facebookTransport } from "../facebook-transport.js";
import { useLiveNetwork } from "./helpers/live-network.js";
import { proofArtifacts } from "./helpers/proof-artifacts.js";
import { requireEnv } from "./helpers/proof-env.js";
import type { MediaAsset, PlatformRender } from "../types.js";

const enabled = process.env.RUN_FACEBOOK_PUBLISH_PROOF === "1";

const STAMP = new Date().toISOString();

const REQUIRED = ["META_APP_SECRET", "META_SYSTEM_USER_TOKEN", "META_PAGE_ID"] as const;

/**
 * ⛔ THE SYSTEM USER TOKEN IS NOT A PAGE TOKEN.
 *
 * Passing it straight in as `pageToken` looks correct: the System User token
 * can genuinely hold `pages_manage_posts` and `pages_read_engagement` (visible
 * via debug_token). Meta still refuses `POST /{page-id}/feed` with a message
 * naming those exact permissions "with page token", an error that reads like a
 * missing scope while the scope is present. The Page's own token has to be
 * fetched first.
 *
 * An app embedding this engine derives the Page token the same way in its own
 * credential resolver; this proof does it inline because the engine must not
 * depend on any app's wiring.
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
  return { appSecret, pageToken: body.access_token, pageId };
}

/**
 * The photo half needs a publicly fetchable image; without one it skips rather
 * than failing, so a run that only has credentials still proves the /feed path.
 */
const photoEnabled = enabled && Boolean(process.env.PROOF_IMAGE_URL);

function proofImage(): MediaAsset {
  return {
    path: "/proof/card.jpg",
    type: "image",
    mimeType: "image/jpeg",
    size: 0,
    url: process.env.PROOF_IMAGE_URL ?? "",
    altText: "district-social transport self-test image.",
  };
}

/**
 * Split a composite ref, mirroring `parseRef` in facebook-transport.ts.
 *
 * Duplicated rather than exported from the transport on purpose: this file
 * tests the engine's public surface, and the proof should fail if the encoding
 * changes shape rather than silently following it.
 */
function splitRef(ref: string): { postId: string; photoId?: string } {
  const at = ref.indexOf(":photo:");
  if (at === -1) return { postId: ref };
  return { postId: ref.slice(0, at), photoId: ref.slice(at + ":photo:".length) };
}

describe.runIf(enabled)("facebook transport live proof", () => {
  // Deletes anything a failed assertion left live on the real Page. See
  // helpers/proof-artifacts.ts: without it, a throw between publish and delete
  // leaves a permanent public post and reports only as a failed expectation.
  const artifacts = proofArtifacts("facebook", facebookTransport);

  // Real network for the whole file. ⛔ The sweep runs inside the same hook,
  // BEFORE fetch is handed back to the suite's interceptor: a cleanup DELETE
  // sent after the interceptor is back is refused, and the stray post stays up
  // with only a `STRAY ... DELETE BY HAND` line to show for it.
  useLiveNetwork(() => artifacts.sweep());

  beforeAll(() => {
    requireEnv(REQUIRED);
  });

  beforeEach(() => {
    setMetaCredentialsResolver(creds);
  });

  it("reports the real Page as connected", async () => {
    const status = await facebookTransport.connectStatus();
    // The reason string first: connectStatus never throws by contract, so
    // asserting the boolean alone would hide the vendor's own message.
    expect(status.reason ?? "").toBe("");
    expect(status.connected).toBe(true);
    console.log(`[proof] connected as ${status.displayName} (${status.accountId})`);
  });

  it("publishes a post, then deletes it and proves it is gone", async () => {
    const render: PlatformRender = {
      platform: "facebook",
      content: `district-social transport self-test ${STAMP}: this post is deleted automatically within seconds.`,
      mediaIndices: [],
    };

    const posted = await facebookTransport.publishNow({ render, media: [], draftId: "live-proof", destination: {} });
    // Tracked BEFORE any assertion, so a throw below cannot strand the post.
    artifacts.track(posted.ref, posted.url);
    // A Page post id is `<pageId>_<postId>`; a bare numeric id would mean we got
    // something other than a post back and every later call would be aimed at
    // the wrong object.
    expect(posted.ref).toContain("_");

    // Step 1: it exists, read back from Meta rather than from the publish response.
    const { pageToken, appSecret } = await creds();
    const read = await graphRequest<{ id: string }>(posted.ref, {
      params: { fields: "id" },
      accessToken: pageToken,
      appSecret,
    });
    expect(read.id).toBe(posted.ref);
    const factsBefore = await facebookTransport.postFacts([posted.ref]);
    expect(factsBefore.get(posted.ref)).toMatchObject({ state: "PUBLISHED", released: true });

    // Step 2: delete it. ⛔ THE UNCERTAIN CALL.
    await facebookTransport.deletePost(posted.ref);
    artifacts.untrack(posted.ref);
    console.log(`[proof] deleted ${posted.ref}`);

    // Step 3: it is REALLY gone. A 200 from the delete is exactly what this
    // test refuses to accept as evidence, and so is postFacts: it is the
    // transport's own reading of Meta and the thing under test. A direct read
    // must fail with Meta's not-found wording; a timeout or a rate limit also
    // throws, and neither is evidence of a deletion.
    await expect(
      graphRequest<{ id: string }>(posted.ref, { params: { fields: "id" }, accessToken: pageToken, appSecret }),
    ).rejects.toThrow(/does not exist|cannot be loaded/i);
  });

  /**
   * A scheduler can retry a delete after a partial failure, and someone can
   * remove a post by hand from the Page; if "already gone" threw, either case
   * would strand the leg forever.
   */
  it("treats deleting an already-deleted post as success", async () => {
    const render: PlatformRender = {
      platform: "facebook",
      content: `district-social idempotent-delete self-test ${STAMP}: deleted automatically.`,
      mediaIndices: [],
    };
    const posted = await facebookTransport.publishNow({ render, media: [], draftId: "live-proof", destination: {} });
    artifacts.track(posted.ref, posted.url);
    await facebookTransport.deletePost(posted.ref);
    artifacts.untrack(posted.ref);
    await expect(facebookTransport.deletePost(posted.ref)).resolves.toBeUndefined();
  });

  /**
   * ⛔ THE PHOTO PATH, AND THE ONE ASSERTION NOTHING ELSE CAN MAKE.
   *
   * Meta splits an image post into a photo node and a feed story and documents
   * nothing about whether deleting one deletes the other. Every unit test here
   * can only prove which calls the transport ISSUES; only this can prove what
   * Meta actually did with them. If the final assertion on the PHOTO object
   * fails, the finding is not "the test is broken": it is that image posts
   * published by this engine leave content on the Page after it reports them
   * deleted.
   */
  it.runIf(photoEnabled)(
    "publishes a photo post, then deletes BOTH the story and the photo object",
    async () => {
      const render: PlatformRender = {
        platform: "facebook",
        content: `district-social photo-delete self-test ${STAMP}: deleted automatically within seconds.`,
        mediaIndices: [0],
      };

      const posted = await facebookTransport.publishNow({
        render,
        media: [proofImage()],
        draftId: "live-proof",
        destination: {},
      });
      // Tracked BEFORE any assertion: a throw below must not leave a public
      // post on the Page with nothing recording it. See helpers/proof-artifacts.
      artifacts.track(posted.ref, posted.url);

      const { postId, photoId } = splitRef(posted.ref);
      const { pageToken, appSecret } = await creds();
      const read = (id: string) =>
        graphRequest<{ id: string }>(id, { params: { fields: "id" }, accessToken: pageToken, appSecret });

      try {
        // The transport must have recorded the photo id at all. Without this,
        // everything below would pass vacuously against a text-shaped ref.
        expect(photoId, "publishNow did not record a photo id for an image post").toBeTruthy();

        // Step 1: BOTH objects exist, read back from Meta rather than from our
        // own publish response.
        expect((await read(postId)).id).toBe(postId);
        expect((await read(photoId!)).id).toBe(photoId);
        console.log(`[proof] photo post live: story ${postId}, photo ${photoId}`);

        // Step 2: one deletePost call, which must cover both.
        await facebookTransport.deletePost(posted.ref);
        artifacts.untrack(posted.ref);
        console.log(`[proof] deleted ${posted.ref}`);

        // Step 3: the story is gone. Asserted on Meta's own not-found wording
        // rather than on "it threw": a timeout or a rate limit also throws,
        // and neither is evidence of a deletion.
        await expect(read(postId)).rejects.toThrow(/does not exist|cannot be loaded/i);

        // Step 4: ⛔ THE PHOTO IS GONE TOO. This is the assertion the whole
        // file exists for: deleting the story and deleting its photo are
        // different operations in Meta's model, and a green step 3 with a red
        // step 4 is precisely the orphaned-photo case.
        await expect(read(photoId!)).rejects.toThrow(/does not exist|cannot be loaded/i);
      } finally {
        // Guaranteed cleanup: any assertion above can throw before or between
        // the deletes, and a failed proof must still remove what it created.
        // deletePost is idempotent by contract, so repeating it is free.
        // ⛔ Untracked only after a delete that succeeded: a failed cleanup
        // stays tracked, so the afterAll sweep tries again and, failing that,
        // names the post to delete by hand.
        await facebookTransport.deletePost(posted.ref).then(
          () => artifacts.untrack(posted.ref),
          (err: unknown) => {
            console.error(`⛔ [proof] could not clean up ${posted.ref}: ${String(err)}`);
          },
        );
      }
    },
  );
});
