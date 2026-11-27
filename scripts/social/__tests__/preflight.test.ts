// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

/**
 * `social preflight <id>` (scripts/social/preflight.ts): one GET to the agent
 * API's preflight, printed as a verdict and its parts, or as JSON. The client
 * is stubbed; nothing leaves the process.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Command } from "commander";
import { registerPreflight, renderPreflight, type PreflightView } from "../preflight.js";

function preflight(overrides: Partial<PreflightView> = {}): PreflightView {
  return {
    draftId: "d1",
    status: "approved",
    origin: "agent:agent@example-project.iam.gserviceaccount.com",
    rendersHash: "a".repeat(64),
    qa: { ranAt: "t", pass: true, issues: [] },
    routes: [
      { platform: "linkedin", route: "direct", aggregator: null, reason: null },
      { platform: "twitter", route: "aggregator", aggregator: "zernio", reason: null },
      { platform: "facebook", route: "none", aggregator: null, reason: "facebook has no route" },
    ],
    linkedin: { granted: true, scopes: ["w_organization_social"], reason: null },
    pinterest: { board: "b1", onAccount: true, error: null },
    x: { posts: 2, postsWithUrl: 1, estimateUsd: 0.215 },
    duplicates: [],
    ring: { next: "2026-11-08T10:22:00.000Z", releaseAt: null },
    blockers: [],
    ready: true,
    ...overrides,
  };
}

describe("renderPreflight", () => {
  it("a ready draft: verdict, hash, QA, routes, scope, board, X cost, no duplicates, ring", () => {
    expect(renderPreflight(preflight()).split("\n")).toEqual([
      "READY: draft d1 [approved] agent:agent@example-project.iam.gserviceaccount.com",
      `rendersHash: ${"a".repeat(64)}`,
      "QA: pass",
      "  linkedin   direct",
      "  twitter    aggregator:zernio",
      "  facebook   none (facebook has no route)",
      "LinkedIn write scope: granted; grant: w_organization_social",
      "Pinterest board: b1, on the account",
      "X cost: ~$0.215 (2 posts, 1 with a URL)",
      "duplicates: none",
      "ring: next tick 2026-11-08T10:22:00.000Z",
    ]);
  });

  it("a blocked draft: every blocker, the missing scope, the board off the account, the duplicates, the release tick", () => {
    const out = renderPreflight(
      preflight({
        ready: false,
        origin: null,
        qa: { ranAt: "t", pass: false, issues: [] },
        routes: [],
        linkedin: { granted: false, scopes: [], reason: "reconnect for posting" },
        pinterest: { board: null, onAccount: false, error: null },
        x: null,
        duplicates: [{ id: "old", status: "published", reason: "title" }],
        ring: { next: "2026-11-08T10:22:00.000Z", releaseAt: "2026-11-08T14:37:00.000Z" },
        blockers: ["QA has failures", "linkedin: reconnect for posting"],
      }),
    );
    expect(out).toContain("NOT READY: draft d1 [approved] made by a person");
    expect(out).toContain("QA: FAIL");
    expect(out).toContain("LinkedIn write scope: MISSING (reconnect for posting); grant: none");
    expect(out).toContain("Pinterest board: none, NOT on the account");
    expect(out).not.toContain("X cost");
    expect(out).toContain("duplicates: old (published, same title)");
    expect(out).toContain("releases this draft at 2026-11-08T14:37:00.000Z");
    expect(out).toContain("  blocker: QA has failures\n  blocker: linkedin: reconnect for posting");
  });

  it("QA not run, no LinkedIn or Pinterest target, boards unknown", () => {
    expect(renderPreflight(preflight({ qa: null, linkedin: null, pinterest: null }))).toContain("QA: not run");
    expect(renderPreflight(preflight({ qa: null, linkedin: null, pinterest: null }))).not.toMatch(/LinkedIn|Pinterest/);
    expect(
      renderPreflight(preflight({ pinterest: { board: "b1", onAccount: null, error: "the Pinterest boards could not be read" } })),
    ).toContain("Pinterest board: b1, unknown (the Pinterest boards could not be read)");
  });
});

describe("the preflight command", () => {
  const request = vi.fn();
  let log: ReturnType<typeof vi.spyOn>;

  function program() {
    const p = new Command().exitOverride();
    registerPreflight(p, () => ({ baseUrl: "https://social.example.com", request }));
    return p;
  }

  beforeEach(() => {
    request.mockReset().mockResolvedValue(preflight());
    log = vi.spyOn(console, "log").mockImplementation(() => {});
    log.mockClear();
  });

  it("GETs the draft's preflight, path-encoded, and prints it", async () => {
    await program().parseAsync(["node", "social", "preflight", "d1/../x"]);
    expect(request).toHaveBeenCalledWith("GET", "/drafts/d1%2F..%2Fx/preflight");
    expect(log).toHaveBeenCalledWith(renderPreflight(preflight()));
  });

  it("--json prints the API's answer", async () => {
    await program().parseAsync(["node", "social", "preflight", "d1", "--json"]);
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toEqual(preflight());
  });
});
