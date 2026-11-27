// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../claude.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../claude.js")>()),
  genJson: vi.fn(),
}));

import { genJson } from "../claude.js";
import {
  applyMechanicalFixes,
  outstandingIssues,
  reviseRenders,
  stripEmDashes,
} from "../revise.js";
import { deterministicChecks, isMechanicallyFixable, qaScore, runQa } from "../qa.js";
import type { Draft, MediaAsset, PlatformRender, QAIssue, QAReport } from "../types.js";

const MB = 1024 * 1024;

const genJsonMock = genJson as unknown as ReturnType<typeof vi.fn>;

function draftWith(renders: PlatformRender[], media: MediaAsset[] = []): Draft {
  return {
    id: "d1",
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
    status: "draft",
    source: { text: "source text", hashtags: [], media, link: "https://acmebrands.com" },
    targets: renders.map((r) => r.platform),
    renders,
  };
}

function render(
  overrides: Partial<PlatformRender> & { platform: PlatformRender["platform"] },
): PlatformRender {
  return { content: "", mediaIndices: [], ...overrides };
}

function image(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return { path: "/tmp/photo.jpg", type: "image", mimeType: "image/jpeg", size: 1000, ...overrides };
}

function video(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return { path: "/tmp/clip.mp4", type: "video", mimeType: "video/mp4", size: 1000, ...overrides };
}

/** The deterministic issues a draft actually has, which is what the fix loop feeds in. */
function issuesFor(draft: Draft): QAIssue[] {
  return deterministicChecks(draft);
}

describe("stripEmDashes", () => {
  it("replaces a spaced em-dash with a comma", () => {
    expect(stripEmDashes("Answer every call — even after hours.")).toBe(
      "Answer every call, even after hours.",
    );
  });

  it("replaces an unspaced em-dash", () => {
    expect(stripEmDashes("calls—answered")).toBe("calls, answered");
  });

  it("does not leave a comma stranded before punctuation", () => {
    expect(stripEmDashes("Book it —.")).toBe("Book it.");
  });

  it("leaves text without em-dashes untouched", () => {
    expect(stripEmDashes("Plain copy, nothing to do.")).toBe("Plain copy, nothing to do.");
  });

  // ⛔ The inline rule used to eat the newline around a dash, so a dash-bulleted
  // list collapsed to "shipped:, Faster calls, French portal" and a sign-off to
  // "Done., Alex", and the fix loop kept it because the em-dash warn cleared.
  it("turns a line-leading dash into a hyphen bullet and keeps every line", () => {
    expect(
      stripEmDashes("Three things we shipped:\n— Faster calls\n— French portal\n— Better QA"),
    ).toBe("Three things we shipped:\n- Faster calls\n- French portal\n- Better QA");
    expect(stripEmDashes("Done.\n\n— Alex")).toBe("Done.\n\n- Alex");
    expect(stripEmDashes("List:\n  —Indented")).toBe("List:\n  - Indented");
  });

  it("keeps the line break after a line-ending dash and the paragraph after it", () => {
    expect(stripEmDashes("Wait for it —\nthen go.")).toBe("Wait for it\nthen go.");
    expect(stripEmDashes("One —\n\nTwo.")).toBe("One\n\nTwo.");
  });

  it("still joins inline dashes with commas", () => {
    expect(stripEmDashes("Fast — reliable — cheap.")).toBe("Fast, reliable, cheap.");
  });
});

