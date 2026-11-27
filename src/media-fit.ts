// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Fitting an image to the platform it is actually going to.
 *
 * ⛔ THE PROBLEM THIS REPLACES. Every generated card was re-encoded ONCE, at
 * compose time, to `TIGHTEST_IMAGE_BYTES` — 1 MB, which is Bluesky's limit and
 * the smallest of the nine. That number was then applied to Instagram (30 MB),
 * Facebook (30 MB) and Pinterest (20 MB) as well, so the single tightest
 * platform silently set the image quality for all of them. Worse, an operator
 * who uploaded a real 5 MB photograph could not publish it ANYWHERE: QA failed
 * the Bluesky leg on `image-too-large` and the whole draft stopped, even though
 * eight platforms would have taken the file untouched.
 *
 * The fit belongs at publish time, per transport, because that is the only
 * place the actual destination is known. `channelRules()` already carries each
 * platform's real limits, which is why it is a required method.
 *
 * ⚠️ The re-encoder itself is INJECTED rather than imported. `sharp` is a
 * native binary and this folder must stay liftable (relative imports only),
 * so the app wires an implementation in the same way
 * it wires the Postiz key and every credential resolver. With no fitter
 * registered — the CLI, most tests — assets pass through UNCHANGED, which keeps
 * the old behaviour rather than inventing a new failure.
 */

import type { MediaAsset } from "./types.js";
import type { TransportChannelRules } from "./transport.js";
import { getErrorMessage } from "./error-message.js";

/** What the app-side re-encoder is asked for. Nothing here mentions sharp. */
export interface MediaFitRequest {
  asset: MediaAsset;
  /** Hard ceiling for this platform, when it declares one. */
  maxBytes?: number;
  /**
   * Mime types this platform will accept. Empty/absent means no constraint.
   *
   * Instagram is the reason this exists: its Content Publishing API takes JPEG
   * and nothing else, while this repo's card pipeline can hand it a PNG.
   */
  formats?: readonly string[];
}

/**
 * Returns a NEW asset when it re-encoded, or the SAME asset when nothing needed
 * doing. Must never throw for a merely-awkward image; a fitter that cannot
 * improve an asset returns it unchanged and lets the vendor have the last word.
 */
export type MediaFitter = (req: MediaFitRequest) => Promise<MediaAsset>;

let _fitter: MediaFitter | null = null;

export function setMediaFitter(fitter: MediaFitter | null): void {
  _fitter = fitter;
}

/** Whether a real re-encoder is wired. QA asks this before relaxing its gate. */
export function hasMediaFitter(): boolean {
  return _fitter !== null;
}

function needsWork(asset: MediaAsset, rules: TransportChannelRules): boolean {
  if (asset.type === "video") return false; // Video re-encoding is out of scope.
  if (rules.maxImageBytes && asset.size > rules.maxImageBytes) return true;
  if (rules.imageFormats?.length && !rules.imageFormats.includes(asset.mimeType)) return true;
  return false;
}

/**
 * Fit every image in a leg's media to one platform's rules.
 *
 * Best-effort by design: a fitter that throws leaves the ORIGINAL asset in
 * place and lets the publish proceed to the vendor, which will give a real
 * error naming a real problem. Failing the publish here instead would turn a
 * recoverable "this image is a bit big" into a dead leg, and the whole point of
 * moving the fit to publish time was to stop one platform's limit deciding
 * another platform's outcome.
 */
export async function fitForTransport(
  assets: MediaAsset[],
  rules: TransportChannelRules,
): Promise<MediaAsset[]> {
  const fitter = _fitter;
  if (!fitter || !assets.length) return assets;

  return Promise.all(
    assets.map(async (asset) => {
      if (!needsWork(asset, rules)) return asset;
      try {
        return await fitter({
          asset,
          ...(rules.maxImageBytes ? { maxBytes: rules.maxImageBytes } : {}),
          ...(rules.imageFormats?.length ? { formats: rules.imageFormats } : {}),
        });
      } catch (err) {
        console.warn(
          `[media-fit] could not fit ${asset.path} for this platform, sending it as-is: ` +
            `${getErrorMessage(err)}`,
        );
        return asset;
      }
    }),
  );
}
