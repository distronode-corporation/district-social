import {
  NO_BRAND,
  normalizeHeadingText,
  reviewerRole,
  type BrandContext,
  type QaGate,
} from "./brand-context.js";
import { modelStamp } from "./claude.js";
import { claudeLlm } from "./ports.js";
import { draftSummaryForPrompt } from "./format.js";
import { isGeneratedCardSet, unpublishableVideoIndices } from "./media-pick.js";
import { hasMediaFitter } from "./media-fit.js";
import {
  assertPublishable,
  connectedAccounts,
  resolveRedditRestrictions,
  sentContents,
  sentValues,
} from "./publish.js";
// ⚠️ Transport LIMITS are no longer looked up here at all. They arrive already
// resolved in `fittingRules`, because a separate lookup could disagree with the
// routing decision that produced the set — which is how the same bug shipped
// three times. `routeTransportFor` remains only for the Pinterest board check,
// which needs a live vendor call rather than a limit.
import { routeTransportFor, type TransportChannelRules } from "./transport.js";
import { defaults } from "./settings.js";
import { SENDS_FIRST_COMMENT, SPECS, linkDestination, normalizeSubreddit, specBlock, vendorLength } from "./specs.js";
import { effectiveMaxChars, type ChannelRulesSnapshot } from "./channel-rules.js";
import { ALL_PLATFORMS, type Platform } from "./types.js";
import { trimTrailing } from "./trim.js";
import type { Draft, MediaAsset, PlatformRender, QAIssue, QAReport, QASeverity } from "./types.js";

function countHashtags(text: string): number {
  return text.match(/(^|\s)#[\p{L}\p{N}_]+/gu)?.length ?? 0;
}

/**
 * Scaffold text a model leaves behind when it hedges instead of deciding:
 * parenthetical alternatives, bracketed insert-markers, lorem. Narrow on
 * purpose — a false positive blocks a real post, so each pattern needs the
 * scaffold KEYWORD, not just the punctuation.
 */
const PLACEHOLDER_PATTERNS: RegExp[] = [
  // "(or similar relevant sub)", "(or an equivalent community)"
  /\(\s*or\s+(?:a\s+|an\s+|the\s+)?(?:similar|equivalent|relevant|other|comparable)\b[^)]*\)/i,
  // "(insert city)", "(replace with your offer)", "(choose one)"
  /\(\s*(?:insert|replace|add|choose|pick|select)\b[^)]*\)/i,
  // "(your business name here)"
  /\(\s*your\b[^)]{0,40}\bhere\s*\)/i,
  // "[insert name]", "[TODO]", "[placeholder]", "[link]"
  /\[\s*(?:insert|todo|fixme|placeholder|tbd|link|name|date|city)\b[^\]]*\]/i,
  /\blorem ipsum\b/i,
];

export function detectPlaceholderText(text: string): boolean {
  return PLACEHOLDER_PATTERNS.some((re) => re.test(text));
}

// The heading phrases are derived from the brand pack's brief by
// briefHeadingPhrases (brand-context.ts); re-exported so QA's callers keep one
// import for the whole check.
export { BRIEF_HEADING_MIN_CHARS, briefHeadingPhrases } from "./brand-context.js";

/**
 * The first brief-heading phrase the text quotes, or undefined. "Quotes" means
 * the phrase appears as a substring of the text once both are normalised the
 * same way (case and whitespace), so a quote across a line break still counts.
 * The phrases come from a brand context (`briefHeadingPhrases()`); a brandless
 * engine has none, so nothing counts as a quote.
 */
export function findQuotedBriefHeading(text: string, phrases: readonly string[]): string | undefined {
  const normalized = normalizeHeadingText(text);
  return phrases.find((phrase) => normalized.includes(phrase));
}

interface OverLimitValue {
  code: "over-limit" | "thread-item-over-limit" | "first-comment-over-limit";
  label: string;
  len: number;
  cap: number;
}

/**
 * Length-check every value this render will actually be published as.
 *
 * A platform applies its maximum to EVERY value we send it, so checking only
 * `content` is blind to two of the three. A first comment over the cap used to
 * sail through QA and come back as an opaque 400.
 *
 * The list comes from publish.ts so it cannot drift from what is sent, and
 * flagging a value that never leaves the building is its own kind of wrong.
 */
function overLimitValues(r: PlatformRender, cap: number): OverLimitValue[] {
  const s = SPECS[r.platform];
  const out: OverLimitValue[] = [];
  let reply = 0;

  for (const { kind, text } of sentValues(r)) {
    if (kind === "reply") reply += 1;
    // A thread item's own cap is never above the channel cap, and the vendor
    // enforces the channel cap regardless, so the stricter of the two applies.
    // Non-null: only X, Bluesky and Threads send replies, and all three declare
    // an item cap (pinned in sent-contents.test.ts).
    const limit = kind === "reply" ? Math.min(s.threadItemMaxChars!, cap) : cap;
    const len = vendorLength(r.platform, text);
    if (len <= limit) continue;
    out.push(
      kind === "content"
        ? { code: "over-limit", label: "content", len, cap: limit }
        : kind === "reply"
          ? { code: "thread-item-over-limit", label: `thread reply ${reply}`, len, cap: limit }
          : { code: "first-comment-over-limit", label: "first comment", len, cap: limit },
    );
  }

  return out;
}

/**
 * Does the cached snapshot carry a usable live cap for this platform?
 *
 * Mirrors the condition inside effectiveMaxChars exactly, and exists so the two
 * length rules can divide the work instead of both firing. Where this is true,
 * channelRuleChecks owns the finding (code "vendor-length", with the vendor's
 * own number in the message); where it is false, the deterministic pass falls
 * back to our researched spec.
 */
function hasLiveMaxLength(snapshot: ChannelRulesSnapshot | null, platform: Platform): boolean {
  const live = snapshot?.channels[platform]?.maxLength;
  return typeof live === "number" && live > 0;
}

/**
 * Pinterest's legal media shapes, which no combination of the spec flags can
 * express: 1-5 images, OR exactly one video accompanied by exactly one cover
 * image. That is why `mixedMediaAllowed` is true on the Pinterest spec (a video
 * pin is legitimately mixed) and why the real rule lives here instead.
 *
 * The vendor states it as: "Pinterest requires at least one media, if posting a
 * video, you must have two attachment, one for video, one for the cover picture,
 * When posting a video, there can be only one, if posting images, there can be
 * maximum 5" (GET /integration-settings/:id, verified live 2026-07-25).
 *
 * The bare `media-required` and `too-many-images` cases are already covered by
 * the generic spec-driven checks, so they are deliberately not repeated.
 */
function pinterestMediaShape(
  r: PlatformRender,
  selected: Array<MediaAsset | undefined>,
): QAIssue[] {
  const assets = selected.filter((m): m is MediaAsset => Boolean(m));
  const videos = assets.filter((m) => m.type === "video");
  if (videos.length === 0) return [];

  const issues: QAIssue[] = [];
  if (videos.length > 1) {
    issues.push({
      severity: "fail",
      platform: r.platform,
      code: "pinterest-media-shape",
      message: `${videos.length} videos attached; a pin can carry only one`,
      fix: "Keep a single video and attach one cover image alongside it.",
    });
  }
  const covers = assets.filter((m) => m.type === "image" || m.type === "gif");
  if (covers.length !== 1) {
    issues.push({
      severity: "fail",
      platform: r.platform,
      code: "pinterest-media-shape",
      message:
        covers.length === 0
          ? "a video pin also needs exactly one cover image, and none is attached"
          : `a video pin needs exactly one cover image, and ${covers.length} images are attached`,
      fix: "Attach exactly one image to serve as the video's cover.",
    });
  }
  return issues;
}

