import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The production half of fetchMediaBytes' SSRF guard. Under NODE_ENV=test the
 * real preparePinnedHttpsFetch skips DNS and returns no dispatcher, so the
 * other suites never see the pinned-dispatcher / `redirect: "error"` init. This
 * stubs the guard to answer the way it does in production and asserts both
 * reach the media fetch, and that the pinned agent is closed afterwards on
 * every path.
 */
const h = vi.hoisted(() => ({ prepare: vi.fn() }));

vi.mock("../ssrf.js", async (importActual) => ({
  ...(await importActual<typeof import("../ssrf.js")>()),
  preparePinnedHttpsFetch: h.prepare,
}));

import { fetchMediaBytes } from "../media-fetch.js";

type FetchFn = (input: string, init?: RequestInit & { dispatcher?: unknown }) => Promise<Response>;

const URL_ = "https://cdn.example.com/a.png";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn<FetchFn>());
});

afterEach(() => {
  vi.unstubAllGlobals();
  h.prepare.mockReset();
});

describe("fetchMediaBytes with a pinned dispatcher", () => {
  it("passes the guard's dispatcher and redirect policy to the fetch, then closes the dispatcher", async () => {
    const dispatcher = { close: vi.fn(async () => {}), destroy: vi.fn(async () => {}) };
    h.prepare.mockResolvedValue({ dispatcher, redirect: "error" });
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn<FetchFn>>;
    fetchMock.mockResolvedValue(new Response(new Uint8Array([7])));

    expect(await fetchMediaBytes("bluesky", URL_)).toEqual(new Uint8Array([7]));

    expect(h.prepare).toHaveBeenCalledWith(URL_);
    const init = fetchMock.mock.calls[0]![1]!;
    expect(init.redirect).toBe("error");
    expect(init.dispatcher).toBe(dispatcher);
    expect(dispatcher.close).toHaveBeenCalledTimes(1);
    expect(dispatcher.destroy).not.toHaveBeenCalled();
  });

  it("destroys the dispatcher when the fetch fails", async () => {
    const dispatcher = { close: vi.fn(async () => {}), destroy: vi.fn(async () => {}) };
    h.prepare.mockResolvedValue({ dispatcher, redirect: "error" });
    // What undici throws for a 3xx under `redirect: "error"`.
    (fetch as unknown as ReturnType<typeof vi.fn<FetchFn>>).mockRejectedValue(new TypeError("unexpected redirect"));

    await expect(fetchMediaBytes("x", URL_)).rejects.toThrow(
      `x: failed to fetch media asset (unexpected redirect): ${URL_}`,
    );
    expect(dispatcher.destroy).toHaveBeenCalledTimes(1);
    expect(dispatcher.close).not.toHaveBeenCalled();
  });

  /**
   * ⛔ A refused status with a body still streaming: a graceful close would wait for
   * that body, so the caller would hear nothing until the timeout.
   */
  it("destroys rather than closes the dispatcher after a non-2xx answer", async () => {
    const dispatcher = { close: vi.fn(async () => {}), destroy: vi.fn(async () => {}) };
    h.prepare.mockResolvedValue({ dispatcher, redirect: "error" });
    (fetch as unknown as ReturnType<typeof vi.fn<FetchFn>>).mockResolvedValue(new Response("gone", { status: 404 }));

    await expect(fetchMediaBytes("pinterest", URL_)).rejects.toThrow(
      `pinterest: failed to fetch media asset (404): ${URL_}`,
    );
    expect(dispatcher.destroy).toHaveBeenCalledTimes(1);
    expect(dispatcher.close).not.toHaveBeenCalled();
  });

  it("refuses before any request when the guard refuses the destination", async () => {
    h.prepare.mockRejectedValue(new Error('SSRF guard: "cdn.example.com" resolves to private/reserved address 10.0.0.5'));

    await expect(fetchMediaBytes("linkedin", URL_)).rejects.toThrow(
      `linkedin: failed to fetch media asset (SSRF guard: "cdn.example.com" resolves to private/reserved address 10.0.0.5): ${URL_}`,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
