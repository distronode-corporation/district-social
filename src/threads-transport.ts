/**
 * Threads' DirectTransport — mirrors bluesky-transport.ts's split: what a
 * post/reply/carousel/delete/lookup MEANS on this platform lives here;
 * everything about *talking* to Threads lives in threads.ts.
 *
 * Bluesky, not Pinterest or LinkedIn, is the exemplar for the threading logic
 * specifically: Threads is the other platform in this engine with a real
 * reply chain, and publish-due.ts's drainReplies() already does the "chain
 * reply N+1 onto reply N via selfRef, not onto the root" work generically for
 * every transport that returns `selfRef` from `publishReply`. This file's job
 * is only to make that machinery work: queue every deferred reply against the
 * ROOT as its initial parent (drainReplies overrides that with the previous
 * reply's selfRef once one exists — see that file), and always return
 * `selfRef` from `publishReply` so the chain can be walked forward.
 *
 * Engine rules apply: relative imports only.
 */

import { PublishPreflightError } from "./publish.js";
import {
  ThreadsError,
  createContainer,
  deleteThread,
  getMediaInsights,
  getPermalink,
  getUserInsights,
  getProfile,
  isThreadsNotFound,
  pollContainerUntilFinished,
  publishContainer,
} from "./threads.js";
import type {
  DirectConnectStatus,
  DirectPostFacts,
  DirectPublishInput,
  DirectPublishResult,
  DirectQueuedReply,
  DirectTransport,
  TransportChannelRules,
} from "./transport.js";
import { threadReplies, type MediaAsset, type PlatformRender } from "./types.js";
import { getErrorMessage } from "./error-message.js";
import { trimLineEnds } from "./trim.js";

/** `children` on a CAROUSEL container: 2-20 items, VERIFIED against Meta's Threads API changelog — see channelRules(). */
const MAX_CAROUSEL_ITEMS = 20;

const MB = 1024 * 1024;

/**
 * Threads has no documented batch lookup (the API reference index lists only
 * "Media Retrieval" as a category, with every worked example fetching one id)
 * — same situation pinterest-transport.ts is in, so this borrows its
 * concurrency cap for the same reason: keep a large outstanding-legs sweep
 * from firing every GET at once.
 */
const POST_FACTS_CONCURRENCY = 10;

function channelRules(): TransportChannelRules {
  return {
    // 500, VERIFIED against developers.facebook.com/docs/threads/posts,
    // quoted verbatim: "Text posts are limited to 500 characters." specs.ts
    // carries the same 500. No UTF-8-byte-weighted emoji counting rule is in
    // the vendor docs; plain UTF-16 code units is what every other transport in
    // this folder uses for a platform
    // with no documented alternative, so that is what this reports too.
    maxLength: 500,
    countMode: "utf16",
    // 20, VERIFIED against Meta's own Threads API changelog, Sept 19 2024:
    // "Carousel posts are now allowed up to 20 images, videos, or a mix of
    // the two." specs.ts's mixedMediaAllowed/maxImages(20) claim is confirmed
    // by that changelog entry. Threads really does accept a mixed image/video carousel; THIS
    // transport still only ever sends images into one (see collectVideo): a
    // video publishes as a standalone VIDEO post, and a video carousel child
    // was never built, not because the vendor forbids it.
    maxImages: MAX_CAROUSEL_ITEMS,
    // 8MB, VERIFIED against developers.facebook.com/docs/threads/posts
    // (quoted verbatim: "8 MB maximum"). SPECS.threads carries the same
    // number; reporting it HERE is what keeps QA's `image-too-large` gate lit,
    // which is the entire reason channelRules() is not optional.
    maxImageBytes: 8 * MB,
    // "JPEG and PNG image types are the officially supported formats for image
    // posts", same doc. Wider than Instagram's JPEG-only, which is
    // exactly why this is a list: a PNG card publishes to Threads untouched and
    // gets re-encoded only for Instagram.
    imageFormats: ["image/jpeg", "image/png"],
    // Declared because this transport builds VIDEO containers; a transport
    // that refuses video outright must not declare a limit, or QA reports a
    // misleading "too long" finding instead of "not supported".
    maxVideoBytes: MAX_VIDEO_BYTES,
    maxVideoSec: MAX_VIDEO_SEC,
  };
}

