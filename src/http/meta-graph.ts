import { createHmac } from "node:crypto";

import { graphTime, type RecentPostsPage } from "../recent-posts.js";
import { retryAfterHeader } from "./retry.js";
import { vendorFetch, vendorText, type VendorFetchOptions } from "./vendor-fetch.js";

/**
 * The shared Meta Graph client behind the P3 trio (Facebook Page, Instagram,
 * Threads). One module because all three speak the same dialect: the same error
 * envelope, the same token-in-query convention, the same `appsecret_proof`
 * requirement. The per-platform behaviour lives in the transports.
 *
 * Engine rules apply: relative imports only. The
 * app injects credentials through `setMetaCredentialsResolver`, the same shape
 * as `setPinterestTokenResolver`.
 *
 * ⛔ THE API VERSION IS PINNED HERE, ON PURPOSE.
 *
 * The App Dashboard has an "Upgrade all calls" setting that silently rewrites
 * requests made WITHOUT a version in the path. That means an unversioned call
 * changes behaviour when somebody clicks a dropdown in a browser, with no deploy
 * and no diff. Every request this module makes names its version explicitly, so
 * the only way to move it is to edit this constant.
 */

/** Matches the dashboard's current setting. Bump deliberately, never implicitly. */
export const META_GRAPH_VERSION = "v26.0";

const GRAPH_HOST = "https://graph.facebook.com";

/** Matches linkedin.ts and x.ts. See the note at the fetch call in graphRequest. */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Operator-owned credentials. Meta is the one provider in this system with NO
 * browser consent step at publish time: the tokens are minted once by the
 * operator and kept in the secret store, so there is nothing to refresh on the
 * publish path.
 */
export interface MetaCredentials {
  /** The app secret, for `appsecret_proof`. Never sent as a parameter itself. */
  appSecret: string;
  /** Long-lived Page access token. Page tokens derived from a never-expiring
   *  user token do not expire, which is why there is no refresh path here. */
  pageToken: string;
  /** The Facebook Page this app publishes to. */
  pageId: string;
  /** IG Business account linked to that Page. Absent until Instagram is wired. */
  igUserId?: string;
}

export type MetaCredentialsResolver = () => Promise<MetaCredentials>;

let _resolver: MetaCredentialsResolver | null = null;

/**
 * Injected by the app layer, because this folder cannot read the secret store
 * (relative imports only). Identical reasoning to setPinterestTokenResolver.
 */
export function setMetaCredentialsResolver(resolver: MetaCredentialsResolver | null): void {
  _resolver = resolver;
}

export async function metaCredentials(): Promise<MetaCredentials> {
  if (!_resolver) {
    throw new Error("no Meta credentials resolver registered (call setMetaCredentialsResolver)");
  }
  return _resolver();
}

/**
 * `appsecret_proof` = HMAC-SHA256(access_token, app_secret), hex.
 *
 * ⚠️ SENT ON EVERY CALL, UNCONDITIONALLY, even though the app's "Require app
 * secret" toggle is currently OFF.
 *
 * Meta accepts the parameter whether or not the toggle demands it, so sending it
 * always costs nothing and removes a live ordering hazard: with a conditional
 * implementation, flipping that toggle in the dashboard would break publishing
 * at the next post, from a change with no deploy and no diff to point at. This
 * way the toggle is free to flip at any time, in either direction.
 *
 * Do not "optimise" this into a conditional.
 */
export function appsecretProof(accessToken: string, appSecret: string): string {
  return createHmac("sha256", appSecret).update(accessToken).digest("hex");
}

/**
 * A Meta API error, carrying enough of the envelope to decide what to do next.
 *
 * `code` and `subcode` are the parts worth branching on. The message is for
 * humans and Meta rewords it freely, so never match on it.
 */
/**
 * Meta error codes meaning "we refused", split out from the transient ones so a
 * create can be retried on these and only these.
 *
 *   4  API_TOO_MANY_CALLS       (app-level rate limit)
 *  17  API_USER_TOO_MANY_CALLS  (user-level rate limit)
 *  32  page-level rate limit
 * 613  custom-level rate limit
 *
 * Exported because ThreadsError (threads.ts) is the same Graph-family
 * infrastructure and answers the same three questions off the same lists: one
 * definition of each list, two error classes reading them.
 */
export const RATE_LIMIT_CODES = [4, 17, 32, 613];

/**
 * "Something went wrong, try again" — the call MAY have been performed.
 *
 *   1  API_UNKNOWN   — Meta's own "try again"
 *   2  API_SERVICE   — transient service failure
 */
