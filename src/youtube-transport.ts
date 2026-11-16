/**
 * YouTube's DirectTransport — mirrors pinterest-transport.ts's split: what an
 * upload/delete/lookup MEANS on this platform lives here; everything about
 * *talking* to YouTube lives in youtube.ts.
 *
 * ⚠️ The thing to be careful about in this file is the opposite of every
 * other transport shipped so far: every other platform's publishNow refuses
 * or downgrades VIDEO (Pinterest, X, Instagram, LinkedIn all lack a working
 * video-upload path today and reject one loudly). YouTube is the one
 * platform where video is the ONLY acceptable payload — a render carrying
 * just images has nothing this transport can post, and uploading nothing
 * silently would be far worse than refusing. See assertHasVideo below.
 *
 * Engine rules apply: relative imports only.
 */

import {
  getChannelAnalytics,
  getMyChannelStats,
  getVideoAnalytics,
  getVideoStats,
  YT_CHANNEL_WINDOW_DAYS,
  YouTubeError,
  deleteVideo,
  getMyChannel,
  getVideos,
  insertVideo,
  isYouTubeNotFound,
  YOUTUBE_DESCRIPTION_MAX_BYTES,
  youtubeDescription,
  youtubeSafeText,
} from "./youtube.js";
import { PublishPreflightError } from "./publish.js";
import { defaults } from "./settings.js";
import type {
  DirectConnectStatus,
  DirectPostFacts,
  DirectPublishInput,
  DirectPublishResult,
  DirectTransport,
  TransportChannelRules,
} from "./transport.js";
import type { PlatformRender } from "./types.js";
import { getErrorMessage } from "./error-message.js";
import { fetchMediaBytes } from "./media-fetch.js";

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** Title cap — PROVEN, developers.google.com/youtube/v3/docs/videos (snippet.title). */
const TITLE_MAX_CHARS = 100;
/** Combined tags-array cap, counting separators — PROVEN, same page (snippet.tags). See fitTagsBudget. */
const TAGS_MAX_COMBINED_CHARS = 500;

/**
 * NOT vendor-confirmed from an official page. Every fetch against
 * developers.google.com's videos.list reference and the shared Errors table
 * came back without a stated maximum for the `id` parameter's item count
 * (only `maxResults`, a DIFFERENT parameter the docs explicitly say is not
 * even used alongside `id`, states a number). 50 is the figure widely
 * reported by third-party YouTube API guides and matches the batch limit
 * every other Google list-by-id method of this shape (channels.list,
 * playlistItems.list) is known to use, so it is used here defensively rather
 * than asserted as a confirmed vendor fact.
 */
const BATCH_LOOKUP_LIMIT = 50;

/**
 * Fetching the operator's already-hosted video asset before re-uploading it to
 * YouTube. Given much larger payloads than the 20s the shared media fetch
 * defaults to (media-fetch.ts), this video fetch passes its own, longer
 * figure, a local engineering choice rather than a vendor number.
 */
const VIDEO_FETCH_TIMEOUT_MS = 120_000;

/**
 * Real vendor limits, verified against developers.google.com: see youtube.ts's
 * module docblock and this function's inline comments for exact
 * PROVEN/ASSUMED status per figure.
 *
 * qa.ts sources the "video-too-long"/"video-too-large" ceilings from the
 * ROUTED transport's channelRules() (via its `fittingRules` map) and falls
 * back to SPECS only for a platform that is not routed anywhere. So these
 * numbers are production-read: changing one changes what QA refuses. The same
 * is true of pinterest-transport.ts and x-transport.ts.
 *
 * ⚠️ media-fit.ts cannot re-encode video (its `canFit` excludes video), so an
 * over-limit video is a hard QA failure rather than something the publish path
 * fixes. These are gates, not budgets.
 */
