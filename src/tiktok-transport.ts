/**
 * TikTok's DirectTransport, on the operator's approved TikTok API for Business app.
 *
 * Same split as youtube-transport.ts: what a publish, a lookup or a metric
 * MEANS lives here; everything about talking to business-api.tiktok.com lives
 * in tiktok.ts.
 *
 * ⛔ A PUBLISH IS A TASK, NOT A POST. `/business/video/publish/` answers a
 * `share_id` and TikTok downloads, checks and publishes the video afterwards,
 * which can take up to an hour (the publish status doc's Failure reasons, `video_pull_failed`:
 * "cannot be completed within the one hour timeout"). So once that call has
 * succeeded this file NEVER throws on uncertainty: a status read that fails, or
 * a task still processing when the poll budget runs out, returns the leg as
 * live on its `share_id` and leaves the verdict to postFacts and the reconcile.
 * Throwing there would mark a leg failed whose video may still go live, and the
 * operator's retry would post it twice. The one post-create throw is TikTok's
 * own definitive `FAILED`, which means nothing was published.
 *
 * ⛔ PUBLIC ONLY, LIKE THE ZERNIO ROUTE. The endpoint is "Publish a public video
 * post" and takes no privacy level, so a TikTok leg is live to everyone the
 * moment it completes. There is no private-first option as YouTube has.
 *
 * ⚠️ NO DELETE. The Accounts API has endpoints to delete comments and URL
 * properties, and none to delete a video post, so deletePost refuses with the
 * one instruction that works: delete it in the TikTok app.
 *
 * Engine rules apply: relative imports only, no `@/`, no prisma, no next.
 */

import { getErrorMessage } from "./error-message.js";
import { isAiGeneratedAsset } from "./instagram-transport.js";
import { PublishPreflightError } from "./publish.js";
import {
  getPostMetrics,
  getProfile,
  publishStatus,
  publishVideo,
  tiktokCredentials,
  TIKTOK_POST_METRIC_FIELDS,
  type TikTokPublishState,
  type TikTokPublishStatus,
} from "./tiktok.js";
import type {
  DirectConnectStatus,
  DirectPostFacts,
  DirectPublishInput,
  DirectPublishResult,
  DirectTransport,
  TransportChannelRules,
} from "./transport.js";

/** The scope `/business/video/publish/` needs. Checked before sending, not discovered from a refusal. */
export const TIKTOK_PUBLISH_SCOPE = "video.publish";

/**
 * How long publishNow watches a task before handing it to the reconcile.
 *
 * Same ceiling as instagram-transport.ts's REELS_POLL and for the same reason:
 * publish-due holds a leg as `publishing` for ten minutes (CLAIM_STALE_MS), and
 * a poll outliving that would let the next tick publish the same video again.
 * Three minutes also matches TikTok's own "Post IDs require up to three minutes
 * of processing time" (the publish status doc).
 */
export const TIKTOK_PUBLISH_POLL = { intervalMs: 5_000, maxAttempts: 36 } as const;

/**
 * Separator between the task id and the post id in a ref: `<share_id>|<post_id>`.
 *
 * Not `~`, which Zernio uses: TikTok's documented share_id form contains one
 * (`v_pub_url~v1.<digits>`, the video publish doc). A post id is
 * digits, so splitting on the LAST `|` is safe whatever a share_id carries.
 * A ref with no `|` is a task whose post id was not known at publish time.
 */
const REF_SEP = "|";

/** The ref is written once and never upgraded (see zernio-aggregator.ts's composeRef). */
function composeRef(shareId: string, postId: string | undefined): string {
  return postId ? `${shareId}${REF_SEP}${postId}` : shareId;
}

function splitRef(ref: string): { shareId: string; postId: string } {
  const at = ref.lastIndexOf(REF_SEP);
  if (at === -1) return { shareId: ref, postId: "" };
  return { shareId: ref.slice(0, at), postId: ref.slice(at + REF_SEP.length) };
}

let _profileUrl: string | null = null;

/**
 * The account Social HQ publishes to, for a link to a post whose id TikTok had
 * not issued yet. Injected from the app's profile registry (wired beside the
 * credentials resolver) rather than a second literal: the engine holds no brand's handles.
 *
 * Unset, such a link is empty rather than a guess. It never throws: postUrl is
 * synchronous and runs after TikTok has already accepted the post.
 */
