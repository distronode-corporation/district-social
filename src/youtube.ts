/**
 * YouTube Data API v3 vendor client, plus the YouTube Analytics API (reports
 * v2) at the bottom of the file, which shares this file's token and request.
 *
 * Plays the same role for this platform that pinterest.ts and x.ts play for
 * theirs: every raw call to googleapis.com lives here, and nothing above this
 * file touches fetch directly. Two things distinguish this vendor from the
 * others already migrated:
 *
 *   - Service accounts are NOT supported by the YouTube Data API (Google's own
 *     docs state the API does not support the service-account OAuth flow), so
 *     there is no ADC path here at all — auth is exclusively an OAuth refresh
 *     token belonging to a human account that manages the channel, exchanged
 *     for a bearer access token app-side and handed in via
 *     setYouTubeTokenResolver, exactly like Pinterest's resolver.
 *   - Uploading a video is not a single POST. `insertVideo` below implements
 *     Google's "resumable upload" protocol: a POST to open a session (which
 *     returns a session URL in a `Location` header, no body), followed by a
 *     PUT of the actual bytes to that URL. This client sends the WHOLE file
 *     in that one PUT rather than chunking — see insertVideo's own docblock
 *     for exactly what that does and does not cover.
 *   - `googleapis` (already a repo dependency) was deliberately NOT used here.
 *     It would auto-manage the resumable exchange, but every sibling
 *     transport in this migration (pinterest.ts, x.ts, linkedin.ts,
 *     threads.ts, bluesky.ts) hand-rolls fetch against the vendor's REST
 *     surface directly, and this file follows that convention rather than
 *     introducing a second, harder-to-test HTTP path (mocking `googleapis`'s
 *     internal gaxios/resumable-upload machinery in a unit test is
 *     materially harder than mocking global `fetch`, which every existing
 *     test file in this folder already does). `googleapis`'s own generated
 *     type for a media upload body is `body?: any` (v3.d.ts,
 *     Params$Resource$Videos$Insert) besides, so it would not even have been
 *     the more strictly-typed option.
 *
 * Every numeric/behavioural fact below is marked PROVEN (with the exact
 * developers.google.com page it was checked against) or ASSUMED
 * (could not be confirmed on an official page). Nothing here is carried over
 * from training data without that check — see the docblocks on insertVideo,
 * getVideos and the module-level constants for the specifics.
 *
 * Engine rules apply: relative imports only.
 */

import { retryAfterHeader } from "./retry.js";
import { vendorFetch, vendorText, type VendorFetchOptions } from "./vendor-fetch.js";

/**
 * YouTube refuses `<` and `>` in a title or description: snippet.title and
 * snippet.description "may contain all valid UTF-8 characters except < and >"
 * (developers.google.com/youtube/v3/docs/videos). The refusal
 * comes from videos.insert, i.e. only after the video bytes were sent.
 *
 * Swapped for the single guillemets rather than stripped, so "5 < 10" keeps
 * its meaning. Each costs 3 UTF-8 bytes instead of 1, so a caller truncating
 * to the byte cap must sanitize FIRST. Every upload path (the direct transport
 * and the Zernio leg) runs its title and description through here.
 */
export function youtubeSafeText(text: string): string {
  return text.replace(/</g, "\u2039").replace(/>/g, "\u203A");
}

/** Description cap is in BYTES, not characters. PROVEN, developers.google.com/youtube/v3/docs/videos (snippet.description). */
export const YOUTUBE_DESCRIPTION_MAX_BYTES = 5000;

/** UTF-8-byte-safe truncation: trims whole Unicode code points, never splitting one, until the encoded byte length fits. */
function truncateUtf8Bytes(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).byteLength <= maxBytes) return text;
  const codePoints = Array.from(text);
  while (codePoints.length > 0 && encoder.encode(codePoints.join("")).byteLength > maxBytes) {
    codePoints.pop();
  }
  return codePoints.join("");
}

/**
 * The description exactly as it may be sent: sanitized, THEN cut to the byte
 * cap, because each swapped bracket costs 3 bytes instead of 1 and QA measures
 * the text before the swap. Shared by both upload paths (the direct transport
 * and the Zernio leg), so neither can send a description the other would cut.
 */
