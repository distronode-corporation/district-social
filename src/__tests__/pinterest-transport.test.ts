import { describe, it, expect, vi, beforeEach } from "vitest";

// The transport is a business-logic layer on top of the vendor client, so it
// is tested against a mocked client — bluesky-transport.test.ts's own pattern
// for bluesky.ts. PinterestError stays real: isPinterestNotFound's
// `instanceof` + status check is exactly the thing under test in the
// delete/postFacts not-found cases.
vi.mock("../pinterest.js", async (importActual) => {
  const actual = await importActual<typeof import("../pinterest.js")>();
  return {
    ...actual,
    createPin: vi.fn(),
    getPin: vi.fn(),
    deletePin: vi.fn(),
    listBoards: vi.fn(),
    getUserAccount: vi.fn(),
  };
});

import {
  PinterestError,
  createPin,
  getPin,
  deletePin,
  listBoards,
  getUserAccount,
} from "../pinterest.js";
import { pinterestTransport } from "../pinterest-transport.js";
import { PublishPreflightError, publishDestination } from "../publish.js";
import type { DirectPublishInput, PublishDestination } from "../transport.js";
import type { MediaAsset, PlatformRender } from "../types.js";

const createPinMock = createPin as unknown as ReturnType<typeof vi.fn>;
const getPinMock = getPin as unknown as ReturnType<typeof vi.fn>;
const deletePinMock = deletePin as unknown as ReturnType<typeof vi.fn>;
const listBoardsMock = listBoards as unknown as ReturnType<typeof vi.fn>;
const getUserAccountMock = getUserAccount as unknown as ReturnType<typeof vi.fn>;

function notFound(): PinterestError {
  return new PinterestError(404, JSON.stringify({ code: 8, message: "Pin not found" }), "GET", "/pins/x");
}

function render(overrides: Partial<PlatformRender> = {}): PlatformRender {
  return { platform: "pinterest", content: "pin copy", mediaIndices: [], board: { id: "board-1" }, ...overrides };
}

function image(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    path: "/tmp/card.png",
    type: "image",
    mimeType: "image/png",
    size: 900_000,
    url: "https://cdn.example.com/card.png",
    altText: "a screenshot of the Acme dashboard",
    ...overrides,
  };
}

function destination(overrides: Partial<PublishDestination> = {}): PublishDestination {
  return { board: "board-1", link: "https://www.example.com/blog/post", ...overrides };
}

function input(overrides: Partial<DirectPublishInput> = {}): DirectPublishInput {
  return {
    render: render(),
    media: [image()],
    draftId: "draft-1",
    destination: destination(),
    ...overrides,
  };
}

beforeEach(() => {
  createPinMock.mockReset();
  getPinMock.mockReset();
  deletePinMock.mockReset();
  listBoardsMock.mockReset();
  getUserAccountMock.mockReset();
  vi.stubGlobal("fetch", vi.fn());
});

