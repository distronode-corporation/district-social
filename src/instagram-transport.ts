/**
 * Instagram's DirectTransport — the first of the P3 Meta trio (Facebook Page,
 * Instagram, Threads) built on top of meta-graph.ts's shared client.
 * Everything platform-specific to how Instagram models a post lives here;
 * everything about *talking* to Meta (the error envelope, appsecret_proof,
 * version pinning) lives in meta-graph.ts and is intentionally NOT duplicated
 * here — this file only ever calls `graphRequest`.
 *
 * ⚠️ THE BIG STRUCTURAL DIFFERENCE FROM EVERY OTHER TRANSPORT IN THIS ENGINE:
 * Bluesky/Pinterest/LinkedIn all fetch the render's media bytes and upload
 * them to the vendor. Instagram's Content Publishing API does not offer that
 * path at all — `POST /{ig-user-id}/media` takes `image_url`, a URL Meta's
 * own servers fetch server-side, unauthenticated (verified against Meta's
 * Content Publishing guide). A media asset with no public `url` therefore
 * cannot be posted, full stop; there is no bytes fallback to reach for.
 *
 * ⚠️ Container creation is asynchronous. `status_code` on the container moves
 * through IN_PROGRESS -> FINISHED (or ERROR/EXPIRED), and `media_publish`
 * needs FINISHED — verified against the ig-container reference. This module
 * polls proactively (see waitUntilFinished's docblock) rather than waiting
 * for a failed publish to tell it to.
 *
 * Video publishes as a Reel: one container with
 * `media_type=REELS` + `video_url`, the same poll-then-`media_publish` flow as
 * an image, on a video-sized poll budget (see REELS_POLL). Things still NOT
 * built here, refused loudly instead of silently mishandled:
 *   - a video inside a carousel, or a video alongside any other media
 *     (collectReelVideo): a Reel is one video and nothing else, and Meta does
 *     not allow a Reel as a carousel child.
 *   - the resumable rupload path for local bytes: the video must already have
 *     a public url, exactly like an image.
 *   - animated GIFs (assertNoGif) — Meta's own image requirements doc states
 *     plainly that "JPEG is the only image format supported."
 *
 * Engine rules apply: relative imports only, no `@/`, no prisma, no next.
 */

import {
  getInstagramFollowers,
  getInstagramMediaInsights,
  getInstagramUserInsights,
  graphRequest,
  metaCredentials,
  MetaGraphError,
} from "./meta-graph.js";
import { PublishPreflightError } from "./publish.js";
import type {
  DirectConnectStatus,
  DirectPostFacts,
  DirectPublishInput,
  DirectPublishResult,
  DirectTransport,
  TransportChannelRules,
} from "./transport.js";
import type { MediaAsset, PlatformRender } from "./types.js";
import { getErrorMessage } from "./error-message.js";

const MB = 1024 * 1024;

/**
 * "Carousels are limited to 10 images, videos, or a mix of the two." —
 * verified against Meta's Content Publishing guide.
 */
const MAX_CAROUSEL_ITEMS = 10;

/**
 * How long to wait between a container's `status_code` checks, and how many
 * checks to make before giving up.
 *
 * Meta's own documented guidance ("query a container's status once per
 * minute, for no more than 5 minutes") is written for the REACTIVE
 * troubleshooting case — the content-publishing guide's video section
 * describes it as what to do AFTER `media_publish` has already failed to
 * return an id, not as a mandatory pre-publish step for every container.
 * Nothing in the docs states plainly that image containers must be polled
 * before every publish.
 *
 * This module polls PROACTIVELY anyway, before the first `media_publish`
 * attempt, and on a much tighter interval than Meta's reactive guidance:
 * the task this transport exists for is a single caption+image (or a small
 * image carousel) publish, not a large video upload, so a several-second
 * bounded loop is enough to absorb ordinary processing latency without
 * making an operator wait minutes for what is usually a near-instant
 * container. This is an engineering judgment call, not a vendor-mandated
 * number — the same honesty pinterest-transport.ts applies to its own
 * unverified byte/duration figures.
 */
