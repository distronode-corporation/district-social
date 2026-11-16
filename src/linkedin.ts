/**
 * LinkedIn REST API vendor client.
 *
 * Plays the same role for this one platform that bluesky.ts plays for
 * Bluesky: every raw call to the vendor lives here, and nothing above this
 * file touches `fetch` against api.linkedin.com directly. Two things this file
 * owns that an aggregator client never has to think about:
 *
 *   - identity. LinkedIn's bearer token says who is AUTHENTICATED, but every
 *     write also needs an `author` URN, and the LinkedIn credential is an
 *     org-level one, so the author is the company page, not whichever member
 *     happened to click "Connect".
 *     getOrganizationUrn() resolves and caches that org URN for the process,
 *     the same lazy-open-and-cache shape as bluesky.ts's getAgent().
 *   - the create response carries the new post's id in a response HEADER
 *     (`x-restli-id`), not the body, which is unlike every other vendor this
 *     engine talks to.
 *
 * Engine rules apply: relative imports only, no `@/`, no prisma, no next.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { retryAfterHeader } from "./retry.js";
import { vendorFetch, vendorText, type VendorFetchOptions } from "./vendor-fetch.js";

/**
 * `LinkedIn-Version` header value, `YYYYMM`. VERIFIED against the Posts,
 * Comments, Follower Statistics and Share Statistics pages under
 * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/
 * (each states `defaultMoniker: li-lms-2026-10`, i.e. version 202610).
 * LinkedIn versions are accepted for roughly a year after release, so this is
 * not a "set once and forget" constant: it needs bumping as newer months are
 * documented.
 */
export const LINKEDIN_VERSION = "202610";

const BASE = "https://api.linkedin.com/rest";

/**
 * A URN as ONE Rest.li 2.0 path segment (the resource key). LinkedIn's
 * protocol page (learn.microsoft.com/en-us/linkedin/shared/api-guide/concepts/
 * protocol-version, "Single Resource Key"): "you must URL encode the entire
 * resource key. The `(` must be encoded to `%28`, `)` to `%29`, `:` to `%3A`
 * and `,` to `%2C`". encodeURIComponent leaves `(` and `)` raw, so a nested
 * comment URN (`urn:li:comment:(urn:li:activity:<thread>,<id>)`) would reach
 * LinkedIn half-encoded and come back 400 "Syntax exception in path
 * variables". `!`, `'` and `*` are encoded too
 * (RFC 3986 strict), so nothing Rest.li treats as syntax survives raw.
 *
 * Path keys only: inside a query param LinkedIn wants `List(...)` and its
 * separators raw (same page), so query values keep encodeURIComponent.
 */
