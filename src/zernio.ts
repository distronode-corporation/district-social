/**
 * Zernio API vendor client.
 *
 * Plays the same role the per-platform clients play for theirs: every raw call
 * to zernio.com lives here, and nothing above this file touches `fetch`.
 *
 * ⛔ A bare-cuid `legacy` entry in `providerPostId` is NOT recoverable through
 * a different Zernio account: a cuid belonging to a different tenant is
 * indistinguishable from one that is simply gone, and `deletePost` idempotence
 * would report success either way. Do not try.
 *
 * WHY AN AGGREGATOR AT ALL. An operator without its own approved Reddit Data
 * API application can publish through Zernio, which holds its OWN approved
 * Reddit app: the operator is then an ordinary end user of an app Reddit
 * already approved rather than an applicant.
 *
 * Vendor facts below were checked against Zernio's published OpenAPI 3.1 spec
 * (https://zernio.com/openapi.yaml) and docs.zernio.com. Anywhere
 * the spec did not settle something, the comment says so rather than asserting.
 *
 * Engine rules apply: relative imports only.
 */

import { retryAfterHeader } from "./retry.js";
import { BODY_KEY, shape, type JsonObject, type Shape } from "./http/shape.js";

const BASE_URL = "https://zernio.com/api/v1";

/** Matches the other JSON clients. Publishing is a single request, not an upload. */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Longer for the create call specifically.
 *
 * `publishNow: true` makes Zernio contact the platform SYNCHRONOUSLY and return
 * the native `platformPostId` inline, so this request is waiting on Reddit or X
 * rather than on Zernio. The per-platform clients allow the same headroom for
 * their own create calls.
 */
const PUBLISH_TIMEOUT_MS = 60_000;

export class ZernioError extends Error {
  readonly status: number;
  /** Zernio's stable machine code, e.g. `ACCOUNT_DISCONNECTED`. */
  readonly code?: string;
  /** Zernio's error class, e.g. `rate_limit_error`, `platform_error`. */
  readonly type?: string;
  /** The platform the failure is about, when the error names one. */
  readonly platform?: string;
  /**
   * The upstream platform's own error payload, passed through verbatim.
   *
   * Kept because flattening it to a hardcoded "delete failed" turns "rate
   * limited, retry in 30s" and "post not found" into the same shrug. Reporting
   * a REAL vendor message is a large part of why the direct transports exist,
   * and routing through an aggregator must not give that away.
   */
  readonly platformError?: unknown;
  /**
   * Raw `Retry-After`, verbatim. retry.ts owns the grammar; see
   * RetryAfterCarrier.
   *
   * ⚠️ It is the AGGREGATOR's window, not the platform's. One credential serves
   * every platform Zernio holds, so a wait it asks for applies to all of them —
   * which is the same reason the Aggregator docblock refuses to model it as N
   * independent transports.
   */
  readonly retryAfter: string | null;

  constructor(
    message: string,
    status: number,
    opts: {
      code?: string;
      type?: string;
      platform?: string;
      platformError?: unknown;
      retryAfter?: string | null;
    } = {},
  ) {
    super(message);
    this.name = "ZernioError";
    this.status = status;
    this.code = opts.code;
    this.type = opts.type;
    this.platform = opts.platform;
    this.platformError = opts.platformError;
    this.retryAfter = opts.retryAfter ?? null;
  }