function channelRules(): TransportChannelRules {
  return {
    // 5000 BYTES, not characters: PROVEN (see YOUTUBE_DESCRIPTION_MAX_BYTES),
    // and DECLARED as bytes.
    //
    // NOT `countMode: "utf16"`. The NUMBER is 5000 either way, and for ASCII
    // copy the two counts are identical, so the difference is invisible until
    // non-ASCII copy diverges: an accented character costs 2 bytes and an
    // emoji up to 4, so a description could pass a UTF-16 gate at 5000
    // characters and be silently cut by youtubeDescription.
    maxLength: YOUTUBE_DESCRIPTION_MAX_BYTES,
    countMode: "utf8bytes",
    // This platform's post payload is a video, not a set of images — nothing
    // in publishNow ever sends an image, so maxImages/maxImageBytes/
    // imageFormats are left undeclared rather than invented.
    // 274,877,906,944 bytes (256 GiB) — PROVEN, the YouTube v3 discovery
    // document's videos.insert `mediaUpload.maxSize`
    // (googleapis.com/discovery/v1/apis/youtube/v3/rest: "274877906944"),
    // matching the "Maximum file size: 256GB" prose on
    // developers.google.com/youtube/v3/docs/videos/insert.
    maxVideoBytes: 256 * GB,
    // 900s (15 minutes) — PROVEN as the UNVERIFIED-account ceiling via
    // support.google.com/youtube/answer/71673. A VERIFIED channel can go up
    // to 12h (43200s) or 256GB, whichever is less — same page — but this
    // function is a static, synchronous declaration with no account context
    // (the same constraint every other transport's channelRules() has), so
    // it cannot know a given channel's verification status. It declares the
    // conservative (unverified) bound rather than the permissive one: a
    // false PASS here would silently ship an over-length video to a
    // not-actually-verified channel and let it fail at the vendor with a
    // much less specific error, while a false FAIL on a verified channel is
    // at least visible and correctable (bump this constant once that
    // channel's status is confirmed).
    maxVideoSec: 900,
  };
}

async function connectStatus(): Promise<DirectConnectStatus> {
  try {
    const channel = await getMyChannel();
    return { connected: true, accountId: channel.id, displayName: channel.title };
  } catch (err) {
    // A transport that cannot report status must not throw: publish.ts's
    // directConnectedAccounts() treats the whole platform as unreachable and
    // moves on to the other platforms, but only if this resolves rather than
    // rejects.
    return {
      connected: false,
      accountId: "",
      displayName: "",
      reason: getErrorMessage(err),
    };
  }
}

/**
 * Standard YouTube watch URL. NOT a field the vendor returns — the Video
 * resource has no permalink/url property (discovery doc) — so this is
 * convention, same honesty caveat pinterest-transport.ts's and
 * x-transport.ts's own postUrl apply to their constructed permalinks.
 */
function postUrl(id: string): string {
  return `https://www.youtube.com/watch?v=${id}`;
}

/** Character-count truncation (title's cap is chars, not bytes), code-point aware so it cannot split a surrogate pair. */
function truncateChars(text: string, maxChars: number): string {
  const codePoints = Array.from(text);
  return codePoints.length <= maxChars ? text : codePoints.slice(0, maxChars).join("");
}

/**
 * PlatformRender has no first-class "tags" field (types.ts) — the render's
 * only carrier for tag-shaped content today is the hashtags playbook.ts
 * leaves inline in the description (`#word`; specs.ts's youtube notes: "2-3
 * in the description"). YouTube's `tags` metadata field is DISTINCT from
 * those inline description hashtags (specs.ts: "Tags field (separate from
 * hashtags)") — it is an invisible keyword list, never shown to a viewer —
 * so harvesting the same words into both places is additive, not a
 * duplication of visible content: the hashtags stay in the description text
 * untouched, and the same words also become searchable metadata.
 *
 * This is a deliberate INTERPRETATION of "send real tags if the render
 * carries them", not a vendor fact. `render.platformSpecificData` (a
 * free-form escape hatch, types.ts) is checked FIRST for an explicit
 * `tags: string[]`, in case a future caller ever populates one directly;
 * failing that, tags are derived from the description's own hashtags.
 */