export function encodeUrnPathSegment(urn: string): string {
  return encodeURIComponent(urn).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

// A hung connection must not hold a publish request open indefinitely.
const REQUEST_TIMEOUT_MS = 15_000;

// Media bytes need longer than a plain API call.
const UPLOAD_TIMEOUT_MS = 120_000;

export class LinkedInError extends Error {
  constructor(
    public status: number,
    public body: string,
    method: string,
    path: string,
    /** Raw `Retry-After`, verbatim. retry.ts owns the grammar; see RetryAfterCarrier. */
    public retryAfter: string | null = null,
  ) {
    super(`LinkedIn ${method} ${path} -> ${status}: ${body.slice(0, 500)}`);
  }
}

/**
 * One server log line per LinkedIn API call, for the Community Management API
 * Standard-tier review, which asks for proof of the calls an app makes:
 *
 *   [linkedin-api] <UTC ISO time> <METHOD> <path> status=<code> x-li-uuid=<id>
 *
 * ⛔ THE PATH ONLY, NEVER THE QUERY, AND NEVER A TOKEN. The query string is cut
 * off whole (a finder's `author=` or a statistics window is not the resource),
 * a pre-signed upload URL is replaced by a fixed label (its query IS a
 * credential), and nothing from the request's headers is read here at all, so
 * the bearer token and the client secret have no route into the line. Every
 * call reaches this through `request()`, `uploadImageBytes` or the app's token
 * endpoint, which is the whole of LinkedIn traffic.
 *
 * `status=none` is a call that got no response (timeout, network); `x-li-uuid`
 * is LinkedIn's request id header, `-` when absent.
 */
export function logLinkedInCall(call: {
  method: string;
  path: string;
  status: number | null;
  liUuid: string | null;
}): void {
  const path = call.path.split("?")[0].split("#")[0];
  const at = new Date().toISOString();
  const method = call.method.toUpperCase();
  console.info(
    `[linkedin-api] ${at} ${method} ${path} ` +
      `status=${call.status ?? "none"} x-li-uuid=${call.liUuid || "-"}`,
  );
  const record: LinkedInCallRecord = { at, method, path, status: call.status, liUuid: call.liUuid || null };
  // The same fields as the line, for a caller that keeps them (see below).
  callSink.getStore()?.push(record);
  // And the durable ledger, every call, tagged with what it was for.
  if (_ledgerSink) {
    const tags = callContext.getStore();
    const entry: LinkedInLedgerRecord = { ...record, context: tags?.context ?? null, draftId: tags?.draftId ?? null };
    try {
      Promise.resolve(_ledgerSink(entry)).catch(ledgerFailed);
    } catch (err) {
      ledgerFailed(err);
    }
  }
}

function ledgerFailed(err: unknown): void {
  console.error("[linkedin-api] the call ledger write failed:", err);
}

/** A ledger row: the log line's fields, plus what the call was for. */
export interface LinkedInLedgerRecord extends LinkedInCallRecord {
  /** What the call served (`agent` today); null when untagged. */
  context: string | null;
  draftId: string | null;
}

/**
 * ⛔ THE CALL LEDGER, AT THE ONE CHOKE POINT. Every LinkedIn call (request(),
 * the image upload and the app's token endpoint) reaches logLinkedInCall, so a
 * sink here records each one, which is what the Community Management API
 * Standard-tier review asks for, and what a per-member daily budget can be
 * counted from. Injected, because this engine never imports Prisma (the app
 * writes the ledger row).
 * Fire-and-forget: a ledger outage is logged and never fails the call.
 */
export type LinkedInLedgerSink = (record: LinkedInLedgerRecord) => void | Promise<void>;

let _ledgerSink: LinkedInLedgerSink | null = null;

export function setLinkedInCallSink(sink: LinkedInLedgerSink | null): void {
  _ledgerSink = sink;
}

const callContext = new AsyncLocalStorage<{ context: string; draftId: string | null }>();

/** Run `fn` with its LinkedIn calls tagged in the ledger as `context` (and the draft they serve). */
export function withLinkedInCallContext<T>(
  tags: { context: string; draftId?: string | null },
  fn: () => Promise<T>,
): Promise<T> {
  return callContext.run({ context: tags.context, draftId: tags.draftId ?? null }, fn);
}

/** One LinkedIn API call, as its log line states it. */
export interface LinkedInCallRecord {
  at: string;
  method: string;
  path: string;
  status: number | null;
  liUuid: string | null;
}

const callSink = new AsyncLocalStorage<LinkedInCallRecord[]>();

/**
 * Run `fn`, appending every LinkedIn call it makes to `calls`, in order.
 *
 * For a caller's evidence rows: the log line above lives only as long as the
 * process's stdout, and a tier application
 * needs the record later. The sink is the caller's array, so the calls made
 * before a throw are still there when it propagates. Scoped by
 * AsyncLocalStorage, so two publishes running at once never see each other's.
 */
export function withLinkedInCallLog<T>(calls: LinkedInCallRecord[], fn: () => Promise<T>): Promise<T> {
  return callSink.run(calls, fn);
}

/** The REST base's path, for the log: `/rest/posts`, not the full URL. */
const BASE_PATH = "/rest";

export type LinkedInTokenResolver = () => Promise<string>;

let _tokenResolver: LinkedInTokenResolver | null = null;
let _orgUrn: string | null = null;
let _orgPromise: Promise<string> | null = null;
/**
 * Bumped by every setter that invalidates the org cache. The in-flight lookup
 * captures it and refuses to write its result back if it changed underneath.
 *
 * ⛔ WITHOUT THIS, CLEARING THE CACHE DOES NOT CLEAR THE CACHE. `_orgPromise`'s
 * body assigns `_orgUrn` after its await, so a setter that nulled `_orgUrn`
 * while a lookup was in flight would have the stale value written straight
 * back over it. Both setters document that clearing exists precisely to stop the process
 * posting as whatever org the OLD token administered.
 *
 * ⚠️ A caller that runs both setters synchronously at wiring time, before
 * any publish can start, never reaches this. The guard is here because that
 * property belongs to the CALLER, and this folder is the
 * portable engine (see the note on setLinkedInTokenResolver) that is meant to
 * be liftable away from it.
 */
let _orgGeneration = 0;

/**
 * Register (or clear, with null) the resolver that supplies a bearer access
 * token.
 *
 * INJECTED rather than imported, like setBlueskyCredentialsResolver: this
 * folder is the portable engine and cannot reach the app's credential store
 * (that would need `@/`, prisma and the app's encryption keys). Clearing also
 * drops the cached organization URN: a credential rotation
 * (a fresh re-consent naming a different org, or a disconnect) must not leave
 * the process posting to whatever org the OLD token administered.
 */
export function setLinkedInTokenResolver(resolver: LinkedInTokenResolver | null): void {
  _tokenResolver = resolver;
  _orgUrn = null;
  _orgPromise = null;
  _orgGeneration += 1;
}

/** Which kind of write a guard is being asked about. */
export type LinkedInWriteKind = "post" | "comment";

/**
 * Asked before every WRITE, after the token resolves. Throws to refuse. The app
 * layer uses it to refuse a grant that lacks the write scope (a read-only seed)
 * with a "reconnect for posting" error, before LinkedIn answers a bare 403.
 */
export type LinkedInWriteGuard = (kind: LinkedInWriteKind) => Promise<void>;

let _writeGuard: LinkedInWriteGuard | null = null;

/** Register (or clear, with null) the write guard. Injected for the resolver's reason. */
export function setLinkedInWriteGuard(guard: LinkedInWriteGuard | null): void {
  _writeGuard = guard;
}

/**
 * Resolve the token FIRST, then ask the guard. Order matters: resolving can
 * adopt the out-of-band seed and write the stored row, and the guard reads that
 * row's scopes.
 */
async function guardWrite(kind: LinkedInWriteKind): Promise<void> {
  await getToken();
  if (_writeGuard) await _writeGuard(kind);
}

/**
 * Resolve the bearer token and discard it: the cheapest honest "is this
 * credential usable" a caller can ask. connectStatus uses it so a credential
 * the store refuses (another app's, or a dead grant) reads as disconnected
 * instead of healthy-from-a-cached-org-urn.
 */
export async function assertLinkedInToken(): Promise<void> {
  await getToken();
}

async function getToken(): Promise<string> {
  if (!_tokenResolver) {
    throw new LinkedInError(
      0,
      "no LinkedIn token resolver registered (call setLinkedInTokenResolver)",
      "GET",
      "(auth)",
    );
  }
  const token = await _tokenResolver();
  if (!token) {
    throw new LinkedInError(0, "LinkedIn token resolver returned an empty token", "GET", "(auth)");
  }
  return token;
}

interface RequestOpts {
  body?: unknown;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

interface RequestResult<T> {
  data: T;
  headers: Headers;
}

/**
 * Every REST call funnels through here so the version headers, timeout and
 * error wrapping are applied exactly once. Returns the raw `Headers` object
 * alongside the parsed body because createPost's id lives in a header, not
 * the body — see the note there.
 */
async function request<T>(method: string, path: string, opts: RequestOpts = {}): Promise<RequestResult<T>> {
  const token = await getToken();
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const resOpts: VendorFetchOptions = { timeoutMs, wrap: (status, message) => new LinkedInError(status, message, method, path) };
  let res: Response;
  try {
    res = await vendorFetch(
      `${BASE}${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          // Required on every call per both the Posts API and Images API docs.
          "LinkedIn-Version": LINKEDIN_VERSION,
          "X-Restli-Protocol-Version": "2.0.0",
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...opts.headers,
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      },
      resOpts,
    );
  } catch (err) {
    logLinkedInCall({ method, path: `${BASE_PATH}${path}`, status: null, liUuid: null });
    throw err;
  }
  logLinkedInCall({ method, path: `${BASE_PATH}${path}`, status: res.status, liUuid: res.headers.get("x-li-uuid") });
  const text = await vendorText(res, resOpts);
  if (!res.ok) throw new LinkedInError(res.status, text, method, path, retryAfterHeader(res));
  if (!text) return { data: undefined as T, headers: res.headers };
  try {
    return { data: JSON.parse(text) as T, headers: res.headers };
  } catch {
    throw new LinkedInError(res.status, `expected JSON, got: ${text.slice(0, 200)}`, method, path);
  }
}

interface OrgAclElement {
  role?: string;
  state?: string;
  /**
   * ⚠️ LinkedIn's own documentation is internally inconsistent about this
   * field's name for `GET /organizationAcls?q=roleAssignee`: the "Find a
   * Member's Organization Access Control Information" section's FIRST sample
   * response uses `organization`, but the very same section's paginated
   * example — same query, same finder — uses `organizationTarget`. UNVERIFIED
   * against the live API which one actually comes back, so both are read
   * below.
   * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-access-control-by-role
   */
  organization?: string;
  organizationTarget?: string;
}

let _pinnedOrgId: string | null = null;

/**
 * Pin which company page posts are authored as.
 *
 * ⛔ WITHOUT THIS, THE ACCOUNT IS CHOSEN BY LIST ORDER. Taking the FIRST
 * element of `organizationAcls` is fine for a person who administers exactly
 * one page and silently wrong for anyone else: a token that administers
 * several pages gets them back in LinkedIn's order, and the first may be an
 * unrelated page. The connection reports itself healthy the whole time,
 * because the credential IS valid; only the audience is wrong.
 *
 * Set from the app via `LINKEDIN_ORG_ID`.
 */
export function setLinkedInOrganizationId(id: string | null): void {
  _pinnedOrgId = id && id.trim() ? id.trim() : null;
  _orgUrn = null;
  // ⛔ `_orgPromise` TOO. Clearing only `_orgUrn` would leave a lookup already
  // in flight to be handed to the next caller and then written back, so a pin
  // set while one was running would be discarded in favour of LinkedIn's list
  // order, which is the exact outcome this function exists to
  // prevent.
  _orgPromise = null;
  _orgGeneration += 1;
}

async function fetchOrganizationUrn(): Promise<string> {
  if (_pinnedOrgId) {
    return _pinnedOrgId.startsWith("urn:li:organization:")
      ? _pinnedOrgId
      : `urn:li:organization:${_pinnedOrgId}`;
  }

  const { data } = await request<{ elements?: OrgAclElement[] }>(
    "GET",
    "/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED",
  );
  const urns = (data?.elements ?? [])
    .map((e) => e.organization ?? e.organizationTarget)
    .filter((u): u is string => Boolean(u));

  if (!urns.length) {
    throw new LinkedInError(
      0,
      "no APPROVED ADMINISTRATOR organization role found for this token; connect a company-page admin account",
      "GET",
      "/organizationAcls",
    );
  }

  if (urns.length > 1) {
    // Refuse rather than guess. Publishing to the wrong company page is not
    // recoverable by deleting the post: it has already been seen, and by the
    // wrong audience. An operator setting one env var is the cheap fix.
    throw new LinkedInError(
      0,
      `this token administers ${urns.length} company pages (${urns.join(", ")}) and LINKEDIN_ORG_ID is not set, ` +
        "so which one posts would be authored as is decided by LinkedIn's list order. " +
        "Set LINKEDIN_ORG_ID to the intended organization id.",
      "GET",
      "/organizationAcls",
    );
  }

  return urns[0];
}

/**
 * The org URN (`urn:li:organization:...`) that every post is authored as,
 * resolved on first use and cached for the process — same shape as
 * bluesky.ts's getAgent(). Single-flighted so concurrent callers on a cold
 * process share one lookup rather than each querying organizationAcls.
 */
export async function getOrganizationUrn(): Promise<string> {
  if (_orgUrn) return _orgUrn;
  if (_orgPromise) return _orgPromise;

  const generation = _orgGeneration;
  const pending = (async () => {
    const urn = await fetchOrganizationUrn();
    // Cache only if nothing invalidated us mid-flight. The caller still gets
    // the value it asked for; what it must not do is become the answer for
    // everyone after a rotation or a pin.
    if (generation === _orgGeneration) _orgUrn = urn;
    return urn;
  })();
  _orgPromise = pending;

  try {
    return await pending;
  } finally {
    // ⚠️ Only if it is still OURS. A setter may have nulled it and a later
    // caller started a fresh lookup; clearing unconditionally would drop that
    // one's single-flight and let a third caller open a second request.
    if (_orgPromise === pending) _orgPromise = null;
  }
}

export interface CreatePostInput {
  commentary: string;
  /** A single already-uploaded image. See linkedin-transport.ts for why only one. */
  media?: { id: string; altText?: string };
}

/**
 * POST /rest/posts. VERIFIED against
 * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api:
 * request body shape (author/commentary/visibility/
 * distribution/lifecycleState/isReshareDisabledByAuthor, content.media for an
 * image post), and the response — "You should get a 201 response and the
 * response header `x-restli-id` contains the Post ID such as
 * `urn:li:share:...` or `urn:li:ugcPost:...`." The endpoint returns NO body on
 * success, which is why the id is read from the header first; a body `id`
 * field is read only as a defensive fallback in case that ever changes.
 */
export async function createPost(input: CreatePostInput): Promise<{ ref: string }> {
  await guardWrite("post");
  const author = await getOrganizationUrn();
  const body: Record<string, unknown> = {
    author,
    commentary: input.commentary,
    visibility: "PUBLIC",
    distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
  };
  if (input.media) {
    body.content = {
      media: { id: input.media.id, ...(input.media.altText ? { altText: input.media.altText } : {}) },
    };
  }
  const { data, headers } = await request<{ id?: string }>("POST", "/posts", { body });
  const ref = headers.get("x-restli-id") ?? data?.id;
  if (!ref) {
    throw new LinkedInError(0, "post created but no id was returned (missing x-restli-id header)", "POST", "/posts");
  }
  return { ref };
}

/**
 * DELETE /rest/posts/{encoded urn}. VERIFIED: the docs state deletion is
 * idempotent server-side — "Deletion requests for a previously deleted UGC
 * Post will return a `204` code" — so this is a thin passthrough that throws
 * on a genuine failure; the "already gone is success" business decision
 * belongs to the transport (see linkedin-transport.ts), matching how
 * bluesky.ts's deleteRecord() is structured, and covering the defensive case
 * of a URN that never existed at all (as opposed to one that was deleted
 * before) in case that behaves differently from a re-delete.
 */
export async function deletePost(ref: string): Promise<void> {
  await guardWrite("post");
  await request("DELETE", `/posts/${encodeUrnPathSegment(ref)}`, {
    headers: { "X-RestLi-Method": "DELETE" },
  });
}

export interface LinkedInBatchGetResult {
  results?: Record<string, unknown>;
  statuses?: Record<string, number>;
  errors?: Record<string, unknown>;
}

/**
 * GET /rest/posts?ids=List(...) with X-RestLi-Method: BATCH_GET.
 *
 * The request shape (header, `List(...)` param, per-id URL-encoding with
 * un-encoded separating commas) is VERIFIED against the docs.
 *
 * ✅ THE MISSING-ID SHAPE IS VERIFIED TOO, observed live by publishing a real
 * post to the operator's page, reading it back, deleting it, and reading it
 * again (linkedin.live.proof.test.ts). It is unverifiable from the docs, whose
 * every sample response shows an empty `errors: {}` with
 * no worked example of a not-found entry.
 *
 *   present:  results: { "<urn>": { lifecycleState: "PUBLISHED", ... } }
 *             statuses: { "<urn>": 200 }
 *             errors:   {}
 *
 *   deleted:  results:  {}
 *             statuses: { "<urn>": 404 }
 *             errors:   { "<urn>": { message: "", status: 404 } }
 *
 * So a deleted id is absent from `results` AND carries an explicit 404 in both
 * `statuses` and `errors`. That 404 is a positive vendor statement that the post
 * is gone, which is what lets linkedin-transport's postFacts answer
 * `absent` instead of collapsing "deleted" and "lookup failed" into QUEUE.
 *
 * ⚠️ Note `errors[urn].message` is the EMPTY STRING, so nothing user-facing can
 * be built from it — read `status`, never the message.
 *
 * One call, no internal chunking — same contract as bluesky.ts's getPosts();
 * callers chunk (see linkedin-transport.ts's BATCH_GET_LIMIT).
 */
export async function getPostsBatch(refs: string[]): Promise<LinkedInBatchGetResult> {
  if (!refs.length) return { results: {} };
  const idsParam = `List(${refs.map((r) => encodeURIComponent(r)).join(",")})`;
  const { data } = await request<LinkedInBatchGetResult>("GET", `/posts?ids=${idsParam}`, {
    headers: { "X-RestLi-Method": "BATCH_GET" },
  });
  return data ?? { results: {} };
}

export interface LinkedInImageUpload {
  uploadUrl: string;
  image: string;
}

/**
 * POST /rest/images?action=initializeUpload. VERIFIED against
 * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api:
 * request body `{ initializeUploadRequest: { owner } }`,
 * response `{ value: { uploadUrl, image, uploadUrlExpiresAt } }`.
 */
export async function initializeImageUpload(): Promise<LinkedInImageUpload> {
  await guardWrite("post");
  const owner = await getOrganizationUrn();
  const { data } = await request<{ value?: { uploadUrl?: string; image?: string } }>(
    "POST",
    "/images?action=initializeUpload",
    { body: { initializeUploadRequest: { owner } } },
  );
  const uploadUrl = data?.value?.uploadUrl;
  const image = data?.value?.image;
  if (!uploadUrl || !image) {
    throw new LinkedInError(
      0,
      `initializeUpload response missing uploadUrl/image: ${JSON.stringify(data).slice(0, 200)}`,
      "POST",
      "/images?action=initializeUpload",
    );
  }
  return { uploadUrl, image };
}

/**
 * PUT the image bytes to the URL initializeImageUpload returned.
 *
 * VERIFIED that this is a PUT carrying an OAuth bearer token in `Authorization`
 * — the Images API doc points at the (older) Assets API's "Upload the Image"
 * section for this step and that section is explicit: "The upload call
 * requires a valid OAuth token in the 'Authorization' header. This is
 * different than the upload video call which doesn't accept an OAuth token."
 * NOT verified for the Images API specifically whether a response body is
 * ever returned (the referenced example shows an empty 201); only `res.ok` is
 * checked here rather than parsing a body.
 *
 * `uploadUrl` is a full, pre-signed URL on a different host
 * (www.linkedin.com/dms-uploads/...), so this bypasses request()'s BASE
 * prefix and goes straight through fetch.
 */
export async function uploadImageBytes(uploadUrl: string, bytes: Uint8Array<ArrayBuffer>, mimeType: string): Promise<void> {
  const token = await getToken();
  const resOpts: VendorFetchOptions = {
    timeoutMs: UPLOAD_TIMEOUT_MS,
    label: "image upload",
    wrap: (status, message) => new LinkedInError(status, message, "PUT", "(uploadUrl)"),
  };
  let res: Response;
  try {
    res = await vendorFetch(
      uploadUrl,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": mimeType },
        // Wrapped in a Blob rather than passed as a raw Uint8Array: TS's DOM lib
        // BodyInit overloads reject a bare Uint8Array<ArrayBufferLike> (a
        // TS 5.7+/6.x lib.dom.d.ts tightening), and a Blob is a real BodyInit in
        // every runtime this ships to.
        body: new Blob([bytes], { type: mimeType }),
      },
      resOpts,
    );
  } catch (err) {
    logLinkedInCall({ method: "PUT", path: "(image upload URL)", status: null, liUuid: null });
    throw err;
  }
  // The pre-signed URL is never logged: its query string is the upload credential.
  logLinkedInCall({ method: "PUT", path: "(image upload URL)", status: res.status, liUuid: res.headers.get("x-li-uuid") });
  if (!res.ok) {
    const text = await vendorText(res, resOpts).catch(() => "");
    throw new LinkedInError(res.status, text, "PUT", "(uploadUrl)");
  }
}

/* -------------------------------------------------------------------------- */
/*  Analytics                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Per-post engagement. VERIFIED against
 * learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/network-update-social-actions:
 * GET /socialActions/{shareUrn|ugcPostUrn|commentUrn}
 * answers `{ likesSummary: { totalLikes }, commentsSummary: { aggregatedTotalComments } }`.
 *
 * Keys are LinkedIn's own names. This endpoint carries no impression or click
 * count; for an organization's own post those come from share statistics
 * filtered to that post (getPostShareStatistics below). Nothing here is renamed
 * into a shared vocabulary: LinkedIn's "like" is not Instagram's.
 */
interface LinkedInSocialActions {
  likesSummary?: { totalLikes?: unknown };
  commentsSummary?: { aggregatedTotalComments?: unknown };
}

function keepFinite(bag: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(bag)) {
    // Absent, never 0 — but a vendor-reported zero IS a real datum and is kept.
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

export async function getSocialActions(ref: string): Promise<Record<string, number>> {
  const { data } = await request<LinkedInSocialActions>("GET", `/socialActions/${encodeUrnPathSegment(ref)}`);
  return keepFinite({
    totalLikes: data?.likesSummary?.totalLikes,
    aggregatedTotalComments: data?.commentsSummary?.aggregatedTotalComments,
  });
}

/**
 * Organization-level share statistics. VERIFIED against
 * learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/share-statistics:
 * GET /organizationalEntityShareStatistics?q=organizationalEntity
 * with `elements[].totalShareStatistics`.
 *
 * `timeIntervals` is deliberately omitted, which asks for LIFETIME totals. The
 * time-bound form returns one element PER interval and each is a delta for that
 * window, so summing or taking the first would report a slice of a day as the
 * account's whole history.
 *
 * `engagement` is a RATIO, not a count — passed through as the vendor's own
 * float rather than being scaled into a percentage here.
 */
interface LinkedInShareStatsElement {
  totalShareStatistics?: Record<string, unknown>;
}

export async function getShareStatistics(): Promise<Record<string, number>> {
  const orgUrn = await getOrganizationUrn();
  const { data } = await request<{ elements?: LinkedInShareStatsElement[] }>(
    "GET",
    `/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${encodeURIComponent(orgUrn)}`,
  );
  const totals = data?.elements?.[0]?.totalShareStatistics;
  return totals ? keepFinite(totals) : {};
}

/**
 * Which share-statistics filter a post URN belongs to, or null for anything
 * that is not a share or ugcPost URN (createPost's `x-restli-id` is documented
 * as one of those two). Exported so the transport refuses a bad ref before it
 * spends any call on it.
 */
export function linkedInPostStatsFilter(ref: string): "shares" | "ugcPosts" | null {
  const match = /^urn:li:(share|ugcPost):\d+$/.exec(ref);
  if (!match) return null;
  return match[1] === "share" ? "shares" : "ugcPosts";
}

/**
 * The totalShareStatistics fields reported as 0 when LinkedIn answers a
 * per-post query with no element for that post. The share-statistics page's
 * "Share Statistics Data Schema" table lists exactly these seven, and the
 * page says "Shares that are not returned in the list of
 * elements can be assumed to have counts of 0 for all statistics."
 *
 * Those zeros are reported rather than leaving the post blank. Known trade-off:
 * the same page says the endpoint only covers a rolling
 * 12 months, so a post older than that also reads as 0 here, as would a URN
 * from another organization; the response does not tell those cases apart.
 */
export const LINKEDIN_POST_STAT_FIELDS = [
  "clickCount",
  "commentCount",
  "engagement",
  "impressionCount",
  "likeCount",
  "shareCount",
  "uniqueImpressionsCount",
] as const;

interface LinkedInPostShareStatsElement extends LinkedInShareStatsElement {
  share?: string;
  ugcPost?: string;
}

/**
 * Lifetime statistics for ONE of the organization's posts. VERIFIED against
 * learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/share-statistics
 * ("Retrieve Statistics for Specific Shares"): the same
 * finder as getShareStatistics plus `shares=List(...)` or `ugcPosts`, answering
 * one element per post carrying `share` (or `ugcPost`) and `totalShareStatistics`
 * (clickCount, commentCount, engagement, impressionCount, likeCount, shareCount,
 * uniqueImpressionsCount on some versions). Organic only; time-bound stats are
 * not supported for specific posts, so this is always lifetime.
 *
 * The URN inside `List(...)` is URL-encoded, the docs' own example
 * (`shares=List(urn%3Ali%3Ashare%3A...)`) and the same rule getPostsBatch
 * follows. One URN per call, so the docs' disagreement over whether the comma
 * between list items is encoded never arises.
 *
 * ⚠️ UNVERIFIED FOR ugcPosts: the docs' ugcPost sample uses the Rest.li 1.0
 * indexed form (`ugcPosts[0]=urn:li:ugcPost:...`) while every call here sends
 * `X-Restli-Protocol-Version: 2.0.0`, whose list syntax is `List(...)`. This
 * sends the 2.0 form for both. Every post this client has published so far
 * came back as a share URN.
 *
 * ⛔ THE ELEMENT IS MATCHED BY URN, NEVER TAKEN AS elements[0]. If LinkedIn ever
 * ignored the filter it would answer the page's AGGREGATE element (no `share`
 * field), and taking the first element would attribute the whole page's
 * impressions to one post. Nor may that answer read as "post omitted, so
 * zeros": an aggregate element means the filter was not applied, which is a
 * failure and THROWS. Another post's element is simply not a match.
 *
 * ⚠️ NO MATCHING ELEMENT IS ZEROS (see LINKEDIN_POST_STAT_FIELDS), but only
 * when LinkedIn answered the documented shape, an `elements` array. A body with
 * no `elements` at all (an empty 200 from a proxy) is not that answer and stays
 * `{}`, as does a matched element carrying no totals. A failed call throws and
 * never becomes zeros.
 */
export async function getPostShareStatistics(ref: string): Promise<Record<string, number>> {
  const filter = linkedInPostStatsFilter(ref);
  if (!filter) {
    throw new LinkedInError(
      0,
      `not a LinkedIn share or ugcPost URN: ${JSON.stringify(ref)}; per-post statistics take urn:li:share:<id> or urn:li:ugcPost:<id>`,
      "GET",
      "/organizationalEntityShareStatistics",
    );
  }
  const orgUrn = await getOrganizationUrn();
  const { data } = await request<{ elements?: LinkedInPostShareStatsElement[] }>(
    "GET",
    `/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${encodeURIComponent(orgUrn)}` +
      `&${filter}=List(${encodeURIComponent(ref)})`,
  );
  const field = filter === "shares" ? "share" : "ugcPost";
  const elements = data?.elements;
  if (!Array.isArray(elements)) return {};
  const element = elements.find((e) => e[field] === ref);
  if (!element) {
    if (elements.some((e) => !e.share && !e.ugcPost)) {
      throw new LinkedInError(
        0,
        `asked for ${filter}=List(${ref}) but LinkedIn answered the page aggregate; the filter was not applied`,
        "GET",
        "/organizationalEntityShareStatistics",
      );
    }
    return Object.fromEntries(LINKEDIN_POST_STAT_FIELDS.map((key) => [key, 0]));
  }
  return element.totalShareStatistics ? keepFinite(element.totalShareStatistics) : {};
}

/**
 * Total followers. VERIFIED against
 * learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-lookup-api:
 * GET /networkSizes/{orgUrn}?edgeType=... -> `{ firstDegreeSize }`.
 *
 * ⚠️ THE edgeType SPELLING IS VERSION-DEPENDENT. `COMPANY_FOLLOWED_BY_MEMBER`
 * on v202305 and later, `CompanyFollowedByMember` at v202304 and earlier. This
 * client pins LINKEDIN_VERSION = 202610, so the screaming-snake form is the
 * correct one; if that pin is ever rolled BACK past v202305 this call starts
 * failing and the spelling has to move with it.
 *
 * Deliberately NOT organizationalEntityFollowerStatistics: its lifetime form
 * returns counts segmented by geo/industry facets (so no single total exists
 * without summing facets and hoping they partition), and its time-bound form
 * returns per-interval deltas. Both would answer a different question than
 * "how many followers are there".
 *
 * THROWS when the field is missing rather than reporting 0 — a fabricated zero
 * reads as an account that lost its entire audience.
 */
export async function getFollowerCount(): Promise<{ followers: number }> {
  const orgUrn = await getOrganizationUrn();
  const { data } = await request<{ firstDegreeSize?: unknown }>(
    "GET",
    `/networkSizes/${encodeUrnPathSegment(orgUrn)}?edgeType=COMPANY_FOLLOWED_BY_MEMBER`,
  );
  const raw = data?.firstDegreeSize;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new LinkedInError(
      0,
      "networkSizes returned no firstDegreeSize; refusing to report 0 followers, which would read as a lost audience",
      "GET",
      "/networkSizes",
    );
  }
  return { followers: raw };
}

/**
 * ONE post by URN: GET /rest/posts/{encoded urn}. VERIFIED against the Posts
 * API page (li-lms-2026-10, "Get Posts by URN"). Answers true for a post that
 * exists; a deleted or unknown one is LinkedIn's 404, which surfaces as a
 * LinkedInError with `status` 404 for the caller to read.
 *
 * Exists for the Community Management API's Development tier, which allows NO
 * BATCH_GET calls at all (learn.microsoft.com/en-us/linkedin/marketing/
 * increasing-access, li-lms-2026-10: "All APIs with BATCH_GET: No API calls
 * allowed"). getPostsBatch stays the first choice; see linkedin-transport.ts.
 */
export async function getPost(ref: string): Promise<boolean> {
  await request("GET", `/posts/${encodeUrnPathSegment(ref)}`);
  return true;
}

/* -------------------------------------------------------------------------- */
/*  Page comments (Community Management API)                                   */
/* -------------------------------------------------------------------------- */

export interface LinkedInPagePost {
  /** `urn:li:share:...` or `urn:li:ugcPost:...`. */
  id: string;
  commentary: string;
  /** Epoch ms. */
  createdAt: number;
}

interface LinkedInPostElement {
  id?: unknown;
  commentary?: unknown;
  createdAt?: unknown;
  publishedAt?: unknown;
}

/** The Posts finder's documented maximum `count`. */
const POSTS_FINDER_MAX = 100;

/**
 * The organization's most recent posts, newest first. VERIFIED against the
 * Posts API page (li-lms-2026-10, "Find Posts by Authors"):
 * GET /rest/posts?author={encoded org urn}&q=author&count=N&sortBy=CREATED with
 * `X-RestLi-Method: FINDER`, answering `{ paging, elements: [{ id, commentary,
 * createdAt, publishedAt, ... }] }`. Needs `r_organization_social`.
 *
 * One page only, on purpose: a Development-tier app has 500 calls a day and
 * 100 per member, so the comment sweep looks under the newest posts rather
 * than walking the whole history.
 */
export async function listOrganizationPosts(limit: number): Promise<LinkedInPagePost[]> {
  const author = await getOrganizationUrn();
  const count = Math.max(1, Math.min(POSTS_FINDER_MAX, Math.floor(limit)));
  const { data } = await request<{ elements?: LinkedInPostElement[] }>(
    "GET",
    `/posts?author=${encodeURIComponent(author)}&q=author&count=${count}&sortBy=CREATED`,
    { headers: { "X-RestLi-Method": "FINDER" } },
  );
  const out: LinkedInPagePost[] = [];
  for (const e of data?.elements ?? []) {
    if (typeof e.id !== "string" || !e.id) continue;
    const created = typeof e.createdAt === "number" ? e.createdAt : e.publishedAt;
    out.push({
      id: e.id,
      commentary: typeof e.commentary === "string" ? e.commentary : "",
      createdAt: typeof created === "number" ? created : 0,
    });
  }
  return out;
}

export interface LinkedInComment {
  /** `urn:li:comment:(urn:li:activity:<thread>,<id>)`, the key a reply targets. */
  commentUrn: string;
  /** Person or organization URN of the author. */
  actor: string;
  text: string;
  /** Epoch ms. */
  createdAt: number;
  /** Set on a nested comment. */
  parentComment?: string;
}

interface LinkedInCommentElement {
  commentUrn?: unknown;
  actor?: unknown;
  message?: { text?: unknown };
  created?: { time?: unknown };
  parentComment?: unknown;
}

interface LinkedInPaging {
  start?: unknown;
  count?: unknown;
  total?: unknown;
}

/** Highest page size this client asks for. LinkedIn may answer fewer. */
const COMMENTS_PAGE_MAX = 100;

/**
 * Comments on one post (or, given a comment URN, the replies to one comment).
 * VERIFIED against the Comments API page (li-lms-2026-10, "Get Comments on
 * Shares"): GET /rest/socialActions/{shareUrn|ugcPostUrn|commentUrn}/comments,
 * answering `{ elements: [{ actor, commentUrn, created: { time }, id,
 * message: { text }, object, parentComment? }], paging }`. Needs
 * `r_organization_social_feed` (or `r_organization_social`) on a Page the member
 * administers; LinkedIn answers 403 ACCESS_DENIED without it.
 *
 * Paged with Rest.li's standard `start`/`count`: the next page is asked for
 * only when this one came back FULL and `paging.total`, when LinkedIn sends it,
 * says there is more. `maxPages` bounds the calls a single post can spend.
 * Elements missing a comment URN or text are skipped rather than stored with
 * holes: an image-only comment has nothing to reply to in words.
 */
export async function getComments(
  target: string,
  opts: { pageSize?: number; maxPages?: number } = {},
): Promise<LinkedInComment[]> {
  const pageSize = Math.max(1, Math.min(COMMENTS_PAGE_MAX, Math.floor(opts.pageSize ?? 50)));
  const maxPages = Math.max(1, Math.floor(opts.maxPages ?? 1));
  const out: LinkedInComment[] = [];
  for (let page = 0; page < maxPages; page += 1) {
    const start = page * pageSize;
    const { data } = await request<{ elements?: LinkedInCommentElement[]; paging?: LinkedInPaging }>(
      "GET",
      `/socialActions/${encodeUrnPathSegment(target)}/comments?start=${start}&count=${pageSize}`,
    );
    const elements = data?.elements ?? [];
    for (const e of elements) {
      const text = typeof e.message?.text === "string" ? e.message.text : "";
      if (typeof e.commentUrn !== "string" || !e.commentUrn || !text.trim()) continue;
      out.push({
        commentUrn: e.commentUrn,
        actor: typeof e.actor === "string" ? e.actor : "",
        text,
        createdAt: typeof e.created?.time === "number" ? e.created.time : 0,
        ...(typeof e.parentComment === "string" ? { parentComment: e.parentComment } : {}),
      });
    }
    const total = data?.paging?.total;
    const more =
      elements.length === pageSize && (typeof total !== "number" || start + elements.length < total);
    if (!more) break;
  }
  return out;
}

/**
 * Reply to a comment, as the organization. VERIFIED against the Comments API
 * page (li-lms-2026-10, "Create a Comment on a Comment"): POST
 * /rest/socialActions/{parent commentUrn}/comments with
 * `{ actor: <org urn>, object: <share|ugcPost urn>, message: { text },
 * parentComment: <parent commentUrn> }`; 201, the new id in `x-restli-id`, and
 * a body carrying `commentUrn`. Needs `w_organization_social_feed` (or
 * `w_organization_social`). 429 "Comment create throttled" is LinkedIn's
 * per-minute create limit.
 *
 * Returns the new comment's URN when LinkedIn states it (body `commentUrn`),
 * else the bare id from the header, else null: the reply exists either way
 * once this resolves, and a caller must not retry it into a duplicate.
 */
export async function replyToComment(input: {
  postUrn: string;
  commentUrn: string;
  text: string;
}): Promise<{ commentUrn: string | null }> {
  await guardWrite("comment");
  const actor = await getOrganizationUrn();
  const { data, headers } = await request<{ commentUrn?: unknown }>(
    "POST",
    `/socialActions/${encodeUrnPathSegment(input.commentUrn)}/comments`,
    {
      body: {
        actor,
        object: input.postUrn,
        message: { text: input.text },
        parentComment: input.commentUrn,
      },
    },
  );
  const urn = typeof data?.commentUrn === "string" && data.commentUrn ? data.commentUrn : null;
  return { commentUrn: urn ?? headers.get("x-restli-id") };
}

/**
 * The public link to one comment: the post's feed URL with `commentUrn`, the
 * form LinkedIn's own "copy link to comment" produces. Also the one place an
 * Engage row records which POST the comment is under, which a reply needs as
 * its `object` (parseLinkedInCommentPermalink reads it back).
 */
export function linkedInCommentPermalink(postUrn: string, commentUrn: string): string {
  return `https://www.linkedin.com/feed/update/${postUrn}/?commentUrn=${encodeURIComponent(commentUrn)}`;
}

/** The inverse of linkedInCommentPermalink, or null for anything it did not build. */
export function parseLinkedInCommentPermalink(url: string): { postUrn: string; commentUrn: string } | null {
  const match = /^https:\/\/www\.linkedin\.com\/feed\/update\/(urn:li:(?:share|ugcPost):\d+)\/\?commentUrn=([^&#]+)$/.exec(url);
  if (!match) return null;
  let commentUrn: string;
  try {
    commentUrn = decodeURIComponent(match[2]);
  } catch {
    return null;
  }
  if (!/^urn:li:comment:\(urn:li:[A-Za-z]+:\d+,\d+\)$/.test(commentUrn)) return null;
  return { postUrn: match[1], commentUrn };
}

/* -------------------------------------------------------------------------- */
/*  Time-bound Page statistics (Community Management API)                      */
/* -------------------------------------------------------------------------- */

const DAY_MS = 24 * 60 * 60 * 1000;

/** A `[start, end)` window in epoch ms, on UTC day boundaries. */
export interface LinkedInStatsWindow {
  start: number;
  end: number;
}

/**
 * The newest `days` whole UTC days LinkedIn can report.
 *
 * The follower-statistics page (li-lms-2026-10) says time-bound data runs "till
 * 2 days before the request date (UTC)", so the window ENDS (exclusive) at the
 * start of yesterday: its last day is the day before yesterday. Asking for the
 * newest day or two would read as a quiet day that was really just not counted
 * yet.
 */
export function linkedInStatsWindow(now: Date, days: number): LinkedInStatsWindow {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const end = today - DAY_MS;
  return { start: end - Math.max(1, Math.floor(days)) * DAY_MS, end };
}

function timeIntervalsParam(window: LinkedInStatsWindow): string {
  // Rest.li 2.0 record syntax, verbatim from both statistics pages.
  return `timeIntervals=(timeRange:(start:${window.start},end:${window.end}),timeGranularityType:DAY)`;
}

function sum(values: unknown[]): number {
  let total = 0;
  for (const v of values) if (typeof v === "number" && Number.isFinite(v)) total += v;
  return total;
}

/**
 * Followers GAINED in a window, organic and paid. VERIFIED against the Follower
 * Statistics page (li-lms-2026-10, "Retrieve Time-Bound Follower Statistics"):
 * GET /rest/organizationalEntityFollowerStatistics?q=organizationalEntity
 * &organizationalEntity={org}&timeIntervals=(timeRange:(start,end),timeGranularityType:DAY),
 * answering one element per day with `followerGains: { organicFollowerGain,
 * paidFollowerGain }`. Needs `rw_organization_admin`.
 *
 * Summed across the days, under LinkedIn's own names. Not the follower TOTAL:
 * that is networkSizes (getFollowerCount), and the lifetime form of this
 * endpoint is facet-segmented with no total. A gain can be negative (unfollows).
 *
 * ⚠️ The page's samples show `paging.count: 10`. A 7-day window is 7 elements,
 * inside one page; a window longer than 10 days would need paging this does
 * not do, so callers keep to a week.
 *
 * THROWS on a body with no `elements` array, never reporting 0: "no answer" is
 * not "no new followers".
 */
export async function getFollowerGains(window: LinkedInStatsWindow): Promise<Record<string, number>> {
  const orgUrn = await getOrganizationUrn();
  const { data } = await request<{
    elements?: { followerGains?: { organicFollowerGain?: unknown; paidFollowerGain?: unknown } }[];
  }>(
    "GET",
    `/organizationalEntityFollowerStatistics?q=organizationalEntity&organizationalEntity=${encodeURIComponent(orgUrn)}` +
      `&${timeIntervalsParam(window)}`,
  );
  const elements = data?.elements;
  if (!Array.isArray(elements)) {
    throw new LinkedInError(
      0,
      "time-bound follower statistics returned no elements array; refusing to report 0 new followers",
      "GET",
      "/organizationalEntityFollowerStatistics",
    );
  }
  return {
    organicFollowerGain: sum(elements.map((e) => e.followerGains?.organicFollowerGain)),
    paidFollowerGain: sum(elements.map((e) => e.followerGains?.paidFollowerGain)),
  };
}

/**
 * The share-statistics counters that ADD across days. `engagement` is a ratio
 * and `uniqueImpressionsCount` counts people, so neither sums: a reader of the
 * week would get a meaningless ratio and the same viewer counted every day.
 */
export const LINKEDIN_WINDOW_SUMMABLE_FIELDS = [
  "impressionCount",
  "clickCount",
  "likeCount",
  "commentCount",
  "shareCount",
] as const;

/**
 * The Page's organic share statistics over a window. VERIFIED against the Share
 * Statistics page (li-lms-2026-10, "Retrieve Time-Bound Share Statistics"):
 * GET /rest/organizationalEntityShareStatistics?q=organizationalEntity
 * &organizationalEntity={org}&timeIntervals=(...DAY), answering one element per
 * day, each a DELTA for that day under `totalShareStatistics`. The endpoint
 * "doesn't support pagination", so a window comes back whole. Needs
 * `rw_organization_admin`.
 *
 * Only the summable counters are returned (LINKEDIN_WINDOW_SUMMABLE_FIELDS), and
 * only those LinkedIn reported on at least one day: absent, never an invented 0.
 * The page notes time-bound `shareCount` excludes instant reposts, so it will
 * not match the lifetime figure.
 *
 * THROWS on a body with no `elements` array, like getFollowerGains.
 */
export async function getShareStatisticsWindow(window: LinkedInStatsWindow): Promise<Record<string, number>> {
  const orgUrn = await getOrganizationUrn();
  const { data } = await request<{ elements?: LinkedInShareStatsElement[] }>(
    "GET",
    `/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${encodeURIComponent(orgUrn)}` +
      `&${timeIntervalsParam(window)}`,
  );
  const elements = data?.elements;
  if (!Array.isArray(elements)) {
    throw new LinkedInError(
      0,
      "time-bound share statistics returned no elements array; refusing to report 0 activity",
      "GET",
      "/organizationalEntityShareStatistics",
    );
  }
  const out: Record<string, number> = {};
  for (const field of LINKEDIN_WINDOW_SUMMABLE_FIELDS) {
    const values = elements.map((e) => e.totalShareStatistics?.[field]);
    if (values.some((v) => typeof v === "number" && Number.isFinite(v))) out[field] = sum(values);
  }
  return out;
}
