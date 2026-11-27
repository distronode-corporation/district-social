// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

/**
 * QA's live Pinterest board check.
 *
 * A pin needs a board that actually exists on the connected account. That is
 * per-destination state the nightly channel-rules snapshot cannot hold, so QA
 * makes a live call — deliberately mirroring the publish preflight
 * (assertPinterestBoard) so an operator reads "this account has no boards" in
 * the QA panel instead of discovering it when a scheduled pin refuses to go out.
 *
 * ⚠️ THE DEFINING PROPERTY: every failure mode degrades to "no issues". A vendor
 * hiccup must neither block a draft nor invent a finding, because both are worse
 * than saying nothing — one stops a publishable post, the other sends someone
 * looking for a problem that is not there. That is why almost every test below
 * asserts the ABSENCE of a finding, and why an unreachable Pinterest is not the
 * same as a Pinterest with no boards.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../claude.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../claude.js")>()),
  genJson: vi.fn(),
}));

import { invalidateConnectedAccounts } from "../publish.js";
import { registerTransport, resetTransports } from "../transport.js";
import type { DirectTransport } from "../transport.js";
import { runQa } from "../qa.js";
import type { Draft, PlatformRender } from "../types.js";

const listBoards = vi.fn();
const connectStatus = vi.fn();

function pinterestTransport(overrides: Partial<DirectTransport> = {}): DirectTransport {
  return {
    platform: "pinterest",
    channelRules: () => ({ maxLength: 500, countMode: "utf16" }),
    connectStatus,
    publishNow: async () => ({ ref: "pin-1" }),
    deletePost: async () => {},
    postFacts: async () => new Map(),
    postUrl: (r: string) => `https://pinterest.com/pin/${r}`,
    listBoards,
    ...overrides,
  };
}

function render(overrides: Partial<PlatformRender> & { platform: PlatformRender["platform"] }): PlatformRender {
  return { content: "", mediaIndices: [], ...overrides };
}

function draftWith(renders: PlatformRender[]): Draft {
  return {
    id: "d1",
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    status: "draft",
    source: { text: "source text", hashtags: [], media: [] },
    targets: renders.map((r) => r.platform),
    renders,
  };
}

/** A pin whose board is named explicitly, so the check does not fall back to settings. */
function pinDraft(overrides: Partial<PlatformRender> = {}) {
  return draftWith([
    render({
      platform: "pinterest",
      content: "A pin",
      board: { id: "board-1", name: "Product" },
      ...overrides,
    } as Partial<PlatformRender> & { platform: "pinterest" }),
  ]);
}

const boardIssues = (report: Awaited<ReturnType<typeof runQa>>) =>
  report.issues.filter((i) => i.code === "no-pinterest-boards" || i.code === "board-unknown");

beforeEach(() => {
  vi.clearAllMocks();
  invalidateConnectedAccounts();
  resetTransports();
  process.env.SOCIALMETA_TRANSPORT_OVERRIDES = JSON.stringify({ pinterest: "direct" });
  connectStatus.mockResolvedValue({ connected: true, accountId: "pi-1", displayName: "acmebrands" });
  listBoards.mockResolvedValue([{ id: "board-1", name: "Product" }]);
  registerTransport(pinterestTransport());
});

afterEach(() => {
  resetTransports();
  delete process.env.SOCIALMETA_TRANSPORT_OVERRIDES;
  invalidateConnectedAccounts();
});

describe("when the board is fine", () => {
  it("raises nothing for a board that exists on the account", async () => {
    const report = await runQa(pinDraft(), { skipLlm: true });

    expect(boardIssues(report)).toEqual([]);
  });

  it("matches on board id, not the display name", async () => {
    // Boards are renamed freely in Pinterest's UI; the id is the stable handle.
    // Matching on name would fail a perfectly valid pin after a rename.
    listBoards.mockResolvedValue([{ id: "board-1", name: "Renamed Since" }]);

    const report = await runQa(pinDraft(), { skipLlm: true });

    expect(boardIssues(report)).toEqual([]);
  });
});

