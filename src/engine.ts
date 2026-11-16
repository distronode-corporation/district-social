/**
 * `createEngine`: one engine instance with its brand bound.
 *
 * Every brand-aware function in the engine takes a `BrandContext`
 * (brand-context.ts). An `Engine` is that context plus the same functions with
 * it already passed, so a consumer holds one value instead of threading the
 * brand through every call. The brand state lives in the instance and nowhere
 * else: two engines never share a pack, and `setBrandPack` changes only its own.
 *
 * Engine rules apply: relative imports only.
 */

import {
  briefHeadingPhrases,
  briefWithOverride,
  type BrandContext,
  type BrandPack,
  type QaGate,
} from "./brand-context.js";
import { formatPost } from "./format.js";
import { claudeLlm, systemClock, type EnginePorts } from "./ports.js";
import { complianceChecks, deterministicChecks, isTextFixable, llmReview, runQa } from "./qa.js";
import { outstandingIssues, reviseRenders } from "./revise.js";
import type { ChannelRulesSnapshot } from "./channel-rules.js";
import type { TransportChannelRules } from "./transport.js";
import type { Draft, Platform, PlatformRender, QAIssue, QAReport, SourcePost } from "./types.js";

/** The pack of an engine created with none: no brief, no gates, no profiles. */
export const EMPTY_BRAND_PACK: BrandPack = Object.freeze({ name: "none", brief: "" });

export interface EngineOptions extends Partial<EnginePorts> {
  brand?: BrandPack;
  /** Gates this engine runs after the pack's own, kept across setBrandPack. */
  extraQaGates?: readonly QaGate[];
}

export interface Engine extends BrandContext {
  /** The pack this engine currently applies. */
  readonly brand: BrandPack;
  /**
   * The ports this engine was created with (ports.ts): `clock` and `llm`
   * default to the wall clock and Claude, the stores are present only when
   * passed. Held per engine, never shared.
   */
  readonly ports: Readonly<EnginePorts>;
  /** The model this engine's prompts go to (`ports.llm`). */
  readonly llm: EnginePorts["llm"];
  /** Replaces this engine's pack. The extraQaGates passed to createEngine stay. */
  setBrandPack(pack: BrandPack): void;
  /** The pack's profile link for a platform, or "" when it lists none. */
  profileUrl(platform: string): string;
  // The engine functions of the same names, with this engine as their brand.
  formatPost(
    source: SourcePost,
    targets: Platform[],
    instruction?: string,
    channelRules?: ChannelRulesSnapshot | null,
  ): Promise<PlatformRender[]>;
  deterministicChecks(
    draft: Draft,
    channelRules?: ChannelRulesSnapshot | null,
    fittingRules?: ReadonlyMap<Platform, TransportChannelRules>,
    routablePlatforms?: ReadonlySet<Platform> | null,
  ): QAIssue[];
  complianceChecks(draft: Draft): QAIssue[];
  isTextFixable(issue: QAIssue): boolean;
  llmReview(draft: Draft): ReturnType<typeof llmReview>;
  runQa(draft: Draft, opts?: Omit<NonNullable<Parameters<typeof runQa>[1]>, "brand">): Promise<QAReport>;
  outstandingIssues(draft: Draft, previous: QAReport | undefined, changed: Platform[]): QAIssue[];
  reviseRenders(draft: Draft, issues: QAIssue[]): Promise<Map<Platform, PlatformRender>>;
}

export function createEngine(opts: EngineOptions = {}): Engine {
  const ports: Readonly<EnginePorts> = Object.freeze({
    clock: opts.clock ?? systemClock,
    llm: opts.llm ?? claudeLlm,
    lock: opts.lock,
    drafts: opts.drafts,
    credentials: opts.credentials,
    media: opts.media,
    approvals: opts.approvals,
  });
  const extra = opts.extraQaGates ?? [];
  let pack = opts.brand ?? EMPTY_BRAND_PACK;
  let phrases = briefHeadingPhrases(pack.brief);
  let gates: readonly QaGate[] = [...(pack.qaGates ?? []), ...extra];

  const engine: Engine = {
    get brand() {
      return pack;
    },
    ports,
    llm: ports.llm,
    setBrandPack(next: BrandPack) {
      pack = next;
      phrases = briefHeadingPhrases(next.brief);
      gates = [...(next.qaGates ?? []), ...extra];
    },
    profileUrl: (platform: string) => pack.profiles?.find((p) => p.platform === platform)?.url ?? "",
    brandBrief: () => briefWithOverride(pack.brief),
    briefHeadingPhrases: () => phrases,
    qaGates: () => gates,
    brandName: () => pack.displayName ?? "",
    linkDomains: () => pack.linkDomains ?? [],
    gateCopy: (code: string) => pack.gateCopy?.[code],
    formatPost: (source, targets: Platform[], instruction?: string, channelRules?) =>
      formatPost(source, targets, instruction, channelRules, engine),
    deterministicChecks: (draft, channelRules?, fittingRules?, routablePlatforms?) =>
      deterministicChecks(draft, channelRules, fittingRules, routablePlatforms, engine),
    complianceChecks: (draft: Draft) => complianceChecks(draft, engine),
    isTextFixable: (issue: QAIssue) => isTextFixable(issue, engine),
    llmReview: (draft: Draft) => llmReview(draft, engine),
    runQa: (draft, runOpts = {}) => runQa(draft, { ...runOpts, brand: engine }),
    outstandingIssues: (draft, previous, changed) => outstandingIssues(draft, previous, changed, engine),
    reviseRenders: (draft, issues) => reviseRenders(draft, issues, engine),
  };
  return engine;
}
