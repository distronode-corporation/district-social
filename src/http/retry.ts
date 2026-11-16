/**
 * Bounded retry with jittered backoff, and the safety rule that decides when a
 * retry is allowed at all.
 *
 * ⛔ WHY THIS EXISTS. Every vendor client in this engine classifies its own
 * transient failures (`MetaGraphError.retryable`, `ThreadsError.retryable`),
 * and a classification nothing acts on is worth nothing: without this module
 * a 429 or a 503 fails the leg outright on every platform.
 *
 * ⛔ THE RULE THAT MATTERS MORE THAN THE BACKOFF. A retry is only safe when the
 * request definitely did NOT happen. That is not the same as "the request
 * failed":
 *
 *   - A 429 is a REJECTION. The vendor refused before doing anything, so
 *     re-sending cannot duplicate.
 *   - A 500, a 502 or a TIMEOUT is an UNKNOWN. The write may well have landed
 *     and only the answer was lost; vendor-fetch.ts's timeout wording says
 *     exactly this ("may still complete server-side"). Re-sending a
 *     create here posts twice to a real brand account.
 *
 * Silent duplicate posts are worse than a failed leg, for the same reason
 * linkedin-transport.ts refuses to truncate rather than silently dropping
 * images: a failed leg is visible and fixable, a duplicate is neither. So
 * creates get `rejected-only` and everything idempotent gets `transient`.
 *
 * ✅ `Retry-After` IS honoured, and it is honoured HERE
 * rather than in nine transports for the same reason the retry itself is:
 * a rule implemented per-vendor is a rule the tenth vendor is born without.
 * All eight vendor error classes carry the raw header (see
 * `RetryAfterCarrier`); this module owns parsing it, capping it, and deciding
 * when to ignore it. For a vendor whose window is HOURS (Bluesky's
 * createSession is 10 per 24h) no in-process wait helps, which is why the cap
 * below exists and why sessions are persisted instead of retried.
 */

import { getErrorMessage } from "../error-message.js";

/** Attempts INCLUDING the first. 3 means at most two retries. */
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 8_000;

/**
 * Ceiling on a wait the VENDOR asked for. Deliberately its own constant, and
 * deliberately larger than `MAX_DELAY_MS`.
 *
 * `MAX_DELAY_MS` bounds a delay this module invented, so it is kept short. A
 * `Retry-After` is the vendor stating its actual window, which earns a longer
 * ceiling — clamping every one of them to 8s would burn the remaining attempts
 * against a limit that had not lifted yet, i.e. honour the header in name only.
 *
 * ⛔ It is a CEILING, not an instruction. Meta answers `Retry-After: 3600` on an
 * app-level rate limit and Reddit has been seen to send a full hour as well;
 * parking a publish worker for that long is worse than failing the leg, because
 * the leg is visible and retryable by the operator while a hung worker is
 * neither. 30s is sized against the per-vendor request timeouts (15s–30s): a
 * wait longer than the request that produced it has stopped absorbing a blip.
 * Worst case is therefore two waits of 30s, bounded by `MAX_ATTEMPTS`.
 */
export const MAX_RETRY_AFTER_MS = 30_000;

/**
 * `transient` — the operation is idempotent (a read, or a delete every
 * transport already treats "already gone" as success). Retries rejections AND
 * unknowns, because repeating it cannot cause harm.
 *
 * `rejected-only` — the operation creates something. Retries ONLY a definitive
 * rejection, never an unknown. See this module's header.
 */
export type RetryPolicy = "transient" | "rejected-only";

/** Every vendor error class in this engine carries a numeric `status`. */
function statusOf(err: unknown): number | undefined {
  const s = (err as { status?: unknown })?.status;
  return typeof s === "number" ? s : undefined;
}

/**
 * The vendor refused to perform the request. Safe to repeat even for a create.
 *
 * `rateLimited` is consulted where a client implements it: Meta and Threads
 * signal rate limits through an error CODE in the body rather than an HTTP
 * status, so 429 alone would miss them.
 */