const CONTAINER_POLL_INTERVAL_MS = 1500;
const CONTAINER_POLL_MAX_ATTEMPTS = 8;

interface PollBudget {
  intervalMs: number;
  maxAttempts: number;
}

const IMAGE_POLL: PollBudget = { intervalMs: CONTAINER_POLL_INTERVAL_MS, maxAttempts: CONTAINER_POLL_MAX_ATTEMPTS };

/**
 * A Reel container, by contrast, has to download and transcode a video before
 * it reads FINISHED, which Meta's own guide puts at tens of seconds to minutes.
 * 36 checks 5 s apart is a three-minute ceiling.
 *
 * ⛔ The ceiling is bounded from ABOVE by the publish claim, not only by
 * patience. publish-due holds a leg as `publishing` for the caller's
 * claim-stale window (10 minutes) and then hands it back to `pending`; a poll that
 * outlived that would let the next tick publish the same Reel a second time.
 * Three minutes leaves room for the create, the publish and the permalink calls
 * inside one claim. A timeout here throws BEFORE `media_publish`, so nothing is
 * live and the next tick starts a fresh container.
 */
export const REELS_POLL: PollBudget = { intervalMs: 5_000, maxAttempts: 36 };

/**
 * "MP4 and MOV", the /{ig-user-id}/media reference's Reels specification.
 * Refused up front by type, because Meta's own answer to anything else is a
 * container ERROR carrying no format in it.
 */
export const REELS_VIDEO_FORMATS: readonly string[] = ["video/mp4", "video/quicktime"];

/** "3 seconds minimum", same reference. The 15-minute maximum is channelRules().maxVideoSec. */
export const REELS_MIN_SEC = 3;

/** Caps concurrent GET /{ig-media-id} lookups during a reconcile sweep — same
 *  reasoning and same figure as pinterest-transport.ts's POST_FACTS_CONCURRENCY:
 *  Instagram has no batch media lookup either, so a large outstanding-legs
 *  list would otherwise fire one request per ref simultaneously. */
const POST_FACTS_CONCURRENCY = 10;

function channelRules(): TransportChannelRules {
  return {
    // 2200 UTF-16 code units — verified against the /{ig-user-id}/media
    // reference's `caption` param ("Maximum 2200 characters"). Matches
    // SPECS.instagram.maxChars.
    maxLength: 2200,
    countMode: "utf16",
    // 10 items per carousel — see MAX_CAROUSEL_ITEMS.
    maxImages: MAX_CAROUSEL_ITEMS,
    // ⚠️ 8 MB, NOT the 30 MB in help-centre prose about the app. The
    // /{ig-user-id}/media reference itself states "File size: 8 MB maximum"
    // for images, and it is the reference the
    // publish call is validated against. Matches SPECS.instagram.
    maxImageBytes: 8 * MB,
    // "JPEG is the only image format supported." Declared here rather than only
    // enforced in collectImages, so media-fit.ts can RE-ENCODE a PNG at publish
    // time instead of the leg being refused, since a card pipeline can emit
    // PNG.
    imageFormats: ["image/jpeg"],
    // Reels: "300MB maximum", "15 mins maximum" on the same reference page
    // (not the app help-centre's 4 GB with no duration).
    maxVideoBytes: 300 * MB,
    maxVideoSec: 900,
  };
}

