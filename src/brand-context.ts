/**
 * The brand as data: what a brand pack hands the engine, and the context every
 * brand-aware engine function reads it through.
 *
 * The engine carries no brand of its own. The brief the model reads, the extra
 * deterministic QA gates that enforce a brand's claim rules, and the public
 * profiles all arrive in a `BrandPack`, which `createEngine` (engine.ts) binds
 * to one engine instance. A brand's own pack lives with the application that
 * binds it; the engine never imports one.
 *
 * The brand-aware functions (formatPost, runQa, deterministicChecks,
 * complianceChecks, llmReview, reviseRenders, outstandingIssues) take a
 * `BrandContext` argument. With none they run brandless: an empty brief, no
 * brief headings to guard and no extra gates, which is the engine's own
 * behaviour and nothing more. There is no module-level registry to set, so two
 * engines in one process (two tenants of a server) never share a brand.
 *
 * Engine rules apply: relative imports only, no `@/`, no prisma, no next.
 */

import type { LlmClient } from "./ports.js";
import type { QASeverity } from "./types.js";

/**
 * One deterministic QA gate over a draft's text surfaces (the source, then
 * each render's body, title, first comment and thread replies). A gate that
 * fires adds one issue per draft, attributed to the first surface it fired on.
 */
export interface QaGate {
  code: string;
  severity: QASeverity;
  message: string;
  fix: string;
  detect: (text: string) => boolean;
  /**
   * Names what tripped the gate, appended to the message. Only for gates with
   * a long term list, where "a banned word" alone would leave the operator
   * guessing which one.
   */
  found?: (text: string) => string | undefined;
}

/** A public profile the brand keeps on a platform. Only the link is read by the engine. */
export interface BrandProfile {
  platform: string;
  url: string;
}

export interface BrandPack {
  /** A short id for logs and tests. */
  name: string;
  /**
   * The brief every model call reads: the formatter, the reviewer and the
   * reviser. Its copy rules (voice, content rules, the words it never says)
   * are prose in here; the parts a machine can hold are `qaGates`. Its `## `
   * headings are internal labels that QA refuses in public copy.
   */
  brief: string;
  /** Deterministic gates run after the engine's own compliance gates. */
  qaGates?: readonly QaGate[];
  profiles?: readonly BrandProfile[];
  /**
   * The brand's name as the model prompts say it ("the social media editor
   * for <name>"). Absent: the prompts name no brand.
   */
  displayName?: string;
  /**
   * The registrable domains the brand's own tracked short links live on
   * (`<host>/l/<code>`), first one the example the reviewer is shown. Absent:
   * the reviewer is not told about tracked links and none are screened.
   */
  linkDomains?: readonly string[];
  /**
   * The brand's own wording for an engine compliance gate's message and fix,
   * by gate code. The gate's detection and severity stay the engine's.
   */
  gateCopy?: Readonly<Record<string, GateCopy>>;
}

/** A compliance gate's operator-facing text. */
export interface GateCopy {
  message: string;
  fix: string;
}

/** What a brand-aware engine function reads. An `Engine` is one. */
export interface BrandContext {
  /** The brief for a model prompt, or the SOCIALMETA_BRAND_OVERRIDE text when that is set. */
  brandBrief(): string;
  /** The normalised `## ` heading phrases of the pack's own brief (see briefHeadingPhrases). */
  briefHeadingPhrases(): readonly string[];
  /** The pack's gates, then the engine's extraQaGates. */
  qaGates(): readonly QaGate[];
  /** The pack's displayName, or "" when it has none. */
  brandName(): string;
  /** The pack's linkDomains, or none. */
  linkDomains(): readonly string[];
  /** The pack's wording for an engine gate, or undefined to keep the engine's. */
  gateCopy(code: string): GateCopy | undefined;
  /** The model the brand-aware prompts go to. Absent: Claude (ports.ts claudeLlm). */
  llm?: LlmClient;
}

/**
 * The shortest normalised phrase the brief-heading check will match. Short
 * headings ("Audience", "Who we are", "Never say", "The four pillars") are
 * ordinary words a post may well use, so they never count as a quote.
 */
export const BRIEF_HEADING_MIN_CHARS = 20;

/** Lower case, every run of whitespace (newlines and NBSP included) one space, trimmed. */
export function normalizeHeadingText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * The phrases from a brief's `## ` headings that copy must never quote (a
 * model will happily write "Here is what shipped in the spring release:" from
 * the heading "## Shipped since launch (the spring release)").
 *
 * For each `## ` heading (not `#` or `###`), normalised: the whole heading,
 * the heading with its parentheticals removed, and the text inside each
 * parenthetical. A phrase shorter than BRIEF_HEADING_MIN_CHARS is dropped.
 */
export function briefHeadingPhrases(brief: string): string[] {
  const phrases = new Set<string>();
  for (const [, heading] of brief.matchAll(/^## (.+)$/gm)) {
    const inner = [...heading.matchAll(/\(([^()]*)\)/g)].map(([, part]) => part);
    for (const phrase of [heading, heading.replace(/\([^()]*\)/g, " "), ...inner]) {
      const normalized = normalizeHeadingText(phrase);
      if (normalized.length >= BRIEF_HEADING_MIN_CHARS) phrases.add(normalized);
    }
  }
  return [...phrases];
}

/**
 * The brief for a prompt: the override when set and non-empty, else the
 * pack's own. The override replaces the words the model reads and nothing
 * else; the heading guard keeps reading the pack's brief.
 */
export function briefWithOverride(brief: string): string {
  return process.env.SOCIALMETA_BRAND_OVERRIDE || brief;
}

/** Who the formatter and the reviser are told they are. */
export function editorRole(brand: Pick<BrandContext, "brandName">): string {
  const name = brand.brandName();
  return name ? `the social media editor for ${name}` : "a social media editor";
}

/** Who the reviewer is told it is. */
export function reviewerRole(brand: Pick<BrandContext, "brandName">): string {
  const name = brand.brandName();
  return name ? `the QA editor for ${name}'s social media` : "the QA editor for this brand's social media";
}

/**
 * A platform note with its brand placeholders filled: `{brand}` is the pack's
 * displayName ("the brand" without one), `{domain}` its first link domain
 * ("example.com" without one).
 */
export function fillBrandPlaceholders(text: string, brand: Pick<BrandContext, "brandName" | "linkDomains">): string {
  return text
    .replaceAll("{brand}", brand.brandName() || "the brand")
    .replaceAll("{domain}", brand.linkDomains()[0] ?? "example.com");
}

/**
 * The context of an engine with no brand pack. Stateless and frozen, so it is
 * a default argument, not a registry anyone can set.
 */
export const NO_BRAND: BrandContext = Object.freeze({
  brandBrief: () => briefWithOverride(""),
  briefHeadingPhrases: () => [],
  qaGates: () => [],
  brandName: () => "",
  linkDomains: () => [],
  gateCopy: () => undefined,
});
