/**
 * Bluesky facet detection: links, mentions, hashtags and cashtags, with the
 * UTF-8 byte offsets the `app.bsky.richtext.facet` lexicon indexes by.
 *
 * Bluesky does not autolink. A post renders exactly the facets its client
 * attaches, so a URL without one is dead text.
 *
 * ⛔ A PORT, NOT A REDESIGN. The patterns, the trailing-punctuation rules, the
 * 64-grapheme tag cap and the TLD check are `@atproto/api`'s own
 * (`src/rich-text/detection.ts` and `util.ts`, Bluesky Social PBC and
 * contributors, MIT licence; see NOTICE), so a post links what the Bluesky app
 * would link. The tests compare this output with fixtures captured from that
 * library's `RichText.detectFacets` before it was removed.
 *
 * Three differences, on purpose (the tests list the fixture cases each one
 * changes):
 *
 *   - a mention whose handle does not resolve is dropped. `@atproto/api` kept
 *     it with an empty `did`, a facet the lexicon does not allow; dropped, the
 *     `@handle` stays plain text;
 *   - a bare domain always gets `https://`. The library added it only when the
 *     text did not start with "http", so `httpbin.org` linked to a relative
 *     target;
 *   - a link with a scheme matches in any case (`HTTPS://`), with its scheme
 *     and host lower-cased and the rest kept as written. The library's pattern
 *     matched it but its `startsWith("http")` test did not, so it was skipped.
 *
 * Relative imports only, like the rest of this folder.
 */

import { createRequire } from "node:module";
import { graphemeCount } from "./length.js";
import type { Facet } from "./bluesky-xrpc.js";

/** The IANA TLD list `@atproto/api` checks bare domains and handles against. */
const TLDS = createRequire(import.meta.url)("tlds") as string[];

