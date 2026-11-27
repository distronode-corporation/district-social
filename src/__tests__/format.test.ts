// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../claude.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../claude.js")>()),
  genJson: vi.fn(),
}));

vi.mock("../media.js", () => ({
  readAsBase64: vi.fn(),
}));

import { genJson } from "../claude.js";
import { readAsBase64 } from "../media.js";
import {
  formatPost,
  skippedForMedia,
  generateAltText,
  generateAltTextsFromFiles,
  draftSummaryForPrompt,
} from "../format.js";
import { vendorLength } from "../specs.js";
import type { Draft, MediaAsset, SourcePost } from "../types.js";

const genJsonMock = genJson as unknown as ReturnType<typeof vi.fn>;
const readAsBase64Mock = readAsBase64 as unknown as ReturnType<typeof vi.fn>;

function image(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    path: "/tmp/photo.jpg",
    type: "image",
    mimeType: "image/jpeg",
    size: 1000,
    ...overrides,
  };
}

function video(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    path: "/tmp/clip.mp4",
    type: "video",
    mimeType: "video/mp4",
    size: 5000,
    durationSec: 30,
    ...overrides,
  };
}

function source(overrides: Partial<SourcePost> = {}): SourcePost {
  return {
    text: "We shipped a thing.",
    hashtags: [],
    media: [],
    ...overrides,
  };
}

