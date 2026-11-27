// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Only the session/network layer (CredentialSession, Agent in
 * bluesky-xrpc.ts) is mocked here; bluesky-xrpc.test.ts covers that layer at
 * the fetch level. Facet detection and XRPCError stay REAL: detectFacets is a
 * pure, offline computation for link-only text (it only touches the network
 * to resolve @mention handles, and none of the text below contains one).
 */
const constructedServiceUrls = vi.hoisted(() => [] as string[]);
const mockLogin = vi.hoisted(() => vi.fn());
const mockPost = vi.hoisted(() => vi.fn());
const mockGetPosts = vi.hoisted(() => vi.fn());
const mockDeletePost = vi.hoisted(() => vi.fn());
const mockUploadBlob = vi.hoisted(() => vi.fn());
const mockGetProfile = vi.hoisted(() => vi.fn());
const mockResumeSession = vi.hoisted(() => vi.fn());

vi.mock("../bluesky-xrpc.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../bluesky-xrpc.js")>();

  class MockCredentialSession {
    did?: string;
    constructor(
      public serviceUrl: URL,
      public fetch?: unknown,
    ) {
      constructedServiceUrls.push(serviceUrl.toString());
    }
    login = (...a: unknown[]) => {
      // Mirrors the real CredentialSession: a successful login is what makes
      // hasSession true, which is how getAgent decides whether it still needs
      // to log in after attempting a resume.
      this.session = { accessJwt: "a", refreshJwt: "r", handle: "h", did: "d", active: true };
      return mockLogin(...a);
    };
    resumeSession = (...a: unknown[]) => {
      const r = mockResumeSession(...a);
      return Promise.resolve(r).then((v) => {
        this.session = { accessJwt: "a", refreshJwt: "r", handle: "h", did: "d", active: true };
        return v;
      });
    };
    session?: unknown;
    get hasSession() {
      return Boolean(this.session);
    }
  }

  class MockAgent {
    did = "did:plc:testaccount000";
    constructor(public sessionManager: MockCredentialSession) {}
    post = mockPost;
    getPosts = mockGetPosts;
    deletePost = mockDeletePost;
    uploadBlob = mockUploadBlob;
    getProfile = mockGetProfile;
  }

  return {
    ...actual,
    CredentialSession: MockCredentialSession,
    Agent: MockAgent,
  };
});

import { XRPCError, type BlobRef } from "../bluesky-xrpc.js";
import {
  BlueskyError,
  setBlueskyCredentialsResolver,
  setBlueskySessionStore,
  buildRichText,
  createPost,
  createReply,
  getPosts,
  deleteRecord,
  uploadBlob,
  getProfile,
  normalizeBlueskyIdentifier,
  blueskyIdentifierHash,
} from "../bluesky.js";

const CREDS = { identifier: "example.com", password: "app-password" };

