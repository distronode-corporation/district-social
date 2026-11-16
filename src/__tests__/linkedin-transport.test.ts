import { describe, it, expect, vi, beforeEach } from "vitest";

// The transport is a business-logic layer on top of the vendor client, so it
// is tested against a mocked client — bluesky-transport.test.ts's own pattern
// for bluesky.ts. LinkedInError stays real: isNotFoundError's `instanceof`
// check is exactly the thing under test in the delete-idempotency cases.
vi.mock("../linkedin.js", async (importActual) => {
  const actual = await importActual<typeof import("../linkedin.js")>();
  return {
    ...actual,
    getOrganizationUrn: vi.fn(),
    assertLinkedInToken: vi.fn(),
    getPost: vi.fn(),
    createPost: vi.fn(),
    deletePost: vi.fn(),
    getPostsBatch: vi.fn(),
    initializeImageUpload: vi.fn(),
    uploadImageBytes: vi.fn(),
  };
});

import {
  LinkedInError,
  assertLinkedInToken,
  getPost,
  getOrganizationUrn,
  createPost,
  deletePost,
  getPostsBatch,
  initializeImageUpload,
  uploadImageBytes,
} from "../linkedin.js";
import { linkedinTransport } from "../linkedin-transport.js";
import { PublishPreflightError } from "../publish.js";
import type { DirectPublishInput } from "../transport.js";
import type { MediaAsset, PlatformRender } from "../types.js";
import { FIXTURE_LINKEDIN_ORG_URN } from "./helpers/fixtures.js";

const getOrganizationUrnMock = getOrganizationUrn as unknown as ReturnType<typeof vi.fn>;
const assertLinkedInTokenMock = assertLinkedInToken as unknown as ReturnType<typeof vi.fn>;
const getPostMock = getPost as unknown as ReturnType<typeof vi.fn>;
const createPostMock = createPost as unknown as ReturnType<typeof vi.fn>;
const deletePostMock = deletePost as unknown as ReturnType<typeof vi.fn>;
const getPostsBatchMock = getPostsBatch as unknown as ReturnType<typeof vi.fn>;
const initializeImageUploadMock = initializeImageUpload as unknown as ReturnType<typeof vi.fn>;
const uploadImageBytesMock = uploadImageBytes as unknown as ReturnType<typeof vi.fn>;

function render(overrides: Partial<PlatformRender> = {}): PlatformRender {
  return { platform: "linkedin", content: "hello from Acme", mediaIndices: [], ...overrides };
}