describe("applyMechanicalFixes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("moves an X body link into a thread reply and leaves the body link-free", () => {
    const draft = draftWith([
      render({
        platform: "twitter",
        content: "No more phone tag. Your calendar stays accurate.\n\nSee it live: https://acmebrands.com",
      }),
    ]);
    const result = applyMechanicalFixes(draft, issuesFor(draft));

    expect(result.changed).toEqual(["twitter"]);
    const r = draft.renders[0]!;
    expect(r.content).not.toContain("https://");
    // Replies only: the body is `content` and the link is the one reply.
    expect(r.threadItems).toHaveLength(1);
    expect(r.threadItems![0]).toContain("https://acmebrands.com");
    // The whole point: re-running QA no longer reports the link penalty.
    expect(deterministicChecks(draft).some((i) => i.code === "link-penalty")).toBe(false);
  });

  it("gives a bare-URL link reply a CTA lead-in (X rejects link-only replies)", () => {
    // A long line keeps its prose and gives up only the URL, so the moved
    // linkText is the naked URL — exactly the reply X refused four times
    // between 07-27 and 07-30 ("Unknown Error" on the comment chain).
    const long = `${"Great copy that keeps going. ".repeat(8)}https://acmebrands.com`;
    const draft = draftWith([render({ platform: "twitter", content: long })]);
    applyMechanicalFixes(draft, issuesFor(draft));
    const reply = draft.renders[0]!.threadItems!.at(-1)!;
    expect(reply).toContain("https://acmebrands.com");
    expect(reply).not.toMatch(/^https:\/\//);
    expect(reply.replace(/https:\/\/\S+/g, "").trim().length).toBeGreaterThan(0);
  });

  it("picks the same CTA for the same post on re-entry (no reshuffling between fix rounds)", () => {
    const long = `${"Stable body copy here. ".repeat(8)}https://acmebrands.com`;
    const a = draftWith([render({ platform: "twitter", content: long })]);
    const b = draftWith([render({ platform: "twitter", content: long })]);
    applyMechanicalFixes(a, issuesFor(a));
    applyMechanicalFixes(b, issuesFor(b));
    expect(a.renders[0]!.threadItems!.at(-1)).toBe(b.renders[0]!.threadItems!.at(-1));
  });

  it("shrinks a duplicate card-set attach to the platform's best crop", () => {
    const cards = [
      image({ path: "ai-card-aaa.png", mimeType: "image/png", width: 1080, height: 1080 }),
      image({ path: "ai-card-bbb.png", mimeType: "image/png", width: 1080, height: 1350 }),
      image({ path: "ai-card-ccc.png", mimeType: "image/png", width: 1080, height: 1620 }),
    ];
    const draft = draftWith(
      [render({ platform: "instagram", content: "Caption", mediaIndices: [0, 1, 2] })],
      cards,
    );
    const before = issuesFor(draft);
    expect(before.some((i) => i.code === "duplicate-media-attach")).toBe(true);
    const result = applyMechanicalFixes(draft, before);
    expect(result.changed).toEqual(["instagram"]);
    expect(draft.renders[0]!.mediaIndices).toEqual([1]);
    expect(issuesFor(draft).some((i) => i.code === "duplicate-media-attach")).toBe(false);
  });

  it("drops a stored leading copy of the body rather than posting the opening twice", () => {
    const draft = draftWith([
      render({
        platform: "twitter",
        content: "Hook line.\nhttps://acmebrands.com",
        threadItems: ["Hook line.\nhttps://acmebrands.com", "Second beat."],
      }),
    ]);
    applyMechanicalFixes(draft, issuesFor(draft));
    const r = draft.renders[0]!;
    expect(r.content).toBe("Hook line.");
    expect(r.threadItems).toHaveLength(2);
    expect(r.threadItems![0]).toBe("Second beat.");
    expect(r.threadItems![1]).toContain("https://acmebrands.com");
  });

  it("moves a Facebook body link into the first comment", () => {
    const draft = draftWith([
      render({
        platform: "facebook",
        content: "District AI books appointments 24/7.\n\nTry it: https://acmebrands.com",
      }),
    ]);
    applyMechanicalFixes(draft, issuesFor(draft));
    const r = draft.renders[0]!;
    expect(r.content).not.toContain("https://");
    expect(r.firstComment).toContain("https://acmebrands.com");
    expect(deterministicChecks(draft).some((i) => i.code === "link-penalty")).toBe(false);
  });

  it("does not duplicate a link the first comment already carries", () => {
    const draft = draftWith([
      render({
        platform: "facebook",
        content: "Body copy. https://acmebrands.com",
        firstComment: "Experience it live: https://acmebrands.com",
      }),
    ]);
    applyMechanicalFixes(draft, issuesFor(draft));
    const r = draft.renders[0]!;
    expect(r.content).not.toContain("https://");
    expect(r.firstComment!.match(/https:\/\//g)).toHaveLength(1);
  });

  it("rewrites an unclickable Instagram link as link-in-bio", () => {
    const draft = draftWith(
      [
        render({
          platform: "instagram",
          content: "Book while you sleep.\n\nhttps://acmebrands.com",
          mediaIndices: [0],
        }),
      ],
      [image()],
    );
    applyMechanicalFixes(draft, issuesFor(draft));
    const r = draft.renders[0]!;
    expect(r.content).not.toContain("https://");
    expect(r.content.toLowerCase()).toContain("link in bio");
    expect(deterministicChecks(draft).some((i) => i.code === "dead-link")).toBe(false);
  });

  it("strips every hashtag from a Reddit post", () => {
    const draft = draftWith([
      render({ platform: "reddit", content: "Built this. #saas #ai", subreddit: "SaaS", title: "T" }),
    ]);
    applyMechanicalFixes(draft, issuesFor(draft));
    expect(draft.renders[0]!.content).toBe("Built this.");
    expect(deterministicChecks(draft).some((i) => i.code === "reddit-hashtags")).toBe(false);
  });

  it("trims hashtags down to the platform cap", () => {
    const draft = draftWith(
      [
        render({
          platform: "instagram",
          content: "Caption #a #b #c #d #e #f #g",
          mediaIndices: [0],
        }),
      ],
      [image()],
    );
    applyMechanicalFixes(draft, issuesFor(draft));
    const tags = draft.renders[0]!.content.match(/#\w+/g) ?? [];
    expect(tags).toHaveLength(5);
    expect(deterministicChecks(draft).some((i) => i.code === "hashtag-cap")).toBe(false);
  });

  it("replaces em-dashes across every text surface", () => {
    const draft = draftWith([
      render({
        platform: "bluesky",
        content: "Calls — answered.",
        threadItems: ["Calls — answered.", "Bookings — confirmed."],
      }),
    ]);
    applyMechanicalFixes(draft, issuesFor(draft));
    const r = draft.renders[0]!;
    expect(r.content).not.toContain("—");
    expect(r.threadItems!.every((t) => !t.includes("—"))).toBe(true);
  });

  it("drops the mismatched attachments when a platform cannot mix media", () => {
    const draft = draftWith(
      [render({ platform: "bluesky", content: "Look", mediaIndices: [0, 1] })],
      [image(), video()],
    );
    applyMechanicalFixes(draft, issuesFor(draft));
    expect(draft.renders[0]!.mediaIndices).toEqual([0]);
    expect(deterministicChecks(draft).some((i) => i.code === "mixed-media")).toBe(false);
  });

  it("trims past the per-platform image maximum", () => {
    const media = Array.from({ length: 6 }, () => image());
    const draft = draftWith(
      [render({ platform: "twitter", content: "Gallery", mediaIndices: [0, 1, 2, 3, 4, 5] })],
      media,
    );
    applyMechanicalFixes(draft, issuesFor(draft));
    expect(draft.renders[0]!.mediaIndices).toHaveLength(4);
  });

  it("drops an image too large for Bluesky, which posts fine without it", () => {
    const draft = draftWith(
      [render({ platform: "bluesky", content: "Look at this", mediaIndices: [0] })],
      [image({ size: 2 * MB })], // Bluesky caps images at 1MB.
    );
    const result = applyMechanicalFixes(draft, issuesFor(draft));
    expect(draft.renders[0]!.mediaIndices).toEqual([]);
    expect(result.changed).toEqual(["bluesky"]);
    expect(deterministicChecks(draft).some((i) => i.code === "image-too-large")).toBe(false);
  });

  it("keeps a within-limit image while dropping only the oversized one", () => {
    const draft = draftWith(
      [render({ platform: "bluesky", content: "Two", mediaIndices: [0, 1] })],
      [image({ size: 500 * 1024 }), image({ size: 2 * MB })],
    );
    applyMechanicalFixes(draft, issuesFor(draft));
    expect(draft.renders[0]!.mediaIndices).toEqual([0]);
  });

  it("does NOT drop an oversized image from a platform that requires media", () => {
    // Instagram requires an image, so dropping it would leave it publishable as
    // nothing; the issue must remain for the operator (a smaller upload).
    const draft = draftWith(
      [render({ platform: "instagram", content: "Caption", mediaIndices: [0] })],
      [image({ size: 40 * MB })], // over IG's 30MB cap
    );
    applyMechanicalFixes(draft, issuesFor(draft));
    expect(draft.renders[0]!.mediaIndices).toEqual([0]);
    expect(deterministicChecks(draft).some((i) => i.code === "image-too-large")).toBe(true);
  });
});

describe("isMechanicallyFixable", () => {
  it("treats an oversized image on an optional-media platform as fixable", () => {
    expect(
      isMechanicallyFixable({ severity: "fail", platform: "bluesky", code: "image-too-large", message: "" }),
    ).toBe(true);
  });

  it("treats an oversized image on a required-media platform as NOT fixable", () => {
    expect(
      isMechanicallyFixable({ severity: "fail", platform: "instagram", code: "image-too-large", message: "" }),
    ).toBe(false);
  });

  it("covers the copy-mechanical codes regardless of platform", () => {
    expect(isMechanicallyFixable({ severity: "warn", code: "brand-em-dash", message: "" })).toBe(true);
    expect(
      isMechanicallyFixable({ severity: "warn", platform: "twitter", code: "link-penalty", message: "" }),
    ).toBe(true);
  });

  it("rejects codes that are neither mechanical nor size-droppable", () => {
    expect(isMechanicallyFixable({ severity: "fail", code: "over-limit", message: "" })).toBe(false);
  });
});

describe("runQa fixable stamping (mechanical media)", () => {
  it("marks a droppable oversized Bluesky image fixable so the Fix button shows", async () => {
    const draft = draftWith(
      [render({ platform: "bluesky", content: "Hi", mediaIndices: [0] })],
      [image({ size: 2 * MB })],
    );
    const report = await runQa(draft, { skipLlm: true });
    const issue = report.issues.find((i) => i.code === "image-too-large");
    expect(issue?.fixable).toBe(true);
  });

  it("leaves a render alone when nothing mechanical was reported for it", () => {
    const draft = draftWith([
      render({ platform: "twitter", content: "Clean copy, link-free." }),
      render({ platform: "reddit", content: "Spammy #tags", subreddit: "SaaS", title: "T" }),
    ]);
    const before = draft.renders[0]!.content;
    const result = applyMechanicalFixes(draft, issuesFor(draft));
    expect(draft.renders[0]!.content).toBe(before);
    expect(result.changed).toEqual(["reddit"]);
  });

  it("reports no change when there is nothing mechanical to do", () => {
    const draft = draftWith([render({ platform: "twitter", content: "Clean." })]);
    expect(applyMechanicalFixes(draft, issuesFor(draft))).toEqual({ changed: [], applied: [] });
  });

  it("refreshes the rationale so it cannot describe copy that no longer exists", () => {
    const draft = draftWith([
      render({
        platform: "twitter",
        content: "Hook. https://acmebrands.com",
        rationale: "Single tweet with the link inline.",
      }),
    ]);
    applyMechanicalFixes(draft, issuesFor(draft));
    expect(draft.renders[0]!.rationale).toContain("Adjusted automatically");
  });
});

describe("outstandingIssues", () => {
  it("drops a previous model finding about copy that has since changed", () => {
    const draft = draftWith([render({ platform: "twitter", content: "Now link-free." })]);
    const previous: QAReport = {
      ranAt: "2026-07-20T00:00:00.000Z",
      pass: false,
      issues: [
        {
          severity: "fail",
          platform: "twitter",
          code: "llm-twitter-link-placement",
          message: "the link is in the body",
          fix: "move it to a reply",
        },
      ],
    };
    expect(outstandingIssues(draft, previous, ["twitter"])).toEqual([]);
  });

  it("carries a model finding forward for a platform that was not touched", () => {
    const draft = draftWith([
      render({ platform: "twitter", content: "Untouched." }),
      render({ platform: "facebook", content: "Changed." }),
    ]);
    const previous: QAReport = {
      ranAt: "2026-07-20T00:00:00.000Z",
      pass: false,
      issues: [
        {
          severity: "warn",
          platform: "twitter",
          code: "llm-weak-hook",
          message: "the hook is flat",
          fix: "lead with the outcome",
        },
      ],
    };
    expect(outstandingIssues(draft, previous, ["facebook"])).toHaveLength(1);
  });

  it("never carries the reviewer-unavailable marker forward", () => {
    const draft = draftWith([render({ platform: "twitter", content: "Fine." })]);
    const previous: QAReport = {
      ranAt: "2026-07-20T00:00:00.000Z",
      pass: false,
      issues: [
        { severity: "warn", code: "llm-qa-unavailable", message: "review failed", fix: "retry" },
      ],
    };
    expect(outstandingIssues(draft, previous, [])).toEqual([]);
  });

  it("recomputes deterministic issues from the edited draft", () => {
    const draft = draftWith([render({ platform: "twitter", content: "a".repeat(300) })]);
    const codes = outstandingIssues(draft, undefined, []).map((i) => i.code);
    expect(codes).toContain("over-limit");
  });
});

describe("qaScore", () => {
  const report = (issues: QAIssue[]): QAReport => ({
    ranAt: "2026-07-20T00:00:00.000Z",
    pass: !issues.some((i) => i.severity === "fail"),
    issues,
  });

  it("ranks any blocker above any number of warnings", () => {
    const oneFail = report([{ severity: "fail", code: "a", message: "m" }]);
    const manyWarns = report(
      Array.from({ length: 50 }, () => ({ severity: "warn" as const, code: "b", message: "m" })),
    );
    expect(qaScore(oneFail)).toBeGreaterThan(qaScore(manyWarns));
  });

  it("ranks a warning above any number of style notes", () => {
    const oneWarn = report([{ severity: "warn", code: "a", message: "m" }]);
    const manyInfos = report(
      Array.from({ length: 50 }, () => ({ severity: "info" as const, code: "b", message: "m" })),
    );
    expect(qaScore(oneWarn)).toBeGreaterThan(qaScore(manyInfos));
  });

  it("scores a clean report at zero", () => {
    expect(qaScore(report([]))).toBe(0);
  });
});

describe("reviseRenders", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends the current copy, not just the source, so the edit is targeted", async () => {
    genJsonMock.mockResolvedValue({
      renders: [{ platform: "bluesky", content: "Tighter copy that fits.", changeNote: "Trimmed." }],
    });
    const draft = draftWith([
      render({ platform: "bluesky", content: "The existing copy that needs trimming." }),
    ]);
    await reviseRenders(draft, [
      { severity: "fail", platform: "bluesky", code: "over-limit", message: "too long", fix: "trim" },
    ]);

    const prompt = genJsonMock.mock.calls[0]![0] as string;
    expect(prompt).toContain("The existing copy that needs trimming.");
    expect(prompt).toContain("too long");
    // Structured output, no sampling knobs (Sonnet 5.5 400s on non-default ones).
    expect(genJsonMock.mock.calls[0]![1]).toEqual({ schema: expect.any(Object) });
  });

  it("stamps a revised render with the model that wrote it", async () => {
    genJsonMock.mockResolvedValue({ renders: [{ platform: "bluesky", content: "Fixed." }] });
    const draft = draftWith([
      render({ platform: "bluesky", content: "Broken.", generatedBy: { model: "older-model", effort: "low" } }),
    ]);
    const revised = await reviseRenders(draft, [
      { severity: "warn", platform: "bluesky", code: "x", message: "m", fix: "f" },
    ]);
    expect(revised.get("bluesky")!.generatedBy).toEqual({ model: "claude-sonnet-5-5", effort: "high" });
  });

  it("only asks about platforms that have issues", async () => {
    genJsonMock.mockResolvedValue({ renders: [{ platform: "bluesky", content: "Fixed." }] });
    const draft = draftWith([
      render({ platform: "bluesky", content: "Broken." }),
      render({ platform: "linkedin", content: "Perfectly clean copy." }),
    ]);
    const revised = await reviseRenders(draft, [
      { severity: "warn", platform: "bluesky", code: "x", message: "m", fix: "f" },
    ]);

    expect([...revised.keys()]).toEqual(["bluesky"]);
    expect(genJsonMock.mock.calls[0]![0] as string).not.toContain("Perfectly clean copy.");
  });

  it("keeps the existing copy when the model returns an empty body", async () => {
    genJsonMock.mockResolvedValue({ renders: [{ platform: "bluesky", content: "   " }] });
    const draft = draftWith([render({ platform: "bluesky", content: "Original." })]);
    const revised = await reviseRenders(draft, [
      { severity: "warn", platform: "bluesky", code: "x", message: "m", fix: "f" },
    ]);
    expect(revised.size).toBe(0);
  });

  it("drops a returned reply that repeats the revised body", async () => {
    // The model can echo the root back as item 0; sent as a reply, it would
    // publish the opening post twice.
    genJsonMock.mockResolvedValue({
      renders: [
        {
          platform: "twitter",
          content: "New hook.",
          threadItems: ["New hook.", "https://acmebrands.com"],
        },
      ],
    });
    const draft = draftWith([render({ platform: "twitter", content: "Old." })]);
    const revised = await reviseRenders(draft, [
      { severity: "fail", platform: "twitter", code: "x", message: "m", fix: "f" },
    ]);
    const r = revised.get("twitter")!;
    expect(r.content).toBe("New hook.");
    expect(r.threadItems).toEqual(["https://acmebrands.com"]);
  });

  it("shows the model the replies only, and tells it never to repeat the body", async () => {
    genJsonMock.mockResolvedValue({ renders: [] });
    const draft = draftWith([
      render({ platform: "twitter", content: "Root.", threadItems: ["Root.", "The reply."] }),
      render({ platform: "bluesky", content: "Solo.", threadItems: ["Solo."] }),
    ]);
    await reviseRenders(draft, [
      { severity: "fail", platform: "twitter", code: "x", message: "m", fix: "f" },
      { severity: "fail", platform: "bluesky", code: "x", message: "m", fix: "f" },
    ]);
    const prompt = genJsonMock.mock.calls[0]![0] as string;
    expect(prompt).toContain('"threadItems": [\n    "The reply."\n   ]');
    expect(prompt).not.toContain('"Root."\n   ]');
    // A chain that is only a stored copy of the body has no replies to show.
    expect(prompt.match(/"threadItems"/g)).toHaveLength(4);
    expect(prompt).toContain("Never repeat \"content\" as a thread item.");
  });

  it("preserves fields the model omitted", async () => {
    genJsonMock.mockResolvedValue({ renders: [{ platform: "reddit", content: "Body." }] });
    const draft = draftWith([
      render({ platform: "reddit", content: "Old body.", title: "Keep me", subreddit: "SaaS", mediaIndices: [0] }),
    ]);
    const revised = await reviseRenders(draft, [
      { severity: "warn", platform: "reddit", code: "x", message: "m", fix: "f" },
    ]);
    expect(revised.get("reddit")).toMatchObject({
      title: "Keep me",
      subreddit: "SaaS",
      mediaIndices: [0],
    });
  });

  it("does not call the model when nothing is in scope", async () => {
    const draft = draftWith([render({ platform: "bluesky", content: "Clean." })]);
    expect((await reviseRenders(draft, [])).size).toBe(0);
    expect(genJsonMock).not.toHaveBeenCalled();
  });
});