function deriveTags(render: PlatformRender): string[] {
  const explicit = render.platformSpecificData?.tags;
  if (Array.isArray(explicit) && explicit.every((t): t is string => typeof t === "string")) {
    return explicit.map((t) => t.trim()).filter(Boolean);
  }
  const matches = render.content.match(/(^|\s)#([\p{L}\p{N}_]+)/gu) ?? [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const m of matches) {
    const tag = m.replace(/^\s*#/, "");
    const key = tag.toLowerCase();
    if (tag && !seen.has(key)) {
      seen.add(key);
      tags.push(tag);
    }
  }
  return tags;
}

/**
 * Fits as many tags as possible under the vendor's combined 500-char budget,
 * using its EXACT counting rule rather than a flat join-length check — PROVEN,
 * developers.google.com/youtube/v3/docs/videos (snippet.tags): "commas
 * between items in the list count toward the limit... If a tag contains a
 * space, the API server handles the tag value as though it were wrapped in
 * quotation marks, and the quotation marks count toward the character
 * limit."
 */
function fitTagsBudget(tags: string[], maxChars: number): string[] {
  const out: string[] = [];
  let used = 0;
  for (const tag of tags) {
    const quoted = tag.includes(" ");
    const cost = tag.length + (quoted ? 2 : 0) + (out.length > 0 ? 1 : 0);
    if (used + cost > maxChars) break;
    used += cost;
    out.push(tag);
  }
  return out;
}

/**
 * Upload the render's video. Title/description/tags/categoryId/privacyStatus
 * all travel on every call — see the module docblock for why refusing an
 * image-only render is this file's central job.
 *
 * `categoryId` and `privacyStatus` are read from settings.ts's `defaults()`
 * directly (`youtubeCategoryId`, `youtubeVisibility`) rather than from
 * `destination`: unlike Pinterest's board or Reddit's subreddit, neither
 * value is part of `publishDestination()`'s youtube case (publish.ts, which
 * returns only `{ title }` for this platform), so there is no existing
 * pass-through for them.
 */
async function publishNow(input: DirectPublishInput): Promise<DirectPublishResult> {
  const { render, media, destination } = input;

  const video = media.find((m) => m.type === "video");
  if (!video) {
    // ⛔ The one refusal this whole transport exists to add. YouTube's
    // videos.insert has no image-post equivalent — silently uploading
    // nothing would be worse than a clear, loud refusal. A
    // PublishPreflightError (not a plain Error): publish.ts's per-leg loop
    // around transport.publishNow() isolates one platform's failure from
    // the others, so refusing here, BEFORE any network call, is what keeps
    // the rest of a multi-platform publish going.
    throw new PublishPreflightError(
      "YouTube needs a video (a render carrying only images/gifs has nothing this transport can post — " +
        "videos.insert has no image-post equivalent). Attach a video to this draft's YouTube render, or drop " +
        "YouTube from the targets, so the other platforms in this publish can still go out.",
    );
  }
  if (!video.url) {
    throw new PublishPreflightError(
      "youtube: the attached video has no fetchable URL (a library asset without a public URL cannot be uploaded here).",
    );
  }

  const def = defaults();
  // Sanitized BEFORE truncating: the replacement is 3 bytes per bracket, and
  // the cap has to hold for what is actually sent.
  const title = truncateChars(youtubeSafeText(render.title ?? destination.title ?? render.content), TITLE_MAX_CHARS);
  const description = youtubeDescription(render.content);
  const tags = fitTagsBudget(deriveTags(render), TAGS_MAX_COMBINED_CHARS);

  const videoBytes = await fetchMediaBytes("youtube", video.url, { timeoutMs: VIDEO_FETCH_TIMEOUT_MS });
  const created = await insertVideo({
    title,
    description,
    tags,
    categoryId: def.youtubeCategoryId,
    privacyStatus: def.youtubeVisibility,
    videoBytes,
    mimeType: video.mimeType,
  });

  return { ref: created.id, url: postUrl(created.id) };
}

/**
 * A video whose deletion already happened (an earlier partial failure, a
 * manual removal in YouTube Studio) reads as a definitive 404 videoNotFound
 * from the vendor (PROVEN — see youtube.ts's isYouTubeNotFound docblock).
 * Recognising that as SUCCESS rather than an error is the whole point of this
 * migration.
 */
async function deletePost(ref: string): Promise<void> {
  try {
    await deleteVideo(ref);
  } catch (err) {
    if (isYouTubeNotFound(err)) return; // idempotent: already gone is success
    throw err;
  }
}

/** A vendor error, timeout, or rate limit says nothing about whether a video exists. */
function isYouTubeError(err: unknown): err is YouTubeError {
  return err instanceof YouTubeError;
}

/**
 * Chunked GET /videos?part=id&id=... at BATCH_LOOKUP_LIMIT (youtube.ts's
 * getVideos).
 *
 * ⚠️ NEVER sets `absent: true` — unlike pinterest-transport.ts's single-id
 * 404 or x-transport.ts's per-ref `resource-not-found` error type, this
 * vendor's behaviour for a MISSING id inside a multi-id `id=` list is
 * AMBIGUOUS from official docs. The videos.list reference page (and the
 * errors reference it shares) DOES list `notFound (404) videoNotFound` —
 * "The video that you are trying to retrieve cannot be found" — as an
 * applicable error for this method, but that is the exact same wording used
 * for the single-id case, and no page says what happens when the `id` list
 * mixes valid and invalid ids. Every other Google list-by-id endpoint of
 * this shape (channels.list, playlistItems.list) is well known to silently
 * OMIT ids it cannot resolve rather than error the whole batch, and nothing
 * official confirms videos.list departs from that for a multi-id request —
 * this was checked and could not be resolved either way (see this file's
 * getVideos import / youtube.ts's own docblock on the same question).
 * Given that ambiguity, a missing id is treated the same way
 * bluesky-transport.ts treats its own vendor's silent omission: QUEUE, no
 * `absent` flag. `state` still never becomes ERROR regardless — see
 * pinterest-transport.ts's postFacts docblock for why that verdict always
 * belongs to the caller, not this function.
 */
async function postFacts(refs: string[]): Promise<Map<string, DirectPostFacts>> {
  const out = new Map<string, DirectPostFacts>();
  for (let i = 0; i < refs.length; i += BATCH_LOOKUP_LIMIT) {
    const batch = refs.slice(i, i + BATCH_LOOKUP_LIMIT);
    try {
      const found = await getVideos(batch);
      const foundIds = new Set(found.map((v) => v.id));
      for (const ref of batch) {
        out.set(
          ref,
          foundIds.has(ref)
            ? { state: "PUBLISHED", released: true, platform: "youtube" }
            : { state: "QUEUE", released: false, platform: "youtube" },
        );
      }
    } catch (err) {
      // ⚠️ Never ERROR from a lookup failure — that marks a live video dead.
      const reason = isYouTubeError(err) ? err.message : String(err);
      console.warn(`[youtube] postFacts lookup failed for a batch of ${batch.length}: ${reason}`);
      for (const ref of batch) out.set(ref, { state: "QUEUE", released: false, platform: "youtube" });
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Analytics                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * ⚠️ Keys are YOUTUBE's own, deliberately not a shared vocabulary. A "view" on
 * YouTube is a watched video; on Bluesky there is no such number at all.
 * Summing incompatible metrics into one series across platforms is the shape
 * to avoid, so these must be rendered per platform.
 *
 * A counter the vendor omits (likes hidden by the channel, subscribers hidden
 * by the owner) is LEFT OUT rather than defaulted to zero — see getVideoStats.
 *
 * Two YouTube APIs feed each bag: the Data API's public counters (real time,
 * lifetime) and the Analytics API's reports (watch time, retention,
 * subscribers gained; lagging two to three days). ⚠️ They overlap on views,
 * likes and comments, and the two figures differ, so a key never has two
 * sources:
 *   - per video, both are lifetime, so the overlap is simply not asked of the
 *     Analytics API (YT_VIDEO_ANALYTICS_METRICS) and the real-time Data API
 *     figure is the one reported;
 *   - per channel, the Analytics figures cover a 28-day window, a different
 *     number from the lifetime counters, so EVERY Analytics key carries the
 *     window as a suffix (`views_28d`, `estimatedMinutesWatched_28d`) and the
 *     unsuffixed Data API keys keep their meaning.
 */
const CHANNEL_WINDOW_SUFFIX = `_${YT_CHANNEL_WINDOW_DAYS}d`;

/**
 * ⚠️ The two APIs are settled independently, the same rule the analytics route
 * applies across platforms: an Analytics failure (a token without
 * yt-analytics.readonly, such as a token consented before that scope was
 * requested)
 * must not discard the Data API counters, nor the reverse. A partial answer is
 * returned as the part that worked and the failure goes to the log, which is
 * where this interface's other partial results (postFacts) report theirs;
 * Record<string, number> has nowhere to carry a reason. Only when BOTH fail
 * does this throw, naming both, so the route shows a reason instead of a blank.
 */
function mergeHalves(
  what: string,
  data: PromiseSettledResult<Record<string, number>>,
  analytics: PromiseSettledResult<Record<string, number>>,
): Record<string, number> {
  const out: Record<string, number> = {};
  const failures: string[] = [];
  if (data.status === "fulfilled") Object.assign(out, data.value);
  else failures.push(`Data API: ${getErrorMessage(data.reason)}`);
  if (analytics.status === "fulfilled") Object.assign(out, analytics.value);
  else failures.push(`Analytics API: ${getErrorMessage(analytics.reason)}`);
  if (failures.length === 2) throw new Error(`youtube ${what}: ${failures.join(" / ")}`);
  if (failures.length) console.warn(`[youtube] ${what} is partial, returning the half that answered. ${failures[0]}`);
  return out;
}

async function videoCounters(ref: string): Promise<Record<string, number>> {
  const [stats] = await getVideoStats([ref]);
  if (!stats) return {};
  const out: Record<string, number> = {};
  if (stats.views !== undefined) out.views = stats.views;
  if (stats.likes !== undefined) out.likes = stats.likes;
  if (stats.comments !== undefined) out.comments = stats.comments;
  return out;
}

async function channelCounters(): Promise<Record<string, number>> {
  const stats = await getMyChannelStats();
  const out: Record<string, number> = {};
  if (stats.subscribers !== undefined) out.subscribers = stats.subscribers;
  if (stats.views !== undefined) out.views = stats.views;
  if (stats.videos !== undefined) out.videos = stats.videos;
  return out;
}

async function channelWindowMetrics(): Promise<Record<string, number>> {
  const metrics = await getChannelAnalytics();
  return Object.fromEntries(Object.entries(metrics).map(([key, value]) => [`${key}${CHANNEL_WINDOW_SUFFIX}`, value]));
}

async function analyticsPost(ref: string): Promise<Record<string, number>> {
  const [data, analytics] = await Promise.allSettled([videoCounters(ref), getVideoAnalytics(ref)]);
  return mergeHalves(`analytics for video ${ref}`, data, analytics);
}

async function analyticsChannel(): Promise<Record<string, number>> {
  const [data, analytics] = await Promise.allSettled([channelCounters(), channelWindowMetrics()]);
  return mergeHalves("channel analytics", data, analytics);
}

/**
 * ⚠️ Throws when the channel hides its subscriber count, rather than reporting
 * 0. `followerStats` has no way to express "unknown", and a fabricated zero on
 * a subscriber chart reads as a channel that lost everyone.
 */
async function followerStats(): Promise<{ followers: number }> {
  const stats = await getMyChannelStats();
  if (stats.subscribers === undefined) {
    throw new YouTubeError(0, "channel statistics carried no subscriberCount (hidden by the owner?)", "GET", "/channels");
  }
  return { followers: stats.subscribers };
}

export const youtubeTransport: DirectTransport = {
  platform: "youtube",
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
