/**
 * X (Twitter) API v2 vendor client.
 *
 * Plays the same role for this platform that pinterest.ts and linkedin.ts play
 * for theirs: every raw call to api.x.com lives here, and nothing above this
 * file touches `fetch` directly. Two things distinguish this vendor from the
 * others already built:
 *
 *   - reading costs money. X's v2 API is pay-per-use ($0.015/post created,
 *     $0.200/post created WITH a url, $0.005/post READ, capped at 2M reads per
 *     billing cycle, per the pricing page). No other vendor in
 *     this engine charges per lookup, which is why getTweetsBatch below is
 *     batched and postFacts (x-transport.ts) chunks into it rather than ever
 *     looping GET /tweets one id at a time.
 *   - media is bytes, not a public URL. Unlike Instagram/Threads (which hand
 *     the vendor a fetchable image_url and let it download server-side), X
 *     wants the raw bytes uploaded through it via POST /2/media/upload. The
 *     upload is a three-step INIT/APPEND/FINALIZE dance even for a single
 *     small image — see uploadImage().
 *
 * Vendor facts below were verified against docs.x.com pages named inline on
 * each function, not assumed from training data or third-party
 * blogs. Where a page did not spell something out, the comment says so rather
 * than asserting it.
 *
 * Engine rules apply: relative imports only.
 */

import type { RecentPostsPage } from "./recent-posts.js";
import { retryAfterHeader } from "./retry.js";
import { vendorFetch, vendorText, type VendorFetchOptions } from "./vendor-fetch.js";
import { shape, type Shape } from "./http/shape.js";

const BASE_URL = "https://api.x.com/2";

/** Matches every other vendor client here: a hung connection must not hold a publish request open indefinitely. */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * A single-shot image APPEND (this client does not implement multi-chunk
 * upload; see uploadImage()) needs longer than a plain JSON call, matching
 * the budget pinterest.ts reserves for its own media path, but not the 120s
 * some vendor clients use for much larger payloads: X's own image cap
 * is 5MB (best-practices page), an order of magnitude below what those
 * timeouts were sized for.
 */
const MEDIA_UPLOAD_TIMEOUT_MS = 30_000;

/** Bounded poll for FINALIZE's processing_info to leave pending/in_progress. See ensureProcessed(). */
const MEDIA_STATUS_MAX_ATTEMPTS = 5;
const MEDIA_STATUS_INTERVAL_MS = 2000;

export class XError extends Error {
  constructor(
    public status: number,
    public body: string,
    method: string,
    path: string,
    /**
     * The vendor's raw `Retry-After` header, verbatim and unparsed — see
     * `RetryAfterCarrier` in retry.ts, which owns the grammar. Null on every
     * error that did not come from a real HTTP response (timeouts, missing
     * token), because those carry no vendor instruction at all.
     */
    public retryAfter: string | null = null,
  ) {
    super(`X ${method} ${path} -> ${status}: ${body.slice(0, 500)}`);
  }
}

/** True when the vendor gave a definitive "this id does not exist" answer (a plain HTTP 404). */
export function isXNotFound(err: unknown): boolean {
  return err instanceof XError && err.status === 404;
}

export type XTokenResolver = () => Promise<string>;

let _resolver: XTokenResolver | null = null;

/**
 * Register (or clear, with null) the resolver that supplies a bearer access
 * token.
 *
 * INJECTED rather than imported, exactly like setPinterestTokenResolver and
 * setLinkedInTokenResolver: this folder is the portable engine and cannot
 * reach the app's credential store itself (that needs the app's database and
 * encryption keys).
 *
 * ⚠️ Deliberately called fresh on EVERY request, never cached here. X's own
 * endpoints (POST /2/tweets, DELETE /2/tweets, GET /2/tweets, GET /2/users/me,
 * POST /2/media/upload) all require a real OAuth 2.0 user-context token
 * ("App-Only Bearer Token authentication is not supported" — the
 * authenticated-lookup doc, verified for GET /2/users/me and true of the
 * writes as well), which means a real refresh cycle behind the resolver. A
 * token cached in THIS file with no expiry check would keep serving an
 * expired token forever once the app-side resolver rotates past it — the same
 * reasoning pinterest.ts's docblock gives for not caching a second copy of
 * what the app's token store already owns. If a future reader
 * is tempted to "optimize" this into a per-process cache: don't. That is
 * exactly the bug this comment exists to head off.
 */