export function isRejection(err: unknown): boolean {
  if (statusOf(err) === 429) return true;
  return (err as { rateLimited?: unknown })?.rateLimited === true;
}

/**
 * The request may or may not have been performed. Safe to repeat ONLY when the
 * operation is idempotent.
 *
 * Covers 5xx, plus the abort/timeout and network-level failures that never
 * reach a status at all — those are exactly the "we never heard back" case.
 * And 408, the one 4xx that is not a decision: the server timed out waiting,
 * and says nothing about whether the request was performed.
 */
export function isUnknownOutcome(err: unknown): boolean {
  const status = statusOf(err);
  if (status !== undefined && (status >= 500 || status === 408)) return true;

  // ⛔ 0 IS NOT A STATUS. IT IS EVERY CLIENT'S SENTINEL FOR "NO HTTP RESPONSE
  // HAPPENED AT ALL", AND WITHOUT THIS LINE THE WHOLE FUNCTION IS DEAD BELOW.
  //
  // All eight vendor clients wrap a timeout or a dropped connection into their
  // own error class carrying `status: 0` (through vendor-fetch.ts, which owns
  // that wrap for every one of them). So `statusOf` returns the NUMBER 0,
  // `status !== undefined` is true, and without this line the check below
  // would return false before the TimeoutError and TypeError arms could ever
  // run, covering none of the failures the docblock above promises.
  //
  // `withRetry(..., "transient", ...)` wraps `deletePost` and `postFacts`
  // (transport.ts), so a timed-out delete or facts read is exactly the case
  // the policy exists for.
  //
  // ⚠️ This does NOT make a timed-out PUBLISH retryable, and it must not.
  // `shouldRetry` gates this whole function on `policy === "transient"`, and
  // `publishNow` is registered `rejected-only`. Several clients say so in the
  // timeout message itself ("the request may still complete server-side; check
  // before retrying a publish"). Repeating an idempotent read is free;
  // repeating a create is a double post.
  if (status === 0) return true;

  if (status !== undefined) return false; // a real 4xx answer is a decision, not a blip

  const name = (err as { name?: unknown })?.name;
  if (name === "TimeoutError" || name === "AbortError") return true;
  // fetch's network failure. Deliberately narrow: a bare `Error` from our own
  // code must NOT be treated as a vendor blip and retried.
  return err instanceof TypeError && /fetch|network/i.test(String((err as Error).message));
}

function shouldRetry(err: unknown, policy: RetryPolicy): boolean {
  if (isRejection(err)) return true;
  return policy === "transient" && isUnknownOutcome(err);
}

/**
 * What a vendor error has to carry for its `Retry-After` to be honoured.
 *
 * ⛔ STRUCTURAL, AND THE RAW HEADER RATHER THAN A PARSED NUMBER. Every one of
 * the eight clients populates it with `res.headers.get("retry-after")` and
 * nothing more — verbatim, unvalidated, `null` when the vendor sent none. The
 * parsing rule then lives in exactly one place instead of eight, which is the
 * same reason `withRetry` is applied at registration rather than inside each
 * transport. A client that pre-parsed would be a ninth implementation of RFC
 * 9110 §10.2.3, and the first one to get the HTTP-date form wrong would fail
 * silently: an unparseable value is indistinguishable from an absent one.
 *
 * A `number` is accepted and read as SECONDS, for a future client whose SDK
 * hands over a count rather than a header.
 */
export interface RetryAfterCarrier {
  retryAfter?: string | number | null;
}

