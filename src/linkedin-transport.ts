// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

/**
 * LinkedIn's DirectTransport — the second direct-vendor transport this engine
 * has, built to the shape bluesky-transport.ts established (see that file's
 * header). Everything platform-specific to how LinkedIn models a post lives
 * here; everything about *talking* to LinkedIn lives in linkedin.ts.
 *
 * Engine rules apply: relative imports only.
 */

import {
  LinkedInError,
  assertLinkedInToken,
  createPost as linkedinCreatePost,
  deletePost as linkedinDeletePost,
  getFollowerCount,
  getOrganizationUrn,
  getFollowerGains,
  getPost,
  getPostShareStatistics,
  getPostsBatch,
  getShareStatistics,
  getShareStatisticsWindow,
  getSocialActions,
  initializeImageUpload,
  linkedInPostStatsFilter,
  linkedInStatsWindow,
  uploadImageBytes,
} from "./linkedin.js";
import { PublishPreflightError } from "./publish.js";
import type {
  DirectConnectStatus,
  DirectPostFacts,
  DirectPublishInput,
  DirectPublishResult,
  DirectTransport,
  TransportChannelRules,
} from "./transport.js";
import type { MediaAsset } from "./types.js";
import { getErrorMessage } from "./error-message.js";
import { fetchMediaBytes, requireMediaUrl } from "./media-fetch.js";

/**
 * This client only implements the single-image `content.media` shape from the
 * Posts API. LinkedIn's native multi-image formats (organic MultiImage,
 * sponsored Carousel) are separate APIs this migration never built, so
 * capping at 1 here is what the client actually does, not a vendor limit —
 * see channelRules().
 */
const MAX_IMAGES = 1;

/**
 * Not documented for `/rest/posts` BATCH_GET the way Bluesky's 25-URI cap is
 * documented for app.bsky.feed.getPosts. Chunked defensively to keep the
 * query string and the vendor's per-call load bounded; unverified whether
 * LinkedIn enforces a smaller (or larger) real limit.
 */
const BATCH_GET_LIMIT = 50;

function channelRules(): TransportChannelRules {
  // 3,000 UTF-16 code units on `commentary` (FIELD_LENGTH_TOO_LONG beyond
  // that — see the Posts API's error table). This static value exists because
  // the aggregator's live GET /integration-settings/:id is gone once a
  // platform is cut over; a transport that omitted this would silently stop
  // being checked at all.
  return { maxLength: 3000, countMode: "utf16", maxImages: MAX_IMAGES };
}