/** A mechanical issue with an exact code, rather than whatever the checks find. */
function issue(code: string, platform?: PlatformRender["platform"]): QAIssue {
  return { severity: "warn", code, message: `${code} on ${platform ?? "all"}`, platform };
}

describe("where a penalised link ends up", () => {
  it("moves it into the thread on a platform that has one", async () => {
    const draft = draftWith([
      render({ platform: "twitter", content: "Never miss a call. https://acmebrands.com" }),
    ]);

    const out = applyMechanicalFixes(draft, [issue("link-penalty", "twitter")]);

    expect(out.changed).toEqual(["twitter"]);
    expect(draft.renders[0].content).not.toContain("https://acmebrands.com");
    expect(draft.renders[0].threadItems?.join(" ")).toContain("https://acmebrands.com");
  });

  it("moves it into the first comment where there is no thread", async () => {
    const draft = draftWith([
      render({ platform: "facebook", content: "Never miss a call. https://acmebrands.com" }),
    ]);

    applyMechanicalFixes(draft, [issue("link-penalty", "facebook")]);

    expect(draft.renders[0].content).not.toContain("https://acmebrands.com");
    expect(draft.renders[0].firstComment).toContain("https://acmebrands.com");
  });

  it("LEAVES LinkedIn alone, because no placement escapes the penalty there", async () => {
    const draft = draftWith([
      render({ platform: "linkedin", content: "Never miss a call. https://acmebrands.com" }),
    ]);
    const before = draft.renders[0].content;

    const out = applyMechanicalFixes(draft, [issue("link-penalty", "linkedin")]);

    // ⛔ This used to move the link to the first comment. 2026 research shows
    // that is penalised just as heavily as a body link, so the edit paid the
    // full cost AND removed the link from where readers actually see it. The
    // finding stays reported instead.
    expect(draft.renders[0].content).toBe(before);
    expect(draft.renders[0].firstComment).toBeUndefined();
    expect(out.changed).toEqual([]);
  });

  it("points an Instagram reader at the bio, and a Pinterest reader at nothing", async () => {
    const ig = draftWith([
      render({ platform: "instagram", content: "Never miss a call.\n\nhttps://acmebrands.com" }),
    ]);
    applyMechanicalFixes(ig, [issue("dead-link", "instagram")]);
    expect(ig.renders[0].content).toContain("Link in bio.");

    const pin = draftWith([
      render({ platform: "pinterest", content: "Never miss a call.\n\nhttps://acmebrands.com" }),
    ]);
    applyMechanicalFixes(pin, [issue("dead-link", "pinterest")]);
    // ⚠️ Pinterest's destination is a PUBLISH SETTING, so there is nothing in
    // the copy to point at. Telling the reader "link in bio" would be a lie.
    expect(pin.renders[0].content).not.toContain("Link in bio.");
    expect(pin.renders[0].content).not.toContain("https://acmebrands.com");
  });
});

