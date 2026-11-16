import { describe, it, expect } from "vitest";
import {
  SPECS,
  specFor,
  vendorLength,
  specBlock,
  sanitizePlatforms,
} from "../specs.js";
import { NO_BRAND } from "../brand-context.js";
import { ALL_PLATFORMS } from "../types.js";

describe("SPECS", () => {
  it("has an entry for every platform in ALL_PLATFORMS", () => {
    for (const p of ALL_PLATFORMS) {
      expect(SPECS[p]).toBeDefined();
    }
    expect(Object.keys(SPECS).sort()).toEqual([...ALL_PLATFORMS].sort());
  });

  it("every spec has the required shape", () => {
    for (const p of ALL_PLATFORMS) {
      const s = SPECS[p];
      expect(s.platform).toBe(p);
      expect(typeof s.displayName).toBe("string");
      expect(s.displayName.length).toBeGreaterThan(0);
      expect(typeof s.maxChars).toBe("number");
      expect(s.maxChars).toBeGreaterThan(0);
      expect(Array.isArray(s.idealHashtags)).toBe(true);
      expect(s.idealHashtags).toHaveLength(2);
      expect(["inline", "end", "firstComment", "none"]).toContain(
        s.hashtagPlacement,
      );
      expect(typeof s.linksClickable).toBe("boolean");
      expect(typeof s.requiresMedia).toBe("boolean");
      expect(typeof s.requiresVideo).toBe("boolean");
      expect(typeof s.publishesVideo).toBe("boolean");
      expect(typeof s.mixedMediaAllowed).toBe("boolean");
      expect(typeof s.titleRequired).toBe("boolean");
      expect(typeof s.supportsFirstComment).toBe("boolean");
      expect(typeof s.supportsThreads).toBe("boolean");
      expect(Array.isArray(s.notes)).toBe(true);
      expect(s.notes.length).toBeGreaterThan(0);
    }
  });

  it("a platform that requires video can publish it (requiresVideo implies publishesVideo)", () => {
    for (const p of ALL_PLATFORMS) {
      if (SPECS[p].requiresVideo) expect(SPECS[p].publishesVideo, p).toBe(true);
    }
  });

  it("publishesVideo is true exactly where a transport implements the video upload", () => {
    // YouTube (resumable upload), X (chunked tweet_video upload), and since
    // 2026-10-02 Instagram Reels, Facebook Page Reels and Threads VIDEO. Flipping a
    // platform here is the whole switch; its transport must ship the upload first.
    //
    // TikTok has no direct transport (our TikTok app is not approved); its
    // video upload is the Zernio aggregator's, which sends the clip as a
    // public URL in `mediaItems`.
    const publishing = ALL_PLATFORMS.filter((p) => SPECS[p].publishesVideo).sort();
    expect(publishing).toEqual(["facebook", "instagram", "threads", "tiktok", "twitter", "youtube"]);
  });

  it("bakes in the notable 2026 platform quirks", () => {
    expect(SPECS.instagram.maxHashtags).toBe(5);
    expect(SPECS.youtube.maxHashtags).toBe(15);
    expect(SPECS.twitter.linksClickable).toBe(true);
    expect(SPECS.twitter.linkPenalty).toBeDefined();
    expect(SPECS.reddit.titleRequired).toBe(true);
    expect(SPECS.youtube.titleRequired).toBe(true);
  });
});

describe("specFor", () => {
  it("returns the exact SPECS entry for a platform", () => {
    for (const p of ALL_PLATFORMS) {
      expect(specFor(p)).toBe(SPECS[p]);
    }
  });
});

