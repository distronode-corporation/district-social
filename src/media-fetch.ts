/**
 * The one media asset fetch every transport uploads from: fetch a render's
 * asset URL, bounded in TIME and in BYTES, with the platform's name in every
 * error so publish failures group per platform.
 *
 * One shared copy instead of one per transport, so every upload (x, bluesky,
 * linkedin, pinterest, reddit's image upload, and YouTube's video variant) gets the same 20s timeout
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
 * ⛔ THE DESTINATION IS CHECKED AND PINNED (`./ssrf.ts`): HTTPS only, every
 * resolved address public, the connection made to the address that was
 * checked, and no redirects followed. An asset URL, or the host behind it, can
 * otherwise point the fetch at the publishing process's own network.
 *
 * Relative imports only, like the rest of this folder: read-capped.ts lives in
 * the engine, and the app may re-export it.
 */

import type { Agent as UndiciAgent } from "undici";
import { readCappedBody } from "./read-capped.js";
import { preparePinnedHttpsFetch } from "./ssrf.js";
import { getErrorMessage } from "./error-message.js";
import { PublishPreflightError } from "./publish.js";
import type { MediaAsset } from "./types.js";

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
 * text the transports always threw, byte for byte), on a destination the SSRF
 * guard refuses and on a redirect, and a platform-prefixed cap error when the
 * response declares or streams more than `maxBytes`.
 */
export async function fetchMediaBytes(
  platform: string,
  url: string,
  opts: MediaFetchOptions = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const timeoutMs = opts.timeoutMs ?? MEDIA_FETCH_TIMEOUT_MS;
  /**
   * ⛔ A FAILED MEDIA FETCH IS NOT AN UNKNOWN OUTCOME. It runs before the
   * vendor create, so nothing was posted, but the raw TimeoutError or fetch
   * TypeError reads as one to retry.ts (`isUnknownOutcome`), and publish.ts
   * then marks the leg `failed` with "the post may already be live". Wrapped
   * as a plain platform-prefixed Error, the leg stays `pending` instead.
   */
  const failed = (err: unknown): Error => {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    const why = timedOut ? `timed out after ${timeoutMs / 1000}s` : getErrorMessage(err);
    return new Error(`${platform}: failed to fetch media asset (${why}): ${url}`);
  };
  // ⛔ One deadline for the whole call: the destination lookup, the fetch and the
  // body read. A lookup that outlives it fails the call as a timeout, and the
  // dispatcher it builds afterwards is destroyed, since nobody else holds it.
  const signal = AbortSignal.timeout(timeoutMs);
  const preparing = preparePinnedHttpsFetch(url);
  const deadline = new Promise<"timeout">((resolve) => {
    signal.addEventListener("abort", () => resolve("timeout"), { once: true });
  });
  const prepared = await Promise.race([preparing, deadline]).catch((err: unknown) => {
    throw failed(err);
  });
  if (prepared === "timeout") {
    preparing
      .then((late) => late.dispatcher?.destroy(), () => {})
      .catch(() => {});
    throw failed(signal.reason);
  }
  const { dispatcher, redirect } = prepared;
  let settled = false;
  try {
    let res: Response;
    try {
      res = await fetch(url, {
        signal,
        // Both present in production; both undefined under NODE_ENV==="test",
        // where preparePinnedHttpsFetch skips DNS.
        ...(redirect ? { redirect } : {}),
        ...(dispatcher ? { dispatcher } : {}),
      } as RequestInit & { dispatcher?: UndiciAgent });
    } catch (err) {
      throw failed(err);
    }
    if (!res.ok) {
      throw new Error(`${platform}: failed to fetch media asset (${res.status}): ${url}`);
    }
    const capped = await readCappedBody(res, opts.maxBytes ?? MEDIA_FETCH_MAX_BYTES).catch((err: unknown) => {
      throw failed(err);
    });
    if (!capped.ok) {
      const maxBytes = opts.maxBytes ?? MEDIA_FETCH_MAX_BYTES;
      throw new Error(`${platform}: media asset exceeds the fetch byte cap (${maxBytes} bytes): ${url}`);
    }
    settled = true;
    return capped.bytes;
  } finally {
    // The pinned agent holds its own connection pool, one per fetch. Closed gracefully
    // after a body read to the end; destroyed after a failure, because a graceful close
    // would wait for a refused body the host is still streaming.
    await (settled ? dispatcher?.close() : dispatcher?.destroy());
  }
}

/**
 * A selected asset's public URL, or a refusal naming it.
 *
 * ⛔ A selected asset with no URL used to be skipped (`continue`), which
 * published the post without it, or text-only, with a real id, so nothing
 * downstream noticed. publish.ts uploads every selected asset first, so a
 * missing URL here is a broken asset, and the leg is refused before any send.
 */
export function requireMediaUrl(platform: string, asset: MediaAsset): string {
  if (!asset.url) {
    throw new PublishPreflightError(
      `${platform}: media asset ${asset.path} has no public url, so it cannot be published. ` +
        "Re-upload it, or drop it from this render, so the other platforms in this publish can still go out.",
    );
  }
  return asset.url;
}
