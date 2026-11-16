/**
 * The one fetch wrapper every vendor client in this engine sends through: a
 * bounded request whose transport failure arrives as the client's OWN error
 * class carrying `status: 0`.
 *
 * ⛔ STATUS 0 IS A CROSS-FILE CONTRACT. retry.ts's `isUnknownOutcome` reads a
 * status of 0 as "no HTTP response happened at all", which is what lets
 * `withRetry(..., "transient", ...)` repeat a timed-out read or delete. A
 * client that let the raw DOMException or fetch's TypeError escape instead
 * slipped past every caller's `instanceof XxxError` handling and surfaced as an
 * unclassified crash (meta-graph.ts did, for every non-timeout failure).
 *
 * ⛔ THE TIMEOUT WORDING IS NOT BOILERPLATE. An aborted request says nothing
 * about whether the vendor processed it: a create that times out may well have
 * landed, so the message tells the operator to CHECK before retrying. Retrying
 * a publish blindly is how you get two posts. This was hand-copied into about a
 * dozen call sites, and a third of them had dropped that clause.
 *
 * Relative imports only, like the rest of this folder.
 */

import { getErrorMessage } from "../error-message.js";

export interface VendorFetchOptions {
  /** Hard ceiling on the request, applied as `AbortSignal.timeout`. */
  timeoutMs: number;
  /**
   * Names what timed out when the client's error carries no method or path of
   * its own ("media upload", "Meta GET /me"). Prefixes the timeout message only.
   */
  label?: string;
  /** Builds the client's own error class. `status` is always 0 here. */
  wrap: (status: 0, message: string) => Error;
}

/** The canonical timeout message, exported so client tests can pin it. */
export function noResponseMessage(timeoutMs: number, label?: string): string {
  return (
    `${label ? `${label}: ` : ""}no response after ${timeoutMs / 1000}s ` +
    `(the request may still complete server-side; check before retrying a publish)`
  );
}

function wrapFailure(err: unknown, opts: VendorFetchOptions): Error {
  const timedOut = err instanceof Error && err.name === "TimeoutError";
  return opts.wrap(0, timedOut ? noResponseMessage(opts.timeoutMs, opts.label) : getErrorMessage(err));
}

/**
 * `fetch` with a timeout, wrapping a timeout or network failure via `wrap`.
 * Any `signal` in `init` is replaced by the timeout.
 */
export async function vendorFetch(
  url: string,
  init: RequestInit,
  opts: VendorFetchOptions,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(opts.timeoutMs) });
  } catch (err) {
    throw wrapFailure(err, opts);
  }
}

/**
 * The body of a `vendorFetch` response, read under the SAME wrap.
 *
 * ⛔ The timeout signal covers the body as well as the headers, so a vendor
 * that answers headers and then stalls aborts inside `res.text()`, and a bare
 * `await res.text()` let that escape as a raw DOMException, past every
 * caller's `instanceof XxxError` handling. Pass the options the fetch used.
 */
export async function vendorText(res: Response, opts: VendorFetchOptions): Promise<string> {
  try {
    return await res.text();
  } catch (err) {
    throw wrapFailure(err, opts);
  }
}
