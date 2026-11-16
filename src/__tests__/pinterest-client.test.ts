import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Coverage for the new pinterest.ts vendor client (pinterest-transport.ts's
 * "how do we talk to it" half). Named pinterest-client.test.ts, NOT
 * pinterest.test.ts: that filename is already taken by existing coverage of
 * publish.ts's Postiz-path board/QA logic (assertPinterestBoard,
 * platformSettings, pinterestBoards from postiz.ts) and must not be touched.
 */

import {
  PinterestError,
  isPinterestNotFound,
  setPinterestTokenResolver,
  createPin,
  getPin,
  deletePin,
  listBoards,
  getUserAccount,
} from "../pinterest.js";

const TOKEN = "test-access-token";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function emptyResponse(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => "",
  } as unknown as Response;
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  setPinterestTokenResolver(async () => TOKEN);
});

describe("pinterest client", () => {
  describe("token resolver", () => {
    it("throws a clear PinterestError when no resolver is registered", async () => {
      setPinterestTokenResolver(null);
      await expect(getPin("1")).rejects.toThrow(/no Pinterest token resolver/);
    });

    it("throws when the resolver returns an empty token", async () => {
      setPinterestTokenResolver(async () => "");
      await expect(getPin("1")).rejects.toThrow(/empty token/);
    });

    it("calls the resolver fresh on every request rather than caching it", async () => {
      const resolver = vi.fn(async () => TOKEN);
      setPinterestTokenResolver(resolver);
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        jsonResponse(200, { id: "1", link: null, title: null, board_id: "b1" }),
      );
      await getPin("1");
      await getPin("2");
      expect(resolver).toHaveBeenCalledTimes(2);
    });

    it("sends the token as a Bearer header", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        jsonResponse(200, { id: "1", link: null, title: null, board_id: "b1" }),
      );
      await getPin("1");
      const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    });
  });

  describe("createPin", () => {
    it("creates a single-image pin and returns its id", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        jsonResponse(201, { id: "pin-1", link: null, title: "A pin", board_id: "board-1" }),
      );
      const pin = await createPin({
        boardId: "board-1",
        title: "A pin",
        description: "some description",
        images: [{ contentType: "image/png", data: "YmFzZTY0" }],
      });
      expect(pin).toEqual({ id: "pin-1", link: undefined, title: "A pin", boardId: "board-1" });

      const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe("https://api.pinterest.com/v5/pins");
      expect(init.method).toBe("POST");
      const body = JSON.parse(init.body as string);
      expect(body.board_id).toBe("board-1");
      expect(body.media_source).toEqual({
        source_type: "image_base64",
        content_type: "image/png",
        data: "YmFzZTY0",
      });
    });

    it("builds a multiple_image_base64 carousel source for 2+ images", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        jsonResponse(201, { id: "pin-2", link: null, title: null, board_id: "board-1" }),
      );
      await createPin({
        boardId: "board-1",
        images: [
          { contentType: "image/jpeg", data: "aaa" },
          { contentType: "image/png", data: "bbb" },
        ],
      });
      const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = JSON.parse(init.body as string);
      expect(body.media_source).toEqual({
        source_type: "multiple_image_base64",
        items: [
          { content_type: "image/jpeg", data: "aaa" },
          { content_type: "image/png", data: "bbb" },
        ],
      });
    });

    it("throws before making a request when no boardId is given", async () => {
      await expect(
        createPin({ boardId: "", images: [{ contentType: "image/png", data: "x" }] }),
      ).rejects.toThrow(/requires a boardId/);
      expect(fetch).not.toHaveBeenCalled();
    });

    it("throws before making a request when images is empty", async () => {
      await expect(createPin({ boardId: "board-1", images: [] })).rejects.toThrow(
        /requires at least one image/,
      );
      expect(fetch).not.toHaveBeenCalled();
    });

    it("wraps a vendor rejection (e.g. bad board id) in a PinterestError carrying the status", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        jsonResponse(400, { code: 2, message: "board_id not found" }),
      );
      await expect(
        createPin({ boardId: "nonexistent", images: [{ contentType: "image/png", data: "x" }] }),
      ).rejects.toMatchObject({ status: 400 });
    });

    it("attaches an abort signal to the request (long create-pin timeout path)", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        jsonResponse(201, { id: "pin-3", link: null, title: null, board_id: "board-1" }),
      );
      await createPin({ boardId: "board-1", images: [{ contentType: "image/png", data: "x" }] });
      // AbortSignal.timeout's own ms value isn't introspectable, so this just
      // confirms a signal was attached at all; the two distinct constants
      // (15s vs 120s) are exercised implicitly by every other test in this
      // file using the short path (getPin/deletePin/listBoards/getUserAccount).
      const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });
  });

  describe("getPin", () => {
    it("returns the pin on success", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        jsonResponse(200, { id: "pin-1", link: "https://example.com", title: "t", board_id: "b1" }),
      );
      const pin = await getPin("pin-1");
      expect(pin).toEqual({ id: "pin-1", link: "https://example.com", title: "t", boardId: "b1" });
      const [url] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe("https://api.pinterest.com/v5/pins/pin-1");
    });

    it("throws a PinterestError with status 404 for a missing pin, detectable via isPinterestNotFound", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        jsonResponse(404, { code: 8, message: "Pin not found" }),
      );
      let caught: unknown;
      try {
        await getPin("gone");
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(PinterestError);
      expect(isPinterestNotFound(caught)).toBe(true);
    });

    it("does not classify a non-404 failure as not-found", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        jsonResponse(401, { code: 1, message: "token expired" }),
      );
      let caught: unknown;
      try {
        await getPin("x");
      } catch (err) {
        caught = err;
      }
      expect(isPinterestNotFound(caught)).toBe(false);
    });
  });

  describe("deletePin", () => {
    it("resolves on a 204 with no body", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(emptyResponse(204));
      await expect(deletePin("pin-1")).resolves.toBeUndefined();
      const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe("https://api.pinterest.com/v5/pins/pin-1");
      expect(init.method).toBe("DELETE");
    });

    it("throws a PinterestError for a genuinely missing pin (idempotency is the transport's job)", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        jsonResponse(404, { code: 8, message: "Pin not found" }),
      );
      await expect(deletePin("gone")).rejects.toBeInstanceOf(PinterestError);
    });
  });

  describe("listBoards", () => {
    it("returns a single page's boards when there is no bookmark", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        jsonResponse(200, { items: [{ id: "b1", name: "Board One" }], bookmark: null }),
      );
      const boards = await listBoards();
      expect(boards).toEqual([{ id: "b1", name: "Board One" }]);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("follows the bookmark cursor across pages and aggregates every board", async () => {
      const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse(200, { items: [{ id: "b1", name: "Board One" }], bookmark: "cursor-1" }),
        )
        .mockResolvedValueOnce(
          jsonResponse(200, { items: [{ id: "b2", name: "Board Two" }], bookmark: null }),
        );

      const boards = await listBoards();

      expect(boards).toEqual([
        { id: "b1", name: "Board One" },
        { id: "b2", name: "Board Two" },
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // The second call must carry the bookmark from the first page's response.
      const secondUrl = fetchMock.mock.calls[1][0] as string;
      expect(secondUrl).toContain("bookmark=cursor-1");
    });

    it("throws rather than returning [] when the lookup itself fails", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        jsonResponse(500, { code: 99, message: "internal error" }),
      );
      await expect(listBoards()).rejects.toBeInstanceOf(PinterestError);
    });

    it("skips malformed entries rather than throwing on one bad element", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        jsonResponse(200, {
          items: [{ id: "b1", name: "Good" }, { id: 123, name: "Bad id type" }, {}],
          bookmark: null,
        }),
      );
      const boards = await listBoards();
      expect(boards).toEqual([{ id: "b1", name: "Good" }]);
    });
  });

  describe("getUserAccount", () => {
    it("returns the token account's id and username", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        jsonResponse(200, { id: "acct-1", username: "examplebrand" }),
      );
      const account = await getUserAccount();
      expect(account).toEqual({ id: "acct-1", username: "examplebrand" });
    });

    it("rejects with a PinterestError on a vendor failure", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        jsonResponse(401, { code: 1, message: "invalid token" }),
      );
      await expect(getUserAccount()).rejects.toBeInstanceOf(PinterestError);
    });
  });
});

