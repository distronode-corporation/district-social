/**
 * The retry layer, and mostly the SAFETY rule rather than the backoff.
 *
 * Before this existed, every vendor client classified its own transient
 * failures and nothing acted on it: MetaGraphError.retryable and
 * ThreadsError.retryable were implemented, documented and tested, and grepping
 * every call site returned only the definitions. A 429 failed the leg outright
 * on all nine platforms.
 *
 * The tests that matter most here are the ones asserting a retry does NOT
 * happen. Retrying a create after a timeout publishes twice to a real brand
 * account, and a duplicate post is worse than a failed leg because a failed leg
 * is visible and fixable.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  MAX_RETRY_AFTER_MS,
  isRejection,
  isUnknownOutcome,
  retryAfterHeader,
  retryAfterMs,
  withRetry,
} from "../retry.js";
import { MetaGraphError } from "../meta-graph.js";

/** Never actually sleeps: every test injects this. */
const opts = { random: () => 1, wait: async () => {} };

class VendorError extends Error {
  constructor(
    readonly status: number,
    /** Matches the field every vendor client now fills from `res.headers`. */
    readonly retryAfter: string | number | null = null,
  ) {
    super(`vendor ${status}`);
  }
}

/**
 * Record the waits a run performed. `random: () => 1` pins full jitter to the
 * top of its window, so an unchanged backoff is the exact sequence
 * [500, 1000, …] and any Retry-After effect shows up as a different number
 * rather than as a range.
 */
function recorder() {
  const waits: number[] = [];
  return { waits, wait: async (ms: number) => void waits.push(ms) };
}

beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

describe("classification", () => {
  it("treats 429 as a rejection on any vendor", () => {
    expect(isRejection(new VendorError(429))).toBe(true);
    expect(isUnknownOutcome(new VendorError(429))).toBe(false);
  });

  it("treats 5xx, timeouts and network failures as UNKNOWN, not rejections", () => {
    expect(isUnknownOutcome(new VendorError(503))).toBe(true);
    expect(isRejection(new VendorError(503))).toBe(false);

    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    expect(isUnknownOutcome(timeout)).toBe(true);

    expect(isUnknownOutcome(new TypeError("fetch failed"))).toBe(true);
  });

  /**
   * ⛔ THE SENTINEL EVERY CLIENT ACTUALLY USES, AND THE ONE THIS FUNCTION USED
   * TO MISS COMPLETELY.
   *
   * None of the eight vendor clients ever throws a bare `TimeoutError` to this
   * layer. Each wraps it in its OWN error class carrying `status: 0`
   * (through vendor-fetch.ts, which all eight send through). So `statusOf`
   * returned the number 0, `status !== undefined` was true, and the function
   * returned false before the TimeoutError arm below could ever run. The bare
   * `TimeoutError` case above passed the whole time, which is exactly why this
   * went unnoticed: the test used a shape production never produces.
   *
   * ⚠️ The test above stays. Both shapes must classify the same way, and one of
   * them is what the code says while the other is what the clients do.
   */
  it("treats a vendor error carrying status 0 as unknown, since 0 is not a status", () => {
    expect(isUnknownOutcome(new VendorError(0))).toBe(true);
    expect(isRejection(new VendorError(0))).toBe(false);
  });

  it("treats a real vendor timeout the same as a bare TimeoutError", () => {
    const bare = new Error("timed out");
    bare.name = "TimeoutError";

    // The shape the docblock describes and the shape the clients emit have to
    // agree, or the promise "covers the abort/timeout failures that never reach
    // a status at all" is only true of the one nobody throws.
    expect(isUnknownOutcome(bare)).toBe(isUnknownOutcome(new VendorError(0)));
  });

  it("treats an ordinary 4xx as a decision, not a blip", () => {
    expect(isUnknownOutcome(new VendorError(400))).toBe(false);
    expect(isRejection(new VendorError(400))).toBe(false);
  });

  /**
   * A bare Error from our OWN code must never look like a vendor blip. If it
   * did, a genuine bug inside a transport would be silently retried three times
   * and reported as a vendor problem.
   */
  it("does not treat a plain Error as retryable", () => {
    expect(isUnknownOutcome(new Error("boom"))).toBe(false);
    expect(isRejection(new Error("boom"))).toBe(false);
  });

  /**
   * Meta signals rate limits by CODE in the body, not an HTTP 429, so status
   * alone misses them entirely — which is the whole reason `rateLimited` was
   * split out of the existing `retryable`.
   */
  it("reads Meta's code-based rate limit, which carries no 429", () => {
    const rateLimited = new MetaGraphError("too many calls", 400, 4, null, null, null);
    expect(rateLimited.status).not.toBe(429);
    expect(rateLimited.rateLimited).toBe(true);
    expect(isRejection(rateLimited)).toBe(true);
  });

  /**
   * ⛔ The distinction the whole design rests on. API_UNKNOWN (1) and
   * API_SERVICE (2) are retryable, but they are NOT rejections: the call may
   * have landed. Collapsing them into `rateLimited` would make double-posting
   * possible on exactly the codes Meta returns when it is struggling.
   */
  it("does NOT call Meta's transient service codes rejections", () => {
    for (const code of [1, 2]) {
      const err = new MetaGraphError("service", 400, code, null, null, null);
      expect(err.retryable).toBe(true);
      expect(err.rateLimited).toBe(false);
      expect(isRejection(err)).toBe(false);
    }
  });
});