export const TRANSIENT_CODES = [1, 2];

/**
 * The token is dead or lost its grant, so nothing in the publish path can fix
 * it: these are operator-minted tokens renewed only by a human.
 *
 * 190  access token invalid or expired
 * 102  session expired
 *  10  permission denied
 * 200  permission error
 */
export const NEEDS_REAUTH_CODES = [190, 102, 10, 200];

export class MetaGraphError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: number | null,
    readonly subcode: number | null,
    readonly type: string | null,
    readonly traceId: string | null,
    /**
     * Raw `Retry-After`, verbatim. retry.ts owns the grammar; see
     * RetryAfterCarrier.
     *
     * ⚠️ Graph usually signals its rate limits through `X-App-Usage` /
     * `X-Business-Use-Case-Usage` percentages rather than this header, so it is
     * frequently null on a perfectly real code-4 rate limit. Null is not
     * evidence the limit is soft: it just means the jittered backoff applies,
     * which is the same behaviour as for any other retryable failure.
     */
    readonly retryAfter: string | null = null,
  ) {
    super(message);
    this.name = "MetaGraphError";
  }

  /**
   * True when the same call could plausibly succeed later.
   *
   * Deliberately narrow. `postFacts` must answer QUEUE rather than ERROR for
   * anything transient (see the warning on DirectPostFacts), and the cost of
   * being wrong in the two directions is asymmetric: a retryable error wrongly
   * called terminal marks a LIVE post dead, while a terminal error wrongly
   * called retryable just gets retried and fails again visibly.
   *
   *   1  API_UNKNOWN      — Meta's own "try again"
   *   2  API_SERVICE      — transient service failure
   *   4  API_TOO_MANY_CALLS   (app-level rate limit)
   *  17  API_USER_TOO_MANY_CALLS (user-level rate limit)
   *  32  page-level rate limit
   * 613  custom-level rate limit
   */
  get retryable(): boolean {
    if (this.status >= 500) return true;
    return this.code !== null && [...RATE_LIMIT_CODES, ...TRANSIENT_CODES].includes(this.code);
  }

  /**
   * The stricter half of `retryable`: Meta REFUSED to perform the call.
   *
   * ⛔ The distinction is what makes retrying a CREATE safe. A rate limit means
   * nothing happened, so re-sending cannot duplicate a post. API_UNKNOWN (1)
   * and API_SERVICE (2) mean the opposite — the call may well have landed and
   * only the answer was lost — so a create must NOT be repeated on those. See
   * retry.ts's header.
   *
   * Meta signals rate limits by CODE in the body rather than an HTTP 429, so
   * status alone cannot detect them.
   */
  get rateLimited(): boolean {
    return this.code !== null && RATE_LIMIT_CODES.includes(this.code);
  }

  /**
   * True when the token is dead or lost its grant. Distinct from retryable
   * because it needs a HUMAN at a consent screen, not a retry: these tokens are
   * operator-minted and nothing in the publish path can renew them.
   */
  get needsReauth(): boolean {
    return this.code !== null && NEEDS_REAUTH_CODES.includes(this.code);
  }
}

/**
 * The Graph-family error envelope every Meta endpoint answers a failure with.
 * Exported because threads.ts decodes the identical envelope for Threads, the
 * same Graph infrastructure behind a different host.
 */
export interface GraphErrorEnvelope {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    fbtrace_id?: string;
  };
}

/**
 * One Graph request, with the proof attached and the error envelope decoded.
 *
 * Params are sent as a form body for writes and as a query string for reads,
 * which is what Meta's own examples do and, more importantly, keeps long values
 * (captions, image URLs) off the request line where proxies truncate them.
 */