async function connectStatus(): Promise<DirectConnectStatus> {
  try {
    const { pageToken, appSecret, igUserId } = await metaCredentials();
    if (!igUserId) {
      // meta-graph.ts's own docblock: igUserId is "Absent until Instagram is
      // wired". A missing id says nothing about the Page token being bad, so
      // this reads as "not connected yet", not a thrown error.
      return {
        connected: false,
        accountId: "",
        displayName: "",
        reason: "no Instagram business account is linked (MetaCredentials.igUserId is unset)",
      };
    }
    // id/username, verified against the ig-user reference (instagram_basic).
    const profile = await graphRequest<{ id: string; username: string }>(igUserId, {
      params: { fields: "id,username" },
      accessToken: pageToken,
      appSecret,
    });
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
 * ⚠️ Best-effort ONLY, and likely does not resolve.
 *
 * Every other transport's postUrl can build a real, working permalink from
 * the bare ref alone: Bluesky's AT-URI embeds the DID+rkey, Pinterest's
 * numeric pin id IS the `/pin/{id}/` path, LinkedIn's URN IS the
 * `/feed/update/{urn}/` path. Instagram's public `/p/{shortcode}/` path does
 * NOT — the shortcode is a distinct base64-style encoding of the numeric
 * media id, and nothing in Meta's official docs describes a conversion
 * between them (confirmed by search: only reverse-engineered third-party
 * scripts claim one, never Meta itself). `ref` here is the raw numeric media
 * id — what media_publish returns and what postFacts/deletePost actually
 * operate on — so this synchronous, no-network method cannot construct the
 * real permalink.
 *
 * The REAL permalink is fetched vendor-side inside publishNow, via one extra
 * `GET /{id}?fields=permalink` call (that path is already async), and
 * returned as `DirectPublishResult.url`. Prefer that everywhere it is
 * available; this function exists only to satisfy the DirectTransport
 * interface for a caller holding nothing but a bare stored ref, and there is
 * no verified guarantee the string it returns resolves to anything.
 */
function postUrl(ref: string): string {
  return `https://www.instagram.com/p/${ref}/`;
}

/**
 * The one video this leg publishes as a Reel, or null for an image post.
 *
 * Every refusal is a PublishPreflightError, raised before any network call:
 * publish.ts's per-leg loop isolates one platform's refusal from the others,
 * so refusing loudly here keeps the rest of a multi-platform publish going
 * rather than posting something the render did not ask for.
 *
 * ⛔ Video plus anything else is REFUSED, not trimmed to the video. Meta does
 * not take a Reel as a carousel child, and quietly dropping the operator's
 * other media is the content loss every transport in this folder refuses.
 */
function collectReelVideo(media: MediaAsset[]): MediaAsset | null {
  const videos = media.filter((m) => m.type === "video");
  if (!videos.length) return null;
  if (media.length > 1) {
    throw new PublishPreflightError(
      `Instagram Reels carry exactly one video and nothing else, and this render selects ${media.length} media ` +
        `items including ${videos.length} video(s). A Reel cannot be a carousel child. Select only the video for ` +
        "Instagram, or drop Instagram from the targets, so the other platforms in this publish can still go out.",
    );
  }
  const [video] = videos;
  if (!REELS_VIDEO_FORMATS.includes(video.mimeType)) {
    throw new PublishPreflightError(
      `Instagram Reels accept MP4 or MOV only, and ${video.path} is "${video.mimeType}". Attach an MP4, or drop ` +
        "Instagram from this draft's targets.",
    );
  }
  if (!video.url) {
    throw new PublishPreflightError(
      `Instagram video ${video.path} has no public url. video_url must be a PUBLIC url Meta fetches server-side, ` +
        "so this video cannot be posted until it is hosted.",
    );
  }
  if (video.durationSec !== undefined && video.durationSec < REELS_MIN_SEC) {
    throw new PublishPreflightError(
      `Instagram Reels must run at least ${REELS_MIN_SEC}s, and ${video.path} runs ${video.durationSec}s.`,
    );
  }
  return video;
}

/**
 * Whether this asset is disclosed as AI-generated, for `is_ai_generated`.
 *
 * Read DEFENSIVELY on purpose: the flag originates in SocialAsset.genMeta, and
 * a draft's media is a JSON snapshot that may carry it flat (`aiGenerated`) or
 * nested (`genMeta.aiGenerated`), or not at all on anything stored before the
 * flag existed. Only a literal `true` counts. A missing or malformed value
 * sends no disclosure, which is exactly what this transport sent before.
 */
export function isAiGeneratedAsset(asset: MediaAsset): boolean {
  const loose = asset as MediaAsset & { aiGenerated?: unknown; genMeta?: unknown };
  if (loose.aiGenerated === true) return true;
  const meta = loose.genMeta;
  return typeof meta === "object" && meta !== null && (meta as { aiGenerated?: unknown }).aiGenerated === true;
}

/**
 * "JPEG is the only image format supported. Extended JPEG formats such as
 * MPO and JPS are not supported." — Meta's own image requirements doc, for
 * `image_url`. Refused loudly rather than silently dropped: a gif attached
 * to a draft is exactly the kind of quiet content loss pinterest-transport.ts's
 * collectImages docblock warns against.
 */
function assertNoGif(media: MediaAsset[]): void {
  if (media.some((m) => m.type === "gif")) {
    throw new Error(
      "instagram: animated GIFs are not supported by the Content Publishing API (image_url accepts JPEG only, " +
        "per Meta's image requirements doc). Attach a static JPEG instead, or drop Instagram from this leg's targets.",
    );
  }
}

interface InstagramImageSource {
  url: string;
  altText?: string;
}

/**
 * Resolve the render's selected media into `image_url` sources.
 *
 * Throws rather than skipping an unsupported asset, same principle as
 * pinterest-transport.ts's collectImages: a silently dropped image is quiet
 * content loss.
 * collectReelVideo/assertNoGif have already routed or refused those media types
 * before this runs, so every candidate here only needs a supported mime type
 * and a public url to become sendable.
 */
/**
 * ⚠️ A PNG REACHING THIS FUNCTION MEANS THE FIT DID NOT RUN, NOT THAT THE POST
 * IS UNPUBLISHABLE. Check the caller before touching anything here.
 *
 * The JPEG-only rule below is real and verified against Meta directly, and
 * this transport deliberately does not re-encode: `sharp` is
 * a native binary and this folder must stay liftable (no `@/`, no prisma, no
 * next), so the conversion is injected instead. `channelRules().imageFormats`
 * declares ["image/jpeg"], `fitForTransport` reads that declaration, and the
 * app's injected media fitter (`fitMediaForPublish`) does the transcode and
 * re-uploads the JPEG so `image_url` points at bytes Meta will accept.
 *
 * ⛔ EVERY PUBLISH PATH MUST FIT. publish.ts fits inline, and the scheduled
 * path (publish-due, which releases every SCHEDULED leg) must too: a caller
 * of `publishNow` that skips `fitForTransport` produces exactly the error
 * below naming an `ai-card-*.png`.
 *
 * Refusing loudly stays the correct behaviour here: a per-leg refusal that names
 * the format is recoverable and points at the missing fit, whereas Meta's own
 * answer to a PNG `image_url` is a container ERROR with no format in it.
 */
function collectImages(media: MediaAsset[]): InstagramImageSource[] {
  const candidates = media.filter((m) => m.type === "image").slice(0, MAX_CAROUSEL_ITEMS);
  const out: InstagramImageSource[] = [];
  for (const asset of candidates) {
    if (asset.mimeType !== "image/jpeg") {
      throw new Error(
        `instagram: unsupported image mime type "${asset.mimeType}" (Meta's Content Publishing API documents ` +
          `JPEG as the only image_url format it accepts) — asset ${asset.path}`,
      );
    }
    if (!asset.url) {
      // Instagram's image_url must be a PUBLIC url Meta fetches server-side,
      // unauthenticated — there is no bytes-upload fallback for this
      // transport (see the module header), so an asset with nothing public
      // to point at cannot be posted at all.
      throw new Error(
        `instagram: media asset ${asset.path} has no public url (image_url must be a PUBLIC url Meta fetches ` +
          `server-side, unauthenticated, and this asset has none to offer)`,
      );
    }
    out.push({ url: asset.url, altText: asset.altText });
  }
  return out;
}

interface ContainerStatusResponse {
  status_code: "EXPIRED" | "ERROR" | "FINISHED" | "IN_PROGRESS" | "PUBLISHED";
  status?: string;
}

/**
 * Poll a container's `status_code` until it is ready to publish (FINISHED —
 * or already PUBLISHED, treated the same way here).
 *
 * ERROR/EXPIRED are terminal and throw immediately: nothing about the vendor
 * being reachable will change what already happened to this container. An
 * IN_PROGRESS container is checked again after `budget.intervalMs`, bounded by
 * `budget.maxAttempts`: IMAGE_POLL for images (see CONTAINER_POLL_INTERVAL_MS
 * for why this polls proactively rather than only after a failed publish),
 * REELS_POLL for a video.
 */
async function waitUntilFinished(
  containerId: string,
  accessToken: string,
  appSecret: string,
  budget: PollBudget = IMAGE_POLL,
): Promise<void> {
  for (let attempt = 0; attempt < budget.maxAttempts; attempt++) {
    const { status_code: statusCode, status } = await graphRequest<ContainerStatusResponse>(containerId, {
      params: { fields: "status_code,status" },
      accessToken,
      appSecret,
    });

    if (statusCode === "FINISHED" || statusCode === "PUBLISHED") return;

    if (statusCode === "ERROR" || statusCode === "EXPIRED") {
      throw new Error(
        `instagram: container ${containerId} reached status_code "${statusCode}"` +
          `${status ? ` (${status})` : ""} and cannot be published`,
      );
    }

    // IN_PROGRESS. Wait before the next check, unless this was the last
    // attempt — no point sleeping only to fall out of the loop unchecked.
    if (attempt < budget.maxAttempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, budget.intervalMs));
    }
  }

  throw new Error(
    `instagram: container ${containerId} did not finish processing after ${budget.maxAttempts} status ` +
      `checks (~${(budget.maxAttempts * budget.intervalMs) / 1000}s) — still IN_PROGRESS`,
  );
}

