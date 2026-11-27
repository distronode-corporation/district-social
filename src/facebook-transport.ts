// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Facebook Page's DirectTransport — one of the P3 trio (Facebook, Instagram,
 * Threads) sharing meta-graph.ts. Mirrors the split bluesky-transport.ts
 * established: what a post/photo/comment/delete/lookup MEANS on this
 * platform lives here.
 *
 * Unlike Bluesky/LinkedIn/Pinterest, there is deliberately no separate
 * low-level `facebook.ts` client. Those three vendors each needed enough of
 * their own request-shaping, auth and error-decoding logic to earn a whole
 * module; Facebook's surface for this migration is a handful of small Graph
 * calls (feed, photos, video_reels, comments, delete/read-by-id) that are each
 * a single `graphRequest` call, plus the one rupload call a Reel needs, which
 * meta-graph.ts owns. Putting a one-line wrapper module between this
 * file and meta-graph.ts would only be indirection. `graphRequest` /
 * `metaCredentials` / `MetaGraphError` come straight from meta-graph.ts,
 * which is NOT modified or duplicated here (see that file's own header).
 *
 * Engine rules apply: relative imports only.
 */

import {
  getFacebookFollowers,
  getFacebookPageInsights,
  getFacebookPostInsights,
  graphBody,
  graphRequest,
  metaCredentials,
  metaShape,
  MetaGraphError,
  readInsightRows,
  ruploadHostedVideo,
  toMetricBag,
  type MetaCredentials,
} from "./meta-graph.js";
import type { Shape } from "./http/shape.js";
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
import { requireMediaUrl } from "./media-fetch.js";

const MB = 1024 * 1024;

/**
 * This client only implements the single-image `POST /{page-id}/photos`
 * shape. A real Facebook multi-photo post needs one `published=false` photo
 * upload call PER extra image before the feed post that attaches them via
 * `attached_media` — an N-extra-call flow this migration never built (see
 * assertSinglePhotoOnly). Facebook's own per-post cap is 10 images
 * (scripts/social/platform-reference.md); the 1 here is what THIS CLIENT
 * does, not a vendor limit, same distinction linkedin-transport.ts draws for
 * its own MAX_IMAGES.
 */
const MAX_IMAGES = 1;

/** Caps concurrent `GET /{post-id}?fields=id` calls during a reconcile sweep. */
const POST_FACTS_CONCURRENCY = 10;

/**
 * Separator joining a photo post's TWO ids in one ref.
 *
 * ⛔ FACEBOOK SPLITS A PHOTO POST INTO TWO OBJECTS AND THIS TRANSPORT KEEPS
 * BOTH. `POST /{page-id}/photos` returns `{ id, post_id }`: `id` is the PHOTO
 * node (it lives in the Page's photo albums) and `post_id` is the feed story
 * about it. Storing `post_id` alone would make `deletePost` issue exactly one
 * `DELETE /{post_id}` and leave the photo node behind: still hosted, still in
 * the Page's Photos tab, and with no id recorded anywhere it could ever be
 * found again from this side.
 *
 * Deleting the photo node IS a documented, permitted operation. The Photo node
 * reference says
 * "An app can delete any photos it published, or a page-management app can
 * delete a Photo published to a page that the app manages", and the node also
 * carries `page_story_id` pointing back at the story: an explicit vendor
 * statement that these are two linked objects.
 *
 * ⚠️ DO NOT READ THE EDGE DOC AS A REFUSAL. `/{page-id}/photos` says "You can't
 * perform this operation on this endpoint" about the EDGE, not the node. That
 * sentence is why this looks impossible on a first read and is not.
 *
 * ⛔ WHAT IS GENUINELY UNDOCUMENTED IS WHETHER `DELETE /{post-id}` CASCADES to
 * the photo. Meta states nothing either way, which is the same silence the
 * delete docs already carry (see deletePost's docblock: three Meta pages
 * contradict each other on whether a Page post is deletable at all). So this
 * deletes both explicitly, which is correct under EITHER answer: if Meta does
 * cascade, the second call answers "does not exist" and `isMetaNotFound`
 * swallows it as success; if it does not, the orphan is cleaned. Being wrong in
 * this direction costs one redundant request. Being wrong in the other leaves
 * brand-account content live after the product reported it deleted.
 * `facebook.live.proof.test.ts` is what settles it against a real Page.
 *
 * ⛔ A BARE `{page-id}_{post-id}` REF CANNOT BE TURNED BACK INTO A PHOTO ID.
 * A leg stored without the photo id cannot have its photo node deleted from
 * here; that photo stays in the Page's albums until removed by hand.
 *
 * Safe inside the `providerPostId` codec: `parseEntry` splits a direct leg on
 * its FIRST colon and keeps everything after it as the ref untouched, precisely
 * because vendor refs are already colon-heavy (`urn:li:share:...`). The only
 * real constraint is that a ref carries no COMMA, which this does not.
 */
const PHOTO_MARKER = ":photo:";

/**
 * Prefix marking a Page REEL's ref: `reel:{video-id}`.
 *
 * A Reel is a different object from a feed story. `/video_reels` finishes with
 * `{"success": true}` and no post id at all (Reels Publishing API guide), so
 * the only handle that exists is the VIDEO id from the start
 * phase. That id deletes (`DELETE /{video-id}`), comments and reconciles like a
 * post id does, but its permalink is `/reel/{id}` and its insights live on
 * `/video_insights` with their own metric names, so the ref has to say which
 * kind it is. A bare numeric id could not: a hand-entered post id has the same
 * shape (see postUrl's fallback).
 *
 * Safe in the `providerPostId` codec for the reason PHOTO_MARKER's docblock
 * gives: the codec splits on the FIRST colon only (`facebook:reel:123`), and
 * the ref carries no comma.
 */
const REEL_PREFIX = "reel:";

interface FacebookRef {
  /** The feed story, or the Reel's video id. Everything except deletion operates on this. */
  postId: string;
  /** The photo node, when this leg was published through `/photos`. */
  photoId?: string;
  /** True when `postId` is a Reel's video id, published through `/video_reels`. */
  reel?: boolean;
}

function encodeRef(postId: string, photoId?: string): string {
  return photoId ? `${postId}${PHOTO_MARKER}${photoId}` : postId;
}

/**
 * Split a stored ref back into its ids.
 *
 * ⛔ BACKWARD COMPATIBILITY IS THE WHOLE CONTRACT HERE. Every Facebook leg
 * published before this encoding existed is a bare `{page-id}_{post-id}` with
 * no marker, and it must keep deleting exactly as it did — one call, no photo
 * step. Those legs' photo ids were never recorded and are not recoverable, so a
 * parser that guessed at them would delete the wrong object. A ref with no
 * marker therefore means "post only", never "photo unknown".
 */
function parseRef(ref: string): FacebookRef {
  if (ref.startsWith(REEL_PREFIX)) {
    const videoId = ref.slice(REEL_PREFIX.length);
    // Same rule as a half-formed photo marker below: an empty id is not a Reel,
    // and `DELETE /` would resolve to the Page itself.
    return videoId ? { postId: videoId, reel: true } : { postId: ref };
  }
  const at = ref.indexOf(PHOTO_MARKER);
  if (at === -1) return { postId: ref };
  const postId = ref.slice(0, at);
  const photoId = ref.slice(at + PHOTO_MARKER.length);
  // A half-formed marker is not a photo ref. Treat the whole string as a post
  // id rather than inventing an empty id and issuing `DELETE /`, which would
  // resolve to the Page itself.
  if (!postId || !photoId) return { postId: ref };
  return { postId, photoId };
}

/** Reels Publishing API guide, video specifications. */
const REEL_MIN_SEC = 3;
const REEL_MAX_SEC = 90;

function channelRules(): TransportChannelRules {
  return {
    // 63,206 chars and 4GB video, [verified] in
    // scripts/social/platform-reference.md (Facebook has no OpenAPI-style
    // schema the way Pinterest does, so these come from Meta's published
    // help-center/developer prose rather than a machine-checkable contract;
    // same caveat pinterest-transport.ts carries for its byte caps).
    // A transport that omitted this static value would silently stop being
    // checked at all.
    maxLength: 63206,
    countMode: "utf16",
    maxImages: MAX_IMAGES,
    // ⚠️ 10 MB, NOT the help-centre's 30 MB. This transport posts through the
    // Page /photos edge (see publishLeg), whose reference says "Files can not
    // exceed 10MB" (developers.facebook.com/docs/graph-api/reference/page/photos).
    // The 30 MB help-centre figure would let a 20 MB card through QA to fail at
    // Meta.
    maxImageBytes: 10 * MB,
    // Help-centre figure for Page video: the Reels Publishing API guide states
    // no byte ceiling of its own.
    maxVideoBytes: 4096 * MB,
    // "Reels duration must be between 3 and 90 seconds", the same guide's
    // error table (code 1363128). Video on this transport publishes as a Reel
    // and nothing else, so the Reels ceiling is the operative one.
    maxVideoSec: REEL_MAX_SEC,
  };
}

/** Same guide: the container formats it names. Anything else fails processing with no format in the error. */
export const REEL_VIDEO_FORMATS: readonly string[] = ["video/mp4", "video/quicktime"];

/**
 * Poll budget for each of the Reel's two waits (upload complete, then
 * published): 24 checks 5 s apart, two minutes each.
 *
 * ⛔ Sized against the publish claim, not only against Meta's latency. A leg is
 * held `publishing` for the caller's claim-stale window (10 minutes) before
 * publish-due hands it back to `pending`. Worst case here is the rupload call's
 * own 2-minute timeout plus two 2-minute waits, six minutes, inside one claim.
 */
export const REEL_POLL = { intervalMs: 5_000, maxAttempts: 24 } as const;

/**
 * Reel metrics on `/{video-id}/video_insights`, all `lifetime` scalars, VERIFIED
 * against the Video Insights reference's "Reels Metrics" table (v26.0). A Reel
 * has no feed story, so FB_POST_METRICS does not apply to it.
 * Exported and pinned in a test for the reason meta-graph.ts gives: one bad
 * name fails the whole call.
 *
 * ⛔ `post_impressions_unique` is ABSENT although that table still lists it: the
 * Graph v25.0 announcement (2026-02-18) retires `video_insights/
 * post_impressions_unique` in June 2026 for all versions, and it would take the
 * Reel's other counters down with it. Not verified live (no Facebook Reel yet).
 */
export const FB_REEL_METRICS = [
  "blue_reels_play_count",
  "fb_reels_total_plays",
  "fb_reels_replay_count",
  "post_video_view_time",
  "post_video_avg_time_watched",
] as const;

async function connectStatus(): Promise<DirectConnectStatus> {
  try {
    const creds = await metaCredentials();
    const s = metaShape("GET :page-id?fields=id,name");
    const page = graphBody(
      s,
      await graphRequest(creds.pageId, {
        params: { fields: "id,name" },
        accessToken: creds.pageToken,
        appSecret: creds.appSecret,
      }),
    );
    return { connected: true, accountId: s.id(page.id, "id"), displayName: s.str(page.name, "name") };
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
 * `permalink.php?story_fbid=<post>&id=<page>` is Facebook's long-standing,
 * still-functional generic redirect that needs only the two numeric ids a
 * Page post's own id already carries (`{page-id}_{post-id}`) — no page
 * vanity name required. The prettier `facebook.com/{page-name}/posts/{id}`
 * form the docs show in examples needs a name this client never fetches, so
 * this is convention, not a field the vendor returns, same honesty
 * pinterest-transport.ts's postUrl applies to its own permalink construction.
 */
function postUrl(rawRef: string): string {
  const { postId: ref, reel } = parseRef(rawRef);
  // `facebook.com/reel/{video-id}` is the public Reel path, by the same
  // convention-not-vendor-field honesty as the permalink.php form below.
  if (reel) return `https://www.facebook.com/reel/${ref}`;
  const underscore = ref.indexOf("_");
  if (underscore === -1) {
    // Not the `{page-id}_{post-id}` shape this client ever produces itself,
    // but postUrl must still return SOMETHING for a ref that arrived some
    // other way (e.g. hand-entered) rather than throwing from a synchronous
    // getter — fall back to the bare-id redirect Facebook also accepts.
    return `https://www.facebook.com/${ref}`;
  }
  const pageId = ref.slice(0, underscore);
  const storyId = ref.slice(underscore + 1);
  return `https://www.facebook.com/permalink.php?story_fbid=${storyId}&id=${pageId}`;
}

/**
 * The one video this leg publishes as a Page Reel, or null for a photo/text
 * post.
 *
 * Refused BEFORE `metaCredentials()` or any Graph call, as a named
 * `PublishPreflightError`, for the reason assertSinglePhotoOnly gives. ⛔ Video
 * plus anything else is refused rather than trimmed: a Reel carries one video
 * and nothing else, and silently dropping the operator's other media is the
 * content loss every transport in this folder refuses.
 */
function collectReelVideo(media: MediaAsset[]): MediaAsset | null {
  const videos = media.filter((m) => m.type === "video");
  if (!videos.length) return null;
  if (media.length > 1) {
    throw new PublishPreflightError(
      `facebook: a Page Reel carries exactly one video and nothing else, and this render selects ${media.length} ` +
        `media items including ${videos.length} video(s). Select only the video for Facebook, or drop Facebook from ` +
        "the targets, so the other platforms in this publish can still go out.",
    );
  }
  const [video] = videos;
  if (!REEL_VIDEO_FORMATS.includes(video.mimeType)) {
    throw new PublishPreflightError(
      `facebook: Reels accept MP4 or MOV, and ${video.path} is "${video.mimeType}". Attach an MP4, or drop Facebook ` +
        "from this draft's targets.",
    );
  }
  if (!video.url) {
    throw new PublishPreflightError(
      `facebook: video ${video.path} has no public url. A Reel is uploaded by handing Meta a PUBLIC file_url to ` +
        "fetch, so this video cannot be posted until it is hosted.",
    );
  }
  const sec = video.durationSec;
  if (sec !== undefined && (sec < REEL_MIN_SEC || sec > REEL_MAX_SEC)) {
    throw new PublishPreflightError(
      `facebook: Page Reels run ${REEL_MIN_SEC} to ${REEL_MAX_SEC} seconds, and ${video.path} runs ${sec}s.`,
    );
  }
  return video;
}

/**
 * Multi-photo is out of scope for this phase (see MAX_IMAGES's docblock), and
 * refused here, BEFORE `metaCredentials()` or any Graph call, as a named
 * `PublishPreflightError` — publish.ts's per-leg loop around
 * `transport.publishNow()` already isolates one platform's failure from the
 * others (a thrown error there becomes a `pending` entry plus a message, and
 * the loop moves on), so refusing loudly here is what keeps the rest of a
 * multi-platform publish going rather than silently posting one of several
 * attached images. Video never reaches this: collectReelVideo routes it first.
 */
function assertSinglePhotoOnly(media: MediaAsset[]): MediaAsset[] {
  const images = media.filter((m) => m.type === "image" || m.type === "gif");
  // Before the count cap: a URL-less asset is refused by name rather than
  // filtered out, which published the post without it (or let a two-image
  // render pass the single-photo cap with one image silently dropped).
  for (const m of images) requireMediaUrl("facebook", m);
  if (images.length > MAX_IMAGES) {
    throw new PublishPreflightError(
      `facebook: this render carries ${images.length} images, but the direct Facebook transport only publishes a ` +
        "single photo per post. A real multi-photo post needs one extra unpublished-photo upload call PER additional " +
        "image before the feed post that attaches them, which this migration never built (see MAX_IMAGES's docblock " +
        "in facebook-transport.ts). Attach a single image, or drop Facebook from the targets.",
    );
  }
  return images;
}

interface ReelPhase {
  status?: string;
  publish_status?: string;
  error?: { message?: string };
}

/** `GET /{video-id}?fields=status`, per the Reels guide's status examples. */
interface ReelStatus {
  video_status?: string;
  uploading_phase?: ReelPhase;
  processing_phase?: ReelPhase;
  publishing_phase?: ReelPhase;
}

/**
 * The failure a Reel status reports, or undefined when nothing has failed.
 *
 * ⚠️ A phase can carry an `error` while its `status` still reads `not_started`
 * (the guide's own "Resolution too low" example shows exactly that), so the
 * error object is checked first and on its own, not only `status === "error"`.
 */
function reelFailure(s: ReelStatus): string | undefined {
  const phases = [
    ["uploading", s.uploading_phase],
    ["processing", s.processing_phase],
    ["publishing", s.publishing_phase],
  ] as const;
  for (const [name, phase] of phases) {
    if (phase?.error?.message) return `${name}: ${phase.error.message}`;
    if (phase?.status === "error") return `${name} phase reported an error`;
  }
  if (s.video_status === "error" || s.video_status === "expired") return `video_status "${s.video_status}"`;
  return undefined;
}

/**
 * Meta REPORTED the Reel failed, as opposed to a status read failing. Only this
 * one may fail a leg after the finish call; see publishReel.
 */
class ReelFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReelFailedError";
  }
}

function reelUploaded(s: ReelStatus): boolean {
  return s.uploading_phase?.status === "complete";
}

/**
 * ⚠️ The exact "published" shape is read off Meta's Page Stories example (the
 * Reels guide shows only failure bodies): `publishing_phase.status` reaching
 * `complete`, or `publish_status: "published"`. Either counts. UNVERIFIED
 * against a live Reel until the first supervised publish.
 */
function reelPublished(s: ReelStatus): boolean {
  return s.publishing_phase?.status === "complete" || s.publishing_phase?.publish_status === "published";
}

/** One Reel phase, each field an optional string; `error` an optional object. */
function readReelPhase(s: Shape, value: unknown, at: string): ReelPhase | undefined {
  const phase = s.optObj(value, at);
  if (!phase) return undefined;
  const error = s.optObj(phase.error, `${at}.error`);
  return {
    status: s.optStr(phase.status, `${at}.status`),
    publish_status: s.optStr(phase.publish_status, `${at}.publish_status`),
    ...(error ? { error: { message: s.optStr(error.message, `${at}.error.message`) } } : {}),
  };
}

async function readReelStatus(videoId: string, creds: MetaCredentials): Promise<ReelStatus> {
  const s = metaShape("GET :video-id?fields=status");
  const body = graphBody(
    s,
    await graphRequest(videoId, {
      params: { fields: "status" },
      accessToken: creds.pageToken,
      appSecret: creds.appSecret,
    }),
  );
  const status = s.optObj(body.status, "status");
  if (!status) return {};
  return {
    video_status: s.optStr(status.video_status, "status.video_status"),
    uploading_phase: readReelPhase(s, status.uploading_phase, "status.uploading_phase"),
    processing_phase: readReelPhase(s, status.processing_phase, "status.processing_phase"),
    publishing_phase: readReelPhase(s, status.publishing_phase, "status.publishing_phase"),
  };
}

/**
 * Poll a Reel until `isDone`, throwing on any reported failure. Resolves true
 * when done, false when the budget ran out: what a timeout MEANS depends on
 * which side of the finish call it falls, so the caller decides.
 */
async function waitForReel(
  videoId: string,
  creds: MetaCredentials,
  isDone: (s: ReelStatus) => boolean,
  stage: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < REEL_POLL.maxAttempts; attempt++) {
    const status = await readReelStatus(videoId, creds);
    const failure = reelFailure(status);
    if (failure) throw new ReelFailedError(`facebook: Reel ${videoId} failed ${stage} (${failure})`);
    if (isDone(status)) return true;
    if (attempt < REEL_POLL.maxAttempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, REEL_POLL.intervalMs));
    }
  }
  return false;
}