export function setTikTokProfileUrl(url: string | null): void {
  _profileUrl = url;
}

/**
 * Limits from the publish reference (the video publish doc):
 *
 *   - caption "Length limit: 2,200 characters (UTF-16 encoding)";
 *   - "The maximum video size is 1 GB", declared as 10^9 bytes, the smaller of
 *     the two readings: a false refusal is visible and fixable, a false pass
 *     fails at TikTok after the task is created;
 *   - "the maximum video duration is 600 seconds". The real cap is per account
 *     (`max_video_post_duration_sec` from /business/video/settings/), which can
 *     be shorter; 600 is the most any account gets.
 *
 * Not expressible here, and enforced only by TikTok: a minimum of 3 seconds,
 * 360 px on each side, 23 to 60 fps, and .mp4/.mov/.webm.
 */
const MAX_VIDEO_BYTES = 1_000_000_000;

function channelRules(): TransportChannelRules {
  return { maxLength: 2_200, countMode: "utf16", maxVideoBytes: MAX_VIDEO_BYTES, maxVideoSec: 600 };
}

/**
 * Reads the profile's default fields, which need only `user.info.basic`. It
 * never throws: publish.ts treats a rejected status as the whole platform
 * unreachable.
 */
async function connectStatus(): Promise<DirectConnectStatus> {
  try {
    const profile = await getProfile();
    // `display_name` is a default field, returned whenever no fields are named.
    return { connected: true, accountId: profile.businessId, displayName: profile.displayName as string };
  } catch (err) {
    return { connected: false, accountId: "", displayName: "", reason: getErrorMessage(err) };
  }
}

/**
 * The embeddable player link once the post id is known: the `embed_url` shape
 * the video list returns (the video list doc, "https://www.tiktok.com/player/v1/<id>").
 * Built rather than fetched because postUrl is synchronous; the account's
 * profile otherwise.
 */
function postUrl(ref: string): string {
  const { postId } = splitRef(ref);
  return postId ? `https://www.tiktok.com/player/v1/${postId}` : (_profileUrl ?? "");
}