/**
 * One REELS container, VERIFIED against the /{ig-user-id}/media reference and
 * the Content Publishing guide.
 *
 * - `share_to_feed=true`: the Reel shows in the Feed tab as well as Reels,
 *   which is what an ordinary post does. NOT sent for a Trial Reel, whose
 *   whole point is that followers do not see it until it graduates.
 * - `trial_params`: a JSON object on the vendor side, sent here as its JSON
 *   string because this client form-encodes every write. Graph parses JSON
 *   strings for object-valued params elsewhere; UNVERIFIED for this one until
 *   a live Trial Reel has been published.
 * - `is_ai_generated=true` only on an asset disclosed as AI-generated (see
 *   isAiGeneratedAsset). Absent otherwise, never `false`, so a post with no
 *   provenance sends exactly what it did before.
 * - `cover_url`/`thumb_offset` are not sent: the render has no cover to name,
 *   and Meta defaults the thumbnail to the first frame.
 */
async function createReelContainer(
  igUserId: string,
  accessToken: string,
  appSecret: string,
  video: MediaAsset,
  render: PlatformRender,
): Promise<string> {
  const trial = render.instagramTrialReel;
  const { id } = await graphRequest<{ id: string }>(`${igUserId}/media`, {
    method: "POST",
    params: {
      media_type: "REELS",
      video_url: video.url,
      caption: render.content,
      share_to_feed: trial ? undefined : true,
      trial_params: trial ? JSON.stringify({ graduation_strategy: trial }) : undefined,
      is_ai_generated: isAiGeneratedAsset(video) ? true : undefined,
    },
    accessToken,
    appSecret,
  });
  return id;
}