/**
 * Publish a Page Reel: start a session, hand Meta the public file_url, wait
 * for the upload, finish with `video_state=PUBLISHED`, then wait for it to go
 * live. VERIFIED against the Reels Publishing API guide.
 *
 * ⛔ THE FINISH CALL IS THE POINT OF NO RETURN, and the two timeouts are
 * treated differently because of it:
 *
 *   - Before finish, nothing is public. A stalled upload THROWS, and the next
 *     attempt starts a fresh session; the abandoned one is an unpublished video
 *     nobody can see.
 *   - After finish, Meta may publish at any moment. A poll that runs out there
 *     must NOT throw: a thrown leg goes back to `pending` and the next tick
 *     would post the same Reel a second time. It returns the ref with a warning
 *     instead, and the reconcile (postFacts, which reads the same status) is
 *     what confirms it. An explicit failure after finish still throws, because
 *     a Reel that failed processing is not live.
 *
 * The ref is `reel:{video-id}` (see REEL_PREFIX), because finish returns no
 * post id at all.
 */
async function publishReel(
  video: MediaAsset,
  description: string,
  creds: MetaCredentials,
): Promise<{ ref: string; warnings?: string[] }> {
  const startShape = metaShape("POST :page-id/video_reels start");
  const start = graphBody(
    startShape,
    await graphRequest(`${creds.pageId}/video_reels`, {
      method: "POST",
      params: { upload_phase: "start" },
      accessToken: creds.pageToken,
      appSecret: creds.appSecret,
    }),
  );
  const videoId = startShape.optId(start.video_id, "video_id");
  if (!videoId) {
    throw new Error("facebook: the Reels upload session started but returned no video_id, so there is nothing to upload to");
  }

  await ruploadHostedVideo(videoId, video.url!, { accessToken: creds.pageToken, appSecret: creds.appSecret });

  if (!(await waitForReel(videoId, creds, reelUploaded, "uploading"))) {
    throw new Error(
      `facebook: Reel ${videoId} was still uploading after ${REEL_POLL.maxAttempts} status checks; nothing was ` +
        "published, so the next attempt starts a fresh upload",
    );
  }

  // The finish answer is not read beyond its envelope (`success` is not
  // documented as always present); the status poll below is the verdict.
  await graphRequest(`${creds.pageId}/video_reels`, {
    method: "POST",
    params: { upload_phase: "finish", video_id: videoId, video_state: "PUBLISHED", description },
    accessToken: creds.pageToken,
    appSecret: creds.appSecret,
  });

  const ref = `${REEL_PREFIX}${videoId}`;
  let warning: string;
  try {
    if (await waitForReel(videoId, creds, reelPublished, "publishing")) return { ref };
    warning =
      `Reel ${videoId} was accepted but had not finished publishing after ${REEL_POLL.maxAttempts} status checks; ` +
      "the reconcile confirms it";
  } catch (err) {
    if (err instanceof ReelFailedError) throw err;
    // A status READ that failed (a timeout, a rate limit) says nothing about
    // the Reel, which may already be live. Throwing here would put the leg back
    // to `pending` (and a rate limit would even be retried in-process by
    // withRetry), publishing it twice.
    const reason = getErrorMessage(err);
    warning = `Reel ${videoId} was accepted but its status could not be read after finish (${reason}); the reconcile confirms it`;
  }
  console.warn(`[facebook] ${warning}`);
  return { ref, warnings: [warning] };
}