export function youtubeDescription(text: string): string {
  return truncateUtf8Bytes(youtubeSafeText(text), YOUTUBE_DESCRIPTION_MAX_BYTES);
}

const API_BASE = "https://www.googleapis.com/youtube/v3";
const UPLOAD_BASE = "https://www.googleapis.com/upload/youtube/v3/videos";

/** Plain JSON calls (list/delete/channels) — same figure as every other vendor client's short path. */
const REQUEST_TIMEOUT_MS = 15_000;
/** Opening a resumable session sends only a small JSON body, so it gets the short timeout too. */
const INIT_UPLOAD_TIMEOUT_MS = 15_000;
/**
 * The byte PUT can be carrying up to hundreds of MB. NOT a vendor-documented
 * figure (Google's guide describes the protocol, not a client-side timeout
 * budget) — 10 minutes is this client's own engineering choice, sized well
 * above what a marketing-length video should need even on a slow link, the
 * same way pinterest.ts's CREATE_PIN_TIMEOUT_MS is a local choice rather than
 * a vendor number.
 */
const UPLOAD_TIMEOUT_MS = 600_000;

export class YouTubeError extends Error {
  constructor(
    public status: number,
    public body: string,
    method: string,
    path: string,
    /** Raw `Retry-After`, verbatim. retry.ts owns the grammar; see RetryAfterCarrier. */
    public retryAfter: string | null = null,
  ) {
    super(`YouTube ${method} ${path} -> ${status}: ${body.slice(0, 500)}`);
  }
}

/**
 * True when the vendor gave a definitive "this id does not exist" answer.
 *
 * Only wired to videos.delete's response today (see deleteVideo below), whose
 * `notFound (404) videoNotFound` error is unambiguous per the official Errors
 * table — PROVEN, developers.google.com/youtube/v3/docs/videos/delete
 * ("The video that you are trying to delete cannot be found. Check the value
 * of the request's `id` parameter to ensure that it is correct."). Do NOT
 * reuse this to decide `absent` for a videos.list lookup — see getVideos's
 * docblock for why that case is different and deliberately left ambiguous.
 */
export function isYouTubeNotFound(err: unknown): boolean {
  return err instanceof YouTubeError && err.status === 404;
}

export type YouTubeTokenResolver = () => Promise<string>;

let _resolver: YouTubeTokenResolver | null = null;

/**
 * Register (or clear, with null) the resolver that supplies a bearer access
 * token.
 *
 * INJECTED rather than imported, exactly like setPinterestTokenResolver: this
 * folder is the portable engine and cannot reach the secret store or whatever
 * app-side module owns the channel's OAuth refresh-token exchange. Called
 * FRESH on every request rather than memoised in this file. There is no
 * cache here at all, on purpose: the app-side resolver this gets wired to is
 * expected to own its own caching AND the refresh-token exchange's expiry
 * check (the same division of responsibility pinterest.ts's docblock
 * describes for its own resolver), so a second cache here would risk serving
 * a token this file believes is still good for minutes after the app-side
 * store has already rotated it — a service-account-free OAuth flow like
 * YouTube's has no ADC layer to silently paper over a stale token, so a
 * duplicated cache is pure downside with no offsetting benefit.
 */
export function setYouTubeTokenResolver(resolver: YouTubeTokenResolver | null): void {
  _resolver = resolver;
}

async function token(): Promise<string> {
  if (!_resolver) {
    throw new YouTubeError(
      0,
      "no YouTube token resolver registered (call setYouTubeTokenResolver)",
      "GET",
      "(resolver)",
    );
  }
  const t = await _resolver();
  if (!t) {
    throw new YouTubeError(0, "YouTube token resolver returned an empty token", "GET", "(resolver)");
  }
  return t;
}

/** vendorFetch's wrap for this client: the method and path ride the error. */
function wrapAs(method: string, path: string): (status: 0, message: string) => YouTubeError {
  return (status, message) => new YouTubeError(status, message, method, path);
}