describe("em-dashes in every field that can hold them", () => {
  it("strips them from the title, the first comment and the thread too", async () => {
    const draft = draftWith([
      render({
        platform: "twitter",
        content: "Answer every call — even after hours.",
        title: "Never miss a call — ever",
        firstComment: "More — here.",
        threadItems: ["One — two.", "Three — four."],
      }),
    ]);

    applyMechanicalFixes(draft, [issue("brand-em-dash")]);

    const r = draft.renders[0];
    // A platform-less mechanical issue applies to every render, and within a
    // render to every field the operator can see.
    for (const field of [r.content, r.title!, r.firstComment!, ...r.threadItems!]) {
      expect(field).not.toContain("—");
    }
  });

  it("does nothing at all when no issue is mechanically fixable", async () => {
    const draft = draftWith([render({ platform: "twitter", content: "Clean copy." })]);

    expect(applyMechanicalFixes(draft, [issue("llm-tone", "twitter")])).toEqual({
      changed: [],
      applied: [],
    });
  });
});

describe("media rules a rule can decide correctly", () => {
  it("drops the mismatched type where a platform cannot mix images and video", async () => {
    const draft = draftWith(
      [render({ platform: "facebook", content: "x", mediaIndices: [0, 1, 2] })],
      [image(), video(), image()],
    );

    applyMechanicalFixes(draft, [issue("mixed-media", "facebook")]);

    // The FIRST attachment decides which type survives.
    expect(draft.renders[0].mediaIndices).toEqual([0, 2]);
  });

  it("trims to the image maximum while leaving a video attachment alone", async () => {
    const draft = draftWith(
      [render({ platform: "twitter", content: "x", mediaIndices: [0, 1, 2, 3, 4, 5] })],
      [image(), image(), image(), image(), image(), video()],
    );

    applyMechanicalFixes(draft, [issue("too-many-images", "twitter")]);

    // Four images (twitter's max) plus the video, which is not an image and is
    // therefore not what the limit is about.
    expect(draft.renders[0].mediaIndices).toEqual([0, 1, 2, 3, 5]);
  });

  it("drops an oversized attachment where the platform can still post without it", async () => {
    const draft = draftWith(
      [render({ platform: "twitter", content: "x", mediaIndices: [0, 1] })],
      [image({ size: 9 * MB }), image({ size: 1000 })],
    );

    const out = applyMechanicalFixes(draft, [issue("image-too-large", "twitter")]);

    expect(draft.renders[0].mediaIndices).toEqual([1]);
    expect(out.applied.join(" ")).toContain("over X / Twitter's file-size limit");
  });

  it("keeps the failing issue where the platform REQUIRES media", async () => {
    const draft = draftWith(
      [render({ platform: "instagram", content: "x", mediaIndices: [0] })],
      [image({ size: 90 * MB })],
    );

    const out = applyMechanicalFixes(draft, [issue("image-too-large", "instagram")]);

    // ⛔ Dropping it would leave the post publishable-as-nothing, so the
    // operator keeps the finding instead.
    expect(draft.renders[0].mediaIndices).toEqual([0]);
    expect(out.changed).toEqual([]);
  });
});

