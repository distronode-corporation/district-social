// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Pinterest API v5 vendor client.
 *
 * Plays the same role for this platform that bluesky.ts plays for Bluesky:
 * every raw call to
 * api.pinterest.com lives here, and nothing above this file touches fetch
 * directly. Two things distinguish this vendor from Bluesky:
 *
 *   - no session. Pinterest is a plain OAuth2 bearer token, refreshed and
 *     cached by the app's token store (behind a cross-process lease, because
 *     Pinterest ROTATES the refresh token on every redemption). This client
 *     asks the injected
 *     resolver for a token on every call rather than caching one itself; see
 *     setPinterestTokenResolver for why.
 *   - no batch lookup. app.bsky.feed.getPosts takes up to 25 uris in one
 *     call; Pinterest's GET /pins/{pin_id} takes exactly one and there is no
 *     bulk-get. pinterest-transport.ts's postFacts issues one call per ref
 *     for that reason, same as the interface docblock anticipates.
 *
 * Field shapes below (media_source, the boards `bookmark` cursor, the 800/100
 * char caps) were verified against Pinterest's own published OpenAPI
 * description (github.com/pinterest/api-description, v5/openapi.yaml) and the
 * generated Python client's model docs, not against training data.
 *
 * Engine rules apply: relative imports only.
 */

import type { RecentPostsPage } from "./recent-posts.js";
import { retryAfterHeader } from "./retry.js";
import { vendorFetch, vendorText, type VendorFetchOptions } from "./vendor-fetch.js";
import { shape } from "./http/shape.js";

/**
 * Production by default. `PINTEREST_API_BASE` exists for exactly one reason and
 * it is not testing convenience:
 *
 * An app on Standard access publishes to production and never needs this.
 * The block below is why the escape hatch stays: an app on Trial access, or
 * one downgraded to it, has no other way to complete a create.
 *
 * ⛔ AN APP ON TRIAL ACCESS CANNOT CREATE PINS ON PRODUCTION AT ALL. Proven
 * live with a fully-scoped token:
 *
 *     POST https://api.pinterest.com/v5/pins
 *     403 {"code":29,"message":"Apps with Trial access may not create Pins in
 *          production https://api.pinterest.com - use API Sandbox
 *          https://api-sandbox.pinterest.com instead."}
 *
 * Reads (`/user_account`, `/boards`) return 200 on production even on Trial, so
 * a green connect and a correct board list prove NOTHING about publishing.
 *
 * That matters here because upgrading to Standard requires submitting a demo
 * VIDEO of the app completing a real action through the API, and the only place
 * a Trial app can complete a create is the sandbox. With BASE_URL hardcoded
 * there would be no way to record that video, making the upgrade unreachable
 * by its own prerequisite.
 *
 * ⚠️ The sandbox is NOT a free fallback: the production OAuth token is rejected
 * there (`401 code 2`). It needs its own credentials, so setting this variable
 * alone does nothing without a matching sandbox token.
 *
 * ⛔ EXPORTED because the OAUTH TOKEN EXCHANGE must move with it. Pinterest mints
 * sandbox tokens at `api-sandbox.pinterest.com/v5/oauth/token` ("insert -sandbox
 * in the URL request path"), so if this switched the pin/board calls while the
 * app's OAuth connect flow kept exchanging against production, the flow would
 * complete green and hand back a PRODUCTION token, which then fails the create
 * with `403 code 29`, three steps later and looking like an access-tier problem
 * rather than a wrong-host one. One variable moves both, deliberately.
 */
export const PINTEREST_API_BASE_URL =
  process.env.PINTEREST_API_BASE?.replace(/\/+$/, "") || "https://api.pinterest.com/v5";
const BASE_URL = PINTEREST_API_BASE_URL;

/**
 * Two-tier timeouts (a short request timeout, a 120s upload timeout): a hung
 * connection must not hold a publish request open indefinitely. Pinterest has
 * no separate media-upload endpoint for the image_base64 path (the encoded
 * bytes ride inside the POST /pins body itself), so CREATE_PIN carries the
 * long upload timeout, and every lighter call (get, delete, list) gets the short
 * one.
 */
const REQUEST_TIMEOUT_MS = 15_000;
const CREATE_PIN_TIMEOUT_MS = 120_000;

/** GET /boards page size. Vendor default is 25, max is 100; ask for the max so a full account's boards take the fewest round trips. */
const BOARDS_PAGE_SIZE = 100;

export class PinterestError extends Error {
  constructor(
    public status: number,
    public body: string,
    method: string,
    path: string,
    /** Raw `Retry-After`, verbatim. retry.ts owns the grammar; see RetryAfterCarrier. */
    public retryAfter: string | null = null,
  ) {
    super(`Pinterest ${method} ${path} -> ${status}: ${body.slice(0, 500)}`);
  }
}