async function createSingleContainer(
  igUserId: string,
  accessToken: string,
  appSecret: string,
  image: InstagramImageSource,
  caption: string,
): Promise<string> {
  const { id } = await graphRequest<{ id: string }>(`${igUserId}/media`, {
    method: "POST",
    params: { image_url: image.url, caption, alt_text: image.altText },
    accessToken,
    appSecret,
  });
  return id;
}

/**
 * Carousel children (`is_carousel_item=true`) do NOT accept `caption` —
 * verified against the /{ig-user-id}/media reference ("Not supported on
 * images or videos in carousels"), so the caption is sent only on the parent.
 * `alt_text` (added to the API 2025-03-24, image posts only, up to 1000
 * chars) is per-image, so it travels on each child instead.
 *
 * Each child is waited on individually before being named in the parent's
 * `children` list — undocumented as a strict requirement, but the safer
 * reading of "getting this wrong produces intermittent, random-looking
 * publish failures": a parent referencing an unfinished child container is
 * exactly the failure mode this transport exists to avoid, and images
 * finish fast in practice, so the extra round trip is cheap.
 */
async function createCarouselContainer(
  igUserId: string,
  accessToken: string,
  appSecret: string,
  images: InstagramImageSource[],
  caption: string,
): Promise<string> {
  const childIds: string[] = [];
  for (const image of images) {
    const { id } = await graphRequest<{ id: string }>(`${igUserId}/media`, {
      method: "POST",
      params: { image_url: image.url, is_carousel_item: true, alt_text: image.altText },
      accessToken,
      appSecret,
    });
    await waitUntilFinished(id, accessToken, appSecret);
    childIds.push(id);
  }

  // "children (comma-separated list of up to 10 container IDs)" — Meta's own
  // Content Publishing guide's carousel example. Standard Graph API
  // convention for a list-valued param sent through a form body.
  const { id: parentId } = await graphRequest<{ id: string }>(`${igUserId}/media`, {
    method: "POST",
    params: { media_type: "CAROUSEL", caption, children: childIds.join(",") },
    accessToken,
    appSecret,
  });
  return parentId;
}

