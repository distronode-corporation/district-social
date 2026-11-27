// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The transport is a business-logic layer on top of the vendor client, so it
// is tested against a mocked client (this is publish.test.ts's own pattern
// for postiz.ts). BlueskyError stays real: isNotFoundError's `instanceof`
// check is exactly the thing under test in the delete-idempotency cases.
vi.mock("../bluesky.js", async (importActual) => {
  const actual = await importActual<typeof import("../bluesky.js")>();
  return {
    ...actual,
    buildRichText: vi.fn(async (text: string) => ({ text, facets: undefined })),
    createPost: vi.fn(),
    createReply: vi.fn(),
    getPosts: vi.fn(),
    deleteRecord: vi.fn(),
    uploadBlob: vi.fn(),
    getProfile: vi.fn(),
  };
});

import {
  BlueskyError,
  buildRichText,
  createPost,
  createReply,
  getPosts,
  deleteRecord,
  uploadBlob,
  getProfile,
} from "../bluesky.js";
import { blueskyTransport } from "../bluesky-transport.js";
import { PublishPreflightError } from "../publish.js";
import { SPECS } from "../specs.js";
import type { DirectPublishInput, DirectQueuedReply } from "../transport.js";
import type { MediaAsset, PlatformRender } from "../types.js";
import { FIXTURE_BLUESKY_AT_URI, FIXTURE_BLUESKY_DID, FIXTURE_BLUESKY_RKEY } from "./helpers/fixtures.js";

const buildRichTextMock = buildRichText as unknown as ReturnType<typeof vi.fn>;
const createPostMock = createPost as unknown as ReturnType<typeof vi.fn>;
const createReplyMock = createReply as unknown as ReturnType<typeof vi.fn>;
const getPostsMock = getPosts as unknown as ReturnType<typeof vi.fn>;
const deleteRecordMock = deleteRecord as unknown as ReturnType<typeof vi.fn>;
const uploadBlobMock = uploadBlob as unknown as ReturnType<typeof vi.fn>;
const getProfileMock = getProfile as unknown as ReturnType<typeof vi.fn>;

function render(overrides: Partial<PlatformRender> = {}): PlatformRender {
  return { platform: "bluesky", content: "hello from Acme", mediaIndices: [], ...overrides };
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
  // value here: bluesky's publishNow never reads it (no board, subreddit,
  // title or link field exists on the vendor). Passing `{}` keeps behaviour
  // byte-for-byte while letting the compiler see the field at all.
  return { render: render(), media: [], draftId: "draft-1", destination: {}, ...overrides };
}

beforeEach(() => {
  buildRichTextMock.mockClear();
  buildRichTextMock.mockImplementation(async (text: string) => ({ text, facets: undefined }));
  createPostMock.mockReset();
  createReplyMock.mockReset();
  getPostsMock.mockReset();
  deleteRecordMock.mockReset();
  uploadBlobMock.mockReset();
  getProfileMock.mockReset();
  vi.stubGlobal("fetch", vi.fn());
});