async function connectStatus(): Promise<DirectConnectStatus> {
  try {
    const profile = await getProfile();
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
 * Best-effort ONLY, and it says so on purpose.
 *
 * Threads permalinks are `@username/post/{shortcode}` (VERIFIED against
 * developers.facebook.com/docs/threads/retrieve-and-discover-posts/retrieve-posts,
 * example response `"permalink": "https://www.threads.net/@threadsapitestuser/post/abcdefg"`),
 * and neither the username nor the shortcode is derivable from the bare
 * numeric media id this transport stores as `ref` — unlike Bluesky, where the
 * did and rkey are both already inside the AT URI, or Pinterest, where the
 * numeric pin id alone resolves a working permalink. `publishNow`/`publishReply`
 * fetch the REAL permalink with one extra `GET {id}?fields=permalink` call
 * (see `resolvePermalink` below) and use THAT for `url`; this synchronous
 * function exists only because `DirectTransport.postUrl` has no async form,
 * and the URL it returns here is NOT guaranteed to resolve to anything.
 */
function postUrl(ref: string): string {
  return `https://www.threads.net/post/${ref}`;
}

/** Real permalink when it can be fetched; the best-effort fallback when it can't, rather than losing the post's id-only URL entirely. */
async function resolvePermalink(mediaId: string): Promise<string> {
  try {
    return (await getPermalink(mediaId)) ?? postUrl(mediaId);
  } catch (err) {
    console.warn(
      `[threads] permalink lookup failed for ${mediaId}, falling back to a best-effort URL: ${getErrorMessage(err)}`,
    );
    return postUrl(mediaId);
  }
}

/**
 * "MOV or MP4", per developers.facebook.com/docs/threads/posts, video
 * specifications. Refused up front by type, because Threads' answer to anything
 * else is a container ERROR after the poll rather than a named refusal.
 */
export const THREADS_VIDEO_FORMATS: readonly string[] = ["video/mp4", "video/quicktime"];

/** "5 minutes maximum" and "1 GB maximum", same doc. Matches SPECS.threads. */
const MAX_VIDEO_SEC = 300;
const MAX_VIDEO_BYTES = 1024 * MB;

/**
 * A VIDEO container has to download and transcode before it reads FINISHED,
 * so it polls on a three-minute ceiling (36 x 5 s) instead of the client's
 * 24 s default. Bounded from above by the publish claim: publish-due hands a
 * `publishing` leg back after CLAIM_STALE_MS (10 minutes), and a poll that
 * outlived it would let the next tick post the same video twice. A timeout
 * throws BEFORE `threads_publish`, so nothing is live when it does.
 */
export const VIDEO_POLL = { maxAttempts: 36, intervalMs: 5_000 } as const;

/**
 * The one video this leg publishes as a VIDEO post, or undefined when there is
 * none. Every refusal is a PublishPreflightError raised before any network
 * call, so publish.ts's per-leg loop isolates it from the other platforms.
 *
 * ⛔ Video plus anything else is REFUSED rather than trimmed. Threads' own
 * carousels CAN mix image and video children, but this client has not built a
 * video carousel child, and silently dropping the other media (or the video)
 * is the quiet content loss every transport in this folder refuses.
 */
function collectVideo(media: MediaAsset[]): MediaAsset | undefined {
  const videos = media.filter((m) => m.type === "video");
  if (!videos.length) return undefined;
  if (media.length > 1) {
    throw new PublishPreflightError(
      `Threads video posts carry exactly one video, and this render selects ${media.length} media items ` +
        `including ${videos.length} video(s). A video inside a Threads carousel is not built in this client. ` +
        "Select only the video for Threads, or drop Threads from the targets, so the other platforms can still go out.",
    );
  }
  const [video] = videos;
  if (!THREADS_VIDEO_FORMATS.includes(video.mimeType)) {
    throw new PublishPreflightError(
      `Threads accepts MP4 or MOV video only, and ${video.path} is "${video.mimeType}". Attach an MP4, or drop ` +
        "Threads from this draft's targets.",
    );
  }
  if (!video.url) {
    throw new PublishPreflightError(
      `Threads video ${video.path} has no public url. Threads fetches video_url server-side and offers no ` +
        "byte-upload path, so this video cannot be posted there at all.",
    );
  }
  if (video.durationSec !== undefined && video.durationSec > MAX_VIDEO_SEC) {
    throw new PublishPreflightError(
      `Threads video runs at most ${MAX_VIDEO_SEC}s, and ${video.path} runs ${video.durationSec}s.`,
    );
  }
  return video;
}

/**
 * Resolve the render's selected media into sendable image URLs, refusing
 * anything Threads will not take rather than dropping it.
 *
 * ⛔ Both refusals here are loud where a silent `.filter()` would not be: an
 * operator who attaches an image and gets a text-only post has no error to read
 * and no reason to look. The rule
 * every transport in this folder follows is that unsendable media is LOUD.
 *
 *   - GIF: Threads' own posts doc states "JPEG and PNG
 *     image types are the officially supported formats for image posts."
 *     ⚠️ Narrower than Instagram, which is JPEG-ONLY, and narrower than the
 *     `gif` this engine's MediaAsset type can carry. Note this is a VENDOR
 *     limit, unlike collectVideo's carousel refusal, which is a limit of THIS client.
 *   - No url: Threads fetches `image_url` server-side and has no byte-upload
 *     path at all, so an asset with nothing public to point at is unpostable
 *     here even though Bluesky/LinkedIn could send the same asset as bytes.
 */
function collectImages(media: MediaAsset[]): MediaAsset[] {
  const candidates = media.filter((m) => m.type === "image" || m.type === "gif");
  for (const asset of candidates) {
    if (asset.type === "gif") {
      throw new PublishPreflightError(
        `Threads does not accept animated GIFs (its posts doc names JPEG and PNG as the only supported image ` +
          `formats for image_url) — asset ${asset.path}. Attach a static JPEG or PNG instead, or drop Threads ` +
          `from this draft's targets so the other platforms can still go out.`,
      );
    }
    if (!asset.url) {
      throw new PublishPreflightError(
        `Threads media asset ${asset.path} has no public url. Threads fetches image_url server-side and offers ` +
          `no byte-upload path, so this asset cannot be posted there at all.`,
      );
    }
  }
  return candidates.slice(0, MAX_CAROUSEL_ITEMS);
}

/**
 * Every reply this render wants in the chain, in order.
 *
 * ⛔ `firstComment` is folded in DELIBERATELY, and dropping it is a real bug
 * the aggregator path still has. `SPECS.threads` sets BOTH `supportsThreads`
 * and `supportsFirstComment` to true (it is the only platform that does), and
 * on Threads the two are the SAME mechanism: a first comment is a reply in the
 * same chain via `reply_to_id`, not a separate comment object the way it is on
 * Instagram and Facebook. So the link comment closes the thread instead of
 * vanishing, and `sentContents()` (publish.ts) lists it last for Threads.
 */
function chainItems(render: PlatformRender): string[] {
  const items = threadReplies(render);
  if (render.firstComment) items.push(render.firstComment);
  return items;
}

/**
 * Create (and, for IMAGE/CAROUSEL, poll) whatever container shape this
 * render needs, then publish it. A video -> VIDEO (on VIDEO_POLL's longer
 * budget). Otherwise zero images -> TEXT. One image -> IMAGE.
 * Two or more -> CAROUSEL, whose children are themselves IMAGE containers
 * created with `isCarouselItem: true` and polled individually before the
 * CAROUSEL parent is created — Threads' own carousel doc requires each
 * child's container id to already exist (and be FINISHED) before it can be
 * listed in `children`.
 */
/**
 * A lone `#tag` in the copy becomes the post's `topic_tag` and leaves the text.
 *
 * Threads shows one topic per post and now prefers the parameter to an in-text
 * hashtag (publishing reference). Exactly one hashtag is lifted;
 * with none there is nothing to lift, and with two or more the text is left as
 * written rather than guessing which the operator meant. A hashtag Threads
 * would refuse as a topic (a `.` or `&` in it) stays in the text too.
 */
export function liftTopicTag(content: string): { text: string; topicTag?: string } {
  const matches = [...content.matchAll(/(^|\s)#([\p{L}\p{N}_]{1,50})(?=\s|$)/gu)];
  if (matches.length !== 1) return { text: content };
  const [m] = matches;
  // No `.`/`&` check: the tag class above admits neither, and `#ai.voice` fails the
  // `(?=\s|$)` lookahead, so such a tag never matches and stays in the text.
  const tag = m[2];
  const start = m.index! + m[1].length;
  const text = trimLineEnds(content.slice(0, start) + content.slice(start + tag.length + 1))
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return { text, topicTag: tag };
}

async function createAndPublishRoot(
  rawContent: string,
  images: MediaAsset[],
  opts: { crossShareToIgStory?: boolean; video?: MediaAsset } = {},
): Promise<string> {
  let containerId: string;
  const { text: content, topicTag } = liftTopicTag(rawContent);
  const crossShareToIgStory = opts.crossShareToIgStory ? true : undefined;
  const { video } = opts;

  if (video) {
    ({ id: containerId } = await createContainer({
      mediaType: "VIDEO",
      text: content,
      videoUrl: video.url!,
      altText: video.altText,
      topicTag,
      crossShareToIgStory,
    }));
  } else if (images.length === 0) {
    ({ id: containerId } = await createContainer({ mediaType: "TEXT", text: content, topicTag, crossShareToIgStory }));
  } else if (images.length === 1) {
    ({ id: containerId } = await createContainer({
      mediaType: "IMAGE",
      text: content,
      imageUrl: images[0].url!,
      altText: images[0].altText,
      topicTag,
      crossShareToIgStory,
    }));
  } else {
    const childIds: string[] = [];
    for (const asset of images) {
      // PER-IMAGE alt text: each carousel child is its own container, so each
      // one carries the alt for the image it actually holds. Reusing a single
      // alt across a carousel would describe the wrong picture for every slide
      // after the first.
      const child = await createContainer({
        mediaType: "IMAGE",
        imageUrl: asset.url!,
        isCarouselItem: true,
        altText: asset.altText,
      });
      await pollContainerUntilFinished(child.id);
      childIds.push(child.id);
    }
    ({ id: containerId } = await createContainer({
      mediaType: "CAROUSEL",
      text: content,
      children: childIds,
      topicTag,
      crossShareToIgStory,
    }));
  }

  if (video) await pollContainerUntilFinished(containerId, VIDEO_POLL);
  else await pollContainerUntilFinished(containerId);
  const published = await publishContainer(containerId);
  if (crossShareToIgStory) {
    // The Threads post is live either way; the Story is best-effort by the
    // vendor's own contract, so a FAILED here is a log line, never a failed leg.
    console.warn(
      `[threads] post ${published.id} cross-share to Instagram Story: ${published.crossShareToIgStatus ?? "no status returned"}`,
    );
  }
  return published.id;
}

/**
 * Post the root, then either chain the whole thread inline or defer it —
 * same two-branch shape bluesky-transport.ts's publishNow uses, for the same
 * reason (see that file's docblock): an inline chain can reference each
 * reply's own immediately-prior post because it just created it, but a
 * deferred reply is persisted before its predecessor (if any) exists, so
 * every deferred reply's initial parent is the ROOT — drainReplies
 * (publish-due.ts) is what walks it forward onto the previous reply's
 * `selfRef` once one has actually landed.
 *
 * `render.threadItems` are plain reply text, exactly like Bluesky's model:
 * Threads' `reply_to_id` container field is what turns a new TEXT container
 * into a reply in the same chain, so no separate "comment" object is ever
 * created — this is also why supportsFirstComment and supportsThreads map to
 * the identical mechanism here, unlike Instagram/Facebook's real comment API.
 */
async function publishNow(input: DirectPublishInput): Promise<DirectPublishResult> {
  const { render, media } = input;
  const video = collectVideo(media);

  // collectVideo has already refused a video mixed with anything else, so a
  // video leg has no images to collect.
  const images = video ? [] : collectImages(media);
  const rootId = await createAndPublishRoot(render.content, images, {
    crossShareToIgStory: render.threadsCrossShareToIgStory,
    video,
  });
  const url = await resolvePermalink(rootId);

  const items = chainItems(render);
  if (!items.length) {
    return { ref: rootId, url };
  }

  const delayMinutes = render.followupDelayMinutes ?? 0;
  if (delayMinutes <= 0) {
    // ⛔ NOTHING THROWS OUT OF HERE ONCE THE ROOT IS LIVE, for the reason
    // bluesky-transport.ts gives: a throw re-sends the whole publishNow, root
    // included. A failed reply (or first comment, which rides this chain) ends
    // the chain and comes back as a warning.
    let parentId = rootId;
    const replyRefs: string[] = [];
    for (const [i, text] of items.entries()) {
      try {
        const container = await createContainer({ mediaType: "TEXT", text, replyToId: parentId });
        await pollContainerUntilFinished(container.id);
        const published = await publishContainer(container.id);
        parentId = published.id;
        replyRefs.push(published.id);
      } catch (err) {
        const reason = getErrorMessage(err);
        console.warn(`[threads] thread reply ${i + 1} failed on published post ${rootId}, leaving the post live: ${reason}`);
        return {
          ref: rootId,
          url,
          replyRefs,
          warnings: [
            `thread stopped at reply ${i + 1} of ${items.length}; that reply and any after it were not sent, the post and earlier replies are live: ${reason}`,
          ],
        };
      }
    }
    return { ref: rootId, url, replyRefs };
  }

  const rootRecord = { id: rootId };
  const now = Date.now();
  const queued: DirectQueuedReply[] = items.map((text, i) => ({
    position: i + 1,
    text,
    dueAt: new Date(now + (i + 1) * delayMinutes * 60_000).toISOString(),
    parent: rootRecord,
  }));

  return { ref: rootId, url, threadRoot: rootRecord, queued };
}

/**
 * Release one deferred thread reply. Called by publish-due once `dueAt` has
 * passed. `reply.parent` is either the root's handle (the first release) or
 * the previous reply's `selfRef`, decided by drainReplies — this function
 * just trusts whatever id it is given.
 */
async function publishReply(
  reply: DirectQueuedReply,
  root: Record<string, string>,
): Promise<DirectPublishResult> {
  const parentId = reply.parent?.id ?? root.id;
  if (!parentId) {
    throw new Error(
      `threads: reply/root is missing an "id" handle (root=${JSON.stringify(root)}, reply.parent=${JSON.stringify(reply.parent)})`,
    );
  }
  const container = await createContainer({ mediaType: "TEXT", text: reply.text, replyToId: parentId });
  await pollContainerUntilFinished(container.id);
  const published = await publishContainer(container.id);
  const url = await resolvePermalink(published.id);
  // selfRef is what lets drainReplies hang the NEXT reply off THIS one.
  // Without it every deferred reply can only ever target the root, which
  // Threads would render as a fan of siblings rather than the thread the
  // operator wrote — the exact bug the Bluesky exemplar shipped once and this
  // file exists partly to not repeat.
  return { ref: published.id, url, selfRef: { id: published.id } };
}

function isThreadsErr(err: unknown): err is ThreadsError {
  return err instanceof ThreadsError;
}

/**
 * One GET per ref (see this file's POST_FACTS_CONCURRENCY comment), chunked
 * for concurrency. Same rule every transport in this folder follows:
 *
 *   A transport reports what it OBSERVED. ERROR is a permanent verdict the
 *   CALLER owns, not something a lookup failure gets to hand down.
 *
 * That holds even for a CONFIRMED 404 — see pinterest-transport.ts's
 * postFacts docblock for the full reasoning (reconcile-verdict.ts's one-hour
 * grace period lives on the caller's side of this boundary, and a transport
 * that answers ERROR anyway has quietly overridden a policy it cannot see).
 * A network failure or an ambiguous response both fall through to the exact
 * same QUEUE outcome as a confirmed-absent id; only the log line
 * distinguishes them, for whoever is watching.
 */
async function postFacts(refs: string[]): Promise<Map<string, DirectPostFacts>> {
  const out = new Map<string, DirectPostFacts>();
  for (let i = 0; i < refs.length; i += POST_FACTS_CONCURRENCY) {
    const batch = refs.slice(i, i + POST_FACTS_CONCURRENCY);
    await Promise.all(
      batch.map(async (ref) => {
        try {
          await getPermalink(ref);
          out.set(ref, { state: "PUBLISHED", released: true, platform: "threads" });
        } catch (err) {
          if (isThreadsNotFound(err)) {
            // ⚠️ Not flagged `absent` (see DirectPostFacts.absent):
            // isThreadsNotFound is an unverified heuristic over wording, not a
            // vendor-documented response, so it is not the definitive answer
            // that flag exists for. Revisit once a real 404 body is captured.
            console.warn(`[threads] post ${ref} is confirmed absent; reporting QUEUE, not ERROR`);
            out.set(ref, { state: "QUEUE", released: false, platform: "threads" });
            return;
          }
          const reason = isThreadsErr(err) ? err.message : String(err);
          console.warn(`[threads] postFacts lookup failed for ${ref}: ${reason}`);
          out.set(ref, { state: "QUEUE", released: false, platform: "threads" });
        }
      }),
    );
  }
  return out;
}

/**
 * Deletion is a REAL, supported Threads API operation (added 2025-03-06 per
 * the vendor's own changelog — see threads.ts's deleteThread docblock), so
 * unlike a platform that genuinely lacks a delete endpoint, this never needs
 * to fake success or throw a "not supported" error. An already-gone post is
 * treated as SUCCESS (idempotent), same business decision every other
 * transport in this folder makes, via the same heuristic isThreadsNotFound
 * documents the honesty caveat for.
 */
async function deletePost(ref: string): Promise<void> {
  try {
    await deleteThread(ref);
  } catch (err) {
    if (isThreadsNotFound(err)) return; // idempotent: already gone is success
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/*  Analytics                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Keys are the vendor's own metric names (`views`, `likes`, `replies`,
 * `reposts`, `quotes`), passed through unrenamed. Renaming them here would
 * invent a cross-platform vocabulary that does not exist — AnalyticsTab's
 * header warns specifically against treating one vendor's metric as another's.
 */
async function analyticsPost(ref: string): Promise<Record<string, number>> {
  return getMediaInsights(ref);
}

async function analyticsChannel(): Promise<Record<string, number>> {
  return getUserInsights();
}

/**
 * ⚠️ Throws when `followers_count` is absent rather than reporting 0 — the
 * metric can be missing because the token lacks the permission, and a
 * fabricated zero on a follower chart reads as an account that lost everyone.
 */
async function followerStats(): Promise<{ followers: number }> {
  const insights = await getUserInsights();
  const followers = insights.followers_count;
  if (typeof followers !== "number") {
    throw new ThreadsError(
      "threads_insights returned no followers_count (is the metric permitted for this token?)",
      0,
      null,
      null,
      null,
      null,
    );
  }
  return { followers };
}

export const threadsTransport: DirectTransport = {
  platform: "threads",
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
