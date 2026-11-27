// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

/**
 * TikTok Accounts API vendor client (TikTok API for Business, v1.3).
 *
 * Every raw call to business-api.tiktok.com lives here; tiktok-transport.ts
 * decides what a publish, a lookup or a metric MEANS. This is the Accounts API,
 * called on the operator's own approved TikTok API for Business app, NOT
 * developers.tiktok.com's Content Posting API: a different host, a different
 * token, and a different publish model.
 *
 * Three properties of this API that break the defaults every other client in
 * this folder can assume:
 *
 *   - ERRORS ARRIVE AS HTTP 200. Every response is an envelope
 *     `{code, message, request_id, data}` and a refusal is a non-zero `code`
 *     with a 200 status (the Appendix - Return Codes doc). A
 *     client that trusted `res.ok` would read a refusal as an empty success.
 *   - THE ACCOUNT IS NAMED ON EVERY CALL. `business_id` is the `open_id` the
 *     token exchange returned, so the injected resolver supplies it with the
 *     token; the app side keeps it beside the stored credential.
 *   - PUBLISHING IS ASYNCHRONOUS. `/business/video/publish/` answers a
 *     `share_id` (a publishing TASK), TikTok downloads the video from the URL
 *     afterwards, and `/business/publish/status/` says how that went
 *     (the video publish and publish status docs).
 *
 * The rate limits are TikTok's own and are refusals, not unknowns: codes 40016
 * and 40100 ("Requests made too frequently") are marked `rateLimited`, which
 * retry.ts treats as safe to repeat even for a create.
 *
 * Engine rules apply: relative imports only.
 */

import { retryAfterHeader } from "./retry.js";
import { vendorFetch, vendorText, type VendorFetchOptions } from "./vendor-fetch.js";
import { shape, type JsonObject, type Shape } from "./http/shape.js";

export const TIKTOK_API_BASE_URL = "https://business-api.tiktok.com/open_api/v1.3";

/** Reads and the status poll. A local engineering bound, not a vendor figure. */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * The publish call hands TikTok a URL; TikTok fetches the bytes afterwards, so
 * the request itself carries no payload worth a long timeout. Longer than a
 * read anyway, because a timeout here is an UNKNOWN outcome on a create.
 */
const PUBLISH_TIMEOUT_MS = 30_000;

/** "Requests made too frequently" at the app level (the Return Codes doc). */
const RATE_LIMIT_CODES: ReadonlySet<number> = new Set([40016, 40100]);

export class TikTokError extends Error {
  /** TikTok refused before doing anything; retry.ts may repeat even a create. */
  readonly rateLimited: boolean;

  constructor(
    /** HTTP status; 0 when no response arrived (vendor-fetch.ts's contract). */
    public status: number,
    /** The envelope's `code`, or null when there was no envelope to read. */
    public code: number | null,
    message: string,
    method: string,
    path: string,
    /** Raw `Retry-After`, verbatim. retry.ts owns the grammar. */
    public retryAfter: string | null = null,
  ) {
    super(`TikTok ${method} ${path} -> ${code === null ? status : `code ${code}`}: ${message.slice(0, 500)}`);
    this.name = "TikTokError";
    this.rateLimited = code !== null && RATE_LIMIT_CODES.has(code);
  }
}

/** What every call needs: a bearer for the account, and which account it is. */
export interface TikTokCredentials {
  accessToken: string;
  /** The `open_id` from /tt_user/oauth2/token/, passed as `business_id`. */
  businessId: string;
  /** Scopes the grant carries, as TikTok echoed them. Empty when unknown. */
  scopes: string[];
}

export type TikTokCredentialsResolver = () => Promise<TikTokCredentials>;

let _resolver: TikTokCredentialsResolver | null = null;

/**
 * Register (or clear, with null) the resolver that supplies the credential.
 *
 * Injected for the reason every resolver in this folder is: the engine cannot
 * reach the app's encrypted credential store. Called fresh on EVERY request, never memoised
 * here, because the store owns the expiry check: TikTok's access token lives
 * one day, and a copy cached in this file would outlive it.
 */
export function setTikTokCredentialsResolver(resolver: TikTokCredentialsResolver | null): void {
  _resolver = resolver;
}

/** The current credential. Exported so the transport can read the granted scopes. */
export async function tiktokCredentials(): Promise<TikTokCredentials> {
  if (!_resolver) {
    throw new TikTokError(0, null, "no TikTok credentials resolver registered (call setTikTokCredentialsResolver)", "GET", "(resolver)");
  }
  return _resolver();
}