export async function graphRequest<T>(
  path: string,
  options: {
    method?: "GET" | "POST" | "DELETE";
    params?: Record<string, string | number | boolean | undefined>;
    accessToken: string;
    appSecret: string;
  },
): Promise<T> {
  const { method = "GET", params = {}, accessToken, appSecret } = options;

  const fields = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) fields.set(key, String(value));
  }
  fields.set("access_token", accessToken);
  fields.set("appsecret_proof", appsecretProof(accessToken, appSecret));

  const base = `${GRAPH_HOST}/${META_GRAPH_VERSION}/${path.replace(/^\/+/, "")}`;
  const url = method === "GET" ? `${base}?${fields.toString()}` : base;

  const responseOpts: VendorFetchOptions = {
    // ⛔ EVERY VENDOR CLIENT IN THE ENGINE BOUNDS ITS REQUESTS, GRAPH TOO.
    // Without a timeout a stalled connection to graph.facebook.com hangs the
    // caller indefinitely rather than failing. That is worst on the WRITE
    // path: a publish that hangs after Meta has already accepted the create
    // leaves a live post on the Page with no id returned, so nothing
    // downstream can find it to delete or reconcile: the post exists and its
    // ref is unknown.
    //
    // 15s matches linkedin.ts and x.ts. Deliberately NOT longer: this client
    // never sends bytes (Instagram and Facebook both publish by handing Meta
    // a public `image_url` and letting Meta fetch it), so no request here is
    // large. Pinterest's 120s ceiling exists precisely because it posts
    // base64 in the body; nothing on this path does.
    timeoutMs: REQUEST_TIMEOUT_MS,
    // MetaGraphError carries no method or path, so the timeout names them.
    // vendor-fetch.ts owns the wording and the status-0 wrap, so a
    // non-timeout network failure does not escape here as a raw TypeError.
    label: `Meta ${method} ${path}`,
    wrap: (status, message) => new MetaGraphError(message, status, null, null, null, null),
  };
  const response = await vendorFetch(
    url,
    {
      method,
      ...(method === "GET"
        ? {}
        : {
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: fields.toString(),
          }),
    },
    responseOpts,
  );

  const text = await vendorText(response, responseOpts);
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    // A non-JSON body from Graph means an edge/proxy answered, not the API.
    // Surface it as a status-shaped error so `retryable` can still classify it.
    throw new MetaGraphError(
      `Meta returned a non-JSON response (${response.status}): ${text.slice(0, 200)}`,
      response.status,
      null,
      null,
      null,
      null,
    );
  }

  const envelope = parsed as GraphErrorEnvelope;
  if (!response.ok || envelope.error) {
    const err = envelope.error ?? {};
    throw new MetaGraphError(
      err.message ?? `Meta request failed with HTTP ${response.status}`,
      response.status,
      typeof err.code === "number" ? err.code : null,
      typeof err.error_subcode === "number" ? err.error_subcode : null,
      err.type ?? null,
      err.fbtrace_id ?? null,
      retryAfterHeader(response),
    );
  }

  return parsed as T;
}

/* -------------------------------------------------------------------------- */
/*  rupload (Facebook Page Reels)                                              */
/* -------------------------------------------------------------------------- */

const RUPLOAD_HOST = "https://rupload.facebook.com";

/**
 * Longer than REQUEST_TIMEOUT_MS on purpose: this is the one call in the module
 * that moves video, because Meta fetches `file_url` while the request is open.
 * Same ceiling and same reasoning as pinterest.ts's body-carrying upload.
 */
export const RUPLOAD_TIMEOUT_MS = 120_000;

interface RuploadResponse {
  success?: boolean;
  message?: string;
  debug_info?: { retriable?: boolean; type?: string; message?: string };
  error?: GraphErrorEnvelope["error"];
}

/**
 * Hand Meta a PUBLIC video URL for an open Page Reels upload session.
 *
 * VERIFIED against the Reels Publishing API guide (developers.facebook.com/
 * documentation/video-api/guides/reels-publishing): `POST
 * https://rupload.facebook.com/video-upload/{version}/{video-id}` with the
 * headers `Authorization: OAuth <page token>` and `file_url: <url>`, answering
 * `{"success": true}`. Meta rejects fbcdn URLs and anything robots.txt keeps
 * from `facebookexternalhit`; a public media store bucket is neither.
 *
 * ⚠️ NOT `graphRequest`. rupload is a different host that authenticates by
 * header rather than by `access_token` parameter, and its failure body is
 * `{debug_info: {type, message}}` rather than the Graph error envelope, so both
 * shapes are decoded here into the same MetaGraphError.
 *
 * ⚠️ `appsecret_proof` rides the query string UNCONDITIONALLY, for the reason
 * appsecretProof's docblock gives. UNVERIFIED for this host: Meta's rupload
 * examples never show the parameter, and nothing documents whether rupload
 * honours or ignores it. The first live Reel settles that; if rupload refuses
 * it, the fix is here and nowhere else.
 */