/** TikTok's definitive verdict on a task: it was refused and nothing went live. */
export class TikTokPublishFailedError extends Error {
  constructor(shareId: string, reason: string | undefined) {
    // `reason` is "Returned only when status is FAILED", so it is always set here.
    super(
      `TikTok refused the video after accepting it (task ${shareId}, reason ${String(reason)}); ` +
        "nothing was published. The reasons are listed under Failure reasons in TikTok's publish " +
        "status docs (business-api.tiktok.com/portal/docs)",
    );
    this.name = "TikTokPublishFailedError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Watch a task until TikTok issues the post id, refuses it, or the budget ends.
 * Returns the post id, or undefined when it is not known yet.
 */
async function awaitPostId(shareId: string): Promise<string | undefined> {
  for (let attempt = 1; attempt <= TIKTOK_PUBLISH_POLL.maxAttempts; attempt += 1) {
    await sleep(TIKTOK_PUBLISH_POLL.intervalMs);
    let state: TikTokPublishState;
    try {
      state = await publishStatus(shareId);
    } catch (err) {
      // The video may be live; this read failing says nothing about it.
      console.warn(`[tiktok] status read for task ${shareId} failed; the reconcile will settle it: ${getErrorMessage(err)}`);
      return undefined;
    }
    if (state.status === "FAILED") throw new TikTokPublishFailedError(shareId, state.reason);
    if (state.postIds.length) return state.postIds[0];
  }
  console.warn(`[tiktok] task ${shareId} had no post id after the publish poll; the reconcile will settle it`);
  return undefined;
}

async function publishNow(input: DirectPublishInput): Promise<DirectPublishResult> {
  const { render, media } = input;

  // QA keeps images off a TikTok render (SPECS.tiktok: requiresVideo, no mixed
  // media), so the render's one video is the post.
  const video = media.find((m) => m.type === "video");
  if (!video) {
    throw new PublishPreflightError(
      "TikTok needs a video: a TikTok post is one video with a caption. Attach a video to this draft's " +
        "TikTok render, or drop TikTok from the targets so the other platforms can still go out.",
    );
  }
  if (!video.url) {
    throw new PublishPreflightError(
      "tiktok: the attached video has no public URL, and TikTok publishes only by downloading one.",
    );
  }

  // ⛔ Refused here rather than by TikTok: a grant without the publish scope
  // answers "No permission" (code 40001), which reads like an app problem.
  // The scopes are the ones TikTok echoed when the grant was made.
  const { scopes } = await tiktokCredentials();
  if (!scopes.includes(TIKTOK_PUBLISH_SCOPE)) {
    throw new PublishPreflightError(
      `the connected TikTok grant does not include ${TIKTOK_PUBLISH_SCOPE}, so it cannot publish; ` +
        "reconnect TikTok (Social HQ > Settings > TikTok) and allow posting",
    );
  }

  const { shareId } = await publishVideo({
    videoUrl: video.url,
    caption: render.content,
    // Absent means true: every post promotes the operator's own brand (types.ts).
    brandOrganic: render.tiktokBrandOrganic !== false,
    disableComment: render.tiktokDisableComment === true,
    disableDuet: render.tiktokDisableDuet === true,
    disableStitch: render.tiktokDisableStitch === true,
    // The disclosure Instagram's is_ai_generated reads: a Veo clip carries it.
    aiGenerated: media.some(isAiGeneratedAsset),
  });

  const ref = composeRef(shareId, await awaitPostId(shareId));
  return { ref, url: postUrl(ref) };
}

/**
 * ⚠️ Always throws. There is no video delete in the Accounts API, and saying
 * "deleted" for a post that is still live would drop the only record of it.
 */
async function deletePost(ref: string): Promise<void> {
  throw new Error(
    `tiktok: TikTok's API cannot delete a video post (task ${splitRef(ref).shareId}); ` +
      "delete it in the TikTok app, where it stays live until then",
  );
}

function factsFor(status: TikTokPublishStatus): DirectPostFacts {
  if (status === "PUBLISH_COMPLETE") return { state: "PUBLISHED", released: true, platform: "tiktok" };
  // TikTok's definitive verdict: the task was refused and nothing is live.
  if (status === "FAILED") return { state: "ERROR", released: false, platform: "tiktok" };
  return { state: "QUEUE", released: false, platform: "tiktok" };
}

/**
 * One status read per ref: the status endpoint takes one `publish_id` and
 * there is no batch form.
 *
 * ⚠️ NEVER sets `absent`. The status endpoint reports the TASK, and no doc
 * says what it answers for a post deleted in the app afterwards, so a deletion
 * cannot be told from a lookup gap. A failed read is QUEUE, never ERROR.
 */
async function postFacts(refs: string[]): Promise<Map<string, DirectPostFacts>> {
  const out = new Map<string, DirectPostFacts>();
  for (const ref of refs) {
    try {
      out.set(ref, factsFor((await publishStatus(splitRef(ref).shareId)).status));
    } catch (err) {
      console.warn(`[tiktok] postFacts lookup failed for ${ref}: ${getErrorMessage(err)}`);
      out.set(ref, { state: "QUEUE", released: false, platform: "tiktok" });
    }
  }
  return out;
}

/**
 * Lifetime counters for one post, keyed by TikTok's own field names (the same
 * per-platform rule youtube-transport.ts's analytics block states).
 *
 * The post id comes from the ref, or from the task when it was not known at
 * publish time. Empty while TikTok lists no post for it: not public yet, or
 * filtered out.
 */
async function analyticsPost(ref: string): Promise<Record<string, number>> {
  const { shareId, postId } = splitRef(ref);
  const id = postId || (await publishStatus(shareId)).postIds[0];
  if (!id) return {};
  const video = await getPostMetrics(id);
  const out: Record<string, number> = {};
  for (const field of TIKTOK_POST_METRIC_FIELDS) {
    const value = video?.[field];
    if (typeof value === "number") out[field] = value;
  }
  return out;
}

/** `followers_count` needs `user.info.stats`; a grant without it gets no number, and says why. */
async function followerStats(): Promise<{ followers: number }> {
  const { followersCount } = await getProfile(["followers_count"]);
  if (followersCount === undefined) {
    throw new Error("tiktok: TikTok returned no followers_count (the grant may lack user.info.stats)");
  }
  return { followers: followersCount };
}

export const tiktokTransport: DirectTransport = {
  platform: "tiktok",
  channelRules,
  connectStatus,
  publishNow,
  deletePost,
  postFacts,
  postUrl,
  analyticsPost,
  followerStats,
};