/**
 * Pull the raw `Retry-After` off a vendor response, for the clients to hand to
 * their own error class. The one place the header NAME is spelled.
 *
 * ⛔ TOLERATES A MISSING **OR NON-`Headers`** BAG ON PURPOSE. This runs on the
 * ERROR path, inside the branch that is already turning a vendor failure into a
 * typed error. A throw here would replace the vendor's real message — the thing
 * an operator reads, and the thing every transport's `instanceof` handling
 * depends on — with a TypeError, converting a rate limit into an unclassified
 * crash. Degrading to the invented backoff is the correct answer to "I could
 * not read the headers", and it is what a `Response` stand-in without a usable
 * header bag gets rather than taking the publish down with it.
 *
 * ⛔ NOT `res?.headers?.get("retry-after")`, whose `?.` only guards `headers`
 * being null/undefined. When `headers` is PRESENT but has no callable `get` (a
 * plain object bag, which is what several SDKs and every hand-rolled
 * `Response` stand-in expose) that call throws
 *   TypeError: u?.get is not a function          (`u` = minified `res.headers`)
 * on the error path of every vendor client, i.e. exactly the "rate limit
 * becomes an unclassified crash" this docstring forbids, and it reaches an APM
 * as an unnamed transaction with no stack.
 *
 * ⚠️ A TYPE of `{ get(name: string): string | null }` satisfies TS, because a
 * vendor `Response` crosses a trust boundary `tsc` cannot police. A
 * compile-time shape is not a runtime guarantee at an I/O edge, so this
 * CHECKS rather than assumes, and reads a plain bag when it finds one.
 */
type HeaderBagLike =
  | { get(name: string): string | null }
  | Record<string, string | string[] | number | null | undefined>;

export function retryAfterHeader(
  res: { headers?: HeaderBagLike | null } | null | undefined,
): string | null {
  const headers = res?.headers;
  if (!headers) return null;

  // WHATWG `Headers`, node-fetch, undici — anything with a callable `get`.
  // ⚠️ `typeof === "function"` rather than `"get" in headers`: a plain object
  // carrying a non-callable `get` property is the shape that throws.
  const get = (headers as { get?: unknown }).get;
  if (typeof get === "function") {
    try {
      return (
        (headers as { get(name: string): string | null }).get("retry-after") ?? null
      );
    } catch {
      // A `get` that exists and throws is still "I could not read the headers".
      return null;
    }
  }

  // Plain-object bag. Header names are case-insensitive (RFC 9110 §5.1) and Node
  // hands back `string[]` for repeated headers, so neither can be assumed away.
  for (const [key, value] of Object.entries(
    headers as Record<string, string | string[] | number | null | undefined>,
  )) {
    if (key.toLowerCase() !== "retry-after") continue;
    const raw = Array.isArray(value) ? value[0] : value;
    if (raw === null || raw === undefined) return null;
    // A number is legal here: retryAfterMs accepts seconds, and stringifying
    // keeps this function's single documented return type.
    return typeof raw === "string" ? raw : String(raw);
  }
  return null;
}

/** RFC 9110 delta-seconds: `1*DIGIT`, and nothing that merely looks numeric. */
const DELTA_SECONDS_RE = /^\d+$/;

/**
 * ⛔ THE GUARD THAT STOPS `Date.parse` FROM RESCUING A MALFORMED HEADER.
 *
 * V8's Date.parse is far more permissive than any spec: it reads `"-5"` as
 * 2001-05-01 and `"1.5"` as 2001-01-05 (verified on Node).
 * Both are dates in the PAST, so without this guard a vendor's malformed
 * delta-seconds would clamp to 0 and produce an immediate re-send — the exact
 * opposite of what a rate limit asked for, arriving through a fallback that was
 * supposed to be the SAFE branch.
 *
 * All three HTTP-date forms RFC 9110 permits start with a day name (IMF-fixdate
 * `Wed, 21 Oct 2026 07:28:00 GMT`, obsolete RFC 850 `Sunday, 06-Nov-94 …`,
 * asctime `Sun Nov  6 08:49:37 1994`), so requiring one costs nothing legal and
 * rejects every accidental-number case.
 */
const HTTP_DATE_RE = /^[A-Za-z]{3,9},?\s/;