/**
 * Post the render's content, either as a photo (`POST /{page-id}/photos`,
 * one image max — see assertSinglePhotoOnly) or as a plain text post
 * (`POST /{page-id}/feed`) when no image is attached.
 *
 * Facebook accepts a public image URL directly on `/photos`, so — unlike
 * Bluesky/LinkedIn/Pinterest — this never fetches the asset's bytes locally;
 * `asset.url` is sent straight through as the `url` param.
 *
 * `render.threadItems` is ignored: SPECS.facebook declares
 * `supportsThreads: false`, so there is no chain to send. `render.firstComment`
 * IS supported (SPECS.facebook: `supportsFirstComment: true`) and is posted
 * as a real comment AFTER the post itself succeeds — see postComment below
 * and the try/catch here that keeps a failed comment from failing the whole
 * publish, because the post is already live by that point.
 */
async function publishNow(input: DirectPublishInput): Promise<DirectPublishResult> {
  const { render, media } = input;
  const video = collectReelVideo(media);
  const images = video ? [] : assertSinglePhotoOnly(media);

  const creds = await metaCredentials();
  let ref: string;
  let warnings: string[] | undefined;

  if (video) {
    ({ ref, warnings } = await publishReel(video, render.content, creds));
  } else if (images.length === 1) {
    const photoShape = metaShape("POST :page-id/photos");
    const photoBody = await graphRequest(`${creds.pageId}/photos`, {
      method: "POST",
      // `alt_text_custom` is the Page-photo field for accessible alt text,
      // VERIFIED against developers.facebook.com/docs/graph-api: "Accessible
      // alternative description for an image."
      //
      // ⚠️ It is NOT `alt_text`. That is Instagram's field on /{ig-user-id}/media,
      // and the two are not interchangeable despite being one API. Graph
      // IGNORES unknown POST parameters rather than rejecting them, so getting
      // this name wrong does not fail — it publishes a photo with no alt text
      // and reports success, which is why the name is pinned in a test.
      params: {
        url: images[0].url,
        caption: render.content,
        alt_text_custom: images[0].altText,
      },
      accessToken: creds.pageToken,
      appSecret: creds.appSecret,
    });
    const photoFields = graphBody(photoShape, photoBody);
    const photo = {
      // The photo is already live here: an unusable photo id (empty, or not a
      // string) is treated like a missing one below (warn, keep the post ref),
      // never thrown, which would discard the post_id we do have.
      id: typeof photoFields.id === "string" && photoFields.id !== "" ? photoFields.id : undefined,
      post_id: photoShape.optId(photoFields.post_id, "post_id"),
    };
    if (!photo.post_id) {
      // The photos edge's documented return shape carries `post_id` for a
      // newly published photo; without it there is no post-shaped ref this
      // transport can hand back (delete/postFacts/postComment all operate
      // on a POST id, not a bare photo id), so this is a loud failure rather
      // than a silent fallback to the photo's own id.
      throw new Error(
        `facebook: photo upload succeeded (photo id ${photo.id}) but the response carried no post_id, so there is no post to reference`,
      );
    }
    // ⛔ BOTH ids, not just the story. `photo.id` is the only handle that can
    // ever delete the photo node, and it exists nowhere else: losing it here
    // orphans the photo. See PHOTO_MARKER.
    //
    // ⚠️ A MISSING `id` WARNS, IT DOES NOT THROW, and the asymmetry with the
    // `post_id` check above is deliberate. By this line the photo is already
    // PUBLISHED on the Page; throwing would discard the post_id we do have and
    // leave a live post with no recorded id anywhere — unreferenceable and
    // undeletable, which is strictly worse than the orphaned photo this code
    // exists to prevent. Degrade to the bare post ref instead.
    if (!photo.id) {
      console.warn(
        `[facebook] photo post ${photo.post_id} came back with no photo id; ` +
          "the photo object cannot be deleted with the post",
      );
    }
    ref = encodeRef(photo.post_id, photo.id);
  } else {
    // No image resolved (either none was attached, or the only candidate had
    // no fetchable public url) — text-only post.
    const feedShape = metaShape("POST :page-id/feed");
    const post = graphBody(
      feedShape,
      await graphRequest(`${creds.pageId}/feed`, {
        method: "POST",
        params: { message: render.content },
        accessToken: creds.pageToken,
        appSecret: creds.appSecret,
      }),
    );
    ref = feedShape.id(post.id, "id");
  }

  const result: DirectPublishResult = { ref, url: postUrl(ref), ...(warnings ? { warnings } : {}) };

  if (render.firstComment) {
    try {
      await postComment(ref, render.firstComment);
    } catch (err) {
      // The post is already live at this point. A failed first comment is a
      // real loss (the operator's link-in-comment strategy — see the
      // ⚠️ link-penalty note in SPECS.facebook — silently didn't land) but it
      // must not make the whole publish read as failed, so this only warns.
      const reason = getErrorMessage(err);
      console.warn(`[facebook] first comment failed for post ${ref}, post itself is live: ${reason}`);
      result.warnings = [...(result.warnings ?? []), `first comment failed: ${reason}`];
    }
  }

  return result;
}