describe("vendorLength", () => {
  it("counts plain ASCII text one unit per character", () => {
    expect(vendorLength("bluesky", "hello")).toBe(5);
    expect(vendorLength("instagram", "hello world")).toBe(11);
    expect(vendorLength("linkedin", "")).toBe(0);
  });

  it("counts URLs at full length on non-twitter platforms", () => {
    const content = "check this out https://acmebrands.com/pricing?utm=abc";
    expect(vendorLength("bluesky", content)).toBe(content.length);
  });

  /**
   * The 2026-07-25 production failure, reproduced exactly. The Bluesky render
   * measured 300 code points, so the composer read 300/300 and QA passed it,
   * but Postiz measured 301 UTF-16 units and answered "post is too long,
   * please fix it". 🗣️ is U+1F5E3 + U+FE0F: two code points, three units.
   */
  /**
   * ⚠️ REWRITTEN 2026-08-05. This test used to assert that "🗣️" costs THREE on
   * Bluesky (U+1F5E3 + U+FE0F = 2 code points, 3 UTF-16 units), so that
   * 298 chars + one emoji came to 301 and failed a 300 cap.
   *
   * That was POSTIZ's rule, not Bluesky's. The aggregator measured
   * `String.length` and rejected the post, and this test was written to match
   * the thing that actually refused us. Postiz is deleted, and Bluesky's own
   * lexicon — the one @atproto/api validates against, read from the installed
   * package on 2026-08-05 — says:
   *
   *     text: { type: 'string', maxLength: 3000, maxGraphemes: 300 }
   *
   * So the cap is 300 GRAPHEME CLUSTERS. "🗣️" is one grapheme, and the old
   * expectation had us refusing posts Bluesky would have accepted.
   */
  it("counts grapheme clusters on Bluesky, which is what its lexicon caps", () => {
    const speaking = "🗣️";
    expect(speaking.length).toBe(3); // UTF-16 units, what the old rule charged
    expect([...speaking].length).toBe(2); // code points
    expect(vendorLength("bluesky", speaking)).toBe(1); // graphemes, what Bluesky charges

    // Exactly at the cap, where the old UTF-16 count saw 900 and failed it.
    const atGraphemeLimit = speaking.repeat(300);
    expect(vendorLength("bluesky", atGraphemeLimit)).toBe(300);
  });

  /**
   * The Postiz rule (serialize as HTML, then count) charged these as their
   * entity forms. No live transport serializes HTML: every one sends the body
   * as a JSON string, so each of these characters costs 1.
   */
  it("charges HTML-significant characters 1 each, as the raw JSON string the transports send", () => {
    expect(vendorLength("linkedin", "a & b")).toBe(5);
    expect(vendorLength("linkedin", "5 < 10")).toBe(6);
    expect(vendorLength("linkedin", "10 > 5")).toBe(6);
    expect(vendorLength("linkedin", "a\u00a0b")).toBe(3);
    expect(vendorLength("linkedin", 'say "hi"\nthere')).toBe('say "hi"\nthere'.length);
  });

  it("charges twitter a flat 23 for any link, short or long", () => {
    expect(vendorLength("twitter", "see https://x.co plz")).toBe(4 + 23 + 4);
    // The old max(weighted, raw) charged this link its full 43 characters.
    expect(vendorLength("twitter", "check this out https://acmebrands.com/pricing?utm_source=x")).toBe(15 + 23);
  });

  it("twitter plain text (no URL) counts normally", () => {
    expect(vendorLength("twitter", "no links here")).toBe("no links here".length);
  });

  /**
   * Each is exactly at its platform's cap under the vendor's rule, and was over
   * it under the old Postiz count, so the formatter trimmed it and QA failed
   * it (format.test.ts proves the trim side).
   */
  describe("valid posts the Postiz count over-charged", () => {
    it("a 3000-char LinkedIn post with ampersands fits", () => {
      const post = "R&D ".repeat(750);
      expect(post.length).toBe(3000);
      expect(vendorLength("linkedin", post)).toBe(SPECS.linkedin.maxChars);
    });

    it("a 500-char Threads post with non-breaking spaces fits", () => {
      const post = "9\u00a0am ".repeat(100);
      expect(vendorLength("threads", post)).toBe(SPECS.threads.maxChars);
    });

    it("a 280-weight X post carrying a long UTM link fits", () => {
      const url = "https://acmebrands.com/pricing?utm_source=x&utm_campaign=launch";
      const post = `${"a".repeat(256)} ${url}`;
      expect(vendorLength("twitter", post)).toBe(280);
    });
  });
});

/**
 * The notes go into the formatter and QA prompts verbatim, so a note quoting a
 * figure the fields have moved past tells the model the wrong limit.
 */
describe("platform notes agree with the spec fields", () => {
  const notes = (p: keyof typeof SPECS) => SPECS[p].notes.join("\n");

  it("Threads quotes its own cap and no longer claims a Postiz-schema provenance", () => {
    expect(notes("threads")).toContain(`${SPECS.threads.maxChars} chars max`);
    expect(notes("threads")).not.toContain("channel's own schema");
  });

  it("Bluesky quotes the video duration and size the fields hold", () => {
    const mb = SPECS.bluesky.maxVideoBytes! / (1024 * 1024);
    expect(notes("bluesky")).toContain(`(${SPECS.bluesky.maxVideoSec}s/${mb}MB)`);
    expect(notes("bluesky")).not.toContain("60s/50MB");
  });

  it("Pinterest quotes its description cap", () => {
    expect(notes("pinterest")).toContain(`${SPECS.pinterest.maxChars}-char description`);
    expect(notes("pinterest")).not.toContain("500-char");
  });
});

