/**
 * Bluesky's DirectTransport — the first direct-vendor transport this engine
 * has, and the shape every later one (LinkedIn, the Meta trio, Reddit, X,
 * YouTube, Pinterest) copies. Everything platform-specific to how Bluesky
 * models a post lives here; everything about *talking* to Bluesky lives in
 * bluesky.ts. That split is what keeps this file readable as the exemplar:
 * no fetch, no auth, no XRPC error shapes — just "what does a post/reply/
 * delete/lookup mean on this platform".
 *
 * Engine rules apply: relative imports only, no `@/`, no prisma, no next.
 */

import {
  BlueskyError,
  buildRichText,
  createPost as blueskyCreatePost,
  createReply as blueskyCreateReply,
  deleteRecord,
  getPosts,
  getProfile,
  uploadBlob,
  type PostImage,
  type StrongRef,
} from "./bluesky.js";
import { PublishPreflightError } from "./publish.js";
import type {
  DirectConnectStatus,
  DirectPostFacts,
  DirectPublishInput,
  DirectPublishResult,
  DirectQueuedReply,
  DirectTransport,
  TransportChannelRules,
} from "./transport.js";
import { threadReplies, type MediaAsset } from "./types.js";
import { getErrorMessage } from "./error-message.js";
import { fetchMediaBytes, requireMediaUrl } from "./media-fetch.js";
import { measureLength } from "./length.js";

/** Bluesky's own hard cap. Never both images and video in one post. */
const MAX_IMAGES = 4;

/** app.bsky.feed.getPosts accepts at most 25 URIs per call. */
const GET_POSTS_BATCH = 25;

function channelRules(): TransportChannelRules {
  // 300 GRAPHEME clusters, not UTF-16 units, per the app.bsky.feed.post lexicon
  // in the installed @atproto/api (the schema the client validates against):
  //
  //     text: { type: 'string', maxLength: 3000, maxGraphemes: 300 }
  //
  // ⚠️ THAT IS TWO LIMITS, AND ONLY ONE IS DECLARED HERE. `maxLength: 3000` is
  // UTF-8 BYTES, and TransportChannelRules has no way to express a second,
  // different-unit cap on the same field. 300 graphemes of ordinary text is
  // ~300-600 bytes so the byte cap is normally slack, but a grapheme is not
  // bounded in bytes: flag emoji cost 8 and long ZWJ sequences 25+, so a
  // 300-grapheme post CAN exceed 3000 bytes and be refused by a limit nothing
  // in this system checks. Undeclared rather than silently approximated, because
  // approximating a unit is how a byte cap gets mistaken for a character cap.
  //
  // This static value is the only source of the limit for this platform; a
  // transport that omitted it would silently stop being checked at all.
  return {
    maxLength: 300,
    countMode: "grapheme",
    maxImages: MAX_IMAGES,
    // ⛔ WITHOUT THIS, QA PROMISES A RE-ENCODE THAT NEVER HAPPENS.
    //
    // `media-fit.ts`'s `needsWork()` decides whether to re-encode by reading
    // `maxImageBytes` FROM HERE, while qa.ts's `image-too-large` gate softens
    // itself from `fail` to `warn` for any direct platform with a fitter wired,
    // telling the operator the image "will be re-encoded at publish time".
    // Omitting it would satisfy the gate's condition while guaranteeing the
    // fitter does nothing: an oversized image would pass QA with a reassuring
    // warning and then fail at the vendor. Bluesky has the tightest image limit
    // of the supported platforms.
    //
    // 2,000,000 bytes, from the `app.bsky.embed.images` lexicon in the
    // installed @atproto/api (`maxSize: 2000000`). Kept numerically identical
    // to SPECS.bluesky: qa.ts reads SPECS and the publish path reads this, so the two disagreeing
    // is what produces a draft that passes QA and fails to publish.
    maxImageBytes: 2_000_000,
    // The lexicon accepts `image/*`, so there is no format to convert to and
    // declaring `imageFormats` would make the fitter transcode for no reason.
  };
}

async function connectStatus(): Promise<DirectConnectStatus> {
  try {
    const profile = await getProfile();
    return { connected: true, accountId: profile.did, displayName: profile.handle };
  } catch (err) {
    // A transport that cannot report status must not throw: publish.ts's
    // directConnectedAccounts() treats the whole platform as unreachable and
    // moves on to the other eight, but only if this resolves rather than rejects.
    return {
      connected: false,
      accountId: "",
      displayName: "",
      reason: getErrorMessage(err),
    };
  }
}

