// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Reddit media upload, behind SOCIALMETA_REDDIT_MEDIA_UPLOAD.
 *
 * ⛔ THESE TESTS PROVE THIS CLIENT'S BEHAVIOUR, NOT REDDIT'S AGREEMENT WITH IT.
 * `/api/media/asset.json` is absent from Reddit's public API reference (which
 * documents S3 leases only for emoji, widgets and subreddit styling), and API
 * access is still unapproved, so nothing here has been exercised against the
 * live endpoint. A green run is not evidence the upload works — it is evidence
 * that the fallback, the ordering rules and the opt-in gate behave as intended.
 *
 * The two things most worth protecting are both about NOT losing content:
 *   1. an image post has no body, so choosing one when there is copy would
 *      silently discard render.content;
 *   2. a failure on an undocumented endpoint must degrade to the self post this
 *      transport already makes, never take the publish down.
 */

vi.mock("../reddit.js", async (importActual) => {
  const actual = await importActual<typeof import("../reddit.js")>();
  return {
    ...actual,
    submitPost: vi.fn(),
    uploadMediaAsset: vi.fn(),
    getSubredditAbout: vi.fn(),
    getPostRequirements: vi.fn(),
    getLinkFlair: vi.fn(),
  };
});

/**
 * The real shared fetcher, wrapped only so one test can lower its byte cap: a real
 * over-cap body would buffer half a gigabyte in the test. Every other test runs the
 * fetcher exactly as the transport calls it.
 */
const mf = vi.hoisted(() => ({ maxBytes: undefined as number | undefined }));
vi.mock("../media-fetch.js", async (importActual) => {
  const actual = await importActual<typeof import("../media-fetch.js")>();
  return {
    ...actual,
    fetchMediaBytes: vi.fn((platform: string, url: string, opts?: { timeoutMs?: number; maxBytes?: number }) =>
      actual.fetchMediaBytes(platform, url, mf.maxBytes === undefined ? opts : { ...opts, maxBytes: mf.maxBytes }),
    ),
  };
});

import { submitPost, uploadMediaAsset } from "../reddit.js";
import { fetchMediaBytes, MEDIA_FETCH_MAX_BYTES } from "../media-fetch.js";
import { redditTransport } from "../reddit-transport.js";
import type { MediaAsset, PlatformRender } from "../types.js";
import type { DirectPublishInput, PublishDestination } from "../transport.js";

const submitPostMock = submitPost as unknown as ReturnType<typeof vi.fn>;
const uploadMock = uploadMediaAsset as unknown as ReturnType<typeof vi.fn>;
const fetchMediaBytesMock = fetchMediaBytes as unknown as ReturnType<typeof vi.fn>;

function image(url = "https://cdn.example.com/card.png"): MediaAsset {
  return { path: "/tmp/card.png", type: "image", mimeType: "image/png", size: 1000, url } as MediaAsset;
}

function input(over: { content?: string; media?: MediaAsset[]; link?: string }): DirectPublishInput {
  const render = {
    platform: "reddit",
    content: over.content ?? "",
    title: "A title",
    mediaIndices: [],
  } as unknown as PlatformRender;
  return {
    render,
    media: over.media ?? [],
    destination: { subreddit: "u_examplebrand", ...(over.link ? { link: over.link } : {}) } as PublishDestination,
  } as DirectPublishInput;
}

beforeEach(() => {
  submitPostMock.mockReset();
  uploadMock.mockReset();
  fetchMediaBytesMock.mockClear();
  mf.maxBytes = undefined;
  submitPostMock.mockResolvedValue({ name: "t3_abc", id: "abc" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))),
  );
  process.env.SOCIALMETA_REDDIT_MEDIA_UPLOAD = "1";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SOCIALMETA_REDDIT_MEDIA_UPLOAD;
});

