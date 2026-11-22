import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";

/**
 * The production half of the Reddit image upload's asset fetch. Under
 * NODE_ENV=test the real preparePinnedHttpsFetch skips DNS and returns no
 * dispatcher, so reddit-media.test.ts never sees a hostname that resolves to a
 * private address, the pinned dispatcher or the `redirect: "error"` init. This
 * stubs the guard to answer the way it does in production and asserts that the
 * transport's fetch carries both, and that every refusal degrades to the self
 * post with no upload.
 */
const h = vi.hoisted(() => ({ prepare: vi.fn() }));

vi.mock("../ssrf.js", async (importActual) => ({
  ...(await importActual<typeof import("../ssrf.js")>()),
  preparePinnedHttpsFetch: h.prepare,
}));

vi.mock("../reddit.js", async (importActual) => ({
  ...(await importActual<typeof import("../reddit.js")>()),
  submitPost: vi.fn(),
  uploadMediaAsset: vi.fn(),
}));

import { submitPost, uploadMediaAsset } from "../reddit.js";
import { redditTransport } from "../reddit-transport.js";
import type { MediaAsset, PlatformRender } from "../types.js";
import type { DirectPublishInput, PublishDestination } from "../transport.js";

type FetchFn = (input: string, init?: RequestInit & { dispatcher?: unknown }) => Promise<Response>;

const ASSET_URL = "https://cdn.example.com/card.png";
const submitPostMock = submitPost as unknown as ReturnType<typeof vi.fn>;
const uploadMock = uploadMediaAsset as unknown as ReturnType<typeof vi.fn>;

function input(): DirectPublishInput {
  const media = [{ path: "/tmp/card.png", type: "image", mimeType: "image/png", size: 3, url: ASSET_URL } as MediaAsset];
  return {
    render: { platform: "reddit", content: "", title: "A title", mediaIndices: [] } as unknown as PlatformRender,
    media,
    destination: { subreddit: "u_examplebrand" } as PublishDestination,
  } as DirectPublishInput;
}

function dispatcher(): { close: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> } {
  return { close: vi.fn(async () => {}), destroy: vi.fn(async () => {}) };
}

function fetchMock(): ReturnType<typeof vi.fn<FetchFn>> {
  return fetch as unknown as ReturnType<typeof vi.fn<FetchFn>>;
}

let warn: MockInstance<typeof console.warn>;

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn<FetchFn>());
  submitPostMock.mockReset().mockResolvedValue({ name: "t3_abc", id: "abc" });
  uploadMock.mockReset();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  process.env.SOCIALMETA_REDDIT_MEDIA_UPLOAD = "1";
});

afterEach(() => {
  vi.unstubAllGlobals();
  h.prepare.mockReset();
  warn.mockRestore();
  delete process.env.SOCIALMETA_REDDIT_MEDIA_UPLOAD;
});

function warned(): string {
  return warn.mock.calls.map((c) => String(c[0])).join(" ");
}

describe("reddit image upload: the asset fetch with a pinned dispatcher", () => {
  it("fetches through the guard's dispatcher with redirects refused, then closes it", async () => {
    const pinned = dispatcher();
    h.prepare.mockResolvedValue({ dispatcher: pinned, redirect: "error" });
    fetchMock().mockResolvedValue(new Response(new Uint8Array([9, 8, 7])));
    uploadMock.mockResolvedValue({ url: "https://s3.example.com/bucket/key.png" });

    await redditTransport.publishNow(input());

    expect(h.prepare).toHaveBeenCalledWith(ASSET_URL);
    const init = fetchMock().mock.calls[0]![1]!;
    expect(init.redirect).toBe("error");
    expect(init.dispatcher).toBe(pinned);
    expect(pinned.close).toHaveBeenCalledTimes(1);
    expect(uploadMock).toHaveBeenCalledWith(new Uint8Array([9, 8, 7]), "card.png", "image/png");
    expect(submitPostMock).toHaveBeenCalledWith(expect.objectContaining({ kind: "image" }));
  });

  it("sends no request when the asset host resolves to a private address", async () => {
    h.prepare.mockRejectedValue(new Error('SSRF guard: "cdn.example.com" resolves to private/reserved address 10.0.0.5'));

    await redditTransport.publishNow(input());

    expect(fetch).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
    expect(submitPostMock).toHaveBeenCalledWith(expect.objectContaining({ kind: "self" }));
    expect(warned()).toContain(
      `reddit: failed to fetch media asset (SSRF guard: "cdn.example.com" resolves to private/reserved address 10.0.0.5): ${ASSET_URL}`,
    );
  });

  /**
   * ⛔ A public host that answers with a redirect toward a private address is not
   * followed: under `redirect: "error"` undici rejects the 3xx, so the bytes behind
   * the redirect are never read and never uploaded.
   */
  it("does not follow a redirect toward a private address, and keeps the self post", async () => {
    const pinned = dispatcher();
    h.prepare.mockResolvedValue({ dispatcher: pinned, redirect: "error" });
    fetchMock().mockImplementation(async (_url, init) => {
      if (init?.redirect === "error") throw new TypeError("unexpected redirect");
      return new Response(null, { status: 302, headers: { location: "https://169.254.169.254/latest/meta-data/" } });
    });

    await redditTransport.publishNow(input());

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(pinned.destroy).toHaveBeenCalledTimes(1);
    expect(pinned.close).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
    expect(submitPostMock).toHaveBeenCalledWith(expect.objectContaining({ kind: "self" }));
    expect(warned()).toContain(`reddit: failed to fetch media asset (unexpected redirect): ${ASSET_URL}`);
  });
});