/** A real comment on the post object — NOT the same mechanism as a Threads reply. */
async function postComment(rawRef: string, text: string): Promise<void> {
  const creds = await metaCredentials();
  // The new comment's id is not used; the envelope check is the whole read.
  await graphRequest(`${parseRef(rawRef).postId}/comments`, {
    method: "POST",
    params: { message: text },
    accessToken: creds.pageToken,
    appSecret: creds.appSecret,
  });
}

/**
 * Best-effort "Meta is confirming this object is gone" check, used by both
 * `deletePost` (already-gone-is-success) and `postFacts` (confirmed-absent
 * logging, see that function's docblock).
 *
 * `code === 100` alone proves nothing: it is Meta's broad "invalid
 * parameter" bucket covering many unrelated validation failures (see
 * meta-graph.ts's MetaGraphError docblock — 100 is neither `retryable` nor
 * `needsReauth`), not a dedicated not-found code. Meta does not publish a
 * stable contract for the exact wording, only the message text widely and
 * consistently observed for a missing/deleted object ("...does not exist,
 * cannot be loaded due to missing permissions, or does not support this
 * operation..."), so this narrows on that text — the same kind of
 * message-content matching bluesky-transport.ts's isNotFoundError does for
 * Bluesky's XRPC error body, with the same caveat: NOT vendor-guaranteed,
 * best available signal.
 */