describe("reddit media upload", () => {
  it("submits an image post when there is no copy to lose", async () => {
    uploadMock.mockResolvedValue({ url: "https://s3.example.com/bucket/key.png" });

    await redditTransport.publishNow(input({ content: "", media: [image()] }));

    expect(uploadMock).toHaveBeenCalled();
    expect(submitPostMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "image", url: "https://s3.example.com/bucket/key.png" }),
    );
  });

  it("⛔ keeps the self post when there IS copy, and never uploads", async () => {
    await redditTransport.publishNow(input({ content: "the body carries the value here", media: [image()] }));

    // An image post has no body field. Preferring it because an image exists
    // would discard render.content — the exact silent loss the self-post rule
    // was written to prevent.
    expect(uploadMock).not.toHaveBeenCalled();
    expect(submitPostMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "self", text: "the body carries the value here" }),
    );
  });

  it("falls back to a self post when the undocumented upload fails", async () => {
    uploadMock.mockRejectedValue(new Error("403 from S3"));

    await expect(redditTransport.publishNow(input({ content: "", media: [image()] }))).resolves.toBeTruthy();

    // The publish survives. Losing the card is recoverable by hand; losing the
    // post is not.
    expect(submitPostMock).toHaveBeenCalledWith(expect.objectContaining({ kind: "self" }));
  });

  /**
   * ⛔ AN ERROR PAGE IS NOT AN IMAGE. `arrayBuffer()` resolves on a 404 too (to
   * the error body), so without the `res.ok` check the transport would hand
   * Reddit an HTML document as a PNG and, if the undocumented endpoint accepted
   * it, publish a broken image post with no copy in it. Failing the fetch and
   * degrading to the self post keeps the words, which are the payload here.
   */
  it("degrades to a self post when the asset URL itself answers an error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));

    await redditTransport.publishNow(input({ content: "", media: [image()] }));

    expect(uploadMock).not.toHaveBeenCalled();
    expect(submitPostMock).toHaveBeenCalledWith(expect.objectContaining({ kind: "self" }));
    expect(warn.mock.calls.map((c) => String(c[0])).join(" ")).toContain(
      "reddit: failed to fetch media asset (404): https://cdn.example.com/card.png",
    );
    warn.mockRestore();
  });

  /**
   * ⚠️ The filename is derived from the URL's last path segment, and a CDN URL
   * can legitimately end in a slash (or carry only a query). `"".split("?")[0]`
   * is an empty string, and Reddit's lease request sends `filepath` as a form
   * field, so an empty filename would be sent as a real value rather than
   * omitted. The fallback keeps a plausible name and an extension the lease can
   * key a content type off.
   */
  it("names the upload image.jpg rather than sending an empty filename", async () => {
    uploadMock.mockResolvedValue({ url: "https://s3.example.com/bucket/key.png" });

    await redditTransport.publishNow(input({ content: "", media: [image("https://cdn.example.com/")] }));

    expect(uploadMock).toHaveBeenCalledWith(expect.any(Uint8Array), "image.jpg", "image/png");
  });

  /**
   * ⚠️ The fallback warning is the only trace this speculative path leaves, and
   * a rejection that is not an Error has no `.message`. Without the String()
   * arm the operator would read "media upload failed, falling back to a self
   * post: undefined" and have nothing at all to act on, on an endpoint that is
   * already absent from Reddit's public reference.
   */
  it("names a non-Error upload failure in the fallback warning instead of logging undefined", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    uploadMock.mockRejectedValue("S3 lease refused");

    await redditTransport.publishNow(input({ content: "", media: [image()] }));

    expect(warn.mock.calls.map((c) => String(c[0])).join(" ")).toContain("S3 lease refused");
    expect(submitPostMock).toHaveBeenCalledWith(expect.objectContaining({ kind: "self" }));
    warn.mockRestore();
  });

  it("does not upload at all unless the opt-in flag is set", async () => {
    delete process.env.SOCIALMETA_REDDIT_MEDIA_UPLOAD;

    await redditTransport.publishNow(input({ content: "", media: [image()] }));

    // Speculative code against an endpoint absent from the vendor reference is
    // off by default; on would make every Reddit post depend on a guess.
    expect(uploadMock).not.toHaveBeenCalled();
    expect(submitPostMock).toHaveBeenCalledWith(expect.objectContaining({ kind: "self" }));
  });

  it("prefers an uploaded image over a bare link post", async () => {
    uploadMock.mockResolvedValue({ url: "https://s3.example.com/bucket/key.png" });

    await redditTransport.publishNow(
      input({ content: "", media: [image()], link: "https://example.com/x" }),
    );

    expect(submitPostMock).toHaveBeenCalledWith(expect.objectContaining({ kind: "image" }));
  });

  it("still posts a link when there is no copy and no usable image", async () => {
    await redditTransport.publishNow(input({ content: "", media: [], link: "https://example.com/x" }));
    expect(submitPostMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "link", url: "https://example.com/x" }),
    );
  });
});