/**
 * One Accounts API call, its envelope (`{ code, message, data }`) read through
 * a Shape: `code` must be a number, a non-zero code is the vendor's refusal
 * (with `message` kept only when it is a string), and on code 0 `data` must be
 * an object. The caller reads `data`'s fields with the returned Shape.
 */
async function request(
  method: "GET" | "POST",
  path: string,
  creds: TikTokCredentials,
  opts: { query?: Record<string, string>; body?: unknown; timeoutMs?: number },
): Promise<{ s: Shape; data: JsonObject }> {
  const url = `${TIKTOK_API_BASE_URL}${path}${opts.query ? `?${new URLSearchParams(opts.query).toString()}` : ""}`;
  const resOpts: VendorFetchOptions = {
    timeoutMs: opts.timeoutMs ?? REQUEST_TIMEOUT_MS,
    wrap: (status, message) => new TikTokError(status, null, message, method, path),
  };
  const res = await vendorFetch(
    url,
    {
      method,
      headers: {
        // Not `Authorization: Bearer`: every Accounts API endpoint names this
        // header (e.g. the video publish doc, "Access-Token {Required}").
        "Access-Token": creds.accessToken,
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    },
    resOpts,
  );
  const text = await vendorText(res, resOpts);
  if (!res.ok) throw new TikTokError(res.status, null, text, method, path, retryAfterHeader(res));
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new TikTokError(res.status, null, `expected JSON, got: ${text.slice(0, 200)}`, method, path);
  }
  const s = shape("tiktok", `${method} ${path}`);
  const envelope = s.obj(parsed, "(body)");
  const code = s.num(envelope.code, "code");
  if (code !== 0) {
    const message = typeof envelope.message === "string" ? envelope.message : `TikTok refused the request (code ${code})`;
    throw new TikTokError(res.status, code, message, method, path, retryAfterHeader(res));
  }
  return { s, data: s.obj(envelope.data, "data") };
}

/** A JSON array in a query parameter, which is how these GETs take string[] (the account profile doc). */
function jsonParam(value: unknown): string {
  return JSON.stringify(value);
}

/* -------------------------------------------------------------------------- */
/*  Publishing                                                                 */
/* -------------------------------------------------------------------------- */

export interface TikTokVideoPublishInput {
  /**
   * A public HTTPS URL TikTok downloads the video from. ⛔ It must sit on a
   * URL property VERIFIED for the app ("Starting from November 16th, 2023, you
   * can no longer publish videos using unverified video URLs", the
   * video publish doc), or TikTok refuses the task.
   */
  videoUrl: string;
  caption: string;
  /** `post_info.is_brand_organic`: "promoting yourself or your own business". */
  brandOrganic: boolean;
  disableComment: boolean;
  disableDuet: boolean;
  disableStitch: boolean;
  /** `post_info.is_ai_generated`: the "Creator labeled as AI-generated" label. */
  aiGenerated: boolean;
}

/**
 * POST /business/video/publish/ (the video publish doc). Starts a publishing
 * task and returns its `share_id`; the video is NOT live when this returns.
 *
 * `post_info` is required even when empty, and `is_brand_organic` and
 * `is_branded_content` are both marked required inside it, so every field is
 * sent explicitly. `is_branded_content` is always false: the engine publishes
 * an account's own brand promoting itself, never a paid partnership.
 */
export async function publishVideo(input: TikTokVideoPublishInput): Promise<{ shareId: string }> {
  const creds = await tiktokCredentials();
  // `share_id` is on every documented success ("Unique identifier for the
  // video post publishing task"); a success without one is a shape error,
  // which retry.ts counts as an unknown outcome, so the publish is never re-sent.
  const { s, data } = await request("POST", "/business/video/publish/", creds, {
    timeoutMs: PUBLISH_TIMEOUT_MS,
    body: {
      business_id: creds.businessId,
      video_url: input.videoUrl,
      post_info: {
        caption: input.caption,
        is_brand_organic: input.brandOrganic,
        is_branded_content: false,
        disable_comment: input.disableComment,
        disable_duet: input.disableDuet,
        disable_stitch: input.disableStitch,
        is_ai_generated: input.aiGenerated,
      },
    },
  });
  return { shareId: s.id(data.share_id, "data.share_id") };
}

/**
 * `/business/publish/status/`'s documented `status` values (the publish status doc).
 * `SEND_TO_USER_INBOX` belongs to a draft upload (`upload_to_draft`), which
 * this client never sends.
 */
