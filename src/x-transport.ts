// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

/**
 * X (Twitter)'s DirectTransport — built to the shape bluesky-transport.ts
 * established, since X is the platform with a real reply-chain model closest
 * to Bluesky's own (unlike Pinterest's single-call publish or LinkedIn's
 * no-threads publish). Everything platform-specific to how X models a
 * post/reply/delete/lookup lives here; everything about *talking* to X lives
 * in x.ts.
 *
 * Engine rules apply: relative imports only.
 */

import {
  XError,
  createTweet as xCreateTweet,
  deleteTweet as xDeleteTweet,
  getFollowerCount,
  getMe,
  getMyMetrics,
  getTweetMetrics,
  getTweetsBatch,
  isXNotFound,
  setMediaAltText,
  uploadGif as xUploadGif,
  uploadImage as xUploadImage,
  uploadVideo as xUploadVideo,
  type XVideoMimeType,
  type XImageMimeType,
} from "./x.js";
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

const MB = 1024 * 1024;

/**
 * The fetch budget for a video or GIF's bytes. The shared 20s figure is sized
 * for a compressed image, and X takes video up to 8 GB, so a real clip timed
 * out on the fetch before the chunked upload began. Same figure as YouTube's.
 */
const X_VIDEO_FETCH_TIMEOUT_MS = 120_000;

/** POST /2/tweets `media.media_ids` — vendor cap, verified (maxItems: 4). */
const MAX_IMAGES = 4;

/** GET /2/tweets?ids= — vendor cap, verified ("Up to 100 are allowed in a single request"). */
const BATCH_LOOKUP_LIMIT = 100;

/**
 * x.ts's uploadImage only declares these three (verified against the
 * best-practices page's "Images ... JPG, PNG, GIF, WEBP" list, minus GIF —
 * see x.ts's XImageMimeType docblock for why animated GIF is excluded and
 * refused instead).
 */
const CONTENT_TYPE_BY_MIME: Record<string, XImageMimeType> = {
  "image/jpeg": "image/jpeg",
  "image/png": "image/png",
  "image/webp": "image/webp",
};

function channelRules(): TransportChannelRules {
  return {
    // 280, weighted (twitter-text rules) — VERIFIED against
    // https://docs.x.com/fundamentals/counting-characters:
    // most characters weight 1, emojis/CJK/"other Unicode" weight 2, and every
    // URL is rewritten to a flat 23-char t.co link regardless of its real
    // length. length.ts's xWeightedLength() implements this rule (not an
    // aggregator's max(weighted, raw), which is not X's rule).
    // NOT independently verified: the 25,000-char Premium ceiling specs.ts's
    // comment carries. The free-tier 280 is what docs.x.com's own
    // counting-characters page states outright; Premium's higher cap comes
    // from specs.ts's comment, not a page re-checked here.
    maxLength: 280,
    countMode: "weighted",
    // media.media_ids maxItems — VERIFIED, create-post page.
    maxImages: MAX_IMAGES,
    // Images ≤5MB — VERIFIED, media best-practices page.
    maxImageBytes: 5 * MB,
    // ⚠️ NOT the 512 MB / 140 s on the media best-practices page, which
    // describes DIRECT-MESSAGE video. docs.x.com/changelog's Sep 1 2026 entry
    // gives the POST limits: default accounts
    // 20 minutes / 8 GB, Premium 125 minutes / 16 GB; DMs keep 140 s / 512 MB.
    // Declared here as the PLATFORM's real limit for QA to check against; this
    // transport uploads video through x.ts's chunked tweet_video path
    // (uploadMediaAssets), so SPECS.twitter.publishesVideo is true and these
    // are the numbers a video leg is actually held to.
    maxVideoBytes: 8 * 1024 * MB,
    maxVideoSec: 1200,
  };
}

