import { describe, it, expect } from "vitest";
import * as engine from "../index.js";

describe("Social HQ engine barrel (index.ts)", () => {
  it("re-exports types.ts values", () => {
    expect(engine.ALL_PLATFORMS).toBeDefined();
    expect(engine.ALL_PLATFORMS).toEqual([
      "instagram",
      "facebook",
      "threads",
      "twitter",
      "linkedin",
      "youtube",
      "reddit",
      "bluesky",
      "pinterest",
      "tiktok",
    ]);
  });

  it("re-exports specs.ts", () => {
    expect(engine.SPECS).toBeDefined();
    expect(typeof engine.specFor).toBe("function");
    expect(typeof engine.vendorLength).toBe("function");
    expect(typeof engine.specBlock).toBe("function");
    expect(typeof engine.sanitizePlatforms).toBe("function");
    expect(engine.specFor("instagram")).toBe(engine.SPECS.instagram);
  });

  it("re-exports engine.ts and brand-context.ts, and carries no brand of its own", () => {
    expect(typeof engine.createEngine).toBe("function");
    expect(engine.EMPTY_BRAND_PACK).toEqual({ name: "none", brief: "" });
    expect(engine.NO_BRAND.qaGates()).toEqual([]);
    expect(engine.BRIEF_HEADING_MIN_CHARS).toBe(20);
    expect(typeof engine.briefHeadingPhrases).toBe("function");
    expect("BRAND_BRIEF" in engine).toBe(false);
    expect("brandBrief" in engine).toBe(false);
  });

  it("re-exports settings.ts", () => {
    expect(typeof engine.timezone).toBe("function");
    expect(typeof engine.defaults).toBe("function");
    expect(engine.vertexVideoConfig()).toEqual(
      expect.objectContaining({ project: expect.any(String) }),
    );
  });

  it("re-exports claude.ts", () => {
    expect(typeof engine.genJson).toBe("function");
    expect(engine.SOCIAL_TEXT_MODEL).toBe("claude-sonnet-5-5");
    expect(engine.SOCIAL_TEXT_EFFORT).toBe("high");
  });

  /**
   * ⚠️ ZERNIO IS BACK, AND THIS ASSERTION STILL HOLDS. It was written when the
   * vendor was removed, to stop app code reaching a flat engine-wide client
   * (`engine.listAccounts()`, `engine.getPost()`). The vendor returned as an
   * `Aggregator`, and the barrel deliberately exports only
   * `zernioAggregator` / `ZERNIO_ID` / `setZernioTokenResolver`; the raw client
   * lives in `./zernio` and is imported directly from inside the engine.
   *
   * So a failure here does NOT mean "delete the Zernio integration". It means
   * somebody widened the barrel back to a per-vendor API surface, which is what
   * this row exists to prevent.
   */
  it("does NOT re-export any of the retired Zernio names", () => {
    const retired = [
      "ZernioError",
      "listAccounts",
      "listProfiles",
      "connectUrl",
      "getPost",
      "updatePost",
      "retryPost",
      "presignUpload",
      "uploadToPresigned",
      "toMediaItem",
      "analyticsPosts",
      "analyticsDaily",
      "analyticsBestTime",
      "analyticsFrequency",
      "followerStats",
      "queueNextSlot",
      "zernioApiKey",
    ] as const;
    for (const name of retired) {
      expect((engine as Record<string, unknown>)[name]).toBeUndefined();
    }
  });

  it("re-exports media.ts", () => {
    expect(typeof engine.analyzeMedia).toBe("function");
    expect(typeof engine.ensureUploaded).toBe("function");
    expect(typeof engine.readAsBase64).toBe("function");
  });

  it("re-exports format.ts", () => {
    expect(typeof engine.formatPost).toBe("function");
    expect(typeof engine.skippedForMedia).toBe("function");
    expect(typeof engine.generateAltText).toBe("function");
    expect(typeof engine.generateAltTextsFromFiles).toBe("function");
    expect(typeof engine.draftSummaryForPrompt).toBe("function");
  });

  it("re-exports qa.ts", () => {
    expect(typeof engine.deterministicChecks).toBe("function");
    expect(typeof engine.llmReview).toBe("function");
    expect(typeof engine.runQa).toBe("function");
  });

  it("re-exports publish.ts", () => {
    expect(typeof engine.connectedAccounts).toBe("function");
    expect(typeof engine.publishDraft).toBe("function");
    expect(typeof engine.PublishPreflightError).toBe("function");
  });
});