const MENTION_REGEX = /(^|\s|\()(@)([a-zA-Z0-9.-]+)(\b)/g;
const URL_REGEX = /(^|\s|\()((https?:\/\/[\S]+)|((?<domain>[a-z][a-z0-9]*(\.[a-z0-9]+)+)[\S]*))/gim;
const TRAILING_PUNCTUATION_REGEX = /\p{P}+$/gu;
/**
 * `\ufe0f` emoji modifier
 * `\u00AD\u2060\u200A\u200B\u200C\u200D\u20e2` zero-width spaces (likely incomplete)
 */
const TAG_REGEX =
  // eslint-disable-next-line no-misleading-character-class
  /(^|\s)[#＃]((?!\ufe0f)[^\s\u00AD\u2060\u200A\u200B\u200C\u200D\u20e2]*[^\d\s\p{P}\u00AD\u2060\u200A\u200B\u200C\u200D\u20e2]+[^\s\u00AD\u2060\u200A\u200B\u200C\u200D\u20e2]*)?/gu;
const CASHTAG_REGEX = /(^|\s|\()\$([A-Za-z][A-Za-z0-9]{0,4})(?=\s|$|[.,;:!?)"'\u2019])/gu;

const encoder = new TextEncoder();

/** The UTF-8 byte offset of UTF-16 index `i` in `text`. */
function utf8Index(text: string, i: number): number {
  return encoder.encode(text.slice(0, i)).byteLength;
}

/**
 * `HTTPS://Me@EXAMPLE.COM/Path` as `https://Me@example.com/Path`: the scheme
 * and host are case-insensitive, so they are lower-cased; the user part and
 * everything after the authority keep their case.
 */
function lowerSchemeAndHost(uri: string): string {
  return uri.replace(/^(https?):\/\/([^/?#]*)/i, (_all, scheme: string, authority: string) => {
    const at = authority.lastIndexOf("@") + 1;
    return `${scheme.toLowerCase()}://${authority.slice(0, at)}${authority.slice(at).toLowerCase()}`;
  });
}

function isValidDomain(str: string): boolean {
  return TLDS.some((tld) => {
    const i = str.lastIndexOf(tld);
    return i !== -1 && str.charAt(i - 1) === "." && i === str.length - tld.length;
  });
}

/**
 * Every facet in `text`, sorted by start, or undefined when there are none.
 * A mention's `did` holds the HANDLE until `resolveMentions` replaces it.
 */
export function detectFacets(text: string): Facet[] | undefined {
  let match: RegExpExecArray | null;
  const facets: Facet[] = [];

  // mentions
  while ((match = MENTION_REGEX.exec(text))) {
    const handle = match[3]!;
    if (!isValidDomain(handle) && !handle.endsWith(".test")) continue; // probably not a handle
    const start = text.indexOf(handle, match.index) - 1;
    facets.push({
      $type: "app.bsky.richtext.facet",
      index: { byteStart: utf8Index(text, start), byteEnd: utf8Index(text, start + handle.length + 1) },
      features: [{ $type: "app.bsky.richtext.facet#mention", did: handle }],
    });
  }

  // links
  while ((match = URL_REGEX.exec(text))) {
    // The pattern's first branch is a link with a scheme (group 3, any case);
    // the second, a bare domain, which always captures `domain`.
    const withScheme = match[3] !== undefined;
    let uri = match[2]!;
    if (!withScheme) {
      if (!isValidDomain(match.groups!.domain!)) continue;
      uri = `https://${uri}`;
    }
    const start = text.indexOf(match[2]!, match.index);
    const index = { start, end: start + match[2]!.length };
    // strip ending punctuation
    if (/[.,;:!?]$/.test(uri)) {
      uri = uri.slice(0, -1);
      index.end--;
    }
    if (/[)]$/.test(uri) && !uri.includes("(")) {
      uri = uri.slice(0, -1);
      index.end--;
    }
    if (withScheme) uri = lowerSchemeAndHost(uri);
    facets.push({
      index: { byteStart: utf8Index(text, index.start), byteEnd: utf8Index(text, index.end) },
      features: [{ $type: "app.bsky.richtext.facet#link", uri }],
    });
  }

  // hashtags
  while ((match = TAG_REGEX.exec(text))) {
    const leading = match[1]!;
    let tag = match[2];
    if (!tag) continue;
    // strip ending punctuation and any spaces
    tag = tag.trim().replace(TRAILING_PUNCTUATION_REGEX, "");
    // tag.length (UTF-16) is always >= its grapheme count, so only count
    // graphemes when the UTF-16 length already exceeds the limit. (The
    // library's `tag.length === 0` arm is dropped: the pattern requires one
    // character that is neither punctuation nor a digit, which the trim keeps.)
    if (tag.length > 64 && graphemeCount(tag) > 64) continue;
    const index = match.index + leading.length;
    facets.push({
      index: { byteStart: utf8Index(text, index), byteEnd: utf8Index(text, index + 1 + tag.length) },
      features: [{ $type: "app.bsky.richtext.facet#tag", tag }],
    });
  }

  // cashtags
  while ((match = CASHTAG_REGEX.exec(text))) {
    const leading = match[1]!;
    const ticker = match[2]!.toUpperCase();
    const index = match.index + leading.length;
    facets.push({
      index: { byteStart: utf8Index(text, index), byteEnd: utf8Index(text, index + 1 + ticker.length) },
      features: [{ $type: "app.bsky.richtext.facet#tag", tag: "$" + ticker }],
    });
  }

  return facets.length > 0 ? facets.sort((a, b) => a.index.byteStart - b.index.byteStart) : undefined;
}

function mentionOf(facet: Facet): { did: string } | undefined {
  const feature = facet.features[0] as { $type?: string; did?: string };
  return feature.$type === "app.bsky.richtext.facet#mention" ? (feature as { did: string }) : undefined;
}

/**
 * Replace each mention's handle with the DID `resolve` returns, and drop the
 * mentions that do not resolve (`resolve` throwing, or answering nothing).
 * Resolutions run concurrently; the order of the facets is kept.
 */
export async function resolveMentions(
  facets: Facet[] | undefined,
  resolve: (handle: string) => Promise<string>,
): Promise<Facet[] | undefined> {
  if (!facets) return undefined;
  const resolved = await Promise.all(
    facets.map(async (facet) => {
      const mention = mentionOf(facet);
      if (!mention) return facet;
      let did: string;
      try {
        did = await resolve(mention.did);
      } catch {
        // Thrown synchronously or rejected: either way, unresolved.
        return null;
      }
      if (!did) return null;
      mention.did = did;
      return facet;
    }),
  );
  const kept = resolved.filter((f): f is Facet => f !== null);
  return kept.length > 0 ? kept : undefined;
}
