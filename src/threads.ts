// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

import {
  appsecretProof,
  toMetricBag,
  NEEDS_REAUTH_CODES,
  RATE_LIMIT_CODES,
  readGraphError,
  readInsightRows,
  TRANSIENT_CODES,
} from "./meta-graph.js";
import { graphTime, type RecentPostsPage } from "./recent-posts.js";
import { retryAfterHeader } from "./retry.js";
import { vendorFetch, vendorText, type VendorFetchOptions } from "./vendor-fetch.js";
import { shape, type JsonObject, type Shape } from "./http/shape.js";

/** The readers for one Threads response, and the body read as an object. */
function threadsBody(operation: string, parsed: unknown): { s: Shape; body: JsonObject } {
  const s = shape("threads", operation);
  return { s, body: s.obj(parsed, "(body)") };
}

/**
 * Threads Graph API vendor client (graph.threads.net).
 *
 * Modeled on meta-graph.ts's SHAPE — the same error envelope, the same
 * unconditional `appsecret_proof`, the same "pin the version in the path"
 * discipline — but deliberately NOT built on top of it and NOT importing its
 * `graphRequest`. Threads is not graph.facebook.com: different host, its own
 * access token + user id (never the Facebook Page token), and its own
 * version scheme (`v1.0`, independent of the Facebook Graph API's `vXX.0`
 * ladder). The one thing genuinely shared is `appsecretProof` itself — a pure
 * HMAC helper with no host baked in — so that alone is imported rather than
 * re-implemented.
 *
 * Structurally this also borrows from pinterest.ts/linkedin.ts: every
 * exported function resolves its own credentials via the injected resolver
 * rather than requiring a caller to plumb a token through (unlike
 * meta-graph.ts's `graphRequest`, which takes credentials as explicit
 * arguments because THREE platforms share that one file and none of them owns
 * the credential). Threads has exactly one platform hanging off this file, so
 * there is nothing to share the credential resolution with.
 *
 * VENDOR FACTS BELOW WERE VERIFIED against developers.facebook.com/docs/threads
 * (the pages named inline), NOT assumed from an aggregator or from training
 * data. Where something could not be confirmed from an official
 * page, the comment says so rather than asserting it.
 *
 * Engine rules apply: relative imports only.
 */

const THREADS_HOST = "https://graph.threads.net";

/**
 * VERIFIED against every current example request across Meta's Threads API
 * docs (/docs/threads/posts, /docs/threads/retrieve-and-manage-replies/create-replies,
 * /docs/threads/get-started, /docs/threads/threads-profiles): every one uses
 * `https://graph.threads.net/v1.0/...`. Threads
 * versions independently of the Facebook Graph API's `vXX.0` ladder covered by
 * meta-graph.ts's `META_GRAPH_VERSION`; no newer Threads version (v1.1, v2.0,
 * …) turned up in any doc page or changelog entry checked. Pinned here for the
 * same reason meta-graph.ts pins its own: if Threads ever grows a Facebook-style
 * "upgrade all calls" dashboard toggle, an unversioned call would be the one
 * thing that setting could silently rewrite — naming the version on every
 * request removes that risk regardless.
 */
export const THREADS_API_VERSION = "v1.0";

/**
 * Operator-owned credentials, injected the same way `setMetaCredentialsResolver`
 * and `setPinterestTokenResolver` are: this folder cannot read the secret store.
 *
 * Distinct from `MetaCredentials` on purpose — a Threads user access token is
 * "unique to the app and user pair" (Threads' own Get Started doc) and is
 * NEVER the Facebook Page token `meta-graph.ts` carries, even though both
 * happen to sit behind the same Meta developer app.
 */
export interface ThreadsCredentials {
  /**
   * For `appsecret_proof`. Threads' own developer community has live threads
   * titled "Invalid appsecret_proof provided" against graph.threads.net
   * requests, which confirms the mechanism is real on this host too, not just
   * on graph.facebook.com — the exact acceptance rule (required vs merely
   * accepted) was not independently confirmed, so this client sends it
   * unconditionally, matching meta-graph.ts's own reasoning: it costs nothing
   * and removes a live ordering hazard either way.
   */
  appSecret: string;
  accessToken: string;
  /** The Threads-scoped user id every container/publish call is made under. */
  userId: string;
}

export type ThreadsCredentialsResolver = () => Promise<ThreadsCredentials>;

let _resolver: ThreadsCredentialsResolver | null = null;