describe("format", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SOCIALMETA_DEFAULT_SUBREDDIT;
  });

  describe("formatPost", () => {
    it("formats renders for eligible platforms, defaulting mediaIndices to all media when omitted", async () => {
      genJsonMock.mockResolvedValue({
        renders: [
          { platform: "facebook", content: "  Hello Facebook  ", rationale: "friendly" },
        ],
      });
      const src = source({ media: [image(), image({ path: "/tmp/2.jpg" })] });
      const renders = await formatPost(src, ["facebook"]);
      expect(renders).toHaveLength(1);
      expect(renders[0]).toMatchObject({
        platform: "facebook",
        content: "Hello Facebook",
        mediaIndices: [0, 1],
        rationale: "friendly",
      });
      expect(renders[0].title).toBeUndefined();
      expect(renders[0].firstComment).toBeUndefined();
    });

    it("routes a generated card set by aspect ratio regardless of what the model chose", async () => {
      genJsonMock.mockResolvedValue({
        renders: [
          // Omitted mediaIndices used to default to attach-all…
          { platform: "twitter", content: "Tweet body" },
          // …and an explicit multi-attach used to be honoured verbatim. Both
          // shipped three near-identical cards on one post (2026-07-29/30).
          { platform: "instagram", content: "IG caption", mediaIndices: [0, 1, 2] },
        ],
      });
      const cards = [
        image({ path: "ai-card-aaa.png", mimeType: "image/png", width: 1080, height: 1080 }),
        image({ path: "ai-card-bbb.png", mimeType: "image/png", width: 1080, height: 1350 }),
        image({ path: "ai-card-ccc.png", mimeType: "image/png", width: 1080, height: 1620 }),
      ];
      const renders = await formatPost(source({ media: cards }), ["twitter", "instagram"]);
      expect(renders.find((r) => r.platform === "twitter")!.mediaIndices).toEqual([0]);
      expect(renders.find((r) => r.platform === "instagram")!.mediaIndices).toEqual([1]);
    });

    it("asks for structured output: renders constrained to the eligible platforms", async () => {
      genJsonMock.mockResolvedValue({
        renders: [
          { platform: "facebook", content: "x" },
          { platform: "linkedin", content: "y" },
        ],
      });
      await formatPost(source(), ["facebook", "linkedin"]);
      const opts = genJsonMock.mock.calls[0][1] as { schema: Record<string, unknown> };
      expect(opts).toEqual({ schema: expect.any(Object) });
      const item = (opts.schema as {
        properties: { renders: { items: { properties: { platform: { enum: string[] } }; required: string[] } } };
      }).properties.renders.items;
      expect(item.properties.platform.enum).toEqual(["facebook", "linkedin"]);
      expect(item.required).toEqual(["platform", "content"]);
      expect(opts.schema).toMatchObject({ required: ["renders"], additionalProperties: false });
    });

    it("stamps every render with the model that wrote it", async () => {
      genJsonMock.mockResolvedValue({ renders: [{ platform: "facebook", content: "x" }] });
      const [render] = await formatPost(source(), ["facebook"]);
      expect(render!.generatedBy).toEqual({ model: "claude-sonnet-5-5", effort: "high" });
    });

    it("makes no model call when no target is eligible, since there is nothing to write", async () => {
      await expect(formatPost(source({ media: [] }), ["instagram", "youtube"])).resolves.toEqual([]);
      expect(genJsonMock).not.toHaveBeenCalled();
    });

    it("drops unknown platform ids without crashing", async () => {
      genJsonMock.mockResolvedValue({
        renders: [{ platform: "facebook", content: "hi" }],
      });
      const src = source();
      const renders = await formatPost(src, ["facebook", "snapchat" as never]);
      expect(renders).toHaveLength(1);
      expect(renders[0].platform).toBe("facebook");
      // genJson should only be asked about the eligible platform
      const prompt = genJsonMock.mock.calls[0][0] as string;
      expect(prompt).toContain("platform ids exactly: facebook");
    });

    it("drops media-ineligible platforms (requiresMedia / requiresVideo) rather than sending them to the model", async () => {
      genJsonMock.mockResolvedValue({
        renders: [{ platform: "twitter", content: "no media needed" }],
      });
      // instagram requires media, youtube requires video; source has neither.
      const src = source({ media: [] });
      const renders = await formatPost(src, ["instagram", "youtube", "twitter"]);
      expect(renders).toHaveLength(1);
      expect(renders[0].platform).toBe("twitter");
    });

    it("applies the operator-supplied instruction and pool defaults into the prompt", async () => {
      genJsonMock.mockResolvedValue({ renders: [{ platform: "facebook", content: "x" }] });
      await formatPost(source(), ["facebook"], "make it punchier");
      const prompt = genJsonMock.mock.calls[0][0] as string;
      expect(prompt).toContain("make it punchier");
    });

    it("takes the reddit subreddit from settings only, NORMALIZED, and never from the model", async () => {
      // normalizeSubreddit, shared with the publisher, QA and the settings
      // store, not a local `replace(/^r\//, "")`. That copy was
      // case-sensitive and missed a leading slash.
      for (const configured of ["r/AcmeBrands", "/r/AcmeBrands", "R/acmebrands", " acmebrands "]) {
        process.env.SOCIALMETA_DEFAULT_SUBREDDIT = configured;
        genJsonMock.mockResolvedValue({
          renders: [{ platform: "reddit", content: "post body", title: "A title" }],
        });
        const withoutSubreddit = await formatPost(source(), ["reddit"]);
        expect(withoutSubreddit[0].subreddit).toBe("acmebrands");
      }

      // ⛔ The model's subreddit never wins over the operator's: posting to a
      // subreddit the model picked is how a brand account gets banned.
      process.env.SOCIALMETA_DEFAULT_SUBREDDIT = "acmebrands";
      genJsonMock.mockResolvedValue({
        renders: [{ platform: "reddit", content: "post body", title: "A title", subreddit: "r/SaaS" }],
      });
      const withModelSubreddit = await formatPost(source(), ["reddit"]);
      expect(withModelSubreddit[0].subreddit).toBe("acmebrands");
    });

    it("drops a model-supplied subreddit when settings have none", async () => {
      genJsonMock.mockResolvedValue({
        renders: [{ platform: "reddit", content: "post body", title: "A title", subreddit: "r/SaaS" }],
      });
      const renders = await formatPost(source(), ["reddit"]);
      expect(renders[0].subreddit).toBeUndefined();
    });

    it("leaves reddit subreddit undefined when neither the model nor settings provide one", async () => {
      genJsonMock.mockResolvedValue({
        renders: [{ platform: "reddit", content: "post body", title: "A title" }],
      });
      const renders = await formatPost(source(), ["reddit"]);
      expect(renders[0].subreddit).toBeUndefined();
    });

    it("makes the model's item 0 the body and hard-trims both it and each reply", async () => {
      // The prompt asks for the whole thread, root first; a render stores the
      // replies only, so the root must not stay in threadItems (it would post twice).
      const overLong = "a".repeat(300); // twitter maxChars and threadItemMaxChars = 280
      genJsonMock.mockResolvedValue({
        renders: [
          {
            platform: "twitter",
            content: "original short content",
            threadItems: [overLong, "second tweet", "b".repeat(300)],
          },
        ],
      });
      const renders = await formatPost(source(), ["twitter"]);
      const r = renders[0];
      expect(r.content.length).toBeLessThanOrEqual(280);
      expect(r.content.startsWith("aaa")).toBe(true);
      expect(r.content.endsWith("…")).toBe(true);
      expect(r.threadItems).toHaveLength(2);
      expect(r.threadItems![0]).toBe("second tweet"); // untouched, within limit
      expect(r.threadItems![1].length).toBeLessThanOrEqual(280);
      expect(r.threadItems![1].endsWith("…")).toBe(true);
    });

    /**
     * The trim used to measure code points and stop at exactly the limit, so
     * every trimmed post landed on the one boundary where our count and the
     * vendor's disagree. A single emoji then made it one UTF-16 unit over and
     * Postiz refused the publish (2026-07-25, Bluesky).
     */
    it("trims to fit the VENDOR count, not the code-point count", async () => {
      genJsonMock.mockResolvedValue({
        renders: [{ platform: "bluesky", content: "🗣️ " + "word ".repeat(120) }],
      });
      const [r] = await formatPost(source(), ["bluesky"]);
      expect(vendorLength("bluesky", r.content)).toBeLessThanOrEqual(300);
      expect(r.content.endsWith("…")).toBe(true);
    });

    /**
     * Posts at the cap under the vendor's own count, which the Postiz-style
     * count (`&` as 5, a non-breaking space as 6) charged over it and trimmed.
     */
    it("leaves a LinkedIn post at the cap alone even when it carries ampersands", async () => {
      const post = "R&D ".repeat(749) + "R&D.";
      genJsonMock.mockResolvedValue({ renders: [{ platform: "linkedin", content: post }] });
      const [r] = await formatPost(source(), ["linkedin"]);
      expect(r.content).toBe(post);
    });

    it("leaves a Threads post at the cap alone even when it carries non-breaking spaces", async () => {
      const post = "a\u00a0b ".repeat(124) + "a\u00a0b.";
      expect(post.length).toBe(500);
      genJsonMock.mockResolvedValue({ renders: [{ platform: "threads", content: post }] });
      const [r] = await formatPost(source(), ["threads"]);
      expect(r.content).toBe(post);
    });

    /**
     * The trim used to start its scan at `limit` code points, on the claim that
     * the vendor count is never below the code-point count. Graphemes are: a
     * family emoji is 5 code points and 1 grapheme, so a Bluesky post of them
     * was cut to 60 when 299 (plus the ellipsis) fit.
     */
    it("trims a grapheme-counted post to the cap, not to `limit` code points", async () => {
      const family = "\u{1F468}\u200d\u{1F469}\u200d\u{1F467}";
      genJsonMock.mockResolvedValue({ renders: [{ platform: "bluesky", content: family.repeat(400) }] });
      const [r] = await formatPost(source(), ["bluesky"]);
      expect(vendorLength("bluesky", r.content)).toBe(300);
    });

    it("drops the partial token rather than emit a broken link", async () => {
      const filler = "word ".repeat(56); // 280 chars, leaves the URL straddling the cap
      genJsonMock.mockResolvedValue({
        renders: [
          { platform: "bluesky", content: `${filler}See it live: https://acmebrands.com/pricing` },
        ],
      });
      const [r] = await formatPost(source(), ["bluesky"]);
      expect(vendorLength("bluesky", r.content)).toBeLessThanOrEqual(300);
      expect(r.content).not.toMatch(/https?:\/\/\S*…$/);
    });

    it("keeps a hard cut when dropping the partial token would empty the post", async () => {
      genJsonMock.mockResolvedValue({
        renders: [{ platform: "bluesky", content: "x".repeat(400) }],
      });
      const [r] = await formatPost(source(), ["bluesky"]);
      expect(vendorLength("bluesky", r.content)).toBeLessThanOrEqual(300);
      expect(r.content.length).toBeGreaterThan(1);
    });

    it("never splits a surrogate pair when trimming", async () => {
      genJsonMock.mockResolvedValue({
        renders: [{ platform: "bluesky", content: "😀".repeat(200) }],
      });
      const [r] = await formatPost(source(), ["bluesky"]);
      expect(vendorLength("bluesky", r.content)).toBeLessThanOrEqual(300);
      // A high surrogate with no low after it, or a low with no high before
      // it, is half an emoji.
      expect(r.content).not.toMatch(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
      );
    });

    it("trims to the VENDOR's live cap when it is lower than our researched one", async () => {
      // Reddit reports 10,000 through Postiz against Reddit's own ~40,000, and it
      // ENFORCES its number. Trimming to the researched figure let copy through
      // that the publish call then rejected, leaving QA reporting a finding the
      // operator could do nothing about.
      genJsonMock.mockResolvedValue({
        renders: [{ platform: "reddit", title: "T", content: "z".repeat(900) }],
      });
      const snapshot = {
        fetchedAt: "t",
        channels: {
          reddit: {
            platform: "reddit" as const,
            integrationId: "i",
            displayName: "Reddit",
            maxLength: 500,
            settingsSchema: null,
            tools: [],
          },
        },
      };
      const [r] = await formatPost(source(), ["reddit"], undefined, snapshot);
      expect(vendorLength("reddit", r.content)).toBeLessThanOrEqual(500);
    });

    it("does not trim copy the vendor would have accepted", async () => {
      // The X Premium case: a live cap ABOVE the researched 280 means a long root
      // is legal, and trimming it to 280 would be throwing away reach.
      const long = "word ".repeat(120);
      genJsonMock.mockResolvedValue({ renders: [{ platform: "twitter", content: long }] });
      const snapshot = {
        fetchedAt: "t",
        channels: {
          twitter: {
            platform: "twitter" as const,
            integrationId: "i",
            displayName: "X / Twitter",
            maxLength: 25_000,
            settingsSchema: null,
            tools: [],
          },
        },
      };
      const [r] = await formatPost(source(), ["twitter"], undefined, snapshot);
      expect(r.content.endsWith("…")).toBe(false);
      expect(vendorLength("twitter", r.content)).toBeGreaterThan(280);
    });

    it("runs the platform playbooks, so a body link never survives on X", async () => {
      // Guards the wiring, not the transform: the playbook module is tested on its
      // own, but nothing else proves formatPost actually calls it.
      genJsonMock.mockResolvedValue({
        renders: [
          { platform: "twitter", content: "Hook line here.\nSee it: https://acmebrands.com/x" },
        ],
      });
      const [r] = await formatPost(source(), ["twitter"]);
      expect(r.content).not.toContain("https://acmebrands.com/x");
      expect(r.threadItems?.join(" ")).toContain("https://acmebrands.com/x");
    });

    it("trims an over-limit first comment, which is published as its own value", async () => {
      genJsonMock.mockResolvedValue({
        renders: [
          {
            platform: "threads",
            content: "short body",
            firstComment: "c".repeat(600), // threads maxChars = 500
          },
        ],
      });
      const [r] = await formatPost(source(), ["threads"]);
      expect(vendorLength("threads", r.firstComment!)).toBeLessThanOrEqual(500);
    });

    it("leaves thread items untouched when already within the limit", async () => {
      genJsonMock.mockResolvedValue({
        renders: [
          {
            platform: "twitter",
            content: "will be replaced",
            threadItems: ["short one", "short two"],
          },
        ],
      });
      const renders = await formatPost(source(), ["twitter"]);
      expect(renders[0].content).toBe("short one");
      expect(renders[0].threadItems).toEqual(["short two"]);
    });

    it("keeps no thread when the model's thread is the root alone", async () => {
      genJsonMock.mockResolvedValue({
        renders: [{ platform: "twitter", content: "ignored", threadItems: [" only the root "] }],
      });
      const [r] = await formatPost(source(), ["twitter"]);
      expect(r.content).toBe("only the root");
      expect(r.threadItems).toBeUndefined();
    });

    it("throws when the formatter returns no render for an eligible platform", async () => {
      genJsonMock.mockResolvedValue({ renders: [] });
      await expect(formatPost(source(), ["facebook"])).rejects.toThrow(
        "formatter returned no render for facebook",
      );
    });

    it("respects an explicit mediaIndices array from the model instead of defaulting to all media", async () => {
      genJsonMock.mockResolvedValue({
        renders: [{ platform: "facebook", content: "x", mediaIndices: [1] }],
      });
      const src = source({ media: [image(), image({ path: "/tmp/2.jpg" })] });
      const renders = await formatPost(src, ["facebook"]);
      expect(renders[0].mediaIndices).toEqual([1]);
    });

    it("dedupes the model's mediaIndices after the range filter, so one asset never posts twice", async () => {
      genJsonMock.mockResolvedValue({
        renders: [{ platform: "facebook", content: "x", mediaIndices: [1, 0, 1, 7, 0] }],
      });
      const src = source({ media: [image(), image({ path: "/tmp/2.jpg" })] });
      const renders = await formatPost(src, ["facebook"]);
      expect(renders[0].mediaIndices).toEqual([1, 0]);
    });
  });

  describe("skippedForMedia", () => {
    it("flags requiresVideo platforms with no video media", () => {
      const src = source({ media: [image()] });
      expect(skippedForMedia(src, ["youtube"])).toEqual(["youtube"]);
    });

    it("flags requiresMedia platforms with no media at all", () => {
      const src = source({ media: [] });
      expect(skippedForMedia(src, ["instagram"])).toEqual(["instagram"]);
    });

    it("does not flag platforms with no media requirement", () => {
      const src = source({ media: [] });
      expect(skippedForMedia(src, ["twitter"])).toEqual([]);
    });

    it("does not flag requiresVideo/requiresMedia platforms once satisfied", () => {
      const src = source({ media: [video()] });
      expect(skippedForMedia(src, ["youtube", "instagram"])).toEqual([]);
    });

    it("drops unknown platform ids", () => {
      const src = source();
      expect(skippedForMedia(src, ["snapchat" as never])).toEqual([]);
    });
  });

  describe("generateAltText", () => {
    it("returns alt text from the model, capped to 200 chars", async () => {
      genJsonMock.mockResolvedValue({ altText: "A photo of a laptop on a desk" });
      const result = await generateAltText("post text", {
        mimeType: "image/jpeg",
        dataBase64: "abc123",
      });
      expect(result).toBe("A photo of a laptop on a desk");
      expect(genJsonMock).toHaveBeenCalledWith(
        expect.stringContaining("Write concise, factual alt text"),
        expect.objectContaining({ media: [{ mimeType: "image/jpeg", dataBase64: "abc123" }] }),
      );
    });

    it("slices an overlong altText down to 200 chars", async () => {
      genJsonMock.mockResolvedValue({ altText: "x".repeat(250) });
      const result = await generateAltText("post text", {
        mimeType: "image/jpeg",
        dataBase64: "abc123",
      });
      expect(result).toHaveLength(200);
    });

  });

  describe("generateAltTextsFromFiles", () => {
    it("fills alt text for image media missing it, skipping non-images and media that already has alt text", async () => {
      readAsBase64Mock.mockReturnValue("base64data");
      genJsonMock.mockResolvedValue({ altText: "generated alt" });

      const src = source({
        media: [
          image({ path: "/tmp/a.jpg" }), // no altText -> should be filled
          image({ path: "/tmp/b.jpg", altText: "already has alt" }), // skip
          video(), // not an image -> skip
        ],
      });
      await generateAltTextsFromFiles(src);

      expect(src.media[0].altText).toBe("generated alt");
      expect(src.media[1].altText).toBe("already has alt");
      expect(src.media[2].altText).toBeUndefined();
      // only called once, for the single eligible image
      expect(readAsBase64Mock).toHaveBeenCalledTimes(1);
      expect(genJsonMock).toHaveBeenCalledTimes(1);
    });

    it("skips images when readAsBase64 returns null (oversized file)", async () => {
      readAsBase64Mock.mockReturnValue(null);
      const src = source({ media: [image()] });
      await generateAltTextsFromFiles(src);
      expect(src.media[0].altText).toBeUndefined();
      expect(genJsonMock).not.toHaveBeenCalled();
    });

    it("swallows errors from alt-text generation (best-effort) and leaves altText unset", async () => {
      readAsBase64Mock.mockReturnValue("base64data");
      genJsonMock.mockRejectedValue(new Error("model unavailable"));
      const src = source({ media: [image()] });
      await expect(generateAltTextsFromFiles(src)).resolves.toBeUndefined();
      expect(src.media[0].altText).toBeUndefined();
    });
  });

  describe("draftSummaryForPrompt", () => {
    it("serializes the draft source (with slimmed media) and renders as JSON", () => {
      const draft: Draft = {
        id: "d1",
        createdAt: "2026-07-20T00:00:00.000Z",
        updatedAt: "2026-07-20T00:00:00.000Z",
        status: "draft",
        source: source({
          media: [image({ width: 100, height: 200, altText: "alt" })],
        }),
        targets: ["facebook"],
        renders: [
          {
            platform: "facebook",
            content: "hello",
            mediaIndices: [0],
          },
        ],
      };
      const json = draftSummaryForPrompt(draft);
      const parsed = JSON.parse(json);
      expect(parsed.source.text).toBe(draft.source.text);
      expect(parsed.source.media).toEqual([
        {
          type: "image",
          mimeType: "image/jpeg",
          width: 100,
          height: 200,
          durationSec: undefined,
          altText: "alt",
        },
      ]);
      expect(parsed.renders).toEqual(draft.renders);
      // path (filesystem detail) must NOT leak into the LLM-facing summary
      expect(json).not.toContain("/tmp/photo.jpg");
    });
  });
});

