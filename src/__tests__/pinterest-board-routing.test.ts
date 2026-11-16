import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  assertPinterestBoard,
  PublishPreflightError,
  registerTransport,
  resetTransports,
  setTransportOverridesResolver,
  type ConnectedMap,
  type DirectTransport,
  type PlatformRender,
} from "../index.js";

/**
 * Which VENDOR gets asked about boards.
 *
 * ⚠️ THIS SUITE OUTLIVED THE BUG IT WAS WRITTEN FOR, and is kept because the
 * refusal semantics it pins are the valuable half. The original hazard: after a
 * cutover `connected.pinterest.accountId` stops being an aggregator channel id
 * and becomes a Pinterest account id, while the aggregator's boards endpoint
 * still expected the former. Asking the wrong service about the wrong
 * identifier did not throw — it returned nothing, which read as the definitive
 * answer "this account has no boards" and refused every Pinterest publish.
 *
 * There is only one vendor now, so the "before cutover" half is gone. What must
 * not drift: a lookup FAILURE proceeds, only a definitive answer refuses.
 */

const connected: ConnectedMap = {
  pinterest: { accountId: "acct-under-test", displayName: "Acme" },
};

function render(board?: string): PlatformRender {
  return {
    platform: "pinterest",
    content: "pin copy",
    mediaIndices: [],
    ...(board ? { board: { id: board } } : {}),
  } as PlatformRender;
}

function transportWith(listBoards: DirectTransport["listBoards"]): DirectTransport {
  return {
    platform: "pinterest",
    channelRules: () => ({ maxLength: 800, countMode: "utf16" }),
    connectStatus: async () => ({ connected: true, accountId: "acct", displayName: "Acme" }),
    publishNow: async () => ({ ref: "pin-1" }),
    deletePost: async () => {},
    postFacts: async () => new Map(),
    postUrl: (r) => `https://www.pinterest.com/pin/${r}/`,
    listBoards,
  };
}

beforeEach(() => {
  resetTransports();
});

afterEach(() => {
  resetTransports();
  setTransportOverridesResolver(null);
});

/** Cut Pinterest over: register a transport AND set the override. */
function cutOver(listBoards: DirectTransport["listBoards"]) {
  registerTransport(transportWith(listBoards));
  setTransportOverridesResolver(async () => ({ pinterest: "direct" }));
}

describe("board routing", () => {
  it("asks the TRANSPORT", async () => {
    const listBoards = vi.fn().mockResolvedValue([{ id: "board-1", name: "Product" }]);
    cutOver(listBoards);

    await assertPinterestBoard([render("board-1")], connected);

    expect(listBoards).toHaveBeenCalled();
  });

  it("refuses an unknown board and enumerates the real ones", async () => {
    cutOver(vi.fn().mockResolvedValue([{ id: "board-1", name: "Product" }]));

    await expect(assertPinterestBoard([render("board-stale")], connected)).rejects.toThrow(
      PublishPreflightError,
    );
    await expect(assertPinterestBoard([render("board-stale")], connected)).rejects.toThrow(
      /Product \(board-1\)/,
    );
  });

  it("refuses when the account genuinely has no boards", async () => {
    cutOver(vi.fn().mockResolvedValue([]));

    await expect(assertPinterestBoard([render("board-1")], connected)).rejects.toThrow(
      /has no boards/,
    );
  });

  /**
   * A flaky boards call must not become the thing that blocks a publish, which
   * is the reason the "no boards" case above has to be a DEFINITIVE empty list
   * rather than an error.
   */
  it("proceeds when the lookup itself fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    cutOver(vi.fn().mockRejectedValue(new Error("pinterest 503")));

    await expect(assertPinterestBoard([render("board-1")], connected)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it("still says nothing when no board is configured at all", async () => {
    // assertPublishable owns that error and words it in terms of what to set.
    const listBoards = vi.fn();
    cutOver(listBoards);

    await expect(assertPinterestBoard([render()], connected)).resolves.toBeUndefined();
    expect(listBoards).not.toHaveBeenCalled();
  });
});