/** True when the vendor gave a definitive "this id does not exist" answer. */
export function isPinterestNotFound(err: unknown): boolean {
  return err instanceof PinterestError && err.status === 404;
}

export type PinterestTokenResolver = () => Promise<string>;

let _resolver: PinterestTokenResolver | null = null;

/**
 * Register (or clear, with null) the resolver that supplies a bearer access
 * token.
 *
 * INJECTED rather than imported, exactly like setBlueskyCredentialsResolver:
 * this folder is the portable engine and cannot reach the app's credential
 * store itself (that needs the app's database and encryption keys). Unlike
 * Bluesky there is no session to open and cache here: the resolver is called
 * fresh on EVERY request rather than memoised in this file, because the app's
 * token store already owns both the caching and the expiry check for the
 * token it returns. Caching a second copy of it here would mean a
 * just-rotated refresh cycle never gets picked up until this file's own cache
 * happened to expire.
 */
export function setPinterestTokenResolver(resolver: PinterestTokenResolver | null): void {
  _resolver = resolver;
}

async function token(): Promise<string> {
  if (!_resolver) {
    throw new PinterestError(
      0,
      "no Pinterest token resolver registered (call setPinterestTokenResolver)",
      "GET",
      "(resolver)",
    );
  }
  const t = await _resolver();
  if (!t) {
    throw new PinterestError(0, "Pinterest token resolver returned an empty token", "GET", "(resolver)");
  }
  return t;
}

