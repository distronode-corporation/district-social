/**
 * The one media asset fetch every transport uploads from: fetch a render's
 * asset URL, bounded in TIME and in BYTES, with the platform's name in every
 * error so publish failures group per platform.
 *
 * One shared copy instead of one per transport, so every upload (x, bluesky,
 * linkedin, pinterest, and YouTube's video variant) gets the same 20s timeout
 * and the same body cap. `arrayBuffer()` alone buffers whatever the host
 * sends, so a hostile or broken asset URL could stream an unbounded body into
 * process memory. The byte cap rides the shared capped reader
 * (`./read-capped.ts`), so a declared body over the cap is refused before a
 * byte is read and a lying Content-Length is caught while streaming.
 *
 * ⛔ THE ERROR TEXT IS AN ERROR-TRACKER GROUPING KEY, not decoration: `x: failed
 * to fetch media asset (500): <url>` and its per-platform siblings are what a
 * publish failure alert can group on. The platform label is an argument so
 * every transport keeps its exact message byte for byte.
 *
 * Relative imports only, like the rest of this folder: read-capped.ts lives in
 * the engine, and the app may re-export it.
 */

import { readCappedBody } from "./read-capped.js";

/**
 * Fetching an already-compressed image asset should be fast. Twenty seconds is
 * the figure all four image transports carried; any platform that genuinely
 * needs longer (YouTube's video-scale fetch) passes an explicit override.
 */
export const MEDIA_FETCH_TIMEOUT_MS = 20_000;

/**
 * Hard ceiling on one fetched media asset's bytes.
 *
 * Sized for a media store whose upload gate is 100 MB: every asset a render
 * carries went through such a gate or a generator that produces clips far
 * below it, so 512 MB is roughly five times the largest legitimate asset and
 * no real publish can hit it. What it does catch is a replaced or oversized
 * body behind a stored URL, which would otherwise buffer unbounded bytes per
 * concurrent publish.
 */
export const MEDIA_FETCH_MAX_BYTES = 512 * 1024 * 1024;

export interface MediaFetchOptions {
  /** Overrides MEDIA_FETCH_TIMEOUT_MS where a platform needs a longer figure. */
  timeoutMs?: number;
  /** Overrides MEDIA_FETCH_MAX_BYTES; pass only with a proven tighter bound. */
  maxBytes?: number;
}

/**
 * A render asset's bytes, fetched with a timeout and a byte cap.
 *
 * Throws the platform-prefixed fetch error on a non-2xx answer (the exact
 * text the transports always threw, byte for byte) and a platform-prefixed cap
 * error when the response declares or streams more than `maxBytes`.
 */
export async function fetchMediaBytes(
  platform: string,
  url: string,
  opts: MediaFetchOptions = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const res = await fetch(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? MEDIA_FETCH_TIMEOUT_MS) });
  if (!res.ok) {
    throw new Error(`${platform}: failed to fetch media asset (${res.status}): ${url}`);
  }
  const capped = await readCappedBody(res, opts.maxBytes ?? MEDIA_FETCH_MAX_BYTES);
  if (!capped.ok) {
    const maxBytes = opts.maxBytes ?? MEDIA_FETCH_MAX_BYTES;
    throw new Error(`${platform}: media asset exceeds the fetch byte cap (${maxBytes} bytes): ${url}`);
  }
  return capped.bytes;
}
