/**
 * Repair pass for an already-formatted draft.
 *
 * `formatPost` builds its prompt from the SOURCE alone and never sees the
 * existing renders, so it cannot "fix" anything: every fix attempt re-rolled
 * each platform from scratch at temperature 0.5 and clean copy came back with
 * brand new QA issues. This module is the other half of the story:
 *
 *   1. `applyMechanicalFixes` resolves the issues that are pure string surgery
 *      (link placement, hashtag caps, em-dashes, media-count limits) in code,
 *      deterministically, with no model call and no chance of regression.
 *   2. `reviseRenders` sends the model the CURRENT copy plus the exact issues
 *      still outstanding on it, and asks for the smallest edit that clears
 *      them, so "leave the clean parts alone" is a constraint it can actually
 *      honor.
 *
 * Both are per-platform. Callers (the /fix route) alternate them and re-run QA
 * between rounds, keeping the best result.
 */
import { NO_BRAND, editorRole, type BrandContext } from "./brand-context.js";
import { modelStamp } from "./claude.js";
import { claudeLlm } from "./ports.js";
import { deterministicChecks, isTextFixable, MECHANICAL_FIX_CODES } from "./qa.js";
import {
  countHashtags,
  dropBodyLink,
  moveLinkToFirstComment,
  moveLinkToThread,
  trimHashtags,
} from "./link-placement.js";
import { normalizeCardMediaIndices } from "./media-pick.js";
import { SENDS_FIRST_COMMENT, SPECS, linkDestination, specBlock, vendorLength } from "./specs.js";
import { threadReplies, type Draft, type PlatformRender, type Platform, type QAIssue, type QAReport } from "./types.js";

/* -------------------------------------------------------------------------- */
/* Mechanical fixes                                                           */
/* -------------------------------------------------------------------------- */

export interface MechanicalFixResult {
  /** Platforms whose render was actually modified. */
  changed: Platform[];
  /** Human-readable log lines, one per applied edit. */
  applied: string[];
}

/**
 * Replace em-dashes with brand-legal punctuation, then tidy the seams.
 *
 * ⛔ Line breaks are never whitespace here. The patterns used `\s`, which ate
 * the newline around a dash, so a dash-bulleted list collapsed into
 * "shipped:, Faster calls, French portal" and a sign-off into "Done., Alex".
 * A dash that OPENS a line is a bullet and becomes "- "; only inline dashes
 * become commas, and every seam rule matches spaces and tabs only.
 */
export function stripEmDashes(text: string): string {
  return text
    .replace(/^([ \t]*)—[ \t]*/gm, "$1- ")
    .replace(/[ \t]*—[ \t]*/g, ", ")
    .replace(/,[ \t]*([,.;:!?])/g, "$1")
    .replace(/[ \t]+,/g, ",")
    .replace(/,[ \t]*$/gm, "");
}

/**
 * Apply every deterministic fix the listed issues call for, in place, on the
 * draft's renders.
 *
 * Driven by the QA report rather than run unconditionally: a render nobody
 * complained about is never restructured. Only issues whose code is in
 * MECHANICAL_FIX_CODES are considered.
 */