export function deterministicChecks(
  draft: Draft,
  channelRules: ChannelRulesSnapshot | null = null,
  /**
   * The limits each platform's media will ACTUALLY be fitted to at publish
   * time, keyed by platform. An entry exists only for a platform that is
   * genuinely routed somewhere right now, and its value is that route's own
   * `channelRules()`.
   *
   * ⛔ ONE MAP, NOT A SET PLUS A REGISTRY LOOKUP, and that is the whole point.
   * This used to be `directPlatforms: ReadonlySet<Platform>`, with the limits
   * fetched separately from `registeredTransportFor(p).channelRules()`. Because
   * those two could disagree, the same bug shipped three times (see the notes at
   * `too-many-images` and `image-too-large` below): registered-but-not-routed,
   * routed-but-limits-read-from-the-wrong-place, and routed-and-fitted-but-no-
   * declared-limit. Carrying both facts in one value makes all three
   * unrepresentable, because "is it fitted" and "to what" are now the same
   * lookup.
   *
   * It also fixes a fourth that had not shipped yet: an AGGREGATOR-routed
   * platform now contributes the AGGREGATOR's limits. Those are its own and are
   * frequently STRICTER than the vendor's, so reading our direct transport's
   * numbers would have validated against limits nothing was going to apply.
   *
   * ⛔ Deliberately not derived here, and the default is deliberately EMPTY.
   * Only a caller that has resolved `transportOverrides` can answer the question
   * (`routeTransportFor` is async and this function is not), and the safe answer
   * when nobody knows is "assume nothing gets fitted", which keeps
   * `image-too-large` a hard fail. A QA gate that guesses in the permissive
   * direction is worse than one that is occasionally too strict.
   */
  fittingRules: ReadonlyMap<Platform, TransportChannelRules> = new Map(),
  /**
   * Platforms this draft can actually be DELIVERED to right now: the union of
   * the ones publishing through a direct transport and the ones the aggregator
   * still holds a connected channel for. Exactly the set publish.ts derives
   * from `connectedAccounts()` to build `sendable`.
   *
   * `null` means the caller could not resolve routing, and the check is skipped
   * — the opposite default to `directPlatforms` above, and for the same reason.
   * There, guessing permissively would let a real defect through; here, guessing
   * would fail EVERY target in the CLI and in unit tests that have no settings
   * table to read. Skipping is the honest answer to "I don't know", and
   * runQaLive (the path every app surface uses) always supplies it.
   */
  routablePlatforms: ReadonlySet<Platform> | null = null,
  /** The brand pack's brief headings and extra gates (brand-context.ts). */
  brand: BrandContext = NO_BRAND,
): QAIssue[] {
  const headingPhrases = brand.briefHeadingPhrases();
  const issues: QAIssue[] = [];
  const media = draft.source.media;

  // ⛔ CAN THIS DRAFT BE DELIVERED AT ALL?
  //
  // QA had thirty checks on what a post SAYS and not one on whether it could be
  // sent. When the aggregator account was deleted, every draft still passed QA
  // and then failed at publish with a vendor subscription 401 — a message that
  // names neither the platform nor the cause, surfaced from a route that had
  // already passed auth. This turns that into a named, pre-publish blocker.
  //
  // Draft-level severity `fail` for the same reason target-skipped is: it must
  // block approval and autopilot rather than being something an operator can
  // scroll past.
  if (routablePlatforms) {
    for (const p of draft.targets) {
      if (routablePlatforms.has(p)) continue;
      const name = SPECS[p]?.displayName ?? p;
      issues.push({
        severity: "fail",
        platform: p,
        code: "no-route",
        message: `${name} has no way to publish: no direct connection, and no aggregator channel for it`,
        fix: `Connect ${name}, or remove it from this post's targets.`,
      });
    }
  }

  // A target the formatter dropped (almost always a requiresMedia/requiresVideo
  // platform on a text-only draft) produces no render, so every per-render check
  // below is blind to it. Without this the platform just silently disappears
  // from the previews with no explanation anywhere.
  const rendered = new Set(draft.renders.map((r) => r.platform));
  for (const p of draft.targets) {
    if (rendered.has(p)) continue;
    const s = SPECS[p];
    if (!s) continue;
    issues.push({
      severity: "fail",
      platform: p,
      code: "target-skipped",
      message: s.requiresVideo
        ? `${s.displayName} was skipped: it requires a video and none is attached`
        : s.requiresMedia
          ? `${s.displayName} was skipped: it requires an image or video and none is attached`
          : `${s.displayName} was skipped: the formatter produced no version for it`,
    });
  }

  // BRAND RULE, not a platform rule: the engine is a marketing surface, so every
  // post is an advertisement and carries a visual. Most platforms would happily
  // accept text, which is precisely why this cannot be expressed as a
  // `requiresMedia` spec flag: setting that on all nine would make the formatter's
  // eligibility filter drop EVERY platform from a text-only draft (and disable the
  // oversized-image auto-drop, whose remedy is publishing without the image).
  // A draft-level fail instead: it blocks approval and autopilot, and stamping
  // needsMedia lights the existing one-click card generator.
  if (media.length === 0) {
    issues.push({
      severity: "fail",
      code: "brand-media-missing",
      message:
        "no image or video is attached; every post is a marketing asset and must carry a visual",
    });
  }

  for (const r of draft.renders) {
    const s = SPECS[r.platform];
    const p = r.platform;
    const len = vendorLength(p, r.content);

    // Measure against the cap the FORMATTER trimmed to, which is the vendor's
    // whenever we have one (format.ts's `capFor` is effectiveMaxChars, for
    // exactly this reason). Reading SPECS[p].maxChars here instead put two
    // contradictory findings in ONE report on the X Premium account: the
    // formatter deliberately kept 1,200 characters because the live cap is
    // 25,000, this rule then failed it against the free-tier 280, and
    // channelRuleChecks below passed the same text. A "fail" nobody can act on
    // is worse than no check.
    //
    // Where a live cap exists, channelRuleChecks emits the finding (code
    // "vendor-length") so it is reported once and in the vendor's own terms.
    // Where it does not — no snapshot, or the vendor reports no maxLength for
    // this channel — the researched spec is still enforced here, so removing
    // the snapshot never silently removes the length gate.
    if (!hasLiveMaxLength(channelRules, p)) {
      for (const v of overLimitValues(r, effectiveMaxChars(channelRules, p, s.maxChars))) {
        issues.push({
          severity: "fail",
          platform: p,
          code: v.code,
          message: `${v.label} is ${v.len} chars (hard limit ${v.cap})`,
        });
      }
    }
    if (s.truncationPoint && len > s.truncationPoint) {
      const visible = r.content.slice(0, s.truncationPoint).split("\n")[0];
      issues.push({
        severity: "info",
        platform: p,
        code: "truncation",
        message: `feed shows ~${s.truncationPoint} chars before "see more"; hook = "${visible?.slice(0, 80)}..."`,
      });
    }

    const tagCount =
      countHashtags(r.content) + countHashtags(r.firstComment ?? "");
    if (s.maxHashtags && tagCount > s.maxHashtags) {
      issues.push({
        severity: "fail",
        platform: p,
        code: "hashtag-cap",
        message: `${tagCount} hashtags exceeds hard cap ${s.maxHashtags}`,
      });
    } else if (tagCount > s.idealHashtags[1]) {
      issues.push({
        severity: "warn",
        platform: p,
        code: "hashtag-heavy",
        message: `${tagCount} hashtags (ideal ${s.idealHashtags[0]}-${s.idealHashtags[1]} on ${s.displayName})`,
      });
    }
    if (p === "reddit" && tagCount > 0) {
      issues.push({
        severity: "fail",
        platform: p,
        code: "reddit-hashtags",
        message: "hashtags on Reddit read as spam — remove them all",
      });
    }

    if (s.titleRequired && !r.title) {
      issues.push({
        severity: "fail",
        platform: p,
        code: "title-missing",
        message: `${s.displayName} requires a title`,
      });
    }
    if (r.title && s.titleMaxChars && [...r.title].length > s.titleMaxChars) {
      issues.push({
        severity: "fail",
        platform: p,
        code: "title-over-limit",
        message: `title is ${[...r.title].length} chars (max ${s.titleMaxChars})`,
      });
    }
    // The upload swaps them (youtubeSafeText), so this is not a refusal; it is
    // flagged because each swap costs 2 more bytes of the description's cap.
    if (p === "youtube" && /[<>]/.test(`${r.title ?? ""}${r.content}`)) {
      issues.push({
        severity: "warn",
        platform: p,
        code: "youtube-angle-brackets",
        message: "YouTube refuses < and > in a title or description; they go out as \u2039 \u203A (3 bytes each)",
      });
    }

    const selected = r.mediaIndices.map((i) => media[i]).filter(Boolean);
    if (s.requiresVideo && !selected.some((m) => m!.type === "video")) {
      issues.push({
        severity: "fail",
        platform: p,
        code: "video-required",
        message: `${s.displayName} requires a video`,
      });
    } else if (s.requiresMedia && selected.length === 0) {
      issues.push({
        severity: "fail",
        platform: p,
        code: "media-required",
        message: `${s.displayName} requires media`,
      });
    } else if (media.length > 0 && selected.length === 0) {
      // The post HAS a visual but this platform is sending none. A warn, not a
      // fail, because two legitimate paths land here: the mechanical
      // oversized-image fix drops the asset from platforms that can publish
      // without it, and a text-only subreddit drops Reddit's image at publish.
      // Failing would strand drafts that are behaving exactly as designed.
      issues.push({
        severity: "warn",
        platform: p,
        code: "render-media-missing",
        message: `${s.displayName} is set to publish with no visual, though the post has one attached`,
      });
    }
    // A video selected for a platform whose transport cannot send one
    // (SPECS[p].publishesVideo). Bluesky's transport used to keep only the
    // images and post the rest text-only, so a video render went out with no
    // visual and nothing said why. media-pick.ts never routes a video here
    // itself; this catches a hand-written selection, and publish.ts refuses
    // the same leg before any network call.
    if (unpublishableVideoIndices(p, media, r.mediaIndices).length > 0) {
      issues.push({
        severity: "fail",
        platform: p,
        code: "video-unsupported",
        message: `${s.displayName} cannot publish video through this engine yet, and this version selects one`,
        fix: `Select an image for ${s.displayName} instead of the video, or drop ${s.displayName} from the targets.`,
      });
    }
    const imgs = selected.filter((m) => m!.type === "image" || m!.type === "gif");
    const vids = selected.filter((m) => m!.type === "video");
    /**
     * ⚠️ ASK THE TRANSPORT WHEN ONE IS ACTUALLY CARRYING THE POST.
     *
     * SPECS.maxImages is the PLATFORM's limit — Facebook 10, LinkedIn 20 — and
     * that is the right number to plan copy against. It is the wrong number to
     * gate a publish on, because what the leg can actually send is whatever the
     * CLIENT implements, and neither of those clients implements multi-image:
     * both cap at 1 (`MAX_IMAGES`, a client limit their own docblocks are
     * careful to distinguish from the vendor's).
     *
     * Checking SPECS therefore passed drafts the publish path could not honour,
     * and the two platforms then failed in opposite ways:
     *   - facebook-transport THROWS a named PublishPreflightError — loud, the
     *     leg fails alone, the operator is told exactly what to change.
     *   - linkedin-transport does `.slice(0, MAX_IMAGES)` — it publishes the
     *     first image and SILENTLY DROPS the rest. The post goes out on the
     *     company page missing content the operator chose, and nothing anywhere
     *     reports it.
     *
     * The silent one is why this is a gate rather than a note. Same shape as
     * the `image-too-large` fix above: ask the thing that will do the work.
     * Falls back to SPECS when the platform is not routed anywhere, which is the
     * conservative direction — an unrouted platform has no transport to ask.
     *
     * ⚠️ Reads `fittingRules`, so a platform routed to an AGGREGATOR is checked
     * against the aggregator's cap. Asking `registeredTransportFor` here would
     * have answered with OUR transport's number for a post the aggregator was
     * going to publish.
     */
    const transportImages = fittingRules.get(p)?.maxImages;
    const imageCap = transportImages ?? s.maxImages;
    if (imageCap && imgs.length > imageCap) {
      issues.push({
        severity: "fail",
        platform: p,
        code: "too-many-images",
        message:
          transportImages && s.maxImages && transportImages < s.maxImages
            ? `${imgs.length} images, but the direct ${s.displayName} transport publishes at most ${transportImages} per post (${s.displayName} itself allows ${s.maxImages}; multi-image was never built)`
            : `${imgs.length} images (max ${imageCap})`,
      });
    }
    // A generated card set is crops of ONE design; attaching several to a single
    // render publishes a carousel of near-duplicates (what a formatter that
    // attaches everything by default produces).
    // Within every platform's image cap, so too-many-images never catches it.
    if (imgs.length > 1 && isGeneratedCardSet(media)) {
      issues.push({
        severity: "fail",
        platform: p,
        code: "duplicate-media-attach",
        message: `${imgs.length} near-identical generated cards attached; a card set sends exactly one crop per platform`,
      });
    }
    if (!s.mixedMediaAllowed && imgs.length > 0 && vids.length > 0) {
      issues.push({
        severity: "fail",
        platform: p,
        code: "mixed-media",
        message: `${s.displayName} cannot mix images and video in one post`,
      });
    }
    /**
     * ⛔ THE TRANSPORT'S NUMBER FIRST, EXACTLY AS `too-many-images` ABOVE.
     *
     * When these two gates read only `SPECS[p]`, every `maxVideoSec`/`maxVideoBytes` a transport declared was inert:
     * media-fit.ts refuses to re-encode video at all, so `fitForTransport` — the
     * one other consumer of `channelRules()` — could never act on them either.
     * Several transports had already written that gap down as a comment
     * (youtube-transport.ts, x-transport.ts) and predicted nobody would close
     * it. A number that reads as enforced and is not is the failure mode this
     * whole area exists to prevent, so the routed transport is now asked first
     * and SPECS is the fallback for an unrouted platform.
     *
     * ⚠️ `fittingRules` and not a fresh lookup: it only holds a platform that is
     * genuinely routed, and an aggregator-routed platform therefore contributes
     * the AGGREGATOR's ceiling — the one the post will actually be measured
     * against. This is the same trap `image-too-large` paid for twice.
     */
    const transportVideoSec = fittingRules.get(p)?.maxVideoSec;
    const videoSecCap = transportVideoSec ?? s.maxVideoSec;
    if (videoSecCap) {
      for (const v of vids) {
        if (v!.durationSec && v!.durationSec > videoSecCap) {
          issues.push({
            severity: "fail",
            platform: p,
            code: "video-too-long",
            message:
              transportVideoSec && s.maxVideoSec && transportVideoSec < s.maxVideoSec
                ? `video is ${v!.durationSec}s, but the ${s.displayName} transport publishing this post accepts at most ${transportVideoSec}s (${s.displayName} itself allows ${s.maxVideoSec}s)`
                : `video is ${v!.durationSec}s (max ${videoSecCap}s)`,
          });
        }
      }
    }
    if (s.maxImageBytes) {
      /**
       * ⚠️ THE ONE PLACE THIS GATE IS ALLOWED TO SOFTEN, and only when
       * something downstream will genuinely fix the problem.
       *
       * An oversized image used to be a hard `fail`, which was right while the
       * publish path could do nothing about it. It is now wrong in one specific
       * case: a platform actually PUBLISHING DIRECT gets its media re-encoded
       * to that platform's own limits at publish time (media-fit.ts), so
       * failing here blocks a draft that would have published fine. Concretely,
       * a 5MB photo used to fail the Bluesky leg on a 1MB limit and stop the
       * whole draft, including the eight platforms that would have taken it
       * untouched.
       *
       * ⛔ REGISTERED IS THE WRONG QUESTION. Testing
       * `registeredTransportFor(p) !== null` asks "does a direct transport
       * exist for this platform", and an application may register all of them
       * at boot. But registration is not routing: `publishDraft` only calls
       * `fitForTransport` on the DIRECT branch, which a platform reaches solely
       * by being set to "direct" in `transportOverrides`. So for a platform on
       * the aggregator that question softens a hard failure to a warning and
       * tells the operator the image "will be re-encoded at publish time",
       * which nothing then does. Small generated cards mask it; a large
       * operator upload hits it.
       *
       * BOTH conditions are still required. A direct platform with no
       * re-encoder wired (the CLI) cannot fit anything, so the gate stays hard
       * there too.
       */
      /**
       * ⛔ THREE CONDITIONS, NOT TWO. Without the third the gate fails exactly
       * as the note above warns, one layer down.
       *
       * `media-fit.ts`'s `needsWork()` re-encodes only when the TRANSPORT's
       * own `channelRules().maxImageBytes` says the asset is too big. It does
       * NOT consult SPECS. So a platform that is routed direct, with a fitter
       * wired, but whose transport declares no `maxImageBytes`, satisfied both
       * old conditions and still re-encoded nothing — this gate downgraded
       * itself to a warning and told the operator the image "will be
       * re-encoded at publish time" while guaranteeing that it would not.
       *
       * Bluesky was that platform, with the tightest limit in the fleet
       * (2,000,000 bytes) and no declaration, and it went live the day it was
       * routed direct. Masked until then only because generated cards are
       * small; an operator upload (that route allows 100MB) hits it directly.
       *
       * ⚠️ NOW TWO CONDITIONS, AND THAT IS NOT A LOOSENING. `fittingRules` only
       * has an entry for a platform that is genuinely routed, and the limit is
       * read from that same entry — so "is it routed" and "does its transport
       * declare a limit" can no longer be answered from two sources that
       * disagree, which is how the third condition came to be missing in the
       * first place. Asking the route is the honest question: soften only if
       * the thing that would do the work knows the limit it is working to.
       */
      const fitterLimit = fittingRules.get(p)?.maxImageBytes;
      const willBeFitted = hasMediaFitter() && Boolean(fitterLimit);
      for (const m of imgs) {
        if (m!.size > s.maxImageBytes) {
          issues.push({
            severity: willBeFitted ? "warn" : "fail",
            platform: p,
            code: "image-too-large",
            message: willBeFitted
              ? `image ${m!.path.split("/").pop()} is ${(m!.size / 1048576).toFixed(1)}MB, over ${s.displayName}'s ${(s.maxImageBytes / 1048576).toFixed(0)}MB limit; it will be re-encoded at publish time`
              : `image ${m!.path.split("/").pop()} is ${(m!.size / 1048576).toFixed(1)}MB (max ${(s.maxImageBytes / 1048576).toFixed(0)}MB on ${s.displayName})`,
          });
        }
      }
    }
    // Same sourcing rule as `video-too-long` above; see its comment.
    //
    // ⚠️ Stays a hard `fail` whichever number wins, unlike `image-too-large`.
    // That gate softens to a warning only because something downstream will
    // genuinely fix the problem, and nothing will here: media-fit.ts's `canFit`
    // excludes video from re-encoding outright.
    const transportVideoBytes = fittingRules.get(p)?.maxVideoBytes;
    const videoByteCap = transportVideoBytes ?? s.maxVideoBytes;
    if (videoByteCap) {
      for (const v of vids) {
        if (v!.size > videoByteCap) {
          issues.push({
            severity: "fail",
            platform: p,
            code: "video-too-large",
            message:
              transportVideoBytes && s.maxVideoBytes && transportVideoBytes < s.maxVideoBytes
                ? `video ${v!.path.split("/").pop()} is ${(v!.size / 1048576).toFixed(0)}MB, but the ${s.displayName} transport publishing this post accepts at most ${(transportVideoBytes / 1048576).toFixed(0)}MB (${s.displayName} itself allows ${(s.maxVideoBytes / 1048576).toFixed(0)}MB)`
                : `video ${v!.path.split("/").pop()} is ${(v!.size / 1048576).toFixed(0)}MB (max ${(videoByteCap / 1048576).toFixed(0)}MB on ${s.displayName})`,
          });
        }
      }
    }

    const hasUrl = /https?:\/\//.test(r.content);
    if (hasUrl && !s.linksClickable) {
      issues.push({
        severity: "warn",
        platform: p,
        code: "dead-link",
        message:
          `links are not clickable on ${s.displayName}; ` +
          (s.linkAdvice ?? `consider "link in bio" phrasing`),
      });
    }
    if (hasUrl && s.linkPenalty) {
      issues.push({
        severity: "warn",
        platform: p,
        code: "link-penalty",
        message: `body link: ${s.linkPenalty}`,
        // Where no published placement escapes the penalty (LinkedIn), the
        // generic "move it to the first comment or a reply" sent the fix pass
        // to a field the transport never sends. Say what is true instead;
        // isTextFixable keeps this one away from the rewrite.
        ...(linkDestination(p)
          ? {}
          : {
              fix: `No published placement avoids this on ${s.displayName}: keep the link in the body if the click matters, or drop it for reach.`,
            }),
      });
    }
    // A first comment the transport never sends (LinkedIn, YouTube) is copy
    // nobody will read: a link moved there is silently lost. Reported, not
    // fixed, because what belongs in the body instead is the operator's call.
    if (r.firstComment && !SENDS_FIRST_COMMENT.has(p)) {
      issues.push({
        severity: "warn",
        platform: p,
        code: "first-comment-unpublished",
        message: `${s.displayName} does not publish a first comment, so this text never goes out`,
        fix: "Move anything that matters into the body, then clear the first comment.",
      });
    }
    // A vendor-enforced cap on the NUMBER of links, distinct from the reach
    // penalty above: Threads refuses a post outright past five (see
    // PlatformSpec.maxLinks). Counted on the body only, the field the vendor
    // counts; thread items and first comments are separate posts to it.
    if (s.maxLinks !== undefined) {
      const linkCount = (r.content.match(/https?:\/\//g) ?? []).length;
      if (linkCount > s.maxLinks) {
        issues.push({
          severity: "fail",
          platform: p,
          code: "too-many-links",
          message: `${linkCount} links in the body; ${s.displayName} refuses a post with more than ${s.maxLinks}`,
        });
      }
    }
    // Consult the SAME fallback publish.ts uses. Checking only r.subreddit
    // failed drafts that would in fact publish fine against a configured
    // default, and QA disagreeing with the publisher trains operators to
    // force past it.
    if (p === "reddit" && !normalizeSubreddit(r.subreddit ?? defaults().subreddit)) {
      issues.push({
        severity: "fail",
        platform: p,
        code: "subreddit-missing",
        message: "Reddit needs a target subreddit (set one on the draft, or a defaultSubreddit)",
      });
    }
    // Same contract as the subreddit gate above, and for the same reason: read
    // the default the publisher would fall back to, so QA and publish agree.
    if (p === "pinterest" && !(r.board?.id ?? defaults().pinterestBoard)) {
      issues.push({
        severity: "fail",
        platform: p,
        code: "board-missing",
        message:
          "Pinterest needs a destination board (set one on the draft, or a defaultPinterestBoard)",
      });
    }
    if (p === "pinterest") {
      issues.push(...pinterestMediaShape(r, selected));
    }

    // A nonzero follow-up delay is surfaced because its failure mode is silent:
    // the root reports success the moment it is live, and a delayed reply that
    // never lands is released later by publish-due with nobody watching. Only
    // the reply-chain transports (X, Bluesky, Threads) defer anything; a
    // Facebook or Instagram first comment goes out with the post regardless.
    if (r.followupDelayMinutes && r.followupDelayMinutes > 0) {
      const deferred = SPECS[p].supportsThreads ? sentContents(r).length - 1 : 0;
      if (deferred > 0) {
        issues.push({
          severity: "info",
          platform: p,
          code: "followup-delay",
          message: `the follow-up posts ${r.followupDelayMinutes} min after the root; the vendor reports no failure for delayed values, so confirm it landed`,
        });
      } else {
        issues.push({
          severity: "warn",
          platform: p,
          code: "followup-delay-unused",
          message: `a ${r.followupDelayMinutes} min follow-up delay is set but this render sends only one value, so nothing will use it`,
        });
      }
    }

    // Every value the platform publishes (thread replies included, which the
    // mechanical fix already strips), plus the title.
    for (const field of [...sentContents(r), r.title ?? ""]) {
      if (field.includes("—")) {
        issues.push({
          severity: "warn",
          platform: p,
          code: "brand-em-dash",
          message: "contains an em-dash (brand rule: restructure with commas/periods)",
        });
        break;
      }
    }

    // Model scaffolding that would reach a live feed: a post opening "Hey r/SaaS
    // (or similar relevant sub), ...", placeholder text addressed to the wrong
    // community, which an LLM review can wave through. Deterministic because prompts are
    // requests; publishing gates are guarantees.
    const sentText = [r.content, r.title ?? "", r.firstComment ?? "", ...(r.threadItems ?? [])].join(
      "\n",
    );
    if (detectPlaceholderText(sentText)) {
      issues.push({
        severity: "fail",
        platform: p,
        code: "placeholder-text",
        message:
          "contains placeholder/scaffold text (e.g. \"(or similar ...)\", \"[insert ...]\") that must not publish",
      });
    }
    // The brand brief's section headings are internal labels, and a model that
    // quotes one into public copy leaks it (#238). Each value is checked on its
    // own, so a match can never span two values.
    for (const field of [r.content, r.title ?? "", r.firstComment ?? "", ...(r.threadItems ?? [])]) {
      const quoted = findQuotedBriefHeading(field, headingPhrases);
      if (quoted) {
        issues.push({
          severity: "fail",
          platform: p,
          code: "brief-heading-quoted",
          message: `quotes the brand brief's internal section heading "${quoted}", which must not publish`,
        });
        break;
      }
    }
    if (p === "reddit") {
      const target = normalizeSubreddit(r.subreddit ?? defaults().subreddit);
      const greeted = /^\s*(?:hey|hi|hello)[ ,]+r\/([A-Za-z0-9_]+)/i.exec(r.content)?.[1];
      if (target && greeted && greeted.toLowerCase() !== target.toLowerCase()) {
        issues.push({
          severity: "fail",
          platform: p,
          code: "reddit-wrong-subreddit",
          message: `the copy greets r/${greeted} but this post targets r/${target}`,
        });
      }
    }
  }

  /**
   * ⚠️ `warn`, not `info`.
   *
   * At `info` it is advisory only and nothing surfaces it, and an audit
   * found alt text reached barely half the platforms that accept it: Threads,
   * Facebook and X sent NONE at all, and Pinterest reused one description for a
   * whole carousel. Threads is fixed and Instagram/Bluesky/LinkedIn already
   * carried it, so the copy was almost always there; it was being dropped in
   * transit rather than never written.
   *
   * Deliberately not `fail`. A missing alt should not block a publish — the
   * post is still better out than held — but it should be visible enough that
   * an operator notices before it ships, which `info` never was.
   */
  for (const [i, m] of media.entries()) {
    if (m.type === "image" && !m.altText) {
      issues.push({
        severity: "warn",
        code: "alt-missing",
        message: `media [${i}] has no alt text (accessibility)`,
      });
    }
  }

  // Deterministic compliance/legal gates. These run here (not in the LLM pass)
  // precisely because the model would wave through a fabricated testimonial or
  // an unbacked legal claim, so they must fire even when skipLlm is set.
  issues.push(...complianceChecks(draft, brand));

  // Validate against the VENDOR's live schema, when we have a cached snapshot.
  issues.push(...channelRuleChecks(draft, channelRules));

  // Attach a concrete recommended fix to each mechanical issue.
  for (const issue of issues) {
    if (!issue.fix) issue.fix = recommendedFix(issue.code);
  }

  return issues;
}

/**
 * Deterministic, code-only compliance gates for social copy.
 *
 * The LLM QA pass (llmReview) is a self-review by the same class of model that
 * drafts the copy, and it will happily pass a fabricated customer testimonial or
 * an absolute legal claim. A model has no way to know a quoted customer exists,
 * so ANY quoted customer praise in generated copy hard-fails: a real, consented
 * quote goes in by hand after review. Canadian law (CASL, Competition Bureau)
 * and platform review rules supply the remaining red lines. A brand pack may
 * reword a gate's message and fix (`gateCopy`) but not what it detects.
 *
 * All gates are pure string/regex over the source AND every per-platform render,
 * and run inside deterministicChecks so they fire even when the LLM pass is
 * skipped. Keyword matching is case-insensitive. A few structural patterns use a
 * capital-letter name heuristic (to tell an attributed testimonial apart from an
 * ordinary quoted phrase); those only ADD coverage on top of the case-insensitive
 * keyword rules, they never gate on their own.
 */
interface TextSurface {
  platform?: Platform;
  text: string;
}

/** Every text surface a compliance gate must inspect: the source, then each render. */
function complianceSurfaces(draft: Draft): TextSurface[] {
  const surfaces: TextSurface[] = [];
  const src = [draft.source.text, draft.source.title]
    .filter((s): s is string => !!s && s.trim().length > 0)
    .join("\n");
  if (src.trim()) surfaces.push({ text: src });
  for (const r of draft.renders) {
    const parts = [r.content, r.title, r.firstComment, ...(r.threadItems ?? [])].filter(
      (s): s is string => !!s && s.trim().length > 0,
    );
    if (parts.length) surfaces.push({ platform: r.platform, text: parts.join("\n") });
  }
  return surfaces;
}

// --- Gate 1: fabricated-testimonial ---------------------------------------
function detectFabricatedTestimonial(text: string): boolean {
  // A quote attributed via a dash to a named role: `"..." - Sarah, dental office manager`.
  const quoteDashRole =
    /["“][^"”]{4,}["”]\s*[-–—]\s*[a-z][\w.'-]*(\s+[\w.'-]+){0,3}\s*,\s*[\w\s-]*\b(dental|dentist|office|clinic|practice|salon|spa|restaurant|hotel|manager|owner|founder|director|ceo|receptionist|doctor|nurse|admin(istrator)?|coordinator|customer|client|patient|realtor|business|entrepreneur|shop)\b/i;
  // A quote attributed via a dash to a capitalised name + comma: `"..." - Sarah, ...`.
  // Case-sensitive on the leading capital ON PURPOSE, to separate a real name
  // attribution from an ordinary dashed clause after a quote. This only adds
  // coverage; the role-based rule above stays case-insensitive.
  const quoteDashName = /["“][^"”]{4,}["”]\s*[-–—]\s*[A-Z][\w.'-]+(\s+[A-Z][\w.'-]+)?\s*,/;
  // Explicit "our customers say / one client told us / a customer of ours" attributions.
  const customerAttribution =
    /\b(our\s+(customers?|clients?|users?)\s+(say|says|tell\s+us|told\s+us|love|rave|report)|one\s+(customer|client|user)\s+(told\s+us|said|says)|a\s+(customer|client|user)\s+of\s+ours|(customers?|clients?)\s+(say|tell\s+us|told\s+us|rave))\b/i;
  // Star ratings: "5 stars", "5-star", "rated 4.9", "4.9/5".
  const starRating = /\b\d(\.\d)?\s*[-\s]?stars?\b|\brated\s+\d(\.\d)?\b|\b\d(\.\d)?\s*\/\s*5\b/i;
  // Review-site claims: "on G2", "Trustpilot reviews say", "our Capterra rating".
  const reviewSite =
    /\b(on|from|our|read\s+our)\s+(g2|trustpilot|capterra|clutch|yelp|google\s+reviews)\b|\b(g2|trustpilot|capterra|clutch|yelp)\s+(reviews?|rating)\b|\breviews?\s+(say|said|rave)\b/i;
  return (
    quoteDashRole.test(text) ||
    quoteDashName.test(text) ||
    customerAttribution.test(text) ||
    starRating.test(text) ||
    reviewSite.test(text)
  );
}

// --- Gate 2: compliance-language ------------------------------------------
function detectComplianceLanguage(text: string): boolean {
  // "<statute> compliant/certified". Deliberately does NOT match the approved
  // "PIPEDA-aligned" / "PHIPA-ready" / "built for PIPEDA" phrasings, which never
  // put "compliant"/"certified" right after the statute.
  const certifiedClaim =
    /\b(PIPEDA|PHIPA|HIPAA|GDPR|CCPA|SOC\s?2|PCI[\s-]?DSS)[\s-]+(compliant|certified)\b/i;
  const neverLeavesCanada =
    /\bdata\s+(never|doesn['’]t|does\s+not|will\s+never|won['’]t)\s+leaves?\s+(canada|the\s+country)\b/i;
  const fullyCompliantWith =
    /\bfully\s+compliant\s+with\b[\s\S]{0,40}?\b(PIPEDA|PHIPA|HIPAA|GDPR|CCPA|privacy|Law\s?25|Bill\s?64)\b/i;
  return certifiedClaim.test(text) || neverLeavesCanada.test(text) || fullyCompliantWith.test(text);
}

// --- Gate 3: earnings-claims ----------------------------------------------
function detectEarningsClaims(text: string): boolean {
  // Any form of the word "guarantee" is a Competition Bureau red line here.
  const guarantee = /\bguarantee(d|s|ing)?\b/i;
  // Quantified outcome promise: "will double your bookings", "guaranteed to triple sales".
  const quantifiedPromise =
    /\b(will|guaranteed\s+to|promise[sd]?\s+to|guarantee\s+to)\s+(double|triple|quadruple|\d+\s?x|\d+\s?%)\s+(your\s+)?(booking|revenue|sale|call|customer|client|lead|appointment|conversion)s?\b/i;
  // Currency promise: "adds $500 to your revenue".
  const revenuePromise =
    /\badd(s|ed|ing)?\b[\s\S]{0,15}?\$\s?\d[\d,]*(\.\d+)?\s?(k|m)?\b[\s\S]{0,20}?\b(to|in|per)\b[\s\S]{0,15}?\b(revenue|sales|bookings?|bottom\s+line|month)\b/i;
  // "promise" + a number.
  const promiseNumber = /\bpromise[sd]?\b[\s\S]{0,25}?(\$\s?\d|\d+\s?%|\bdouble\b|\btriple\b)/i;
  return (
    guarantee.test(text) ||
    quantifiedPromise.test(text) ||
    revenuePromise.test(text) ||
    promiseNumber.test(text)
  );
}

// --- Gate 4: incentivized-review ------------------------------------------
function detectIncentivizedReview(text: string): boolean {
  // "leave a review and get ...", "write a review to earn ...".
  const reviewForReward =
    /\b(leave|write|post|give|drop)\b[\s\S]{0,15}?\breview\b[\s\S]{0,25}?\b(and|to)\b[\s\S]{0,15}?\b(get|receive|earn|win|claim|enjoy|score|free|a\s+chance)\b/i;
  // "free month for a review", "discount for leaving a review".
  const rewardForReview =
    /\b(free|discount|\d+%\s*off|%\s*off|gift|entry|coupon|credit|month\s+free|free\s+month|bonus|reward)\b[\s\S]{0,25}?\bfor\b[\s\S]{0,15}?\breview\b/i;
  // "review us for a chance ...".
  const reviewForChance = /\breview\b[\s\S]{0,15}?\bfor\b[\s\S]{0,10}?\b(a|your|the)?\s*chance\b/i;
  return reviewForReward.test(text) || rewardForReview.test(text) || reviewForChance.test(text);
}

// --- Gate 5: unverified-superlatives (warn) -------------------------------
const SUPERLATIVE_RE =
  /\b(the\s+best|#\s?1|number\s+one|cheapest|lowest[\s-]?(price|cost)|most\s+affordable|best[\s-]?in[\s-]?class|unbeatable|world['’]?s\s+best)\b/gi;
const SUPERLATIVE_QUALIFIER = /\b(verified|per[\s-]?minute|according\s+to|based\s+on|independently|benchmark)\b/i;
const SUPERLATIVE_MARKET = /\bin\s+the\s+[\w\s'-]{1,40}?market\b/i;
function detectUnverifiedSuperlative(text: string): boolean {
  const re = new RegExp(SUPERLATIVE_RE.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const start = Math.max(0, m.index - 60);
    const end = Math.min(text.length, m.index + m[0].length + 60);
    const window = text.slice(start, end);
    // A verified/per-minute/comparison-anchored superlative carries its own
    // substantiation, so skip it.
    if (SUPERLATIVE_QUALIFIER.test(window) || SUPERLATIVE_MARKET.test(window)) continue;
    return true;
  }
  return false;
}

// --- Gate 6 RETIRED: french-quebec (warn) ---------------------------------
//
// ⛔ A gate that only answered "does this text mention Quebec" was removed: its
// premise (no French-language site to point at) stops holding once the brand
// has one, and a gate that keeps warning after its premise is false trains the
// operator to dismiss the compliance panel, where the FAIL-tier gates live. No
// gate emits the code "french-quebec" any more, and `QAIssue.code` is a plain
// string, so an old stored report still reads. What it never checked still
// applies: French-language marketing to Quebec must BE in French and at least
// as prominent as the English (Bill 96).

// --- Gates 7 and 8 MOVED: positioning-terms and recordings-claim -----------
//
// Both are one brand's claim rules (which words its copy holds back, and that
// it makes no call recordings), so they left the engine with the brand brief
// (district-social P2). They arrive as data, in a brand pack's `qaGates`, and
// complianceChecks runs them after the gates below, so a pack that brings the
// same two gates gets the same issues in the same order.

const COMPLIANCE_GATES: readonly QaGate[] = [
  {
    code: "fabricated-testimonial",
    severity: "fail",
    message:
      "Quoted customer testimonial, star rating, or review-site claim detected. Generated copy cannot cite a real customer review, so attributed customer praise is treated as fabricated and cannot ship.",
    fix: "Remove the quoted testimonial, star rating, or review-site reference, or replace it by hand with a real, consented quote.",
    detect: detectFabricatedTestimonial,
  },
  {
    code: "compliance-language",
    severity: "fail",
    message:
      "Absolute regulatory claim detected (for example 'PIPEDA compliant', 'HIPAA compliant', 'data never leaves Canada'). Use approved phrasing such as 'built for PIPEDA', 'PIPEDA-aligned', or 'PHIPA-ready'.",
    fix: "Replace the absolute claim with approved phrasing: 'built for PIPEDA', 'PIPEDA-aligned', or 'PHIPA-ready'.",
    detect: detectComplianceLanguage,
  },
  {
    code: "earnings-claims",
    severity: "fail",
    message:
      "Guaranteed-outcome or specific revenue/booking promise detected. Guarantees and quantified income promises are not substantiated (Competition Bureau red line).",
    fix: "Drop the guarantee or dollar/booking figure. Keep outcomes aspirational (for example 'so you never miss a call').",
    detect: detectEarningsClaims,
  },
  {
    code: "incentivized-review",
    severity: "fail",
    message:
      "Review incentive without disclosure detected (offering something in exchange for a review). This breaks platform review policies and Competition Bureau rules.",
    fix: "Remove the incentive. Ask for feedback without offering anything in return.",
    detect: detectIncentivizedReview,
  },
  {
    code: "unverified-superlatives",
    severity: "warn",
    message:
      "Unsubstantiated superlative ('best', '#1', 'cheapest') without a verified or comparison qualifier.",
    fix: "Add a verified qualifier or comparison anchor (for example 'verified cheapest per-minute rate'), or soften the claim.",
    detect: detectUnverifiedSuperlative,
  },
  // ⚠️ No `french-quebec` gate: see the retired Gate 6 block above.
];

/**
 * Run every deterministic compliance gate over the source and each render:
 * the engine's own, then the brand's (`brand.qaGates()`).
 *
 * One issue per gate per draft: a gate either fails the whole draft or it does
 * not, and duplicating one identical fail across the source plus seven renders
 * would bury the report. Surfaces are scanned source-first, so a violation the
 * operator wrote is reported globally, while a violation that survives only in a
 * single render is still caught and attributed to that platform.
 */
export function complianceChecks(draft: Draft, brand: BrandContext = NO_BRAND): QAIssue[] {
  const surfaces = complianceSurfaces(draft);
  const issues: QAIssue[] = [];
  for (const gate of [...COMPLIANCE_GATES, ...brand.qaGates()]) {
    const hit = surfaces.find((s) => gate.detect(s.text));
    if (!hit) continue;
    const term = gate.found?.(hit.text);
    // The brand's wording for an engine gate; a brand gate already carries its own.
    const copy = brand.gateCopy(gate.code) ?? gate;
    issues.push({
      severity: gate.severity,
      platform: hit.platform,
      code: gate.code,
      message: term ? `${copy.message} Found: "${term}".` : copy.message,
      fix: copy.fix,
    });
  }
  return issues;
}

/**
 * Validate each render against the platform's OWN live schema, as cached by the
 * nightly channel-rules refresh.
 *
 * Everything above encodes what we believe the platforms require; this encodes
 * what they actually enforce. It is what turns a class of failure that used to
 * surface as an opaque 400 at publish time into a blocking QA issue the operator
 * sees while editing. Reddit is the worked example: an unset subreddit or an
 * invalid post `type` is caught here rather than by the vendor.
 *
 * No snapshot (never refreshed, or the refresh is failing) means no checks. This
 * is an enhancement layer and must not block publishing when it is unavailable.
 */
export function channelRuleChecks(
  draft: Draft,
  snapshot: ChannelRulesSnapshot | null,
): QAIssue[] {
  if (!snapshot) return [];
  const issues: QAIssue[] = [];

  for (const r of draft.renders) {
    const rules = snapshot.channels[r.platform];
    if (!rules) continue;

    // The vendor's cap beats our researched one when they disagree.
    if (typeof rules.maxLength === "number" && rules.maxLength > 0) {
      for (const v of overLimitValues(r, rules.maxLength)) {
        issues.push({
          severity: "fail",
          platform: r.platform,
          code: "vendor-length",
          message: `${v.label} is ${v.len} chars, over ${r.platform}'s live limit of ${v.cap}`,
          fix: `Trim to ${v.cap} characters.`,
          fixable: true,
        });
      }
    }

    // ⛔ The `vendor-schema` check is GONE, not disabled. It validated the
    // per-platform `settings` object against a JSON Schema the aggregator
    // served, and neither the object nor the schema exists any more — a direct
    // transport takes a `PublishDestination`. Validating a payload nobody sends
    // is worse than not validating: it reads like a gate and enforces nothing.
    //
    // What it was actually catching (a Reddit post with no subreddit, a pin
    // with no board) is caught by `assertPublishable`, which is the publish
    // path's own refusal rather than a second model of it. Called here so a
    // draft is refused at review time rather than at publish time.
    try {
      assertPublishable(r, draft);
    } catch (err) {
      issues.push({
        severity: "fail",
        platform: r.platform,
        code: "destination-invalid",
        message: err instanceof Error ? err.message : `${r.platform} cannot be published as configured`,
        fix: `Fix the ${r.platform} destination settings before publishing.`,
      });
    }
  }

  return issues;
}

/** Recommended one-line action for a mechanical (deterministic) QA issue code. */
function recommendedFix(code: string): string | undefined {
  switch (code) {
    case "over-limit":
      return "Trim the copy to fit the hard character limit.";
    case "hashtag-cap":
    case "hashtag-heavy":
      return "Cut the hashtags down to the recommended count.";
    case "reddit-hashtags":
      return "Remove every hashtag (Reddit reads them as spam).";
    case "title-missing":
      return "Add a title for this platform.";
    case "title-over-limit":
      return "Shorten the title to fit the limit.";
    case "youtube-angle-brackets":
      return "Reword without < and >, or accept the swap to \u2039 \u203A.";
    case "dead-link":
      return "Drop the raw URL from the body and say 'link in bio' instead.";
    case "duplicate-media-attach":
      return "Attach only the best-fitting crop of the generated card set.";
    case "link-penalty":
      return "Move the link out of the body (into the first comment or a reply).";
    case "too-many-links":
      return "Keep one canonical link in the body and move the rest to a reply.";
    case "thread-item-over-limit":
      return "Split or trim the thread item to fit its limit.";
    case "first-comment-over-limit":
      return "Trim the first comment to fit the channel's limit.";
    case "brand-em-dash":
      return "Replace em-dashes with commas, periods, or parentheses.";
    case "placeholder-text":
      return "Replace the placeholder with real copy, or delete it.";
    case "brief-heading-quoted":
      return "Reword without the brief's section heading; say what shipped in plain words.";
    case "reddit-wrong-subreddit":
      return "Address the target subreddit, or drop the greeting entirely.";
    case "truncation":
      return "Front-load the hook so it lands before the feed cutoff.";
    case "subreddit-missing":
      return "Set a target subreddit for this post.";
    case "board-missing":
      return "Pick a destination Pinterest board for this pin.";
    // No pinterest-media-shape / no-pinterest-boards / board-unknown cases: every
    // emitter of those codes sets its own `fix`, so they never reach this lookup.
    case "alt-missing":
      return "Add alt text to the image.";
    case "target-skipped":
      return "Attach media for this platform, or drop it from the targets.";
    case "media-required":
      return "Attach an image or video for this platform.";
    case "brand-media-missing":
      return "Generate or attach an image; every post needs a visual.";
    case "render-media-missing":
      return "Attach one of the post's images to this platform's version.";
    case "video-required":
      return "Attach a video for this platform.";
    case "too-many-images":
      return "Reduce the number of images to the platform maximum.";
    case "mixed-media":
      return "Use only images or only video, not both.";
    case "video-too-long":
      return "Use a shorter video.";
    case "image-too-large":
      return "Use a smaller image file.";
    case "video-too-large":
      return "Use a smaller video file.";
    default:
      return undefined;
  }
}

/**
 * The CLOSED set of categories the LLM reviewer may report, and the severity
 * each one carries.
 *
 * ⚠️ SEVERITY IS ASSIGNED HERE, NOT BY THE MODEL. It used to come straight from
 * the model's own `severity` field while `code` was whatever kebab-slug it
 * invented that run, and a batch of drafts showed exactly what that produced:
 * one defect arriving under five different names (`llm-missing-emoji`,
 * `llm-missing-emojis`, `llm-instagram-missing-emoji`,
 * `llm-instagram-missing-emojis`, `llm-missing-emojis-instagram`) and, worse,
 * the SAME name carrying different severities on different drafts
 * (`llm-twitter-body-link` was `warn` on four and `fail` on one;
 * `llm-instagram-bare-url` `warn` on three and `fail` on one).
 *
 * `pass` is computed from severity and gates publishing, so that made whether a
 * draft could publish depend on how the model happened to phrase itself. Same
 * copy, same rules, different verdict. Pinning severity to the category makes
 * the gate reproducible; the model now only classifies.
 *
 * Severity split follows the prompt's own rule — block only on things that must
 * not go out. Link PLACEMENT is reach optimisation, so it warns (the mechanical
 * `link-penalty` already covers it at the same level). Grammar blocks: a
 * published post opening "Whether it is morning in Toronto or late evening in
 * Tokyo." is the failure this catches, and it goes out under a model-assigned
 * pass.
 */
const LLM_ISSUE_SEVERITY = {
  // Must not publish.
  "factual-drift": "fail",
  "unbacked-claim": "fail",
  "broken-link": "fail",
  "wrong-link": "fail",
  grammar: "fail",
  "off-brand": "fail",
  // Worth surfacing, not worth blocking.
  "link-placement": "warn",
  "platform-norm": "warn",
  "weak-hook": "warn",
  "missing-cta": "warn",
  "hashtag-quality": "warn",
  "tone-mismatch": "warn",
  formatting: "warn",
  "media-mismatch": "warn",
  // Cosmetic.
  "emoji-usage": "info",
  "style-nit": "info",
} as const satisfies Record<string, QASeverity>;

/** The categories offered to the model, in the prompt, as its only choices. */
const LLM_ISSUE_CODES = Object.keys(LLM_ISSUE_SEVERITY);

/**
 * Issue codes that a text-only reformat cannot resolve (they need media or
 * targeting changes the operator must make by hand). Used to decide what the
 * "fix with AI" action can actually address.
 */
const NON_TEXT_FIX_CODES = new Set([
  "target-skipped",
  // Nothing about the copy makes a disconnected platform reachable. Letting the
  // fix loop try would burn a Vertex cycle per attempt and, worse, count against
  // the draft's attempt budget on its way to quarantine for the wrong reason.
  "no-route",
  "media-required",
  "video-required",
  // Which asset a platform sends is a media selection, not copy.
  "video-unsupported",
  // Attaching a visual is not something rewriting the copy can achieve.
  "brand-media-missing",
  "render-media-missing",
  // Publish-timing settings, not copy.
  "followup-delay",
  "followup-delay-unused",
  "too-many-images",
  "mixed-media",
  "video-too-long",
  "image-too-large",
  "video-too-large",
  "alt-missing",
  "subreddit-missing",
  // Pinterest targeting and media shape are operator decisions (which board,
  // which assets), so no amount of rewriting the description resolves them.
  "board-missing",
  "board-unknown",
  "no-pinterest-boards",
  "pinterest-media-shape",
  "llm-qa-unavailable",
  // Whether the text belongs in the body is the operator's call, and the
  // rewrite cannot set a first comment on a platform that never sends one.
  "first-comment-unpublished",
  // A refused destination is a settings problem (missing subreddit, missing
  // board, a sub that will not take this post), not a copy problem. Rewriting
  // the text cannot resolve it and would only burn a fix cycle.
  "destination-invalid",
  // Compliance/legal gates are human-owned: an AI rewrite could soften a
  // fabricated testimonial or an unbacked legal claim while leaving it just as
  // fabricated (and passing QA), so these never go to the auto-fix formatter.
  "fabricated-testimonial",
  "compliance-language",
  "earnings-claims",
  "incentivized-review",
  "unverified-superlatives",
  // No "french-quebec": a code no gate can emit has no place in this set.
]);

/**
 * Whether the AI fix pass can resolve an issue by rewriting copy.
 *
 * Severity deliberately does NOT gate this. Several genuinely actionable
 * mechanical issues are info-tier (notably `truncation`, "your hook falls past
 * the feed cutoff"), and excluding them meant the fix button vanished on a
 * passing draft while the panel still listed a bolded "Fix:" for each one. What
 * actually matters is whether a rewrite can address it, plus having concrete
 * direction to give the formatter.
 *
 * An issue a brand gate raised (`brand.qaGates()`) is human-owned, like the
 * engine's own compliance gates, and for a sharper reason: a rewrite asked to
 * lose a held word tends to paraphrase it, which keeps the claim and loses the
 * word the gate can see.
 */
export function isTextFixable(issue: QAIssue, brand: BrandContext = NO_BRAND): boolean {
  return (
    !NON_TEXT_FIX_CODES.has(issue.code) &&
    !brand.qaGates().some((gate) => gate.code === issue.code) &&
    !!issue.fix &&
    !linkStuckInBody(issue)
  );
}

/**
 * A `link-penalty` on a platform with nowhere published to move the link
 * (specs.ts linkDestination; LinkedIn). Neither fix path may claim it: the
 * mechanical pass leaves the link in the body on purpose, and a rewrite told to
 * move it out could only put it in a first comment that is never sent.
 */
function linkStuckInBody(issue: QAIssue): boolean {
  return issue.code === "link-penalty" && issue.platform !== undefined && !linkDestination(issue.platform);
}

/**
 * QA codes the fix pass resolves deterministically, in code, with no model call
 * (link placement, hashtag caps, em-dashes, media-count and file-size limits).
 * Lives here (not in revise.ts) so runQa can consult it without an import cycle;
 * applyMechanicalFixes is the implementation.
 */
export const MECHANICAL_FIX_CODES = new Set([
  "brand-em-dash",
  "link-penalty",
  "dead-link",
  "reddit-hashtags",
  "hashtag-cap",
  "hashtag-heavy",
  "too-many-images",
  "duplicate-media-attach",
  "mixed-media",
  "image-too-large",
  "video-too-large",
]);

/**
 * Whether the fix pass can resolve an issue mechanically (as opposed to by a
 * rewrite). Most mechanical codes always can; the file-size codes are special,
 * because the only automatic remedy is to DROP the offending asset, which is
 * valid only where the platform can still publish without media. On a platform
 * that requires media (Instagram, YouTube) an oversized file has no automatic
 * fix, so it must stay a blocker rather than pretend to be fixable.
 */
export function isMechanicallyFixable(issue: QAIssue): boolean {
  if (!MECHANICAL_FIX_CODES.has(issue.code) || linkStuckInBody(issue)) return false;
  if (issue.code === "image-too-large" || issue.code === "video-too-large") {
    const s = issue.platform ? SPECS[issue.platform] : undefined;
    return !!s && !s.requiresMedia;
  }
  return true;
}

/**
 * What kind of media would resolve this issue, or null when media is not the
 * remedy. `target-skipped` is only a media problem when the dropped platform
 * actually requires media; it also fires when the formatter simply produced no
 * version, and offering "Add image" there would be a dead end.
 */
export function mediaFixKind(issue: QAIssue): "image" | "video" | null {
  if (issue.code === "video-required") return "video";
  if (issue.code === "media-required") return "image";
  // Both brand-media codes are resolved by attaching a visual, which is what
  // lights the composer's one-click card generator.
  if (issue.code === "brand-media-missing" || issue.code === "render-media-missing") {
    return "image";
  }
  if (issue.code !== "target-skipped" || !issue.platform) return null;
  const s = SPECS[issue.platform];
  if (!s) return null;
  if (s.requiresVideo) return "video";
  if (s.requiresMedia) return "image";
  return null;
}

/**
 * Rank a QA report so a repair loop can tell better from worse and refuse to
 * keep a regression. A single blocker outweighs any number of warnings, and a
 * warning outweighs any number of style notes, which matches what actually
 * gates publishing.
 */
/**
 * Comparison weight for one issue. The tiers are orders of magnitude apart so a
 * fail can never be outweighed by any number of warns, nor a warn by infos.
 * Exported so the fix loop scores platforms on the same scale as whole reports.
 */
export function issueWeight(severity: QASeverity): number {
  return severity === "fail" ? 1_000_000 : severity === "warn" ? 1_000 : 1;
}

export function qaScore(report: QAReport): number {
  let score = 0;
  for (const i of report.issues) {
    score += issueWeight(i.severity);
  }
  return score;
}

/** The LLM reviewer's categories, as the closed type its schema enforces. */
type LlmIssueCode = keyof typeof LLM_ISSUE_SEVERITY;

/** What `platform` holds for a draft-wide finding (the schema has no optional). */
const GLOBAL_PLATFORM = "global";

interface LlmQaOutput {
  issues: Array<{
    code: LlmIssueCode;
    platform: Platform | typeof GLOBAL_PLATFORM;
    message: string;
    fix: string;
  }>;
  summary: string;
}

/**
 * The reviewer's reply, as structured output. `code` and `platform` are closed
 * enums, so the decoder can only produce a category LLM_ISSUE_SEVERITY prices.
 * There is deliberately NO severity field: severity is ours (see
 * LLM_ISSUE_SEVERITY), and a field the model fills would only invite it back.
 */
const LLM_QA_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          code: { type: "string", enum: LLM_ISSUE_CODES },
          platform: { type: "string", enum: [...ALL_PLATFORMS, GLOBAL_PLATFORM] },
          message: { type: "string" },
          fix: { type: "string" },
        },
        required: ["code", "platform", "message", "fix"],
        additionalProperties: false,
      },
    },
    summary: { type: "string" },
  },
  required: ["issues", "summary"],
  additionalProperties: false,
};

/**
 * The brand's own tracked short link, the way the reviewer is told about it.
 *
 * ⛔ THE RENDERER, NOT THE WRITER, PUTS IT THERE. An application that tracks
 * clicks swaps the source link in every render for that platform's
 * `<brand host>/l/<code>`, a first-party redirect to the same destination with
 * UTM parameters. A reviewer comparing renders with `source.link` sees two
 * different URLs and calls it a wrong link (`llm-wrong-link`, a FAIL), which
 * blocks a true post. The brand pack's `linkDomains` name the hosts; with none,
 * the prompt says nothing and no finding is screened.
 */
function trackedLinkGuidance(brand: Pick<BrandContext, "linkDomains">): string {
  const [domain] = brand.linkDomains();
  if (!domain) return "";
  return `Tracked links: the publisher replaces the source link in each render with that platform's own tracked short link, a URL on our domain whose path is /l/ and a short code (for example https://www.${domain}/l/Ab3xK9q). It redirects to the source link with UTM parameters. A render that carries such a link where the source has its link is correct: never report it as a wrong, broken or mismatched link.`;
}

/** A tracked short link on one of the brand's domains: `<host>/l/<code>`, scheme optional. */
function trackedLinkRe(domains: readonly string[]): RegExp {
  const hosts = domains.map((d) => d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return new RegExp(`(?:https?:\\/\\/)?(?:[a-z0-9-]+\\.)*(?:${hosts})\\/l\\/[A-Za-z0-9]+`, "gi");
}

/** Any URL-shaped token: a scheme, or a dotted host, with an optional path. */
const URL_TOKEN_RE = /(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s"'`<>()]*)?/gi;

/** Scheme, `www.`, trailing slash and sentence punctuation off, lower case. */
function normalizeUrl(url: string): string {
  return trimTrailing(url, ".,;:!?")
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

/** Every text a draft's renders publish. */
function renderTexts(draft: Draft): string {
  return draft.renders
    .flatMap((r) => [r.content, r.firstComment ?? "", ...(r.threadItems ?? [])])
    .join("\n");
}

/**
 * Whether an `llm-wrong-link` finding is the tracked-link false positive: it
 * names at least one tracked link the draft's renders really carry, and every
 * other URL in it is the draft's own source link. Exported for the test.
 *
 * Deliberately narrow. Only `wrong-link` ("points somewhere unintended") is
 * screened; `broken-link` (malformed, a swallowed trailing period) stays a
 * finding even on a tracked link, and a wrong-link finding that names any third
 * URL is kept, since that one may be a real wrong destination.
 */
export function isTrackedLinkFalsePositive(
  issue: { code: string; message: string; fix: string },
  draft: Draft,
  brand: Pick<BrandContext, "linkDomains"> = NO_BRAND,
): boolean {
  const domains = brand.linkDomains();
  if (issue.code !== "wrong-link" || domains.length === 0) return false;
  const text = `${issue.message}\n${issue.fix}`;
  const carried = new Set((renderTexts(draft).match(trackedLinkRe(domains)) ?? []).map(normalizeUrl));
  const named = (text.match(URL_TOKEN_RE) ?? []).map(normalizeUrl);
  const tracked = named.filter((u) => carried.has(u));
  const source = draft.source.link ? normalizeUrl(draft.source.link) : null;
  return tracked.length > 0 && named.every((u) => carried.has(u) || u === source);
}

export async function llmReview(draft: Draft, brand: BrandContext = NO_BRAND): Promise<LlmQaOutput> {
  // A brand pack's brief is never empty, so the section below has no "(none)"
  // placeholder; a brandless engine sends the heading over an empty section.
  const guidance = trackedLinkGuidance(brand);
  const prompt = `You are ${reviewerRole(brand)}. Review this multi-platform post draft before it goes out. You are the last line of defense.

## Brand brief
${brand.brandBrief()}

## Platform rules
${specBlock(draft.renders.map((r) => r.platform), brand)}

## Draft (source + per-platform renders)
${draftSummaryForPrompt(draft)}

Check for: factual drift between renders and source, typos/grammar, broken or wrong URLs, tone mismatches per platform, weak hooks (first line), missing CTAs, hashtag quality, claims we cannot back, anything embarrassing or off-brand, platform-norm violations not caught by mechanical limits.

${guidance ? `${guidance}\n\n` : ""}Return JSON: {"issues": [{"code": "<one of the codes below>", "platform": "${ALL_PLATFORMS.join("|")}|${GLOBAL_PLATFORM}", "message": "...", "fix": "one concrete action to resolve it"}], "summary": "2-3 sentence overall verdict"}

"code" MUST be exactly one of: ${LLM_ISSUE_CODES.join(", ")}
Pick the closest one; do not invent new codes, do not add a platform suffix (the "platform" field carries that; use "${GLOBAL_PLATFORM}" for a finding about the whole draft), and do not report severity — it is derived from the code. Use "style-nit" if nothing else fits.
Guidance: factual-drift = a render contradicts the source; unbacked-claim = a claim we cannot support; broken-link/wrong-link = a URL that 404s, is malformed, or points somewhere unintended (including a trailing period swallowed into the href); grammar = typos, dangling sentences or fragments; off-brand = embarrassing or against the brand brief; link-placement = a link in a spot that costs reach; platform-norm = a convention of that network not caught by the mechanical limits.
Always include a short, concrete "fix" for each issue. If it is clean, return an empty issues array and say so.`;
  // Structured output: the reply always has this shape (claude.ts), and a
  // refused or truncated review throws, which runQa turns into a blocking
  // llm-qa-unavailable.
  return (brand.llm ?? claudeLlm).generateJson<LlmQaOutput>(prompt, { schema: LLM_QA_SCHEMA });
}

/**
 * Ask the target subreddit what it accepts, and report the mismatch here rather
 * than letting Reddit refuse the post silently.
 *
 * Reddit is the one channel whose rules are per-destination, so the nightly
 * channel-rules snapshot cannot hold them: they change with the subreddit on
 * the draft. That is why this is a live call in runQa instead of another entry
 * in ChannelRulesSnapshot.
 *
 * Every failure mode degrades to "no issues". A vendor hiccup must not block a
 * draft, and it must not manufacture a scary finding either.
 */
async function subredditChecks(draft: Draft): Promise<QAIssue[]> {
  const r = draft.renders.find((x) => x.platform === "reddit");
  if (!r) return [];
  const subreddit = normalizeSubreddit(r.subreddit ?? defaults().subreddit);
  if (!subreddit) return []; // already reported as subreddit-missing

  let rules;
  try {
    // The publish path's own lookup, not a second copy of it: QA refusing a
    // draft the publisher would accept (or the reverse) is worse than either
    // answer on its own.
    rules = await resolveRedditRestrictions(draft.renders, await connectedAccounts());
  } catch {
    return [];
  }
  if (!rules?.allow.length) return [];

  const issues: QAIssue[] = [];
  const mediaCount = r.mediaIndices.filter((i) => draft.source.media[i]).length;

  if (!rules.allow.includes("self") && !(mediaCount === 1 && rules.allow.includes("media"))) {
    issues.push({
      severity: "fail",
      platform: "reddit",
      code: "subreddit-type-not-allowed",
      message: `r/${subreddit} accepts only ${rules.allow.join(", ")} posts, which this draft cannot produce`,
      fix: `Target a subreddit that accepts text posts.`,
    });
  } else if (mediaCount === 1 && !rules.allow.includes("media")) {
    // Not a blocker: publish falls back to a text post. Warn so the operator
    // knows the image will not appear rather than discovering it afterwards.
    issues.push({
      severity: "warn",
      platform: "reddit",
      code: "subreddit-no-media",
      message: `r/${subreddit} does not allow image posts, so this publishes as a text post and the image is dropped`,
      fix: `Remove the image from the Reddit version, or pick a subreddit that allows images.`,
    });
  }

  if (rules.isFlairRequired && !r.flair) {
    issues.push({
      severity: "fail",
      platform: "reddit",
      code: "subreddit-flair-required",
      message:
        `r/${subreddit} requires a post flair and none is set` +
        (rules.flairs.length ? ` (available: ${rules.flairs.map((f) => f.name).join(", ")})` : ""),
      fix: `Set a flair on the Reddit version of this draft.`,
    });
  }

  return issues;
}

/**
 * Check the draft's Pinterest board actually exists, at QA time rather than at
 * publish time.
 *
 * Like subreddit restrictions, this is per-destination state that the nightly
 * channel-rules snapshot cannot hold, so it is a live call. It mirrors the
 * publish preflight (assertPinterestBoard) deliberately: an operator should see
 * "this account has no boards" in the QA panel, not discover it when a
 * scheduled pin refuses to go out.
 *
 * Every failure mode degrades to "no issues", for the same reason as
 * subredditChecks: a vendor hiccup must neither block a draft nor invent a
 * finding.
 */
async function pinterestBoardChecks(draft: Draft): Promise<QAIssue[]> {
  const r = draft.renders.find((x) => x.platform === "pinterest");
  if (!r) return [];
  const wanted = r.board?.id ?? defaults().pinterestBoard;
  if (!wanted) return []; // already reported as board-missing

  let boards;
  try {
    const connected = await connectedAccounts();
    if (!connected.pinterest) return [];
    const transport = (await routeTransportFor("pinterest"))?.transport;
    if (!transport?.listBoards) return [];
    boards = await transport.listBoards();
  } catch {
    return [];
  }

  if (!boards.length) {
    return [
      {
        severity: "fail",
        platform: "pinterest",
        code: "no-pinterest-boards",
        message:
          "the connected Pinterest account has no boards, so a pin has nowhere to go",
        fix: "Create a board in Pinterest, then set it as the default board.",
      },
    ];
  }
  if (!boards.some((b) => b.id === wanted)) {
    return [
      {
        severity: "fail",
        platform: "pinterest",
        code: "board-unknown",
        message: `board "${wanted}" is not on the connected Pinterest account (available: ${boards
          .map((b) => b.name)
          .join(", ")})`,
        fix: "Pick one of the boards that exists on the account.",
      },
    ];
  }
  return [];
}

export async function runQa(
  draft: Draft,
  opts: {
    skipLlm?: boolean;
    channelRules?: ChannelRulesSnapshot | null;
    /** See deterministicChecks: the limits each platform's media gets fitted to. */
    fittingRules?: ReadonlyMap<Platform, TransportChannelRules>;
    /** See deterministicChecks: the platforms that can be delivered to at all. */
    routablePlatforms?: ReadonlySet<Platform> | null;
    /** The brand pack (brand-context.ts). Absent, QA runs brandless. */
    brand?: BrandContext;
  } = {},
): Promise<QAReport> {
  const brand = opts.brand ?? NO_BRAND;
  const issues = deterministicChecks(
    draft,
    opts.channelRules ?? null,
    opts.fittingRules,
    opts.routablePlatforms ?? null,
    brand,
  );
  // Both are live per-destination lookups and neither depends on the other, so
  // they overlap rather than adding two serial round trips to every QA run.
  const [subreddit, pinterest] = await Promise.all([
    subredditChecks(draft),
    pinterestBoardChecks(draft),
  ]);
  issues.push(...subreddit, ...pinterest);
  let llmSummary: string | undefined;
  let reviewedBy: QAReport["reviewedBy"];
  if (!opts.skipLlm) {
    try {
      const llm = await llmReview(draft, brand);
      llmSummary = llm.summary;
      reviewedBy = modelStamp();
      for (const i of llm.issues) {
        if (!i.message.trim()) continue;
        // The brand's own tracked short link is not a wrong link (see
        // trackedLinkGuidance): the prompt says so, and this holds the line
        // when the model says it anyway.
        if (isTrackedLinkFalsePositive(i, draft, brand)) continue;
        // `pass` is computed from severity and gates publishing, so severity is
        // taken from LLM_ISSUE_SEVERITY by category and the model's own opinion
        // of it is never asked for (see the note there for why). The schema's
        // enum means every code is priced (the old `llm-other` fail-closed path
        // for an unknown code had nothing left to catch, so it went).
        issues.push({
          severity: LLM_ISSUE_SEVERITY[i.code],
          platform: i.platform === GLOBAL_PLATFORM ? undefined : i.platform,
          code: `llm-${i.code}`,
          message: i.message,
          fix: i.fix.trim() ? i.fix : undefined,
        });
      }
    } catch (err) {
      // ⛔ A FAIL, NOT A WARN. The review
      // is the only gate for factual drift, unbacked claims, grammar and
      // off-brand copy, and autopilot and the digest's email approve publish on
      // `pass` alone, so a warn here scheduled copy no reviewer had read. A
      // human still has two ways through: re-run QA once the reviewer answers,
      // or read it and force-approve, which the publish
      // route honours. Not text-fixable: no rewrite brings the reviewer back.
      issues.push({
        severity: "fail",
        code: "llm-qa-unavailable",
        message: `LLM review failed (${(err as Error).message.slice(0, 120)}); only mechanical checks ran, so this draft cannot publish unattended`,
        fix: "Re-run QA once the reviewer answers, or read the copy yourself and force-approve it.",
      });
    }
  }
  // Stamped server-side so the UI can offer "Fix issues with AI" using the same
  // rule the fix endpoint enforces, instead of a client-side guess that can
  // disagree with it. `fixable` covers BOTH paths the fix pass runs — a text
  // rewrite and a deterministic mechanical edit — so an oversized image the
  // fixer will drop from Bluesky still lights the button.
  for (const i of issues) {
    i.fixable = isTextFixable(i, brand) || isMechanicallyFixable(i);
    const media = mediaFixKind(i);
    if (media) i.needsMedia = media;
  }

  return {
    ranAt: new Date().toISOString(),
    pass: !issues.some((i) => i.severity === "fail"),
    issues,
    llmSummary,
    reviewedBy,
  };
}