export async function ruploadHostedVideo(
  videoId: string,
  fileUrl: string,
  options: { accessToken: string; appSecret: string },
): Promise<void> {
  const { accessToken, appSecret } = options;
  const proof = new URLSearchParams({ appsecret_proof: appsecretProof(accessToken, appSecret) });
  const url = `${RUPLOAD_HOST}/video-upload/${META_GRAPH_VERSION}/${encodeURIComponent(videoId)}?${proof.toString()}`;

  const responseOpts: VendorFetchOptions = {
    timeoutMs: RUPLOAD_TIMEOUT_MS,
    label: `Meta Reels upload for video ${videoId}`,
    wrap: (status, message) => new MetaGraphError(message, status, null, null, null, null),
  };
  const response = await vendorFetch(
    url,
    { method: "POST", headers: { authorization: `OAuth ${accessToken}`, file_url: fileUrl } },
    responseOpts,
  );

  const text = await vendorText(response, responseOpts);
  let parsed: RuploadResponse;
  try {
    parsed = text ? (JSON.parse(text) as RuploadResponse) : {};
  } catch {
    throw new MetaGraphError(
      `Meta's Reels upload returned a non-JSON response (${response.status}): ${text.slice(0, 200)}`,
      response.status,
      null,
      null,
      null,
      null,
    );
  }

  if (response.ok && parsed.success === true) return;

  const err = parsed.error ?? {};
  throw new MetaGraphError(
    err.message ??
      parsed.debug_info?.message ??
      parsed.message ??
      `Meta's Reels upload for video ${videoId} failed with HTTP ${response.status}`,
    response.status,
    typeof err.code === "number" ? err.code : null,
    typeof err.error_subcode === "number" ? err.error_subcode : null,
    err.type ?? parsed.debug_info?.type ?? null,
    err.fbtrace_id ?? null,
    retryAfterHeader(response),
  );
}

/* -------------------------------------------------------------------------- */
/*  Insights                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One row of any Meta insights response (Instagram, Facebook Pages, Threads).
 *
 * ⚠️ TWO SHAPES, and both are real. Meta reports "Total Value" metrics as
 * `total_value: { value }` and time-series metrics as `values: [{ value }]`.
 * The docs for a given endpoint usually show only one of them, so parsing the
 * documented shape alone silently returns nothing for the other — and on a
 * dashboard "no data" is indistinguishable from genuine zero engagement, which
 * makes a parser bug read as a quiet account. Verified on the Threads endpoints
 * first (see threads.ts); the same envelope is used across the family.
 */
export interface MetaInsightRow {
  name?: string;
  values?: Array<{ value?: unknown }>;
  total_value?: { value?: unknown };
}

function insightValue(row: MetaInsightRow): number | undefined {
  const raw = row.total_value?.value ?? row.values?.[0]?.value;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

/**
 * Rows -> `{ metric: number }`, keeping the VENDOR's own metric names.
 *
 * A row that cannot be parsed is ABSENT, never 0. A vendor-reported zero IS
 * kept, because that is a real datum — conflating "we could not read it" with
 * "it is zero" is the failure this whole family of code is careful about.
 * Renaming keys is likewise avoided: it would invent a cross-platform
 * vocabulary that does not exist, and one vendor's `reach` is not another's.
 */
export function toMetricBag(rows: MetaInsightRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    if (!row.name) continue;
    const value = insightValue(row);
    if (value !== undefined) out[row.name] = value;
  }
  return out;
}

/**
 * ⛔ META ERRORS THE WHOLE CALL ON ONE BAD METRIC — there is no partial result.
 * So every metric list below is a liability: one name that a future Graph
 * version drops takes the entire platform's analytics down, not just that
 * counter. That is not hypothetical. `impressions` was deprecated in v22.0 and
 * now returns an ERROR for media created after 2024-07-02 (Meta changelog,
 * 2025-01-21), and it is still the metric the public insights example shows,
 * so copying the documented sample into a v26.0 client (the version pinned
 * here) would break every Instagram request rather than dropping a field.
 *
 * Metric lists are therefore exported and asserted in tests, so a bump that
 * needs them changed fails somewhere cheap instead of in production.
 */
export async function fetchInsights(
  path: string,
  params: Record<string, string | number | undefined>,
  creds: { pageToken: string; appSecret: string },
): Promise<Record<string, number>> {
  const data = await graphRequest<{ data?: MetaInsightRow[] }>(path, {
    params,
    accessToken: creds.pageToken,
    appSecret: creds.appSecret,
  });
  return toMetricBag(data.data ?? []);
}