export function setXTokenResolver(resolver: XTokenResolver | null): void {
  _resolver = resolver;
}

async function token(): Promise<string> {
  if (!_resolver) {
    throw new XError(0, "no X token resolver registered (call setXTokenResolver)", "GET", "(resolver)");
  }
  const t = await _resolver();
  if (!t) {
    throw new XError(0, "X token resolver returned an empty token", "GET", "(resolver)");
  }
  return t;
}

async function request(method: string, path: string, opts: { body?: unknown; timeoutMs?: number } = {}): Promise<unknown> {
  const accessToken = await token();
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const resOpts: VendorFetchOptions = { timeoutMs, wrap: (status, message) => new XError(status, message, method, path) };
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
  const text = await vendorText(res, resOpts);
  if (!res.ok) throw new XError(res.status, text, method, path, retryAfterHeader(res));
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new XError(res.status, `expected JSON, got: ${text.slice(0, 200)}`, method, path);
  }
}

/**
 * Same request/error/timeout handling as request() above, but for the
 * multipart/form-data body POST /2/media/upload wants (VERIFIED against
 * https://docs.x.com/x-api/media/quickstart/media-upload-chunked: every
 * INIT/APPEND/FINALIZE example is `-F "command=..." -F
 * ...`, i.e. multipart form fields, not a JSON body). No Content-Type header
 * is set here on purpose — fetch computes the multipart boundary itself from
 * the FormData instance, and setting one manually would strip it.
 */
async function mediaUploadRequest(form: FormData, opts: { timeoutMs?: number } = {}): Promise<unknown> {
  const accessToken = await token();
  const timeoutMs = opts.timeoutMs ?? MEDIA_UPLOAD_TIMEOUT_MS;
  const resOpts: VendorFetchOptions = {
    timeoutMs,
    label: "media upload",
    wrap: (status, message) => new XError(status, message, "POST", "/media/upload"),
  };
  const res = await vendorFetch(
    `${BASE_URL}/media/upload`,
    { method: "POST", headers: { Authorization: `Bearer ${accessToken}` }, body: form },
    resOpts,
  );
  const text = await vendorText(res, resOpts);
  if (!res.ok) {
    throw new XError(res.status, text, "POST", "/media/upload", retryAfterHeader(res));
  }
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new XError(res.status, `expected JSON, got: ${text.slice(0, 200)}`, "POST", "/media/upload");
  }
}

async function mediaStatusRequest(mediaId: string): Promise<XMediaUploadResponse> {
  const accessToken = await token();
  const resOpts: VendorFetchOptions = {
    timeoutMs: REQUEST_TIMEOUT_MS,
    label: "media status",
    wrap: (status, message) => new XError(status, message, "GET", "/media/upload"),
  };
  const res = await vendorFetch(
    `${BASE_URL}/media/upload?command=STATUS&media_id=${encodeURIComponent(mediaId)}`,
    { method: "GET", headers: { Authorization: `Bearer ${accessToken}` } },
    resOpts,
  );
  const text = await vendorText(res, resOpts);
  if (!res.ok) {
    throw new XError(res.status, text, "GET", "/media/upload", retryAfterHeader(res));
  }
  if (!text) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new XError(res.status, `expected JSON, got: ${text.slice(0, 200)}`, "GET", "/media/upload");
  }
  return readMediaUploadResponse(parsed, "GET /media/upload STATUS");
}

/* -------------------------------------------------------------------------- */
/*  Posts                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * VERIFIED against https://docs.x.com/x-api/posts/create-post:
 * the enum has NO "everyone" value; omitting the field entirely
 * is how a post allows anyone to reply (this is the X product's own default;
 * the field's own doc text does not spell out the omitted-default explicitly,
 * so that inference is carried here rather than as a confirmed vendor
 * statement).
 */
export type XReplySettings = "following" | "mentionedUsers" | "subscribers" | "verified";