/**
 * Clamp to `[0, MAX_RETRY_AFTER_MS]`.
 *
 * A non-positive value (`Retry-After: 0`, or an HTTP-date already in the past
 * by the time we read it) means "the window has lifted", so it yields 0 rather
 * than falling back to the invented backoff. `MAX_ATTEMPTS` is what stops that
 * from becoming a hot loop, and it is the same bound that already applies when
 * full jitter rolls a 0.
 */
function clampRetryAfter(ms: number): number {
  if (!(ms > 0)) return 0;
  return Math.min(Math.round(ms), MAX_RETRY_AFTER_MS);
}

/**
 * The vendor's requested wait in ms, or null to mean "use the backoff".
 *
 * Both RFC 9110 §10.2.3 forms are read: `delta-seconds` (`Retry-After: 120`)
 * and `HTTP-date` (`Retry-After: Wed, 21 Oct 2026 07:28:00 GMT`).
 *
 * ⚠️ Null on ANYTHING it cannot read, never a guess. A malformed header is a
 * vendor bug, and the existing jittered backoff is a safe answer to it;
 * coercing `"soon"` or `"-5"` into a number would let a typo at the vendor
 * dictate our timing. That is why the delta-seconds test is `1*DIGIT` exactly
 * as the grammar states rather than `Number()`, which happily accepts `"1.5"`,
 * `"-1"`, `" 12 "`, `"0x10"` and `""`.
 */
export function retryAfterMs(err: unknown, now: number): number | null {
  const raw = (err as RetryAfterCarrier | null | undefined)?.retryAfter;
  if (raw === undefined || raw === null) return null;

  if (typeof raw === "number") {
    return Number.isFinite(raw) ? clampRetryAfter(raw * 1000) : null;
  }
  if (typeof raw !== "string") return null;

  const value = raw.trim();
  if (value === "") return null;
  if (DELTA_SECONDS_RE.test(value)) return clampRetryAfter(Number(value) * 1000);
  if (!HTTP_DATE_RE.test(value)) return null;

  const at = Date.parse(value);
  return Number.isNaN(at) ? null : clampRetryAfter(at - now);
}

/**
 * Full jitter (AWS's term): a random point in [0, capped exponential]. Chosen
 * over fixed backoff because the reconcile fans out across platforms at once,
 * and synchronised retries are how a rate limit becomes a thundering herd.
 */
function delayFor(attempt: number, random: () => number): number {
  return Math.floor(random() * Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface WithRetryOptions {
  maxAttempts?: number;
  /** Injectable for tests; nothing in production passes these. */
  random?: () => number;
  wait?: (ms: number) => Promise<void>;
  /** Injectable clock, read only to age an `HTTP-date` form of `Retry-After`. */
  now?: () => number;
}

/**
 * Run `fn`, retrying per `policy`. The final failure is rethrown UNCHANGED, so
 * callers keep the vendor's own error type and every transport's existing
 * `instanceof` handling still works.
 *
 * `label` appears only in the warning log, and exists so an operator can tell
 * which of nine platforms is being slow.
 */
export async function withRetry<T>(
  label: string,
  policy: RetryPolicy,
  fn: () => Promise<T>,
  opts: WithRetryOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
  const random = opts.random ?? Math.random;
  const wait = opts.wait ?? sleep;
  const now = opts.now ?? Date.now;

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxAttempts || !shouldRetry(err, policy)) throw err;
      // The vendor's own number wins when it gave one. Jitter is not applied on
      // top: it exists to desynchronise retries we timed ourselves, and a
      // Retry-After is already a per-response instruction rather than a shared
      // schedule, so scattering it would only mean asking again too early.
      const vendorMs = retryAfterMs(err, now());
      const ms = vendorMs ?? delayFor(attempt, random);
      console.warn(
        `[retry] ${label} failed (attempt ${attempt}/${maxAttempts}), retrying in ${ms}ms` +
          `${vendorMs === null ? "" : " (vendor Retry-After)"}: ` +
          `${getErrorMessage(err)}`,
      );
      await wait(ms);
    }
  }
}