// A test that throws before its own cleanup line must not hand fake timers, a
// console spy or the stubbed fetch to the next one.
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("bluesky transport", () => {
  it("declares grapheme-counted, 300-char channel rules", () => {
    expect(blueskyTransport.channelRules()).toEqual({
      maxLength: 300,
      countMode: "grapheme",
      maxImages: 4,
      maxImageBytes: 2_000_000,
    });
  });

  /**
   * Asserted separately from the shape above because it is the one field with a
   * consequence outside this file.
   *
   * media-fit's needsWork() re-encodes only when the TRANSPORT declares a byte
   * limit, while qa.ts softens `image-too-large` to a warning for any direct
   * platform with a fitter wired. Omitting this satisfies QA's condition and
   * guarantees the fitter does nothing: an oversized image passes QA with a
   * message promising a re-encode, then fails at the vendor. Bluesky has the
   * tightest limit of the nine platforms.
   *
   * The value is the `app.bsky.embed.images` lexicon's `maxSize` in the
   * lexicons as @atproto/api 0.20.x ships them, and must stay numerically identical to
   * SPECS.bluesky.maxImageBytes — QA reads SPECS, the publish path reads this,
   * and the two disagreeing is what produces a draft that passes and cannot
   * publish. ⛔ It is 2,000,000 decimal bytes, NOT 2 * 1024 * 1024.
   */
  it("declares the image byte limit the media fitter needs, matching the lexicon exactly", () => {
    expect(blueskyTransport.channelRules().maxImageBytes).toBe(2_000_000);
    expect(SPECS.bluesky.maxImageBytes).toBe(blueskyTransport.channelRules().maxImageBytes);
  });

  describe("connectStatus", () => {
    it("reports connected with the account's did/handle", async () => {
      getProfileMock.mockResolvedValue({ did: "did:plc:examplebrand", handle: "examplebrand.bsky.social" });
      const status = await blueskyTransport.connectStatus();
      expect(status).toEqual({ connected: true, accountId: "did:plc:examplebrand", displayName: "examplebrand.bsky.social" });
    });

    it("returns connected:false with a reason instead of throwing", async () => {
      getProfileMock.mockRejectedValue(new Error("no session"));
      const status = await blueskyTransport.connectStatus();
      expect(status.connected).toBe(false);
      expect(status.reason).toMatch(/no session/);
    });

    /**
     * ⚠️ Not everything a rejected promise carries is an Error. An `AbortSignal`
     * timeout deep in the fetch stack, or any library that rejects with a plain
     * value, arrives here as a non-Error, and `err.message` on one is
     * `undefined`. A `reason: undefined` renders as an EMPTY explanation on the
     * connections screen, which reads as "connected but nameless" rather than
     * "we could not reach Bluesky" and sends the operator hunting the wrong
     * thing. The String() arm is what keeps the reason legible.
     */
    it("states a non-Error rejection as text rather than reporting an empty reason", async () => {
      getProfileMock.mockRejectedValue("socket hang up");
      const status = await blueskyTransport.connectStatus();
      expect(status.connected).toBe(false);
      expect(status.reason).toBe("socket hang up");
    });
  });

  describe("postUrl", () => {
    it("builds the public permalink from the AT URI's did and rkey", () => {
      const url = blueskyTransport.postUrl(FIXTURE_BLUESKY_AT_URI);
      expect(url).toBe(`https://bsky.app/profile/${FIXTURE_BLUESKY_DID}/post/${FIXTURE_BLUESKY_RKEY}`);
    });
  });

  describe("publishNow: media", () => {
    it("fetches asset bytes, uploads a blob, and carries altText into the embed", async () => {
      // A real Response: the shared media fetch streams res.body under a byte
      // cap (media-fetch.ts), so a plain { ok, arrayBuffer } object can no
      // longer stand in for what fetch actually returns.
      (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => new Response(new Uint8Array([1, 2, 3])));
      const blob = { ref: "blob-1" };
      uploadBlobMock.mockResolvedValue(blob);
      createPostMock.mockResolvedValue({ uri: "at://did:plc:x/app.bsky.feed.post/root", cid: "cid-root" });

      await blueskyTransport.publishNow(input({ media: [media()] }));

      expect(fetch).toHaveBeenCalledWith("https://cdn.example.com/card.png", expect.any(Object));
      expect(uploadBlobMock).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]), "image/png");
      expect(createPostMock).toHaveBeenCalledWith(
        expect.objectContaining({
          images: [{ blob, alt: "a screenshot of the Acme dashboard" }],
        }),
      );
    });

    it("falls back to empty alt text rather than dropping the image when altText is unset", async () => {
      // mockImplementation: several fetches need several bodies, and a
      // Response body can only be consumed once.
      (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => new Response(new Uint8Array([1])));
      uploadBlobMock.mockResolvedValue({ ref: "blob-2" });
      createPostMock.mockResolvedValue({ uri: "at://did:plc:x/app.bsky.feed.post/root", cid: "cid-root" });

      await blueskyTransport.publishNow(input({ media: [media({ altText: undefined })] }));

      expect(createPostMock).toHaveBeenCalledWith(
        expect.objectContaining({ images: [{ blob: { ref: "blob-2" }, alt: "" }] }),
      );
    });

    it("caps uploads at 4 images even if more are attached", async () => {
      // mockImplementation: several fetches need several bodies, and a
      // Response body can only be consumed once.
      (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => new Response(new Uint8Array([1])));
      uploadBlobMock.mockResolvedValue({ ref: "blob" });
      createPostMock.mockResolvedValue({ uri: "at://did:plc:x/app.bsky.feed.post/root", cid: "cid-root" });

      const fiveImages = Array.from({ length: 5 }, (_, i) => media({ url: `https://cdn.example.com/${i}.png` }));
      await blueskyTransport.publishNow(input({ media: fiveImages }));

      expect(uploadBlobMock).toHaveBeenCalledTimes(4);
    });

    /**
     * A GIF is an image to Bluesky (the embed lexicon has one image list, no
     * separate animation type), and `pickMediaForPlatform` hands GIFs to this
     * transport like any other card. Filtering on `type === "image"` alone would
     * drop them SILENTLY: the post would still publish, just without the asset
     * the operator attached, which is the failure shape this engine treats as
     * unacceptable everywhere else.
     */
    it("uploads a gif, which Bluesky embeds as an image like any other", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => new Response(new Uint8Array([7])));
      uploadBlobMock.mockResolvedValue({ ref: "blob-gif" });
      createPostMock.mockResolvedValue({ uri: "at://did:plc:x/app.bsky.feed.post/root", cid: "cid-root" });

      await blueskyTransport.publishNow(
        input({ media: [media({ type: "gif", mimeType: "image/gif", url: "https://cdn.example.com/loop.gif" })] }),
      );

      expect(uploadBlobMock).toHaveBeenCalledWith(new Uint8Array([7]), "image/gif");
      expect(createPostMock).toHaveBeenCalledWith(
        expect.objectContaining({ images: [expect.objectContaining({ blob: { ref: "blob-gif" } })] }),
      );
    });

    /**
     * The transport kept images and GIFs only, so a render selecting a video
     * published as TEXT with no visual and no error. It must refuse instead,
     * before any fetch or upload, with the class publish.ts treats as "refused
     * before sending".
     */
    it("refuses a video loudly, before any network call, instead of posting text-only", async () => {
      const video = media({ path: "/tmp/clip.mp4", type: "video", mimeType: "video/mp4", url: "https://cdn.example.com/clip.mp4" });
      const err = await blueskyTransport.publishNow(input({ media: [media(), video] })).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(PublishPreflightError);
      expect((err as Error).message).toMatch(/Bluesky video is not supported/);
      expect(fetch).not.toHaveBeenCalled();
      expect(uploadBlobMock).not.toHaveBeenCalled();
      expect(createPostMock).not.toHaveBeenCalled();
      expect(SPECS.bluesky.publishesVideo).toBe(false);
    });

    /**
     * ⛔ A selected asset with no public URL is REFUSED by name, before any
     * post. Skipping it published the post without it, with a real id, so
     * nothing downstream noticed the image was gone.
     */
    it("refuses a selected asset with no public URL instead of posting without it", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => new Response(new Uint8Array([2])));
      uploadBlobMock.mockResolvedValue({ ref: "blob-ok" });

      await expect(
        blueskyTransport.publishNow(
          input({
            media: [media({ url: "https://cdn.example.com/first.png" }), media({ path: "/lib/second.png", url: undefined })],
          }),
        ),
      ).rejects.toMatchObject({
        name: "PublishPreflightError",
        message: expect.stringContaining("bluesky: media asset /lib/second.png has no public url"),
      });
      expect(createPostMock).not.toHaveBeenCalled();
    });

    /**
     * ⛔ A HALF-FETCHED IMAGE MUST NOT BECOME A PUBLISHED POST. The CDN answering
     * 404 or 502 means the bytes are wrong, and `arrayBuffer()` on an error
     * response still resolves (to the error page's own body), so without the
     * `res.ok` check Bluesky would be handed an HTML blob as an image. Failing
     * here leaves the leg retryable; publishing a broken embed does not, because
     * Bluesky has no edit.
     */
    it("refuses to publish when the media fetch itself failed, rather than uploading the error body", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        status: 502,
        arrayBuffer: async () => new Uint8Array([0]).buffer,
      });
      createPostMock.mockResolvedValue({ uri: "at://did:plc:x/app.bsky.feed.post/root", cid: "cid-root" });

      await expect(blueskyTransport.publishNow(input({ media: [media()] }))).rejects.toThrow(
        /failed to fetch media asset \(502\)/,
      );
      expect(uploadBlobMock).not.toHaveBeenCalled();
      expect(createPostMock).not.toHaveBeenCalled();
    });
  });

  describe("publishNow: threads", () => {
    it("with no threadItems, returns just the root ref and url", async () => {
      createPostMock.mockResolvedValue({ uri: "at://did:plc:x/app.bsky.feed.post/root", cid: "cid-root" });
      const result = await blueskyTransport.publishNow(input());
      expect(result).toEqual({
        ref: "at://did:plc:x/app.bsky.feed.post/root",
        url: "https://bsky.app/profile/did:plc:x/post/root",
      });
      expect(result.queued).toBeUndefined();
      expect(result.threadRoot).toBeUndefined();
    });

    it("with no delay, chains every reply inline, each to the immediately prior post", async () => {
      const root = { uri: "at://did:plc:x/app.bsky.feed.post/root", cid: "cid-root" };
      const reply1 = { uri: "at://did:plc:x/app.bsky.feed.post/r1", cid: "cid-r1" };
      const reply2 = { uri: "at://did:plc:x/app.bsky.feed.post/r2", cid: "cid-r2" };
      createPostMock.mockResolvedValue(root);
      createReplyMock.mockResolvedValueOnce(reply1).mockResolvedValueOnce(reply2);

      const result = await blueskyTransport.publishNow(
        input({ render: render({ threadItems: ["first follow-up", "second follow-up"], followupDelayMinutes: 0 }) }),
      );

      expect(createReplyMock).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ text: "first follow-up", root, parent: root }),
      );
      expect(createReplyMock).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ text: "second follow-up", root, parent: reply1 }),
      );
      // The result is the ROOT's ref, not the last reply's.
      expect(result.ref).toBe(root.uri);
      expect(result.queued).toBeUndefined();
      // Every reply's own ref, so a delete can remove them: deleting the root
      // does not delete its replies on Bluesky.
      expect(result.replyRefs).toEqual([reply1.uri, reply2.uri]);
    });

    /**
     * ⛔ ONCE THE ROOT IS LIVE, A FAILED REPLY MUST NOT FAIL publishNow. It used
     * to throw, and the registry's retry wrapper re-ran the whole publishNow on a
     * 429 (three roots in one call), while any other error left the leg pending
     * for the ring to post the root again next tick.
     */
    it.each([
      ["a vendor error", new BlueskyError(429, "RateLimitExceeded", "POST", "com.atproto.repo.createRecord"), "RateLimitExceeded"],
      ["a non-Error rejection", "socket hang up", "socket hang up"],
    ])("stops the inline chain at a failed reply (%s) and returns the root with a warning", async (_label, failure, reason) => {
      const root = { uri: "at://did:plc:x/app.bsky.feed.post/root", cid: "cid-root" };
      createPostMock.mockResolvedValue(root);
      createReplyMock
        .mockResolvedValueOnce({ uri: "at://did:plc:x/app.bsky.feed.post/r1", cid: "cid-r1" })
        .mockRejectedValueOnce(failure);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      const result = await blueskyTransport.publishNow(
        input({ render: render({ threadItems: ["one", "two", "three"] }) }),
      );

      expect(createPostMock).toHaveBeenCalledTimes(1);
      // Reply three is never attempted: hanging it off reply one would put the
      // thread out of order.
      expect(createReplyMock).toHaveBeenCalledTimes(2);
      expect(result.ref).toBe(root.uri);
      expect(result.warnings).toEqual([expect.stringContaining("thread stopped at reply 2 of 3")]);
      expect(result.warnings![0]).toContain(reason);
      // The reply that landed before the failure is still recorded.
      expect(result.replyRefs).toEqual(["at://did:plc:x/app.bsky.feed.post/r1"]);
      warn.mockRestore();
    });

    it("never posts the root twice through the registry when a reply is rate limited", async () => {
      const { registerTransport, registeredTransportFor, resetTransports } = await import("../transport.js");
      resetTransports();
      registerTransport(blueskyTransport);
      const root = { uri: "at://did:plc:x/app.bsky.feed.post/root", cid: "cid-root" };
      createPostMock.mockResolvedValue(root);
      createReplyMock.mockRejectedValue(new BlueskyError(429, "RateLimitExceeded", "POST", "com.atproto.repo.createRecord"));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      try {
        const result = await registeredTransportFor("bluesky")!.publishNow(
          input({ render: render({ threadItems: ["a", "b"] }) }),
        );

        expect(createPostMock).toHaveBeenCalledTimes(1);
        expect(result.ref).toBe(root.uri);
        expect(result.warnings).toHaveLength(1);
      } finally {
        resetTransports();
        warn.mockRestore();
      }
    });

    /**
     * ⛔ AN UNSET DELAY IS "NOW", NOT "NEVER". `followupDelayMinutes` is optional
     * on PlatformRender and the playbook only stamps it once a tuning value is
     * raised above zero, so the ordinary render arrives here with the field
     * ABSENT. If absence fell through to the deferred branch, every ordinary
     * thread would be persisted as queued replies waiting on a `dueAt` computed
     * from `undefined`, and publish-due would be the only thing that could ever
     * release them.
     */
    it("chains inline when the render carries no delay field at all", async () => {
      const root = { uri: "at://did:plc:x/app.bsky.feed.post/root", cid: "cid-root" };
      createPostMock.mockResolvedValue(root);
      createReplyMock.mockResolvedValue({ uri: "at://did:plc:x/app.bsky.feed.post/r1", cid: "cid-r1" });

      const result = await blueskyTransport.publishNow(
        input({ render: render({ threadItems: ["the follow-up"] }) }),
      );

      expect(createReplyMock).toHaveBeenCalledTimes(1);
      expect(result.queued).toBeUndefined();
      expect(result.threadRoot).toBeUndefined();
      expect(result.ref).toBe(root.uri);
    });

    it("with a delay, posts only the root and returns threadRoot + queued replies due at position*delay", async () => {
      const root = { uri: "at://did:plc:x/app.bsky.feed.post/root", cid: "cid-root" };
      createPostMock.mockResolvedValue(root);
      const now = Date.parse("2026-08-02T12:00:00.000Z");
      vi.useFakeTimers();
      vi.setSystemTime(now);

      const result = await blueskyTransport.publishNow(
        input({ render: render({ threadItems: ["a", "b"], followupDelayMinutes: 10 }) }),
      );

      expect(createReplyMock).not.toHaveBeenCalled();
      expect(result.threadRoot).toEqual({ uri: root.uri, cid: root.cid });
      expect(result.queued).toEqual([
        { position: 1, text: "a", dueAt: new Date(now + 10 * 60_000).toISOString(), parent: { uri: root.uri, cid: root.cid } },
        { position: 2, text: "b", dueAt: new Date(now + 20 * 60_000).toISOString(), parent: { uri: root.uri, cid: root.cid } },
      ]);
      vi.useRealTimers();
    });

    it("persists the render's langs on every queued reply, so a deferred reply is tagged like the root", async () => {
      const root = { uri: "at://did:plc:x/app.bsky.feed.post/root", cid: "cid-root" };
      createPostMock.mockResolvedValue(root);
      const result = await blueskyTransport.publishNow(
        input({ render: render({ threadItems: ["a", "b"], followupDelayMinutes: 10, langs: ["fr", "en"] }) }),
      );
      expect(result.queued!.map((q) => q.langs)).toEqual([
        ["fr", "en"],
        ["fr", "en"],
      ]);
    });
  });

  describe("the 3000-byte text cap", () => {
    // 150 family emoji: 150 graphemes, well inside 300, but 25 bytes each.
    const heavy = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}".repeat(150);

    it("refuses a root over 3000 UTF-8 bytes before anything is uploaded or posted", async () => {
      await expect(
        blueskyTransport.publishNow(input({ render: render({ content: heavy }), media: [media()] })),
      ).rejects.toMatchObject({
        name: "PublishPreflightError",
        message: expect.stringMatching(/^bluesky: the post is 3750 UTF-8 bytes, over the post record's 3000-byte cap/),
      });
      expect(fetch).not.toHaveBeenCalled();
      expect(createPostMock).not.toHaveBeenCalled();
    });

    it("refuses an over-cap REPLY before the root goes live", async () => {
      await expect(
        blueskyTransport.publishNow(input({ render: render({ threadItems: ["fine", heavy] }) })),
      ).rejects.toThrow(/^bluesky: reply 2 is 3750 UTF-8 bytes/);
      expect(createPostMock).not.toHaveBeenCalled();
    });

    it("refuses an over-cap queued reply at release", async () => {
      const root = { uri: "at://did:plc:x/app.bsky.feed.post/root", cid: "cid-root" };
      const reply: DirectQueuedReply = { position: 3, text: heavy, dueAt: new Date().toISOString(), parent: root };
      await expect(blueskyTransport.publishReply!(reply, root)).rejects.toThrow(/^bluesky: reply 3 is 3750 UTF-8 bytes/);
      expect(createReplyMock).not.toHaveBeenCalled();
    });
  });

  describe("publishReply", () => {
    it("tags a released reply with the langs persisted on it", async () => {
      const root = { uri: "at://did:plc:x/app.bsky.feed.post/root", cid: "cid-root" };
      createReplyMock.mockResolvedValue({ uri: "at://did:plc:x/app.bsky.feed.post/d1", cid: "cid-d1" });
      const reply: DirectQueuedReply = {
        position: 1,
        text: "suivi",
        dueAt: new Date().toISOString(),
        parent: { uri: root.uri, cid: root.cid },
        langs: ["fr"],
      };
      await blueskyTransport.publishReply!(reply, root);
      expect(createReplyMock).toHaveBeenCalledWith(expect.objectContaining({ text: "suivi", langs: ["fr"] }));
    });

    it("posts one queued reply against the given root and its own parent", async () => {
      const root = { uri: "at://did:plc:x/app.bsky.feed.post/root", cid: "cid-root" };
      const posted = { uri: "at://did:plc:x/app.bsky.feed.post/deferred1", cid: "cid-d1" };
      createReplyMock.mockResolvedValue(posted);

      const reply: DirectQueuedReply = {
        position: 1,
        text: "deferred follow-up",
        dueAt: new Date().toISOString(),
        parent: { uri: root.uri, cid: root.cid },
      };

      const result = await blueskyTransport.publishReply!(reply, root);

      expect(createReplyMock).toHaveBeenCalledWith(
        expect.objectContaining({ text: "deferred follow-up", root, parent: root }),
      );
      expect(result.ref).toBe(posted.uri);
    });

    it("throws rather than posting when the persisted parent handles are malformed", async () => {
      const root = { uri: "at://did:plc:x/app.bsky.feed.post/root", cid: "cid-root" };
      const reply: DirectQueuedReply = { position: 1, text: "x", dueAt: new Date().toISOString(), parent: {} };
      await expect(blueskyTransport.publishReply!(reply, root)).rejects.toThrow(/missing uri\/cid/);
      expect(createReplyMock).not.toHaveBeenCalled();
    });
  });

  describe("postFacts", () => {
    it("maps a found post to PUBLISHED/released", async () => {
      getPostsMock.mockResolvedValue([{ uri: "at://a", cid: "1" }]);
      const facts = await blueskyTransport.postFacts(["at://a"]);
      expect(facts.get("at://a")).toEqual({ state: "PUBLISHED", released: true, platform: "bluesky" });
    });

    it("maps a ref ABSENT from the response to QUEUE, not ERROR", async () => {
      // The vendor answered successfully but simply omitted this uri — not a
      // per-ref error entry, exactly as app.bsky.feed.getPosts behaves.
      getPostsMock.mockResolvedValue([]);
      const facts = await blueskyTransport.postFacts(["at://gone"]);
      // `absent` marks it as the DEFINITIVE kind of QUEUE, which is what lets
      // the reconcile eventually give up on it. `state` is still QUEUE: the
      // transport does not get to call a post permanently dead.
      expect(facts.get("at://gone")).toEqual({
        state: "QUEUE",
        released: false,
        platform: "bluesky",
        absent: true,
      });
    });

    it("maps every ref in a batch to QUEUE (never ERROR) when the lookup itself fails", async () => {
      getPostsMock.mockRejectedValue(new BlueskyError(503, "upstream unavailable", "GET", "app.bsky.feed.getPosts"));
      const facts = await blueskyTransport.postFacts(["at://a", "at://b"]);
      // No `absent` here, and that difference is the whole point: an unreachable
      // vendor says nothing about whether the post exists, so this QUEUE must
      // never become terminal no matter how long it persists.
      expect(facts.get("at://a")).toEqual({ state: "QUEUE", released: false, platform: "bluesky" });
      expect(facts.get("at://b")).toEqual({ state: "QUEUE", released: false, platform: "bluesky" });
    });

    /**
     * ⛔ THE QUEUE VERDICT MUST NOT DEPEND ON THE ERROR BEING A BlueskyError. A
     * DNS failure, an aborted timeout or a TypeError out of undici never reaches
     * the vendor at all, so it is the LEAST informative kind of failure about
     * whether the post exists. Narrowing the catch to BlueskyError would let one
     * of those escape postFacts entirely and surface as a thrown reconcile,
     * which the caller reads as a broken leg rather than an unreachable vendor.
     */
    it("maps a transport-level failure (not even a vendor error) to QUEUE, with the reason still legible", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      getPostsMock.mockRejectedValue(new TypeError("fetch failed"));

      const facts = await blueskyTransport.postFacts(["at://a"]);

      expect(facts.get("at://a")).toEqual({ state: "QUEUE", released: false, platform: "bluesky" });
      // ⛔ No `absent`: nothing was confirmed, so this QUEUE must never become
      // the definitive kind the reconcile is allowed to give up on.
      expect(facts.get("at://a")).not.toHaveProperty("absent");
      expect(String(warn.mock.calls[0]?.[0])).toContain("TypeError: fetch failed");
      warn.mockRestore();
    });

    it("chunks more than 25 refs into multiple getPosts calls", async () => {
      getPostsMock.mockResolvedValue([]);
      const refs = Array.from({ length: 30 }, (_, i) => `at://post-${i}`);
      await blueskyTransport.postFacts(refs);
      expect(getPostsMock).toHaveBeenCalledTimes(2);
      expect(getPostsMock.mock.calls[0][0]).toHaveLength(25);
      expect(getPostsMock.mock.calls[1][0]).toHaveLength(5);
    });

    it("returns an empty map for an empty ref list", async () => {
      const facts = await blueskyTransport.postFacts([]);
      expect(facts.size).toBe(0);
      expect(getPostsMock).not.toHaveBeenCalled();
    });
  });

  describe("deletePost", () => {
    it("deletes normally when the post still exists", async () => {
      deleteRecordMock.mockResolvedValue(undefined);
      await expect(blueskyTransport.deletePost("at://did:plc:x/app.bsky.feed.post/abc")).resolves.toBeUndefined();
    });

    it("treats a RecordNotFound error as SUCCESS, not a failure", async () => {
      deleteRecordMock.mockRejectedValue(
        new BlueskyError(400, "RecordNotFound: could not locate record", "POST", "com.atproto.repo.deleteRecord"),
      );
      await expect(blueskyTransport.deletePost("at://did:plc:x/app.bsky.feed.post/gone")).resolves.toBeUndefined();
    });

    it("still throws for a real failure (e.g. auth), not just swallowing everything", async () => {
      deleteRecordMock.mockRejectedValue(
        new BlueskyError(401, "AuthenticationRequired: token expired", "POST", "com.atproto.repo.deleteRecord"),
      );
      await expect(blueskyTransport.deletePost("at://did:plc:x/app.bsky.feed.post/abc")).rejects.toThrow(
        /AuthenticationRequired/,
      );
    });

    /**
     * ⚠️ The not-found check reads `err.body`, which only a BlueskyError has. A
     * network-level rejection carries no body at all, so guarding on the error
     * TYPE first is what stops the idempotency shortcut from throwing a
     * `Cannot read properties of undefined` out of the catch block and masking
     * the real failure. A connection error is emphatically not "already
     * deleted": swallowing it would report a still-live post as removed.
     */
    it("rethrows a network-level failure rather than mistaking it for an already-deleted record", async () => {
      deleteRecordMock.mockRejectedValue(new TypeError("fetch failed"));
      await expect(blueskyTransport.deletePost("at://did:plc:x/app.bsky.feed.post/abc")).rejects.toThrow(
        /fetch failed/,
      );
    });
  });
});