describe("the rationale after a structural edit", () => {
  it("appends to an existing one rather than replacing it", async () => {
    const draft = draftWith([
      render({ platform: "twitter", content: "Call us — now.", rationale: "Short and direct." }),
    ]);

    applyMechanicalFixes(draft, [issue("brand-em-dash", "twitter")]);

    // ⚠️ The rationale is shown to the operator verbatim, so a stale one would
    // explain choices the copy no longer makes.
    expect(draft.renders[0].rationale).toBe(
      "Short and direct. Adjusted automatically to satisfy X / Twitter's platform rules.",
    );
  });

  it("writes a fresh one where there was none", async () => {
    const draft = draftWith([render({ platform: "twitter", content: "Call us — now." })]);

    applyMechanicalFixes(draft, [issue("brand-em-dash", "twitter")]);

    expect(draft.renders[0].rationale).toBe(
      "Adjusted automatically to satisfy X / Twitter's platform rules.",
    );
  });
});

describe("reviseRenders against what the model actually returns", () => {
  const draft = () =>
    draftWith([
      render({
        platform: "twitter",
        content: "old body",
        title: "old title",
        firstComment: "old comment",
        threadItems: ["old body", "old second"],
        rationale: "old rationale",
      }),
    ]);

  it("asks the model nothing when no issue lands on a render that exists", async () => {
    const out = await reviseRenders(draft(), [issue("llm-tone", "instagram")]);

    expect(out.size).toBe(0);
    expect(genJsonMock).not.toHaveBeenCalled();
  });

  // The schema holds every entry to a string body on a platform in scope
  // (claude.ts); an all-whitespace body is the one bad roll it allows.
  it.each([["an empty body", [{ platform: "twitter", content: "   " }]]])("discards %s", async (_label, renders) => {
    genJsonMock.mockResolvedValue({ renders });

    const out = await reviseRenders(draft(), [issue("llm-tone", "twitter")]);

    // ⛔ An empty body would publish a blank post. A failed revision keeps what
    // we had rather than shipping the model's mistake.
    expect(out.size).toBe(0);
  });

  it("takes returned thread items as the replies after the body", async () => {
    genJsonMock.mockResolvedValue({
      renders: [{ platform: "twitter", content: "new body", threadItems: ["new first", "new second"] }],
    });

    const revised = (await reviseRenders(draft(), [issue("llm-tone", "twitter")])).get("twitter")!;

    expect(revised.content).toBe("new body");
    expect(revised.threadItems).toEqual(["new first", "new second"]);
  });

  it("does not carry a stored copy of the OLD body forward as a reply", async () => {
    // The fixture's chain is stored root-first ("old body" as item 0). With the
    // body revised, that item no longer matches it, so only reading the kept
    // chain through threadReplies stops it going out as a reply.
    genJsonMock.mockResolvedValue({ renders: [{ platform: "twitter", content: "new body" }] });

    const revised = (await reviseRenders(draft(), [issue("llm-tone", "twitter")])).get("twitter")!;

    expect(revised.threadItems).toEqual(["old second"]);
  });

  it("drops the thread when the kept chain was only the old body", async () => {
    genJsonMock.mockResolvedValue({ renders: [{ platform: "twitter", content: "new body" }] });
    const d = draft();
    d.renders[0]!.threadItems = ["old body"];

    const revised = (await reviseRenders(d, [issue("llm-tone", "twitter")])).get("twitter")!;

    expect(revised.threadItems).toBeUndefined();
  });

  it("clears a field on an empty string but leaves it alone when the key is absent", async () => {
    genJsonMock.mockResolvedValue({
      renders: [{ platform: "twitter", content: "new body", title: "" }],
    });

    const revised = (await reviseRenders(draft(), [issue("llm-tone", "twitter")])).get("twitter")!;

    // Omitting a key means "leave it"; an empty string means "clear it".
    expect(revised.title).toBeUndefined();
    expect(revised.firstComment).toBe("old comment");
  });

  it("keeps the previous rationale when the model returns no change note", async () => {
    genJsonMock.mockResolvedValue({
      renders: [{ platform: "twitter", content: "new body", changeNote: "   " }],
    });

    const revised = (await reviseRenders(draft(), [issue("llm-tone", "twitter")])).get("twitter")!;

    expect(revised.rationale).toBe("old rationale");
  });
});

