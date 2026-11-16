/**
 * scripts/social/render.ts: the CLI's text previews of a draft and its QA report.
 * The Social HQ engine is mocked at its module boundary: these tests pin what
 * the CLI prints from the engine's answers, not the engine's own measurements.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelRulesSnapshot, Draft, QAReport } from "../../../src/index.js";

const h = vi.hoisted(() => ({
  effectiveMaxChars: vi.fn(),
  vendorLength: vi.fn(),
}));

vi.mock("../../../src/index.js", async () => ({
  SPECS: {
    twitter: { displayName: "X", maxChars: 280, supportsThreads: true },
    linkedin: { displayName: "LinkedIn", maxChars: 3000, supportsThreads: false },
  },
  effectiveMaxChars: h.effectiveMaxChars,
  vendorLength: h.vendorLength,
  // The real helper: which items are replies is the convention under test.
  threadReplies: (await import("../../../src/types.js")).threadReplies,
}));

import { renderDraft, renderQa } from "../render.js";

beforeEach(() => {
  h.effectiveMaxChars.mockReset().mockImplementation((_r, _p, fallback: number) => fallback);
  h.vendorLength.mockReset().mockImplementation((_p, content: string) => content.length);
});

function draft(over: Partial<Draft> = {}): Draft {
  return {
    id: "sm-1",
    createdAt: "",
    updatedAt: "",
    status: "draft",
    source: { text: "Source text", hashtags: [], media: [] },
    targets: ["twitter"],
    renders: [],
    ...over,
  } as Draft;
}

describe("renderDraft", () => {
  it("prints a minimal draft: header, source, no renders, no QA", () => {
    expect(renderDraft(draft())).toBe(
      ["Draft sm-1  [draft]", "  targets: twitter  media: 0  ", "", "SOURCE: Source text", ""].join(
        "\n",
      ),
    );
  });

  it("prints schedule, provider id, a truncated long source and the link", () => {
    const out = renderDraft(
      draft({
        status: "scheduled",
        scheduledFor: "2026-10-01T09:00:00Z",
        providerPostId: "pp-1",
        source: {
          text: "x".repeat(250),
          link: "https://example.test",
          hashtags: [],
          media: [{ path: "a.png" }, { path: "b.png" }],
        } as unknown as Draft["source"],
      }),
    ).split("\n");
    expect(out[1]).toBe(
      "  targets: twitter  media: 2  scheduled: 2026-10-01T09:00:00Z  postiz: pp-1",
    );
    expect(out[3]).toBe(`SOURCE: ${"x".repeat(200)}…`);
    expect(out[4]).toBe("LINK:   https://example.test");
  });

  it("boxes every render with the vendor length over the cap QA measures against", () => {
    const rules = { rules: true } as unknown as ChannelRulesSnapshot;
    h.effectiveMaxChars.mockReturnValue(25_000);
    h.vendorLength.mockReturnValue(1200);
    const out = renderDraft(
      draft({
        targets: ["twitter", "linkedin"],
        renders: [
          {
            platform: "twitter",
            content: "line one\nline two",
            threadItems: ["second\npost", "third"],
            firstComment: "c1\nc2",
            mediaIndices: [0, 2],
          },
          {
            platform: "linkedin",
            content: "hi",
            title: "A title",
            subreddit: "saas",
            threadItems: ["only one"],
            mediaIndices: [],
          },
        ] as unknown as Draft["renders"],
      }),
      rules,
    );
    expect(h.effectiveMaxChars).toHaveBeenCalledWith(rules, "twitter", 280);
    expect(h.vendorLength).toHaveBeenCalledWith("twitter", "line one\nline two");
    const bottom = `└${"─".repeat(70)}`;
    expect(out).toContain(
      [
        `┌─ X ${"─".repeat(59)} 1200/25000`,
        "│ line one",
        "│ line two",
        "│ ── reply 1/2 ──",
        "│ second",
        "│ post",
        "│ ── reply 2/2 ──",
        "│ third",
        "│ ┄ first comment ┄",
        "│ c1",
        "│ c2",
        "│ media: [0, 2]",
        bottom,
        "",
        `┌─ LinkedIn ${"─".repeat(52)} 1200/25000`,
        "│ TITLE: A title",
        "│ SUBREDDIT: r/saas",
        "│ hi",
        "│ ── reply 1/1 (not sent) ──",
        "│ only one",
        bottom,
        "",
      ].join("\n"),
    );
  });

  it("does not print a stored leading copy of the body as a reply", () => {
    const out = renderDraft(
      draft({
        renders: [
          { platform: "twitter", content: "root", threadItems: ["root", "the link"], mediaIndices: [] },
        ] as unknown as Draft["renders"],
      }),
    );
    expect(out).toContain(["│ root", "│ ── reply 1/1 ──", "│ the link", `└${"─".repeat(70)}`].join("\n"));
  });

  it("appends the QA report when the draft has one", () => {
    const qa: QAReport = { pass: true, ranAt: "t0", issues: [] } as unknown as QAReport;
    expect(renderDraft(draft({ qa })).endsWith("\nQA PASS (t0)\n  no issues")).toBe(true);
  });
});

describe("renderQa", () => {
  it("prints a pass with no issues", () => {
    expect(renderQa({ pass: true, ranAt: "t1", issues: [] } as unknown as QAReport)).toBe(
      "QA PASS (t1)\n  no issues",
    );
  });

  it("prints a fail with the LLM summary and each issue by severity, platform-tagged when set", () => {
    const qa = {
      pass: false,
      ranAt: "t2",
      llmSummary: "Two problems.",
      issues: [
        { severity: "fail", platform: "twitter", code: "too-long", message: "over cap" },
        { severity: "warn", code: "tone", message: "a bit salesy" },
        { severity: "info", platform: "linkedin", code: "note", message: "fyi" },
      ],
    } as unknown as QAReport;
    expect(renderQa(qa)).toBe(
      [
        "QA FAIL (t2)",
        "  Two problems.",
        "  ✗ [twitter] too-long: over cap",
        "  ⚠ tone: a bit salesy",
        "  · [linkedin] note: fyi",
      ].join("\n"),
    );
  });
});