export function setThreadsCredentialsResolver(resolver: ThreadsCredentialsResolver | null): void {
  _resolver = resolver;
}

export async function threadsCredentials(): Promise<ThreadsCredentials> {
  if (!_resolver) {
    throw new Error("no Threads credentials resolver registered (call setThreadsCredentialsResolver)");
  }
  return _resolver();
}

/**
 * A Threads API error. Same envelope shape as `MetaGraphError` because this
 * host is served from Meta's Graph API infrastructure — but that specific
 * claim (the `{error:{message,type,code,error_subcode,fbtrace_id}}` shape) is
 * NOT independently confirmed for graph.threads.net from an official example:
 * every troubleshooting/error page checked showed only container
 * `error_message` strings (FAILED_DOWNLOADING_VIDEO and friends), never a full
 * error envelope. This is the best-available assumption, not a verified fact,
 * and `request()` below falls back to a status-shaped error when a response
 * doesn't match it.
 */
export class ThreadsError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: number | null,
    readonly subcode: number | null,
    readonly type: string | null,
    readonly traceId: string | null,
    /**
     * Raw `Retry-After`, verbatim. retry.ts owns the grammar; see
     * RetryAfterCarrier. Same caveat as `MetaGraphError.retryAfter`: this host
     * is Graph-family infrastructure, which prefers usage-percentage headers,
     * so null here is common and means "fall back to the backoff".
     */
    readonly retryAfter: string | null = null,
  ) {
    super(message);
    this.name = "ThreadsError";
  }

  /**
   * Same code lists `MetaGraphError.retryable` reads, imported from meta-graph.ts
   * rather than re-typed here. Unverified whether Threads issues these exact
   * numeric codes (no official error-code table was found; see this class's
   * docblock), but it is the same Graph-family infrastructure and no
   * Threads-specific list exists to prefer instead.
   */
  get retryable(): boolean {
    if (this.status >= 500) return true;
    return this.code !== null && [...RATE_LIMIT_CODES, ...TRANSIENT_CODES].includes(this.code);
  }

  /**
   * The "Threads refused, so nothing happened" half of `retryable` — the rate
   * limit codes only, excluding API_UNKNOWN (1) and API_SERVICE (2), which mean
   * the call may have landed. That distinction is what lets a CREATE be retried
   * safely; see retry.ts's header.
   *
   * ⚠️ Inherits the same caveat as `retryable` directly above: no official
   * Threads error-code table was found, so these are the Graph-family codes.
   */
  get rateLimited(): boolean {
    return this.code !== null && RATE_LIMIT_CODES.includes(this.code);
  }

  /** Same reasoning and code list as `MetaGraphError.needsReauth` — see the caveat above. */
  get needsReauth(): boolean {
    return this.code !== null && NEEDS_REAUTH_CODES.includes(this.code);
  }
}

/**
 * True when the vendor gave (or plausibly gave) a definitive "this id does
 * not exist" answer.
 *
 * Threads' own delete-posts doc does not specify what deleting an
 * already-deleted post returns, and no error-envelope example for a missing
 * object turned up either (see ThreadsError's docblock) — so this is a
 * heuristic over an HTTP 404 plus the classic Graph-family "does not exist" /
 * "cannot be loaded" wording, the same style of best-effort match
 * bluesky-transport.ts's `isNotFoundError` makes over AT Protocol error
 * bodies. UNVERIFIED against a live response; update this the first time a
 * real one is captured.
 */
export function isThreadsNotFound(err: unknown): boolean {
  if (!(err instanceof ThreadsError)) return false;
  if (err.status === 404) return true;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("does not exist") ||
    msg.includes("cannot be loaded") ||
    msg.includes("nonexisting field") ||
    msg.includes("unsupported get request")
  );
}

// The error envelope is meta-graph.ts's GraphErrorEnvelope, imported above:
// Threads is the same Graph-family infrastructure and decodes the same shape.

/** Matches meta-graph.ts's REQUEST_TIMEOUT_MS and every other vendor client in this folder. */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * One Threads request. Takes the resolved credentials as an explicit
 * argument, like meta-graph.ts's `graphRequest` — NOT re-resolved internally
 * — so that each exported function below calls `threadsCredentials()` exactly
 * once per call even when it also needs `userId` to build the request path
 * (createContainer, publishContainer). Resolving twice per call would be
 * wasteful at best; at worst, a resolver backed by a real credential store
 * (a secret store, a cross-process lease) would pay that cost on every single
 * request.
 *
 * Params ride the query string for GET/DELETE and a form body for POST,
 * mirroring graphRequest's split — `image_url`/`text` values are long enough
 * that keeping them off the request line matters here too, and the vendor's
 * own DELETE docs specifically show `access_token` as a query parameter.
 */