describe("a hashtag-heavy YouTube description", () => {
  it("is trimmed to the ideal ceiling it reports, not left at the hard cap", () => {
    // YouTube is the one platform whose hard cap (15) sits above its ideal
    // ceiling (3). Trimming to the cap for `hashtag-heavy` changed nothing, so
    // the deterministic fix never happened and the issue went to the model.
    const tags = Array.from({ length: 8 }, (_, i) => `#tag${i}`).join(" ");
    const draft = draftWith(
      [render({ platform: "youtube", content: `Watch the demo. ${tags}`, title: "Demo", mediaIndices: [0] })],
      [video()],
    );
    const heavy = issuesFor(draft).filter((i) => i.code === "hashtag-heavy");
    expect(heavy).toHaveLength(1);

    const out = applyMechanicalFixes(draft, heavy);

    expect(draft.renders[0]!.content.match(/#\w+/g)).toHaveLength(3);
    expect(out.applied.join(" ")).toContain("cut 5 hashtags down to the platform's limit of 3");
    expect(deterministicChecks(draft).some((i) => i.code.startsWith("hashtag-"))).toBe(false);
  });

  it("still trims a hashtag-cap finding to the hard cap", () => {
    const tags = Array.from({ length: 17 }, (_, i) => `#tag${i}`).join(" ");
    const draft = draftWith(
      [render({ platform: "youtube", content: `Watch. ${tags}`, title: "Demo", mediaIndices: [0] })],
      [video()],
    );

    applyMechanicalFixes(draft, [issue("hashtag-cap", "youtube")]);

    expect(draft.renders[0]!.content.match(/#\w+/g)).toHaveLength(15);
  });
});

describe("a LinkedIn link is never moved somewhere LinkedIn does not publish", () => {
  beforeEach(() => vi.clearAllMocks());

  const linkedin = () =>
    draftWith([
      render({ platform: "linkedin", content: "We shipped the French portal. https://acmebrands.com/fr" }),
    ]);

  it("ignores a first comment the model adds on a platform whose transport drops it", async () => {
    // linkedin-transport.ts never sends render.firstComment, so a revision that
    // "moves the link out of the body" into it publishes a post with no link.
    genJsonMock.mockResolvedValue({
      renders: [
        {
          platform: "linkedin",
          content: "We shipped the French portal.",
          firstComment: "https://acmebrands.com/fr",
        },
      ],
    });

    const revised = (await reviseRenders(linkedin(), [issue("llm-grammar", "linkedin")])).get("linkedin")!;

    expect(revised.firstComment).toBeUndefined();
  });

  it("keeps an existing unsent first comment rather than replacing it, and lets the model clear it", async () => {
    const d = linkedin();
    d.renders[0]!.firstComment = "older comment";
    genJsonMock.mockResolvedValueOnce({
      renders: [{ platform: "linkedin", content: "Body.", firstComment: "https://acmebrands.com/fr" }],
    });
    expect((await reviseRenders(d, [issue("llm-grammar", "linkedin")])).get("linkedin")!.firstComment).toBe(
      "older comment",
    );

    genJsonMock.mockResolvedValueOnce({
      renders: [{ platform: "linkedin", content: "Body.", firstComment: "" }],
    });
    expect((await reviseRenders(d, [issue("llm-grammar", "linkedin")])).get("linkedin")!.firstComment).toBeUndefined();
  });

  it("still takes a first comment on a platform that publishes one", async () => {
    genJsonMock.mockResolvedValue({
      renders: [{ platform: "facebook", content: "Body.", firstComment: "Read more: https://acmebrands.com" }],
    });
    const d = draftWith([render({ platform: "facebook", content: "Body. https://acmebrands.com" })]);

    const revised = (await reviseRenders(d, [issue("link-penalty", "facebook")])).get("facebook")!;

    expect(revised.firstComment).toBe("Read more: https://acmebrands.com");
  });

  it("tells the model a link moves only into a field the platform publishes", async () => {
    genJsonMock.mockResolvedValue({ renders: [] });

    await reviseRenders(linkedin(), [issue("llm-grammar", "linkedin")]);

    const prompt = genJsonMock.mock.calls[0]![0] as string;
    expect(prompt).not.toContain("the url must appear in the thread item or first comment instead");
    expect(prompt).toContain("firstComment is NOT published here");
    // LinkedIn's rule line; the Rules section quotes the phrase on purpose.
    expect(prompt).not.toContain("- firstComment supported");
  });

  it("is not handed to the model as a link-penalty fix at all", () => {
    // outstandingIssues feeds reviseRenders; the mechanical pass leaves
    // LinkedIn's link where it is on purpose, so the rewrite must not be asked
    // to move it either.
    const remaining = outstandingIssues(linkedin(), undefined, []);
    expect(remaining.some((i) => i.code === "link-penalty")).toBe(false);
  });
});