function media(overrides: Partial<MediaAsset> = {}): MediaAsset {
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

function input(overrides: Partial<DirectPublishInput> = {}): DirectPublishInput {
  // `destination` is required on DirectPublishInput and empty is the honest
  // value here: linkedin's publishNow never reads it. Passing `{}` keeps
  // behaviour byte-for-byte while letting the compiler see the field at all.
  return { render: render(), media: [], draftId: "draft-1", destination: {}, ...overrides };
}

beforeEach(() => {
  getOrganizationUrnMock.mockReset();
  assertLinkedInTokenMock.mockReset().mockResolvedValue(undefined);
  getPostMock.mockReset();
  createPostMock.mockReset();
  deletePostMock.mockReset();
  getPostsBatchMock.mockReset();
  initializeImageUploadMock.mockReset();
  uploadImageBytesMock.mockReset();
  vi.stubGlobal("fetch", vi.fn());
});

describe("linkedin transport", () => {
  it("declares utf16-counted, 3000-char channel rules with a single-image cap", () => {
    expect(linkedinTransport.channelRules()).toEqual({ maxLength: 3000, countMode: "utf16", maxImages: 1 });
  });

  describe("connectStatus", () => {
    it("reports connected with the organization urn as both accountId and displayName", async () => {
      getOrganizationUrnMock.mockResolvedValue("urn:li:organization:100000001");
      const status = await linkedinTransport.connectStatus();
      expect(status).toEqual({
        connected: true,
        accountId: "urn:li:organization:100000001",
        displayName: "urn:li:organization:100000001",
      });
    });

    it("resolves (never rejects) connected:false with a reason when the credential is bad", async () => {
      getOrganizationUrnMock.mockRejectedValue(new LinkedInError(401, "invalid token", "GET", "/organizationAcls"));
      await expect(linkedinTransport.connectStatus()).resolves.toEqual(
        expect.objectContaining({ connected: false, reason: expect.stringContaining("invalid token") }),
      );
    });

    it("⛔ reads DISCONNECTED when the stored grant is refused, even with the org urn pinned", async () => {
      // After a move to another LinkedIn OAuth app (the Community Management
      // API needs its own), a row minted by the old app answers
      // OAuthReauthRequiredError from the resolver. The org urn
      // comes from LINKEDIN_ORG_ID without the token, so without the token
      // check Settings read "connected" while every publish failed.
      getOrganizationUrnMock.mockResolvedValue(FIXTURE_LINKEDIN_ORG_URN);
      assertLinkedInTokenMock.mockRejectedValue(new Error("linkedin needs re-consent: another OAuth app"));
      const status = await linkedinTransport.connectStatus();
      expect(status).toEqual({
        connected: false,
        accountId: "",
        displayName: "",
        reason: "linkedin needs re-consent: another OAuth app",
      });
      expect(getOrganizationUrnMock).not.toHaveBeenCalled();
    });

    it("never throws even when getOrganizationUrn throws a plain Error", async () => {
      getOrganizationUrnMock.mockRejectedValue(new Error("network unreachable"));
      const status = await linkedinTransport.connectStatus();
      expect(status.connected).toBe(false);
      expect(status.reason).toMatch(/network unreachable/);
    });
  });

  describe("postUrl", () => {
    it("builds the feed/update permalink from the returned urn", () => {
      expect(linkedinTransport.postUrl("urn:li:share:0000000000000000000")).toBe(
        "https://www.linkedin.com/feed/update/urn:li:share:0000000000000000000/",
      );
    });
  });

  describe("publishNow: video refusal", () => {
    it("refuses a leg carrying video with a named PublishPreflightError, without calling the vendor", async () => {
      const videoAsset = media({ type: "video", mimeType: "video/mp4" });
      await expect(linkedinTransport.publishNow(input({ media: [videoAsset] }))).rejects.toThrow(
        PublishPreflightError,
      );
      await expect(linkedinTransport.publishNow(input({ media: [videoAsset] }))).rejects.toThrow(/video/i);
      expect(createPostMock).not.toHaveBeenCalled();
      expect(initializeImageUploadMock).not.toHaveBeenCalled();
    });

    it("still refuses when video is mixed with an image in the same leg", async () => {
      const assets = [media(), media({ type: "video", mimeType: "video/mp4", url: "https://cdn.example.com/clip.mp4" })];
      await expect(linkedinTransport.publishNow(input({ media: assets }))).rejects.toThrow(PublishPreflightError);
    });
  });

  describe("publishNow: text-only", () => {
    it("posts the render's content with no media and returns the ref/url", async () => {
      createPostMock.mockResolvedValue({ ref: "urn:li:share:123" });
      const result = await linkedinTransport.publishNow(input());
      expect(createPostMock).toHaveBeenCalledWith({ commentary: "hello from Acme", media: undefined });
      expect(result).toEqual({ ref: "urn:li:share:123", url: "https://www.linkedin.com/feed/update/urn:li:share:123/" });
    });
  });

  describe("publishNow: image", () => {
    it("fetches asset bytes, uploads the image, and attaches it to the post with alt text", async () => {
      // A real Response: the shared media fetch streams res.body under a byte
      // cap (media-fetch.ts), so a plain { ok, arrayBuffer } object can no
      // longer stand in for what fetch actually returns.
      (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => new Response(new Uint8Array([1, 2, 3])));
      initializeImageUploadMock.mockResolvedValue({
        uploadUrl: "https://www.linkedin.com/dms-uploads/abc",
        image: "urn:li:image:abc",
      });
      uploadImageBytesMock.mockResolvedValue(undefined);
      createPostMock.mockResolvedValue({ ref: "urn:li:share:with-image" });

      const result = await linkedinTransport.publishNow(input({ media: [media()] }));

      expect(fetch).toHaveBeenCalledWith("https://cdn.example.com/card.png", expect.any(Object));
      expect(uploadImageBytesMock).toHaveBeenCalledWith(
        "https://www.linkedin.com/dms-uploads/abc",
        new Uint8Array([1, 2, 3]),
        "image/png",
      );
      expect(createPostMock).toHaveBeenCalledWith({
        commentary: "hello from Acme",
        media: { id: "urn:li:image:abc", altText: "a screenshot of the Acme dashboard" },
      });
      expect(result.ref).toBe("urn:li:share:with-image");
    });

    /**
     * ⛔ REFUSES, it does not truncate.
     *
     * This test used to be called "caps uploads at 1 image even if more are
     * attached" and asserted exactly that: three images in, one upload, publish
     * succeeds. That is silent content loss on the company page — a post going
     * out missing images the operator deliberately attached, with nothing
     * anywhere reporting it. The test name made it sound intentional; it was
     * the bug, pinned.
     *
     * facebook-transport already refused loudly under the identical one-image
     * client limit (assertSinglePhotoOnly), so the two transports failed in
     * opposite ways under the same constraint. publish.ts isolates a thrown
     * leg, so refusing still lets the rest of the publish go out.
     */
    it("REFUSES a multi-image render rather than silently dropping the extras", async () => {
      createPostMock.mockResolvedValue({ ref: "urn:li:share:1" });
      const threeImages = Array.from({ length: 3 }, (_, i) => media({ url: `https://cdn.example.com/${i}.png` }));

      await expect(linkedinTransport.publishNow(input({ media: threeImages }))).rejects.toThrow(
        /single image per post/i,
      );

      // Nothing was uploaded and nothing was posted — a refused leg must not
      // leave a half-built post behind.
      expect(initializeImageUploadMock).not.toHaveBeenCalled();
      expect(createPostMock).not.toHaveBeenCalled();
    });

    it("still publishes normally with exactly one image", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => new Response(new Uint8Array([1])));
      initializeImageUploadMock.mockResolvedValue({ uploadUrl: "https://www.linkedin.com/dms-uploads/x", image: "urn:li:image:x" });
      uploadImageBytesMock.mockResolvedValue(undefined);
      createPostMock.mockResolvedValue({ ref: "urn:li:share:1" });

      await linkedinTransport.publishNow(input({ media: [media()] }));

      expect(initializeImageUploadMock).toHaveBeenCalledTimes(1);
    });

    it("refuses a selected asset with no public url instead of posting text-only", async () => {
      createPostMock.mockResolvedValue({ ref: "urn:li:share:1" });
      await expect(
        linkedinTransport.publishNow(input({ media: [media({ path: "/lib/a.png", url: undefined })] })),
      ).rejects.toMatchObject({
        name: "PublishPreflightError",
        message: expect.stringContaining("linkedin: media asset /lib/a.png has no public url"),
      });
      expect(initializeImageUploadMock).not.toHaveBeenCalled();
      expect(createPostMock).not.toHaveBeenCalled();
    });
  });

  describe("postFacts", () => {
    it("maps a ref present in `results` to PUBLISHED/released", async () => {
      getPostsBatchMock.mockResolvedValue({ results: { "urn:li:share:1": {} }, statuses: {}, errors: {} });
      const facts = await linkedinTransport.postFacts(["urn:li:share:1"]);
      expect(facts.get("urn:li:share:1")).toEqual({ state: "PUBLISHED", released: true, platform: "linkedin" });
    });

    it("maps a genuinely-missing post (absent from results) to QUEUE, never ERROR", async () => {
      getPostsBatchMock.mockResolvedValue({ results: {}, statuses: {}, errors: {} });
      const facts = await linkedinTransport.postFacts(["urn:li:share:gone"]);
      expect(facts.get("urn:li:share:gone")).toEqual({ state: "QUEUE", released: false, platform: "linkedin" });
    });

    /**
     * ✅ These shapes are TRANSCRIBED FROM A LIVE CALL, not invented.
     * linkedin.live.proof.test.ts publishes a real post, reads it back, deletes
     * it and reads it again. LinkedIn's docs alone cannot show the missing-id
     * shape (every sample response shows an empty `errors: {}`); without it
     * postFacts would have to answer plain QUEUE for a deleted post, and
     * publish-due could not tell "deleted" from "lookup failed" (stranding such
     * a draft pending forever).
     */
    it("maps the LIVE deleted shape (404 in statuses AND errors) to QUEUE + absent", async () => {
      getPostsBatchMock.mockResolvedValue({
        results: {},
        statuses: { "urn:li:share:7000000000000000003": 404 },
        // Note the EMPTY message: that is what LinkedIn actually returns, so
        // nothing user-facing can be built from it. Read `status`, not `message`.
        errors: { "urn:li:share:7000000000000000003": { message: "", status: 404 } },
      });
      const facts = await linkedinTransport.postFacts(["urn:li:share:7000000000000000003"]);
      expect(facts.get("urn:li:share:7000000000000000003")).toEqual({
        state: "QUEUE",
        released: false,
        absent: true,
        platform: "linkedin",
      });
    });

    it("⛔ keeps state QUEUE when marking absent — a transport may never mark a post terminal", async () => {
      getPostsBatchMock.mockResolvedValue({
        results: {},
        statuses: { "urn:li:share:gone": 404 },
        errors: {},
      });
      const facts = await linkedinTransport.postFacts(["urn:li:share:gone"]);
      // The caller owns the grace window and the decision to give up. If this
      // ever became ERROR/DELETED the transport would be making the terminal
      // call itself — the exact boundary DirectPostFacts.absent exists to hold.
      expect(facts.get("urn:li:share:gone")?.state).toBe("QUEUE");
      expect(facts.get("urn:li:share:gone")?.absent).toBe(true);
    });

    it("does NOT claim absent when a ref is missing with no 404 to explain it", async () => {
      // Absent from `results` but with no vendor 404 anywhere: that is a
      // response shape this client does not recognise, which says nothing about
      // whether the post exists. Claiming `absent` here would let the caller
      // eventually give up on a post that is still live.
      getPostsBatchMock.mockResolvedValue({ results: {}, statuses: {}, errors: {} });
      const facts = await linkedinTransport.postFacts(["urn:li:share:mystery"]);
      expect(facts.get("urn:li:share:mystery")).toEqual({
        state: "QUEUE",
        released: false,
        platform: "linkedin",
      });
      expect(facts.get("urn:li:share:mystery")?.absent).toBeUndefined();
    });

    it("does not treat a non-404 error status as proof the post is gone", async () => {
      // A 500 or 403 says the lookup failed, not that the post was deleted.
      getPostsBatchMock.mockResolvedValue({
        results: {},
        statuses: { "urn:li:share:x": 500 },
        errors: { "urn:li:share:x": { message: "", status: 500 } },
      });
      const facts = await linkedinTransport.postFacts(["urn:li:share:x"]);
      expect(facts.get("urn:li:share:x")?.absent).toBeUndefined();
    });

    it("maps the LIVE published shape (200 in statuses) to PUBLISHED", async () => {
      getPostsBatchMock.mockResolvedValue({
        results: { "urn:li:share:1": { lifecycleState: "PUBLISHED", author: FIXTURE_LINKEDIN_ORG_URN } },
        statuses: { "urn:li:share:1": 200 },
        errors: {},
      });
      const facts = await linkedinTransport.postFacts(["urn:li:share:1"]);
      expect(facts.get("urn:li:share:1")).toEqual({ state: "PUBLISHED", released: true, platform: "linkedin" });
    });

    it("maps every ref in a batch to QUEUE (never ERROR) when the lookup itself fails — vendor unreachable", async () => {
      getPostsBatchMock.mockRejectedValue(new LinkedInError(503, "upstream unavailable", "GET", "/posts"));
      const facts = await linkedinTransport.postFacts(["urn:li:share:a", "urn:li:share:b"]);
      expect(facts.get("urn:li:share:a")).toEqual({ state: "QUEUE", released: false, platform: "linkedin" });
      expect(facts.get("urn:li:share:b")).toEqual({ state: "QUEUE", released: false, platform: "linkedin" });
    });

    it("chunks more than 50 refs into multiple getPostsBatch calls", async () => {
      getPostsBatchMock.mockResolvedValue({ results: {}, statuses: {}, errors: {} });
      const refs = Array.from({ length: 60 }, (_, i) => `urn:li:share:${i}`);
      await linkedinTransport.postFacts(refs);
      expect(getPostsBatchMock).toHaveBeenCalledTimes(2);
      expect(getPostsBatchMock.mock.calls[0][0]).toHaveLength(50);
      expect(getPostsBatchMock.mock.calls[1][0]).toHaveLength(10);
    });

    /**
     * ⛔ The Community Management API's Development tier allows NO BATCH_GET.
     * An integration on that tier gets a 403 on the batch, which must fall
     * back to one GET per post, or no leg is ever confirmed.
     */
    it("falls back to one GET per post when the batch is refused with 403", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      getPostsBatchMock.mockRejectedValue(new LinkedInError(403, "BATCH_GET not allowed", "GET", "/posts"));
      getPostMock.mockImplementation(async (ref: string) => {
        if (ref === "urn:li:share:gone") throw new LinkedInError(404, "", "GET", "/posts/x");
        if (ref === "urn:li:share:flaky") throw new LinkedInError(500, "boom", "GET", "/posts/x");
        if (ref === "urn:li:share:odd") throw "socket closed";
        return true;
      });
      const facts = await linkedinTransport.postFacts([
        "urn:li:share:live",
        "urn:li:share:gone",
        "urn:li:share:flaky",
        "urn:li:share:odd",
      ]);
      expect(facts.get("urn:li:share:live")).toEqual({ state: "PUBLISHED", released: true, platform: "linkedin" });
      expect(facts.get("urn:li:share:gone")).toEqual({
        state: "QUEUE",
        released: false,
        absent: true,
        platform: "linkedin",
      });
      expect(facts.get("urn:li:share:flaky")).toEqual({ state: "QUEUE", released: false, platform: "linkedin" });
      expect(facts.get("urn:li:share:odd")).toEqual({ state: "QUEUE", released: false, platform: "linkedin" });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("single lookup failed for urn:li:share:flaky"));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("socket closed"));
      expect(getPostMock).toHaveBeenCalledTimes(4);
      warn.mockRestore();
    });

    it("returns an empty map for an empty ref list", async () => {
      const facts = await linkedinTransport.postFacts([]);
      expect(facts.size).toBe(0);
      expect(getPostsBatchMock).not.toHaveBeenCalled();
    });
  });

  describe("deletePost", () => {
    it("deletes normally when the post still exists", async () => {
      deletePostMock.mockResolvedValue(undefined);
      await expect(linkedinTransport.deletePost("urn:li:share:123")).resolves.toBeUndefined();
    });

    it("treats a 404 as SUCCESS, not a failure (already-gone is idempotent)", async () => {
      deletePostMock.mockRejectedValue(new LinkedInError(404, "NOT_FOUND", "DELETE", "/posts/urn:li:share:gone"));
      await expect(linkedinTransport.deletePost("urn:li:share:gone")).resolves.toBeUndefined();
    });

    it("still throws for a real failure (e.g. auth), not just swallowing everything", async () => {
      deletePostMock.mockRejectedValue(new LinkedInError(401, "EMPTY_ACCESS_TOKEN", "DELETE", "/posts/urn:li:share:123"));
      await expect(linkedinTransport.deletePost("urn:li:share:123")).rejects.toThrow(/EMPTY_ACCESS_TOKEN/);
    });
  });
});

