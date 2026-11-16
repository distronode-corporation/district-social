/**
 * Pinterest's DirectTransport — mirrors bluesky-transport.ts's split: what a
 * pin/board/delete/lookup MEANS on this platform lives here; everything about
 * *talking* to Pinterest lives in pinterest.ts.
 *
 * ⚠️ The destination link is the thing to be careful about in this file, and
 * it is the reason `DirectPublishInput.destination` exists at all.
 *
 * A pin's click-through URL comes from `draft.source.link`, NOT from the copy:
 * playbook.ts's pinterest rule actively strips any URL out of `render.content`
 * (dropBodyLink) precisely because Pinterest carries the link as its own
 * field. A transport reading only the render therefore publishes a pin that
 * succeeds, returns a real id, reports analytics, and goes NOWHERE when
 * clicked — which is most of the point of a pin. The same applies to the
 * board: `render.board` only holds a board the operator picked explicitly, so
 * the Social HQ default (`defaultPinterestBoard`) arrives via `destination`
 * too, and reading the render alone would refuse publishes the aggregator
 * path accepted.
 *
 * Both are now read from `destination` first. If a later change makes that
 * field optional, this is what breaks and it breaks silently.
 *
 * Engine rules apply: relative imports only, no `@/`, no prisma, no next.
 */

import {
  createPin,
  deletePin,
  getAccountAnalytics,
  getFollowerCount,
  getPin,
  getPinAnalytics,
  getUserAccount,
  isPinterestNotFound,
  listBoards as fetchPinterestBoards,
  type PinterestImageContentType,
  type PinterestImageSource,
} from "./pinterest.js";
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

const MB = 1024 * 1024;

/** Real vendor cap: 1 image via `image_base64`, or a 2-5 image carousel via `multiple_image_base64`. */
const MAX_IMAGES = 5;

/**
 * Caps how many GET /pins/{id} calls run at once during a reconcile sweep.
 * Pinterest has no batch pin lookup (pinterest.ts's docblock), so a large
 * outstanding-legs list would otherwise fire one request per ref
 * simultaneously; this keeps a big batch from looking like a burst attack on
 * the vendor's rate limiter.
 */
const POST_FACTS_CONCURRENCY = 10;

/**
 * Pinterest's `image_base64` media source only declares two content types
 * (openapi.yaml `ContentType` enum: image/jpeg, image/png — no webp, no gif).
 * A mime type outside this map must fail loudly, not get silently re-encoded
 * or dropped.
 */
const CONTENT_TYPE_BY_MIME: Record<string, PinterestImageContentType> = {
  "image/jpeg": "image/jpeg",
  "image/png": "image/png",
};

function channelRules(): TransportChannelRules {
  return {
    // 800, per Pinterest's own OpenAPI description
    // (github.com/pinterest/api-description, PinCreate.description
    // maxLength), matching SPECS.pinterest.maxChars. An aggregator's integration
    // schema reports 500, which is narrower than what the real vendor API
    // accepts.
    maxLength: 800,
    countMode: "utf16",
    // Real vendor cap on images per pin — PinMediaSourceImagesBase64's
    // `items` array is `minItems: 2, maxItems: 5` for the carousel path, and
    // a single image_base64 pin is the other legal shape.
    maxImages: MAX_IMAGES,
    // NOT vendor-verified — same caveat specs.ts already carries for these
    // two figures. Pinterest publishes byte/duration guidance in prose
    // help-center pages, not in the OpenAPI schema's field constraints, so
    // there was nothing to check these against beyond what specs.ts already
    // recorded as a guard rather than a contract.
    maxImageBytes: 20 * MB,
    maxVideoBytes: 2048 * MB,
    maxVideoSec: 900,
  };
}