describe("when the account cannot satisfy the pin", () => {
  it("fails when the connected account has no boards at all", async () => {
    listBoards.mockResolvedValue([]);

    const report = await runQa(pinDraft(), { skipLlm: true });

    expect(report.issues.find((i) => i.code === "no-pinterest-boards")).toMatchObject({
      severity: "fail",
      platform: "pinterest",
    });
    // A blocker, not a warning: there is nowhere for the pin to go, so
    // publishing cannot succeed by any route.
    expect(report.pass).toBe(false);
  });

  it("points at Pinterest itself for the remedy, since nothing here can create a board", async () => {
    listBoards.mockResolvedValue([]);

    const report = await runQa(pinDraft(), { skipLlm: true });

    expect(report.issues.find((i) => i.code === "no-pinterest-boards")?.fix).toContain(
      "Create a board in Pinterest",
    );
  });

  it("fails a board that is not on the account", async () => {
    listBoards.mockResolvedValue([{ id: "other-board", name: "Recipes" }]);

    const report = await runQa(pinDraft(), { skipLlm: true });

    expect(report.issues.find((i) => i.code === "board-unknown")).toMatchObject({
      severity: "fail",
      platform: "pinterest",
    });
    expect(report.pass).toBe(false);
  });

  it("names the boards that DO exist, so the fix is a choice and not a hunt", async () => {
    listBoards.mockResolvedValue([
      { id: "b-a", name: "Recipes" },
      { id: "b-b", name: "Interiors" },
    ]);

    const report = await runQa(pinDraft(), { skipLlm: true });

    const message = report.issues.find((i) => i.code === "board-unknown")?.message ?? "";
    expect(message).toContain("board-1");
    expect(message).toContain("Recipes, Interiors");
  });
});

describe("degrading to silence", () => {
  it("says nothing when the draft has no pinterest render", async () => {
    const report = await runQa(draftWith([render({ platform: "twitter", content: "hi" })]), {
      skipLlm: true,
    });

    expect(boardIssues(report)).toEqual([]);
    expect(listBoards).not.toHaveBeenCalled();
  });

  it("says nothing when no board is chosen, because that is board-missing's job", async () => {
    // Two findings for one cause would double-report it, and board-missing is
    // the one that can actually be acted on without a live call.
    const report = await runQa(pinDraft({ board: undefined }), { skipLlm: true });

    expect(boardIssues(report)).toEqual([]);
  });

  it("says nothing when Pinterest is not connected", async () => {
    // Not connected is already reported elsewhere. Asking an unconnected account
    // for its boards would only produce a confusing second failure.
    connectStatus.mockResolvedValue({ connected: false });

    const report = await runQa(pinDraft(), { skipLlm: true });

    expect(boardIssues(report)).toEqual([]);
    expect(listBoards).not.toHaveBeenCalled();
  });

  it("says nothing when the routed transport cannot list boards", async () => {
    // A transport without listBoards cannot answer the question. Treating the
    // silence as "no boards" would invent a hard failure out of a capability gap.
    resetTransports();
    invalidateConnectedAccounts();
    registerTransport(pinterestTransport({ listBoards: undefined }));

    const report = await runQa(pinDraft(), { skipLlm: true });

    expect(boardIssues(report)).toEqual([]);
  });

  it("says nothing when the boards call throws", async () => {
    // The vendor-hiccup case this function exists to absorb: a 500 from
    // Pinterest must not block a draft that is otherwise ready.
    listBoards.mockRejectedValue(new Error("pinterest 503"));

    const report = await runQa(pinDraft(), { skipLlm: true });

    expect(boardIssues(report)).toEqual([]);
  });

  it("says nothing when the connection lookup itself throws", async () => {
    connectStatus.mockRejectedValue(new Error("token exchange failed"));

    const report = await runQa(pinDraft(), { skipLlm: true });

    expect(boardIssues(report)).toEqual([]);
  });

  it("still reports the MECHANICAL findings when the live call fails", async () => {
    // Degrading to silence is scoped to the board question alone. The rest of
    // QA is unaffected, so a broken Pinterest does not blind the whole report.
    listBoards.mockRejectedValue(new Error("pinterest 503"));
    const draft = pinDraft({ content: "x".repeat(2000) });

    const report = await runQa(draft, { skipLlm: true });

    expect(boardIssues(report)).toEqual([]);
    expect(report.issues.some((i) => i.code === "over-limit")).toBe(true);
  });
});