async function connectStatus(): Promise<DirectConnectStatus> {
  try {
    const profile = await getMe();
    return { connected: true, accountId: profile.id, displayName: profile.username };
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

/**
 * `https://x.com/i/web/status/{id}` — NOT a field the API returns (no
 * permalink property appears anywhere in the create-post response schema),
 * and NOT confirmed against an official docs.x.com page the way the endpoint
 * shapes above are. This is the long-standing public "any viewer, no username
 * required" X/Twitter status-link convention; same honesty caveat
 * pinterest-transport.ts's postUrl and bluesky-transport.ts's postUrl apply to
 * their own constructed permalinks.
 */
function postUrl(id: string): string {
  return `https://x.com/i/web/status/${id}`;
}

/**
 * VERIFIED against https://docs.x.com/x-api/media/quickstart/best-practices:
 * MP4 and MOV for video.
 */
const VIDEO_MIME: Record<string, XVideoMimeType> = {
  "video/mp4": "video/mp4",
  "video/quicktime": "video/quicktime",
};

/**
 * ⚠️ X ALLOWS EXACTLY ONE VIDEO OR GIF PER POST, and never alongside images.
 * The vendor rule is not "4 media of any kind": it is up to 4 images, OR one
 * video, OR one GIF. Sending a video plus images is rejected at post time,
 * after every byte has already been uploaded — so it is refused here, before
 * a 512MB upload is spent discovering it.
 *
 * A single video or GIF is NOT refused: both go through x.ts's async chunked
 * upload (tweet_video / tweet_gif, with STATUS polling) in uploadMediaAssets.
 * Only the shapes X itself rejects are refused, BEFORE any network call, and
 * as a PublishPreflightError (not a plain Error): publish.ts's per-leg loop
 * isolates one platform's failure, so refusing loudly here keeps the rest of
 * a multi-platform publish going rather than dropping media and posting
 * text-only.
 */
function assertNoUnsupportedMedia(media: MediaAsset[]): void {
  const videos = media.filter((m) => m.type === "video");
  const gifs = media.filter((m) => m.type === "gif");
  const images = media.filter((m) => m.type === "image");

  if (videos.length + gifs.length > 1) {
    throw new PublishPreflightError(
      "X accepts at most ONE video or animated GIF per post, and this draft's X render has " +
        `${videos.length + gifs.length}. Remove the extras, or drop X from the targets, so the other ` +
        "platforms in this publish can still go out.",
    );
  }
  if ((videos.length || gifs.length) && images.length) {
    throw new PublishPreflightError(
      "X cannot mix a video or animated GIF with still images in one post. Remove one or the other from " +
        "this draft's X render, or drop X from the targets, so the other platforms in this publish can still go out.",
    );
  }
  const badVideo = videos.find((v) => !VIDEO_MIME[v.mimeType]);
  if (badVideo) {
    throw new PublishPreflightError(
      `X video must be MP4 or MOV; this draft's X render carries "${badVideo.mimeType}". Re-encode it, or ` +
        "drop X from the targets, so the other platforms in this publish can still go out.",
    );
  }
}

/**
 * Resolve the render's selected media into uploaded X media ids.
 *
 * Images are capped at MAX_IMAGES; a video or GIF is a single id and, per
 * assertNoUnsupportedMedia, cannot appear alongside images. Video and GIF go
 * through the chunked upload path with STATUS polling. Without that path,
 * channelRules advertising X's real video limits would have the QA gate
 * checking a ceiling the upload path could not reach.
 */
async function uploadMediaAssets(media: MediaAsset[]): Promise<string[]> {
  const video = media.find((m) => m.type === "video");
  if (video) {
    const bytes = await fetchMediaBytes("x", requireMediaUrl("x", video), { timeoutMs: X_VIDEO_FETCH_TIMEOUT_MS });
    const id = await xUploadVideo(bytes, VIDEO_MIME[video.mimeType]);
    await attachAltText(id, video.altText);
    return [id];
  }

  const gif = media.find((m) => m.type === "gif");
  if (gif) {
    const bytes = await fetchMediaBytes("x", requireMediaUrl("x", gif), { timeoutMs: X_VIDEO_FETCH_TIMEOUT_MS });
    const id = await xUploadGif(bytes, "image/gif");
    await attachAltText(id, gif.altText);
    return [id];
  }

  return uploadImages(media);
}

/**
 * Non-fatal by contract: the bytes are already uploaded and the post is about
 * to go out, so losing the whole post over a missing description would harm
 * the reader this call exists to serve.
 */
async function attachAltText(mediaId: string, altText: string | undefined): Promise<void> {
  if (!altText) return;
  try {
    await setMediaAltText(mediaId, altText);
  } catch (err) {
    console.warn(
      `[x] alt text could not be attached to media ${mediaId}: ${getErrorMessage(err)}`,
    );
  }
}

/** Resolve the render's selected media into uploaded X media ids, capped at MAX_IMAGES. */
async function uploadImages(media: MediaAsset[]): Promise<string[]> {
  const candidates = media.filter((m) => m.type === "image").slice(0, MAX_IMAGES);
  const out: string[] = [];
  for (const asset of candidates) {
    const url = requireMediaUrl("x", asset);
    const contentType = CONTENT_TYPE_BY_MIME[asset.mimeType];
    if (!contentType) {
      throw new Error(
        `x: unsupported image mime type "${asset.mimeType}" (x.ts's uploadImage only accepts image/jpeg, image/png or image/webp)`,
      );
    }
    const bytes = await fetchMediaBytes("x", url);
    const mediaId = await xUploadImage(bytes, contentType);
    // X has no alt-text parameter on the upload itself — it is a separate
    // POST /2/media/metadata call; without it this platform would send no alt
    // text at all even though the engine carries altText on every asset.
    await attachAltText(mediaId, asset.altText);
    out.push(mediaId);
  }
  return out;
}

/**
 * Post the root, then either chain the whole thread inline or defer it.
 *
 * Same two-branch split as bluesky-transport.ts's publishNow, for the same
 * reason: an inline chain can reference each reply's own immediately-prior
 * tweet because it just posted it, but a deferred reply is persisted before
 * its predecessor (if any) exists. There is no synchronous way to know a
 * not-yet-posted tweet's id, so every deferred reply targets the ROOT
 * directly rather than pretending to chain — the same flat relationship
 * bluesky-transport.ts's own deferred branch settles for, and the aggregator's
 * `value[1..]` model always had for a delayed follow-up.
 *
 * Unlike Bluesky, X has no separate root/parent pair on the wire — a reply
 * only ever needs ONE id, `reply.in_reply_to_tweet_id`, naming its immediate
 * parent. So the inline branch below walks `parentId` forward tweet-by-tweet
 * (each reply's parent is the tweet just posted), while the deferred branch
 * parents every queued item on the root id directly (flat, as above). Both
 * are expressed with the same single `{ id: string }` handle shape rather
 * than Bluesky's uri/cid StrongRef pair, because that is all X's wire format
 * needs.
 */
async function publishNow(input: DirectPublishInput): Promise<DirectPublishResult> {
  const { render, media } = input;
  assertNoUnsupportedMedia(media);

  const mediaIds = await uploadMediaAssets(media);
  const root = await xCreateTweet({ text: render.content, mediaIds: mediaIds.length ? mediaIds : undefined });

  const items = threadReplies(render);
  if (!items.length) {
    return { ref: root.id, url: postUrl(root.id) };
  }

  const delayMinutes = render.followupDelayMinutes ?? 0;
  if (delayMinutes <= 0) {
    // ⛔ NOTHING THROWS OUT OF HERE ONCE THE ROOT IS LIVE, for the reason
    // bluesky-transport.ts gives: a throw re-sends the whole publishNow, root
    // included. A failed reply ends the chain and comes back as a warning.
    let parentId = root.id;
    const replyRefs: string[] = [];
    for (const [i, text] of items.entries()) {
      try {
        const reply = await xCreateTweet({ text, inReplyToTweetId: parentId });
        parentId = reply.id;
        replyRefs.push(reply.id);
      } catch (err) {
        const reason = getErrorMessage(err);
        console.warn(`[x] thread reply ${i + 1} failed on published tweet ${root.id}, leaving the tweet live: ${reason}`);
        return {
          ref: root.id,
          url: postUrl(root.id),
          replyRefs,
          warnings: [
            `thread stopped at reply ${i + 1} of ${items.length}; that reply and any after it were not sent, the post and earlier replies are live: ${reason}`,
          ],
        };
      }
    }
    return { ref: root.id, url: postUrl(root.id), replyRefs };
  }

  const rootRecord: Record<string, string> = { id: root.id };
  const now = Date.now();
  const queued: DirectQueuedReply[] = items.map((text, i) => ({
    position: i + 1,
    text,
    dueAt: new Date(now + (i + 1) * delayMinutes * 60_000).toISOString(),
    parent: rootRecord,
  }));

  return { ref: root.id, url: postUrl(root.id), threadRoot: rootRecord, queued };
}

function tweetIdFrom(rec: Record<string, string>, label: string): string {
  if (!rec.id) {
    throw new Error(`x: ${label} is missing id: ${JSON.stringify(rec)}`);
  }
  return rec.id;
}

/**
 * Release one deferred thread reply. Called by publish-due once `dueAt` has
 * passed.
 *
 * `root` is validated but NOT sent on the wire: X's reply object only ever
 * carries the immediate parent (`reply.in_reply_to_tweet_id`), unlike the AT
 * Protocol's every-reply-names-its-root requirement that makes Bluesky's
 * `root` param load-bearing in its own publishReply. It is still required and
 * checked here (same defensive shape as bluesky-transport.ts's
 * `toStrongRef(root, "threadRoot")`) because a malformed persisted
 * `threadRoot` is a real failure mode worth catching with a clear message
 * rather than a wire error deep inside x.ts.
 */
async function publishReply(reply: DirectQueuedReply, root: Record<string, string>): Promise<DirectPublishResult> {
  tweetIdFrom(root, "threadRoot");
  const parentId = tweetIdFrom(reply.parent, "queued reply parent");
  const posted = await xCreateTweet({ text: reply.text, inReplyToTweetId: parentId });
  // selfRef is what lets the releaser hang the NEXT reply off this one instead
  // of every deferred reply pointing at the root forever — see
  // transport.ts's DirectPublishResult.selfRef docblock.
  return { ref: posted.id, url: postUrl(posted.id), selfRef: { id: posted.id } };
}

/**
 * A record whose deletion already happened (an earlier partial failure, a
 * manual removal on x.com) reads as a definitive 404 from the vendor per the
 * documented ResourceNotFoundProblem schema (see x.ts's deleteTweet
 * docblock). Recognising that as SUCCESS rather than an error is the whole
 * point of this migration.
 */
async function deletePost(ref: string): Promise<void> {
  try {
    await xDeleteTweet(ref);
  } catch (err) {
    if (isXNotFound(err)) return; // idempotent: already gone is success
    throw err;
  }
}

/** A vendor error, timeout, or rate limit says nothing about whether a post exists. */
function isXError(err: unknown): err is XError {
  return err instanceof XError;
}

/**
 * Chunked into GET /2/tweets?ids= at its documented 100-id limit (x.ts's
 * getTweetsBatch) — NEVER one GET /2/tweets/{id} per ref. This is the one
 * postFacts in the whole engine where that distinction is a real cost:
 * X bills $0.005 per Post READ (per the pricing page, capped at 2M
 * reads/billing cycle), so a reconcile sweep that looped single-id lookups
 * instead of this batched call would be spending real money to re-derive
 * information one /2/tweets?ids= call already gives for up to 100 refs at
 * once. If a future change ever needs per-ref granularity beyond what the
 * batch response carries, chunk into MORE batched calls — do not fall back to
 * a single-id loop.
 *
 * `errors` entries typed `resource-not-found` (x.ts's getTweetsBatch
 * docblock) are a vendor-CONFIRMED absence, unlike Bluesky's silent omission
 * or LinkedIn's unconfirmed `errors` shape — so `absent: true` is set for
 * those specifically. A ref that is neither in `data` nor flagged
 * `resource-not-found` (a permission problem, an unrecognised error shape) is
 * still QUEUE, but without `absent`, because that case says nothing definite
 * about whether the tweet exists.
 *
 * ⚠️ Still never ERROR, for the same reason as every other transport: `state`
 * is the caller's verdict to make (see pinterest-transport.ts's postFacts
 * docblock for the full reasoning — reconcile-verdict.ts's one-hour grace on
 * "not found" cannot be applied here because this function receives no
 * timestamps).
 */
async function postFacts(refs: string[]): Promise<Map<string, DirectPostFacts>> {
  const out = new Map<string, DirectPostFacts>();
  for (let i = 0; i < refs.length; i += BATCH_LOOKUP_LIMIT) {
    const batch = refs.slice(i, i + BATCH_LOOKUP_LIMIT);
    let result;
    try {
      result = await getTweetsBatch(batch);
    } catch (err) {
      // ⚠️ Never ERROR from a lookup failure — that marks a live post dead.
      const reason = isXError(err) ? err.message : String(err);
      console.warn(`[x] postFacts lookup failed for a batch of ${batch.length}: ${reason}`);
      for (const ref of batch) out.set(ref, { state: "QUEUE", released: false, platform: "twitter" });
      continue;
    }
    const found = new Set(result.data.map((t) => t.id));
    const confirmedGone = new Set(
      result.errors.filter((e) => e.type?.includes("resource-not-found") && e.resource_id).map((e) => e.resource_id as string),
    );
    for (const ref of batch) {
      if (found.has(ref)) {
        out.set(ref, { state: "PUBLISHED", released: true, platform: "twitter" });
      } else if (confirmedGone.has(ref)) {
        console.warn(`[x] tweet ${ref} is confirmed absent (resource-not-found); reporting QUEUE, not ERROR`);
        out.set(ref, { state: "QUEUE", released: false, platform: "twitter", absent: true });
      } else {
        out.set(ref, { state: "QUEUE", released: false, platform: "twitter" });
      }
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Analytics                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 💰 X IS THE ONLY BILLED ANALYTICS PATH IN THIS ENGINE — $0.005 per Post read.
 *
 * These are registered even though X is routed Off, because every transport is
 * registered unconditionally (see registerDirectTransports) and the signals
 * gatherer calls analyticsChannel on every platform that exposes it. That means
 * ONE users/me lookup per daily digest, not per post: analyticsPost is only
 * reached when something asks about a specific post, and nothing on the daily
 * chain does. If that ever changes, this becomes a per-post charge on every
 * reconcile pass and the cost stops being negligible.
 *
 * When the balance is empty X answers 402 and that surfaces as an XError, which
 * gatherChannelAnalytics renders as "(unavailable: ...)" rather than as zero
 * engagement — the distinction that matters here.
 */
async function analyticsPost(ref: string): Promise<Record<string, number>> {
  return getTweetMetrics(ref);
}

async function analyticsChannel(): Promise<Record<string, number>> {
  return getMyMetrics();
}

async function followerStats(): Promise<{ followers: number }> {
  return getFollowerCount();
}

export const xTransport: DirectTransport = {
  platform: "twitter",
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
