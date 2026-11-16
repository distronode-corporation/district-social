import { describe, it, expect } from "vitest";

import { NO_BRAND } from "../brand-context.js";
import { complianceChecks, deterministicChecks, isTextFixable } from "../qa.js";
import type { Draft, PlatformRender } from "../types.js";

/**
 * Deterministic (code-only, non-LLM) compliance gates. Generated copy cannot
 * cite a real customer, so any attributed customer praise is treated as
 * fabricated and must hard-fail. Each gate below has a triggering case and a
 * near-miss that must NOT trigger.
 */

function draftWith(renders: PlatformRender[], sourceText = "source text"): Draft {
  return {
    id: "d1",
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
    status: "draft",
    source: { text: sourceText, hashtags: [], media: [] },
    targets: renders.map((r) => r.platform),
    renders,
  };
}

function render(
  overrides: Partial<PlatformRender> & { platform: PlatformRender["platform"] },
): PlatformRender {
  return { content: "", mediaIndices: [], ...overrides };
}

/** Convenience: build a single-render draft whose bluesky content is `content`. */
function draftText(content: string): Draft {
  return draftWith([render({ platform: "bluesky", content })]);
}

function codes(draft: Draft): string[] {
  return complianceChecks(draft).map((i) => i.code);
}

describe("complianceChecks", () => {
  describe("gate 1: fabricated-testimonial (fail)", () => {
    it("flags a quote attributed to a named customer role", () => {
      const draft = draftText(
        'District AI is amazing. "It answers every call and books appointments while I sleep." - Sarah, dental office manager',
      );
      const issue = complianceChecks(draft).find((i) => i.code === "fabricated-testimonial");
      expect(issue).toMatchObject({ severity: "fail", platform: "bluesky" });
      expect(issue!.fix).toBeTruthy();
    });

    it("flags 'our customers say' attribution", () => {
      expect(codes(draftText("Our customers say it pays for itself in a week."))).toContain(
        "fabricated-testimonial",
      );
    });

    it("flags star-rating and review-site claims", () => {
      expect(codes(draftText("Rated 4.9 stars by small businesses everywhere."))).toContain(
        "fabricated-testimonial",
      );
      expect(codes(draftText("See our 5-star Trustpilot reviews."))).toContain(
        "fabricated-testimonial",
      );
    });

    it("does NOT flag a quoted product keyword with no attribution", () => {
      // A quoted feature name / keyword is not a testimonial.
      expect(
        codes(draftText('Meet your new "AI receptionist" that answers every call.')),
      ).not.toContain("fabricated-testimonial");
    });
  });

  describe("gate 2: compliance-language (fail)", () => {
    it("flags absolute regulatory claims", () => {
      expect(codes(draftText("District AI is fully PIPEDA compliant and HIPAA compliant.")))
        .toContain("compliance-language");
      expect(codes(draftText("Your data never leaves Canada."))).toContain("compliance-language");
      expect(codes(draftText("We are fully compliant with PIPEDA."))).toContain(
        "compliance-language",
      );
    });

    it("does NOT flag approved phrasing (built for PIPEDA / PIPEDA-aligned / PHIPA-ready)", () => {
      expect(
        codes(draftText("District AI is built for PIPEDA, PIPEDA-aligned, and PHIPA-ready.")),
      ).not.toContain("compliance-language");
    });
  });

  describe("gate 3: earnings-claims (fail)", () => {
    it("flags guarantees and quantified income/booking promises", () => {
      expect(codes(draftText("Guaranteed to never miss a call again."))).toContain(
        "earnings-claims",
      );
      expect(codes(draftText("District AI will double your bookings this month."))).toContain(
        "earnings-claims",
      );
      expect(codes(draftText("It adds $5,000 to your monthly revenue."))).toContain(
        "earnings-claims",
      );
    });

    it("does NOT flag aspirational phrasing with no guarantee or figure", () => {
      expect(codes(draftText("So you never miss another call."))).not.toContain("earnings-claims");
    });
  });

  describe("gate 4: incentivized-review (fail)", () => {
    it("flags offering something in exchange for a review", () => {
      expect(codes(draftText("Leave a review and get a free month of District AI.")))
        .toContain("incentivized-review");
      expect(codes(draftText("Review us for a chance to win a gift card."))).toContain(
        "incentivized-review",
      );
      expect(codes(draftText("Free month for a review of our service."))).toContain(
        "incentivized-review",
      );
    });

    it("does NOT flag simply asking for a review with no incentive", () => {
      expect(codes(draftText("We'd love a review if you have a moment."))).not.toContain(
        "incentivized-review",
      );
    });
  });

  describe("gate 5: unverified-superlatives (warn)", () => {
    it("flags an unqualified superlative as a warning (not a fail)", () => {
      const issue = complianceChecks(
        draftText("District AI is the best receptionist you can buy."),
      ).find((i) => i.code === "unverified-superlatives");
      expect(issue).toMatchObject({ severity: "warn" });
    });

    it("does NOT flag a verified per-minute superlative with a market anchor", () => {
      expect(
        codes(
          draftText(
            "District AI offers the verified cheapest per-minute rate in the named-brand market.",
          ),
        ),
      ).not.toContain("unverified-superlatives");
    });
  });

  describe("⛔ gate 6 RETIRED: french-quebec no longer exists", () => {
    /**
     * The gate warned on any Quebec mention because "the French-language site
     * and UI do not exist yet (Bill 96)". FR_LAUNCHED went true on 2026-09-08
     * and the whole public site now has an indexed French twin at /fr, so the
     * premise is false and the gate is deleted (src/qa.ts).
     *
     * ⚠️ These are `not.toContain` assertions ON PURPOSE, the same shape the
     * expired residency claims use: a copy-paste that revives the gate reds CI
     * instead of quietly reintroducing a warning whose reason has gone.
     */
    it("does NOT flag Quebec-targeted marketing now that the French site is live", () => {
      expect(codes(draftText("Attention Quebec businesses: never miss a call again."))).not.toContain(
        "french-quebec",
      );
      // The accented spellings were their own trigger — they were enough on
      // their own to warn, and are now ordinary copy.
      expect(codes(draftText("Nous servons les entreprises de Montréal et de Québec."))).not.toContain(
        "french-quebec",
      );
    });

    it("still flags a real compliance problem in the same Quebec copy", () => {
      // The companion assertion that keeps the one above honest: an empty gate
      // list would satisfy every `not.toContain` in this block while silently
      // disabling the four FAIL-tier gates too.
      expect(
        codes(draftText("Quebec businesses: guaranteed to double your bookings.")),
      ).toContain("earnings-claims");
    });
  });

  describe("gates 7 and 8 live in a brand pack", () => {
    // positioning-terms and recordings-claim are one brand's rules, so a
    // brandless engine raises neither; a brand that wants them ships them in
    // its own pack, with its own cases.
    it("raises neither without a brand", () => {
      const issues = complianceChecks(draftText("Unlimited minutes and call recordings included."));
      expect(issues.map((i) => i.code)).toEqual([]);
    });

    it("runs a brand's gates after the engine's own, attributed and named like them", () => {
      const brand = {
        ...NO_BRAND,
        brandBrief: () => "",
        briefHeadingPhrases: () => [],
        qaGates: () => [
          {
            code: "brand-word",
            severity: "fail" as const,
            message: "Brand word.",
            fix: "Drop it.",
            detect: (text: string) => /\bwidget\b/i.test(text),
            found: (text: string) => /\bwidget\b/i.exec(text)?.[0],
          },
        ],
      };
      const draft = draftWith(
        [render({ platform: "linkedin", content: "Guaranteed: one Widget per call." })],
        "A clean source.",
      );
      expect(complianceChecks(draft, brand)).toEqual([
        expect.objectContaining({ code: "earnings-claims", platform: "linkedin" }),
        {
          severity: "fail",
          platform: "linkedin",
          code: "brand-word",
          message: 'Brand word. Found: "Widget".',
          fix: "Drop it.",
        },
      ]);
    });
  });

  describe("issue messages", () => {
    it("leaves the message untouched on a gate that does not name its match", () => {
      const issue = complianceChecks(draftText("Guaranteed results.")).find(
        (i) => i.code === "earnings-claims",
      );
      expect(issue!.message).not.toContain("Found:");
    });
  });

  describe("surface coverage", () => {
    it("scans source.text (global issue, no platform) as well as renders", () => {
      const draft = draftWith(
        [render({ platform: "bluesky", content: "clean render copy" })],
        "Our customers say it changed their business.",
      );
      const issue = complianceChecks(draft).find((i) => i.code === "fabricated-testimonial");
      expect(issue).toBeDefined();
      expect(issue!.platform).toBeUndefined();
    });

    it("scans firstComment and threadItems, attributing to the render's platform", () => {
      const draft = draftWith([
        render({
          platform: "twitter",
          content: "clean starter",
          threadItems: ["still clean", "Guaranteed to double your revenue."],
        }),
      ]);
      const issue = complianceChecks(draft).find((i) => i.code === "earnings-claims");
      expect(issue).toMatchObject({ severity: "fail", platform: "twitter" });
    });

    /**
     * ⛔ AN EMPTY SURFACE MUST NOT MAKE THE GATE GO QUIET.
     *
     * Surfaces are scanned source-first and the FIRST hit wins the attribution,
     * so which surfaces exist decides both whether a gate fires and who gets
     * blamed. Both of these drafts are ordinary: a media-led post carries no
     * source prose, and the formatter drops a render to empty strings whenever
     * a platform is skipped. If either empty surface were kept and scanned, or
     * if its absence stopped the loop, a violation would ship unreported.
     */
    it("scans the renders of a media-led draft that carries no source prose", () => {
      const draft = draftWith(
        [render({ platform: "bluesky", content: "Rated 4.9 stars by every clinic we work with." })],
        "   ",
      );
      const issue = complianceChecks(draft).find((i) => i.code === "fabricated-testimonial");
      // Attributed to the render, because there is no source surface to win it.
      expect(issue).toMatchObject({ severity: "fail", platform: "bluesky" });
    });

    it("keeps the source attribution when a render has no text at all", () => {
      const draft = draftWith(
        [render({ platform: "instagram", content: "" }), render({ platform: "bluesky", content: "clean" })],
        "Our customers say it pays for itself.",
      );
      const issues = complianceChecks(draft).filter((i) => i.code === "fabricated-testimonial");
      expect(issues).toHaveLength(1);
      // Global, not pinned to the empty Instagram render.
      expect(issues[0].platform).toBeUndefined();
    });

    it("emits at most one issue per gate per draft (deduped by code)", () => {
      const draft = draftWith(
        [
          render({ platform: "twitter", content: "Our customers say it's great." }),
          render({ platform: "linkedin", content: "Our customers say it's great." }),
        ],
        "Our customers say it's great.",
      );
      expect(codes(draft).filter((c) => c === "fabricated-testimonial")).toHaveLength(1);
    });
  });

  describe("wiring into deterministicChecks / QA gating", () => {
    it("compliance issues are produced by deterministicChecks (the skipLlm entry point)", () => {
      const draft = draftText("Our customers say it pays for itself.");
      expect(deterministicChecks(draft).some((i) => i.code === "fabricated-testimonial")).toBe(true);
    });

    it("a fabricated testimonial is a fail (would block publishing)", () => {
      const draft = draftText('"Best decision we ever made." - Mark, clinic owner');
      const issues = deterministicChecks(draft);
      expect(issues.some((i) => i.code === "fabricated-testimonial" && i.severity === "fail")).toBe(
        true,
      );
    });

    it("compliance fails are NOT auto-fixable (human-owned, kept out of the AI fix pass)", () => {
      const draft = draftText("Fully PIPEDA compliant.");
      const issue = deterministicChecks(draft).find((i) => i.code === "compliance-language");
      expect(issue).toBeDefined();
      expect(isTextFixable(issue!)).toBe(false);
    });

    it("a clean promotional draft trips no compliance gate", () => {
      const draft = draftText(
        "District AI answers your calls and books appointments, built for PIPEDA and available across Canada.",
      );
      expect(complianceChecks(draft)).toEqual([]);
    });
  });
});
