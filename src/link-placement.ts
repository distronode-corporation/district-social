// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Deterministic text surgery: hashtag trimming, whitespace tidying, and moving a
 * link out of a post body into a reply or a first comment.
 *
 * Split out of revise.ts so BOTH the issue-driven mechanical fixer and the
 * always-on platform playbooks can share one implementation. Two copies of "move
 * the link into a reply" would drift, and the drift would be invisible: the
 * playbook would place a link one way at format time and the fix pass would place
 * it another way afterwards.
 *
 * Deliberately imports nothing but specs and types. playbook.ts needs these
 * helpers and format.ts needs playbook.ts, while qa.ts already imports format.ts
 * and revise.ts imports qa.ts — putting them anywhere in that chain closes a real
 * ESM cycle (format -> playbook -> revise -> qa -> format).
 */
import { threadReplies, type PlatformRender } from "./types.js";
import { trimTrailing } from "./trim.js";

/**
 * A URL in copy. A parenthesis is part of it only as a balanced pair
 * ("wiki/Foo_(bar)"), so a URL wrapped in prose parentheses stops before the
 * closing one; the old `[^...)]+` cut a Wikipedia-style link at its first `)`.
 */
export const URL_RE = /https?:\/\/(?:[^\s<>"'()]|\([^\s<>"'()]*\))+/g;
const HASHTAG_RE = /(^|\s)(#[\p{L}\p{N}_]+)/gu;

/** Collapse the whitespace/punctuation debris left by a removal. */
export function tidy(text: string): string {
  return text
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .trim();
}

/** Count hashtags the same way the QA check does. */
export function countHashtags(text: string): number {
  return text.match(/(^|\s)#[\p{L}\p{N}_]+/gu)?.length ?? 0;
}

/**
 * Drop hashtags from the END of a text until at most `keep` remain, reporting
 * how many were removed. Trailing tags go first because that is where the
 * low-value filler sits, and on end-placement platforms the whole block is
 * trailing anyway.
 */
export function trimHashtags(text: string, keep: number): { text: string; removed: number } {
  const matches = [...text.matchAll(HASHTAG_RE)];
  if (matches.length <= keep) return { text, removed: 0 };
  const doomed = matches.slice(keep);
  let out = text;
  // Reverse order so earlier match indices stay valid as we splice.
  for (const m of [...doomed].reverse()) {
    // Group 1 is `(^|\s)`, which always participates (possibly empty), so m[1] is always a string.
    const start = m.index! + m[1]!.length;
    out = out.slice(0, start) + out.slice(start + m[2]!.length);
  }
  return { text: tidy(out), removed: doomed.length };
}

export function hasUrl(text: string | undefined): boolean {
  return !!text && new RegExp(URL_RE.source).test(text);
}

/**
 * CTA lead-ins for a reply whose only content would otherwise be the URL.
 *
 * X refuses a bare-link reply outright: a reply containing nothing but a URL
 * fails with "Unknown Error", while replies with lead-in text post fine on the
 * same account.
 * A few words of copy is also simply a better reply than a naked link.
 */
const LINK_REPLY_CTAS = [
  "See it in action:",
  "Try it yourself:",
  "Details here:",
  "Learn more:",
  "Start here:",
  "See it live:",
];

/** True when the text is nothing but URLs and separator punctuation. */
export function isLinkOnly(text: string): boolean {
  return !text.replace(new RegExp(URL_RE.source, "g"), " ").replace(/[\s:\-–.,!]+/g, "");
}

/**
 * Deterministic CTA pick, seeded by the post body so one post always gets the
 * same phrase (re-running a fix round must not reshuffle copy) while
 * consecutive posts vary instead of stamping one identical reply account-wide.
 */
function ctaFor(seed: string): string {
  let h = 2166136261 >>> 0;
  for (const ch of seed) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619) >>> 0;
  return LINK_REPLY_CTAS[h % LINK_REPLY_CTAS.length]!;
}

/**
 * `s` without a trailing ":", "-" or "–" and the whitespace either side of it,
 * or `s` unchanged when it does not end in one: the output of
 * `s.replace(/\s*[:\-–]\s*$/, "")` in one pass from the end. The regex is
 * quadratic on a long whitespace run that is not at the end, because it retries
 * the run from each of its positions; `trimEnd` drops the same characters `\s`
 * matches.
 */
function dropTrailingDelimiter(s: string): string {
  const trimmed = s.trimEnd();
  return /[:\-–]$/.test(trimmed) ? trimmed.slice(0, -1).trimEnd() : s;
}

/**
 * Split EVERY link out of a body: returns the body without them plus the text
 * that should carry them elsewhere (a thread item or first comment), one line
 * per link line moved.
 *
 * A line holding a URL is moved WHOLE when it is short, so a lead-in like
 * "See it answer live: https://example.com" survives intact instead of
 * leaving a dangling colon behind. A long line keeps its prose and gives up
 * only its URLs. When moving whole lines would leave nothing to post, every
 * line keeps its prose instead.
 *
 * ⛔ Every link line, not only the last. Moving one left the others in the
 * body; the next pass then found the destination already carrying a URL,
 * stripped the rest from the body and appended nothing, so they vanished.
 */
export function extractLink(content: string): { body: string; linkText: string } | null {
  const lines = content.split("\n");
  if (!lines.some(hasUrl)) return null;

  const split = (wholeLines: boolean) => {
    const kept: string[] = [];
    const moved: string[] = [];
    for (const line of lines) {
      if (!hasUrl(line)) {
        kept.push(line);
      } else if (wholeLines && [...line].length <= 120) {
        moved.push(line.trim());
      } else {
        kept.push(dropTrailingDelimiter(line.replace(URL_RE, "")));
        // Non-null: hasUrl tested URL_RE's own source on this line.
        moved.push(line.match(URL_RE)!.join(" "));
      }
    }
    return { body: tidy(kept.join("\n")), linkText: moved.join("\n") };
  };

  const whole = split(true);
  return whole.body ? whole : split(false);
}

/**
 * The URLs in `text`, each with the sentence punctuation URL_RE lets it swallow
 * trimmed off, so "https://example.com." and "https://example.com" are
 * the same link.
 */
function urlSet(text: string): Set<string> {
  return new Set((text.match(URL_RE) ?? []).map((u) => trimTrailing(u, ".,;:!?")));
}

/**
 * The moved link lines whose URLs `dest` does not already carry, so a mover
 * appends exactly what is missing: re-running it adds nothing, and a
 * destination holding some OTHER link no longer swallows this one.
 *
 * ⛔ COMPARED AS URLS, NOT AS SUBSTRINGS. `dest.includes(u)` read the homepage
 * as already present in a comment carrying `/pricing`, because one is a prefix
 * of the other, and the homepage link was dropped from the post entirely.
 */
function missingFrom(dest: string, linkText: string): string {
  const present = urlSet(dest);
  return linkText
    .split("\n")
    .filter((entry) => ![...urlSet(entry)].every((u) => present.has(u)))
    .join("\n");
}

/**
 * Move the body's links into a trailing thread item, leaving the root post
 * link-free. Returns a log line, or null when there was nothing to move.
 *
 * This is the mechanism behind "post the link as a comment after the post goes
 * out": the transport publishes `content` and chains each thread item as a
 * reply, so a thread item IS a reply to the published post. Idempotent: a body
 * with no URL is left alone, and a link the chain already carries is not added
 * again.
 */
export function moveLinkToThread(r: PlatformRender): string | null {
  const split = extractLink(r.content);
  if (!split || !split.body.trim()) return null;
  const replies = threadReplies(r);
  const missing = missingFrom(replies.join("\n"), split.linkText);
  if (missing) {
    // Never push a naked URL as the reply: X rejects link-only replies (the
    // whole 07-27→07-30 "Unknown Error" comment-failure class), and a CTA
    // reads better everywhere the thread mechanism is used.
    replies.push(isLinkOnly(missing) ? `${ctaFor(split.body)} ${missing}` : missing);
  }
  // Never empty: with no replies to start from, nothing carries the link, so
  // `missing` is non-empty and was pushed above.
  r.threadItems = replies;
  r.content = split.body;
  return "moved the link out of the post into a reply, keeping the body link-free";
}

/**
 * Move the body's links into the first comment. Returns a log line, or null
 * when there was nothing to move.
 */
export function moveLinkToFirstComment(r: PlatformRender): string | null {
  const split = extractLink(r.content);
  if (!split || !split.body.trim()) return null;
  const missing = missingFrom(r.firstComment ?? "", split.linkText);
  if (missing) r.firstComment = r.firstComment ? tidy(`${r.firstComment}\n${missing}`) : missing;
  r.content = split.body;
  return "moved the link out of the body into the first comment";
}

/**
 * Drop an unclickable URL out of the body, optionally leaving a pointer in its
 * place. Returns a log line, or null when there was nothing to drop.
 *
 * `replacement` is explicit rather than derived from the spec because the two
 * platforms with unclickable body links want opposite things: Instagram needs
 * "Link in bio." because the bio is the only route to a click, while Pinterest's
 * destination is a publish setting (`settings.link`), so any replacement text
 * would be pure noise. Idempotent: a body already carrying the pointer does not
 * get a second one.
 */
export function dropBodyLink(r: PlatformRender, replacement?: string): string | null {
  const split = extractLink(r.content);
  // ⛔ `!split.body.trim()` matches both sibling movers above. Without it a body
  // that is nothing BUT a URL gets emptied: Instagram would publish
  // `"Link in bio."` with the link itself gone, or `""` when there is no
  // `source.link`, and Pinterest an empty description. `playbook.test.ts` pins
  // this refusal for X, Facebook and Bluesky (through moveLinkToThread and
  // moveLinkToFirstComment) and for Instagram and Pinterest, which route
  // through here.
  // Returning null means the caller's `if (log)` leaves the copy untouched,
  // which is the same "leave it alone" outcome the other three already get.
  if (!split || !split.body.trim()) return null;
  const needsPointer =
    !!replacement && !split.body.toLowerCase().includes(replacement.toLowerCase().slice(0, 12));
  r.content = tidy(needsPointer ? `${split.body}\n\n${replacement}` : split.body);
  return replacement
    ? `dropped the unclickable URL in favour of "${replacement}"`
    : "dropped the URL from the copy (the destination is a publish setting, not body text)";
}