describe("pinterest transport", () => {
  it("declares the real 800-char description limit (not the stale 500 Postiz imposed)", () => {
    expect(pinterestTransport.channelRules()).toMatchObject({ maxLength: 800, countMode: "utf16", maxImages: 5 });
  });

  describe("connectStatus", () => {
    it("reports connected with the account's id/username", async () => {
      getUserAccountMock.mockResolvedValue({ id: "acct-1", username: "examplebrand" });
      const status = await pinterestTransport.connectStatus();
      expect(status).toEqual({ connected: true, accountId: "acct-1", displayName: "examplebrand" });
    });

    it("resolves with connected:false and a reason instead of rejecting on a bad credential", async () => {
      getUserAccountMock.mockRejectedValue(new PinterestError(401, "invalid token", "GET", "/user_account"));
      const status = await pinterestTransport.connectStatus();
      expect(status.connected).toBe(false);
      expect(status.accountId).toBe("");
      expect(status.reason).toMatch(/invalid token/);
    });
  });

  describe("postUrl", () => {
    it("builds the public pin permalink from the id", () => {
      expect(pinterestTransport.postUrl("123456")).toBe("https://www.pinterest.com/pin/123456/");
    });
  });

  describe("publishNow", () => {
    it("creates a pin and returns its id and url", async () => {
      // A real Response: the shared media fetch streams res.body under a byte
      // cap (media-fetch.ts), so a plain { ok, arrayBuffer } object can no
      // longer stand in for what fetch actually returns.
      (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => new Response(new Uint8Array([1, 2, 3])));
      createPinMock.mockResolvedValue({ id: "pin-1", link: undefined, title: "t", boardId: "board-1" });

      const result = await pinterestTransport.publishNow(input());

      expect(result).toEqual({ ref: "pin-1", url: "https://www.pinterest.com/pin/pin-1/" });
      expect(createPinMock).toHaveBeenCalledWith(
        expect.objectContaining({
          boardId: "board-1",
          description: "pin copy",
          altText: "a screenshot of the Acme dashboard",
          images: [{ contentType: "image/png", data: Buffer.from([1, 2, 3]).toString("base64") }],
        }),
      );
    });

    /**
     * Both sources must be empty. A board on EITHER the render (the operator
     * picked one on the draft) or the destination (the Social HQ default)
     * is enough to publish.
     */
    it("throws before calling the vendor when neither the render nor the settings supply a board", async () => {
      await expect(
        pinterestTransport.publishNow(
          input({ render: render({ board: undefined }), destination: destination({ board: undefined }) }),
        ),
      ).rejects.toThrow(/no destination board id/);
      expect(createPinMock).not.toHaveBeenCalled();
    });

    /**
     * The regression this whole `destination` field exists to prevent. A pin
     * without its click-through URL publishes fine, returns a real id and
     * reports analytics, while being useless — and nothing anywhere alerts on
     * it. The link is NOT in render.content: playbook.ts strips it out
     * deliberately, because Pinterest carries it as its own field.
     */
    it("sends the draft's destination link, which never appears in the copy", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => new Response(new Uint8Array([1, 2, 3])));
      createPinMock.mockResolvedValue({ id: "pin-1" });

      await pinterestTransport.publishNow(input());

      expect(createPinMock).toHaveBeenCalledWith(
        expect.objectContaining({ link: "https://www.example.com/blog/post" }),
      );
      // The copy itself carries no URL, which is exactly why the link has to
      // travel separately.
      expect(createPinMock.mock.calls[0][0].description).not.toContain("http");
    });

    // A tracked pin links straight to the post with its UTMs (no /l/ redirect,
    // which Pinterest blocks or warns on); publishDestination picks it.
    it("sends a tracked pin's UTM'd link, as publishDestination resolves it", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => new Response(new Uint8Array([1, 2, 3])));
      createPinMock.mockResolvedValue({ id: "pin-1" });
      const post = "https://www.example.com/blog/post";
      const pinLink = `${post}?utm_source=pinterest&utm_medium=social&utm_campaign=socialhq_1&utm_content=pinCode`;
      const r = render({ pinLink });

      await pinterestTransport.publishNow(
        input({ render: r, destination: publishDestination(r, { text: "t", hashtags: [], media: [], link: post }) }),
      );

      expect(createPinMock).toHaveBeenCalledWith(expect.objectContaining({ link: pinLink }));
    });

    /**
     * The Social HQ default board (settings "defaultPinterestBoard") arrives
     * on destination, not on the render. Preferring the render here would
     * refuse publishes the aggregator path accepted.
     */
    it("falls back to the settings-default board when the draft names none", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => new Response(new Uint8Array([1, 2, 3])));
      createPinMock.mockResolvedValue({ id: "pin-2" });

      await pinterestTransport.publishNow(
        input({ render: render({ board: undefined }), destination: destination({ board: "default-board" }) }),
      );

      expect(createPinMock).toHaveBeenCalledWith(expect.objectContaining({ boardId: "default-board" }));
    });

    it("throws a clear error rather than posting when a video is attached (unsupported)", async () => {
      const video: MediaAsset = {
        path: "/tmp/clip.mp4",
        type: "video",
        mimeType: "video/mp4",
        size: 5_000_000,
        url: "https://cdn.example.com/clip.mp4",
      };
      const err = await pinterestTransport.publishNow(input({ media: [video] })).catch((e: unknown) => e);
      // The same class every other transport's media refusal uses, so callers
      // read it as "refused before sending", not as a vendor failure.
      expect(err).toBeInstanceOf(PublishPreflightError);
      expect((err as Error).message).toMatch(/video pins are not supported/);
      expect(createPinMock).not.toHaveBeenCalled();
    });

    it("throws when no attached media resolves to a sendable image", async () => {
      await expect(pinterestTransport.publishNow(input({ media: [] }))).rejects.toThrow(
        /needs at least one image/,
      );
      expect(createPinMock).not.toHaveBeenCalled();
    });

    it("throws a clear error for an unsupported image mime type rather than dropping it silently", async () => {
      const webp = image({ mimeType: "image/webp" });
      await expect(pinterestTransport.publishNow(input({ media: [webp] }))).rejects.toThrow(
        /unsupported image mime type/,
      );
      expect(createPinMock).not.toHaveBeenCalled();
    });

    it("builds a multi-image carousel body when 2-5 images are attached", async () => {
      // mockImplementation: a carousel fetches each image, and a Response body
      // can only be consumed once.
      (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => new Response(new Uint8Array([9])));
      createPinMock.mockResolvedValue({ id: "pin-2", boardId: "board-1" });
      const images = [image({ url: "https://cdn/1.png" }), image({ url: "https://cdn/2.png" })];

      await pinterestTransport.publishNow(input({ media: images }));

      expect(createPinMock).toHaveBeenCalledWith(
        expect.objectContaining({
          images: [
            { contentType: "image/png", data: Buffer.from([9]).toString("base64") },
            { contentType: "image/png", data: Buffer.from([9]).toString("base64") },
          ],
        }),
      );
    });

    it("caps uploads at 5 images even if more are attached", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => new Response(new Uint8Array([1])));
      createPinMock.mockResolvedValue({ id: "pin-3", boardId: "board-1" });
      const sixImages = Array.from({ length: 6 }, (_, i) => image({ url: `https://cdn/${i}.png` }));

      await pinterestTransport.publishNow(input({ media: sixImages }));

      const call = createPinMock.mock.calls[0][0] as { images: unknown[] };
      expect(call.images).toHaveLength(5);
    });
  });

  describe("deletePost", () => {
    it("deletes normally when the pin still exists", async () => {
      deletePinMock.mockResolvedValue(undefined);
      await expect(pinterestTransport.deletePost("pin-1")).resolves.toBeUndefined();
    });

    it("treats an already-gone pin (404) as SUCCESS, not a failure", async () => {
      deletePinMock.mockRejectedValue(notFound());
      await expect(pinterestTransport.deletePost("pin-gone")).resolves.toBeUndefined();
    });

    it("still throws for a real failure (e.g. auth), not just swallowing everything", async () => {
      deletePinMock.mockRejectedValue(new PinterestError(401, "token expired", "DELETE", "/pins/x"));
      await expect(pinterestTransport.deletePost("pin-1")).rejects.toThrow(/token expired/);
    });
  });

  describe("postFacts", () => {
    it("maps a found pin to PUBLISHED/released", async () => {
      getPinMock.mockResolvedValue({ id: "pin-1", boardId: "board-1" });
      const facts = await pinterestTransport.postFacts(["pin-1"]);
      expect(facts.get("pin-1")).toEqual({ state: "PUBLISHED", released: true, platform: "pinterest" });
    });

    /**
     * A confirmed 404 tells us more than Bluesky's batch lookup ever can, and
     * it STILL must not become ERROR. ERROR is a permanent verdict
     * (reconcile-verdict.ts turns it into a failed leg and never revisits it),
     * while the reconcile policy puts a one-hour grace on "not found" that
     * postFacts cannot apply because it receives no timestamps. A QUEUE that
     * should have been ERROR gets corrected on the next pass; an ERROR that
     * should have been QUEUE marks a live pin dead for good.
     */
    it("maps a confirmed-404 pin to QUEUE, because ERROR is the caller's verdict to make", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      getPinMock.mockRejectedValue(notFound());
      const facts = await pinterestTransport.postFacts(["pin-gone"]);
      // QUEUE, but flagged `absent`: a clean 404 is an unambiguous vendor
      // answer, so the caller is told which kind of QUEUE this is and can
      // apply its own grace window. The state itself stays QUEUE.
      expect(facts.get("pin-gone")).toEqual({
        state: "QUEUE",
        released: false,
        platform: "pinterest",
        absent: true,
      });
      // The extra information is not discarded silently; it is logged so it
      // stays visible until a caller can act on it.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("confirmed absent"));
      warn.mockRestore();
    });

    it("maps an unreachable vendor (non-404 failure) to QUEUE, never ERROR", async () => {
      getPinMock.mockRejectedValue(new PinterestError(503, "upstream unavailable", "GET", "/pins/x"));
      const facts = await pinterestTransport.postFacts(["pin-a", "pin-b"]);
      expect(facts.get("pin-a")).toEqual({ state: "QUEUE", released: false, platform: "pinterest" });
      expect(facts.get("pin-b")).toEqual({ state: "QUEUE", released: false, platform: "pinterest" });
    });

    it("returns an empty map for an empty ref list without calling the vendor", async () => {
      const facts = await pinterestTransport.postFacts([]);
      expect(facts.size).toBe(0);
      expect(getPinMock).not.toHaveBeenCalled();
    });

    it("handles a large batch by chunking concurrency rather than firing every request at once", async () => {
      let inFlight = 0;
      let maxInFlight = 0;
      getPinMock.mockImplementation(async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight -= 1;
        return { id: "x", boardId: "b" };
      });
      const refs = Array.from({ length: 25 }, (_, i) => `pin-${i}`);
      const facts = await pinterestTransport.postFacts(refs);
      expect(facts.size).toBe(25);
      expect(getPinMock).toHaveBeenCalledTimes(25);
      expect(maxInFlight).toBeLessThanOrEqual(10);
    });
  });

  describe("listBoards", () => {
    it("returns the boards from the client", async () => {
      listBoardsMock.mockResolvedValue([{ id: "b1", name: "Board One" }]);
      await expect(pinterestTransport.listBoards!()).resolves.toEqual([{ id: "b1", name: "Board One" }]);
    });

    it("propagates a lookup failure rather than reporting an empty list", async () => {
      listBoardsMock.mockRejectedValue(new PinterestError(500, "internal error", "GET", "/boards"));
      await expect(pinterestTransport.listBoards!()).rejects.toBeInstanceOf(PinterestError);
    });
  });
});

