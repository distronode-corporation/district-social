import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Pinterest coverage. The load-bearing facts, all verified live against
 * `GET /integration-settings/:id`, are: `board` is REQUIRED and is
 * an id rather than a name, media is mandatory, the description caps at 500 and
 * the title at 100, and a video pin needs a separate cover image.
 *
 * The boards-lookup tests are the important ones. The mapper's contract (empty
 * means empty, unreadable throws) is what stops "no boards" being reported about
 * an account that has plenty.
 */

vi.mock("../media.js", () => ({ ensureUploaded: vi.fn(async (a: unknown) => a) }));

import {
  assertPinterestBoard,
  assertPublishable,
  PublishPreflightError,
  type ConnectedMap,
} from "../publish.js";
import { registerTransport, resetTransports } from "../transport.js";
import type { DirectTransport } from "../transport.js";
import { deterministicChecks } from "../qa.js";
import { SPECS } from "../specs.js";
import { ALL_PLATFORMS } from "../types.js";
import { PLATFORM_IDENTIFIERS, platformForIdentifier } from "../provider-map.js";
import type { Draft, MediaAsset, PlatformRender } from "../types.js";

/**
 * ⚠️ THE BOARD LOOKUP MOVED VENDORS. It used to go through the aggregator's
 * channel-tool endpoint, so these tests stubbed `fetch` and also covered that
 * client's response mapper (which had its own tests in postiz.test.ts). It now
 * goes through `pinterestTransport.listBoards()`, so the seam under test is the
 * transport, and a fake one is registered per test.
 */
const listBoards = vi.fn();

function pinterestTransport(): DirectTransport {
  return {
    platform: "pinterest",
    channelRules: () => ({ maxLength: 500, countMode: "utf16" }),
    connectStatus: async () => ({ connected: true, accountId: "pin-1", displayName: "examplebrand" }),
    publishNow: async () => ({ ref: "pin-x" }),
    deletePost: async () => {},
    postFacts: async () => new Map(),
    postUrl: (r: string) => `https://pinterest.com/pin/${r}`,
    listBoards,
  };
}

function render(overrides: Partial<PlatformRender> = {}): PlatformRender {
  return { platform: "pinterest", content: "pin copy", mediaIndices: [], ...overrides };
}

function draft(overrides: Partial<Draft> = {}): Draft {
  return {
    id: "d1",
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:00.000Z",
    status: "draft",
    source: { text: "pin copy", hashtags: [], media: [] },
    targets: ["pinterest"],
    renders: [],
    ...overrides,
  };
}

function image(path = "card.png"): MediaAsset {
  return { path, type: "image", mimeType: "image/png", size: 1000, url: `https://cdn/${path}` };
}

function video(path = "clip.mp4"): MediaAsset {
  return { path, type: "video", mimeType: "video/mp4", size: 5000, url: `https://cdn/${path}` };
}

const connected: ConnectedMap = {
  pinterest: { accountId: "int_pin", displayName: "examplebrand" },
};

const ORIGINAL_BOARD = process.env.SOCIALMETA_DEFAULT_PINTEREST_BOARD;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.SOCIALMETA_DEFAULT_PINTEREST_BOARD;
  resetTransports();
  // Registration alone is not routing: assertPinterestBoard resolves through
  // `directTransportFor`, which consults the override.
  process.env.SOCIALMETA_TRANSPORT_OVERRIDES = JSON.stringify({ pinterest: "direct" });
  registerTransport(pinterestTransport());
});
afterEach(() => {
  resetTransports();
  delete process.env.SOCIALMETA_TRANSPORT_OVERRIDES;
  if (ORIGINAL_BOARD === undefined) delete process.env.SOCIALMETA_DEFAULT_PINTEREST_BOARD;
  else process.env.SOCIALMETA_DEFAULT_PINTEREST_BOARD = ORIGINAL_BOARD;
});