function isMetaNotFound(err: unknown): boolean {
  if (!(err instanceof MetaGraphError)) return false;
  if (err.code !== 100) return false;
  return /does not exist|cannot be loaded/i.test(err.message);
}

/**
 * A post whose deletion already happened (an earlier partial failure, a
 * manual removal on facebook.com) reads as a "does not exist" error from
 * Graph. Recognising that as SUCCESS rather than an error is the whole point
 * of this migration: Postiz's equivalent path reports success on a FAILED
 * delete while the post stays live, the opposite failure mode.
 *
 * ⛔ UNVERIFIED, and Meta's own documentation CONTRADICTS ITSELF on it. Three
 * pages disagree about whether this call is even permitted:
 *
 *   - /page/feed says deletion happens via `DELETE /{post-id}`;
 *   - /post/ says "You can't perform this operation on this endpoint";
 *   - /page-post/ says "Only select developers can perform this operation
 *     using the API."
 *
 * Implemented as `DELETE /{post-id}` because that is what every other
 * transport here does and what apps holding `pages_manage_posts` are widely
 * observed to use, but NOTHING in this repo has proven it against a live
 * token. If Meta refuses, this throws and the leg correctly stays recorded as
 * live — a loud failure, not a false success, which is the right direction to
 * be wrong in. Prove it with a real create-then-delete before the Facebook
 * cutover, exactly as bluesky.live.proof.test.ts does; a cutover justified by
 * "delete works properly now" cannot rest on an unread doc.
 */