async function connectStatus(): Promise<DirectConnectStatus> {
  try {
    // ⛔ THE TOKEN FIRST. The org URN alone answers from a per-process cache or
    // the pinned LINKEDIN_ORG_ID without touching the credential, so a stored
    // grant the store refuses (minted by a different LinkedIn app, or revoked)
    // would read "connected" while every publish failed. Resolving it makes
    // Settings say reconnect.
    await assertLinkedInToken();
    const org = await getOrganizationUrn();
    // LinkedIn's org URN doubles as both fields here: there is no cheap,
    // verified call in scope for this migration that resolves the page's
    // human-readable name (Organization Lookup is a separate, unverified
    // endpoint), and a raw urn:li:organization:<id> is at least a stable,
    // truthful identifier rather than an invented display name.
    return { connected: true, accountId: org, displayName: org };
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
 * LinkedIn's own docs give the public permalink structure only for a
 * PUBLISHED ugcPost ("an authorized member can view the post using the
 * follow URL structure: https://www.linkedin.com/feed/update/urn:li:ugcPost:<id>/"),
 * but the same `/feed/update/{urn}/` shape is the one every LinkedIn share
 * link (`urn:li:share:...`) uses in practice too, so it is applied to both
 * URN kinds this client can receive back from createPost.
 */
function postUrl(ref: string): string {
  return `https://www.linkedin.com/feed/update/${ref}/`;
}

async function uploadImage(asset: MediaAsset): Promise<{ id: string; altText?: string }> {
  const bytes = await fetchMediaBytes("linkedin", requireMediaUrl("linkedin", asset));
  const { uploadUrl, image } = await initializeImageUpload();
  await uploadImageBytes(uploadUrl, bytes, asset.mimeType);
  return { id: image, altText: asset.altText };
}

/**
 * LinkedIn video is out of scope for this migration (see the module header of
 * publish.ts's PublishPreflightError and the P2b task notes): the Videos API
 * was never built. A leg that carries video must be refused with a clear,
 * NAMED reason before any network call happens, as a PublishPreflightError —
 * publish.ts's per-leg loop around transport.publishNow() already isolates
 * one platform's failure from the others (a thrown error there becomes a
 * `pending` entry plus a message, and the loop moves on), so refusing loudly
 * here is what keeps the rest of a multi-platform publish going rather than
 * silently dropping the video and posting text-only.
 */
function assertNoVideo(media: MediaAsset[]): void {
  if (media.some((m) => m.type === "video")) {
    throw new PublishPreflightError(
      "LinkedIn video is not supported by the direct LinkedIn integration (the Videos API leg was never built in " +
        "this migration). Remove video from this draft's LinkedIn render, or drop LinkedIn from the targets, so " +
        "the other platforms in this publish can still go out.",
    );
  }
}

/**
 * Post the render's content, with at most one image attached.
 *
 * render.firstComment and render.threadItems are deliberately NOT sent
 * anywhere: SPECS.linkedin declares supportsThreads: false, and posting
 * firstComment as a real LinkedIn comment would need the Social Actions
 * (comments) API, which is outside this migration's verified scope (see the
 * module header). Nothing is silently dropped without a trace — this comment
 * IS the trace — but a caller relying on a LinkedIn first-comment landing
 * should not expect it to from this transport yet.
 */
async function publishNow(input: DirectPublishInput): Promise<DirectPublishResult> {
  const { render, media } = input;
  assertNoVideo(media);

  const images = media.filter((m) => m.type === "image" || m.type === "gif");
  /**
   * ⛔ REFUSE, DO NOT TRUNCATE. This was `.slice(0, MAX_IMAGES)`, which
   * published the first image and silently discarded the rest — a post going
   * out on the company page missing content the operator deliberately attached,
   * with nothing anywhere reporting it. Silent content loss on a brand account
   * is worse than a failed leg, because a failed leg can be fixed and a
   * truncated post is not noticed.
   *
   * Matches assertSinglePhotoOnly in facebook-transport.ts, which had the same
   * one-image client limit and already refused loudly. publish.ts isolates a
   * thrown leg (it becomes `pending` plus a message and the loop moves on), so
   * refusing here still lets the other platforms in the publish go out.
   *
   * ⚠️ MAX_IMAGES is a CLIENT limit, not LinkedIn's — LinkedIn itself takes up
   * to 20 via the MultiImage API, which this migration never built. Building it
   * is what raises this, not relaxing the check.
   */
  if (images.length > MAX_IMAGES) {
    throw new PublishPreflightError(
      `linkedin: this render carries ${images.length} images, but the direct LinkedIn transport publishes a single ` +
        "image per post. LinkedIn's native multi-image formats (organic MultiImage, sponsored Carousel) are separate " +
        "APIs this migration never built (see MAX_IMAGES's docblock in linkedin-transport.ts). Attach a single " +
        "image, or drop LinkedIn from the targets, so the rest of this publish can still go out.",
    );
  }
  const mediaRef = images[0] ? await uploadImage(images[0]) : undefined;

  const { ref } = await linkedinCreatePost({ commentary: render.content, media: mediaRef });
  return { ref, url: postUrl(ref) };
}

/** A vendor error, timeout, or rate limit says nothing about whether a post exists. */
function isLinkedInError(err: unknown): err is LinkedInError {
  return err instanceof LinkedInError;
}

/**
 * One post at a time, for when BATCH_GET is refused. 200 is PUBLISHED, LinkedIn's
 * 404 is `absent` (the same positive "it is gone" the batch's 404 is), and
 * anything else stays QUEUE for the reason postFacts gives below.
 */
async function postFactsOneByOne(batch: string[], out: Map<string, DirectPostFacts>): Promise<void> {
  for (const ref of batch) {
    try {
      await getPost(ref);
      out.set(ref, { state: "PUBLISHED", released: true, platform: "linkedin" });
    } catch (err) {
      if (isNotFoundError(err)) {
        out.set(ref, { state: "QUEUE", released: false, absent: true, platform: "linkedin" });
      } else {
        const reason = isLinkedInError(err) ? err.message : String(err);
        console.warn(`[linkedin] postFacts single lookup failed for ${ref}: ${reason}`);
        out.set(ref, { state: "QUEUE", released: false, platform: "linkedin" });
      }
    }
  }
}

async function postFacts(refs: string[]): Promise<Map<string, DirectPostFacts>> {
  const out = new Map<string, DirectPostFacts>();
  for (let i = 0; i < refs.length; i += BATCH_GET_LIMIT) {
    const batch = refs.slice(i, i + BATCH_GET_LIMIT);
    let result;
    try {
      result = await getPostsBatch(batch);
    } catch (err) {
      // ⛔ THE COMMUNITY MANAGEMENT API'S DEVELOPMENT TIER ALLOWS NO BATCH_GET
      // (learn.microsoft.com/en-us/linkedin/marketing/increasing-access,
      // li-lms-2026-10: "All APIs with BATCH_GET: No API calls allowed"). On an
      // app at that tier, without this, no LinkedIn leg could ever be confirmed
      // until Standard tier. A 403 on the
      // batch falls back to one GET per post; the batch stays the first choice
      // because its missing-id shape is the live-proven one. ⚠️ That the tier
      // refusal is a 403 is an assumption from the Posts API's error table
      // (ACCESS_DENIED), not yet observed.
      if (isLinkedInError(err) && err.status === 403) {
        await postFactsOneByOne(batch, out);
        continue;
      }
      // ⚠️ Never ERROR from a lookup failure: that marks a live post dead.
      // publish-due's overdue sweep is the only thing allowed to give up on a
      // leg; a transport that cannot currently reach the vendor must answer
      // QUEUE so the next reconcile pass gets another chance.
      const reason = isLinkedInError(err) ? err.message : String(err);
      console.warn(`[linkedin] postFacts lookup failed for a batch of ${batch.length}: ${reason}`);
      for (const ref of batch) out.set(ref, { state: "QUEUE", released: false, platform: "linkedin" });
      continue;
    }
    // ✅ The missing-id shape is established by the live proof (publishing a
    // real post, deleting it and reading it back both times; see
    // getPostsBatch's docblock), so "deleted" and "lookup failed" are told apart:
    //
    //   present -> results[urn] set,  statuses[urn] = 200
    //   deleted -> results empty,     statuses[urn] = 404, errors[urn].status = 404
    //
    // A 404 is a positive vendor statement that the post is gone, so it maps to
    // `absent` and publish-due's overdue sweep can tell a deleted post from an
    // unreachable API.
    const results = result.results ?? {};
    const statuses = result.statuses ?? {};
    const errors = (result.errors ?? {}) as Record<string, { status?: number } | undefined>;

    for (const ref of batch) {
      if (Object.prototype.hasOwnProperty.call(results, ref)) {
        out.set(ref, { state: "PUBLISHED", released: true, platform: "linkedin" });
        continue;
      }

      if (statuses[ref] === 404 || errors[ref]?.status === 404) {
        // ⛔ `state` STAYS QUEUE — see DirectPostFacts.absent. `absent` tells
        // the caller which KIND of QUEUE this is; it must never change what
        // `state` says, because the caller owns the grace window and the
        // decision to give up. A transport marking a post terminal by itself is
        // exactly the boundary that contract exists to hold.
        out.set(ref, { state: "QUEUE", released: false, absent: true, platform: "linkedin" });
        continue;
      }

      // Anything else — absent from results with NO 404 to explain it — stays
      // QUEUE, never ERROR. An unrecognised response shape says nothing about
      // whether the post exists, and marking a live post dead is the one
      // outcome worth avoiding at the cost of a retry. Same rule as
      // bluesky-transport.ts's postFacts.
      out.set(ref, { state: "QUEUE", released: false, platform: "linkedin" });
    }
  }
  return out;
}

/** LinkedIn's own docs say a re-delete already answers 204; this is the defensive fallback. */
function isNotFoundError(err: unknown): boolean {
  return isLinkedInError(err) && err.status === 404;
}

async function deletePost(ref: string): Promise<void> {
  try {
    await linkedinDeletePost(ref);
  } catch (err) {
    if (isNotFoundError(err)) return; // idempotent: already gone is success
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/*  Analytics                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Per-post figures from two LinkedIn endpoints, under LinkedIn's own names.
 *
 * Share statistics filtered to the post (getPostShareStatistics) carry the
 * organic lifetime impressionCount, uniqueImpressionsCount, clickCount,
 * engagement (a ratio), likeCount, commentCount and shareCount. socialActions
 * adds totalLikes and aggregatedTotalComments, which LinkedIn documents as the
 * up-to-date counts that match the feed.
 *
 * Both are kept, and that is not double counting: the two never share a key,
 * nothing downstream sums keys, and they answer different questions (organic
 * only, where likeCount can even go negative after a sponsored unlike, versus
 * every like shown on the post). Dropping either would discard a definition the
 * vendor reports separately.
 *
 * Settled independently, like the analytics route settles analyticsChannel and
 * followerStats: one endpoint failing keeps the other's numbers. Only when a
 * call failed AND nothing came back does this throw, so "could not be asked"
 * never reads as "no figures".
 */
async function analyticsPost(ref: string): Promise<Record<string, number>> {
  if (!linkedInPostStatsFilter(ref)) {
    throw new LinkedInError(
      0,
      `not a LinkedIn share or ugcPost URN: ${JSON.stringify(ref)}`,
      "GET",
      "(analyticsPost)",
    );
  }
  const settled = await Promise.allSettled([getPostShareStatistics(ref), getSocialActions(ref)]);
  const out: Record<string, number> = {};
  const failures: unknown[] = [];
  for (const result of settled) {
    if (result.status === "fulfilled") Object.assign(out, result.value);
    else failures.push(result.reason);
  }
  if (!failures.length) return out;
  if (!Object.keys(out).length) {
    if (failures.length === 1) throw failures[0];
    // Both failed: one error naming both, joined the way the analytics route
    // joins a platform's failures.
    throw new LinkedInError(0, failures.map(getErrorMessage).join(" / "), "GET", "(analyticsPost)");
  }
  for (const failure of failures) {
    console.warn(
      `[linkedin] analyticsPost ${ref}: one source failed, returning the other's figures: ${getErrorMessage(failure)}`,
    );
  }
  return out;
}

/** The trailing window the channel block adds to the lifetime totals, in days. */
export const LINKEDIN_CHANNEL_WINDOW_DAYS = 7;

/**
 * The Page's lifetime share statistics, plus the last week's follower gains and
 * share counters (Community Management API, time-bound).
 *
 * The week's keys carry a `_7d` suffix on LinkedIn's own names
 * (`organicFollowerGain_7d`, `impressionCount_7d`), because the block mixes two
 * spans and an unsuffixed `impressionCount` would read as both. The window is
 * the newest seven days LinkedIn can report (linkedInStatsWindow), which ends
 * two days before today.
 *
 * Settled independently, like analyticsPost: one source failing keeps the
 * others. Only when every source failed does this throw (the first failure), so
 * "could not be asked" never reads as "no figures".
 */
async function analyticsChannel(): Promise<Record<string, number>> {
  const window = linkedInStatsWindow(new Date(), LINKEDIN_CHANNEL_WINDOW_DAYS);
  const suffix = (bag: Record<string, number>): Record<string, number> =>
    Object.fromEntries(Object.entries(bag).map(([key, value]) => [`${key}_${LINKEDIN_CHANNEL_WINDOW_DAYS}d`, value]));
  const settled = await Promise.allSettled([
    getShareStatistics(),
    getFollowerGains(window).then(suffix),
    getShareStatisticsWindow(window).then(suffix),
  ]);
  const out: Record<string, number> = {};
  const failures: unknown[] = [];
  for (const result of settled) {
    if (result.status === "fulfilled") Object.assign(out, result.value);
    else failures.push(result.reason);
  }
  if (failures.length === settled.length) throw failures[0];
  for (const failure of failures) {
    console.warn(`[linkedin] analyticsChannel: one source failed, returning the others: ${getErrorMessage(failure)}`);
  }
  return out;
}

async function followerStats(): Promise<{ followers: number }> {
  return getFollowerCount();
}

export const linkedinTransport: DirectTransport = {
  platform: "linkedin",
  channelRules,
  connectStatus,
  publishNow,
  deletePost,
  postFacts,
  postUrl,
  analyticsPost,
  analyticsChannel,
  followerStats,
};
