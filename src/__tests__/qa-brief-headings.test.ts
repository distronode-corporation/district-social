// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";

import { NO_BRAND } from "../brand-context.js";
import { createEngine } from "../engine.js";
import {
  BRIEF_HEADING_MIN_CHARS,
  briefHeadingPhrases,
  deterministicChecks,
  findQuotedBriefHeading,
  isTextFixable,
} from "../qa.js";
import type { Draft, PlatformRender } from "../types.js";

/**
 * A model will render a brand brief's section heading such as
 * "## Shipped since the pillars (the 30 October 2026 release)" into LinkedIn
 * copy. The `brief-heading-quoted` gate fails any render that quotes a `## `
 * heading from the brand pack's brief, derived from it with no hard-coded list.
 */

/** A brief shaped like a real one, with headings short and long. */
const BRIEF_238 = [
  "# Acmebrands brand brief (for social formatting + QA)",
  "",
  "## Who we are",
  "- a line",
  "## Audience",
  "## Never say",
  "## Shipped since the pillars (the 30 October 2026 release)",
  "### 1. One line for the whole company, a third-level heading.",
  "## Voice (tone)",
].join("\n");

const PHRASES_238 = briefHeadingPhrases(BRIEF_238);

const LEAK_238 = "Here is what shipped in the 30 October 2026 release: teammates on every plan.";

function draftWith(renders: PlatformRender[]): Draft {
  return {
    id: "d1",
    createdAt: "2026-11-09T00:00:00.000Z",
    updatedAt: "2026-11-09T00:00:00.000Z",
    status: "draft",
    source: { text: "source text", hashtags: [], media: [] },
    targets: renders.map((r) => r.platform),
    renders,
  };
}

function render(overrides: Partial<PlatformRender> & { platform: PlatformRender["platform"] }): PlatformRender {
  return { content: "", mediaIndices: [], ...overrides };
}

/** A pack brief with two long `## ` headings, in this order, and a short one. */
const PACK_BRIEF = [
  "# Example brand brief",
  "## Who we are",
  "## Claim source: shipped features",
  "## The ledger in one sentence",
].join("\n");

const engine = createEngine({ brand: { name: "example", brief: PACK_BRIEF } });

function headingIssues(draft: Draft) {
  return engine.deterministicChecks(draft).filter((i) => i.code === "brief-heading-quoted");
}

/** A heading the pack's brief carries, long enough to count, as a model might quote it. */
const LIVE_QUOTE = "Here is the ledger in one sentence: we publish every company that touches your data.";

describe("briefHeadingPhrases", () => {
  it("takes the whole heading, the heading without its parenthetical, and the parenthetical", () => {
    expect(PHRASES_238).toEqual([
      "shipped since the pillars (the 30 october 2026 release)",
      "shipped since the pillars",
      "the 30 october 2026 release",
    ]);
  });

  it("drops headings under the minimum length, and ignores # and ### headings", () => {
    expect(BRIEF_HEADING_MIN_CHARS).toBe(20);
    for (const phrase of PHRASES_238) {
      expect(phrase.length).toBeGreaterThanOrEqual(BRIEF_HEADING_MIN_CHARS);
    }
    expect(PHRASES_238.join("|")).not.toMatch(/who we are|audience|never say|voice|tone|brand brief|one line/);
  });

  it("is what an engine derives from its pack's brief", () => {
    expect(engine.briefHeadingPhrases()).toEqual(["claim source: shipped features", "the ledger in one sentence"]);
  });
});

describe("findQuotedBriefHeading", () => {
  it("finds the leak through the heading's parenthetical", () => {
    expect(findQuotedBriefHeading(LEAK_238, PHRASES_238)).toBe("the 30 october 2026 release");
  });

  it("ignores case and whitespace, including a line break and an NBSP", () => {
    const nbsp = String.fromCharCode(0xa0);
    const shouted = `WHAT SHIPPED IN THE 30\n  OCTOBER${nbsp}2026   RELEASE`;
    expect(findQuotedBriefHeading(shouted, PHRASES_238)).toBe("the 30 october 2026 release");
  });

  it("does not flag short headings or ordinary copy", () => {
    for (const copy of [
      "Who we are: a Canadian telecommunications company for a growing audience.",
      "Never say never. Our voice and tone stay plain.",
      "Teammates on every plan, shipped on 30 October 2026.",
      "Here is what shipped since the launch.",
    ]) {
      expect(findQuotedBriefHeading(copy, PHRASES_238)).toBeUndefined();
    }
  });

  it("matches only the phrases it is given, and a brandless engine gives none", () => {
    expect(findQuotedBriefHeading(LIVE_QUOTE, engine.briefHeadingPhrases())).toBe("the ledger in one sentence");
    expect(findQuotedBriefHeading(LEAK_238, engine.briefHeadingPhrases())).toBeUndefined();
    expect(NO_BRAND.briefHeadingPhrases()).toEqual([]);
    expect(findQuotedBriefHeading(LIVE_QUOTE, NO_BRAND.briefHeadingPhrases())).toBeUndefined();
  });
});

describe("deterministicChecks: brief-heading-quoted", () => {
  it("fails a render whose content quotes a brief heading, once, with a text fix", () => {
    const issues = headingIssues(
      draftWith([render({ platform: "linkedin", content: `${LIVE_QUOTE} Claim source: SHIPPED features.` })]),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: "fail", platform: "linkedin" });
    // The first phrase in brief order is reported; the ledger heading comes later.
    expect(issues[0]!.message).toContain('"claim source: shipped features"');
    expect(issues[0]!.fix).toBeTruthy();
    expect(isTextFixable(issues[0]!)).toBe(true);
  });

  it.each([
    ["title", render({ platform: "reddit", content: "Plain copy.", title: LIVE_QUOTE })],
    ["first comment", render({ platform: "facebook", content: "Plain copy.", firstComment: LIVE_QUOTE })],
    ["thread reply", render({ platform: "bluesky", content: "Plain copy.", threadItems: ["Reply one.", LIVE_QUOTE] })],
  ])("checks the %s too", (_surface, r) => {
    const issues = headingIssues(draftWith([r]));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.platform).toBe(r.platform);
  });

  it("raises nothing without a brand, whose brief has no headings to quote", () => {
    const draft = draftWith([render({ platform: "linkedin", content: LIVE_QUOTE })]);
    expect(deterministicChecks(draft).filter((i) => i.code === "brief-heading-quoted")).toEqual([]);
  });

  it("passes ordinary copy on every surface", () => {
    const clean = render({
      platform: "bluesky",
      content: "Who we are: a Canadian telecommunications company.",
      title: "Never say never",
      firstComment: "See it answer live at acmebrands.com",
      threadItems: ["Teammates on every plan, shipped on 30 October 2026."],
    });
    expect(headingIssues(draftWith([clean, render({ platform: "linkedin", content: "Plain copy." })]))).toEqual([]);
  });
});
