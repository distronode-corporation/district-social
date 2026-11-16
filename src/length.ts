/**
 * Post-length counting, one implementation for the engine and the composer.
 *
 * ⚠️ NO RUNTIME IMPORTS. The Social HQ composer (client-side) imports this
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
let encoder: TextEncoder | null = null;

function graphemes(text: string): Intl.Segments {
  segmenterInstance ??= new Intl.Segmenter("en", { granularity: "grapheme" });
  return segmenterInstance.segment(text);
}

/**
 * Extended grapheme clusters, what Bluesky's `maxGraphemes` counts and what
 * `RichText.graphemeLength` in @atproto/api computes. A family emoji is 1.
 * Lazy and shared: `Intl.Segmenter` is the expensive object to build.
 */
export function graphemeCount(text: string): number {
  let n = 0;
  for (const _ of graphemes(text)) n++;
  return n;
}

/**
 * A URL as X's t.co wrapping sees it: trailing sentence punctuation is not part
 * of the link, so it is charged as ordinary text after the flat 23.
 */
const X_URL_RE = /https?:\/\/\S*[^\s.,;:!?'")\]]/g;
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
 * NFC-normalized, every URL a flat 23 whatever its real length,
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
    n += xTextWeight(normalized.slice(last, m.index)) + X_URL_WEIGHT;
    last = m.index + m[0].length;
  }
  return n + xTextWeight(normalized.slice(last));
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