describe("bluesky client", () => {
  beforeEach(() => {
    mockLogin.mockReset().mockResolvedValue(undefined);
    mockPost.mockReset();
    mockGetPosts.mockReset();
    mockDeletePost.mockReset();
    mockUploadBlob.mockReset();
    mockGetProfile.mockReset();
    constructedServiceUrls.length = 0;
    // Clears the cached session too, so each test opens a fresh one.
    setBlueskyCredentialsResolver(async () => CREDS);
  });

  afterEach(() => {
    setBlueskyCredentialsResolver(null);
  });

  describe("session", () => {
    it("throws a clear BlueskyError when no resolver is registered", async () => {
      setBlueskyCredentialsResolver(null);
      await expect(getProfile("did:plc:someone")).rejects.toThrow(/no Bluesky credentials resolver/);
    });

    it("throws when the resolver returns an empty identifier or password", async () => {
      setBlueskyCredentialsResolver(async () => ({ identifier: "", password: "" }));
      await expect(getProfile("did:plc:someone")).rejects.toThrow(/empty identifier or password/);
      expect(mockLogin).not.toHaveBeenCalled();
    });

    it("opens exactly one session across multiple calls (lazy + cached)", async () => {
      mockGetProfile.mockResolvedValue({ did: "did:plc:x", handle: "x.bsky.social" });
      await getProfile("did:plc:x");
      await getProfile("did:plc:x");
      await getProfile("did:plc:x");
      expect(mockLogin).toHaveBeenCalledTimes(1);
    });

    it("logs in against bsky.social, not the public AppView host", async () => {
      mockGetProfile.mockResolvedValue({ did: "did:plc:x", handle: "x.bsky.social" });
      await getProfile("did:plc:x");
      expect(mockLogin).toHaveBeenCalledWith(CREDS);
      expect(constructedServiceUrls).toEqual(["https://bsky.social/"]);
    });

    it("re-opens a session after the credentials resolver is replaced", async () => {
      mockGetProfile.mockResolvedValue({ did: "did:plc:x", handle: "x.bsky.social" });
      await getProfile("did:plc:x");
      expect(mockLogin).toHaveBeenCalledTimes(1);
      setBlueskyCredentialsResolver(async () => CREDS); // rotation: clears the cached session
      await getProfile("did:plc:x");
      expect(mockLogin).toHaveBeenCalledTimes(2);
    });
  });

  describe("buildRichText (facets)", () => {
    it("attaches a real link facet for a URL in the text", async () => {
      const result = await buildRichText("check this out https://example.com");
      expect(result.facets).toBeDefined();
      const linkFacet = result.facets?.find((f) => f.features.some((ft) => ft.$type === "app.bsky.richtext.facet#link"));
      expect(linkFacet).toBeDefined();
      const linkFeature = linkFacet?.features.find(
        (ft): ft is { $type: string; uri: string } => ft.$type === "app.bsky.richtext.facet#link",
      );
      expect(linkFeature?.uri).toBe("https://example.com");
    });

    it("returns no facets for plain text with no link, mention or tag", async () => {
      const result = await buildRichText("just a plain build-in-public update, no links here");
      expect(result.facets ?? []).toHaveLength(0);
    });
  });

  describe("createPost / createReply", () => {
    it("uploads images with alt text into the embed", async () => {
      mockPost.mockResolvedValue({ uri: "at://did:plc:x/app.bsky.feed.post/abc", cid: "cid-1" });
      const blob = { ref: "blob-ref" } as unknown as BlobRef;
      await createPost({
        text: "hello",
        images: [{ blob, alt: "a photo of the product" }],
      });
      const record = mockPost.mock.calls[0][0];
      expect(record.embed).toEqual({
        $type: "app.bsky.embed.images",
        images: [{ image: blob, alt: "a photo of the product" }],
      });
    });

    it("builds a reply with independent root and parent StrongRefs", async () => {
      mockPost.mockResolvedValue({ uri: "at://did:plc:x/app.bsky.feed.post/reply1", cid: "cid-2" });
      const root = { uri: "at://did:plc:x/app.bsky.feed.post/root", cid: "cid-root" };
      const parent = { uri: "at://did:plc:x/app.bsky.feed.post/mid", cid: "cid-mid" };
      await createReply({ text: "follow-up", root, parent });
      const record = mockPost.mock.calls[0][0];
      expect(record.reply).toEqual({ root, parent });
    });

    it("wraps a vendor rejection in a BlueskyError", async () => {
      mockPost.mockRejectedValue(new XRPCError(400, "InvalidRequest", "invalid record"));
      await expect(createPost({ text: "x" })).rejects.toBeInstanceOf(BlueskyError);
    });
  });

  describe("getPosts", () => {
    it("returns [] for an empty uri list without calling the vendor", async () => {
      const result = await getPosts([]);
      expect(result).toEqual([]);
      expect(mockLogin).not.toHaveBeenCalled();
    });

    it("passes the uris through and returns the posts array", async () => {
      const posts = [{ uri: "at://a", cid: "1" }];
      mockGetPosts.mockResolvedValue(posts);
      const result = await getPosts(["at://a", "at://b"]);
      expect(mockGetPosts).toHaveBeenCalledWith(["at://a", "at://b"]);
      expect(result).toBe(posts);
    });
  });

  describe("deleteRecord", () => {
    it("passes the raw error through as a BlueskyError (idempotency is the transport's job)", async () => {
      mockDeletePost.mockRejectedValue(new XRPCError(400, "RecordNotFound", "could not locate record"));
      await expect(deleteRecord("at://did:plc:x/app.bsky.feed.post/gone")).rejects.toThrow(BlueskyError);
    });

    it("resolves on a normal successful delete", async () => {
      mockDeletePost.mockResolvedValue(undefined);
      await expect(deleteRecord("at://did:plc:x/app.bsky.feed.post/abc")).resolves.toBeUndefined();
    });
  });

  describe("uploadBlob", () => {
    it("uploads bytes with the given mime type and returns the blob", async () => {
      const blob = { ref: "blob-1" };
      mockUploadBlob.mockResolvedValue(blob);
      const data = new Uint8Array([1, 2, 3]);
      const result = await uploadBlob(data, "image/png");
      expect(mockUploadBlob).toHaveBeenCalledWith(data, "image/png");
      expect(result).toBe(blob);
    });
  });

  describe("getProfile", () => {
    it("defaults to the authenticated session's own did when no actor is given", async () => {
      mockGetProfile.mockResolvedValue({ did: "did:plc:testaccount000", handle: "examplebrand.bsky.social" });
      const profile = await getProfile();
      expect(mockGetProfile).toHaveBeenCalledWith("did:plc:testaccount000");
      expect(profile).toEqual({ did: "did:plc:testaccount000", handle: "examplebrand.bsky.social" });
    });

    it("looks up a specific actor when one is given", async () => {
      mockGetProfile.mockResolvedValue({ did: "did:plc:other", handle: "other.bsky.social" });
      await getProfile("did:plc:other");
      expect(mockGetProfile).toHaveBeenCalledWith("did:plc:other");
    });
  });
});

