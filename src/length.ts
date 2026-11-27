// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Post-length counting, one implementation for the engine and the composer.
 *
 * ⚠️ NO RUNTIME IMPORTS. A host's composer (client-side) imports this
 * file directly, so anything it pulls in ships to the browser. The type-only
 * import below is erased at build.
 *
 * Every live transport sends the post body as a plain JSON string (Meta Graph,
 * LinkedIn, X, Bluesky, Pinterest, Reddit, YouTube and Zernio alike). Nothing
 * serializes it as HTML first, so an `&` costs 1 and a non-breaking space costs
 * 1. The old counter escaped both (5 and 6) because Postiz did, and Postiz is
 * deleted.
 */
import type { CountMode } from "./transport.js";

let segmenterInstance: Intl.Segmenter | null = null;
let encoder: InstanceType<typeof TextEncoder> | null = null;

function graphemes(text: string): Intl.Segments {
  segmenterInstance ??= new Intl.Segmenter("en", { granularity: "grapheme" });
  return segmenterInstance.segment(text);
}

/**
 * Extended grapheme clusters, what Bluesky's `maxGraphemes` counts and what
 * the Bluesky facet tag cap counts (`./bluesky-richtext.ts`). A family emoji is 1.
 * Lazy and shared: `Intl.Segmenter` is the expensive object to build.
 */
export function graphemeCount(text: string): number {
  let n = 0;
  for (const _ of graphemes(text)) n++;
  return n;
}

/** Trailing sentence punctuation is not part of a link X wraps. */
const X_LINK_TAIL = String.raw`[^\s.,;:!?'")\]]`;

/**
 * The TLDs a bare domain is recognized by. X's own list (twitter-text) is far
 * longer, and it cannot be imported here (no runtime imports), so this covers
 * the common ones; a name ending in anything else ("Node.js") stays text.
 */
const X_BARE_TLDS =
  "com|net|org|io|co|ai|app|dev|info|biz|me|tv|ly|gg|xyz|ca|us|uk|de|fr|eu|au|nz|jp|es|it|nl|se|no|ch|be|at|ie|br|mx|sg|hk";

/**
 * A URL as X's t.co wrapping sees it, scheme first (group 1), else a bare
 * domain (group 2): not preceded by `@`, a word character, a dot or a slash,
 * so an email, a handle and the inside of another name never match.
 */
const X_URL_RE = new RegExp(
  String.raw`(https?:\/\/\S*${X_LINK_TAIL})|(?<![\w@.\/:-])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:${X_BARE_TLDS})(?![\w-])(?:\/\S*${X_LINK_TAIL})?)`,
  "gi",
);
const X_URL_WEIGHT = 23;

/**
 * twitter-text v3's weight-1 code point ranges (Latin, general punctuation and
 * common symbols). Everything else, CJK included, weighs 2.
 */
const X_LIGHT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x10ff],
  [0x2000, 0x200d],
  [0x2010, 0x201f],
  [0x2032, 0x2037],
];

/**
 * An emoji sequence counts 2 however many code points it carries (skin tones,
 * ZWJ families, flags, keycaps). A bare BMP pictograph such as "©" without a
 * variation selector is text, not emoji, and keeps its per-code-point weight.
 */
const X_EMOJI_RE = /\p{Emoji_Presentation}|\uFE0F|\u20E3|(?=[\u{10000}-\u{10FFFF}])\p{Extended_Pictographic}/u;

function xCodePointWeight(cp: number): number {
  return X_LIGHT_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi) ? 1 : 2;
}

function xTextWeight(text: string): number {
  let n = 0;
  for (const { segment } of graphemes(text)) {
    if (X_EMOJI_RE.test(segment)) {
      n += 2;
      continue;
    }
    for (const ch of segment) n += xCodePointWeight(ch.codePointAt(0)!);
  }
  return n;
}

/**
 * X's weighted length (docs.x.com/fundamentals/counting-characters):
 * NFC-normalized, every URL a flat 23 whatever its real length, a bare domain
 * max(its length, 23) (see X_BARE_TLDS for why not a flat 23),
 * Latin and common punctuation 1, CJK and other scripts 2, every emoji 2.
 *
 * Not `max(weighted, raw)`, which is an aggregator validator's rule and not
 * X's: it charges a UTM-stamped link at full length and trims posts X would
 * accept.
 */
export function xWeightedLength(text: string): number {
  const normalized = text.normalize("NFC");
  let n = 0;
  let last = 0;
  for (const m of normalized.matchAll(X_URL_RE)) {
    const weight = m[1] ? X_URL_WEIGHT : Math.max(m[0].length, X_URL_WEIGHT);
    n += xTextWeight(normalized.slice(last, m.index)) + weight;
    last = m.index + m[0].length;
  }
  return n + xTextWeight(normalized.slice(last));
}

/**
 * The unit a limit in `mode` is counted in, for a prompt or an operator. A
 * bare "300 chars" for Bluesky's 300 graphemes, or X's weighted 280, tells the
 * model to count something the platform does not.
 */
export function countUnit(mode: CountMode): string {
  switch (mode) {
    case "weighted":
      return "weighted chars (X weighting: every link 23, emoji and CJK 2)";
    case "utf8bytes":
      return "UTF-8 bytes (accented letters 2, emoji 4)";
    case "grapheme":
      return "graphemes (each emoji counts 1)";
    case "utf16":
      return "chars";
  }
}

/** The length of `text` in the unit `mode` names, as the vendor counts it. */
export function measureLength(text: string, mode: CountMode): number {
  switch (mode) {
    case "weighted":
      return xWeightedLength(text);
    case "utf8bytes":
      encoder ??= new TextEncoder();
      return encoder.encode(text).length;
    case "grapheme":
      return graphemeCount(text);
    case "utf16":
      return text.length;
  }
}
