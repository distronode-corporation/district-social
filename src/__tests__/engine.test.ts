// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../claude.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../claude.js")>()),
  genJson: vi.fn(async () => ({ issues: [], summary: "fine", renders: [] })),
}));

import { genJson } from "../claude.js";
import { NO_BRAND, briefWithOverride, type BrandPack, type QaGate } from "../brand-context.js";
import { createEngine, EMPTY_BRAND_PACK } from "../engine.js";
import { claudeLlm, inMemoryApprovalGate, inMemoryDraftStore, manualClock, scriptedLlm, systemClock } from "../ports.js";
import type { Draft, MediaAsset, PlatformRender } from "../types.js";

/**
 * createEngine binds a brand pack to one engine instance. The engine carries
 * no brand of its own, so every brand here is a fixture.
 */

const WIDGET: QaGate = {
  code: "widget-word",
  severity: "fail",
  message: "Says widget.",
  fix: "Drop it.",
  detect: (text) => /\bwidget\b/i.test(text),
  found: (text) => /\bwidget\b/i.exec(text)?.[0],
};
const GADGET: QaGate = {
  code: "gadget-word",
  severity: "warn",
  message: "Says gadget.",
  fix: "Drop it.",
  detect: (text) => /\bgadget\b/i.test(text),
};
const SPROCKET: QaGate = { ...GADGET, code: "sprocket-word", detect: (text) => /\bsprocket\b/i.test(text) };

const PACK: BrandPack = {
  name: "example",
  brief: "# Example brief\n## The internal heading for the shipped list\nSay plain things.",
  qaGates: [WIDGET],
  profiles: [{ platform: "tiktok", url: "https://www.tiktok.com/@example" }],
};

const IMAGE: MediaAsset = { path: "/tmp/card.png", type: "image", mimeType: "image/png", size: 1000, altText: "A card" };

function draftWith(content: string, extra: Partial<PlatformRender> = {}): Draft {
  return {
    id: "d1",
    createdAt: "2026-11-16T00:00:00.000Z",
    updatedAt: "2026-11-16T00:00:00.000Z",
    status: "draft",
    source: { text: "source text", hashtags: [], media: [IMAGE] },
    targets: ["bluesky"],
    renders: [{ platform: "bluesky", content, mediaIndices: [0], ...extra }],
  };
}

const lastPrompt = () => vi.mocked(genJson).mock.calls.at(-1)![0];