/**
 * A real, permanent comment on the media object — `POST /{ig-media-id}/comments`
 * with `message`, verified against the ig-media/comments reference (needs
 * `instagram_manage_comments` + `instagram_basic`). NOT a Threads-style
 * reply: it does not chain against the platform's own reply/thread graph,
 * it is a comment like any user's, just posted by this account.
 */
async function postComment(ref: string, text: string): Promise<void> {
  const { pageToken, appSecret } = await metaCredentials();
  await graphRequest(`${ref}/comments`, {
    method: "POST",
    params: { message: text },
    accessToken: pageToken,
    appSecret,
  });
}

/**
 * `GET /{id}?fields=permalink` right after a successful publish — see
 * postUrl's docblock for why this is the only way to get Instagram's real,
 * working permalink. The post is already LIVE by the time this runs
 * (media_publish already returned an id), so a failed lookup here must not
 * fail or retry the publish — same principle applied to first-comment
 * failures below. Falls back to postUrl's best-effort (and, by its own
 * admission, unverified) guess rather than leaving `url` empty.
 */
async function fetchPermalink(
  mediaId: string,
  accessToken: string,
  appSecret: string,
): Promise<string | undefined> {
  try {
    const { permalink } = await graphRequest<{ permalink?: string }>(mediaId, {
      params: { fields: "permalink" },
      accessToken,
      appSecret,
    });
    return permalink;
  } catch (err) {
    console.warn(
      `[instagram] permalink lookup failed for published post ${mediaId}, falling back to the unverified ` +
        `convention url: ${getErrorMessage(err)}`,
    );
    return undefined;
  }
}

/**
 * Container, then publish, then (optionally) a first comment.
 *
 * A single image skips the carousel machinery entirely (no media_type,
 * no is_carousel_item, no children) — the plain single-container path
 * verified against the Content Publishing guide's two-step flow. A video takes
 * the same two steps as a REELS container, on the longer REELS_POLL budget.
 *
 * The result shape is identical for both: the media id as `ref`, the vendor
 * permalink as `url`. A Reel's media id deletes, reconciles, comments and reads
 * insights through exactly the same calls an image's does.
 */