async function connectStatus(): Promise<DirectConnectStatus> {
  try {
    const account = await getUserAccount();
    return { connected: true, accountId: account.id, displayName: account.username };
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
 * Standard Pinterest pin permalink convention. NOT a field the vendor
 * returns — the v5 `Pin` schema has no url/permalink property (verified
 * against openapi.yaml) — so this is convention, not a confirmed contract,
 * same honesty bluesky-transport.ts's postUrl applies to its own DID-based
 * URL construction.
 */
function postUrl(pinId: string): string {
  return `https://www.pinterest.com/pin/${pinId}/`;
}

/**
 * Resolve the render's selected media into base64 image sources.
 *
 * Throws rather than skipping an unsupported asset: a silently dropped image
 * is exactly the kind of quiet content loss this migration exists to stop
 * (see this file's docblock on the destination link, a different instance of
 * the same principle). GIFs and videos are refused up front by the caller
 * (publishNow) with their own clear errors, so by the time this runs every
 * selected asset is a still image that only needs a supported mime type and a
 * public URL (requireMediaUrl) to become sendable.
 */
async function collectImages(media: MediaAsset[]): Promise<PinterestImageSource[]> {
  const candidates = media.filter((m) => m.type === "image").slice(0, MAX_IMAGES);
  const out: PinterestImageSource[] = [];
  for (const asset of candidates) {
    const url = requireMediaUrl("pinterest", asset);
    const contentType = CONTENT_TYPE_BY_MIME[asset.mimeType];
    if (!contentType) {
      throw new Error(
        `pinterest: unsupported image mime type "${asset.mimeType}" (Pinterest's media_source only accepts image/jpeg or image/png as base64)`,
      );
    }
    const bytes = await fetchMediaBytes("pinterest", url);
    out.push({ contentType, data: Buffer.from(bytes).toString("base64") });
  }
  return out;
}

/**
 * Pinterest allows exactly ONE alt_text per pin (max 500 chars), even for a
 * 2-5 image carousel — that is the vendor's model, not a gap in this client.
 *
 * ⚠️ So the question is what goes in it. Not
 * `media.find(m => m.type === "image")?.altText`: the FIRST image's
 * description, announced as the description of the whole pin. On a five-slide
 * carousel that is worse than saying nothing, because a screen-reader user is
 * told what one slide contains and given no signal that four more exist.
 *
 * Multiple images are therefore labelled and joined. Truncated to the vendor's
 * 500-char cap here rather than letting Pinterest reject the create — losing
 * the tail of a description is a far better outcome than losing the pin.
 */
const PINTEREST_ALT_TEXT_MAX = 500;

export function combinedAltText(imageCount: number, media: MediaAsset[]): string | undefined {
  // Only the images the pin carries (collectImages sends the first imageCount).
  const alts = media
    .filter((m) => m.type === "image")
    .slice(0, imageCount)
    .map((m) => m.altText?.trim() ?? "");
  const described = alts.filter(Boolean);
  if (!described.length) return undefined;

  // A single-image pin reads naturally with no numbering. A carousel is
  // numbered even when only one slide is described: unnumbered, that one
  // description reads as the whole pin's, with no signal that more slides exist.
  const joined =
    imageCount === 1
      ? described[0]
      : alts.map((alt, i) => `${i + 1}. ${alt || "(no description provided)"}`).join(" ");

  return joined.length > PINTEREST_ALT_TEXT_MAX ? joined.slice(0, PINTEREST_ALT_TEXT_MAX) : joined;
}

/**
 * Pinterest has no thread/reply/comment model (supportsThreads and
 * supportsFirstComment are both false on the Pinterest spec), so this is a
 * single vendor call with no follow-up chain — the simplest publishNow of
 * any transport so far, unlike Bluesky's root-then-replies branching.
 */
async function publishNow(input: DirectPublishInput): Promise<DirectPublishResult> {
  const { render, media, destination } = input;

  // `destination` first, `render.board` second. The render only ever carries a
  // board the operator picked EXPLICITLY on the draft; the Social HQ default
  // (settings "defaultPinterestBoard") lives on destination, so reading the
  // render alone silently ignores the default and refuses a publish that the
  // aggregator path would have accepted.
  const boardId = destination.board ?? render.board?.id;
  if (!boardId) {
    // Should already have been refused upstream (assertPinterestBoard /
    // platformSettings both check this before a publish reaches a
    // transport), so reaching this is a caller bug, not a vendor edge case —
    // fail loudly rather than let createPin() send a request Pinterest would
    // reject with a far less specific error.
    throw new Error(
      "pinterest: render has no destination board id (assertPinterestBoard should have refused this publish before it reached the transport)",
    );
  }

  if (media.some((m) => m.type === "video")) {
    // Pinterest's video pins need a separate register -> upload -> poll flow
    // (media_source's video_id path, registered via POST /media) that this
    // client does not implement (see pinterest.ts's docblock, and
    // SPECS.pinterest.publishesVideo). Refusing loudly here is safer than
    // silently posting an image-only pin from a render that was meant to carry
    // video, and a PublishPreflightError (like every other transport's media
    // refusal) marks it as "we refused to send", not a vendor failure.
    throw new PublishPreflightError(
      "pinterest: video pins are not supported by the direct transport yet (attach an image instead, or publish this one via the aggregator)",
    );
  }

  if (media.some((m) => m.type === "gif")) {
    // `image_base64` declares only image/jpeg and image/png, and this file
    // filtered to `type === "image"`, so a GIF beside a still image was
    // dropped from the pin without a word. Refused by name instead, as
    // instagram-transport.ts's assertNoGif does.
    throw new PublishPreflightError(
      "pinterest: animated GIFs are not supported by the direct transport (Pinterest's image_base64 media source " +
        "accepts only image/jpeg or image/png). Attach a static JPEG or PNG instead, or drop Pinterest from this leg's targets.",
    );
  }

  const images = await collectImages(media);
  if (!images.length) {
    throw new Error(
      "pinterest: a pin needs at least one image (Pinterest requires media on every pin) and none of the attached media resolved to a fetchable image",
    );
  }

  const pin = await createPin({
    boardId,
    title: render.title ?? destination.title,
    description: render.content,
    // The click-through URL, which is most of the point of a pin. It is NOT in
    // render.content: the Pinterest playbook strips URLs out of the copy
    // because Pinterest carries the link as its own field, so a transport
    // reading only the render publishes a pin that goes nowhere when clicked.
    link: destination.link,
    altText: combinedAltText(images.length, media),
    images,
  });

  return { ref: pin.id, url: postUrl(pin.id) };
}

/**
 * A record whose deletion already happened (an earlier partial failure, a
 * manual removal on pinterest.com) reads as a definitive 404 from the vendor.
 * Recognising that as SUCCESS rather than an error is the whole point of this
 * migration: Postiz's equivalent path reports success while the pin stays
 * live, the opposite failure mode.
 */
async function deletePost(ref: string): Promise<void> {
  try {
    await deletePin(ref);
  } catch (err) {
    if (isPinterestNotFound(err)) return; // idempotent: already gone is success
    throw err;
  }
}

/**
 * One GET /pins/{id} per ref (pinterest.ts's docblock: there is no batch
 * lookup), chunked to POST_FACTS_CONCURRENCY so a large outstanding-legs
 * sweep does not fire every request at once.
 *
 * Pinterest's single-id GET genuinely knows more than Bluesky's batch
 * getPosts does: a 404 is the vendor confirming the pin is gone, whereas
 * Bluesky merely omits URIs it cannot resolve, which is indistinguishable
 * from a transient miss. That extra information is real. It is still NOT
 * reported as ERROR here, and the reason is a rule that has to hold across
 * all nine transports:
 *
 *   A transport reports what it OBSERVED. Policy belongs to the caller.
 *
 * ERROR is not an observation, it is a verdict, and a permanent one:
 * reconcile-verdict.ts turns it into a failed leg, and nothing ever revisits
 * it. The plan's reconcile table deliberately puts a ONE-HOUR grace on
 * "ref not found" — QUEUE inside the hour, ERROR only past it — precisely
 * because a just-created post can read as absent from a replica that has not
 * caught up. `postFacts` receives bare refs and no timestamps, so it cannot
 * apply that grace, and a transport that answers ERROR anyway has quietly
 * overridden a policy it cannot see.
 *
 * The asymmetry settles it. A QUEUE that should have been ERROR is retried
 * and corrected; an ERROR that should have been QUEUE marks a LIVE pin dead
 * for good.
 *
 * ⚠️ There is a real gap on the other side of this, and it is not fixed by
 * being conservative: a pin deleted by a human on pinterest.com will now
 * read QUEUE forever, and reconcile-verdict.ts:44-45 strands anything
 * outside {PUBLISHED, ERROR} as pending indefinitely. Closing that needs the
 * CALLER to own the grace — postFacts must learn each ref's publish time, or
 * DirectPostFacts must carry "confirmed absent" separately from "cannot
 * tell". Whoever wires reconcile to postFacts (it has no consumer yet) owns
 * that, and this comment is the handoff.
 */
async function postFacts(refs: string[]): Promise<Map<string, DirectPostFacts>> {
  const out = new Map<string, DirectPostFacts>();
  for (let i = 0; i < refs.length; i += POST_FACTS_CONCURRENCY) {
    const batch = refs.slice(i, i + POST_FACTS_CONCURRENCY);
    await Promise.all(
      batch.map(async (ref) => {
        try {
          await getPin(ref);
          out.set(ref, { state: "PUBLISHED", released: true, platform: "pinterest" });
        } catch (err) {
          if (isPinterestNotFound(err)) {
            // Confirmed gone, and still QUEUE — see the docblock. Logged
            // distinctly from a lookup failure so the information is at least
            // visible until the caller can act on it.
            console.warn(`[pinterest] pin ${ref} is confirmed absent (404); reporting QUEUE, not ERROR`);
            // A clean 404 on a single-object GET is unambiguous, so the caller
            // is told WHICH kind of QUEUE this is and can eventually give up on
            // it. `state` is still QUEUE: the grace window is not ours.
            out.set(ref, { state: "QUEUE", released: false, platform: "pinterest", absent: true });
            return;
          }
          const reason = getErrorMessage(err);
          console.warn(`[pinterest] postFacts lookup failed for ${ref}: ${reason}`);
          out.set(ref, { state: "QUEUE", released: false, platform: "pinterest" });
        }
      }),
    );
  }
  return out;
}

/**
 * Pinterest boards, following pagination to the end (pinterest.ts's
 * listBoards). A caller doing the same three-way check publish.ts's
 * assertPinterestBoard does for the aggregator path — lookup exception warns
 * and proceeds, a definitive empty list refuses, an unrecognised id refuses
 * and lists what IS available — depends on this returning the COMPLETE list;
 * a board sitting past page one would otherwise read as nonexistent.
 */
async function listBoards(): Promise<Array<{ id: string; name: string }>> {
  return fetchPinterestBoards();
}

/* -------------------------------------------------------------------------- */
/*  Analytics                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * ⚠️ WINDOWED, not lifetime — see pinterest.ts. These numbers cover the last 30
 * days, where Instagram's and Threads' cover all time. A dashboard placing them
 * side by side is comparing different questions.
 */
async function analyticsPost(ref: string): Promise<Record<string, number>> {
  return getPinAnalytics(ref);
}

async function analyticsChannel(): Promise<Record<string, number>> {
  return getAccountAnalytics();
}

async function followerStats(): Promise<{ followers: number }> {
  return getFollowerCount();
}

export const pinterestTransport: DirectTransport = {
  platform: "pinterest",
  channelRules,
  connectStatus,
  publishNow,
  deletePost,
  postFacts,
  postUrl,
  listBoards,
  analyticsPost,
  analyticsChannel,
  followerStats,
};