async function request<T>(
  method: string,
  path: string,
  opts: { timeoutMs?: number; base?: string } = {},
): Promise<T> {
  const accessToken = await token();
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const resOpts: VendorFetchOptions = { timeoutMs, wrap: wrapAs(method, path) };
  const res = await vendorFetch(
    `${opts.base ?? API_BASE}${path}`,
    { method, headers: { Authorization: `Bearer ${accessToken}` } },
    resOpts,
  );
  // DELETE returns 204 with no body on success — nothing to parse.
  if (res.status === 204) return undefined as T;
  const text = await vendorText(res, resOpts);
  if (!res.ok) throw new YouTubeError(res.status, text, method, path, retryAfterHeader(res));
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new YouTubeError(res.status, `expected JSON, got: ${text.slice(0, 200)}`, method, path);
  }
}

function withQuery(path: string, params: Record<string, string | undefined>): string {
  const entries = Object.entries(params).filter((e): e is [string, string] => e[1] !== undefined);
  // No empty-entries case: every caller passes at least one defined param (part or id).
  return `${path}?${new URLSearchParams(entries).toString()}`;
}

/**
 * PROVEN — the discovery document's `schemas.VideoStatus.properties.privacyStatus.enum`
 * (googleapis.com/discovery/v1/apis/youtube/v3/rest), matching
 * developers.google.com/youtube/v3/docs/videos/insert's own
 * "privacyStatus" parameter description ("Valid values are: private, public, unlisted.").
 */
export type YouTubePrivacyStatus = "public" | "unlisted" | "private";

export interface YouTubeVideoMetadata {
  /** Max 100 characters — PROVEN, developers.google.com/youtube/v3/docs/videos (snippet.title). */
  title: string;
  /** Max 5000 BYTES, not characters — PROVEN, same page (snippet.description). */
  description?: string;
  /**
   * Combined max 500 characters across the whole array, counting the
   * separating commas and (for any tag containing a space) a pair of
   * quotation marks — PROVEN, same page (snippet.tags).
   */
  tags?: string[];
  categoryId: string;
  privacyStatus: YouTubePrivacyStatus;
}

export interface YouTubeUploadInput extends YouTubeVideoMetadata {
  videoBytes: Uint8Array<ArrayBuffer>;
  /** Vendor accepts `video/*` and `application/octet-stream` — PROVEN, discovery doc's mediaUpload.accept. */
  mimeType: string;
}

export interface YouTubeVideo {
  id: string;
  title?: string;
  privacyStatus?: YouTubePrivacyStatus;
}

interface VideoResource {
  id: string;
  snippet?: { title?: string; description?: string; tags?: string[]; categoryId?: string };
  status?: { privacyStatus?: string };
}

function toVideo(r: VideoResource): YouTubeVideo {
  const privacy = r.status?.privacyStatus;
  return {
    id: r.id,
    title: r.snippet?.title,
    privacyStatus:
      privacy === "public" || privacy === "unlisted" || privacy === "private" ? privacy : undefined,
  };
}

/**
 * Resumable upload: POST to open a session, then ONE PUT carrying the whole
 * file. PROVEN against
 * developers.google.com/youtube/v3/guides/using_resumable_upload_protocol's
 * "upload the entire file in a single request" flow:
 *
 *   1. `POST {UPLOAD_BASE}?uploadType=resumable&part=snippet,status`, body =
 *      the video resource's snippet/status JSON, headers carry
 *      `Content-Type: application/json; charset=UTF-8`,
 *      `X-Upload-Content-Length` (the video's byte length) and
 *      `X-Upload-Content-Type` (its mime type). A successful response is
 *      `200 OK` with NO body and a `Location` header naming the session URL.
 *   2. `PUT <Location>`, headers carry `Content-Type` (the video's mime
 *      type) and the binary body. The guide's single-request flow states
 *      `Content-Range` is not required here — that header belongs to the
 *      chunked/resume case this client does not implement (below). A
 *      successful response is `201 Created` with the created Video resource
 *      as its JSON body.
 *
 * ⚠️ NOT a full resumable-upload client. `X-Upload-Content-Length` +
 * `X-Upload-Content-Type` and the whole-file PUT are exactly what the
 * single-request flow calls for, but the CHUNKED path (splitting the PUT into
 * `Content-Range`-addressed pieces and resuming from wherever a `308 Resume
 * Incomplete` response's `Range` header says to) is not built. A network
 * interruption mid-upload fails this call outright instead of resuming from
 * where it left off. Given this transport's use case — operator-approved
 * marketing/product video, not unattended multi-GB uploads over a flaky
 * link — that tradeoff is deliberate rather than an oversight; a `308` is
 * treated as a hard failure below rather than silently reported as success.
 */
