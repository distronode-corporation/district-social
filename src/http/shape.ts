/**
 * Reading a vendor response at the client boundary: the fields a client uses,
 * checked one by one, with a typed error when one is not what it must be.
 *
 * ⛔ A RESPONSE IS INPUT, NOT A TYPE. `JSON.parse(text) as T` told the compiler
 * what the vendor sends and checked nothing, so a renamed field, a number where
 * a string was due or an error envelope on a 200 travelled into the engine as a
 * well-typed value and failed somewhere far from the cause, or worse, did not
 * fail. Each client now reads its responses through a `Shape`, and a field that
 * is missing or of the wrong type throws `ResponseShapeError` right there.
 *
 * ⛔ ONLY THE FIELDS A CLIENT READS. Vendors add fields all the time, and an
 * unknown field is not an error: a client checks what it uses and ignores the
 * rest, so a vendor's additive change never takes a publish down.
 *
 * ⛔ THE ERROR NAMES A TYPE, NEVER A VALUE. A response can carry a token, an
 * account's details or a whole post, and the message ends up in logs and in
 * `draft.lastError`, so it says which field and what kind of value was there
 * ("a number", "null"), not what the value was.
 *
 * ⛔ A SHAPE ERROR IS AN UNKNOWN OUTCOME. It is thrown only on a 2xx answer,
 * which means the vendor performed the request: a create may well have landed
 * even though its id could not be read. retry.ts's `isUnknownOutcome` therefore
 * counts it, so a create is never re-sent and publish.ts marks the leg failed
 * with "the post may already be live", while an idempotent read is retried.
 *
 * Relative imports only, like the rest of this folder.
 */

/** A 2xx vendor response that does not have the shape the client reads. */
export class ResponseShapeError extends Error {
  override readonly name = "ResponseShapeError";

  constructor(
    /** The vendor, as the client names it in its own errors ("x", "reddit"). */
    readonly vendor: string,
    /** What the response was for ("POST /tweets"). */
    readonly operation: string,
    /** Where in the response the problem is (`data.id`, `items[2].title`). */
    readonly path: string,
    /** What the client needed there ("a non-empty string"). */
    readonly expected: string,
    /** What was there, as a kind of value ("a number", "missing"). */
    readonly got: string,
  ) {
    super(`${vendor} ${operation}: unexpected response shape at ${path}: expected ${expected}, got ${got}`);
  }
}

/** The kind of a value, for an error message. Never the value itself. */
export function kindOf(value: unknown): string {
  if (value === undefined) return "missing";
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "string") return value === "" ? "an empty string" : "a string";
  if (typeof value === "number") return Number.isFinite(value) ? "a number" : "a non-finite number";
  return typeof value === "object" ? "an object" : `a ${typeof value}`;
}

/**
 * The path segment for a member of an object whose KEYS come from the
 * response (a bag of counters, a map keyed by id). A key is vendor data like
 * any value, so it never reaches the message: `analytics[?]`, not
 * `analytics.<whatever the vendor sent>`.
 */
export const BODY_KEY = "[?]";

/** A plain JSON object, as `JSON.parse` builds one. */
export type JsonObject = Record<string, unknown>;

/**
 * The readers for one response. Each takes the value and the path it was read
 * from, and returns it typed or throws `ResponseShapeError`. The `opt` readers
 * also accept `undefined` and `null`, and return `undefined` for both: vendors
 * use the two interchangeably for "not set".
 */
export interface Shape {
  fail(path: string, expected: string, value: unknown): never;
  obj(value: unknown, path: string): JsonObject;
  optObj(value: unknown, path: string): JsonObject | undefined;
  arr(value: unknown, path: string): unknown[];
  optArr(value: unknown, path: string): unknown[] | undefined;
  str(value: unknown, path: string): string;
  optStr(value: unknown, path: string): string | undefined;
  /** A non-empty string: what an id, a URL or a token must be. */
  id(value: unknown, path: string): string;
  optId(value: unknown, path: string): string | undefined;
  num(value: unknown, path: string): number;
  optNum(value: unknown, path: string): number | undefined;
  bool(value: unknown, path: string): boolean;
  optBool(value: unknown, path: string): boolean | undefined;
  /** An id the vendor sends as either a string or a number, read as a string. */
  idOrNum(value: unknown, path: string): string;
  optIdOrNum(value: unknown, path: string): string | undefined;
  /** Each element of an array, read with `read` at `path[i]`. */
  each<T>(value: unknown, path: string, read: (item: unknown, at: string) => T): T[];
  /** Like `each`, for an array that may be absent (read as empty). */
  optEach<T>(value: unknown, path: string, read: (item: unknown, at: string) => T): T[];
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function absent(value: unknown): value is null | undefined {
  return value === undefined || value === null;
}

/** The readers for one response of `vendor`'s `operation`. */
export function shape(vendor: string, operation: string): Shape {
  const s: Shape = {
    fail(path, expected, value) {
      throw new ResponseShapeError(vendor, operation, path, expected, kindOf(value));
    },
    obj: (v, p) => (isObject(v) ? v : s.fail(p, "an object", v)),
    optObj: (v, p) => (absent(v) ? undefined : s.obj(v, p)),
    // Array.isArray narrows to any[]; the elements are unknown until read.
    arr: (v, p) => (Array.isArray(v) ? (v as unknown[]) : s.fail(p, "an array", v)),
    optArr: (v, p) => (absent(v) ? undefined : s.arr(v, p)),
    str: (v, p) => (typeof v === "string" ? v : s.fail(p, "a string", v)),
    optStr: (v, p) => (absent(v) ? undefined : s.str(v, p)),
    id: (v, p) => (typeof v === "string" && v !== "" ? v : s.fail(p, "a non-empty string", v)),
    optId: (v, p) => (absent(v) ? undefined : s.id(v, p)),
    num: (v, p) => (typeof v === "number" && Number.isFinite(v) ? v : s.fail(p, "a finite number", v)),
    optNum: (v, p) => (absent(v) ? undefined : s.num(v, p)),
    bool: (v, p) => (typeof v === "boolean" ? v : s.fail(p, "a boolean", v)),
    optBool: (v, p) => (absent(v) ? undefined : s.bool(v, p)),
    idOrNum: (v, p) =>
      typeof v === "number" && Number.isFinite(v) ? String(v) : typeof v === "string" && v !== "" ? v : s.fail(p, "a non-empty string or a number", v),
    optIdOrNum: (v, p) => (absent(v) ? undefined : s.idOrNum(v, p)),
    each: (v, p, read) => s.arr(v, p).map((item, i) => read(item, `${p}[${i}]`)),
    optEach: (v, p, read) => (absent(v) ? [] : s.each(v, p, read)),
  };
  return s;
}