export interface CreateTweetInput {
  text: string;
  /** Already-uploaded media ids (see uploadImage). Vendor caps at 4 (media.media_ids maxItems). */
  mediaIds?: string[];
  /** POST /2/tweets `reply.in_reply_to_tweet_id`. */
  inReplyToTweetId?: string;
  /** Omit for "everyone can reply" — see XReplySettings' docblock. */
  replySettings?: XReplySettings;
}

export interface XTweet {
  id: string;
  text: string;
}


/**
 * POST /2/tweets. VERIFIED against https://docs.x.com/x-api/posts/create-post:
 * request body shape (`text`, `reply.in_reply_to_tweet_id`,
 * `media.media_ids` up to 4, `reply_settings` enum), response shape (201 with
 * `{ data: { id, text }, errors: [] }`). `media` and `reply` are independent
 * fields on the body — verified NOT mutually exclusive with each other (the
 * doc's stated exclusions for `media` are quote_tweet_id/poll/card_uri/DM deep
 * link, reply is not among them), which is what lets a reply carry its own
 * image.
 */
export async function createTweet(input: CreateTweetInput): Promise<XTweet> {
  const body: Record<string, unknown> = { text: input.text };
  if (input.inReplyToTweetId) body.reply = { in_reply_to_tweet_id: input.inReplyToTweetId };
  if (input.mediaIds?.length) body.media = { media_ids: input.mediaIds };
  if (input.replySettings) body.reply_settings = input.replySettings;

  const s = shape("x", "POST /tweets");
  const res = s.obj(await request("POST", "/tweets", { body }), "(body)");
  const data = s.optObj(res.data, "data");
  const id = s.optId(data?.id, "data.id");
  if (!id) {
    throw new XError(0, "tweet created but no id was returned", "POST", "/tweets");
  }
  return { id, text: s.optStr(data?.text, "data.text") ?? input.text };
}

/**
 * DELETE /2/tweets/{id}. VERIFIED against
 * https://docs.x.com/x-api/posts/delete-post: success is
 * `{ data: { deleted: true } }`; a `ResourceNotFoundProblem` schema exists on
 * this endpoint for a tweet id that does not exist (`resource_type: "tweet"`).
 *
 * ⚠️ NOT verified: the page has no worked example of what re-deleting an
 * ALREADY-deleted id returns — whether it re-answers `deleted:true` or a
 * ResourceNotFoundProblem. This function stays a thin passthrough that throws
 * on any non-2xx (matching pinterest.ts's deletePin / linkedin.ts's
 * deletePost); the "already gone is success" business decision belongs to the
 * transport, via isXNotFound's status-404 check — a reasonable inference from
 * the documented error schema, not a confirmed worked example.
 */
export async function deleteTweet(id: string): Promise<void> {
  // `{ data: { deleted: true } }`, or no body. A `deleted: false` is refused:
  // the caller would otherwise report a post as deleted that X says is not.
  const res = await request("DELETE", `/tweets/${encodeURIComponent(id)}`);
  if (res === undefined) return;
  const s = shape("x", "DELETE /tweets/:id");
  const deleted = s.optBool(s.optObj(s.obj(res, "(body)").data, "data")?.deleted, "data.deleted");
  if (deleted === false) s.fail("data.deleted", "true", deleted);
}

/* -------------------------------------------------------------------------- */
/*  Batch lookup                                                              */
/* -------------------------------------------------------------------------- */

export interface XProblem {
  type?: string;
  title?: string;
  detail?: string;
  status?: number;
  resource_id?: string;
  resource_type?: string;
  parameter?: string;
  value?: string;
}

export interface XTweetsBatchResult {
  data: XTweet[];
  errors: XProblem[];
}

/** One RFC 7807 problem from a batch lookup's `errors`, every field optional. */
function readProblem(s: Shape, value: unknown, at: string): XProblem {
  const p = s.obj(value, at);
  const problem: XProblem = {};
  for (const key of ["type", "title", "detail", "resource_id", "resource_type", "parameter", "value"] as const) {
    const v = s.optStr(p[key], `${at}.${key}`);
    if (v !== undefined) problem[key] = v;
  }
  const status = s.optNum(p.status, `${at}.status`);
  if (status !== undefined) problem.status = status;
  return problem;
}