describe("specBlock", () => {
  it("returns a section per requested platform, joined by blank lines", () => {
    const block = specBlock(["instagram", "twitter"]);
    const sections = block.split("\n\n");
    expect(sections).toHaveLength(2);
    expect(sections[0]).toContain('### Instagram (platform id: "instagram")');
    expect(sections[1]).toContain('### X / Twitter (platform id: "twitter")');
  });

  it("includes hard limit, truncation, hashtags, and links lines", () => {
    const block = specBlock(["instagram"]);
    expect(block).toContain("Hard limit: 2200 chars");
    expect(block).toContain('see more');
    expect(block).toContain("Hashtags: ideal 3-5");
    expect(block).toContain("hard cap 5");
    expect(block).toContain("Links clickable: NO");
  });

  it("omits the truncation clause when a platform has no truncationPoint", () => {
    const block = specBlock(["reddit"]);
    expect(block).not.toContain("see more");
    // Reads the spec rather than hardcoding the number: this test is about the
    // truncation clause being ABSENT, and the limit line being present at all.
    // It previously pinned "10000", so correcting Reddit's stale Postiz-era cap
    // to 40,000 failed it for a reason unrelated to what it checks. A test that
    // fails when an unrelated fact changes teaches people to edit tests to make
    // builds green. specs-transport-drift.test.ts is what guards the VALUE.
    expect(block).toContain(`Hard limit: ${SPECS.reddit.maxChars} chars`);
  });

  it("includes a title-required line only for platforms that require one", () => {
    const withTitle = specBlock(["youtube"]);
    expect(withTitle).toContain("Title REQUIRED (max 100 chars)");
    const withoutTitle = specBlock(["bluesky"]);
    expect(withoutTitle).not.toContain("Title REQUIRED");
  });

  it("distinguishes requiresVideo vs requiresMedia vs neither", () => {
    expect(specBlock(["youtube"])).toContain("Requires a VIDEO");
    expect(specBlock(["instagram"])).toContain("Requires media");
    expect(specBlock(["instagram"])).not.toContain("Requires a VIDEO");
    const neither = specBlock(["twitter"]);
    expect(neither).not.toContain("Requires a VIDEO");
    expect(neither).not.toContain("Requires media");
  });

  it("tells the formatter which platforms cannot publish video, and only those", () => {
    expect(specBlock(["bluesky"])).toContain("Cannot publish video");
    expect(specBlock(["twitter"])).not.toContain("Cannot publish video");
    expect(specBlock(["youtube"])).not.toContain("Cannot publish video");
  });

  it("includes threads and firstComment lines only when supported", () => {
    const threads = specBlock(["twitter"]);
    expect(threads).toContain("Threads supported (280 chars/item)");
    const noThreads = specBlock(["facebook"]);
    expect(noThreads).not.toContain("Threads supported");

    const firstComment = specBlock(["instagram"]);
    expect(firstComment).toContain("firstComment supported");
    const noFirstComment = specBlock(["twitter"]);
    expect(noFirstComment).not.toContain("firstComment supported");
  });

  it("tells the model LinkedIn and YouTube publish no first comment, whatever SPECS declares", () => {
    // Both declare supportsFirstComment, and both transports drop the field
    // (publish.ts sentValues). Telling a model "firstComment supported" there is
    // how a LinkedIn link got moved to a place that never goes out.
    for (const p of ["linkedin", "youtube"] as const) {
      const block = specBlock([p]);
      expect(block).not.toContain("firstComment supported");
      expect(block).toContain("firstComment is NOT published here");
    }
    for (const p of ["instagram", "facebook", "threads"] as const) {
      expect(specBlock([p])).toContain("firstComment supported");
    }
    // A platform that never declared one says nothing either way, as before.
    expect(specBlock(["twitter"])).not.toContain("firstComment is NOT published");
  });

  it("includes every note line for the platform, placeholders filled", () => {
    const block = specBlock(["reddit"]);
    for (const note of SPECS.reddit.notes) {
      expect(block).toContain(note.replaceAll("{brand}", "the brand"));
    }
    expect(block).toContain("Subreddit fit for the brand: r/SaaS");
    expect(block).not.toContain("{brand}");
  });

  it("fills the brand's name and first link domain when one is bound", () => {
    const brand = { ...NO_BRAND, brandName: () => "Acmebrands", linkDomains: () => ["acmebrands.com"] };
    expect(specBlock(["reddit"], brand)).toContain("Subreddit fit for Acmebrands: r/SaaS");
    expect(specBlock(["bluesky"], brand)).toContain("(e.g. acmebrands.com, no UTM tags)");
    expect(specBlock(["bluesky"])).toContain("(e.g. example.com, no UTM tags)");
  });

  it("returns an empty string for an empty platform list", () => {
    expect(specBlock([])).toBe("");
  });
});

describe("sanitizePlatforms", () => {
  it("filters unknown platform ids", () => {
    expect(sanitizePlatforms(["instagram", "myspace", "twitter"])).toEqual([
      "instagram",
      "twitter",
    ]);
  });

  it("dedupes while preserving first-seen order", () => {
    expect(
      sanitizePlatforms(["twitter", "instagram", "twitter", "instagram"]),
    ).toEqual(["twitter", "instagram"]);
  });

  it("ignores non-string entries", () => {
    expect(sanitizePlatforms(["instagram", 42, null, {}, undefined, true])).toEqual([
      "instagram",
    ]);
  });

  it("returns [] for non-array input", () => {
    expect(sanitizePlatforms(undefined)).toEqual([]);
    expect(sanitizePlatforms(null)).toEqual([]);
    expect(sanitizePlatforms("instagram")).toEqual([]);
    expect(sanitizePlatforms({ instagram: true })).toEqual([]);
    expect(sanitizePlatforms(42)).toEqual([]);
  });

  it("returns [] for an empty array", () => {
    expect(sanitizePlatforms([])).toEqual([]);
  });

  it("accepts all known platforms", () => {
    expect(sanitizePlatforms([...ALL_PLATFORMS])).toEqual([...ALL_PLATFORMS]);
  });
});