/**
 * The image upload fetches its asset through the shared media fetcher
 * (`fetchMediaBytes`), so it gets the same URL checks and byte cap as every other
 * transport. Each refusal degrades to the self post, and no request is sent for a
 * destination the checks refuse. The pinned-dispatcher half (a hostname that
 * resolves to a private address, a redirect) is in reddit-media-pinned.test.ts,
 * because DNS is skipped under NODE_ENV=test.
 */
describe("reddit media upload: the asset fetch", () => {
  async function refusedWith(url: string, fragment: string): Promise<void> {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await redditTransport.publishNow(input({ content: "", media: [image(url)] }));

      expect(fetch).not.toHaveBeenCalled();
      expect(uploadMock).not.toHaveBeenCalled();
      expect(submitPostMock).toHaveBeenCalledWith(expect.objectContaining({ kind: "self" }));
      const warned = warn.mock.calls.map((c) => String(c[0])).join(" ");
      expect(warned).toContain("[reddit] media upload failed, falling back to a self post: reddit: failed to fetch media asset (");
      expect(warned).toContain(fragment);
    } finally {
      warn.mockRestore();
    }
  }

  it("uploads exactly the bytes the shared fetcher read from the asset URL", async () => {
    uploadMock.mockResolvedValue({ url: "https://s3.example.com/bucket/key.png" });

    await redditTransport.publishNow(input({ content: "", media: [image()] }));

    expect(fetch).toHaveBeenCalledWith("https://cdn.example.com/card.png", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(uploadMock).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]), "card.png", "image/png");
  });

  it.each([
    ["a private IPv4 literal", "https://10.0.0.5/card.png"],
    ["a loopback literal", "https://127.0.0.1/card.png"],
    ["the cloud metadata address", "https://169.254.169.254/latest/meta-data/"],
    ["a private IPv6 literal", "https://[fd00::1]/card.png"],
    ["an IPv4-mapped IPv6 loopback", "https://[::ffff:127.0.0.1]/card.png"],
    ["localhost", "https://localhost/card.png"],
  ])("refuses %s before any request and keeps the self post", async (_label, url) => {
    await refusedWith(url, "SSRF guard");
  });

  it("refuses a plain-HTTP asset URL before any request", async () => {
    await refusedWith("http://cdn.example.com/card.png", "SSRF guard");
  });

  it("refuses a body declared over the byte cap without reading it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pulled = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull: pulled });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { headers: { "content-length": String(MEDIA_FETCH_MAX_BYTES + 1) } })),
    );

    await redditTransport.publishNow(input({ content: "", media: [image()] }));

    expect(uploadMock).not.toHaveBeenCalled();
    expect(submitPostMock).toHaveBeenCalledWith(expect.objectContaining({ kind: "self" }));
    expect(warn.mock.calls.map((c) => String(c[0])).join(" ")).toContain(
      `reddit: media asset exceeds the fetch byte cap (${MEDIA_FETCH_MAX_BYTES} bytes): https://cdn.example.com/card.png`,
    );
    warn.mockRestore();
  });

  /**
   * ⛔ A missing or lying Content-Length is caught while streaming. A test cap
   * stands in for the 512 MiB one (a real over-cap body would buffer half a
   * gigabyte in the test), passed through by wrapping the real fetcher, so the
   * code under test is still the one the transport calls.
   */
  it("refuses a streamed body that outgrows the byte cap", async () => {
    mf.maxBytes = 4;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4, 5, 6]))));

    await redditTransport.publishNow(input({ content: "", media: [image()] }));

    expect(fetchMediaBytesMock).toHaveBeenCalledWith("reddit", "https://cdn.example.com/card.png");
    expect(uploadMock).not.toHaveBeenCalled();
    expect(submitPostMock).toHaveBeenCalledWith(expect.objectContaining({ kind: "self" }));
    expect(warn.mock.calls.map((c) => String(c[0])).join(" ")).toContain(
      "reddit: media asset exceeds the fetch byte cap (4 bytes): https://cdn.example.com/card.png",
    );
    warn.mockRestore();
  });
});