/** `at://did:plc:xxx/app.bsky.feed.post/rkey` -> the public bsky.app permalink. */
function postUrl(ref: string): string {
  const parts = ref.split("/");
  const rkey = parts[parts.length - 1];
  // The DID (authority segment of the AT URI) works exactly like a handle in
  // bsky.app's profile route, which is what makes this synchronous: a real
  // handle would need a live resolveHandle round trip, and postUrl on the
  // DirectTransport interface returns a plain string, not a Promise.
  const did = parts[2];
  return `https://bsky.app/profile/${did}/post/${rkey}`;
}

/**
 * Upload the render's selected media as Bluesky image blobs.
 *
 * Alt text has been generated and stored on every MediaAsset since the
 * formatter ran, and thrown away at every previous publish path — Postiz's
 * post-value shape has nowhere to put it. This is the first time it actually
 * reaches a platform, which is why `alt` is never allowed to silently become
 * `""` from a missing field: it comes straight from `asset.altText`.
 */
async function uploadImages(media: MediaAsset[]): Promise<PostImage[]> {
  const images = media.filter((m) => m.type === "image" || m.type === "gif").slice(0, MAX_IMAGES);
  const out: PostImage[] = [];
  for (const asset of images) {
    const bytes = await fetchMediaBytes("bluesky", requireMediaUrl("bluesky", asset));
    const blob = await uploadBlob(bytes, asset.mimeType);
    out.push({ blob, alt: asset.altText ?? "" });
  }
  return out;
}

/**
 * Bluesky takes video (`app.bsky.embed.video`), but this client never builds
 * that embed, so SPECS.bluesky.publishesVideo is false. A leg carrying a video
 * is refused before any network call, as a PublishPreflightError like
 * linkedin-transport.ts's assertNoVideo, so the rest of a multi-platform
 * publish still goes out.
 *
 * ⛔ REFUSED, NOT DROPPED. uploadImages keeps images and GIFs only, so without
 * this a video render would post as text with no visual and nothing anywhere
 * would say so.
 */
function assertNoVideo(media: MediaAsset[]): void {
  if (media.some((m) => m.type === "video")) {
    throw new PublishPreflightError(
      "Bluesky video is not supported by the direct Bluesky integration (this client never builds an " +
        "app.bsky.embed.video record). Select an image for this draft's Bluesky render instead, or drop Bluesky " +
        "from the targets, so the other platforms in this publish can still go out.",
    );
  }
}

/**
 * `app.bsky.feed.post` caps `text` at 3000 UTF-8 BYTES as well as 300
 * graphemes. QA counts graphemes, and 300 of them can run past 3000 bytes
 * (a ZWJ family emoji is one grapheme and 18 or more bytes), so the PDS would
 * refuse a post QA passed. Checked for the root and every reply before
 * anything is sent, so a refused reply cannot strand a live root.
 */
const MAX_TEXT_BYTES = 3000;

function assertTextBytes(text: string, label: string): void {
  const bytes = measureLength(text, "utf8bytes");
  if (bytes > MAX_TEXT_BYTES) {
    throw new PublishPreflightError(
      `bluesky: ${label} is ${bytes} UTF-8 bytes, over the post record's ${MAX_TEXT_BYTES}-byte cap ` +
        "(Bluesky caps bytes as well as the 300 graphemes). Shorten it, or use fewer emoji.",
    );
  }
}

function toStrongRef(rec: Record<string, string>, label: string): StrongRef {
  if (!rec.uri || !rec.cid) {
    throw new Error(`bluesky: ${label} is missing uri/cid: ${JSON.stringify(rec)}`);
  }
  return { uri: rec.uri, cid: rec.cid };
}

function strongRefToRecord(ref: StrongRef): Record<string, string> {
  return { uri: ref.uri, cid: ref.cid };
}

/**
 * The warning an inline chain returns when reply `index` (0-based) fails. The
 * same wording as x-transport.ts and threads-transport.ts, so lastError reads
 * the same whichever platform stopped.
 */
function threadStoppedWarning(index: number, total: number, reason: string): string {
  return `thread stopped at reply ${index + 1} of ${total}; that reply and any after it were not sent, the post and earlier replies are live: ${reason}`;
}