/**
 * ⛔ The base URL is what lets a Trial-access app reach Standard access, so it
 * gets its own coverage rather than riding on the happy path.
 *
 * A Trial app cannot create Pins on production (403 code 29); Pinterest's own
 * error directs you to api-sandbox.pinterest.com. Upgrading to Standard
 * requires a demo video of the app completing a real action through the API,
 * so with the host hardcoded the upgrade would be blocked by its own
 * prerequisite. These two tests exist to stop the default drifting to
 * something non-production and to stop the override being quietly removed.
 */
describe("pinterest API base URL", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.PINTEREST_API_BASE;
  });

  it("defaults to production when PINTEREST_API_BASE is unset", async () => {
    const mod = await import("../pinterest.js");
    mod.setPinterestTokenResolver(async () => "tok");
    // The client parses with res.text() then JSON.parse, not res.json().
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: "u1", username: "examplebrand" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await mod.getUserAccount();

    expect(String(fetchMock.mock.calls[0][0])).toBe("https://api.pinterest.com/v5/user_account");
    vi.unstubAllGlobals();
  });

  it("targets the sandbox when PINTEREST_API_BASE is set, trailing slash and all", async () => {
    process.env.PINTEREST_API_BASE = "https://api-sandbox.pinterest.com/v5/";
    const mod = await import("../pinterest.js");
    mod.setPinterestTokenResolver(async () => "tok");
    // The client parses with res.text() then JSON.parse, not res.json().
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: "u1", username: "examplebrand" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await mod.getUserAccount();

    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://api-sandbox.pinterest.com/v5/user_account",
    );
    vi.unstubAllGlobals();
  });
});