async function deleteGraphObject(id: string, creds: MetaCredentials): Promise<void> {
  try {
    // The answer is `{ success: true }`; a `false` is refused, because the caller reports success.
    const s = metaShape("DELETE :id");
    const res = graphBody(s, await graphRequest(id, {
      method: "DELETE",
      accessToken: creds.pageToken,
      appSecret: creds.appSecret,
    }));
    if (s.optBool(res.success, "success") === false) s.fail("success", "true", false);
  } catch (err) {
    if (!isMetaNotFound(err)) throw err;
    // Idempotent: already gone is success, but only once the answer is about
    // THIS Page's object (see whyNotGone).
    const why = await whyNotGone(id, creds);
    if (!why) return;
    throw new Error(`facebook: Meta answered "does not exist" for ${id}, which cannot be read as deleted: ${why}`, {
      cause: err,
    });
  }
}

/**
 * Why a code-100 "does not exist" for `id` is NOT proof the object is gone, or
 * null when it is.
 *
 * ⛔ Meta's text also covers "cannot be loaded due to missing permissions", so
 * a token for ANOTHER Page (the credential was switched) or one that lost its
 * own Page reads every live post as missing, and the delete reported success
 * while the post stayed up. A feed story id names its Page
 * (`{page-id}_{post-id}`), which has to be the configured one; a photo or Reel
 * id names no owner. Either way the configured token must still read its own
 * Page, or the answer says nothing about the object.
 */