/**
 * Post the root, then either chain the whole thread inline or defer it.
 *
 * The two branches are deliberately NOT the same code path with a delay
 * bolted on: an inline chain can reference each reply's own immediately-prior
 * post because it just posted it, but a deferred reply is persisted before
 * its predecessor (if any) exists. There is no synchronous way to know a
 * not-yet-posted post's StrongRef, so every deferred reply targets the ROOT
 * directly rather than pretending to chain — the same flat relationship the
 * aggregator's `value[1..]` model always had for a delayed follow-up.
 */
async function publishNow(input: DirectPublishInput): Promise<DirectPublishResult> {
  const { render, media } = input;

  assertNoVideo(media);
  assertTextBytes(render.content, "the post");
  threadReplies(render).forEach((text, i) => assertTextBytes(text, `reply ${i + 1}`));
  const images = await uploadImages(media);
  const rootRich = await buildRichText(render.content);
  // The render's language tags ride on the root and on every inline reply: a
  // reply is its own record, and a language feed reads each record's own tag.
  const langs = render.langs?.length ? render.langs : undefined;
  const root = await blueskyCreatePost({ text: rootRich.text, facets: rootRich.facets, images, langs });

  const items = threadReplies(render);
  if (!items.length) {
    return { ref: root.uri, url: postUrl(root.uri) };
  }

  const delayMinutes = render.followupDelayMinutes ?? 0;
  if (delayMinutes <= 0) {
    // ⛔ NOTHING THROWS OUT OF HERE ONCE THE ROOT IS LIVE. A throw made the
    // registry's retry wrapper (a 429 is a rejection) and the publish ring
    // (anything else) send the whole publishNow again, posting the ROOT again
    // each time. A failed reply ends the chain and comes back as a warning.
    let parent = root;
    const replyRefs: string[] = [];
    for (const [i, text] of items.entries()) {
      try {
        const rich = await buildRichText(text);
        parent = await blueskyCreateReply({ text: rich.text, facets: rich.facets, root, parent, langs });
        replyRefs.push(parent.uri);
      } catch (err) {
        const reason = getErrorMessage(err);
        console.warn(`[bluesky] thread reply ${i + 1} failed on published post ${root.uri}, leaving the post live: ${reason}`);
        return {
          ref: root.uri,
          url: postUrl(root.uri),
          replyRefs,
          warnings: [threadStoppedWarning(i, items.length, reason)],
        };
      }
    }
    return { ref: root.uri, url: postUrl(root.uri), replyRefs };
  }

  const rootRecord = strongRefToRecord(root);
  const now = Date.now();
  const queued: DirectQueuedReply[] = items.map((text, i) => ({
    position: i + 1,
    text,
    dueAt: new Date(now + (i + 1) * delayMinutes * 60_000).toISOString(),
    parent: rootRecord,
    // Persisted with the reply: publishReply has no render to read them from.
    ...(langs ? { langs } : {}),
  }));

  return { ref: root.uri, url: postUrl(root.uri), threadRoot: rootRecord, queued };
}

/** Release one deferred thread reply. Called by publish-due once `dueAt` has passed. */
async function publishReply(
  reply: DirectQueuedReply,
  root: Record<string, string>,
): Promise<DirectPublishResult> {
  const rootRef = toStrongRef(root, "threadRoot");
  const parentRef = toStrongRef(reply.parent, "queued reply parent");
  assertTextBytes(reply.text, `reply ${reply.position}`);
  const rich = await buildRichText(reply.text);
  const posted = await blueskyCreateReply({
    text: rich.text,
    facets: rich.facets,
    root: rootRef,
    parent: parentRef,
    langs: reply.langs,
  });
  // selfRef is what lets the releaser hang the NEXT reply off this one. Without
  // it every deferred reply can only target the root, which Bluesky renders as
  // a fan of siblings rather than the thread the operator wrote.
  return { ref: posted.uri, url: postUrl(posted.uri), selfRef: strongRefToRecord(posted) };
}

/** A vendor error, timeout, or rate limit says nothing about whether a post exists. */
function isBlueskyError(err: unknown): err is BlueskyError {
  return err instanceof BlueskyError;
}