/**
 * The "@" that cost Bluesky its credential.
 *
 * `com.atproto.server.createSession` takes EITHER a handle or an email and
 * decides which by looking for an "@". So the handle exactly as it appears on
 * the profile page — "@example.com" — is parsed as an email with an empty
 * local part and rejected:
 *
 *   400 InvalidEmail: Invalid email address: Address local part cannot be empty
 *
 * Found live: BLUESKY_IDENTIFIER held "@example.com" and Bluesky was the
 * only platform reporting a failed credential. Calling createSession with the
 * stripped value authenticated immediately as handle `example.com`.
 *
 * The trap is that the error blames EMAIL validation for something the operator
 * entered as a HANDLE, so it reads like a dead account rather than one stray
 * character.
 */
describe("normalizeBlueskyIdentifier", () => {
  it("strips the leading @ an operator copies off the profile page", () => {
    expect(normalizeBlueskyIdentifier("@example.com")).toBe("example.com");
  });

  it("leaves a correctly-entered handle untouched", () => {
    expect(normalizeBlueskyIdentifier("example.com")).toBe("example.com");
    expect(normalizeBlueskyIdentifier("examplebrand.bsky.social")).toBe("examplebrand.bsky.social");
  });

  /**
   * The other accepted form. An email's "@" is INTERNAL, never leading, so
   * stripping a leading "@" cannot corrupt one — which is what makes doing this
   * unconditionally safe rather than a guess about which form was supplied.
   */
  it("does not touch the internal @ of an email identifier", () => {
    expect(normalizeBlueskyIdentifier("approver@example.com")).toBe("approver@example.com");
  });

  it("trims whitespace, which a pasted secret picks up silently", () => {
    expect(normalizeBlueskyIdentifier("  @example.com \n")).toBe("example.com");
  });

  it("collapses a doubled @ rather than leaving one behind", () => {
    expect(normalizeBlueskyIdentifier("@@example.com")).toBe("example.com");
  });
});

/**
 * The altitude half of the fix: normalising inside getAgent() means EVERY
 * consumer is covered, whatever resolver the app wired in. Fixing it only in
 * the app's resolver left the listening path (which POSTs createSession itself)
 * still broken, which is exactly what happened on the first attempt.
 */