export async function insertVideo(input: YouTubeUploadInput): Promise<YouTubeVideo> {
  const accessToken = await token();

  const metadata = {
    snippet: {
      title: input.title,
      ...(input.description ? { description: input.description } : {}),
      ...(input.tags?.length ? { tags: input.tags } : {}),
      categoryId: input.categoryId,
    },
    status: {
      privacyStatus: input.privacyStatus,
    },
  };

  const initResOpts: VendorFetchOptions = { timeoutMs: INIT_UPLOAD_TIMEOUT_MS, wrap: wrapAs("POST", "/upload/videos (init)") };
  const initRes = await vendorFetch(
    `${UPLOAD_BASE}?uploadType=resumable&part=snippet,status`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Length": String(input.videoBytes.byteLength),
        "X-Upload-Content-Type": input.mimeType,
      },
      body: JSON.stringify(metadata),
    },
    initResOpts,
  );
  if (!initRes.ok) {
    const text = await vendorText(initRes, initResOpts);
    throw new YouTubeError(initRes.status, text, "POST", "/upload/videos (init)");
  }
  const uploadUrl = initRes.headers.get("location");
  if (!uploadUrl) {
    throw new YouTubeError(
      initRes.status,
      "resumable session response carried no Location header",
      "POST",
      "/upload/videos (init)",
    );
  }

  const uploadResOpts: VendorFetchOptions = { timeoutMs: UPLOAD_TIMEOUT_MS, wrap: wrapAs("PUT", "/upload/videos (bytes)") };
  const uploadRes = await vendorFetch(
    uploadUrl,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": input.mimeType,
      },
      body: input.videoBytes,
    },
    uploadResOpts,
  );
  if (uploadRes.status === 308) {
    // "Resume Incomplete" — only a chunked client can recover from this by
    // reading the Range header and PUTting the rest. This client cannot, so
    // failing loudly is safer than silently reporting success for a video
    // that is not actually fully uploaded.
    throw new YouTubeError(
      308,
      "upload was left incomplete (308 Resume Incomplete) and this client does not implement chunked resume",
      "PUT",
      "/upload/videos (bytes)",
    );
  }
  const text = await vendorText(uploadRes, uploadResOpts);
  if (!uploadRes.ok) {
    throw new YouTubeError(uploadRes.status, text, "PUT", "/upload/videos (bytes)");
  }
  if (!text) {
    throw new YouTubeError(
      uploadRes.status,
      "upload succeeded but the response carried no video resource body",
      "PUT",
      "/upload/videos (bytes)",
    );
  }
  let parsed: VideoResource;
  try {
    parsed = JSON.parse(text) as VideoResource;
  } catch {
    throw new YouTubeError(uploadRes.status, `expected JSON, got: ${text.slice(0, 200)}`, "PUT", "/upload/videos (bytes)");
  }
  return toVideo(parsed);
}

/**
 * GET /videos?part=id&id=<comma-separated>. Batched by the caller
 * (youtube-transport.ts's postFacts) — see that file's BATCH_LOOKUP_LIMIT
 * docblock for the id-count cap, which is NOT vendor-confirmed. `part=id`
 * only: callers of this function need nothing but existence today.
 *
 * ⚠️ What comes back for an id this call cannot find is AMBIGUOUS from
 * official docs when the `id` list mixes valid and invalid ids — see
 * youtube-transport.ts's postFacts docblock, which is where that ambiguity
 * actually matters (it decides whether `absent` may be set). This function
 * itself stays a thin passthrough either way: it returns whatever `items`
 * the vendor sent, and does not try to detect or paper over a partial
 * result.
 */