describe("pinterest transport: non-Error failures, url-less assets and media host errors", () => {
  const fetchMock = () => fetch as unknown as ReturnType<typeof vi.fn>;

  it("connectStatus stringifies a thrown non-Error into the reason", async () => {
    getUserAccountMock.mockRejectedValue("socket hang up");
    const status = await pinterestTransport.connectStatus();
    expect(status).toEqual({ connected: false, accountId: "", displayName: "", reason: "socket hang up" });
  });

  it("refuses to create the pin when the media host answers non-2xx", async () => {
    fetchMock().mockResolvedValue({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) });
    await expect(pinterestTransport.publishNow(input())).rejects.toThrow(
      "pinterest: failed to fetch media asset (404): https://cdn.example.com/card.png",
    );
    expect(createPinMock).not.toHaveBeenCalled();
  });

  it("refuses a selected asset with no public url instead of pinning without it", async () => {
    fetchMock().mockImplementation(async () => new Response(new Uint8Array([4])));
    createPinMock.mockResolvedValue({ id: "pin-2", link: undefined, title: "t", boardId: "board-1" });

    await pinterestTransport.publishNow(input({ media: [image({ url: undefined, path: "/lib/a.png" }), image()] }));

    expect(fetchMock()).toHaveBeenCalledTimes(1);
    expect(createPinMock).toHaveBeenCalledWith(
      expect.objectContaining({ images: [{ contentType: "image/png", data: Buffer.from([4]).toString("base64") }] }),
    );
  });

  it("postFacts logs a non-Error lookup failure and reports QUEUE", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    getPinMock.mockRejectedValue("ECONNRESET");
    const facts = await pinterestTransport.postFacts(["pin-1"]);
    expect(facts.get("pin-1")).toEqual({ state: "QUEUE", released: false, platform: "pinterest" });
    expect(warn).toHaveBeenCalledWith("[pinterest] postFacts lookup failed for pin-1: ECONNRESET");
    warn.mockRestore();
  });
});