async function publishNow(input: DirectPublishInput): Promise<DirectPublishResult> {
  const { render, media } = input;
  assertNoGif(media);
  const video = collectReelVideo(media);

  const { pageToken: accessToken, appSecret, igUserId } = await metaCredentials();
  if (!igUserId) {
    throw new Error(
      "instagram: no Instagram business account is linked (MetaCredentials.igUserId is unset — see meta-graph.ts)",
    );
  }

  let creationId: string;
  if (video) {
    creationId = await createReelContainer(igUserId, accessToken, appSecret, video, render);
    await waitUntilFinished(creationId, accessToken, appSecret, REELS_POLL);
  } else {
    const images = collectImages(media);
    if (!images.length) {
      throw new Error(
        "instagram: a post needs at least one image (Instagram requires media on every post) and none of the " +
          "attached media resolved to a sendable JPEG",
      );
    }

    creationId =
      images.length === 1
        ? await createSingleContainer(igUserId, accessToken, appSecret, images[0], render.content)
        : await createCarouselContainer(igUserId, accessToken, appSecret, images, render.content);

    await waitUntilFinished(creationId, accessToken, appSecret);
  }

  const { id: mediaId } = await graphRequest<{ id: string }>(`${igUserId}/media_publish`, {
    method: "POST",
    params: { creation_id: creationId },
    accessToken,
    appSecret,
  });

  let warnings: string[] | undefined;
  if (render.firstComment) {
    try {
      await postComment(mediaId, render.firstComment);
    } catch (err) {
      // The post is already LIVE (media_publish succeeded). A failed first
      // comment must not make the whole publish look failed — that would
      // strand a real, published post as a `pending`/retried leg, and a
      // retry would attempt to create a SECOND post rather than just the
      // missing comment. Log loudly and move on; nothing currently retries a
      // lone missing first comment (same kind of gap pinterest-transport.ts's
      // postFacts docblock flags for its own edge case — a handoff, not a fix).
      // The warning also rides back on the result so it reaches lastError.
      const reason = getErrorMessage(err);
      console.warn(`[instagram] first comment failed on published post ${mediaId}, leaving the post live: ${reason}`);
      warnings = [`first comment failed: ${reason}`];
    }
  }

  const permalink = await fetchPermalink(mediaId, accessToken, appSecret);
  return { ref: mediaId, url: permalink ?? postUrl(mediaId), ...(warnings ? { warnings } : {}) };
}

/** A vendor error, timeout, or rate limit says nothing about whether a post exists. */
function isMetaGraphError(err: unknown): err is MetaGraphError {
  return err instanceof MetaGraphError;
}

/**
 * Graph API's generic "gone" shape for this credential type: HTTP 400,
 * `code: 100` (GraphMethodException), message "...does not exist, cannot be
 * loaded due to missing permissions, or does not support this operation."
 * (verified via search against Meta's own developer community threads and
 * SDK issue trackers — the wording is consistent everywhere it is quoted).
 *
 * ⚠️ That message is explicitly AMBIGUOUS between "deleted", "no permission"
 * and "unsupported operation" — Meta does not distinguish them in the
 * response. That is even less certain than Pinterest's clean 404, which is
 * itself still never promoted to ERROR (see postFacts's docblock). This is
 * strictly weaker evidence, so it gets the same, more conservative answer.
 */
function isNotFoundError(err: unknown): boolean {
  if (!isMetaGraphError(err)) return false;
  return err.code === 100 && /does not exist/i.test(err.message);
}

/**
 * DELETE /{ig-media-id} IS a real, documented Graph API operation — verified
 * against the ig-media reference's deletion section: "Instagram API with
 * Facebook Login" (a Page access token + linked IG business account —
 * exactly this client's credential shape, see meta-graph.ts's
 * MetaCredentials) can delete non-ad posts, Stories, Reels and ENTIRE
 * carousel albums. It needs the `instagram_manage_contents` permission,
 * which this app may or may not currently hold; if it does not, Meta answers
 * with an ordinary permission error (a normal MetaGraphError — code 200 is
 * `needsReauth: true` in meta-graph.ts) rather than this function inventing
 * a "not supported" refusal for an operation the API genuinely offers.
 *
 * A single item inside a carousel canNOT be deleted individually — only the
 * whole parent album, by its own container id ("To delete media inside
 * carousel albums, the entire carousel album must be deleted by specifying
 * the carousel container media id") — but this transport only ever
 * publishes and stores the PARENT id (see createCarouselContainer), so that
 * limitation never reaches a caller here.
 */