describe("createEngine", () => {
  beforeEach(() => {
    vi.stubEnv("SOCIALMETA_BRAND_OVERRIDE", "");
    vi.mocked(genJson).mockClear();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("with no brand", () => {
    const engine = createEngine();

    it("applies the empty pack: no brief, no headings, no gates, no profiles", () => {
      expect(engine.brand).toBe(EMPTY_BRAND_PACK);
      expect(Object.isFrozen(EMPTY_BRAND_PACK)).toBe(true);
      expect(engine.brandBrief()).toBe("");
      expect(engine.briefHeadingPhrases()).toEqual([]);
      expect(engine.qaGates()).toEqual([]);
      expect(engine.profileUrl("tiktok")).toBe("");
    });

    it("still runs the extra gates it was given", () => {
      const extra = createEngine({ extraQaGates: [GADGET] });
      expect(extra.qaGates()).toEqual([GADGET]);
      expect(extra.complianceChecks(draftWith("A gadget.")).map((i) => i.code)).toEqual(["gadget-word"]);
    });

    it("hands the model the override when one is set", () => {
      vi.stubEnv("SOCIALMETA_BRAND_OVERRIDE", "override brief");
      expect(engine.brandBrief()).toBe("override brief");
    });
  });

  describe("with a pack", () => {
    it("reads the pack: its brief, its headings, its gates then the extras, its profiles", () => {
      const engine = createEngine({ brand: PACK, extraQaGates: [GADGET] });
      expect(engine.brand).toBe(PACK);
      expect(engine.brandBrief()).toBe(PACK.brief);
      expect(engine.briefHeadingPhrases()).toEqual(["the internal heading for the shipped list"]);
      expect(engine.qaGates()).toEqual([WIDGET, GADGET]);
      expect(engine.profileUrl("tiktok")).toBe("https://www.tiktok.com/@example");
      expect(engine.profileUrl("youtube")).toBe("");
    });

    it("prefers the override for the prompt and keeps guarding the pack's own headings", () => {
      vi.stubEnv("SOCIALMETA_BRAND_OVERRIDE", "override brief");
      const engine = createEngine({ brand: PACK });
      expect(engine.brandBrief()).toBe("override brief");
      expect(engine.briefHeadingPhrases()).toEqual(["the internal heading for the shipped list"]);
    });

    it("takes a pack with no gates and no profiles", () => {
      const engine = createEngine({ brand: { name: "bare", brief: "Just words." } });
      expect(engine.qaGates()).toEqual([]);
      expect(engine.profileUrl("tiktok")).toBe("");
    });
  });

  describe("setBrandPack", () => {
    it("replaces this engine's pack and keeps its extra gates", () => {
      const engine = createEngine({ brand: PACK, extraQaGates: [GADGET] });
      const next: BrandPack = { name: "next", brief: "## Another heading long enough to count", qaGates: [SPROCKET] };
      engine.setBrandPack(next);
      expect(engine.brand).toBe(next);
      expect(engine.brandBrief()).toBe(next.brief);
      expect(engine.briefHeadingPhrases()).toEqual(["another heading long enough to count"]);
      expect(engine.qaGates()).toEqual([SPROCKET, GADGET]);
      expect(engine.profileUrl("tiktok")).toBe("");
    });

    /**
     * The engine derives its heading phrases and gate list from the pack when
     * it is bound, so a pack edited in place afterwards would leave them
     * stale. The fields are readonly: replacing the pack is the one way to
     * change it, and the compiler refuses the edit.
     */
    it("exposes a pack whose fields cannot be reassigned, only replaced through setBrandPack", () => {
      const engine = createEngine({ brand: { ...PACK } });
      // @ts-expect-error BrandPack fields are readonly
      engine.brand.brief = "## A heading edited in after binding";
      // At runtime the stale derivation is exactly what the type prevents.
      expect(engine.briefHeadingPhrases()).toEqual(["the internal heading for the shipped list"]);
    });

    it("leaves every other engine alone: there is no shared registry", () => {
      const a = createEngine({ brand: PACK });
      const b = createEngine({ brand: PACK });
      a.setBrandPack({ name: "other", brief: "Other." });
      expect(a.qaGates()).toEqual([]);
      expect(b.brand).toBe(PACK);
      expect(b.qaGates()).toEqual([WIDGET]);
      expect(NO_BRAND.qaGates()).toEqual([]);
    });
  });

  describe("the bound engine functions", () => {
    const engine = createEngine({ brand: PACK });
    const brandless = createEngine();

    it("complianceChecks runs the pack's gates, naming what they found", () => {
      expect(engine.complianceChecks(draftWith("One Widget per call."))).toEqual([
        { severity: "fail", platform: "bluesky", code: "widget-word", message: 'Says widget. Found: "Widget".', fix: "Drop it." },
      ]);
      expect(brandless.complianceChecks(draftWith("One Widget per call."))).toEqual([]);
    });

    it("deterministicChecks applies the pack's gates and its brief headings", () => {
      const draft = draftWith("A widget, and the internal heading for the shipped list.");
      expect(engine.deterministicChecks(draft).map((i) => i.code)).toEqual(["brief-heading-quoted", "widget-word"]);
      expect(brandless.deterministicChecks(draft)).toEqual([]);
    });

    it("isTextFixable keeps the pack's gate codes away from the rewrite", () => {
      const issue = { severity: "fail" as const, code: "widget-word", message: "m", fix: "f" };
      expect(engine.isTextFixable(issue)).toBe(false);
      expect(brandless.isTextFixable(issue)).toBe(true);
    });

    it("outstandingIssues leaves the pack's gate out and keeps the copy issues", () => {
      const draft = draftWith("A widget, and the internal heading for the shipped list.");
      expect(engine.outstandingIssues(draft, undefined, []).map((i) => i.code)).toEqual(["brief-heading-quoted"]);
    });

    it("runQa runs the pack's gates and stamps their issues not fixable", async () => {
      const report = await engine.runQa(draftWith("A widget."), { skipLlm: true });
      expect(report.pass).toBe(false);
      expect(report.issues).toEqual([expect.objectContaining({ code: "widget-word", fixable: false })]);
      expect(genJson).not.toHaveBeenCalled();
    });

    it("runQa with no options hands the reviewer the pack's brief", async () => {
      const report = await engine.runQa(draftWith("Plain copy."));
      expect(report.pass).toBe(true);
      expect(report.llmSummary).toBe("fine");
      expect(lastPrompt()).toContain(`## Brand brief\n${PACK.brief}\n`);
    });

    it("llmReview, formatPost and reviseRenders hand the model the pack's brief", async () => {
      const draft = draftWith("Plain copy.");
      await engine.llmReview(draft);
      expect(lastPrompt()).toContain(`## Brand brief\n${PACK.brief}\n`);
      // The mocked answer has no renders, so the formatter refuses it after sending the prompt.
      await expect(engine.formatPost(draft.source, ["bluesky"])).rejects.toThrow("no render for bluesky");
      expect(lastPrompt()).toContain(`## Brand brief\n${PACK.brief}\n`);
      await engine.reviseRenders(draft, [{ severity: "warn", code: "llm-tone", message: "tone", fix: "warmer" }]);
      expect(lastPrompt()).toContain(`## Brand brief\n${PACK.brief}\n`);
    });

    it("a brandless engine sends the brief heading over an empty section", async () => {
      await brandless.llmReview(draftWith("Plain copy."));
      expect(lastPrompt()).toContain("## Brand brief\n\n");
    });
  });
});

describe("createEngine's ports", () => {
  it("defaults to the wall clock and Claude, and holds no store it was not given", () => {
    const engine = createEngine();
    expect(engine.ports.clock).toBe(systemClock);
    expect(engine.ports.llm).toBe(claudeLlm);
    expect(engine.llm).toBe(claudeLlm);
    for (const store of ["lock", "drafts", "credentials", "media", "approvals"] as const) {
      expect(engine.ports[store]).toBeUndefined();
    }
    expect(Object.isFrozen(engine.ports)).toBe(true);
  });

  it("holds the ports it is given, per engine", () => {
    const clock = manualClock();
    const drafts = inMemoryDraftStore();
    const approvals = inMemoryApprovalGate(clock);
    const a = createEngine({ clock, drafts, approvals });
    const b = createEngine();
    expect(a.ports).toMatchObject({ clock, drafts, approvals });
    expect(b.ports.drafts).toBeUndefined();
  });

  it("sends every brand-aware prompt to its own llm, never to Claude", async () => {
    vi.mocked(genJson).mockClear();
    const llm = scriptedLlm(() => ({ issues: [], summary: "clean", renders: [] }));
    const engine = createEngine({ brand: PACK, llm });
    const draft = draftWith("Plain copy.");
    await engine.llmReview(draft);
    await expect(engine.formatPost(draft.source, ["bluesky"])).rejects.toThrow("no render for bluesky");
    await engine.reviseRenders(draft, [{ severity: "warn", code: "llm-tone", message: "tone", fix: "warmer" }]);
    await engine.runQa(draft);
    expect(llm.prompts).toHaveLength(4);
    expect(vi.mocked(genJson)).not.toHaveBeenCalled();
  });
});

describe("brand data in prompts and gates", () => {
  const NAMED: BrandPack = {
    ...PACK,
    displayName: "Acme",
    linkDomains: ["acme.example"],
    gateCopy: { "earnings-claims": { message: "Acme never promises numbers.", fix: "Say it plainly." } },
  };

  it("names the brand in every role line when the pack has a displayName", async () => {
    const llm = scriptedLlm(() => ({ issues: [], summary: "", renders: [] }));
    const engine = createEngine({ brand: NAMED, llm });
    const draft = draftWith("Plain copy.");
    await engine.llmReview(draft);
    await engine.formatPost(draft.source, ["bluesky"]).catch(() => undefined);
    await engine.reviseRenders(draft, [{ severity: "warn", code: "llm-tone", message: "tone", fix: "warmer" }]);
    const [review, format, revise] = llm.prompts;
    expect(review).toMatch(/^You are the QA editor for Acme's social media\./);
    expect(review).toContain("https://www.acme.example/l/Ab3xK9q");
    expect(format).toMatch(/^You are the social media editor for Acme\./);
    expect(revise).toMatch(/^You are the social media editor for Acme\./);
  });

  it("names no brand when brandless", async () => {
    const llm = scriptedLlm(() => ({ issues: [], summary: "", renders: [] }));
    const engine = createEngine({ llm });
    const draft = draftWith("Plain copy.");
    await engine.formatPost(draft.source, ["bluesky", "reddit"]).catch(() => undefined);
    await engine.reviseRenders(draft, [{ severity: "warn", code: "llm-tone", message: "tone", fix: "warmer" }]);
    const [format, revise] = llm.prompts;
    expect(format).toMatch(/^You are a social media editor\./);
    expect(format).toContain("Subreddit fit for the brand:");
    expect(format).toContain("(e.g. example.com, no UTM tags)");
    expect(revise).toMatch(/^You are a social media editor\./);
  });

  it("rewords an engine gate with the pack's copy and keeps the engine's otherwise", () => {
    const promise = draftWith("We guarantee results.");
    const named = createEngine({ brand: NAMED }).complianceChecks(promise);
    expect(named.find((i) => i.code === "earnings-claims")).toMatchObject({
      message: "Acme never promises numbers.",
      fix: "Say it plainly.",
    });
    const plain = createEngine().complianceChecks(promise);
    expect(plain.find((i) => i.code === "earnings-claims")?.message).toMatch(/^Guaranteed-outcome/);
  });

  it("NO_BRAND carries no name, no link domains and no gate copy", () => {
    expect(NO_BRAND.brandName()).toBe("");
    expect(NO_BRAND.linkDomains()).toEqual([]);
    expect(NO_BRAND.gateCopy("earnings-claims")).toBeUndefined();
  });
});

describe("briefWithOverride", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is the brief unless the override is set and non-empty", () => {
    vi.stubEnv("SOCIALMETA_BRAND_OVERRIDE", "");
    expect(briefWithOverride("own")).toBe("own");
    expect(NO_BRAND.brandBrief()).toBe("");
    vi.stubEnv("SOCIALMETA_BRAND_OVERRIDE", "replacement");
    expect(briefWithOverride("own")).toBe("replacement");
    expect(NO_BRAND.brandBrief()).toBe("replacement");
  });
});