export async function getVideos(ids: string[]): Promise<YouTubeVideo[]> {
  if (!ids.length) return [];
  const res = await request<{ items: VideoResource[] }>("GET", withQuery("/videos", { part: "id", id: ids.join(",") }));
  return (res.items ?? []).map(toVideo);
}

/**
 * GET /videos?part=statistics — public counters for videos we own.
 *
 * Separate from getVideos rather than widening its `part`: that function is on
 * the reconcile path and runs against every outstanding leg, where asking for
 * data nobody reads costs quota on every sweep. YouTube bills per part, so
 * `part` is a cost decision, not a convenience.
 *
 * ⚠️ Every value in `statistics` arrives as a STRING (the API returns unsigned
 * longs as JSON strings to survive 2^53), so each is parsed here. A field the
 * vendor omits — `likeCount` disappears when a channel hides likes — is left
 * OUT of the result rather than defaulted to 0, because a real zero and a
 * hidden counter must not look the same on a dashboard.
 */
export interface YouTubeVideoStats {
  id: string;
  views?: number;
  likes?: number;
  comments?: number;
}

function toCount(raw: unknown): number | undefined {
  if (typeof raw !== "string" && typeof raw !== "number") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

export async function getVideoStats(ids: string[]): Promise<YouTubeVideoStats[]> {
  if (!ids.length) return [];
  const res = await request<{
    items: Array<{ id: string; statistics?: Record<string, unknown> }>;
  }>("GET", withQuery("/videos", { part: "statistics", id: ids.join(",") }));
  return (res.items ?? []).map((item) => {
    const st = item.statistics ?? {};
    const out: YouTubeVideoStats = { id: item.id };
    const views = toCount(st.viewCount);
    const likes = toCount(st.likeCount);
    const comments = toCount(st.commentCount);
    if (views !== undefined) out.views = views;
    if (likes !== undefined) out.likes = likes;
    if (comments !== undefined) out.comments = comments;
    return out;
  });
}

/** GET /channels?part=statistics&mine=true — subscriber/view/video counters. */
export interface YouTubeChannelStats {
  subscribers?: number;
  views?: number;
  videos?: number;
}

export async function getMyChannelStats(): Promise<YouTubeChannelStats> {
  const res = await request<{ items: Array<{ statistics?: Record<string, unknown> }> }>(
    "GET",
    withQuery("/channels", { part: "statistics", mine: "true" }),
  );
  const st = res.items?.[0]?.statistics;
  if (!st) {
    throw new YouTubeError(0, "no channel found for this credential (mine=true returned zero items)", "GET", "/channels");
  }
  const out: YouTubeChannelStats = {};
  // ⚠️ hiddenSubscriberCount makes subscriberCount absent OR zero depending on
  // the channel; an absent value stays absent rather than becoming a real 0.
  const subs = toCount(st.subscriberCount);
  const views = toCount(st.viewCount);
  const videos = toCount(st.videoCount);
  if (subs !== undefined) out.subscribers = subs;
  if (views !== undefined) out.views = views;
  if (videos !== undefined) out.videos = videos;
  return out;
}

/**
 * DELETE /videos?id=... -> 204. Per the vendor's own Errors table this can
 * also answer a 404 videoNotFound for an id that no longer exists (PROVEN —
 * see isYouTubeNotFound's docblock); this function stays a thin passthrough
 * (throws either way) so the "idempotent, already-gone-is-success" business
 * decision belongs to the transport, exactly like pinterest.ts's deletePin.
 */
export async function deleteVideo(id: string): Promise<void> {
  await request<void>("DELETE", withQuery("/videos", { id }));
}

export interface YouTubeChannel {
  id: string;
  title: string;
}

/**
 * GET /channels?part=snippet&mine=true. PROVEN as the documented way to
 * resolve "the channel belonging to the currently authenticated user" —
 * developers.google.com/youtube/v3/docs/channels/list's `mine` parameter:
 * "Set this parameter's value to true to instruct the API to only return
 * channels owned by the authenticated user." Used only for connectStatus().
 */
export async function getMyChannel(): Promise<YouTubeChannel> {
  const res = await request<{ items: Array<{ id: string; snippet?: { title?: string } }> }>(
    "GET",
    withQuery("/channels", { part: "snippet", mine: "true" }),
  );
  const channel = res.items?.[0];
  if (!channel) {
    throw new YouTubeError(0, "no channel found for this credential (mine=true returned zero items)", "GET", "/channels");
  }
  return { id: channel.id, title: channel.snippet?.title ?? "" };
}

/* -------------------------------------------------------------------------- */
/*  YouTube Analytics API (reports v2)                                         */
/* -------------------------------------------------------------------------- */

/**
 * youtubeanalytics.googleapis.com, a DIFFERENT API from the Data API above,
 * reached with the SAME bearer token (setYouTubeTokenResolver). There is no
 * second token flow: the refresh token simply has to carry a scope the
 * Analytics API accepts.
 *
 * Query shape, VERIFIED against developers.google.com/youtube/analytics
 * (reference/reports/query and channel_reports) and proven live against a
 * real channel:
 *   GET /v2/reports?ids=channel==MINE&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 *       &metrics=a,b,c[&filters=video==<id>]
 * No `dimensions`, so the answer is ONE row of totals for the whole window,
 * in the order of `columnHeaders`.
 */
const ANALYTICS_BASE = "https://youtubeanalytics.googleapis.com/v2";

/**
 * ⛔ ONE INVALID METRIC FAILS THE WHOLE QUERY, exactly like Meta's insights
 * (proven live: `metrics=views,bogusMetric` answered 400 "Unknown
 * identifier (bogusMetric) given in field parameters.metrics."). So both lists
 * are exported and pinned in tests. Every name is from the "Basic stats" video
 * report on channel_reports (core and additional metrics), the report that
 * allows both no filter and `filters=video==<id>`, and each list as written
 * was proven as one live call.
 *
 * Per video: only the numbers the Data API CANNOT give. views, likes and
 * comments stay with getVideoStats, which is real time, whereas this API lags
 * two to three days; asking for them here would put two different figures
 * under one key (see youtube-transport.ts's analyticsPost).
 */
export const YT_VIDEO_ANALYTICS_METRICS = [
  "estimatedMinutesWatched",
  "averageViewDuration",
  "averageViewPercentage",
  "subscribersGained",
  "subscribersLost",
  "shares",
] as const;

/**
 * Channel, over a fixed trailing window. views, likes and comments ARE asked
 * for here: over a window they are a different number from the Data API's
 * lifetime channel counters, and the transport keys them apart.
 */
export const YT_CHANNEL_ANALYTICS_METRICS = [
  "views",
  "estimatedMinutesWatched",
  "averageViewDuration",
  "averageViewPercentage",
  "subscribersGained",
  "subscribersLost",
  "likes",
  "shares",
  "comments",
] as const;

/**
 * 28 days, the default window in YouTube Studio, so the dashboard and Studio
 * can be compared directly. A local choice, not a vendor limit.
 */
export const YT_CHANNEL_WINDOW_DAYS = 28;

/**
 * "Data processing typically introduces a latency of 48 to 72 hours"
 * (developers.google.com/youtube/analytics/data_model). The channel window
 * therefore ENDS three days back, so all 28 of its days are processed ones and
 * its totals are not short by an unprocessed tail.
 */
export const YT_ANALYTICS_LAG_DAYS = 3;

/**
 * Lifetime start for a per-video total: the day YouTube was founded, so no
 * video predates it (accepted by the API, proven live). The
 * per-video END is today: the API answers an unprocessed or future endDate
 * with whatever is processed (a window wholly in the future came back 200 with
 * `rows: []`, proven live), so ending today means "everything processed
 * so far" without guessing the lag.
 */
export const YT_ANALYTICS_LIFETIME_START = "2005-02-14";

const DAY_MS = 86_400_000;

/**
 * YYYY-MM-DD in UTC. YouTube's reporting days are Pacific, so a UTC date can
 * be one day ahead of YouTube's; that only ever touches the unprocessed tail.
 */
function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

interface AnalyticsReport {
  columnHeaders?: Array<{ name?: string; columnType?: string }>;
  rows?: unknown[][];
}

/**
 * columnHeaders plus the first row, as a bag keyed by YouTube's metric names.
 *
 * ⚠️ No row means no data, NOT zero: a brand-new video (or one the API has not
 * processed yet) comes back with `rows: []` (proven live) or with no `rows` at
 * all (the documented form), and both read as an EMPTY bag. Showing 0 minutes
 * watched for a video uploaded an hour ago would be a lie.
 */
function toReportBag(report: AnalyticsReport | undefined): Record<string, number> {
  const row = report?.rows?.[0];
  if (!row) return {};
  const out: Record<string, number> = {};
  (report.columnHeaders ?? []).forEach((header, i) => {
    if (header.columnType !== "METRIC" || !header.name) return;
    const value = toCount(row[i]);
    if (value !== undefined) out[header.name] = value;
  });
  return out;
}

/**
 * The vendor's answer to a token without an Analytics scope, proven live with
 * a token downscoped to youtube.upload: 403, reason
 * `insufficientPermissions`, ErrorInfo reason `ACCESS_TOKEN_SCOPE_INSUFFICIENT`.
 * (A token downscoped to plain `youtube` was ACCEPTED, so only tokens without
 * either scope hit this.)
 */
function isScopeRefusal(err: YouTubeError): boolean {
  return (
    err.status === 403 &&
    (err.body.includes("ACCESS_TOKEN_SCOPE_INSUFFICIENT") || err.body.includes("insufficientPermissions"))
  );
}

async function analyticsReport(params: {
  metrics: readonly string[];
  startDate: string;
  endDate: string;
  filters?: string;
}): Promise<Record<string, number>> {
  const path = withQuery("/reports", {
    ids: "channel==MINE",
    startDate: params.startDate,
    endDate: params.endDate,
    metrics: params.metrics.join(","),
    filters: params.filters,
  });
  try {
    return toReportBag(await request<AnalyticsReport | undefined>("GET", path, { base: ANALYTICS_BASE }));
  } catch (err) {
    // Only the scope refusal is rewritten. Any other 403 (the API disabled on
    // the client's project, say) keeps the vendor's own body.
    if (err instanceof YouTubeError && isScopeRefusal(err)) {
      throw new YouTubeError(
        403,
        "the YouTube token lacks an Analytics scope (ACCESS_TOKEN_SCOPE_INSUFFICIENT); re-consent " +
          "YOUTUBE_REFRESH_TOKEN with https://www.googleapis.com/auth/yt-analytics.readonly",
        "GET",
        "/reports",
      );
    }
    throw err;
  }
}

/** Lifetime Analytics totals for one of our videos (YT_VIDEO_ANALYTICS_METRICS). */
export async function getVideoAnalytics(videoId: string, now: Date = new Date()): Promise<Record<string, number>> {
  return analyticsReport({
    metrics: YT_VIDEO_ANALYTICS_METRICS,
    startDate: YT_ANALYTICS_LIFETIME_START,
    endDate: isoDay(now),
    filters: `video==${videoId}`,
  });
}

/**
 * Channel Analytics totals (YT_CHANNEL_ANALYTICS_METRICS) over the trailing
 * YT_CHANNEL_WINDOW_DAYS, ending YT_ANALYTICS_LAG_DAYS back. Both dates are
 * inclusive, so the window is exactly 28 days.
 */
export async function getChannelAnalytics(now: Date = new Date()): Promise<Record<string, number>> {
  const end = new Date(now.getTime() - YT_ANALYTICS_LAG_DAYS * DAY_MS);
  const start = new Date(end.getTime() - (YT_CHANNEL_WINDOW_DAYS - 1) * DAY_MS);
  return analyticsReport({
    metrics: YT_CHANNEL_ANALYTICS_METRICS,
    startDate: isoDay(start),
    endDate: isoDay(end),
  });
}