async function request(
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Record<string, string | number | boolean | undefined>,
  creds: ThreadsCredentials,
): Promise<unknown> {
  const { accessToken, appSecret } = creds;

  const fields = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) fields.set(key, String(value));
  }
  fields.set("access_token", accessToken);
  fields.set("appsecret_proof", appsecretProof(accessToken, appSecret));

  const base = `${THREADS_HOST}/${THREADS_API_VERSION}${path}`;
  const usesQuery = method === "GET" || method === "DELETE";
  const url = usesQuery ? `${base}?${fields.toString()}` : base;

  const responseOpts: VendorFetchOptions = {
    timeoutMs: REQUEST_TIMEOUT_MS,
    wrap: (status, message) => new ThreadsError(message, status, null, null, null, null),
  };
  const response = await vendorFetch(
    url,
    {
      method,
      ...(usesQuery
        ? {}
        : { headers: { "content-type": "application/x-www-form-urlencoded" }, body: fields.toString() }),
    },
    responseOpts,
  );

  const text = await vendorText(response, responseOpts);
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new ThreadsError(
      `Threads returned a non-JSON response (${response.status}): ${text.slice(0, 200)}`,
      response.status,
      null,
      null,
      null,
      null,
    );
  }

  const graphError = readGraphError(parsed);
  if (!response.ok || graphError) {
    const err = graphError ?? {};
    throw new ThreadsError(
      err.message ?? `Threads request failed with HTTP ${response.status}`,
      response.status,
      err.code ?? null,
      err.error_subcode ?? null,
      err.type ?? null,
      err.fbtrace_id ?? null,
      retryAfterHeader(response),
    );
  }

  // Each caller reads the body through a Shape (shape.ts).
  return parsed;
}

export type ThreadsMediaType = "TEXT" | "IMAGE" | "VIDEO" | "CAROUSEL";

/**
 * Fields for `POST /{threads-user-id}/threads`, VERIFIED against
 * developers.facebook.com/docs/threads/posts:
 *
 *   TEXT:     media_type=TEXT, text (required, <=500 chars)
 *   IMAGE:    media_type=IMAGE, image_url (required, publicly accessible), text (optional)
 *   VIDEO:    media_type=VIDEO, video_url (required, publicly accessible), text (optional)
 *   CAROUSEL: media_type=CAROUSEL, children (required, 2-20 container ids), text (optional)
 *
 * VIDEO per Meta's posts doc: MOV or MP4, up to 5 minutes and 1 GB. The
 * transport sends it as a standalone post only; a video CHILD of a
 * carousel is still refused there (see threads-transport.ts's collectVideo).
 * `is_carousel_item`/`reply_to_id` are documented on the same endpoint
 * (create-replies doc for the latter) and apply across media types.
 */
export interface CreateContainerInput {
  mediaType: ThreadsMediaType;
  /** Required for TEXT; optional caption for IMAGE/CAROUSEL. Vendor cap: 500 chars. */
  text?: string;
  /** Required for IMAGE. Must be a publicly fetchable URL — Threads fetches it server-side, there is no byte-upload path. */
  imageUrl?: string;
  /** Required for VIDEO. Public for the same reason as imageUrl: Threads fetches it, nothing is uploaded. */
  videoUrl?: string;
  /** Required for CAROUSEL: 2-20 already-created (and FINISHED) item container ids. */
  children?: string[];
  /** Marks this container as a CAROUSEL child rather than a standalone post. */
  isCarouselItem?: boolean;
  /**
   * `topic_tag`: the post's ONE topic, 1-50 characters, no `.` or `&`, sent
   * WITHOUT the leading `#`. Threads surfaces a single topic per post and, on
   * its publishing reference, calls the in-text `#tag` path
   * "not preferred" and kept only for backwards compatibility. The transport
   * lifts a lone hashtag out of the text into this field.
   */
  topicTag?: string;
  /**
   * `crossreshare_to_ig`: also post this thread as a Story on the linked
   * Instagram account (developers.facebook.com/docs/threads/create-posts/
   * share-to-ig-stories). Any media type. Needs the
   * `threads_share_to_instagram` scope on the token; without it, or with no
   * linked account, "the cross-share fails but the Threads post is still
   * published", and the publish response says which in
   * `crossreshare_to_ig_status`. Stories expire after 24 hours.
   */
  crossShareToIgStory?: boolean;
  /**
   * Chains this container onto an existing post as a reply. VERIFIED against
   * developers.facebook.com/docs/threads/retrieve-and-manage-replies/create-replies
   * (the exact param name and an example request):
   *   curl -F "media_type=<T>" -F "text=<T>" -F "reply_to_id=<THREADS_ID>" ...
   */
  replyToId?: string;
  /**
   * Accessibility text for the image or video in this container.
   *
   * VERIFIED against developers.facebook.com/docs/threads/posts/accessibility
   * and the POST /threads parameter table: "The
   * accessibility text label or description for an image or video in a Threads
   * post. Note: The maximum length of alt_text is 1,000 characters."
   *
   * Meaningless on a TEXT container — there is no media to describe — so
   * callers only set it alongside imageUrl or videoUrl.
   */
  altText?: string;
}