export function applyMechanicalFixes(draft: Draft, issues: QAIssue[]): MechanicalFixResult {
  const changed = new Set<Platform>();
  const applied: string[] = [];
  const codesByPlatform = new Map<Platform, Set<string>>();
  for (const issue of issues) {
    if (!MECHANICAL_FIX_CODES.has(issue.code)) continue;
    // A platform-less mechanical issue applies to every render (only the
    // em-dash rule can currently produce one).
    const targets = issue.platform ? [issue.platform] : draft.renders.map((r) => r.platform);
    for (const p of targets) {
      const set = codesByPlatform.get(p) ?? new Set<string>();
      set.add(issue.code);
      codesByPlatform.set(p, set);
    }
  }
  if (codesByPlatform.size === 0) return { changed: [], applied: [] };

  for (const render of draft.renders) {
    const codes = codesByPlatform.get(render.platform);
    if (!codes) continue;
    const spec = SPECS[render.platform];
    if (!spec) continue;
    const before = JSON.stringify(render);
    const name = spec.displayName;

    if (codes.has("brand-em-dash")) {
      render.content = stripEmDashes(render.content);
      if (render.title) render.title = stripEmDashes(render.title);
      if (render.firstComment) render.firstComment = stripEmDashes(render.firstComment);
      if (render.threadItems) render.threadItems = render.threadItems.map(stripEmDashes);
      applied.push(`${name}: replaced em-dashes with brand-legal punctuation`);
    }

    // Links that are not clickable (Instagram) become "link in bio" phrasing.
    // Links that are clickable but reach-suppressed move OUT of the body to
    // wherever specs.ts linkDestination says is published and unpenalized: a
    // thread item on X, the first comment on Facebook, and nowhere on LinkedIn.
    if (codes.has("dead-link") && !spec.linksClickable) {
      // Pinterest's destination is a publish setting, so there is nothing to
      // point the reader at in the copy; Instagram's bio is the only route.
      const pointer = spec.platform === "pinterest" ? undefined : "Link in bio.";
      const log = dropBodyLink(render, pointer);
      if (log) applied.push(`${name}: ${log}`);
    } else if (codes.has("link-penalty") && spec.linkPenalty) {
      // Shared with the platform playbooks, so a link moved at format time and a
      // link moved by a later fix round land in exactly the same place.
      //
      // LinkedIn is left ALONE deliberately. This used to move its link into
      // the first comment, which 2026 research shows is penalized just as
      // heavily as a body link, and which linkedin-transport.ts never sends:
      // the edit paid the full cost and published the post with no link at
      // all. The finding stays reported instead (QA stamps it not fixable).
      const destination = linkDestination(render.platform);
      const log =
        destination === "thread"
          ? moveLinkToThread(render)
          : destination === "firstComment"
            ? moveLinkToFirstComment(render)
            : null;
      if (log) applied.push(`${name}: ${log}`);
    }

    if (codes.has("reddit-hashtags")) {
      const stripped = trimHashtags(render.content, 0);
      render.content = stripped.text;
      if (render.title) render.title = trimHashtags(render.title, 0).text;
      if (stripped.removed) {
        applied.push(`${name}: removed ${stripped.removed} hashtag${stripped.removed === 1 ? "" : "s"} (Reddit reads them as spam)`);
      }
    } else if (codes.has("hashtag-cap") || codes.has("hashtag-heavy")) {
      // The cap counts caption + first comment together, so trim the comment
      // first (lower value) and only then eat into the caption.
      //
      // Each code trims to the limit it reports. `hashtag-cap` only fires where
      // a hard cap exists (qa.ts), so `maxHashtags` is set there; `hashtag-heavy`
      // reports the ideal ceiling, and trimming it to the hard cap instead was a
      // no-op on YouTube (ideal 3, cap 15) that sent it to the model.
      const keep = codes.has("hashtag-cap") ? spec.maxHashtags! : spec.idealHashtags[1];
      const inComment = countHashtags(render.firstComment ?? "");
      const inBody = countHashtags(render.content);
      let removed = 0;
      if (inBody + inComment > keep) {
        const commentKeep = Math.max(0, keep - Math.min(inBody, keep));
        if (render.firstComment) {
          const t = trimHashtags(render.firstComment, commentKeep);
          render.firstComment = t.text || undefined;
          removed += t.removed;
        }
        const bodyKeep = Math.min(inBody, keep);
        const t = trimHashtags(render.content, bodyKeep);
        render.content = t.text;
        removed += t.removed;
      }
      if (removed) {
        applied.push(`${name}: cut ${removed} hashtag${removed === 1 ? "" : "s"} down to the platform's limit of ${keep}`);
      }
    }

    // Media-count rules. These were classed as "operator must fix by hand",
    // but picking which attachments to keep is exactly the kind of decision a
    // rule can make correctly, so a media limit no longer strands a draft.
    if (codes.has("mixed-media") && !spec.mixedMediaAllowed) {
      const selected = render.mediaIndices.map((i) => ({ i, m: draft.source.media[i] })).filter((x) => x.m);
      const firstType = selected[0]?.m?.type === "video" ? "video" : "image";
      const kept = selected.filter((x) =>
        firstType === "video" ? x.m!.type === "video" : x.m!.type !== "video",
      );
      if (kept.length && kept.length < selected.length) {
        render.mediaIndices = kept.map((x) => x.i);
        applied.push(`${name}: dropped the mismatched attachments (${name} cannot mix images and video)`);
      }
    }
    if (codes.has("too-many-images") && spec.maxImages) {
      const images = render.mediaIndices.filter((i) => {
        const m = draft.source.media[i];
        return m && (m.type === "image" || m.type === "gif");
      });
      if (images.length > spec.maxImages) {
        const keep = new Set(images.slice(0, spec.maxImages));
        render.mediaIndices = render.mediaIndices.filter((i) => {
          const m = draft.source.media[i];
          const isImage = m && (m.type === "image" || m.type === "gif");
          return !isImage || keep.has(i);
        });
        applied.push(`${name}: trimmed to the ${spec.maxImages}-image maximum`);
      }
    }
    // Several crops of one generated card on a single render. Deterministic by
    // definition: the right crop is the aspect-ratio match, no judgment involved.
    if (codes.has("duplicate-media-attach") && render.mediaIndices.length > 1) {
      const picked = normalizeCardMediaIndices(draft.source.media, [render]);
      if (picked.length) {
        applied.push(`${name}: kept only the best-fitting crop of the generated card set`);
      }
    }

    // A file too large for this platform (an uploaded photo over Bluesky's 1MB,
    // most often). The only automatic remedy is to drop it, so this runs ONLY
    // where the platform can still post without media; a requiresMedia platform
    // keeps the failing issue for the operator, since dropping would leave it
    // publishable-as-nothing. This is exactly the by-hand fix (remove the too-
    // big image from Bluesky) that prompted the rule.
    if ((codes.has("image-too-large") || codes.has("video-too-large")) && !spec.requiresMedia) {
      const fits = (i: number): boolean => {
        const m = draft.source.media[i];
        if (!m) return false;
        const isImage = m.type === "image" || m.type === "gif";
        if (isImage && spec.maxImageBytes && m.size > spec.maxImageBytes) return false;
        if (m.type === "video" && spec.maxVideoBytes && m.size > spec.maxVideoBytes) return false;
        return true;
      };
      const kept = render.mediaIndices.filter(fits);
      if (kept.length < render.mediaIndices.length) {
        const dropped = render.mediaIndices.length - kept.length;
        render.mediaIndices = kept;
        applied.push(
          `${name}: removed ${dropped} attachment${dropped === 1 ? "" : "s"} over ${name}'s file-size limit`,
        );
      }
    }

    // Any structural edit above invalidates the stored rationale ("Why this
    // version"), which is shown to the operator verbatim. Leaving a stale one
    // means the panel explains choices the copy no longer makes.
    if (JSON.stringify(render) !== before) {
      changed.add(render.platform);
      render.rationale = render.rationale
        ? `${render.rationale} Adjusted automatically to satisfy ${name}'s platform rules.`
        : `Adjusted automatically to satisfy ${name}'s platform rules.`;
    }
  }

  return { changed: [...changed], applied };
}

