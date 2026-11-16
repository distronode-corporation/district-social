/**
 * The message of an unknown thrown value, for logs and vendor-error wrapping.
 *
 * A folder-local copy of `getErrorMessage` in src/utils/errors.ts, with the
 * same semantics: an Error gives its message, a string is returned as is, an
 * object with a `message` field gives `String(message)`, and anything else
 * falls through to `String(value)`. It lives here because this engine takes
 * relative imports only (no `@/`), so it cannot import the app's copy. Keep
 * the two in step.
 *
 * The inline `err instanceof Error ? err.message : String(err)` it replaces
 * logged a plain-object rejection such as `{ message: "rate limited" }` as
 * "[object Object]".
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}