/** Threads' documented ceiling for alt_text. Longer values are truncated, not dropped. */
export const ALT_TEXT_MAX_CHARS = 1000;

export interface ThreadsContainerRef {
  id: string;
}

export async function createContainer(input: CreateContainerInput): Promise<ThreadsContainerRef> {
  const creds = await threadsCredentials();
  const parsed = await request(
    "POST",
    `/${creds.userId}/threads`,
    {
      media_type: input.mediaType,
      text: input.text,
      image_url: input.imageUrl,
      video_url: input.videoUrl,
      children: input.children?.length ? input.children.join(",") : undefined,
      is_carousel_item: input.isCarouselItem ? "true" : undefined,
      reply_to_id: input.replyToId,
      alt_text: input.altText ? input.altText.slice(0, ALT_TEXT_MAX_CHARS) : undefined,
      topic_tag: input.topicTag ? input.topicTag.replace(/^#/, "").slice(0, 50) : undefined,
      crossreshare_to_ig: input.crossShareToIgStory ? "true" : undefined,
    },
    creds,
  );
  // A 2xx with no usable id is a ResponseShapeError: an unknown outcome, never re-sent.
  const { s, body } = threadsBody("POST /:user-id/threads", parsed);
  return { id: s.id(body.id, "id") };
}

export interface ThreadsPublishedRef extends ThreadsContainerRef {
  /**
   * Present only when the container asked for an Instagram Story cross-share:
   * SUCCESS or FAILED. FAILED still means the Threads post is live.
   */
  crossShareToIgStatus?: "SUCCESS" | "FAILED";
}

/** `POST /{threads-user-id}/threads_publish`, VERIFIED against /docs/threads/posts. */
export async function publishContainer(creationId: string): Promise<ThreadsPublishedRef> {
  const creds = await threadsCredentials();
  const parsed = await request("POST", `/${creds.userId}/threads_publish`, { creation_id: creationId }, creds);
  const { s, body } = threadsBody("POST /:user-id/threads_publish", parsed);
  const id = s.id(body.id, "id");
  const raw = s.optStr(body.crossreshare_to_ig_status, "crossreshare_to_ig_status");
  const cross =
    raw === undefined || raw === "SUCCESS" || raw === "FAILED"
      ? raw
      : s.fail("crossreshare_to_ig_status", '"SUCCESS" or "FAILED"', raw);
  return { id, ...(cross ? { crossShareToIgStatus: cross } : {}) };
}

export type ThreadsContainerStatusCode = "IN_PROGRESS" | "FINISHED" | "PUBLISHED" | "ERROR" | "EXPIRED";

const CONTAINER_STATUS_CODES: readonly ThreadsContainerStatusCode[] = ["IN_PROGRESS", "FINISHED", "PUBLISHED", "ERROR", "EXPIRED"];

export interface ThreadsContainerStatus {
  status: ThreadsContainerStatusCode;
  errorMessage?: string;
}

/**
 * `GET /{threads-container-id}?fields=status,error_message`. VERIFIED against
 * the Threads troubleshooting doc: status_code values
 * IN_PROGRESS / FINISHED / PUBLISHED / ERROR / EXPIRED (containers expire 24h
 * after creation if never published), with error_message examples like
 * FAILED_DOWNLOADING_VIDEO for the ERROR state.
 */
export async function getContainerStatus(containerId: string): Promise<ThreadsContainerStatus> {
  const creds = await threadsCredentials();
  const parsed = await request("GET", `/${containerId}`, { fields: "status,error_message" }, creds);
  const { s, body } = threadsBody("GET /:container-id?fields=status,error_message", parsed);
  // An absent status still reads as IN_PROGRESS (the poll is bounded); a value
  // outside the documented five is refused rather than polled on as if pending.
  const raw = s.optStr(body.status, "status") ?? "IN_PROGRESS";
  const status = CONTAINER_STATUS_CODES.find((c) => c === raw) ?? s.fail("status", `one of ${CONTAINER_STATUS_CODES.join(", ")}`, raw);
  return { status, errorMessage: s.optStr(body.error_message, "error_message") };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Bounded poll for a container to leave IN_PROGRESS.
 *
 * Threads' own docs recommend waiting "on average 30 seconds" before
 * publishing and separately document the status endpoint for "monitoring" —
 * i.e. polling IS the vendor-sanctioned path, not a guess this client is
 * making up. A TEXT container with no media to fetch typically resolves on
 * the first check; an IMAGE container needs Threads to download `image_url`
 * server-side first, which is what this loop is actually waiting on. Bounded
 * rather than a blind sleep so a stuck container fails loudly (ERROR/EXPIRED,
 * or a timeout after `maxAttempts`) instead of `threads_publish` being called
 * against a container that was never going to finish.
 */
export async function pollContainerUntilFinished(
  containerId: string,
  opts: { maxAttempts?: number; intervalMs?: number } = {},
): Promise<void> {
  const maxAttempts = opts.maxAttempts ?? 12;
  const intervalMs = opts.intervalMs ?? 2000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { status, errorMessage } = await getContainerStatus(containerId);
    if (status === "FINISHED" || status === "PUBLISHED") return;
    if (status === "ERROR") {
      throw new ThreadsError(
        `container ${containerId} failed processing: ${errorMessage ?? "unknown error"}`,
        0,
        null,
        null,
        null,
        null,
      );
    }
    if (status === "EXPIRED") {
      throw new ThreadsError(
        `container ${containerId} expired (24h window) before it could be published`,
        0,
        null,
        null,
        null,
        null,
      );
    }
    if (attempt < maxAttempts) await sleep(intervalMs);
  }

  throw new ThreadsError(
    `container ${containerId} was still IN_PROGRESS after ${maxAttempts} status checks; giving up rather than publishing a possibly-unready container`,
    0,
    null,
    null,
    null,
    null,
  );
}

/**
 * `DELETE /v1.0/{threads-media-id}`, VERIFIED against
 * developers.facebook.com/docs/threads/posts/delete-posts:
 * requires `threads_basic` + `threads_delete`, returns
 * `{success, deleted_id}` on success, rate-limited to 100/day per account.
 * Added to the API 2025-03-06 per the Threads API changelog — deletion is a
 * real, supported operation, not something this client has to fake or refuse.
 *
 * Stays a thin passthrough (throws on any failure) — the "already gone is
 * success" business decision belongs to threads-transport.ts's deletePost,
 * same split as every other vendor client in this folder.
 */
export async function deleteThread(mediaId: string): Promise<void> {
  const creds = await threadsCredentials();
  // `{ success: true }` on a delete; a `false` is refused, because the caller reports success.
  const { s, body } = threadsBody("DELETE /:media-id", await request("DELETE", `/${mediaId}`, {}, creds));
  if (s.optBool(body.success, "success") === false) s.fail("success", "true", false);
}

/**
 * `GET /{threads-media-id}?fields=permalink`. VERIFIED against
 * developers.facebook.com/docs/threads/retrieve-and-discover-posts/retrieve-posts:
 * the media object exposes a `permalink` field, example
 * response `"permalink": "https://www.threads.net/@threadsapitestuser/post/abcdefg"`.
 * Returns `undefined` rather than throwing when the field is simply absent
 * (as opposed to the lookup itself failing, which still throws) — the caller
 * decides what to fall back to.
 */
export async function getPermalink(mediaId: string): Promise<string | undefined> {
  const creds = await threadsCredentials();
  const { s, body } = threadsBody("GET /:media-id?fields=permalink", await request("GET", `/${mediaId}`, { fields: "permalink" }, creds));
  return s.optId(body.permalink, "permalink");
}

/**
 * Insights, for both a single post and the account.
 *
 * VERIFIED against developers.facebook.com/docs/threads/insights and
 * /docs/threads/reference/insights:
 *
 *   GET /{threads-media-id}/insights?metric=likes,replies
 *   GET /{threads-user-id}/threads_insights?metric=views,likes,...,followers_count
 *
 * with a response of `{ data: [{ name, period, values: [{ value }] }] }`.
 *
 * ⚠️ TWO RESPONSE SHAPES, and both are parsed. Meta's insights family reports
 * "Total Value" metrics as `total_value: { value }` and time-series metrics as
 * `values: [{ value }]` — the Threads docs show the `values` form for media and
 * describe several user metrics as Total Value without showing one. Reading
 * only the documented shape would silently return nothing for the other, which
 * on a dashboard is indistinguishable from genuine zero engagement. So this
 * accepts either and reports a metric it cannot parse as ABSENT rather than 0.
 *
 * A metric this token is not permitted to read comes back as an error for the
 * whole call, not a partial result — callers get the throw.
 */
// The row shape and the dual-shape parsing live in meta-graph.ts: Threads is
// part of the same insights family as Instagram and Facebook. One parser, so a
// fix to the total_value/values handling cannot land in some
// Meta platforms and not others.

/** Lifetime engagement for one post. */
const THREADS_MEDIA_METRICS = ["views", "likes", "replies", "reposts", "quotes"] as const;

export async function getMediaInsights(mediaId: string): Promise<Record<string, number>> {
  const creds = await threadsCredentials();
  const data = await request("GET", `/${mediaId}/insights`, { metric: THREADS_MEDIA_METRICS.join(",") }, creds);
  return toMetricBag(readInsightRows(shape("threads", "GET /:media-id/insights"), data));
}

/**
 * Account-level insights.
 *
 * ⚠️ `follower_demographics` is deliberately NOT requested: the vendor
 * documents it as incompatible with `since`/`until`, and it returns a breakdown
 * rather than a scalar, so it does not fit a Record<string, number> at all.
 */
const THREADS_USER_METRICS = [
  "views",
  "likes",
  "replies",
  "reposts",
  "quotes",
  "clicks",
  "followers_count",
] as const;

export async function getUserInsights(): Promise<Record<string, number>> {
  const creds = await threadsCredentials();
  const data = await request("GET", `/${creds.userId}/threads_insights`, { metric: THREADS_USER_METRICS.join(",") }, creds);
  return toMetricBag(readInsightRows(shape("threads", "GET /:user-id/threads_insights"), data));
}

export interface ThreadsProfile {
  id: string;
  username: string;
}

/**
 * `GET /me?fields=id,username`. VERIFIED against
 * developers.facebook.com/docs/threads/threads-profiles,
 * which states plainly: "You may only fetch the profile of the app-scoped
 * user" — via the literal `me` alias, not the stored `userId` path segment
 * every other call in this file uses.
 */
export async function getProfile(): Promise<ThreadsProfile> {
  const creds = await threadsCredentials();
  const { s, body } = threadsBody("GET /me", await request("GET", "/me", { fields: "id,username" }, creds));
  return { id: s.id(body.id, "id"), username: s.id(body.username, "username") };
}

/** How many of the newest posts one crash-check read asks for. */
const RECENT_THREADS_LIMIT = 25;

/**
 * `GET /{user-id}/threads`: the account's own top-level posts since `since`,
 * newest first, for the agent publish's crash check. Replies are not on this
 * edge, which is what the check wants: it looks for the root.
 */
export async function listRecentThreads(since: Date): Promise<RecentPostsPage> {
  const creds = await threadsCredentials();
  const parsed = await request(
    "GET",
    `/${creds.userId}/threads`,
    { fields: "id,text,timestamp,permalink", since: Math.floor(since.getTime() / 1000), limit: RECENT_THREADS_LIMIT },
    creds,
  );
  const { s, body: res } = threadsBody("GET /:user-id/threads", parsed);
  const posts = s.optEach(res.data, "data", (item, at) => {
    const r = s.obj(item, at);
    const text = s.optStr(r.text, `${at}.text`);
    const permalink = s.optStr(r.permalink, `${at}.permalink`);
    return {
      id: s.id(r.id, `${at}.id`),
      texts: text === undefined ? [] : [text],
      createdAt: graphTime(s.optStr(r.timestamp, `${at}.timestamp`)),
      ...(permalink ? { url: permalink } : {}),
    };
  });
  return { posts, more: Boolean(s.optStr(s.optObj(res.paging, "paging")?.next, "paging.next")) };
}