describe("bluesky login normalises the identifier", () => {
  beforeEach(() => {
    mockLogin.mockReset().mockResolvedValue(undefined);
    mockPost.mockReset();
  });
  afterEach(() => setBlueskyCredentialsResolver(null));

  it("logs in with the @ stripped when the resolver hands back a raw handle", async () => {
    setBlueskyCredentialsResolver(async () => ({
      identifier: "@example.com",
      password: "app-password",
    }));

    await createPost({ text: "hello" });

    expect(mockLogin).toHaveBeenCalledWith({
      identifier: "example.com",
      password: "app-password",
    });
  });

  /**
   * An identifier of nothing but "@" must still fail — but as a MISSING
   * credential, which points at the secret, rather than as a malformed email,
   * which points at the account.
   */
  it("still rejects an identifier that normalises to empty", async () => {
    setBlueskyCredentialsResolver(async () => ({ identifier: "@", password: "app-password" }));

    await expect(createPost({ text: "hello" })).rejects.toThrow(/empty identifier or password/);
    expect(mockLogin).not.toHaveBeenCalled();
  });
});

/**
 * Session persistence: the ten-logins-a-day problem.
 *
 * `com.atproto.server.createSession` is capped at 10 per 24h per account
 * (`RateLimit-Policy: 10;w=86400`, read live). Without a stored session every
 * cold worker logs in, and a settings panel that does a live connectStatus()
 * on each load spends one of the ten every time it is OPENED, so the account
 * reaches `429 RateLimitExceeded` within a day.
 *
 * These assert the property that matters: with a stored session, no login.
 */
describe("bluesky session persistence", () => {
  const ATP_SESSION = {
    accessJwt: "access-1",
    refreshJwt: "refresh-1",
    handle: "example.com",
    did: "did:plc:test",
    active: true,
  };
  /** As stored: tagged with the hash of the identifier it was created for. */
  const SESSION = { ...ATP_SESSION, identifierHash: blueskyIdentifierHash(CREDS.identifier) };

  beforeEach(() => {
    mockLogin.mockReset().mockResolvedValue(undefined);
    mockResumeSession.mockReset().mockResolvedValue(undefined);
    mockGetProfile.mockReset().mockResolvedValue({ did: "did:plc:test", handle: "example.com" });
    setBlueskyCredentialsResolver(async () => CREDS);
  });

  afterEach(() => {
    setBlueskySessionStore(null);
    setBlueskyCredentialsResolver(null);
  });

  it("resumes a stored session INSTEAD of logging in", async () => {
    setBlueskySessionStore({ load: async () => SESSION, save: async () => {} });

    await getProfile("did:plc:test");

    // The XRPC client gets its own session data, never our hash.
    expect(mockResumeSession).toHaveBeenCalledWith(ATP_SESSION);
    // The whole point. A login here would spend one of ten daily.
    expect(mockLogin).not.toHaveBeenCalled();
  });

  it("logs in when there is no stored session", async () => {
    setBlueskySessionStore({ load: async () => null, save: async () => {} });

    await getProfile("did:plc:test");

    expect(mockResumeSession).not.toHaveBeenCalled();
    expect(mockLogin).toHaveBeenCalledTimes(1);
  });

  /**
   * A rejection from resumeSession means the REFRESH failed. The session may
   * still be "set", but its access token cannot be trusted, so it is dropped
   * and a real login happens rather than issuing unauthenticated requests.
   */
  it("falls back to login and CLEARS the store when the stored session cannot refresh", async () => {
    const saved: unknown[] = [];
    mockResumeSession.mockRejectedValue(new Error("ExpiredToken"));
    setBlueskySessionStore({
      load: async () => SESSION,
      save: async (s) => {
        saved.push(s);
      },
    });

    await getProfile("did:plc:test");

    expect(mockLogin).toHaveBeenCalledTimes(1);
    expect(saved).toContain(null);
  });

  /** A storage outage must not take publishing down with it. */
  it("still logs in when the store throws on read", async () => {
    setBlueskySessionStore({
      load: async () => {
        throw new Error("database down");
      },
      save: async () => {},
    });

    await expect(getProfile("did:plc:test")).resolves.toBeDefined();
    expect(mockLogin).toHaveBeenCalledTimes(1);
  });
});