async function whyNotGone(id: string, creds: MetaCredentials): Promise<string | null> {
  const sep = id.indexOf("_");
  if (sep > 0 && id.slice(0, sep) !== creds.pageId) {
    return `it belongs to Page ${id.slice(0, sep)}, not the configured Page ${creds.pageId}`;
  }
  try {
    const s = metaShape("GET :page-id?fields=id");
    s.id(
      graphBody(
        s,
        await graphRequest(creds.pageId, {
          params: { fields: "id" },
          accessToken: creds.pageToken,
          appSecret: creds.appSecret,
        }),
      ).id,
      "id",
    );
    return null;
  } catch (probe) {
    return `the configured token cannot read its own Page ${creds.pageId} (${getErrorMessage(probe)})`;
  }
}

async function deletePost(rawRef: string): Promise<void> {
  const { postId, photoId } = parseRef(rawRef);
  const creds = await metaCredentials();

  // ⛔ THE STORY FIRST, THE PHOTO SECOND, AND THE ORDER IS LOAD-BEARING. The
  // feed story is the thing a visitor sees, so it is the obligation that must
  // not be traded away: if it cannot be deleted this throws before touching the
  // photo, and the leg correctly stays recorded as live rather than being left
  // as a story pointing at a deleted image.
  // A Reel ref parses to its video id with no photo, so this one call is the
  // whole deletion: `DELETE /{video-id}` on a video the Page published.
  await deleteGraphObject(postId, creds);
  if (!photoId) return;

  // A failure here DOES propagate, so the caller sees an incomplete cleanup
  // rather than a silent orphan. Retrying is safe and is the intended recovery:
  // the second attempt finds the story already gone, swallows that as success,
  // and gets another go at the photo.
  await deleteGraphObject(photoId, creds);
}

/**
 * One `GET /{post-id}?fields=id` per ref, chunked to POST_FACTS_CONCURRENCY
 * so a large outstanding-legs sweep does not fire every request at once —
 * same shape as pinterest-transport.ts's postFacts, for the same reason
 * (Graph has no batch single-object lookup for arbitrary post ids in scope
 * here).
 *
 * ⚠️ Same rule as every other transport in this engine, spelled out in full
 * in pinterest-transport.ts's postFacts docblock:
 *
 *   A transport reports what it OBSERVED. Policy belongs to the caller.
 *
 * ERROR is a permanent verdict (reconcile-verdict.ts turns it into a failed
 * leg and never revisits it); a transport cannot see the caller's grace
 * window, so EVERY lookup failure here — a confirmed "does not exist" from
 * Meta included — maps to QUEUE, never ERROR. A confirmed-absent case is
 * still logged distinctly from an ordinary transient failure so the extra
 * information is not silently discarded, exactly as pinterest-transport.ts
 * does for its own confirmed-404 case.
 */
