/**
 * Per-platform optimization playbooks: the techniques that should happen EVERY
 * time, applied deterministically instead of asked for in a prompt.
 *
 * The formatter already carries every platform's rules in its prompt, and a model
 * follows them most of the time. "Most of the time" is the problem. The X link
 * rule is worth up to ~94% of a post's reach, and the prompt's own wording leaves
 * threads to the model's judgement ("only if the content genuinely needs a
 * thread"), so the single highest-value mechanic on the highest-penalty platform
 * was a coin flip. Anything that can be decided from the platform and the copy is
 * decided here, in code, once.
 *
 * Two hard rules for anything added to this file:
 *
 *  1. IDEMPOTENT. These run inside formatPost, which the reformat and fix paths
 *     re-enter, so applying a playbook twice must be a no-op. Every transform
 *     below is written as "if the body still has a URL, move it" rather than
 *     "move the URL", which is self-limiting.
 *  2. NEVER INVENTS A CLAIM. Rearranging, trimming and dropping are fair game;
 *     writing new marketing sentences is not. The one place a sentence is added
 *     ("Link in bio.") is a mechanical pointer, not a claim. Reddit's affiliation
 *     disclosure is deliberately a QA finding rather than a transform for exactly
 *     this reason: a machine must not fabricate a personal disclosure.
 */
import {
  countHashtags,
  dropBodyLink,
  hasUrl,
  moveLinkToFirstComment,
  moveLinkToThread,
  trimHashtags,
} from "./link-placement.js";
import { SPECS, vendorLength } from "./specs.js";
import type { Platform, PlatformRender, SourcePost } from "./types.js";

/**
 * Tunable timings for the follow-up value (a reply or first comment).
 *
 * ALL ZERO on purpose. Zero means "chain immediately", which is the only
 * behaviour verified against the vendor, and it already satisfies "the link goes
 * out as a comment after the post". A nonzero delay is unobservable on failure:
 * Postiz reports one state per post, so a root that publishes while its delayed
 * reply silently never lands looks identical to complete success. Do not raise
 * these until publish-delay.live.proof has been run and the result recorded in
 * scripts/social/platform-reference.md.
 */
export const PLAYBOOK_TUNING: Partial<Record<Platform, { followupDelayMinutes: number }>> = {
  twitter: { followupDelayMinutes: 0 },
  facebook: { followupDelayMinutes: 0 },
  linkedin: { followupDelayMinutes: 0 },
};

/**
 * LinkedIn's link policy, isolated because the honest answer changed once and may
 * change again.
 *
 * The research settles the question: a body link costs ~60% reach
 * AND the first-comment workaround is penalized JUST AS HEAVILY, because the
 * algorithm now reads the comments immediately and treats an author's link comment
 * as bridge behaviour. So "first-comment" is strictly DOMINATED: it pays the same
 * penalty, adds a detection signal, and buries the link where fewer people look.
 *
 * That leaves two real options, and neither is free:
 *   "body" - keep the link where readers see it and accept the ~60%.
 *   "none" - strip it, keep full reach, give up the click path and the attribution.
 *
 * "body" is the default because this is a marketing surface: a post nobody can act
 * on is not cheaper than a throttled one, it is just quieter. QA still reports the
 * penalty, so the cost is visible rather than hidden.
 *
 * Held on an object rather than a bare const so all three branches stay live code:
 * a `const x: Union = "body"` narrows to `"body"`, and the compiler then reports the
 * other two as unreachable, which would quietly turn a documented choice into dead
 * code the next person deletes.
 */
export type LinkPolicy = "body" | "first-comment" | "none";

// Exported so tests can exercise the two alternative policies; nothing else writes it.
export const LINK_POLICIES: { linkedin: LinkPolicy } = { linkedin: "body" };

export const LINKEDIN_LINK_POLICY: LinkPolicy = LINK_POLICIES.linkedin;

export interface PlaybookResult {
  /** Platforms whose render was actually modified. */
  changed: Platform[];
  /** Human-readable log lines, one per applied transform. */
  applied: string[];
}

/**
 * `cap` is the effective character limit for this platform, resolved by the
 * caller. Passed in rather than read from channel-rules here so this module keeps
 * a dependency-light graph (link-placement + specs + types only), which is what
 * lets format.ts import it without closing a cycle back through qa.
 */
type PlaybookFn = (r: PlatformRender, source: SourcePost, cap: number) => string[];

/** Apply the tuned follow-up delay, if this platform has one configured. */
function applyTuning(r: PlatformRender): void {
  const tuning = PLAYBOOK_TUNING[r.platform];
  if (tuning && tuning.followupDelayMinutes > 0) {
    r.followupDelayMinutes = tuning.followupDelayMinutes;
  }
}

/** Trim hashtags on the body (and title, where the platform has one). */
function capHashtags(r: PlatformRender, keep: number, why: string): string[] {
  const applied: string[] = [];
  if (countHashtags(r.content) > keep) {
    const t = trimHashtags(r.content, keep);
    r.content = t.text;
    // countHashtags and trimHashtags share one pattern, so count > keep means
    // removed >= 1 here (there was no zero-removed case to skip).
    applied.push(`cut ${t.removed} hashtag${t.removed === 1 ? "" : "s"} (${why})`);
  }
  if (r.title && countHashtags(r.title) > keep) {
    r.title = trimHashtags(r.title, keep).text;
    applied.push(`removed hashtags from the title (${why})`);
  }
  return applied;
}