describe("pinterest is a modelled platform", () => {
  it("is in ALL_PLATFORMS with a spec and an identifier mapping", () => {
    expect(ALL_PLATFORMS).toContain("pinterest");
    expect(SPECS.pinterest).toBeDefined();
    expect(PLATFORM_IDENTIFIERS.pinterest).toEqual(["pinterest"]);
    // The mapping has to work in reverse too, or a connected channel is
    // invisible in whichever surface does the reverse lookup.
    expect(platformForIdentifier("pinterest")).toBe("pinterest");
  });

  it("carries the vendor-verified limits", () => {
    const s = SPECS.pinterest;
    // 800, from Pinterest's own OpenAPI (`PinCreate.description` maxLength).
    // This assertion previously read 500 under the heading "vendor-verified",
    // which is how the wrong number survived: the 500 came from the Postiz
    // aggregator's narrower channel schema, not from Pinterest, and a green
    // test asserting it made the mistake look confirmed. The vendor was never
    // the source of the number this test was defending.
    expect(s.maxChars).toBe(800);
    expect(s.titleMaxChars).toBe(100);
    expect(s.maxImages).toBe(5);
    expect(s.requiresMedia).toBe(true);
    expect(s.requiresVideo).toBe(false);
    // Hashtags are deprecated on Pinterest, and the destination URL is a
    // separate publish field rather than something to work around.
    expect(s.hashtagPlacement).toBe("none");
    expect(s.idealHashtags).toEqual([0, 0]);
    expect(s.linksClickable).toBe(false);
    expect(s.linkAdvice).toBeTruthy();
  });

  it("does not claim thread or first-comment support", () => {
    expect(SPECS.pinterest.supportsThreads).toBe(false);
    expect(SPECS.pinterest.supportsFirstComment).toBe(false);
  });
});


/**
 * ⚠️ `platformSettings` BECAME `assertPublishable`. The old function built the
 * aggregator's `settings` object and raised the preflight refusals while doing
 * it, so most of these tests asserted that object's shape (board/title/link,
 * the 100-char title truncation, omitting empty strings because `link` was
 * declared `format: url`). That payload is not sent to anything now — the
 * pinterest transport takes a `PublishDestination` — so `publishDestination`
 * owns the shape and this owns the refusal.
 */
describe("assertPublishable — pinterest", () => {
  it("accepts a board id from the render", () => {
    expect(() => assertPublishable(render({ board: { id: "b_123" } }), draft())).not.toThrow();
  });

  it("accepts the configured default board", () => {
    process.env.SOCIALMETA_DEFAULT_PINTEREST_BOARD = "b_default";
    expect(() => assertPublishable(render(), draft())).not.toThrow();
  });

  it("refuses when no board is resolvable", () => {
    // The vendor answers a missing board with a generic 400 whose cause never
    // reaches the operator, so this must fail before the send.
    expect(() => assertPublishable(render(), draft())).toThrow(PublishPreflightError);
    expect(() => assertPublishable(render(), draft())).toThrow(/needs a destination board/i);
  });
});

describe("assertPinterestBoard", () => {
  it("passes when the configured board exists", async () => {
    listBoards.mockResolvedValue([{ id: "b_1", name: "Voice AI" }]);
    await expect(
      assertPinterestBoard([render({ board: { id: "b_1" } })], connected),
    ).resolves.toBeUndefined();
  });

  it("refuses when the account has no boards, naming the account", async () => {
    listBoards.mockResolvedValue([]);
    await expect(
      assertPinterestBoard([render({ board: { id: "b_1" } })], connected),
    ).rejects.toThrow(/has no boards/i);
  });

  it("refuses an unknown board id and lists what does exist", async () => {
    listBoards.mockResolvedValue([{ id: "b_real", name: "Voice AI" }]);
    await expect(
      assertPinterestBoard([render({ board: { id: "b_stale" } })], connected),
    ).rejects.toThrow(/Voice AI \(b_real\)/);
  });

  it("stays quiet when the lookup itself fails", async () => {
    // A check that cannot run must not become a new way for publishing to fail.
    listBoards.mockRejectedValue(new Error("pinterest 502"));
    await expect(
      assertPinterestBoard([render({ board: { id: "b_1" } })], connected),
    ).resolves.toBeUndefined();
  });

  it("does not call the vendor when pinterest is not a target", async () => {
    await expect(
      assertPinterestBoard([{ platform: "bluesky", content: "hi", mediaIndices: [] }], connected),
    ).resolves.toBeUndefined();
    expect(listBoards).not.toHaveBeenCalled();
  });

  it("does not call the vendor when no board is configured", async () => {
    // assertPublishable raises that case with a message about what to set;
    // pre-empting it here would replace it with a worse one.
    await expect(assertPinterestBoard([render()], connected)).resolves.toBeUndefined();
    expect(listBoards).not.toHaveBeenCalled();
  });

  it("does nothing when pinterest is not connected", async () => {
    await expect(
      assertPinterestBoard([render({ board: { id: "b_1" } })], {}),
    ).resolves.toBeUndefined();
    expect(listBoards).not.toHaveBeenCalled();
  });
});

