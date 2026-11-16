import { NO_BRAND, editorRole, type BrandContext } from "./brand-context.js";
import { defaults } from "./settings.js";
import { genJson, modelStamp } from "./claude.js";
import { claudeLlm } from "./ports.js";
import { readAsBase64 } from "./media.js";
import { isGeneratedCardSet, pickMediaForPlatform, routeModelMediaIndices } from "./media-pick.js";
import { SPECS, normalizeSubreddit, specBlock, vendorLength } from "./specs.js";
import { effectiveMaxChars, rulesBlock, type ChannelRulesSnapshot } from "./channel-rules.js";
import { applyPlaybooks } from "./playbook.js";
import type {
  Draft,
  MediaAsset,
  Platform,
  PlatformRender,
  SourcePost,
} from "./types.js";

interface FormatterRender {
  platform: Platform;
  content: string;
  title?: string;
  firstComment?: string;
  threadItems?: string[];
  subreddit?: string;
  mediaIndices?: number[];
  rationale?: string;
}

/**
 * The formatter's reply, as structured output. `platform` is constrained to the
 * eligible targets; the optional fields are the ones a platform may not use.
 */
function formatterSchema(platforms: Platform[]): Record<string, unknown> {
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
            subreddit: { type: "string" },
            mediaIndices: { type: "array", items: { type: "integer" } },
            rationale: { type: "string" },
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

function describeMedia(media: MediaAsset[]): string {
  if (!media.length) return "none";
  return media
    .map((m, i) => {
      const dims = m.width ? ` ${m.width}x${m.height}` : "";
      const dur = m.durationSec ? ` ${m.durationSec}s` : "";
      return `  [${i}] ${m.type} (${m.mimeType}${dims}${dur})${m.altText ? ` alt: "${m.altText}"` : ""}`;
    })
    .join("\n");
}

export async function formatPost(
  source: SourcePost,
  targets: Platform[],
  instruction?: string,
  /**
   * Live vendor rules, when the caller has a cached snapshot. Injected after our
   * researched specs and marked authoritative, so the model writes to what the
   * platform actually enforces rather than to what we last researched.
   */
  channelRules?: ChannelRulesSnapshot | null,
  /** The brand pack whose brief the model reads (brand-context.ts). Absent, the brief is empty. */
  brand: BrandContext = NO_BRAND,
): Promise<PlatformRender[]> {
  const def = defaults();
  // Unknown platform ids (possible from loosely-validated web/model input)
  // are dropped rather than crashing on an undefined spec.
  const eligible = targets.filter((p) => {
    const s = SPECS[p];
    if (!s) return false;
    if (s.requiresVideo) return source.media.some((m) => m.type === "video");
    if (s.requiresMedia) return source.media.length > 0;
    return true;
  });
  // Targets dropped here are reported by skippedForMedia() and, at the app
  // layer, by the deterministic `target-skipped` QA check. With none left there
  // is nothing to write, and an empty `enum` is not a schema the API accepts.
  if (!eligible.length) return [];

  // A brand pack's brief is never empty, so the section below has no "(none)"
  // placeholder; a brandless engine sends the heading over an empty section.
  const prompt = `You are ${editorRole(brand)}. Take ONE source post and produce an optimally formatted version for EACH target platform. Rewrite freely per platform norms — do not just copy the text. Keep facts, links, and product names exactly accurate.

## Brand brief
${brand.brandBrief()}

## Source post
Text:
"""
${source.text}
"""
${source.title ? `Suggested title: ${source.title}` : ""}
Hashtag pool (use per-platform judgment, rewrite/trim freely): ${source.hashtags.join(" ") || "(none — derive 0-5 relevant ones per platform norms)"}
Link to promote: ${source.link ?? "(none)"}
Media attached:
${describeMedia(source.media)}
${source.notes ? `Author notes: ${source.notes}` : ""}
${instruction ? `\n## Operator instruction for this pass\n${instruction}` : ""}

## Target platforms and their rules
${specBlock(eligible, brand)}
${rulesBlock(channelRules ?? null, eligible)}

## Output
Return JSON: {"renders": [{"platform": "...", "content": "...", "title": "...", "firstComment": "...", "threadItems": ["..."], "subreddit": "...", "mediaIndices": [0], "rationale": "..."}]}

Rules:
- One render per target platform, platform ids exactly: ${eligible.join(", ")}.
- "content" is the body/caption. Respect every hard limit STRICTLY.
- Only include "title" where the platform uses one (youtube required <=100 chars, reddit required <=300 chars, pinterest strongly recommended <=100 chars because the feed shows the title and image, not the description).
- Only include "firstComment" where the platform rules above say "firstComment supported" and it is useful (e.g. Instagram hashtag overflow). Where they say it is NOT published, leave it out: that text never goes out.
- Only include "threadItems" (full sequence INCLUDING the first post as item 0) if the content genuinely needs a thread; otherwise omit.
- "subreddit" only for reddit${def.subreddit ? ` (use exactly: ${def.subreddit})` : ". OMIT this field entirely. Do NOT invent, guess, or infer a subreddit: posting promotional content to an unvetted subreddit is spam and gets the account banned. Leaving it out is correct and safe, because a later step supplies the operator's configured subreddit and QA blocks the post if none is set"}.
- "mediaIndices": which source media items to attach for this platform (respect platform media rules; youtube must be video indices only, and a platform marked "Cannot publish video" must never get a video index; omit to attach all). Generated brand-card sets are routed by code after you, so never attach more than one near-identical image.
- "rationale": one sentence on the platform-specific choices you made.
- Never use em-dashes anywhere.
- Write naturally and put the link wherever it reads best. A deterministic pass runs AFTER you and applies each platform's link policy (X moves it into a reply, Facebook into the first comment, LinkedIn keeps it in the body because it publishes no first comment and every placement there is penalized, Instagram and Pinterest drop it because it is not clickable there), so do not engineer around those rules or try to pre-empt them.`;

  // Structured output: the reply always has this shape (claude.ts), so only
  // the per-platform completeness check below can still fail.
  const out = await (brand.llm ?? claudeLlm).generateJson<{ renders: FormatterRender[] }>(prompt, {
    schema: formatterSchema(eligible),
  });

  const renders: PlatformRender[] = [];
  for (const p of eligible) {
    const r = out.renders.find((x) => x.platform === p);
    if (!r) throw new Error(`formatter returned no render for ${p}`);
    // mediaIndices is dereferenced during publish (publish.ts indexes
    // source.media with it), so anything out of range here becomes a
    // mid-publish crash after media has already uploaded (the schema makes
    // them integers, not in range). Then the video routing (media-pick.ts): a
    // video goes only where publishesVideo.
    const mediaIndices = routeModelMediaIndices(
      p,
      source.media,
      r.mediaIndices?.filter((i) => i >= 0 && i < source.media.length),
    );
    // The prompt asks for the whole thread with the root as item 0; a render
    // stores replies only (types.ts), so item 0 becomes the body and the rest
    // the replies.
    const thread = r.threadItems?.length ? r.threadItems : undefined;
    const replies = thread?.slice(1);
    renders.push({
      platform: p,
      content: (thread ? thread[0]! : r.content).trim(),
      title: r.title?.trim() || undefined,
      firstComment: r.firstComment?.trim() || undefined,
      threadItems: replies?.length ? replies : undefined,
      // The shared normalizer, not a local strip: the hand-rolled version here
      // was case-sensitive and missed a leading slash, so "/r/SaaS" survived as
      // "/r/SaaS" while the publisher, the QA gate and the settings store all
      // resolved it to "saas". What we stored and showed then differed from
      // what was actually published.
      subreddit:
        p === "reddit"
          ? normalizeSubreddit(r.subreddit) ?? normalizeSubreddit(def.subreddit)
          : undefined,
      mediaIndices,
      rationale: r.rationale,
      generatedBy: modelStamp(),
    });
  }

  // The effective cap is the VENDOR's when we have it. hardTrim used the
  // researched SPECS number, so on any platform where Postiz enforces something
  // lower (Reddit reports 10,000 against Reddit's own 40,000) the trim let copy
  // through that the publish call then rejected, and QA reported it as a finding
  // nobody could act on. Where Postiz allows MORE (X Premium), this stops us
  // trimming copy the platform would have accepted.
  const capFor = (p: Platform): number => effectiveMaxChars(channelRules ?? null, p, SPECS[p].maxChars);

  // Generated card sets are routed by aspect ratio in code, never by the model.
  // The set is three crops of the SAME design, so "which crop" has exactly one
  // right answer per platform, and the model's answer was nondeterministic: when
  // it omitted the field, the allIndices default above shipped three
  // near-identical images on one post.
  if (isGeneratedCardSet(source.media)) {
    for (const r of renders) r.mediaIndices = pickMediaForPlatform(r.platform, source.media);
  }

  // Per-platform playbooks BEFORE the trim, so the trim measures final copy and
  // never has to cut a URL the playbook was about to move anyway.
  applyPlaybooks(source, renders, capFor);

  // Deterministic hard-trim safety net. This previously only ran on thread
  // items despite the comment claiming otherwise, so over-limit content from
  // the model went out to the platform and only ever surfaced as a QA warning.
  for (const r of renders) {
    const s = SPECS[r.platform];
    const cap = capFor(r.platform);
    if (r.threadItems) {
      // The channel cap applies to every value the vendor receives, thread
      // items included, so a per-item cap above it would not save the post.
      const itemLimit = Math.min(s.threadItemMaxChars ?? cap, cap);
      r.threadItems = r.threadItems.map((t) => hardTrim(r.platform, t, itemLimit));
    }
    r.content = hardTrim(r.platform, r.content, cap);
    // Sent as its own value and measured against the same cap.
    if (r.firstComment) r.firstComment = hardTrim(r.platform, r.firstComment, cap);
  }

  return renders;
}

export function skippedForMedia(source: SourcePost, targets: Platform[]): Platform[] {
  return targets.filter((p) => {
    const s = SPECS[p];
    if (!s) return false;
    if (s.requiresVideo) return !source.media.some((m) => m.type === "video");
    if (s.requiresMedia) return source.media.length === 0;
    return false;
  });
}

/**
 * Trim to fit, measured the way the VENDOR measures (see specs.vendorLength).
 *
 * Two bugs lived in an earlier version, and both shipped a post that Postiz
 * then refused or mangled:
 *
 * 1. It measured code points while Postiz counts UTF-16 units, and it trimmed
 *    to exactly `limit`, so every trimmed post landed precisely on the boundary
 *    where the two counts disagree. One emoji was enough to make it over.
 * 2. It cut blind, mid-token, leaving bodies ending `See it live: https://…`.
 *    A trimmed post is a compromise; a trimmed post with a broken link is
 *    worthless. Dropping the partial token is strictly better, so long as
 *    something is left of the post.
 */
function hardTrim(platform: Platform, text: string, limit: number): string {
  if (vendorLength(platform, text) <= limit) return text;

  // Code points, so a cut can never split a surrogate pair and leave a stray
  // half. Binary search, not a scan down from `limit` code points: the vendor
  // count can be BELOW the code-point count (a family emoji is one grapheme, an
  // X link is 23 however long), so a prefix longer than `limit` may fit. Every
  // accepted `lo` was measured, so the cut always fits even where the count is
  // not monotonic (a URL cut short stops being a URL).
  const chars = [...text];
  const fits = (k: number) => vendorLength(platform, chars.slice(0, k).join("") + "…") <= limit;
  let lo = 0;
  let hi = chars.length;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  let n = lo;

  const cutMidToken = n > 0 && n < chars.length && /\S/.test(chars[n]!) && /\S/.test(chars[n - 1]!);
  if (cutMidToken) {
    let w = n;
    while (w > 0 && /\S/.test(chars[w - 1]!)) w--;
    // Only if a word survives. A single token longer than the whole limit (a
    // giant URL) would otherwise trim away to nothing but an ellipsis.
    if (w > 0) n = w;
  }

  return chars.slice(0, n).join("").trimEnd() + "…";
}

/**
 * Generate alt text for a single media asset (accessibility + SEO). Caller
 * supplies the already-loaded bytes, so this has no filesystem dependency and
 * is safe to call from a hosted admin UI (uploaded media, not a local path).
 */
export async function generateAltText(
  postText: string,
  media: { mimeType: string; dataBase64: string },
): Promise<string> {
  const out = await genJson<{ altText: string }>(
    `Write concise, factual alt text (max 125 chars) for this image, which accompanies this social post: "${postText.slice(0, 300)}". Return JSON {"altText": "..."}. Describe what is visible; no "image of" prefix.`,
    {
      media: [media],
      schema: {
        type: "object",
        properties: { altText: { type: "string" } },
        required: ["altText"],
        additionalProperties: false,
      },
    },
  );
  return out.altText.slice(0, 200);
}

/**
 * CLI convenience: fills in alt text for local-path image media in a
 * SourcePost that lack it, reading bytes off disk.
 */
export async function generateAltTextsFromFiles(source: SourcePost): Promise<void> {
  for (const m of source.media) {
    if (m.type !== "image" || m.altText) continue;
    const b64 = await readAsBase64(m);
    if (!b64) continue;
    try {
      m.altText = await generateAltText(source.text, { mimeType: m.mimeType, dataBase64: b64 });
    } catch {
      // alt text is best-effort; QA will flag missing ones
    }
  }
}

/**
 * Serialize a draft for an LLM prompt.
 *
 * `rationale` is the formatter's own "why this version" note. It is metadata
 * shown to the operator, never published, so a reviewer that sees it spends its
 * findings auditing prose nobody reads: three of six issues on a real draft
 * were "the rationale says two tweets but there is one", which blocks
 * publishing over a stale caption on the explanation. Callers that review copy
 * leave it out; callers that ask for an edit to it can opt back in.
 */
export function draftSummaryForPrompt(
  draft: Draft,
  opts: { includeRationale?: boolean } = {},
): string {
  return JSON.stringify(
    {
      source: {
        ...draft.source,
        media: draft.source.media.map((m) => ({
          type: m.type,
          mimeType: m.mimeType,
          width: m.width,
          height: m.height,
          durationSec: m.durationSec,
          altText: m.altText,
        })),
      },
      renders: opts.includeRationale
        ? draft.renders
        : draft.renders.map(({ rationale: _rationale, ...rest }) => rest),
    },
    null,
    1,
  );
}