/**
 * Bluesky's analytics come free: the counts ride on the SAME
 * app.bsky.feed.getPosts response postFacts already makes. They were being
 * fetched and discarded.
 *
 * ⛔ Same rule as YouTube's: an optional count the lexicon allows to be absent
 * is OMITTED, never defaulted to 0, because a real zero and "the appview has
 * not aggregated it" look identical on a chart and only one is true.
 */
describe("bluesky analytics", () => {
  it("reads engagement off the post view without an extra call", async () => {
    getPostsMock.mockResolvedValue([
      { uri: "at://a", cid: "1", likeCount: 12, repostCount: 3, replyCount: 2, quoteCount: 1 },
    ]);
    await expect(blueskyTransport.analyticsPost!("at://a")).resolves.toEqual({
      likes: 12,
      reposts: 3,
      replies: 2,
      quotes: 1,
    });
    expect(getPostsMock).toHaveBeenCalledTimes(1);
  });

  it("omits a count the appview did not report", async () => {
    getPostsMock.mockResolvedValue([{ uri: "at://a", cid: "1", likeCount: 12 }]);
    const stats = await blueskyTransport.analyticsPost!("at://a");
    expect(stats).toEqual({ likes: 12 });
    expect("reposts" in stats).toBe(false);
  });

  it("returns an empty bag when the post is not in the response", async () => {
    getPostsMock.mockResolvedValue([]);
    await expect(blueskyTransport.analyticsPost!("at://gone")).resolves.toEqual({});
  });

  /**
   * ⛔ Likes are not privileged. Every count here is optional in the lexicon, and
   * a post whose likeCount has not been aggregated yet must come back WITHOUT a
   * `likes` key rather than with `likes: 0`. A brand-new post reporting zero
   * likes next to real reposts is indistinguishable from a post nobody liked,
   * and only one of those is true.
   */
  it("omits likes entirely when the appview reported every count except that one", async () => {
    getPostsMock.mockResolvedValue([{ uri: "at://a", cid: "1", repostCount: 3, replyCount: 1, quoteCount: 0 }]);
    const stats = await blueskyTransport.analyticsPost!("at://a");
    expect(stats).toEqual({ reposts: 3, replies: 1, quotes: 0 });
    expect("likes" in stats).toBe(false);
  });

  it("reports profile counters as channel analytics", async () => {
    getProfileMock.mockResolvedValue({
      did: "did:plc:x",
      handle: "example.com",
      followersCount: 500,
      followsCount: 100,
      postsCount: 20,
    });
    await expect(blueskyTransport.analyticsChannel!()).resolves.toEqual({
      followers: 500,
      following: 100,
      posts: 20,
    });
  });

  /**
   * ⚠️ The mirror of the analyticsChannel test above: a profile view that
   * carries none of the three counters must produce an EMPTY bag, not three
   * zeroes. The dashboard renders whatever keys it is given, so a fabricated
   * `followers: 0` on a real account reads as an account that lost everyone.
   */
  it("reports no channel counters at all when the profile view carries none", async () => {
    getProfileMock.mockResolvedValue({ did: "did:plc:x", handle: "example.com" });
    await expect(blueskyTransport.analyticsChannel!()).resolves.toEqual({});
  });

  it("THROWS rather than reporting 0 followers when the profile omits the count", async () => {
    getProfileMock.mockResolvedValue({ did: "did:plc:x", handle: "example.com" });
    await expect(blueskyTransport.followerStats!()).rejects.toThrow(/followersCount/i);
  });

  /**
   * The happy path of the method whose FAILURE was the only case pinned. A
   * follower chart is drawn from this number, so "throws when absent" is only
   * half the contract: the other half is that a present count is returned
   * unwrapped and unrounded, including a genuine zero on a brand-new account
   * (which is why the assertion below is `toBe(0)`, not a truthiness check).
   */
  it("returns the vendor's follower count as-is, including a real zero", async () => {
    getProfileMock.mockResolvedValue({ did: "did:plc:x", handle: "example.com", followersCount: 0 });
    await expect(blueskyTransport.followerStats!()).resolves.toEqual({ followers: 0 });

    getProfileMock.mockResolvedValue({ did: "did:plc:x", handle: "example.com", followersCount: 1234 });
    await expect(blueskyTransport.followerStats!()).resolves.toEqual({ followers: 1234 });
  });
});

