// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Deterministic media routing for generated card sets.
 *
 * A cadence/autopilot post carries up to three crops of the SAME branded card
 * (square, 4:5, 2:3). Which crop a platform publishes has exactly one right
 * answer (the one closest to its preferred aspect ratio) and it is never a
 * judgment call. Left to the formatter model, `mediaIndices` with an "omit to
 * attach all" default means that whenever it omits the field a post goes out
 * with three near-identical images on X, Threads and Bluesky. Routing for card
 * sets is therefore code-owned; the model's value is only honoured for
 * operator-supplied media, where a multi-image
 * carousel can be intentional.
 *
 * Lives in the engine (not the host application) so formatPost and publishDraft can both
 * enforce it without a layering violation.
 */
import { SPECS } from "./specs.js";
import type { MediaAsset, Platform } from "./types.js";

/** Filename prefix media-store gives every generated card. */
export const AI_CARD_PATH_PREFIX = "ai-card-";

/**
 * The preferred height/width ratio per platform. Used to match an existing
 * asset to a platform rather than to generate one, so every platform resolves
 * to something: the fallback is 1.0 (square), which no platform rejects.
 */
export const PREFERRED_RATIO: Partial<Record<Platform, number>> = {
  instagram: 1350 / 1080, // 1.25, the 4:5 feed slot
  pinterest: 1620 / 1080, // 1.5, native 2:3
  facebook: 628 / 1200, // 0.523, the landscape link card
};

const SQUARE_RATIO = 1;

/**
 * Whether this media list is a generated card set: more than one asset, every
 * one an image produced by the card engine. One generated card needs no
 * routing, and any operator-supplied asset in the mix means the operator's
 * (or model's) selection could be a real carousel, so it is left alone.
 */
export function isGeneratedCardSet(media: MediaAsset[]): boolean {
  return (
    media.length > 1 &&
    media.every((m) => m.type === "image" && m.path.startsWith(AI_CARD_PATH_PREFIX))
  );
}

/**
 * The indices this platform is even ALLOWED to publish, before shape matters.
 *
 * Aspect ratio is the right tiebreaker between crops of one card; it is the
 * wrong one between media of different KINDS. A draft that carries both a
 * generated video and a generated still (the P5 pipeline produces exactly
 * that: an 8s portrait clip for YouTube alongside the cards every other
 * platform gets) has two assets whose ratios are directly comparable and whose
 * usability is not — a 9:16 card beats a 9:16 video on ratio for YouTube by a
 * delta of zero, and YouTube cannot publish a PNG.
 *
 * So type filters first, and only as a PREFERENCE, keyed on
 * `SPECS[p].publishesVideo` (the one switch for "can our transport send a
 * video here"): a platform that publishes video gets the draft's video when
 * there is one, and every other platform gets a still. A platform with no
 * asset of its preferred kind falls through to the full list rather than
 * selecting nothing, because publishing the wrong thing is a QA failure
 * (qa.ts's `video-required` and `video-unsupported` checks say so) while
 * selecting nothing is a silent text-only post.
 */
function eligibleIndices(platform: Platform, media: MediaAsset[]): number[] {
  const all = media.map((_, i) => i);
  const wantsVideo = SPECS[platform]?.publishesVideo === true;
  const matching = all.filter((i) => (media[i]!.type === "video") === wantsVideo);
  return matching.length > 0 ? matching : all;
}

/**
 * The indices in `indices` that select a video this platform cannot publish.
 * Empty when the platform publishes video or the selection holds none. qa.ts
 * fails on a non-empty answer and publish.ts refuses the leg, so a video never
 * reaches a transport that would drop it.
 */
export function unpublishableVideoIndices(
  platform: Platform,
  media: MediaAsset[],
  indices: number[],
): number[] {
  if (SPECS[platform]?.publishesVideo) return [];
  return indices.filter((i) => media[i]?.type === "video");
}

/**
 * The formatter model's mediaIndices for one platform, made safe to keep.
 *
 * The model is told which platforms cannot publish video, and still writes a
 * video index there, or omits the field (which means "attach everything").
 * Neither is a selection anyone made on purpose, so on a draft carrying a
 * video the routing is code-owned, as it is for card sets:
 *   - omitted: the shape pick, rather than every asset (a video plus cards is
 *     a mixed-media fail on most platforms);
 *   - a video index where the platform cannot publish one: that index is
 *     dropped, and if nothing is left the shape pick runs instead.
 * A hand-written render never passes through here (it is not model output),
 * which is why QA's `video-unsupported` still exists: an operator's explicit
 * choice is refused loudly, never rewritten.
 */
export function routeModelMediaIndices(
  platform: Platform,
  media: MediaAsset[],
  indices: number[] | undefined,
): number[] {
  const hasVideo = media.some((m) => m.type === "video");
  if (indices === undefined) return hasVideo ? pickMediaForPlatform(platform, media) : media.map((_, i) => i);
  const bad = new Set(unpublishableVideoIndices(platform, media, indices));
  if (bad.size === 0) return indices;
  const kept = indices.filter((i) => !bad.has(i));
  return kept.length > 0 ? kept : pickMediaForPlatform(platform, media);
}

/**
 * Which of the draft's assets this platform should publish, as mediaIndices.
 *
 * Picks the asset whose aspect ratio is closest to the platform's preferred
 * one, so a post carrying a square, a 4:5 and a 2:3 card sends the right shape
 * to each channel instead of the same one everywhere. Returns a single index
 * because these are generated brand cards: several near-identical cards on one
 * post read as a carousel of duplicates.
 *
 * Assets with no usable dimensions are treated as square rather than skipped —
 * missing metadata should not make a platform publish text-only.
 */
export function pickMediaForPlatform(platform: Platform, media: MediaAsset[]): number[] {
  if (!media.length) return [];
  const candidates = eligibleIndices(platform, media);
  const preferred = PREFERRED_RATIO[platform] ?? SQUARE_RATIO;
  let bestIndex = candidates[0]!;
  let bestDelta = Infinity;
  for (const i of candidates) {
    const m = media[i]!;
    const ratio = m.width && m.height ? m.height / m.width : SQUARE_RATIO;
    const delta = Math.abs(ratio - preferred);
    // Strict <: ties keep the earliest asset, so the result is stable and the
    // operator's own first attachment wins over a later generated card.
    if (delta < bestDelta) {
      bestDelta = delta;
      bestIndex = i;
    }
  }
  return [bestIndex];
}

/**
 * Shrink any multi-card selection on a card-set draft down to the single
 * best-fitting card. Returns the platforms whose selection changed.
 *
 * Deliberately touches ONLY selections larger than one: an EMPTY selection can
 * be the oversized-image fix dropping the asset from a platform that publishes
 * fine without it, and a single index — even a sub-optimal crop — is not the
 * defect this exists to stop. A no-op (and cheap) for operator media, so every
 * publishing and repair path can call it unconditionally.
 */
export function normalizeCardMediaIndices(
  media: MediaAsset[],
  renders: Array<{ platform: Platform; mediaIndices: number[] }>,
): Platform[] {
  if (!isGeneratedCardSet(media)) return [];
  const changed: Platform[] = [];
  for (const r of renders) {
    if (r.mediaIndices.length <= 1) continue;
    r.mediaIndices = pickMediaForPlatform(r.platform, media);
    changed.push(r.platform);
  }
  return changed;
}