async function request(
  method: string,
  path: string,
  opts: { body?: unknown; timeoutMs?: number } = {},
): Promise<unknown> {
  const accessToken = await token();
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const resOpts: VendorFetchOptions = { timeoutMs, wrap: (status, message) => new PinterestError(status, message, method, path) };
  const res = await vendorFetch(
    `${BASE_URL}${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    },
    resOpts,
  );
  // DELETE returns 204 with no body on success — nothing to parse.
  if (res.status === 204) return undefined;
  const text = await vendorText(res, resOpts);
  if (!res.ok) throw new PinterestError(res.status, text, method, path, retryAfterHeader(res));
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new PinterestError(res.status, `expected JSON, got: ${text.slice(0, 200)}`, method, path);
  }
}

function withQuery(path: string, params: Record<string, string | undefined>): string {
  const entries = Object.entries(params).filter((e): e is [string, string] => e[1] !== undefined);
  // No empty-entries case: both callers (listBoards, listRecentPins) pass page_size.
  return `${path}?${new URLSearchParams(entries).toString()}`;
}

/**
 * Pinterest's PinMediaSource `image_base64` only declares these two
 * content types (openapi.yaml `ContentType` enum) — no webp, no gif. A
 * caller with a different mime type must convert or fail loudly rather than
 * have this client guess at a silent re-encode.
 */
export type PinterestImageContentType = "image/jpeg" | "image/png";

export interface PinterestImageSource {
  contentType: PinterestImageContentType;
  /** Raw base64, no `data:` prefix. */
  data: string;
}

export interface CreatePinInput {
  boardId: string;
  title?: string;
  /** Vendor cap is 800 chars (openapi.yaml PinCreate.description), not the 500 some docs quote — see pinterest-transport.ts channelRules(). */
  description?: string;
  /** Destination URL. Pinterest's own field name is `link`. */
  link?: string;
  altText?: string;
  /**
   * 1 image uses `image_base64`; 2-5 use `multiple_image_base64` (a carousel
   * pin — PinMediaSourceImagesBase64, `minItems: 2, maxItems: 5`). Building
   * the right source_type from this array's length is this function's job so
   * every caller just hands it "the images," matching how createPost in
   * bluesky.ts hides the embed-building from its callers.
   */
  images: PinterestImageSource[];
}

export interface PinterestPin {
  id: string;
  link?: string;
  title?: string;
  boardId?: string;
}

function toPin(value: unknown, operation: string): PinterestPin {
  const s = shape("pinterest", operation);
  const r = s.obj(value, "(body)");
  return {
    id: s.id(r.id, "id"),
    // Type-checked; an empty link or board id is read as absent, not refused:
    // Pinterest uses "" for "no link", and getPin sits on the reconcile path.
    link: s.optStr(r.link, "link") || undefined,
    title: s.optStr(r.title, "title"),
    boardId: s.optStr(r.board_id, "board_id") || undefined,
  };
}

/**
 * POST /pins. Requires at least one image (`requiresMedia` on the Pinterest
 * spec) — an empty `images` array is a caller bug, not a vendor edge case, so
 * this throws before making the request rather than sending a medialess body
 * the vendor would reject anyway with a less specific error.
 */
export async function createPin(input: CreatePinInput): Promise<PinterestPin> {
  if (!input.boardId) {
    throw new PinterestError(0, "createPin requires a boardId", "POST", "/pins");
  }
  if (!input.images.length) {
    throw new PinterestError(0, "createPin requires at least one image", "POST", "/pins");
  }
  const media_source =
    input.images.length === 1
      ? {
          source_type: "image_base64" as const,
          content_type: input.images[0].contentType,
          data: input.images[0].data,
        }
      : {
          source_type: "multiple_image_base64" as const,
          items: input.images.map((img) => ({ content_type: img.contentType, data: img.data })),
        };
  const body: Record<string, unknown> = {
    board_id: input.boardId,
    media_source,
  };
  if (input.title) body.title = input.title;
  if (input.description) body.description = input.description;
  if (input.link) body.link = input.link;
  if (input.altText) body.alt_text = input.altText;

  return toPin(await request("POST", "/pins", { body, timeoutMs: CREATE_PIN_TIMEOUT_MS }), "POST /pins");
}

/**
 * GET /pins/{pin_id}. One call, no batch — see this file's docblock. Throws
 * a PinterestError (status 404) for a genuinely missing pin rather than
 * returning null; classifying that as "gone" vs "lookup failed" is the
 * transport's job (isPinterestNotFound), matching how bluesky.ts stays a
 * thin passthrough and leaves the "already gone" call to bluesky-transport.ts.
 */
export async function getPin(pinId: string): Promise<PinterestPin> {
  return toPin(await request("GET", `/pins/${encodeURIComponent(pinId)}`), "GET /pins/:id");
}

/**
 * DELETE /pins/{pin_id} -> 204. Per the vendor's own spec this can also
 * answer a 404 for an id that no longer exists; this function stays a thin
 * passthrough (throws either way) so the "idempotent, already-gone-is-success"
 * business decision belongs to the transport, exactly like bluesky.ts's
 * deleteRecord.
 */
export async function deletePin(pinId: string): Promise<void> {
  await request("DELETE", `/pins/${encodeURIComponent(pinId)}`);
}

export interface PinterestBoard {
  id: string;
  name: string;
}


/**
 * GET /boards, following the `bookmark` cursor to the end.
 *
 * Pagination here is not optional: assertPinterestBoard-shaped callers judge
 * "does this board exist" by scanning the full returned list, so a board
 * sitting past page one would read as UNKNOWN and wrongly refuse a publish
 * (or, worse, wrongly report the account as having none) if this stopped
 * after the first page. `page_size` is requested at the vendor max (100) so
 * a real account's boards - never more than a handful in practice - resolve
 * in one round trip almost always.
 */
export async function listBoards(): Promise<PinterestBoard[]> {
  const out: PinterestBoard[] = [];
  let bookmark: string | undefined;
  for (;;) {
    const s = shape("pinterest", "GET /boards");
    const page = s.obj(await request("GET", withQuery("/boards", { page_size: String(BOARDS_PAGE_SIZE), bookmark })), "(body)");
    for (const b of s.optEach(page.items, "items", (item, at) => {
      const board = s.obj(item, at);
      return { id: s.id(board.id, `${at}.id`), name: s.str(board.name, `${at}.name`) };
    })) {
      out.push(b);
    }
    const next = s.optStr(page.bookmark, "bookmark");
    if (!next) break;
    bookmark = next;
  }
  return out;
}

export interface PinterestAccount {
  id: string;
  username: string;
}

/** GET /user_account. The token's own profile — used for connectStatus(). */
export async function getUserAccount(): Promise<PinterestAccount> {
  const s = shape("pinterest", "GET /user_account");
  const res = s.obj(await request("GET", "/user_account"), "(body)");
  return { id: s.id(res.id, "id"), username: s.id(res.username, "username") };
}

/* -------------------------------------------------------------------------- */
/*  Analytics                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * VERIFIED against developers.pinterest.com/docs/api/v5/pins-analytics and
 * /docs/api/v5/user_account-analytics.
 *
 * ⚠️ UNLIKE EVERY OTHER PLATFORM HERE, Pinterest analytics are WINDOWED, not
 * lifetime: `start_date`, `end_date` and `metric_types` are all REQUIRED, the
 * window cannot start more than 90 days ago, and it cannot span more than 90
 * days. So there is no "total engagement since publication" to ask for, and a
 * number from this endpoint means "in the last 30 days" while the same-named
 * number from Instagram means "ever". They are not comparable, which is one
 * more reason nothing in this family renames metrics into a shared vocabulary.
 */
const ANALYTICS_WINDOW_DAYS = 30;

function analyticsWindow(): { start_date: string; end_date: string } {
  const end = new Date();
  const start = new Date(end.getTime() - ANALYTICS_WINDOW_DAYS * 86_400_000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { start_date: iso(start), end_date: iso(end) };
}

export const PINTEREST_PIN_METRICS = ["IMPRESSION", "PIN_CLICK", "OUTBOUND_CLICK", "SAVE"] as const;

/**
 * Pinterest returns metrics keyed by app type ("ALL", "MOBILE", ...), each
 * carrying `summary_metrics` and, for eligible pins, `lifetime_metrics`. Only
 * ALL is requested, and both shapes are accepted because a response that is
 * already a flat `{ metric: number }` has been observed for some pin formats.
 * An unreadable value is ABSENT rather than 0.
 */
function extractPinterestMetrics(payload: unknown, operation: string): Record<string, number> {
  const s = shape("pinterest", operation);
  if (payload === undefined) return {};
  const root = s.obj(payload, "(body)");
  const all = s.optObj(root.ALL ?? root.all, "ALL");
  const candidate =
    s.optObj(all?.summary_metrics, "ALL.summary_metrics") ?? s.optObj(all?.lifetime_metrics, "ALL.lifetime_metrics") ?? all ?? root;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(candidate)) {
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

export async function getPinAnalytics(pinId: string): Promise<Record<string, number>> {
  const { start_date, end_date } = analyticsWindow();
  const query = new URLSearchParams({
    start_date,
    end_date,
    metric_types: PINTEREST_PIN_METRICS.join(","),
    app_types: "ALL",
  });
  const res = await request("GET", `/pins/${encodeURIComponent(pinId)}/analytics?${query.toString()}`);
  return extractPinterestMetrics(res, "GET /pins/:id/analytics");
}

const PINTEREST_ACCOUNT_METRICS = ["IMPRESSION", "PIN_CLICK", "OUTBOUND_CLICK", "SAVE", "ENGAGEMENT"] as const;

export async function getAccountAnalytics(): Promise<Record<string, number>> {
  const { start_date, end_date } = analyticsWindow();
  const query = new URLSearchParams({
    start_date,
    end_date,
    metric_types: PINTEREST_ACCOUNT_METRICS.join(","),
    app_types: "ALL",
  });
  const res = await request("GET", `/user_account/analytics?${query.toString()}`);
  return extractPinterestMetrics(res, "GET /user_account/analytics");
}

/**
 * Follower count, read as a FIELD on /user_account rather than from analytics —
 * the analytics endpoints are windowed and would answer "followers gained in
 * the last 30 days", which is a different number that looks plausible.
 *
 * THROWS rather than reporting 0, for the same reason as the other platforms.
 */
export async function getFollowerCount(): Promise<{ followers: number }> {
  const s = shape("pinterest", "GET /user_account");
  const raw = s.obj(await request("GET", "/user_account"), "(body)").follower_count;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new PinterestError(
      0,
      "user_account returned no follower_count; refusing to report 0 followers, which would read as a lost audience",
      "GET",
      "/user_account",
    );
  }
  return { followers: raw };
}

/* -------------------------------------------------------------------------- */
/*  Recent pins (the agent publish's crash check)                              */
/* -------------------------------------------------------------------------- */

const RECENT_PINS_PAGE_SIZE = 25;

/**
 * `GET /pins`, the authenticated account's own Pins, first page only, for the
 * agent publish's crash check. Pinterest documents no order for this list, so
 * the page says so (`unordered`), and windowCovers proves the window only when
 * there are no further pages.
 */
export async function listRecentPins(): Promise<RecentPostsPage> {
  const s = shape("pinterest", "GET /pins");
  const page = s.obj(await request("GET", withQuery("/pins", { page_size: String(RECENT_PINS_PAGE_SIZE) })), "(body)");
  const posts = s.optEach(page.items, "items", (item, at) => {
    const p = s.obj(item, at);
    const createdAt = s.optStr(p.created_at, `${at}.created_at`);
    return {
      id: s.id(p.id, `${at}.id`),
      texts: [s.optStr(p.description, `${at}.description`), s.optStr(p.title, `${at}.title`)].filter(
        (t): t is string => t !== undefined,
      ),
      // Pinterest's created_at is UTC with no offset (`2026-11-08T05:00:00`).
      createdAt: createdAt ? toUtcIso(createdAt) : null,
    };
  });
  return { posts, more: Boolean(s.optStr(page.bookmark, "bookmark")), unordered: true };
}

function toUtcIso(value: string): string | null {
  const t = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value}Z`).getTime();
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}