/**
 * Instagram media insights.
 *
 * VERIFIED against developers.facebook.com/documentation/instagram-platform
 * (/reference/instagram-media/insights and /changelog).
 *
 * ⛔ `impressions` is deliberately ABSENT. It is the metric the public example
 * still shows, and on v22.0+ it returns an error for media created after
 * 2024-07-02, which, because Meta fails the whole call, would take every
 * other counter here down with it. `views` is its documented replacement.
 */
export const IG_MEDIA_METRICS = [
  "reach",
  "likes",
  "comments",
  "shares",
  "saved",
  "total_interactions",
  "views",
] as const;

export async function getInstagramMediaInsights(mediaId: string): Promise<Record<string, number>> {
  const creds = await metaCredentials();
  return fetchInsights(`${mediaId}/insights`, { metric: IG_MEDIA_METRICS.join(",") }, creds);
}

/**
 * Instagram account insights.
 *
 * `metric_type=total_value` is required for these: without it Meta returns the
 * time-series form and several of them error outright. `period=day` is the
 * window the vendor supports for all of the below.
 */
const IG_USER_METRICS = ["reach", "views", "profile_views", "accounts_engaged"] as const;

export async function getInstagramUserInsights(): Promise<Record<string, number>> {
  const creds = await metaCredentials();
  if (!creds.igUserId) {
    throw new Error("instagram: no Instagram business account is linked (MetaCredentials.igUserId is unset)");
  }
  return fetchInsights(
    `${creds.igUserId}/insights`,
    { metric: IG_USER_METRICS.join(","), period: "day", metric_type: "total_value" },
    creds,
  );
}

/**
 * Follower count for the linked IG Business account.
 *
 * Read as a FIELD on the user node, not as an insight. `followers_count` is a
 * plain field; the insights edge exposes `follower_count` (singular, a daily
 * delta) which is a different number entirely, and reporting a day's net change
 * as the audience size would be badly wrong rather than merely imprecise.
 *
 * THROWS when the field is missing rather than answering 0 — it can be absent
 * because the token lacks permission, and a fabricated zero reads as an account
 * that lost everyone.
 */
export async function getInstagramFollowers(): Promise<{ followers: number }> {
  const creds = await metaCredentials();
  if (!creds.igUserId) {
    throw new Error("instagram: no Instagram business account is linked (MetaCredentials.igUserId is unset)");
  }
  const data = await graphRequest<{ followers_count?: unknown }>(creds.igUserId, {
    params: { fields: "followers_count" },
    accessToken: creds.pageToken,
    appSecret: creds.appSecret,
  });
  const raw = data.followers_count;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new Error(
      "instagram: followers_count missing from the Graph response — the token likely lacks " +
        "instagram_basic/instagram_manage_insights. Refusing to report 0, which would read as a lost audience.",
    );
  }
  return { followers: raw };
}

/**
 * Facebook Page POST insights.
 *
 * Page-post metrics keep the `post_` prefix and are a different namespace from
 * Instagram's. They are not interchangeable and are deliberately not renamed to
 * look alike.
 *
 * ⛔ Pages retired impressions for VIEWS, on every API version: Meta's
 * deprecated-metrics page lists `post_impressions_unique` (2025-06-15) and
 * `post_impressions` (2025-11-15), and `post_engaged_users` is gone from the
 * v26.0 reference. Asked together they fail the whole call ("must be a valid
 * insights metric", verified live), leaving no Facebook numbers at all.
 * `post_media_view` and `post_total_media_view_unique` are the
 * documented replacements; this exact list was verified live as one call.
 *
 * `post_reactions_by_type_total` is excluded: it returns a per-reaction object
 * rather than a scalar, so it cannot fit Record<string, number> without
 * inventing a flattening this layer has no business choosing.
 */
export const FB_POST_METRICS = [
  "post_media_view",
  "post_total_media_view_unique",
  "post_clicks",
] as const;

export async function getFacebookPostInsights(postId: string): Promise<Record<string, number>> {
  const creds = await metaCredentials();
  return fetchInsights(`${postId}/insights`, { metric: FB_POST_METRICS.join(",") }, creds);
}

/**
 * Facebook Page insights. `period=day` is required; Meta rejects the call
 * without one rather than picking a default. `page_impressions` and
 * `page_impressions_unique` were retired for `page_media_view` and
 * `page_total_media_view_unique` (same deprecation as the post metrics above;
 * this list verified live as one call).
 */
export const FB_PAGE_METRICS = ["page_media_view", "page_total_media_view_unique", "page_post_engagements"] as const;