/**
 * GET /2/tweets?ids=. VERIFIED against
 * https://docs.x.com/x-api/posts/get-posts-by-ids: "Up to
 * 100 are allowed in a single request", `ids` is "A comma separated list of
 * Post IDs", and a missing/deleted id surfaces as an RFC 7807 Problem in the
 * response's `errors` array with
 * `type: "https://api.twitter.com/2/problems/resource-not-found"` plus
 * `resource_id`/`resource_type` naming which id — i.e. this is NOT a silent
 * omission the way Bluesky's getPosts is; X states the absence explicitly.
 *
 * 💰 This call is NOT free — X bills $0.005 per Post READ, capped at 2M/billing
 * cycle (per the pricing page, see x-transport.ts's postFacts
 * docblock). One call here reads up to 100 posts at once, which is why
 * x-transport.ts's postFacts chunks into this rather than ever calling
 * GET /2/tweets/{id} once per ref in a loop — that would be the same
 * information for a much larger bill. One call, no internal chunking here
 * (matches bluesky.ts's getPosts / linkedin.ts's getPostsBatch); the caller
 * chunks at the 100-id limit.
 */
export async function getTweetsBatch(ids: string[]): Promise<XTweetsBatchResult> {
  if (!ids.length) return { data: [], errors: [] };
  const s = shape("x", "GET /tweets");
  const res = s.obj(await request("GET", `/tweets?ids=${ids.map(encodeURIComponent).join(",")}`), "(body)");
  return {
    data: s.optEach(res.data, "data", (t, at) => {
      const tweet = s.obj(t, at);
      return { id: s.id(tweet.id, `${at}.id`), text: s.optStr(tweet.text, `${at}.text`) ?? "" };
    }),
    errors: s.optEach(res.errors, "errors", (p, at) => readProblem(s, p, at)),
  };
}

/* -------------------------------------------------------------------------- */
/*  Media upload                                                              */
/* -------------------------------------------------------------------------- */

/**
 * VERIFIED against https://docs.x.com/x-api/media/quickstart/best-practices:
 * "Images ... JPG, PNG, GIF, WEBP" under the ≤5MB image
 * cap. `image/gif` is deliberately excluded from this map even though the
 * vendor prose lists GIF under "Images": this engine's own MediaAsset already
 * separates a still image from an animated one via `type: "gif"`, and animated
 * GIFs go through uploadGif's async media_category=tweet_gif path (with
 * STATUS polling, see ensureProcessed) rather than through this map.
 */
export type XImageMimeType = "image/jpeg" | "image/png" | "image/webp";

interface XProcessingInfo {
  state?: string;
  check_after_secs?: number;
  error?: { message?: string };
}

interface XMediaUploadResponse {
  data?: { id?: string; processing_info?: XProcessingInfo };
}