describe("withRetry", () => {
  it("returns the first success without retrying", async () => {
    const fn = vi.fn(async () => "ok");
    expect(await withRetry("t", "transient", fn, opts)).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries an idempotent operation through a transient failure", async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new VendorError(503))
      .mockResolvedValue("ok");
    expect(await withRetry("t", "transient", fn, opts)).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  /**
   * ⛔ THE DUPLICATE-POST GUARD.
   *
   * A 5xx or a timeout on a create means the post MAY have landed and only the
   * answer was lost — meta-graph.ts's own timeout wording says exactly that.
   * Retrying would publish twice to a real brand account, with nothing
   * reporting it.
   */
  it("does NOT retry a create when the outcome is unknown", async () => {
    const fn = vi.fn(async () => {
      throw new VendorError(502);
    });
    await expect(withRetry("publish", "rejected-only", fn, opts)).rejects.toThrow("vendor 502");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry a create on a timeout either", async () => {
    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    const fn = vi.fn(async () => {
      throw timeout;
    });
    await expect(withRetry("publish", "rejected-only", fn, opts)).rejects.toThrow("timed out");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  /**
   * ⛔ THE SAME SAFETY RULE, AGAINST THE SHAPE A CLIENT ACTUALLY THROWS.
   *
   * The test above uses a bare `TimeoutError`, which no vendor client emits:
   * each wraps it in its own error class carrying `status: 0`. That is the
   * shape that has to stay un-retried for a create, and it is the one the
   * clients' own timeout message is about ("the request may still complete
   * server-side; check before retrying a publish"). Repeating a create after a
   * timeout double-posts to a real brand account, and a duplicate is worse than
   * a failed leg because a failed leg is visible and fixable.
   */
  it("does NOT retry a create when the client reports a timeout as status 0", async () => {
    const fn = vi.fn(async () => {
      throw new VendorError(0);
    });
    await expect(withRetry("publish", "rejected-only", fn, opts)).rejects.toThrow("vendor 0");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  /**
   * ⛔ AND THE OTHER HALF. `transient` wraps `deletePost` and `postFacts`,
   * both idempotent, and a timed-out one would silently never be retried if
   * `status: 0` short-circuited `isUnknownOutcome`. Deleting the `status === 0` arm in retry.ts makes this
   * fail and the create test above still pass, which is the pair worth holding:
   * the fix must not have bought retry-on-timeout for publishes.
   */
  it("DOES retry an idempotent call when the client reports a timeout as status 0", async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new VendorError(0))
      .mockResolvedValue("ok");
    expect(await withRetry("deletePost", "transient", fn, opts)).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  /** A rejection is safe even for a create: the vendor refused before acting. */
  it("DOES retry a create when the vendor definitively refused", async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new VendorError(429))
      .mockResolvedValue("posted");
    expect(await withRetry("publish", "rejected-only", fn, opts)).toBe("posted");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("gives up after the attempt bound and rethrows the vendor's own error", async () => {
    const fn = vi.fn(async () => {
      throw new VendorError(503);
    });
    await expect(withRetry("t", "transient", fn, opts)).rejects.toBeInstanceOf(VendorError);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  /**
   * The error must survive unchanged: every transport's postFacts and
   * deletePost branches on `instanceof` its own error class, and wrapping the
   * failure would silently turn "already gone is success" into a thrown delete.
   */
  it("rethrows the original error object, not a wrapper", async () => {
    const original = new MetaGraphError("gone", 404, null, null, null, null);
    const fn = async () => {
      throw original;
    };
    await expect(withRetry("t", "transient", fn, opts)).rejects.toBe(original);
  });

  it("backs off with full jitter, bounded by the cap", async () => {
    const waits: number[] = [];
    const fn = vi.fn(async () => {
      throw new VendorError(503);
    });
    await expect(
      withRetry("t", "transient", fn, {
        maxAttempts: 4,
        random: () => 1,
        wait: async (ms) => void waits.push(ms),
      }),
    ).rejects.toThrow();
    // Exponential while under the cap, and never longer than the cap.
    expect(waits).toEqual([500, 1000, 2000]);
    expect(Math.max(...waits)).toBeLessThanOrEqual(8000);
  });

  it("jitters down to zero, so concurrent retries do not resynchronise", async () => {
    const waits: number[] = [];
    const fn = vi.fn(async () => {
      throw new VendorError(503);
    });
    await expect(
      withRetry("t", "transient", fn, { random: () => 0, wait: async (ms) => void waits.push(ms) }),
    ).rejects.toThrow();
    expect(waits).toEqual([0, 0]);
  });
});

/**
 * `Retry-After`, RFC 9110 §10.2.3. Parsed in ONE place rather than in nine
 * transports, so these tests are the whole contract every vendor inherits.
 *
 * The two that matter most are the negative ones. An unparseable header must
 * fall back to the existing backoff rather than to a guess, and an hour-long
 * window must be capped rather than obeyed: a publish worker parked for 3600s
 * is worse than a failed leg, because a failed leg is visible and retryable.
 */
describe("retryAfterMs", () => {
  const NOW = Date.parse("2026-08-11T12:00:00Z");

  it("reads the delta-seconds form", () => {
    expect(retryAfterMs(new VendorError(429, "12"), NOW)).toBe(12_000);
  });

  it("reads the HTTP-date form, relative to now", () => {
    const at = new Date(NOW + 5_000).toUTCString();
    expect(retryAfterMs(new VendorError(429, at), NOW)).toBe(5_000);
  });

  /** A date that has already passed means the window lifted, not "wait a while". */
  it("floors a date already in the past at zero", () => {
    const at = new Date(NOW - 60_000).toUTCString();
    expect(retryAfterMs(new VendorError(429, at), NOW)).toBe(0);
    expect(retryAfterMs(new VendorError(429, "0"), NOW)).toBe(0);
  });

  it("caps both forms at MAX_RETRY_AFTER_MS", () => {
    expect(retryAfterMs(new VendorError(429, "3600"), NOW)).toBe(MAX_RETRY_AFTER_MS);
    const farOff = new Date(NOW + 3_600_000).toUTCString();
    expect(retryAfterMs(new VendorError(429, farOff), NOW)).toBe(MAX_RETRY_AFTER_MS);
  });

  it("answers null when the vendor sent no header at all", () => {
    expect(retryAfterMs(new VendorError(429), NOW)).toBeNull();
    expect(retryAfterMs(new VendorError(429, null), NOW)).toBeNull();
    expect(retryAfterMs(new Error("no such field"), NOW)).toBeNull();
    expect(retryAfterMs(undefined, NOW)).toBeNull();
  });

  /**
   * ⛔ `Number()` accepts every one of these and would turn a vendor's typo
   * into our timing. delta-seconds is `1*DIGIT` and nothing else.
   */
  it("answers null for anything outside the two grammars", () => {
    for (const raw of ["", "   ", "soon", "-5", "1.5", "10s", "0x10", "+30", "Tue, 99 Xxx 2026"]) {
      expect(retryAfterMs(new VendorError(429, raw), NOW)).toBeNull();
    }
  });

  /** Whitespace around a valid value is the vendor being sloppy, not malformed. */
  it("tolerates surrounding whitespace on a valid value", () => {
    expect(retryAfterMs(new VendorError(429, " 7 "), NOW)).toBe(7_000);
  });

  /** For a future client whose SDK hands over a count instead of a header. */
  it("reads a numeric value as seconds", () => {
    expect(retryAfterMs(new VendorError(429, 3), NOW)).toBe(3_000);
    expect(retryAfterMs(new VendorError(429, Number.POSITIVE_INFINITY), NOW)).toBeNull();
    expect(retryAfterMs(new VendorError(429, Number.NaN), NOW)).toBeNull();
  });
});

describe("withRetry honouring Retry-After", () => {
  const NOW = Date.parse("2026-08-11T12:00:00Z");
  const now = () => NOW;

  it("waits exactly what the vendor asked for, not the backoff", async () => {
    const { waits, wait } = recorder();
    const fn = vi.fn(async () => {
      throw new VendorError(429, "4");
    });
    await expect(withRetry("x.publishNow", "rejected-only", fn, { random: () => 1, wait, now })).rejects.toThrow();
    // Unhonoured, this would have been [500, 1000].
    expect(waits).toEqual([4_000, 4_000]);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("honours the HTTP-date form the same way", async () => {
    const { waits, wait } = recorder();
    const at = new Date(NOW + 6_000).toUTCString();
    const fn = vi.fn(async () => {
      throw new VendorError(429, at);
    });
    await expect(withRetry("t", "transient", fn, { random: () => 1, wait, now })).rejects.toThrow();
    expect(waits).toEqual([6_000, 6_000]);
  });

  it("never parks longer than the cap, however long the vendor asks", async () => {
    const { waits, wait } = recorder();
    const fn = vi.fn(async () => {
      throw new VendorError(429, "3600");
    });
    await expect(withRetry("t", "transient", fn, { random: () => 1, wait, now })).rejects.toThrow();
    expect(waits).toEqual([MAX_RETRY_AFTER_MS, MAX_RETRY_AFTER_MS]);
    expect(Math.max(...waits)).toBeLessThanOrEqual(30_000);
  });

  it("leaves the backoff untouched when the vendor sent no header", async () => {
    const { waits, wait } = recorder();
    const fn = vi.fn(async () => {
      throw new VendorError(503);
    });
    await expect(
      withRetry("t", "transient", fn, { maxAttempts: 4, random: () => 1, wait, now }),
    ).rejects.toThrow();
    expect(waits).toEqual([500, 1000, 2000]);
  });

  it("falls back to the backoff on a malformed header rather than guessing", async () => {
    const { waits, wait } = recorder();
    const fn = vi.fn(async () => {
      throw new VendorError(503, "whenever");
    });
    await expect(
      withRetry("t", "transient", fn, { maxAttempts: 4, random: () => 1, wait, now }),
    ).rejects.toThrow();
    expect(waits).toEqual([500, 1000, 2000]);
  });

  /**
   * The safety rule outranks the header. A create that got an unknown outcome
   * is not retried no matter how politely the vendor asks, because the post may
   * already be live.
   */
  it("does not retry a create on a 5xx even when it carries a Retry-After", async () => {
    const { waits, wait } = recorder();
    const fn = vi.fn(async () => {
      throw new VendorError(502, "1");
    });
    await expect(
      withRetry("publish", "rejected-only", fn, { random: () => 1, wait, now }),
    ).rejects.toThrow("vendor 502");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });

  it("succeeds on the retry the vendor's window allowed", async () => {
    const { waits, wait } = recorder();
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new VendorError(429, "2"))
      .mockResolvedValue("posted");
    expect(await withRetry("publish", "rejected-only", fn, { random: () => 1, wait, now })).toBe("posted");
    expect(waits).toEqual([2_000]);
  });
});

/**
 * ⛔ THE PLUMBING, NOT THE PARSER. The parser above would pass just as happily
 * if no vendor client ever populated the field, which is precisely the failure
 * this engine has already had once: `MetaGraphError.retryable` was implemented,
 * documented and tested while NOTHING read it. These assert the header actually
 * survives the trip from a real Response into the error retry.ts sees.
 */
describe("vendor errors carry the header", () => {
  it("MetaGraphError carries Retry-After through the constructor", () => {
    const err = new MetaGraphError("too many calls", 400, 4, null, null, null, "25");
    expect(err.retryAfter).toBe("25");
    expect(retryAfterMs(err, Date.now())).toBe(25_000);
  });

  it("defaults to null on errors built without one, so behaviour is unchanged", () => {
    const err = new MetaGraphError("gone", 404, null, null, null, null);
    expect(err.retryAfter).toBeNull();
    expect(retryAfterMs(err, Date.now())).toBeNull();
  });
});

/**
 * ⛔ THE REGRESSION SUITE FOR A REAL PRODUCTION CRASH, not defensive trivia.
 * `retryAfterHeader` had NO direct tests, and read
 * `res?.headers?.get("retry-after")` — which throws when `headers` is present
 * but has no callable `get`. That produced 54 `TypeError: u?.get is not a
 * function` events in 7 days on the error path of all eight vendor clients,
 * turning a rate-limit response into an unclassified crash: the exact outcome
 * the function's own docstring says it exists to prevent.
 *
 * ⚠️ EVERY CASE HERE IS A SHAPE A REAL RESPONSE CAN HAVE. `tsc` accepts all of
 * them at the call sites because a vendor response crosses a trust boundary the
 * compiler cannot police, so the type annotation is not the test.
 */
describe("retryAfterHeader tolerates every header-bag shape", () => {
  it("reads a WHATWG Headers bag", () => {
    const res = { headers: new Headers({ "retry-after": "42" }) };
    expect(retryAfterHeader(res)).toBe("42");
  });

  it("returns null from a Headers bag that has no Retry-After", () => {
    expect(retryAfterHeader({ headers: new Headers() })).toBeNull();
  });

  // ── the shapes that used to throw ──────────────────────────────────────────
  it("does not throw on a PLAIN-OBJECT bag, and reads the value", () => {
    expect(retryAfterHeader({ headers: { "retry-after": "17" } })).toBe("17");
  });

  it("matches the header name case-insensitively (RFC 9110 §5.1)", () => {
    expect(retryAfterHeader({ headers: { "Retry-After": "9" } })).toBe("9");
    expect(retryAfterHeader({ headers: { "RETRY-AFTER": "8" } })).toBe("8");
  });

  it("takes the first value when Node hands back a string[]", () => {
    expect(retryAfterHeader({ headers: { "retry-after": ["3", "99"] } })).toBe("3");
  });

  it("stringifies a numeric value, which retryAfterMs reads as seconds", () => {
    expect(retryAfterHeader({ headers: { "retry-after": 30 } })).toBe("30");
  });

  it("returns null for an empty plain bag rather than throwing", () => {
    expect(retryAfterHeader({ headers: {} })).toBeNull();
  });

  it("returns null when a plain bag carries a NON-CALLABLE get property", () => {
    // The precise shape behind the production TypeError: `?.` passes because
    // `headers` is truthy, then `.get(...)` is not a function.
    expect(retryAfterHeader({ headers: { get: "not a function" } })).toBeNull();
  });

  it("returns null when get() itself throws", () => {
    const headers = {
      get() {
        throw new Error("header bag exploded");
      },
    };
    expect(retryAfterHeader({ headers })).toBeNull();
  });

  it("returns null for null/undefined headers and for no response at all", () => {
    expect(retryAfterHeader({ headers: null })).toBeNull();
    expect(retryAfterHeader({})).toBeNull();
    expect(retryAfterHeader(null)).toBeNull();
    expect(retryAfterHeader(undefined)).toBeNull();
  });

  it("treats an explicitly null header value as absent", () => {
    expect(retryAfterHeader({ headers: { "retry-after": null } })).toBeNull();
  });

  /**
   * The end-to-end point of the fix: a plain-bag 429 has to reach retryAfterMs
   * as an honoured backoff instead of crashing the client that built the error.
   */
  it("feeds retryAfterMs from a plain-object 429, end to end", () => {
    const raw = retryAfterHeader({ headers: { "Retry-After": "25" } });
    const err = new MetaGraphError("too many calls", 429, 4, null, null, null, raw);
    expect(retryAfterMs(err, Date.now())).toBe(25_000);
  });
});

describe("non-Error rejections and odd Retry-After types", () => {
  afterEach(() => vi.restoreAllMocks());

  it("retries a plain-object 429 and logs it through String() rather than crashing on .message", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rejection = { status: 429, toString: () => "vendor said slow down" };
    const fn = vi.fn<() => Promise<string>>().mockRejectedValueOnce(rejection).mockResolvedValue("ok");

    expect(await withRetry("publish", "rejected-only", fn, opts)).toBe("ok");

    expect(fn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/: vendor said slow down$/));
  });

  it("ignores a Retry-After that is neither a string nor a number", () => {
    // `retryAfter` is structurally typed and filled from untyped SDK objects,
    // so a boolean or an object must fall back to our own backoff.
    expect(retryAfterMs({ retryAfter: true }, 0)).toBeNull();
    expect(retryAfterMs({ retryAfter: { seconds: 5 } }, 0)).toBeNull();
  });
});