async function deletePost(ref: string): Promise<void> {
  const { pageToken, appSecret } = await metaCredentials();
  try {
    await graphRequest(ref, { method: "DELETE", accessToken: pageToken, appSecret });
  } catch (err) {
    if (isNotFoundError(err)) return; // idempotent: already gone is success
    throw err;
  }
}

/**
 * One `GET /{id}?fields=id` per ref — Instagram has no batch media lookup
 * the way Bluesky's app.bsky.feed.getPosts does, same situation
 * pinterest-transport.ts documents for Pinterest, so this chunks to
 * POST_FACTS_CONCURRENCY rather than firing every request at once.
 *
 * ⚠️ Never ERROR from a lookup failure, confirmed-gone included — same rule
 * pinterest-transport.ts's postFacts docblock states in full: a transport
 * reports what it OBSERVED, ERROR is a permanent verdict the CALLER owns
 * (reconcile-verdict.ts turns it into a failed leg and never revisits it),
 * and the cost of being wrong is asymmetric — a QUEUE that should have been
 * ERROR is retried and corrected, while an ERROR that should have been
 * QUEUE marks a LIVE post dead for good. Instagram's "not found" signal is
 * if anything LESS trustworthy than Pinterest's clean 404 (see
 * isNotFoundError's docblock on the ambiguity in Meta's own wording), which
 * makes QUEUE the only defensible answer here too.
 */
async function postFacts(refs: string[]): Promise<Map<string, DirectPostFacts>> {
  const out = new Map<string, DirectPostFacts>();
  if (!refs.length) return out;

  let accessToken: string;
  let appSecret: string;
  try {
    ({ pageToken: accessToken, appSecret } = await metaCredentials());
  } catch (err) {
    // Losing the ability to look up at all is still a lookup failure, not a
    // verdict on any individual post — same "never ERROR" rule applies.
    console.warn(
      `[instagram] postFacts could not resolve credentials, reporting QUEUE for ${refs.length} ref(s): ` +
        `${getErrorMessage(err)}`,
    );
    for (const ref of refs) out.set(ref, { state: "QUEUE", released: false, platform: "instagram" });
    return out;
  }

  for (let i = 0; i < refs.length; i += POST_FACTS_CONCURRENCY) {
    const batch = refs.slice(i, i + POST_FACTS_CONCURRENCY);
    await Promise.all(
      batch.map(async (ref) => {
        try {
          await graphRequest(ref, { params: { fields: "id" }, accessToken, appSecret });
          out.set(ref, { state: "PUBLISHED", released: true, platform: "instagram" });
        } catch (err) {
          if (isNotFoundError(err)) {
            // That same ambiguity is why this is not flagged `absent` either
            // (see DirectPostFacts.absent) — the flag is for a vendor answer
            // that means one thing, and this one means three.
            console.warn(
              `[instagram] media ${ref} reads as gone (code 100); reporting QUEUE, not ERROR — Meta's own error ` +
                `text does not distinguish "deleted" from "no permission" or "unsupported"`,
            );
            out.set(ref, { state: "QUEUE", released: false, platform: "instagram" });
            return;
          }
          const reason = isMetaGraphError(err) ? err.message : String(err);
          console.warn(`[instagram] postFacts lookup failed for ${ref}: ${reason}`);
          out.set(ref, { state: "QUEUE", released: false, platform: "instagram" });
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
 * Keys are Instagram's own metric names, passed through unrenamed. See
 * meta-graph.ts for why `impressions` is not among them, and why one bad metric
 * name would take the whole call down rather than dropping a field.
 */
async function analyticsPost(ref: string): Promise<Record<string, number>> {
  return getInstagramMediaInsights(ref);
}

async function analyticsChannel(): Promise<Record<string, number>> {
  return getInstagramUserInsights();
}

async function followerStats(): Promise<{ followers: number }> {
  return getInstagramFollowers();
}

export const instagramTransport: DirectTransport = {
  platform: "instagram",
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