export async function getFacebookPageInsights(): Promise<Record<string, number>> {
  const creds = await metaCredentials();
  return fetchInsights(`${creds.pageId}/insights`, { metric: FB_PAGE_METRICS.join(","), period: "day" }, creds);
}

/**
 * Page follower count.
 *
 * `followers_count` and `fan_count` are DIFFERENT numbers — fans are Page
 * likes, followers are follows, and the two diverged once Facebook let people
 * follow without liking. Followers is the one that matches what every other
 * platform in this engine calls a follower, so that is what is read; falling
 * back to fan_count would silently answer a different question.
 *
 * THROWS rather than reporting 0, for the same reason as Instagram's.
 */
export async function getFacebookFollowers(): Promise<{ followers: number }> {
  const creds = await metaCredentials();
  const data = await graphRequest<{ followers_count?: unknown }>(creds.pageId, {
    params: { fields: "followers_count" },
    accessToken: creds.pageToken,
    appSecret: creds.appSecret,
  });
  const raw = data.followers_count;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new Error(
      "facebook: followers_count missing from the Graph response — the token likely lacks " +
        "pages_read_engagement/read_insights. Refusing to report 0, which would read as a lost audience.",
    );
  }
  return { followers: raw };
}

/* -------------------------------------------------------------------------- */
/*  Recent posts (the agent publish's crash check)                             */
/* -------------------------------------------------------------------------- */

/** How many of the newest posts one crash-check read asks for. */
export const RECENT_POSTS_LIMIT = 25;

interface GraphList<T> {
  data?: T[];
  paging?: { next?: string };
}

interface GraphPostRow {
  id?: string;
  message?: string;
  description?: string;
  caption?: string;
  created_time?: string;
  timestamp?: string;
  permalink_url?: string;
  permalink?: string;
}

function recentPage(res: GraphList<GraphPostRow>, idOf: (id: string) => string): RecentPostsPage {
  const posts = (res.data ?? []).flatMap((r) =>
    typeof r.id === "string" && r.id
      ? [
          {
            id: idOf(r.id),
            texts: [r.message, r.description, r.caption].filter((t): t is string => typeof t === "string"),
            createdAt: graphTime(r.created_time ?? r.timestamp),
            ...(r.permalink_url || r.permalink ? { url: (r.permalink_url ?? r.permalink)! } : {}),
          },
        ]
      : [],
  );
  return { posts, more: Boolean(res.paging?.next) };
}

/**
 * `GET /{page-id}/published_posts`: the Page's own feed stories since `since`,
 * newest first (Graph's `since` takes a unix time). Photo posts are feed
 * stories too, so this covers `/feed` and `/photos` publishes; a Reel is not,
 * see listRecentPageReels.
 */
export async function listRecentPagePosts(since: Date): Promise<RecentPostsPage> {
  const creds = await metaCredentials();
  const res = await graphRequest<GraphList<GraphPostRow>>(`${creds.pageId}/published_posts`, {
    params: {
      fields: "id,message,created_time,permalink_url",
      since: Math.floor(since.getTime() / 1000),
      limit: RECENT_POSTS_LIMIT,
    },
    accessToken: creds.pageToken,
    appSecret: creds.appSecret,
  });
  return recentPage(res, (id) => id);
}

/**
 * `GET /{page-id}/video_reels`: the Page's Reels, newest first. The ids come
 * back as facebook-transport.ts stores a Reel's ref (`reel:{video-id}`).
 */
export async function listRecentPageReels(): Promise<RecentPostsPage> {
  const creds = await metaCredentials();
  const res = await graphRequest<GraphList<GraphPostRow>>(`${creds.pageId}/video_reels`, {
    params: { fields: "id,description,created_time,permalink_url", limit: RECENT_POSTS_LIMIT },
    accessToken: creds.pageToken,
    appSecret: creds.appSecret,
  });
  return recentPage(res, (id) => `reel:${id}`);
}

/** `GET /{ig-user-id}/media`: the Instagram account's posts and Reels, newest first. */
export async function listRecentInstagramMedia(): Promise<RecentPostsPage> {
  const creds = await metaCredentials();
  if (!creds.igUserId) throw new Error("instagram: no Instagram account is linked to the Page (igUserId)");
  const res = await graphRequest<GraphList<GraphPostRow>>(`${creds.igUserId}/media`, {
    params: { fields: "id,caption,timestamp,permalink", limit: RECENT_POSTS_LIMIT },
    accessToken: creds.pageToken,
    appSecret: creds.appSecret,
  });
  return recentPage(res, (id) => id);
}