/**
 * The text-fixable issues that are still real after a mechanical pass.
 *
 * Deterministic findings are recomputed from the edited draft, so anything the
 * mechanical pass just resolved disappears for free. The previous run's `llm-*`
 * findings have no such recomputation available, so they are carried over only
 * for platforms whose copy was NOT touched: a model finding about copy that has
 * since changed describes text that no longer exists, and feeding it back would
 * have the reviser "fix" a body link it can no longer find.
 */
export function outstandingIssues(
  draft: Draft,
  previous: QAReport | undefined,
  changed: Platform[],
  /** The brand pack whose gates and brief headings QA applies (brand-context.ts). */
  brand: BrandContext = NO_BRAND,
): QAIssue[] {
  const changedSet = new Set(changed);
  const fresh = deterministicChecks(draft, null, undefined, null, brand);
  const carried = (previous?.issues ?? []).filter(
    (i) =>
      i.code.startsWith("llm-") &&
      i.code !== "llm-qa-unavailable" &&
      (!i.platform || !changedSet.has(i.platform)),
  );
  return [...fresh, ...carried].filter((issue) => isTextFixable(issue, brand));
}

/* -------------------------------------------------------------------------- */
/* LLM revise pass                                                            */
/* -------------------------------------------------------------------------- */

/** Fails first: the model reads the list top-down and edits in that order. */
const SEVERITY_RANK: Record<QAIssue["severity"], number> = {
  fail: 0,
  warn: 1,
  info: 2,
};

