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