describe("publishNow: language tags", () => {
  it("sends the render's langs on the root and on every inline reply", async () => {
    createPostMock.mockResolvedValue({ uri: "at://did:plc:x/app.bsky.feed.post/root", cid: "cid-root" });
    createReplyMock.mockResolvedValue({ uri: "at://did:plc:x/app.bsky.feed.post/r1", cid: "cid-r1" });

    await blueskyTransport.publishNow(
      input({ render: { ...render(), content: "Six voix en français canadien", threadItems: ["Lien : https://example.ca/x"], langs: ["fr-CA", "en"] } }),
    );

    // A French post with no tag is invisible to a reader whose feed is
    // filtered to French; the reply is its own record and needs the tag too.
    expect(createPostMock).toHaveBeenCalledWith(expect.objectContaining({ langs: ["fr-CA", "en"] }));
    expect(createReplyMock).toHaveBeenCalledWith(expect.objectContaining({ langs: ["fr-CA", "en"] }));
  });

  it("omits langs entirely when the render carries none, as every post did before", async () => {
    createPostMock.mockResolvedValue({ uri: "at://did:plc:x/app.bsky.feed.post/root", cid: "cid-root" });
    await blueskyTransport.publishNow(input());
    expect(createPostMock.mock.calls[0]![0]).not.toHaveProperty("langs", expect.anything());
    expect(createPostMock.mock.calls[0]![0].langs).toBeUndefined();
  });
});