/**
 * Severity as the prompt states it. Deliberately not the raw enum: "info" reads
 * as "informative, act on it" to a model, which is the opposite of what it
 * means here.
 */
const PROMPT_SEVERITY: Record<QAIssue["severity"], string> = {
  fail: "BLOCKING",
  warn: "IMPORTANT",
  info: "OPTIONAL",
};

interface RevisedRender {
  platform: Platform;
  content: string;
  title?: string;
  firstComment?: string;
  threadItems?: string[];
  changeNote?: string;
}

/** The revise pass's reply, as structured output; `platform` is one of those being revised. */
function revisedSchema(platforms: Platform[]): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      renders: {
        type: "array",
        items: {
          type: "object",
          properties: {
            platform: { type: "string", enum: platforms },
            content: { type: "string" },
            title: { type: "string" },
            firstComment: { type: "string" },
            threadItems: { type: "array", items: { type: "string" } },
            changeNote: { type: "string" },
          },
          required: ["platform", "content"],
          additionalProperties: false,
        },
      },
    },
    required: ["renders"],
    additionalProperties: false,
  };
}

function renderForPrompt(render: PlatformRender): Record<string, unknown> {
  const spec = SPECS[render.platform];
  const replies = threadReplies(render);
  return {
    platform: render.platform,
    content: render.content,
    contentLength: vendorLength(render.platform, render.content),
    hardLimit: spec?.maxChars,
    ...(render.title ? { title: render.title } : {}),
    ...(render.firstComment ? { firstComment: render.firstComment } : {}),
    ...(replies.length ? { threadItems: replies } : {}),
  };
}

/**
 * Ask the model to make the smallest edit to each listed platform's CURRENT
 * copy that clears its outstanding issues.
 *
 * Returns only the platforms it managed to revise; anything missing or
 * malformed is simply left as-is by the caller, so a bad roll degrades to "no
 * change" instead of to a re-rolled draft.
 */