  /**
   * Whether `withRetry`'s `transient` policy should repeat this.
   *
   * ⛔ Read by retry.ts, NOT by publishNow. The bound view registers publishNow
   * under `rejected-only`, so a 5xx on a create is never repeated: it may mean
   * the post landed and only the answer was lost.
   */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

/** Zernio's API key, injected by the app layer. See setZernioTokenResolver. */
export type ZernioTokenResolver = () => Promise<string>;

let _tokenResolver: ZernioTokenResolver | null = null;

/**
 * ⚠️ MUST NOT BE MEMOISED BY THE CALLER, matching the rule the four OAuth
 * transports carry. The resolver is what re-checks expiry and refreshes; a cache
 * in front of it defeats that and, for a key rotated in the secret store, pins
 * the dead one until the process restarts.
 */
export function setZernioTokenResolver(resolver: ZernioTokenResolver | null): void {
  _tokenResolver = resolver;
}

async function token(): Promise<string> {
  if (!_tokenResolver) {
    throw new ZernioError("no Zernio token resolver is wired in this deployment", 0);
  }
  return _tokenResolver();
}

async function request(
  path: string,
  init: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<unknown> {
  const bearer = await token();
  const res = await fetch(`${BASE_URL}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${bearer}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(init.timeoutMs ?? REQUEST_TIMEOUT_MS),
  });

  const text = await res.text();
  let parsed: unknown = null;
  let parseFailed = false;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parseFailed = true;
  }

  /**
   * ⛔ AN UNKNOWN PATH ANSWERS 200 WITH AN HTML APP SHELL, NOT 404.
   *
   * Verified against the live API: `/v1/analytics/posts`,
   * `/v1/analytics/summary` and `/v1/accounts/{id}/analytics` all return HTTP
   * 200 and Zernio's Next.js page markup. `zernio.com` serves the dashboard and
   * the API from one origin, so anything the API router does not claim falls
   * through to the SPA.
   *
   * Swallowing that would return `null`, which every caller reads as a
   * perfectly ordinary empty answer: `listAccounts` would report NO CONNECTED ACCOUNTS, so
   * every platform would go `connected: false` and publishing would stop with a
   * message blaming the credential. A renamed or mistyped endpoint has to be
   * loud, because there is no other signal that it happened.
   */
  if (res.ok && parseFailed) {
    throw new ZernioError(
      `Zernio returned 200 with a non-JSON body for ${path} — the path is probably ` +
        `not an API route (the dashboard SPA is served from the same origin)`,
      res.status,
      { code: "NON_JSON_200" },
    );
  }

  if (!res.ok) {
    // The failure path: each field is kept only when it is a string, so a
    // malformed error body still reports the HTTP failure.
    const err: Record<string, unknown> =
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    throw new ZernioError(str(err.error) || text || `Zernio ${res.status}`, res.status, {
      code: str(err.code),
      type: str(err.type),
      platform: str(err.platform),
      platformError: err.platformError,
      retryAfter: retryAfterHeader(res),
    });
  }

  // Each caller reads the body through a Shape (shape.ts).
  return parsed;
}

/** A 2xx body as an object, for `operation`'s Shape. An empty body is refused like any non-object. */
function zernioBody(operation: string, parsed: unknown): { s: Shape; body: JsonObject } {
  const s = shape("zernio", operation);
  return { s, body: s.obj(parsed, "(body)") };
}


/* -------------------------------------------------------------------------- */
/*  Accounts                                                                   */
/* -------------------------------------------------------------------------- */

export interface ZernioAccount {
  _id: string;
  platform: string;
  username?: string;
  displayName?: string;
  profileUrl?: string;
  isActive?: boolean;
}

/**
 * Every connected account on this API key.
 *
 * This is how the aggregator learns which platforms it can serve: connecting an
 * account in Zernio's dashboard is enough, with no settings edit here. The
 * operator's own UI stays the source of truth for what is connected, which is
 * the house rule for this vendor's configuration.
 */
export async function listAccounts(): Promise<ZernioAccount[]> {
  // ⛔ `page` AND `limit` TOGETHER, ALWAYS. Sending `limit` alone is a 400
  // `{"error":"page and limit must be provided together","code":
  // "invalid_field_value"}`, verified against the live API. This is
  // not in the OpenAPI spec, which documents the two as independent optional
  // query parameters, so it can only be found by calling it.
  const { s, body } = zernioBody("GET /accounts", await request("/accounts?page=1&limit=100"));
  return s.optEach(body.accounts, "accounts", (item, at) => {
    const a = s.obj(item, at);
    const account: ZernioAccount = { _id: s.id(a._id, `${at}._id`), platform: s.id(a.platform, `${at}.platform`) };
    const username = s.optStr(a.username, `${at}.username`);
    const displayName = s.optStr(a.displayName, `${at}.displayName`);
    const profileUrl = s.optStr(a.profileUrl, `${at}.profileUrl`);
    const isActive = s.optBool(a.isActive, `${at}.isActive`);
    if (username !== undefined) account.username = username;
    if (displayName !== undefined) account.displayName = displayName;
    if (profileUrl !== undefined) account.profileUrl = profileUrl;
    if (isActive !== undefined) account.isActive = isActive;
    return account;
  });
}

/* -------------------------------------------------------------------------- */
/*  Posts                                                                      */
/* -------------------------------------------------------------------------- */

export interface ZernioMediaItem {
  type: "image" | "video" | "gif" | "document";
  url: string;
  altText?: string;
}

/** Per-platform options. Only the fields this engine actually sets. */
export interface ZernioPlatformData {
  /** Reddit. Without the `r/` prefix. */
  subreddit?: string;
  /** Reddit (max 300) / Pinterest (max 100) / YouTube (max 100). */
  title?: string;
  /** Reddit. Some subreddits require one; `flairId` wins over `flairText`. */
  flairId?: string;
  /** Pinterest. Effectively required — the vendor errors without it. */
  boardId?: string;
  /** Pinterest click-through. */
  link?: string;
  /** YouTube. */
  visibility?: "public" | "private" | "unlisted";
  /**
   * X. The whole thread, root first: Zernio publishes threadItems[0] as the
   * root tweet and chains the rest as replies, and when this is present the
   * top-level `content` is "used only for display and search purposes, it is
   * NOT published" (zernio.com/openapi.yaml v1.8.0, TwitterPlatformData).
   * This is Zernio's wire shape, NOT `PlatformRender.threadItems` (replies
   * only): zernio-aggregator.ts builds it as the render's `content` followed
   * by its `threadReplies`.
   *
   * ⛔ WITHOUT THIS, AN X POST ROUTED THROUGH ZERNIO GOES OUT WITHOUT ITS LINK.
   * The playbook moves the URL out of the root into a thread item (X suppresses
   * body links), the direct transport replies with each item, and sending
   * `content` alone lands the root while the reply with the link never exists,
   * and nothing downstream notices because the leg reports a real native id.
   * Media rides on threadItems[0], the root.
   */
  threadItems?: Array<{ content: string; mediaItems?: ZernioMediaItem[] }>;
  /**
   * TikTok (`TikTokPlatformData`). `privacyLevel` must be one of the values
   * `GET /v1/accounts/{id}/tiktok/creator-info` returns for the account, and the
   * three `allow*` flags are each required by TikTok on a video post.
   */
  privacyLevel?: string;
  allowComment?: boolean;
  allowDuet?: boolean;
  allowStitch?: boolean;
  /** TikTok's commercial-content disclosure. `brand_organic` is "Your Brand". */
  commercialContentType?: "none" | "brand_organic" | "brand_content";
  /** TikTok's AI-generated content label. Video posts only on a business account. */
  videoMadeWithAi?: boolean;
  /** TikTok's two direct-post attestations (content previewed, consent to post). */
  contentPreviewConfirmed?: boolean;
  expressConsentGiven?: boolean;
}

export interface ZernioPlatformTarget {
  platform: string;
  accountId: string;
  platformSpecificData?: ZernioPlatformData;
}

export interface ZernioPlatformResult {
  platform: string;
  accountId?: string;
  /**
   * The aggregator acts on `published` and `failed` only; every other state
   * Zernio reports (pending, processing, uploading, cancelled, ...) reads as
   * not finished. Type-checked, not held to a list: a state Zernio adds must
   * not fail a create whose post may already be live.
   */
  status: string;
  platformPostId?: string;
  platformPostUrl?: string;
  error?: string;
}

export interface ZernioPost {
  /**
   * Absent only when Zernio answered without one; the aggregator turns that
   * into its NO_POST_ID failure, whose message names the manual recovery.
   */
  _id?: string;
  /** Type-checked, not held to a list (partial, publishing, ... exist): see ZernioPlatformResult.status. */
  status?: string;
  platforms?: ZernioPlatformResult[];
}

/**
 * Create and publish immediately.
 *
 * ⚠️ `publishNow: true` is what makes the native ids available inline. Omitting
 * every one of `publishNow` / `scheduledFor` / `queuedFromProfile` silently
 * creates a DRAFT on Zernio's side — the request succeeds, returns an id, and
 * nothing is ever published.
 *
 * ⚠️ Zernio dedupes on a content hash of (platform, accountId, content + media
 * URLs) over a 24-hour window and answers 409 with `details.existingPostId`.
 * Anything that republishes identical copy inside a day (a proof run, a retry
 * after a lost response) must vary the text.
 */
/**
 * ⛔ BOTH THE CREATE AND THE GET WRAP THE POST IN AN ENVELOPE:
 * `{message, post}` (`PostCreateResponse` / the `/posts/{id}` 200). Reading the
 * envelope as the post leaves `_id` undefined, and because the post is created
 * BEFORE the response is parsed, that failure arrives with a real post already
 * live on the platform ("returned no post id", with a live post to delete by
 * hand). The list endpoint, by contrast, uses `{posts: [...]}`.
 */
function unwrapPost(operation: string, parsed: unknown): ZernioPost {
  // An empty 200 is "no post id", which the aggregator reports as NO_POST_ID
  // with the manual-recovery message; anything else must be an object.
  if (parsed === null) return {};
  const { s, body } = zernioBody(operation, parsed);
  // `{message, post}`, or (older answers) the post itself at the top level.
  const at = body.post === undefined || body.post === null ? "(body)" : "post";
  const p = at === "post" ? s.obj(body.post, "post") : body;
  const post: ZernioPost = {};
  const id = s.optId(p._id, `${at}._id`);
  const status = s.optStr(p.status, `${at}.status`);
  if (id !== undefined) post._id = id;
  if (status !== undefined) post.status = status;
  const platforms = s.optArr(p.platforms, `${at}.platforms`);
  if (platforms) {
    post.platforms = platforms.map((item, i): ZernioPlatformResult => {
      const lat = `${at}.platforms[${i}]`;
      const leg = s.obj(item, lat);
      const result: ZernioPlatformResult = {
        platform: s.id(leg.platform, `${lat}.platform`),
        // A leg with no status is still pending: nothing has reported an outcome.
        status: s.optStr(leg.status, `${lat}.status`) ?? "pending",
      };
      for (const key of ["accountId", "platformPostId", "platformPostUrl", "error"] as const) {
        const v = s.optStr(leg[key], `${lat}.${key}`);
        if (v !== undefined) result[key] = v;
      }
      return result;
    });
  }
  return post;
}

export async function createPost(input: {
  content: string;
  platforms: ZernioPlatformTarget[];
  mediaItems?: ZernioMediaItem[];
}): Promise<ZernioPost> {
  const body = await request("/posts", {
    method: "POST",
    body: { ...input, publishNow: true },
    timeoutMs: PUBLISH_TIMEOUT_MS,
  });
  return unwrapPost("POST /posts", body);
}

export async function getPost(postId: string): Promise<ZernioPost> {
  return unwrapPost("GET /posts/:id", await request(`/posts/${encodeURIComponent(postId)}`));
}

/**
 * Remove a PUBLISHED post from the platform.
 *
 * ⛔ THIS IS THE DELETE, AND `DELETE /posts/{id}` IS NOT. The obvious verb only
 * removes Zernio-side drafts and scheduled posts; the spec is explicit that
 * "Published posts cannot be deleted; use the Unpublish endpoint instead."
 * Wiring the obvious one would leave the post live on Reddit while this system
 * recorded a successful delete — and because every transport treats an
 * already-gone post as success, nothing would ever notice.
 *
 * One platform per call, so a multi-target post needs N calls. Zernio keeps its
 * own record and moves it to `cancelled`.
 */
export async function unpublishPost(postId: string, platform: string): Promise<void> {
  await request(`/posts/${encodeURIComponent(postId)}/unpublish`, {
    method: "POST",
    body: { platform },
  });
}

/* -------------------------------------------------------------------------- */
/*  Per-destination lookups                                                    */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/*  Analytics                                                                  */
/* -------------------------------------------------------------------------- */

/** The counters Zernio normalises across platforms. All are present, many are 0. */
export interface ZernioAnalytics {
  impressions?: number;
  reach?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  saves?: number;
  clicks?: number;
  views?: number;
  follows?: number;
}

export interface ZernioAnalyticsPost {
  _id: string;
  status?: string;
  publishedAt?: string;
  analytics?: ZernioAnalytics;
  platforms?: Array<{
    platform: string;
    status?: string;
    platformPostId?: string;
    accountId?: string;
    analytics?: ZernioAnalytics;
  }>;
}

export interface ZernioAnalyticsReport {
  overview?: { totalPosts?: number; publishedPosts?: number; scheduledPosts?: number };
  posts?: ZernioAnalyticsPost[];
}

/**
 * ⚠️ ONE ENDPOINT FOR EVERYTHING. `/v1/analytics` returns the whole account's
 * posts with per-post AND per-platform counters, so both `analyticsPost` and
 * `analyticsChannel` are served from a single call rather than one per post.
 * There is no per-post analytics route — `/v1/analytics/posts` is one of the
 * paths that answers 200 with the dashboard SPA.
 *
 * Analytics endpoints carry their own per-SECOND cap (max(6, req_per_min/60)),
 * which is why the aggregator memoises this rather than calling it per leg.
 */
export async function getAnalytics(): Promise<ZernioAnalyticsReport> {
  const { s, body } = zernioBody("GET /analytics", await request("/analytics"));
  const report: ZernioAnalyticsReport = {};
  const overview = s.optObj(body.overview, "overview");
  if (overview) {
    report.overview = {};
    for (const key of ["totalPosts", "publishedPosts", "scheduledPosts"] as const) {
      const v = s.optNum(overview[key], `overview.${key}`);
      if (v !== undefined) report.overview[key] = v;
    }
  }
  const posts = s.optArr(body.posts, "posts");
  if (posts) {
    report.posts = posts.map((item, i) => {
      const at = `posts[${i}]`;
      const p = s.obj(item, at);
      const post: ZernioAnalyticsPost = { _id: s.id(p._id, `${at}._id`) };
      const status = s.optStr(p.status, `${at}.status`);
      const publishedAt = s.optStr(p.publishedAt, `${at}.publishedAt`);
      const analytics = readCounters(s, p.analytics, `${at}.analytics`);
      if (status !== undefined) post.status = status;
      if (publishedAt !== undefined) post.publishedAt = publishedAt;
      if (analytics) post.analytics = analytics;
      const legs = s.optArr(p.platforms, `${at}.platforms`);
      if (legs) {
        post.platforms = legs.map((legItem, j) => {
          const lat = `${at}.platforms[${j}]`;
          const leg = s.obj(legItem, lat);
          const out: NonNullable<ZernioAnalyticsPost["platforms"]>[number] = { platform: s.id(leg.platform, `${lat}.platform`) };
          for (const key of ["status", "platformPostId", "accountId"] as const) {
            const v = s.optStr(leg[key], `${lat}.${key}`);
            if (v !== undefined) out[key] = v;
          }
          const legAnalytics = readCounters(s, leg.analytics, `${lat}.analytics`);
          if (legAnalytics) out.analytics = legAnalytics;
          return out;
        });
      }
      return post;
    });
  }
  return report;
}

/** A counters object: every value a finite number (a `null` counter is left out, never read as 0). */
function readCounters(s: Shape, value: unknown, at: string): ZernioAnalytics | undefined {
  const bag = s.optObj(value, at);
  if (!bag) return undefined;
  const out: Record<string, number> = {};
  for (const [key, v] of Object.entries(bag)) {
    const n = s.optNum(v, `${at}${BODY_KEY}`);
    if (n !== undefined) out[key] = n;
  }
  return out;
}

export interface ZernioFlair {
  id: string;
  text: string;
}

export async function listRedditFlairs(
  accountId: string,
  subreddit: string,
): Promise<ZernioFlair[]> {
  const { s, body } = zernioBody(
    "GET /accounts/:id/reddit-flairs",
    await request(`/accounts/${encodeURIComponent(accountId)}/reddit-flairs?subreddit=${encodeURIComponent(subreddit)}`),
  );
  return s.optEach(body.flairs, "flairs", (item, at) => {
    const f = s.obj(item, at);
    return { id: s.id(f.id, `${at}.id`), text: s.str(f.text, `${at}.text`) };
  });
}

export interface ZernioBoard {
  id: string;
  name?: string;
}

export async function listPinterestBoards(accountId: string): Promise<ZernioBoard[]> {
  const { s, body } = zernioBody(
    "GET /accounts/:id/pinterest-boards",
    await request(`/accounts/${encodeURIComponent(accountId)}/pinterest-boards`),
  );
  return s.optEach(body.boards, "boards", (item, at) => {
    const b = s.obj(item, at);
    const board: ZernioBoard = { id: s.id(b.id, `${at}.id`) };
    const name = s.optStr(b.name, `${at}.name`);
    if (name !== undefined) board.name = name;
    return board;
  });
}