describe("pinterest QA gates", () => {
  function pinDraft(r: Partial<PlatformRender>, media: MediaAsset[] = [image()]): Draft {
    const built = render({ mediaIndices: media.map((_, i) => i), ...r });
    return draft({
      source: { text: "pin copy", hashtags: [], media },
      renders: [built],
    });
  }

  it("fails a pin with no board", () => {
    const codes = deterministicChecks(pinDraft({})).map((i) => i.code);
    expect(codes).toContain("board-missing");
  });

  it("accepts the configured default as satisfying the board gate", () => {
    // QA has to consult the SAME fallback the publisher does, or it blocks
    // drafts that would in fact publish fine and teaches operators to force past
    // the gate.
    process.env.SOCIALMETA_DEFAULT_PINTEREST_BOARD = "b_default";
    const codes = deterministicChecks(pinDraft({})).map((i) => i.code);
    expect(codes).not.toContain("board-missing");
  });

  it("fails a pin with no media at all", () => {
    const codes = deterministicChecks(pinDraft({ board: { id: "b" } }, [])).map((i) => i.code);
    expect(codes).toContain("media-required");
  });

  it("accepts up to 5 images and rejects a 6th", () => {
    const five = [1, 2, 3, 4, 5].map((n) => image(`c${n}.png`));
    expect(
      deterministicChecks(pinDraft({ board: { id: "b" } }, five)).map((i) => i.code),
    ).not.toContain("too-many-images");
    expect(
      deterministicChecks(pinDraft({ board: { id: "b" } }, [...five, image("c6.png")])).map(
        (i) => i.code,
      ),
    ).toContain("too-many-images");
  });

  it("does not flag a video plus its cover as mixed media", () => {
    // The generic mixed-media rule would reject Pinterest's one legal mixed
    // shape, which is why the spec allows mixing and pinterestMediaShape owns
    // the real rule.
    const codes = deterministicChecks(
      pinDraft({ board: { id: "b" } }, [video(), image()]),
    ).map((i) => i.code);
    expect(codes).not.toContain("mixed-media");
    expect(codes).not.toContain("pinterest-media-shape");
  });

  it("fails a video pin with no cover image", () => {
    const issues = deterministicChecks(pinDraft({ board: { id: "b" } }, [video()]));
    const shape = issues.find((i) => i.code === "pinterest-media-shape");
    expect(shape?.severity).toBe("fail");
    expect(shape?.message).toMatch(/cover image/i);
  });

  it("fails a video pin with more than one cover image", () => {
    const codes = deterministicChecks(
      pinDraft({ board: { id: "b" } }, [video(), image("a.png"), image("b.png")]),
    ).map((i) => i.code);
    expect(codes).toContain("pinterest-media-shape");
  });

  it("fails a pin carrying two videos", () => {
    const issues = deterministicChecks(
      pinDraft({ board: { id: "b" } }, [video("a.mp4"), video("b.mp4"), image()]),
    );
    expect(issues.find((i) => i.code === "pinterest-media-shape")?.message).toMatch(/only one/i);
  });

  it("raises no shape finding for an image-only pin", () => {
    const codes = deterministicChecks(
      pinDraft({ board: { id: "b" } }, [image("a.png"), image("b.png")]),
    ).map((i) => i.code);
    expect(codes).not.toContain("pinterest-media-shape");
  });

  it("gives Pinterest-specific advice for a URL in the copy, not 'link in bio'", () => {
    const issues = deterministicChecks(
      pinDraft({ board: { id: "b" }, content: "see https://example.com" }),
    );
    const dead = issues.find((i) => i.code === "dead-link");
    expect(dead?.message).toMatch(/separate field/i);
    expect(dead?.message).not.toMatch(/link in bio/i);
  });

  it("still tells Instagram to use link-in-bio", () => {
    // Guards the shared default: adding linkAdvice for Pinterest must not
    // silently change the advice every other no-clickable-links platform gives.
    const igDraft = draft({
      targets: ["instagram"],
      source: { text: "x", hashtags: [], media: [image()] },
      renders: [
        {
          platform: "instagram",
          content: "see https://example.com",
          mediaIndices: [0],
        },
      ],
    });
    const dead = deterministicChecks(igDraft).find((i) => i.code === "dead-link");
    expect(dead?.message).toMatch(/link in bio/i);
  });
});