const PLAYBOOKS: Partial<Record<Platform, PlaybookFn>> = {
  /**
   * X: the root post carries NO link. Body links are suppressed up to ~94%, and
   * the link becomes value[1], which is published as a reply to the post once it
   * is out.
   */
  twitter: (r) => {
    const applied: string[] = [];
    if (hasUrl(r.content)) {
      const log = moveLinkToThread(r);
      if (log) applied.push(log);
    }
    applyTuning(r);
    return applied;
  },

  /**
   * Facebook: non-verified Pages get roughly two body-link posts a MONTH before
   * reach collapses, while links in comments are unlimited. So the body stays
   * clean and the link goes to the first comment every time.
   */
  facebook: (r) => {
    const applied: string[] = [];
    if (hasUrl(r.content)) {
      const log = moveLinkToFirstComment(r);
      if (log) applied.push(log);
    }
    applyTuning(r);
    return applied;
  },

  /**
   * LinkedIn: see LINKEDIN_LINK_POLICY. On the default ("body") this does nothing
   * to the link, which is the point: every relocation available here is either
   * equally penalized or throws the click path away, so the honest move is to
   * leave it where readers see it and let QA report the cost.
   */
  linkedin: (r) => {
    const applied: string[] = [];
    if (!hasUrl(r.content)) return applied;
    const policy = LINK_POLICIES.linkedin;
    if (policy === "first-comment") {
      const log = moveLinkToFirstComment(r);
      if (log) applied.push(`${log} (penalized as heavily as a body link; not a workaround)`);
    } else if (policy === "none") {
      const log = dropBodyLink(r);
      if (log) applied.push(`${log} (keeps full reach, gives up the click path)`);
    }
    applyTuning(r);
    return applied;
  },

  /**
   * Instagram: captions are search-indexed and the hashtag cap is 5 total, so
   * tags stay in the caption and get trimmed hard. A body URL is inert, so it is
   * replaced with the bio pointer.
   */
  instagram: (r, source) => {
    const applied: string[] = [];
    if (hasUrl(r.content)) {
      const log = dropBodyLink(r, source.link ? "Link in bio." : undefined);
      if (log) applied.push(log);
    }
    applied.push(...capHashtags(r, SPECS.instagram.maxHashtags ?? 5, "Instagram's cap is 5"));
    return applied;
  },

  /**
   * Pinterest: a search surface, not a feed. The TITLE is what the feed shows, so
   * it must exist; the description's URL is dead text because the click-through is
   * a publish setting; hashtags are deprecated entirely.
   */
  pinterest: (r, source) => {
    const applied: string[] = [];
    const cap = SPECS.pinterest.titleMaxChars ?? 100;
    if (!r.title?.trim()) {
      // Derived from copy that already exists, never invented: the post's own
      // title, else its opening sentence.
      const candidate = source.title?.trim() || r.content.split(/(?<=[.!?])\s+|\n/)[0]?.trim() || "";
      if (candidate) {
        r.title = [...candidate].slice(0, cap).join("").trim();
        applied.push("added the pin title the feed actually displays");
      }
    }
    if (hasUrl(r.content)) {
      const log = dropBodyLink(r);
      if (log) applied.push(log);
    }
    applied.push(...capHashtags(r, 0, "Pinterest deprecated hashtags"));
    return applied;
  },

  /** Threads surfaces a single topic tag, so extra tags are dead weight. */
  threads: (r) => capHashtags(r, SPECS.threads.maxHashtags ?? 1, "Threads surfaces one tag"),

  /**
   * Bluesky: links are clickable, unfurl, and carry no known penalty, so a link
   * in the body is CORRECT here and is left alone. The exception is length.
   *
   * Bluesky counts a full URL against its 300 characters with no protocol-level
   * shortening, so a post that is over budget and carries a URL is about to be
   * hard-trimmed, and a trim that lands mid-URL produces a link that looks real
   * and goes nowhere. Two already-published posts carry exactly that damage
   * (there is no edit on Bluesky, so they can only be deleted and reposted).
   * Moving the URL into a thread item keeps both the prose and a working link.
   */
  bluesky: (r, _source, cap) => {
    if (!hasUrl(r.content) || vendorLength("bluesky", r.content) <= cap) return [];
    const log = moveLinkToThread(r);
    return log ? [`${log} (over Bluesky's ${cap}-character budget, and a trimmed URL is a dead link)`] : [];
  },

  /**
   * Reddit: zero hashtags and zero ad-speak. A title is mandatory. Affiliation
   * disclosure is checked in QA, not written here.
   */
  reddit: (r, source) => {
    const applied: string[] = [];
    if (!r.title?.trim() && source.title?.trim()) {
      r.title = source.title.trim();
      applied.push("carried the post title over (Reddit requires one)");
    }
    applied.push(...capHashtags(r, 0, "Reddit reads hashtags as spam"));
    return applied;
  },
};

/**
 * Run every platform's playbook over the renders, in place.
 *
 * Called from formatPost, which is the single choke point every path crosses
 * (draft creation, reformat, auto-media re-render, cadence planning, the
 * copilot), so no caller can accidentally publish un-optimized copy.
 */
export function applyPlaybooks(
  source: SourcePost,
  renders: PlatformRender[],
  /** Effective cap per platform; defaults to the researched spec limit. */
  capFor: (platform: Platform) => number = (p) => SPECS[p].maxChars,
): PlaybookResult {
  const changed = new Set<Platform>();
  const applied: string[] = [];

  for (const r of renders) {
    const playbook = PLAYBOOKS[r.platform];
    if (!playbook || !SPECS[r.platform]) continue;
    const before = JSON.stringify(r);
    const logs = playbook(r, source, capFor(r.platform));
    if (JSON.stringify(r) === before) continue;
    changed.add(r.platform);
    for (const log of logs) applied.push(`${SPECS[r.platform].displayName}: ${log}`);
  }

  return { changed: [...changed], applied };
}