/**
 * Failures without the fields the happy path reads: a bare-string rejection, a
 * non-2xx media host, and a batch body that omits whole sections.
 */
describe("linkedin transport: non-Error failures and sparse vendor bodies", () => {
  const fetchMock = () => fetch as unknown as ReturnType<typeof vi.fn>;

  it("connectStatus stringifies a thrown non-Error into the reason", async () => {
    getOrganizationUrnMock.mockRejectedValue("socket hang up");
    const status = await linkedinTransport.connectStatus();
    expect(status).toEqual({ connected: false, accountId: "", displayName: "", reason: "socket hang up" });
  });

  it("refuses to post when the media host answers non-2xx, before touching LinkedIn", async () => {
    fetchMock().mockResolvedValue({ ok: false, status: 403, arrayBuffer: async () => new ArrayBuffer(0) });

    await expect(linkedinTransport.publishNow(input({ media: [media()] }))).rejects.toThrow(
      "linkedin: failed to fetch media asset (403): https://cdn.example.com/card.png",
    );
    expect(initializeImageUploadMock).not.toHaveBeenCalled();
    expect(createPostMock).not.toHaveBeenCalled();
  });

  it("uploads a GIF through the image path", async () => {
    fetchMock().mockImplementation(async () => new Response(new Uint8Array([9])));
    initializeImageUploadMock.mockResolvedValue({ uploadUrl: "https://up.example/g", image: "urn:li:image:g" });
    uploadImageBytesMock.mockResolvedValue(undefined);
    createPostMock.mockResolvedValue({ ref: "urn:li:share:gif" });

    await linkedinTransport.publishNow(
      input({ media: [media({ type: "gif", mimeType: "image/gif", url: "https://cdn.example.com/a.gif", altText: undefined })] }),
    );

    expect(uploadImageBytesMock).toHaveBeenCalledWith("https://up.example/g", new Uint8Array([9]), "image/gif");
    expect(createPostMock).toHaveBeenCalledWith({
      commentary: "hello from Acme",
      media: { id: "urn:li:image:g", altText: undefined },
    });
  });

  it("maps a batch to QUEUE with the stringified reason when the lookup rejects with a non-LinkedInError", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    getPostsBatchMock.mockRejectedValue("ECONNRESET");
    const facts = await linkedinTransport.postFacts(["urn:li:share:1"]);
    expect(facts.get("urn:li:share:1")).toEqual({ state: "QUEUE", released: false, platform: "linkedin" });
    expect(warn).toHaveBeenCalledWith("[linkedin] postFacts lookup failed for a batch of 1: ECONNRESET");
    warn.mockRestore();
  });

  it("reads a batch body with no results, statuses or errors sections as QUEUE, not absent", async () => {
    getPostsBatchMock.mockResolvedValue({});
    const facts = await linkedinTransport.postFacts(["urn:li:share:1"]);
    expect(facts.get("urn:li:share:1")).toEqual({ state: "QUEUE", released: false, platform: "linkedin" });
  });
});
