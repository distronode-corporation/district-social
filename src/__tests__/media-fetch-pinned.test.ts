// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

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

  /**
   * ⛔ ONE DEADLINE COVERS THE WHOLE FETCH, the destination lookup included. A lookup
   * that outlives `timeoutMs` fails the call as a timeout, sends no request, and the
   * dispatcher it builds afterwards is destroyed, since nobody else holds it.
   */
  describe("a destination lookup that outlives the deadline", () => {
    function late<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
      let resolve!: (v: T) => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }

    it("times out, sends no request, and destroys the dispatcher the late lookup builds", async () => {
      const dispatcher = { close: vi.fn(async () => {}), destroy: vi.fn(async () => {}) };
      const prep = late<unknown>();
      h.prepare.mockReturnValue(prep.promise);
      (fetch as unknown as ReturnType<typeof vi.fn<FetchFn>>).mockResolvedValue(new Response(new Uint8Array([7])));

      const call = fetchMediaBytes("x", URL_, { timeoutMs: 20 });
      await expect(call).rejects.toThrow(`x: failed to fetch media asset (timed out after 0.02s): ${URL_}`);
      expect(fetch).not.toHaveBeenCalled();

      prep.resolve({ dispatcher, redirect: "error" });
      await vi.waitFor(() => expect(dispatcher.destroy).toHaveBeenCalledTimes(1));
      expect(dispatcher.close).not.toHaveBeenCalled();
    });

    it("lets a late lookup with no dispatcher, or one whose destroy fails, end quietly", async () => {
      const failing = { close: vi.fn(async () => {}), destroy: vi.fn(async () => Promise.reject(new Error("gone"))) };
      const first = late<unknown>();
      const second = late<unknown>();
      h.prepare.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

      await expect(fetchMediaBytes("x", URL_, { timeoutMs: 10 })).rejects.toThrow("timed out after 0.01s");
      await expect(fetchMediaBytes("x", URL_, { timeoutMs: 10 })).rejects.toThrow("timed out after 0.01s");
      first.resolve({ dispatcher: undefined, redirect: undefined });
      second.resolve({ dispatcher: failing, redirect: "error" });

      await vi.waitFor(() => expect(failing.destroy).toHaveBeenCalledTimes(1));
      expect(fetch).not.toHaveBeenCalled();
    });

    it("ignores a lookup that fails after the deadline", async () => {
      const prep = late<unknown>();
      h.prepare.mockReturnValue(prep.promise);

      await expect(fetchMediaBytes("x", URL_, { timeoutMs: 10 })).rejects.toThrow("timed out after 0.01s");
      prep.reject(new Error("SSRF guard: late refusal"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fetch).not.toHaveBeenCalled();
    });
  });
});