async function postFacts(refs: string[]): Promise<Map<string, DirectPostFacts>> {
  const out = new Map<string, DirectPostFacts>();
  if (!refs.length) return out;

  let creds: MetaCredentials;
  try {
    creds = await metaCredentials();
  } catch (err) {
    // Credential resolution failing is not a per-ref condition, but it must
    // not become ERROR for any ref either — same QUEUE-not-ERROR rule as a
    // network failure below.
    const reason = getErrorMessage(err);
    console.warn(`[facebook] postFacts could not resolve credentials, deferring the whole batch: ${reason}`);
    for (const ref of refs) out.set(ref, { state: "QUEUE", released: false, platform: "facebook" });
    return out;
  }

  for (let i = 0; i < refs.length; i += POST_FACTS_CONCURRENCY) {
    const batch = refs.slice(i, i + POST_FACTS_CONCURRENCY);
    await Promise.all(
      // ⚠️ Keyed by the ORIGINAL ref, looked up by the post id. The caller
      // matches this map against the `providerPostId` entry it passed in, so
      // re-keying on the parsed id would silently drop every photo leg from the
      // reconcile — they would read as never answered rather than as missing.
      batch.map(async (ref) => {
        try {
          const { postId, reel } = parseRef(ref);
          if (reel) {
            // A Reel's video node exists from the START phase on, published or
            // not, so its mere existence proves nothing. Only a publishing
            // phase that reached the end does; anything short of that is QUEUE
            // (a failed processing included: ERROR stays the caller's verdict).
            const status = await readReelStatus(postId, creds);
            if (!reelPublished(status)) {
              console.warn(`[facebook] Reel ${ref} is not published yet; reporting QUEUE`);
              out.set(ref, { state: "QUEUE", released: false, platform: "facebook" });
              return;
            }
          } else {
            // Existence is a 2xx that names an id; any other body is a failed lookup (QUEUE).
            const s = metaShape("GET :post-id?fields=id");
            s.id(
              graphBody(
                s,
                await graphRequest(postId, {
                  params: { fields: "id" },
                  accessToken: creds.pageToken,
                  appSecret: creds.appSecret,
                }),
              ).id,
              "id",
            );
          }
          out.set(ref, { state: "PUBLISHED", released: true, platform: "facebook" });
        } catch (err) {
          if (isMetaNotFound(err)) {
            // ⚠️ Logged as absent, but DELIBERATELY not flagged `absent` on the
            // facts object. Meta answers "deleted", "no permission" and
            // "unsupported operation" with one code-100 message, so this is not
            // the unambiguous vendor answer that flag is reserved for (see
            // DirectPostFacts.absent). Flagging it would let the reconcile
            // eventually mark a live post dead over a permissions change.
            console.warn(`[facebook] post ${ref} is confirmed absent; reporting QUEUE, not ERROR`);
          } else {
            const reason = getErrorMessage(err);
            console.warn(`[facebook] postFacts lookup failed for ${ref}: ${reason}`);
          }
          out.set(ref, { state: "QUEUE", released: false, platform: "facebook" });
        }
      }),
    );
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Analytics                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Page-post metrics, keeping Facebook's own `post_`-prefixed names.
 *
 * Pages and Instagram are separate metric namespaces in the same API. Renaming
 * either to match the other would fabricate an equivalence the vendor does not
 * make.
 */
async function analyticsPost(rawRef: string): Promise<Record<string, number>> {
  const { postId, reel } = parseRef(rawRef);
  if (reel) {
    // A Reel has no feed story to ask; its counters live on the video node,
    // under the Reels metric names (FB_REEL_METRICS), passed through unrenamed.
    const creds = await metaCredentials();
    const data = await graphRequest(`${postId}/video_insights`, {
      params: { metric: FB_REEL_METRICS.join(",") },
      accessToken: creds.pageToken,
      appSecret: creds.appSecret,
    });
    return toMetricBag(readInsightRows(metaShape("GET :video-id/video_insights"), data));
  }
  // Insights are a property of the STORY. Asking Graph for `post_media_view`
  // on a photo node returns nothing useful, so this must be the parsed id.
  return getFacebookPostInsights(postId);
}

async function analyticsChannel(): Promise<Record<string, number>> {
  return getFacebookPageInsights();
}

async function followerStats(): Promise<{ followers: number }> {
  return getFacebookFollowers();
}

export const facebookTransport: DirectTransport = {
  platform: "facebook",
  channelRules,
  connectStatus,
  publishNow,
  deletePost,
  postFacts,
  postUrl,
  postComment,
  analyticsPost,
  analyticsChannel,
  followerStats,
};