/** A media upload or STATUS answer: the fields uploadMedia and ensureProcessed read. */
function readMediaUploadResponse(value: unknown, operation: string): XMediaUploadResponse {
  if (value === undefined) return {};
  const s = shape("x", operation);
  const data = s.optObj(s.obj(value, "(body)").data, "data");
  if (!data) return {};
  const info = s.optObj(data.processing_info, "data.processing_info");
  const error = s.optObj(info?.error, "data.processing_info.error");
  return {
    data: {
      id: s.optId(data.id, "data.id"),
      processing_info: info && {
        state: s.optStr(info.state, "data.processing_info.state"),
        check_after_secs: s.optNum(info.check_after_secs, "data.processing_info.check_after_secs"),
        error: error && { message: s.optStr(error.message, "data.processing_info.error.message") },
      },
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Bounded poll for FINALIZE's `processing_info` to leave pending/in_progress.
 *
 * ⚠️ UNVERIFIED how often this actually fires for a still image specifically:
 * the chunked-upload quickstart states "Videos and GIFs require server-side
 * processing after finalization" but does not say images never do, only that
 * "if `processing_info` is present in the FINALIZE response, you must poll for
 * completion before attaching the media to a post" without carving out images
 * as always-synchronous. For a still image this poll is a defensive path
 * expected to no-op (no `processing_info` in the FINALIZE response); for a
 * video or GIF (uploadVideo / uploadGif) it is the primary path.
 */
async function ensureProcessed(mediaId: string, initial: XProcessingInfo | undefined): Promise<void> {
  let info = initial;
  let attempt = 0;
  while (info?.state === "pending" || info?.state === "in_progress") {
    if (attempt >= MEDIA_STATUS_MAX_ATTEMPTS) {
      throw new XError(
        0,
        `media ${mediaId} still ${info.state} after ${attempt} status checks; giving up rather than attaching a possibly-unready media id`,
        "GET",
        "/media/upload",
      );
    }
    // `check_after_secs: 0` is a real, meaningful value ("check again right
    // away"), not an absent one — a falsy check here would silently fall back
    // to the 2s default and turn a fast-resolving upload into a needlessly
    // slow one, so this tests for the field's PRESENCE, not its truthiness.
    await sleep(info.check_after_secs !== undefined ? info.check_after_secs * 1000 : MEDIA_STATUS_INTERVAL_MS);
    const statusRes = await mediaStatusRequest(mediaId);
    info = statusRes.data?.processing_info;
    attempt++;
  }
  if (info?.state === "failed") {
    throw new XError(0, `media ${mediaId} failed processing: ${info.error?.message ?? "unknown error"}`, "POST", "/media/upload");
  }
}

/**
 * Chunked upload via INIT -> APPEND(segment_index=0..n) -> FINALIZE.
 *
 * VERIFIED against https://docs.x.com/x-api/media/quickstart/media-upload-chunked:
 * INIT takes `media_type`/`total_bytes`/`media_category`
 * as multipart fields, APPEND takes `media_id`/`segment_index`/`media` (the raw
 * chunk, as a multipart file field — NOT base64 in JSON), FINALIZE takes just
 * `media_id`, and the created media's id comes back as response `data.id` (not
 * `media_id`/`media_id_string` — the older v1.1 field names).
 *
 * ⚠️ A LOOP OF APPENDS, NOT A SINGLE ONE. A still image is capped at 5MB and
 * always fits one segment, but a video does not, and channelRules advertises
 * X's video limits, so a single-APPEND path would have the QA gate checking a
 * limit against an upload path that could not carry it.
 *
 * Segments are ordered and sequential on purpose. X assembles the media from
 * `segment_index`, so uploading them concurrently is not safe to assume even
 * where it happens to work, and a 512MB video is not worth discovering that on.
 */
const APPEND_CHUNK_BYTES = 4 * 1024 * 1024;

export type XMediaCategory = "tweet_image" | "tweet_video" | "tweet_gif";

export async function uploadMedia(
  bytes: Uint8Array<ArrayBuffer>,
  mimeType: string,
  category: XMediaCategory,
): Promise<string> {
  const initForm = new FormData();
  initForm.set("command", "INIT");
  initForm.set("media_type", mimeType);
  initForm.set("total_bytes", String(bytes.byteLength));
  initForm.set("media_category", category);
  const initRes = readMediaUploadResponse(await mediaUploadRequest(initForm), "POST /media/upload INIT");
  const mediaId = initRes.data?.id;
  if (!mediaId) {
    throw new XError(0, "media INIT returned no id", "POST", "/media/upload");
  }

  // A zero-byte asset would otherwise send NO append at all and then FINALIZE,
  // which X accepts and turns into a media id that fails when attached.
  if (bytes.byteLength === 0) {
    throw new XError(0, "refusing to upload a zero-byte asset", "POST", "/media/upload");
  }

  for (let offset = 0, segment = 0; offset < bytes.byteLength; offset += APPEND_CHUNK_BYTES, segment++) {
    const chunk = bytes.subarray(offset, Math.min(offset + APPEND_CHUNK_BYTES, bytes.byteLength));
    const appendForm = new FormData();
    appendForm.set("command", "APPEND");
    appendForm.set("media_id", mediaId);
    appendForm.set("segment_index", String(segment));
    appendForm.set("media", new Blob([chunk], { type: mimeType }));
    await mediaUploadRequest(appendForm);
  }

  const finalizeForm = new FormData();
  finalizeForm.set("command", "FINALIZE");
  finalizeForm.set("media_id", mediaId);
  const finalizeRes = readMediaUploadResponse(await mediaUploadRequest(finalizeForm), "POST /media/upload FINALIZE");

  // For video and GIF this is the PRIMARY path, not the defensive one it was
  // for images: X documents both as requiring server-side processing after
  // finalization, and attaching an unready media id fails the post.
  await ensureProcessed(mediaId, finalizeRes.data?.processing_info);
  return mediaId;
}

/**
 * Still images. Kept as its own export so the ~existing call sites and the
 * XImageMimeType guard stay unchanged, and so the category cannot be passed
 * wrongly at a call site that only ever sends images.
 */
export async function uploadImage(bytes: Uint8Array<ArrayBuffer>, mimeType: XImageMimeType): Promise<string> {
  return uploadMedia(bytes, mimeType, "tweet_image");
}

/**
 * VERIFIED against https://docs.x.com/x-api/media/quickstart/best-practices:
 * MP4 and MOV, ≤512MB, ≤140s.
 *
 * ⚠️ `media_category` MATTERS BEYOND LABELLING. tweet_video and tweet_gif take
 * different processing paths at X's end, and an animated GIF uploaded as
 * tweet_video is accepted and then behaves as a video (no autoplay loop),
 * which is why the two have separate entry points here rather than one
 * "upload the bytes" call that guesses from the mime type.
 */
export type XVideoMimeType = "video/mp4" | "video/quicktime";

export async function uploadVideo(bytes: Uint8Array<ArrayBuffer>, mimeType: XVideoMimeType): Promise<string> {
  return uploadMedia(bytes, mimeType, "tweet_video");
}

export async function uploadGif(bytes: Uint8Array<ArrayBuffer>, mimeType: "image/gif"): Promise<string> {
  return uploadMedia(bytes, mimeType, "tweet_gif");
}

/* -------------------------------------------------------------------------- */
/*  Account                                                                    */
/* -------------------------------------------------------------------------- */

export interface XProfile {
  id: string;
  username: string;
  name?: string;
}


/**
 * GET /2/users/me. VERIFIED against
 * https://docs.x.com/x-api/users/lookup/quickstart/authenticated-lookup:
 * response is `{ data: { id, name, username, ... } }`;
 * "App-Only (Bearer Token) authentication is not supported" — this endpoint
 * (and every other one in this file) needs the real user-context token the
 * injected resolver supplies.
 */
export async function getMe(): Promise<XProfile> {
  const s = shape("x", "GET /users/me");
  const res = s.obj(await request("GET", "/users/me"), "(body)");
  const data = s.optObj(res.data, "data");
  const id = s.optId(data?.id, "data.id");
  const username = s.optId(data?.username, "data.username");
  if (!id || !username) {
    throw new XError(0, "GET /users/me returned no id/username", "GET", "/users/me");
  }
  return { id, username, name: s.optStr(data?.name, "data.name") };
}

/* -------------------------------------------------------------------------- */
/*  Analytics                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Per-post engagement, via `tweet.fields=public_metrics`.
 *
 * 💰 THIS IS A BILLED READ, $0.005 per Post, exactly like getTweetsBatch — the
 * field selector rides along on the same lookup and does not add a second
 * charge, but calling this at all is a charge. X is the only platform in this
 * engine where reading analytics costs money, and the only one that answers
 * `402 credits depleted` when the balance runs out, which surfaces to the
 * caller as an ordinary XError rather than as empty analytics.
 *
 * VERIFIED against docs.x.com/x-api/posts/lookup:
 * public_metrics carries retweet_count, reply_count, like_count, quote_count,
 * bookmark_count and impression_count.
 *
 * ⛔ `non_public_metrics` and `organic_metrics` are deliberately NOT requested.
 * They need the elevated `tweet.read` + owner context and, more importantly,
 * they 403 for posts older than 30 days — which would fail the whole call for
 * an old post rather than returning the public numbers that ARE available.
 */
function finiteOnly(bag: Record<string, unknown> | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(bag ?? {})) {
    // Absent, never 0 — but a vendor-reported zero is kept.
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

/** `data.public_metrics` of a lookup: an object or absent. Its values are filtered by finiteOnly. */
function publicMetrics(value: unknown, operation: string): Record<string, unknown> | undefined {
  const s = shape("x", operation);
  return s.optObj(s.optObj(s.obj(value, "(body)").data, "data")?.public_metrics, "data.public_metrics");
}

export async function getTweetMetrics(id: string): Promise<Record<string, number>> {
  return finiteOnly(publicMetrics(await request("GET", `/tweets/${encodeURIComponent(id)}?tweet.fields=public_metrics`), "GET /tweets/:id"));
}

/**
 * Account totals from `GET /users/me?user.fields=public_metrics`.
 *
 * 💰 A user lookup, not a Post read. X does not bill this on the per-Post meter,
 * but it still consumes the account's request allowance.
 */
export async function getMyMetrics(): Promise<Record<string, number>> {
  return finiteOnly(publicMetrics(await request("GET", "/users/me?user.fields=public_metrics"), "GET /users/me"));
}

/**
 * Follower count. THROWS when the field is missing rather than reporting 0 —
 * on X specifically, a fabricated zero would be indistinguishable from the
 * account having been suspended.
 */
export async function getFollowerCount(): Promise<{ followers: number }> {
  const metrics = await getMyMetrics();
  const raw = metrics.followers_count;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new XError(
      0,
      "users/me public_metrics carried no followers_count; refusing to report 0, which on X is " +
        "indistinguishable from a suspended account",
      "GET",
      "/users/me",
    );
  }
  return { followers: raw };
}

/**
 * Attach accessible alt text to an already-uploaded media id.
 *
 * VERIFIED against docs.x.com/x-api/media/create-media-metadata:
 * POST /2/media/metadata, body `{ id, metadata: { alt_text: { text } } }`.
 *
 * ⚠️ SEPARATE CALL, AFTER upload and BEFORE the post. X has no alt-text
 * parameter on the upload itself, so a client that only uploads publishes an
 * image with no description and nothing anywhere reports a problem.
 *
 * NON-FATAL BY CONTRACT. A failure here must not sink a publish whose media has
 * already been uploaded and is about to be attached: the post is still worth
 * making, and losing it over a missing description would be a worse outcome for
 * the same user this call exists to serve. The caller logs and continues.
 */
export const X_ALT_TEXT_MAX = 1000;

export async function setMediaAltText(mediaId: string, altText: string): Promise<void> {
  const text = altText.trim();
  if (!text) return;
  await request("POST", "/media/metadata", {
    // X rejects alt text over 1000 characters for the whole request rather than
    // truncating it, which would fail the media metadata call for a long
    // description. Trimmed here so a verbose alt degrades instead of erroring.
    body: { id: mediaId, metadata: { alt_text: { text: text.slice(0, X_ALT_TEXT_MAX) } } },
  });
}

/* -------------------------------------------------------------------------- */
/*  Recent posts (the agent publish's crash check)                             */
/* -------------------------------------------------------------------------- */


/**
 * `GET /2/users/{id}/tweets` from `since`, replies and reposts excluded: the
 * account's own roots, newest first, for the agent publish's crash check.
 * `note_tweet` is asked for because `text` stops at 280 characters on a long
 * post.
 *
 * 💰 A billed read, like getTweetsBatch: it is charged per Post returned, and
 * the window is minutes, so it is a handful.
 */
export async function listRecentTweets(since: Date): Promise<RecentPostsPage> {
  const me = await getMe();
  const query = new URLSearchParams({
    start_time: since.toISOString(),
    max_results: "100",
    exclude: "replies,retweets",
    "tweet.fields": "created_at,note_tweet",
  });
  const s = shape("x", "GET /users/:id/tweets");
  const res = s.obj(await request("GET", `/users/${encodeURIComponent(me.id)}/tweets?${query.toString()}`), "(body)");
  const posts = s.optEach(res.data, "data", (item, at) => {
    const t = s.obj(item, at);
    const note = s.optObj(t.note_tweet, `${at}.note_tweet`);
    return {
      id: s.id(t.id, `${at}.id`),
      texts: [s.optStr(note?.text, `${at}.note_tweet.text`), s.optStr(t.text, `${at}.text`)].filter(
        (v): v is string => v !== undefined,
      ),
      createdAt: s.optStr(t.created_at, `${at}.created_at`) ?? null,
    };
  });
  return { posts, more: Boolean(s.optStr(s.optObj(res.meta, "meta")?.next_token, "meta.next_token")) };
}