export async function reviseRenders(
  draft: Draft,
  issues: QAIssue[],
  /** The brand pack whose brief the model reads (brand-context.ts). Absent, the brief is empty. */
  brand: BrandContext = NO_BRAND,
): Promise<Map<Platform, PlatformRender>> {
  const byPlatform = new Map<Platform, QAIssue[]>();
  for (const issue of issues) {
    const targets: Platform[] = issue.platform
      ? [issue.platform]
      : draft.renders.map((r) => r.platform);
    for (const p of targets) {
      if (!draft.renders.some((r) => r.platform === p)) continue;
      byPlatform.set(p, [...(byPlatform.get(p) ?? []), issue]);
    }
  }
  if (byPlatform.size === 0) return new Map();

  const platforms = [...byPlatform.keys()];
  const work = platforms.map((p) => {
    const render = draft.renders.find((r) => r.platform === p)!;
    // Severity-ordered and severity-LABELLED. Sending a bare list of messages
    // told the model nothing about what was blocking, so a hard character
    // overrun and a stylistic nitpick arrived with equal weight and it would
    // spend the edit on whichever read as easier, leaving the blocker behind.
    const ordered = [...byPlatform.get(p)!].sort(
      (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
    );
    return {
      current: renderForPrompt(render),
      issues: ordered.map((i) => ({
        severity: PROMPT_SEVERITY[i.severity],
        code: i.code,
        message: i.message,
        fix: i.fix,
      })),
    };
  });

  // A brand pack's brief is never empty, so the section below has no "(none)"
  // placeholder; a brandless engine sends the heading over an empty section.
  const prompt = `You are ${editorRole(brand)}. Each platform version below ALREADY EXISTS and has been reviewed. Your job is to EDIT it so the listed issues are resolved. This is a revision pass, not a rewrite.

## Brand brief
${brand.brandBrief()}

## Source post (for facts only, do not restart from it)
"""
${draft.source.text}
"""
Link to promote: ${draft.source.link ?? "(none)"}

## Platform rules
${specBlock(platforms, brand)}

## Versions to revise
${JSON.stringify(work, null, 1)}

## Output
Return JSON: {"renders": [{"platform": "...", "content": "...", "title": "...", "firstComment": "...", "threadItems": ["..."], "changeNote": "..."}]}

Rules:
- One entry per platform listed above, ids exactly: ${platforms.join(", ")}.
- Severity is an instruction, not a label. EVERY issue marked BLOCKING must be resolved: a revision that leaves one standing has failed, no matter how clean the rest reads. Resolve IMPORTANT issues too. Leave an OPTIONAL issue alone if fixing it would put a BLOCKING or IMPORTANT one at risk.
- Do NOT introduce new problems while fixing. The listed issues are what was caught, not the full set of rules: the platform rules above still apply to every edit you make. Adding an em-dash, a hashtag where none is allowed, a link in the body, or pushing another field over its limit is a regression even when it clears the issue you were aiming at.
- Make the MINIMUM edit that resolves every listed issue. Preserve the existing wording, structure, facts, links, and hooks everywhere the issues do not force a change. Do not restyle copy nobody complained about.
- "content" must respect the hard character limit STRICTLY. Rewrite to fit; never end mid-sentence and never use an ellipsis to squeeze under a limit.
- Include "title"/"firstComment"/"threadItems" only where the platform uses them; omit a key to leave the existing value untouched, or return an empty string to clear it.
- "threadItems" are the replies posted after "content", in order. Never repeat "content" as a thread item.
- When an issue says a link must move out of the body, the body must end up with NO url in it, and the url must appear in a field this platform PUBLISHES: a thread item where threads are supported, otherwise the first comment, and only where the platform rules above say "firstComment supported". Never put a link (or anything else) in a firstComment the rules say is NOT published: that text never goes out, so the link would be lost.
- "changeNote": one short sentence on what you changed and why.
- Never use em-dashes anywhere.`;

  const out = await (brand.llm ?? claudeLlm).generateJson<{ renders: RevisedRender[] }>(prompt, {
    schema: revisedSchema(platforms),
  });

  const revised = new Map<Platform, PlatformRender>();
  for (const item of out.renders) {
    // The schema holds `platform` to the platforms being revised, and each of
    // those has a render (they were read off draft.renders above).
    const existing = draft.renders.find((r) => r.platform === item.platform)!;
    const content = item.content.trim();
    // An empty body would publish a blank post; treat it as a failed revision
    // and keep what we had.
    if (!content) continue;

    // Replies only (types.ts). A kept chain is read through threadReplies so a
    // row stored with its root as item 0 cannot carry the OLD body forward as
    // a reply, and a reply repeating the revised body (the model echoing the
    // root back as item 0) is dropped too.
    const threadItems = threadReplies({
      content,
      threadItems:
        item.threadItems?.length
          ? item.threadItems.filter((t) => !!t.trim())
          : threadReplies(existing),
    });

    const firstComment =
      typeof item.firstComment === "string"
        ? item.firstComment.trim() || undefined
        : existing.firstComment;

    revised.set(item.platform, {
      ...existing,
      content,
      title: typeof item.title === "string" ? item.title.trim() || undefined : existing.title,
      // A platform whose transport never sends a first comment (LinkedIn,
      // YouTube) cannot GAIN one here, whatever the model returns: a link it
      // "moved out of the body" into that field would publish nowhere. Clearing
      // one is still taken, since that changes nothing that goes out.
      firstComment:
        SENDS_FIRST_COMMENT.has(item.platform) || !firstComment ? firstComment : existing.firstComment,
      threadItems: threadItems.length ? threadItems : undefined,
      rationale: item.changeNote?.trim() || existing.rationale,
      generatedBy: modelStamp(),
    });
  }
  return revised;
}