async function postFacts(refs: string[]): Promise<Map<string, DirectPostFacts>> {
  const out = new Map<string, DirectPostFacts>();
  for (let i = 0; i < refs.length; i += GET_POSTS_BATCH) {
    const batch = refs.slice(i, i + GET_POSTS_BATCH);
    let posts;
    try {
      posts = await getPosts(batch);
    } catch (err) {
      // ⚠️ Never ERROR from a lookup failure — that marks a live post dead.
      // publish-due's overdue sweep is the only thing allowed to give up on a
      // leg; a transport that cannot currently reach the vendor must answer
      // QUEUE so the next reconcile pass gets another chance.
      const reason = isBlueskyError(err) ? err.message : String(err);
      console.warn(`[bluesky] postFacts lookup failed for a batch of ${batch.length}: ${reason}`);
      for (const ref of batch) out.set(ref, { state: "QUEUE", released: false, platform: "bluesky" });
      continue;
    }
    // A post missing from the response is simply ABSENT, not an error entry —
    // getPosts silently drops uris it cannot resolve rather than 404ing.
    const found = new Set(posts.map((p) => p.uri));
    for (const ref of batch) {
      out.set(
        ref,
        found.has(ref)
          ? { state: "PUBLISHED", released: true, platform: "bluesky" }
          : // `absent` because this branch is only reachable on a SUCCESSFUL
            // getPosts (the failure case returned above), and the AT Protocol
            // answers a uri it cannot resolve by omitting it rather than by
            // erroring. So a miss here really is the vendor saying the record
            // is gone, not this client failing to ask. Still QUEUE: the caller
            // owns the grace window.
            { state: "QUEUE", released: false, platform: "bluesky", absent: true },
      );
    }
  }
  return out;
}

/**
 * A record whose deletion already happened (by any means — an earlier partial
 * failure, a manual removal on bsky.app) reads as NotFound-shaped from the
 * PDS. Recognising that is the whole point of this migration: Postiz's
 * equivalent path returns 200 while the post stays live, the opposite failure
 * mode, and this is what getting it right looks like instead.
 */
function isNotFoundError(err: unknown): boolean {
  if (!isBlueskyError(err)) return false;
  const body = err.body.toLowerCase();
  return body.includes("notfound") || body.includes("not found") || body.includes("could not locate");
}

async function deletePost(ref: string): Promise<void> {
  try {
    await deleteRecord(ref);
  } catch (err) {
    if (isNotFoundError(err)) return; // idempotent: already gone is success
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/*  Analytics                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Bluesky is the cheapest analytics on the fleet: the engagement counts ride
 * along on the SAME `app.bsky.feed.getPosts` response postFacts already uses.
 * There is no separate insights API, no extra scope and no extra call — the
 * numbers were being fetched and thrown away.
 *
 * ⚠️ The keys here are BLUESKY's, not a shared vocabulary. AnalyticsTab's own
 * header warns against the aggregator's old habit of summing metrics across
 * vendors that do not define them compatibly ("an impression on one platform is
 * not an impression on another"), so these stay platform-named and must be
 * rendered per platform.
 *
 * A count the lexicon marks optional is OMITTED rather than defaulted to 0: a
 * real zero and "the appview did not report it" look identical on a dashboard,
 * and only one of them is true.
 */
async function analyticsPost(ref: string): Promise<Record<string, number>> {
  const [post] = await getPosts([ref]);
  if (!post) return {};
  const out: Record<string, number> = {};
  if (typeof post.likeCount === "number") out.likes = post.likeCount;
  if (typeof post.repostCount === "number") out.reposts = post.repostCount;
  if (typeof post.replyCount === "number") out.replies = post.replyCount;
  if (typeof post.quoteCount === "number") out.quotes = post.quoteCount;
  return out;
}

/** Account-level counters from the profile; Bluesky exposes no per-day series. */
async function analyticsChannel(): Promise<Record<string, number>> {
  const profile = await getProfile();
  const out: Record<string, number> = {};
  if (typeof profile.followersCount === "number") out.followers = profile.followersCount;
  if (typeof profile.followsCount === "number") out.following = profile.followsCount;
  if (typeof profile.postsCount === "number") out.posts = profile.postsCount;
  return out;
}

/**
 * ⚠️ Throws when the vendor omits the count, rather than reporting 0.
 * `followerStats` returns a bare number with no way to say "unknown", and a
 * fabricated zero on a follower chart reads as an account that lost everyone.
 */
async function followerStats(): Promise<{ followers: number }> {
  const profile = await getProfile();
  if (typeof profile.followersCount !== "number") {
    throw new BlueskyError(0, "profile carried no followersCount", "GET", "app.bsky.actor.getProfile");
  }
  return { followers: profile.followersCount };
}

export const blueskyTransport: DirectTransport = {
  platform: "bluesky",
  channelRules,
  connectStatus,
  publishNow,
  deletePost,
  postFacts,
  postUrl,
  publishReply,
  analyticsPost,
  analyticsChannel,
  followerStats,
};