export type TikTokPublishStatus = "PROCESSING_DOWNLOAD" | "PUBLISH_COMPLETE" | "FAILED" | "SEND_TO_USER_INBOX";

const PUBLISH_STATUSES: readonly TikTokPublishStatus[] = ["PROCESSING_DOWNLOAD", "PUBLISH_COMPLETE", "FAILED", "SEND_TO_USER_INBOX"];

export interface TikTokPublishState {
  status: TikTokPublishStatus;
  /**
   * "Returned only when `status` is `PUBLISH_COMPLETE` and the posts are
   * publicly viewable", and "Post IDs require up to three minutes of processing
   * time", so empty is normal for a while after completion.
   */
  postIds: string[];
  /** "Returned only when `status` is `FAILED`", e.g. `frame_rate_check_failed`. */
  reason?: string;
}

/** GET /business/publish/status/ (the publish status doc). */
export async function publishStatus(shareId: string): Promise<TikTokPublishState> {
  const creds = await tiktokCredentials();
  const { s, data } = await request("GET", "/business/publish/status/", creds, {
    query: { business_id: creds.businessId, publish_id: shareId },
  });
  // A status outside the documented four is refused, not read as "still processing".
  const raw = s.str(data.status, "data.status");
  const status = PUBLISH_STATUSES.find((v) => v === raw) ?? s.fail("data.status", `one of ${PUBLISH_STATUSES.join(", ")}`, raw);
  const reason = s.optStr(data.reason, "data.reason");
  return {
    status,
    postIds: s.optEach(data.post_ids, "data.post_ids", (id, at) => s.id(id, at)),
    ...(reason ? { reason } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/*  Account and post data                                                      */
/* -------------------------------------------------------------------------- */

export interface TikTokProfile {
  businessId: string;
  /** Default field, scope `user.info.basic`. */
  displayName?: string;
  /** Asked for explicitly, scope `user.info.stats`. Absent when not asked or not granted. */
  followersCount?: number;
}

/**
 * GET /business/get/ (the account profile doc).
 *
 * With no `fields` TikTok returns its defaults, `display_name` and
 * `profile_image`, which need only `user.info.basic`. Every other field needs
 * its own scope (`followers_count`: user.info.stats), so callers ask only for
 * what they use.
 */
export async function getProfile(fields?: readonly string[]): Promise<TikTokProfile> {
  const creds = await tiktokCredentials();
  const { s, data } = await request("GET", "/business/get/", creds, {
    query: { business_id: creds.businessId, ...(fields ? { fields: jsonParam(fields) } : {}) },
  });
  return {
    businessId: creds.businessId,
    displayName: s.optStr(data.display_name, "data.display_name"),
    followersCount: s.optNum(data.followers_count, "data.followers_count"),
  };
}

/**
 * The counters asked of /business/video/list/. Each needs only `video.list`
 * (the "Required permission" column of the video list doc); the watch-time
 * fields need `video.insights` and are not asked.
 */
export const TIKTOK_POST_METRIC_FIELDS = ["video_views", "likes", "comments", "shares", "favorites", "reach"] as const;

/**
 * Lifetime counters for one post: GET /business/video/list/ filtered by
 * `video_ids` (the video list doc).
 *
 * Returns null when TikTok does not list the post. That is not a definitive
 * "deleted": the doc names "filtered out due to violations, such as music
 * copyright violation" as the likely reason.
 */
export async function getPostMetrics(postId: string): Promise<Record<string, number> | null> {
  const creds = await tiktokCredentials();
  const { s, data } = await request("GET", "/business/video/list/", creds, {
    query: {
      business_id: creds.businessId,
      // "you need to at least include item_id" when asking for several fields.
      fields: jsonParam(["item_id", ...TIKTOK_POST_METRIC_FIELDS]),
      filters: jsonParam({ video_ids: [postId] }),
    },
  });
  // Every listed video is read: `item_id` a non-empty string, each counter
  // asked for a finite number or absent (absent stays absent, never 0).
  const videos = s.each(data.videos, "data.videos", (item, at) => {
    const v = s.obj(item, at);
    const metrics: Record<string, number> = {};
    for (const field of TIKTOK_POST_METRIC_FIELDS) {
      const value = s.optNum(v[field], `${at}.${field}`);
      if (value !== undefined) metrics[field] = value;
    }
    return { id: s.id(v.item_id, `${at}.item_id`), metrics };
  });
  return videos.find((v) => v.id === postId)?.metrics ?? null;
}
