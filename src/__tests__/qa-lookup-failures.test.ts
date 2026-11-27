// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

/**
 * What QA reports when the things it CONSULTS misbehave.
 *
 * Two of QA's checks are not opinions about the copy at all: they ask the
 * publish path itself (`assertPublishable`) and the vendors (`connectedAccounts`
 * plus the per-destination lookups) what will actually be accepted. Both can
 * fail in ways the happy-path tests never produce, and the two failure modes
 * pull in opposite directions:
 *
 *  - A refusal must be reported with a message an operator can act on. A throw
 *    that is not an `Error` has no `.message`, and reading one off it yields
 *    `undefined`: a blocking QA row with no text, on a draft that cannot ship.
 *  - A vendor OUTAGE must report nothing. The whole point of these lookups is
 *    to stop a post being refused later, so it would be perverse for the check
 *    itself to become the thing that blocks a draft, or to manufacture a scary
 *    finding out of a 500.
 *
 * ⚠️ This file mocks `../publish` (partially, keeping the rest real) because
 * neither failure can be provoked through the transport registry: the registry
 * only lets a transport answer wrongly, not throw from the wrong place.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../claude.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../claude.js")>()),
  genJson: vi.fn(),
}));

vi.mock("../publish.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../publish.js")>();
  return { ...actual, assertPublishable: vi.fn(), connectedAccounts: vi.fn() };
});

import { assertPublishable, connectedAccounts } from "../publish.js";
import { channelRuleChecks, runQa } from "../qa.js";
import type { ChannelRulesMap, ChannelRulesSnapshot } from "../channel-rules.js";
import type { Draft, Platform, PlatformRender } from "../types.js";

const assertPublishableMock = vi.mocked(assertPublishable);
const connectedAccountsMock = vi.mocked(connectedAccounts);

function render(
  overrides: Partial<PlatformRender> & { platform: Platform },
): PlatformRender {
  return { content: "body", mediaIndices: [], ...overrides };
}

function draftWith(renders: PlatformRender[]): Draft {
  return {
    id: "d1",
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    status: "draft",
    source: { text: "source text", hashtags: [], media: [] },
    targets: renders.map((r) => r.platform),
    renders,
  };
}

function snapshot(...platforms: Platform[]): ChannelRulesSnapshot {
  // No maxLength: the vendor-length rule is qa-vendor-cap.test.ts's subject.
  // These tests are only here for the assertPublishable leg of the same loop.
  const channels: ChannelRulesMap = {};
  for (const p of platforms) channels[p] = { platform: p };
  return { fetchedAt: "2026-08-20T00:00:00.000Z", channels };
}

beforeEach(() => {
  vi.clearAllMocks();
  connectedAccountsMock.mockResolvedValue({});
});

describe("a destination the publish path refuses", () => {
  it("reports the publish path's own words when it throws an Error", () => {
    // The refusal text is written where the available flairs and board ids are
    // in hand, so it is more useful than anything QA could word for itself.
    assertPublishableMock.mockImplementation(() => {
      throw new Error("r/saas requires a post flair. Set one on the draft.");
    });
    const issues = channelRuleChecks(
      draftWith([render({ platform: "reddit", title: "t", subreddit: "saas" })]),
      snapshot("reddit"),
    );
    expect(issues.find((i) => i.code === "destination-invalid")).toMatchObject({
      severity: "fail",
      platform: "reddit",
      message: "r/saas requires a post flair. Set one on the draft.",
    });
  });

  it("still names the platform when what was thrown is not an Error", () => {
    // ⛔ `err.message` on a thrown string is `undefined`, and an issue with an
    // undefined message renders as a blank blocking row: the draft cannot
    // publish and the panel says nothing about why. The fallback keeps the
    // operator pointed at the right platform's settings.
    assertPublishableMock.mockImplementation(() => {
      throw "pinterest exploded";
    });
    const issues = channelRuleChecks(
      draftWith([render({ platform: "pinterest", title: "t", board: { id: "b1" } })]),
      snapshot("pinterest"),
    );
    const issue = issues.find((i) => i.code === "destination-invalid");
    expect(issue).toMatchObject({ severity: "fail", platform: "pinterest" });
    expect(issue!.message).toBe("pinterest cannot be published as configured");
    expect(issue!.fix).toContain("pinterest");
  });

  it("says nothing when the publish path accepts the destination", () => {
    assertPublishableMock.mockImplementation(() => {});
    const issues = channelRuleChecks(
      draftWith([render({ platform: "reddit", title: "t", subreddit: "saas" })]),
      snapshot("reddit"),
    );
    expect(issues.some((i) => i.code === "destination-invalid")).toBe(false);
  });
});

describe("a vendor lookup that cannot answer at all", () => {
  /**
   * ⛔ SILENCE, NOT A FINDING, AND NOT A CRASH.
   *
   * `connectedAccounts()` is the first await inside BOTH live lookups, so one
   * unreachable vendor (or an expired credential sweep) takes out the Reddit
   * restrictions read and the Pinterest board read together. Every mechanical
   * check has already run by then and its findings are the ones that matter;
   * losing them to an unhandled rejection would turn a vendor blip into "QA
   * failed" on a draft that is perfectly publishable.
   */
  it("keeps the mechanical report and adds no per-destination findings", async () => {
    connectedAccountsMock.mockRejectedValue(new Error("vendor 500"));
    const report = await runQa(
      draftWith([
        render({ platform: "reddit", title: "t", subreddit: "saas" }),
        render({ platform: "pinterest", title: "t", board: { id: "b1" } }),
      ]),
      { skipLlm: true },
    );

    // Nothing invented about either destination.
    expect(
      report.issues.some(
        (i) => i.code.startsWith("subreddit-") && i.code !== "subreddit-missing",
      ),
    ).toBe(false);
    expect(report.issues.some((i) => ["no-pinterest-boards", "board-unknown"].includes(i.code))).toBe(
      false,
    );
    // ...and the deterministic pass is untouched: this draft has no visual, and
    // that is still a blocker.
    expect(report.issues.some((i) => i.code === "brand-media-missing")).toBe(true);
    expect(report.ranAt).toEqual(expect.any(String));
  });
});
