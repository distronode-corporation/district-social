import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchMediaBytes, MEDIA_FETCH_MAX_BYTES, MEDIA_FETCH_TIMEOUT_MS } from "../media-fetch.js";
import { isUnknownOutcome } from "../retry.js";

/**
 * Unit cover for the shared media asset fetch. The five
 * transports exercise the happy path and the non-2xx error through their own
 * suites (x-transport.test.ts also pins the DECLARED-length refusal at the
 * transport seam); these pin the helper's own contract, above all the byte
 * cap: a response that lies about (or omits) its Content-Length and streams more than the cap is cut off with an error, the
 * streaming half of the cap that a declared-length test cannot reach.
 */

describe("fetchMediaBytes", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the asset's bytes and names the platform in the error on a non-2xx answer", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async () => new Response(new Uint8Array([1, 2, 3])));

    expect(await fetchMediaBytes("x", "https://cdn.example.com/a.png")).toEqual(new Uint8Array([1, 2, 3]));

    fetchMock.mockImplementation(async () => new Response(null, { status: 500 }));
    await expect(fetchMediaBytes("bluesky", "https://cdn.example.com/a.png")).rejects.toThrow(
      "bluesky: failed to fetch media asset (500): https://cdn.example.com/a.png",
    );
  });

  it("cuts off a response that STREAMS past the cap with no usable Content-Length", async () => {
    // The real body is 16 bytes with no content-length header at all (a
    // constructed Response carries none), so only the streaming half of the
    // cap can catch it. A small maxBytes override keeps the test from
    // materializing the real cap's 512 MB.
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async () => new Response(new Uint8Array(16)));

    await expect(fetchMediaBytes("x", "https://cdn.example.com/huge.bin", { maxBytes: 10 })).rejects.toThrow(
      "x: media asset exceeds the fetch byte cap (10 bytes): https://cdn.example.com/huge.bin",
    );
  });

  it("refuses a declared Content-Length over the cap before reading a byte", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async () => new Response(new Uint8Array([1]), { headers: { "content-length": "999999999" } }));

    await expect(fetchMediaBytes("pinterest", "https://cdn.example.com/card.png")).rejects.toThrow(
      `pinterest: media asset exceeds the fetch byte cap (${MEDIA_FETCH_MAX_BYTES} bytes): https://cdn.example.com/card.png`,
    );
  });

  it("bounds every call with the shared 20s timeout, and honours a platform's explicit override", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async () => new Response(new Uint8Array([1])));
    // Spied rather than comparing the signal object: two AbortSignal instances
    // never compare equal, but the MILLISECOND VALUE is the fact being pinned.
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");

    await fetchMediaBytes("linkedin", "https://cdn.example.com/card.png");
    expect(timeoutSpy).toHaveBeenLastCalledWith(MEDIA_FETCH_TIMEOUT_MS);

    await fetchMediaBytes("youtube", "https://cdn.example.com/clip.mp4", { timeoutMs: 120_000 });
    expect(timeoutSpy).toHaveBeenLastCalledWith(120_000);

    timeoutSpy.mockRestore();
  });

  /**
   * ⛔ A media fetch runs BEFORE the vendor create, so its failure is never an
   * unknown outcome. Raw, a TimeoutError or fetch TypeError read as one to
   * retry.ts, and the leg was marked "the post may already be live".
   */
  it("wraps a timed-out fetch as a plain platform error that is NOT an unknown outcome", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    fetchMock.mockRejectedValue(timeout);

    const err = await fetchMediaBytes("x", "https://cdn.example.com/clip.mp4", { timeoutMs: 120_000 }).catch(
      (e: unknown) => e,
    );
    expect((err as Error).message).toBe(
      "x: failed to fetch media asset (timed out after 120s): https://cdn.example.com/clip.mp4",
    );
    expect(isUnknownOutcome(err)).toBe(false);
  });

  it("wraps a network failure the same way, keeping its reason", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));

    const err = await fetchMediaBytes("bluesky", "https://cdn.example.com/a.png").catch((e: unknown) => e);
    expect((err as Error).message).toBe("bluesky: failed to fetch media asset (fetch failed): https://cdn.example.com/a.png");
    expect(isUnknownOutcome(err)).toBe(false);
  });

  it("wraps a body that fails mid-stream, which the same timeout signal also aborts", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(timeout);
      },
    });
    fetchMock.mockImplementation(async () => new Response(body));

    const err = await fetchMediaBytes("pinterest", "https://cdn.example.com/a.png").catch((e: unknown) => e);
    expect((err as Error).message).toBe(
      "pinterest: failed to fetch media asset (timed out after 20s): https://cdn.example.com/a.png",
    );
    expect(isUnknownOutcome(err)).toBe(false);
  });
});