describe("format: prompt content and model-output fallbacks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SOCIALMETA_DEFAULT_SUBREDDIT;
  });

  it("describes each media item with its dimensions, duration and alt text, and carries title and notes", async () => {
    genJsonMock.mockResolvedValue({ renders: [{ platform: "youtube", content: "watch" }] });
    const src = source({
      title: "Launch day",
      notes: "keep it calm",
      media: [image({ width: 1080, height: 1350, altText: "the dashboard" }), video({ width: 1920, height: 1080 })],
    });

    await formatPost(src, ["youtube"]);

    const prompt = genJsonMock.mock.calls[0]![0] as string;
    expect(prompt).toContain('[0] image (image/jpeg 1080x1350) alt: "the dashboard"');
    expect(prompt).toContain("[1] video (video/mp4 1920x1080 30s)");
    expect(prompt).toContain("Suggested title: Launch day");
    expect(prompt).toContain("Author notes: keep it calm");
  });

  it("keeps a requiresVideo platform when the source carries a video among other media", async () => {
    genJsonMock.mockResolvedValue({ renders: [{ platform: "youtube", content: "watch" }] });
    const renders = await formatPost(source({ media: [image(), video()] }), ["youtube"]);
    expect(renders.map((r) => r.platform)).toEqual(["youtube"]);
  });

  // The model's media choice on a draft carrying a video is routed by
  // SPECS.publishesVideo: its stray video index on Bluesky is dropped, and an
  // omitted selection is the shape pick (the video for X), never attach-all.
  it("routes the model's media around a video by publishesVideo", async () => {
    genJsonMock.mockResolvedValue({
      renders: [
        { platform: "bluesky", content: "b", mediaIndices: [0, 1] },
        { platform: "twitter", content: "x" },
        { platform: "youtube", content: "y", title: "t", mediaIndices: [1] },
      ],
    });
    const renders = await formatPost(source({ media: [image(), video()] }), ["bluesky", "twitter", "youtube"]);
    expect(renders.find((r) => r.platform === "bluesky")!.mediaIndices).toEqual([0]);
    expect(renders.find((r) => r.platform === "twitter")!.mediaIndices).toEqual([1]);
    expect(renders.find((r) => r.platform === "youtube")!.mediaIndices).toEqual([1]);
    const prompt = genJsonMock.mock.calls[0]![0] as string;
    expect(prompt).toContain("Cannot publish video");
  });

  it("never tells the formatter LinkedIn's link goes to a first comment, which LinkedIn never publishes", async () => {
    genJsonMock.mockResolvedValue({ renders: [{ platform: "linkedin", content: "x" }] });
    await formatPost(source({ link: "https://acmebrands.com/x" }), ["linkedin"]);
    const prompt = genJsonMock.mock.calls[0]![0] as string;
    // linkedin-transport.ts drops render.firstComment, and the playbook keeps
    // LinkedIn's link in the body on purpose.
    expect(prompt).not.toContain("LinkedIn link-in-comments");
    expect(prompt).not.toContain("Facebook and LinkedIn into the first comment");
    expect(prompt).toContain("LinkedIn keeps it in the body");
    expect(prompt).toContain("firstComment is NOT published here");
  });

  it("drops a requiresVideo platform when the source has media but no video", async () => {
    genJsonMock.mockResolvedValue({ renders: [{ platform: "facebook", content: "x" }] });
    const renders = await formatPost(source({ media: [image()] }), ["youtube", "facebook"]);
    expect(renders.map((r) => r.platform)).toEqual(["facebook"]);
  });

  it("trims thread items to the channel cap on a platform with no per-item limit", async () => {
    genJsonMock.mockResolvedValue({
      renders: [{ platform: "facebook", content: "c", threadItems: ["first item", "second item"] }],
    });
    const renders = await formatPost(source(), ["facebook"], undefined, {
      fetchedAt: "2026-09-24T00:00:00.000Z",
      channels: { facebook: { platform: "facebook", maxLength: 8 } },
    });
    expect(renders[0]!.content).toBe("first…");
    expect(renders[0]!.threadItems).toEqual(["second…"]);
  });

  it("includes the rationale in the draft summary only when asked", () => {
    const draft: Draft = {
      id: "d1",
      createdAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-20T00:00:00.000Z",
      status: "draft",
      source: source(),
      targets: ["facebook"],
      renders: [{ platform: "facebook", content: "hello", mediaIndices: [], rationale: "why" }],
    };
    expect(JSON.parse(draftSummaryForPrompt(draft, { includeRationale: true })).renders[0].rationale).toBe("why");
    expect(JSON.parse(draftSummaryForPrompt(draft)).renders[0]).not.toHaveProperty("rationale");
  });
});
