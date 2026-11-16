import { describe, it, expect } from "vitest";
import { SPECS, specBlock, vendorLength } from "../specs.js";
import { ALL_PLATFORMS } from "../types.js";

/**
 * Threads is a publish-only channel. The thing worth pinning is the numbers
 * that came from the vendor rather than from research.
 */
describe("threads platform", () => {
  const spec = SPECS.threads;

  it("is a known platform", () => {
    expect(ALL_PLATFORMS).toContain("threads");
    expect(spec).toBeDefined();
    expect(spec.platform).toBe("threads");
    expect(spec.displayName).toBe("Threads");
  });

  it("caps text at the 500 chars the vendor schema reports", () => {
    // Verified live against GET /integration-settings/:id (maxLength 500) and
    // Postiz's threads.provider.ts maxLength(). If Threads raises the cap this
    // test should be updated from the live schema, not from memory.
    expect(spec.maxChars).toBe(500);
    expect(spec.threadItemMaxChars).toBe(500);
  });

  it("supports the reply chain used for threads and first comments", () => {
    // Postiz's Threads provider posts value[0] via post() and chains value[1..]
    // through comment() with reply_to_id, the same contract X and Bluesky use,
    // so our existing threadItems/firstComment plumbing needs no special case.
    expect(spec.supportsThreads).toBe(true);
    expect(spec.supportsFirstComment).toBe(true);
  });

  it("allows carousels to mix images and video, unlike Instagram and Facebook", () => {
    expect(spec.mixedMediaAllowed).toBe(true);
    expect(spec.maxImages).toBe(20);
    expect(SPECS.instagram.mixedMediaAllowed).toBe(false);
    expect(SPECS.facebook.mixedMediaAllowed).toBe(false);
  });

  it("does not require media, so text-only posts are publishable", () => {
    expect(spec.requiresMedia).toBe(false);
    expect(spec.requiresVideo).toBe(false);
  });

  it("counts URLs at full length (only X gets the flat 23-char allowance)", () => {
    const content = "shipping notes https://example.com/changelog";
    expect(vendorLength("threads", content)).toBe(content.length);
  });

  it("appears in the prompt spec block with its limit and thread support", () => {
    const block = specBlock(["threads"]);
    expect(block).toContain('### Threads (platform id: "threads")');
    expect(block).toContain("500 chars");
    expect(block).toContain("Threads supported");
  });
});
