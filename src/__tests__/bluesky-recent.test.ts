/**
 * bluesky.ts listRecentPosts: the account's own post records, newest first,
 * for the agent publish's crash check. The XRPC client is mocked; no network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockListRecords = vi.hoisted(() => vi.fn());
const agentDid = vi.hoisted(() => ({ value: "did:plc:me" as string | undefined }));

vi.mock("../bluesky-xrpc.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../bluesky-xrpc.js")>();
  class MockCredentialSession {
    session?: unknown;
    constructor(public serviceUrl: URL) {}
    login = async () => {
      this.session = { accessJwt: "a", refreshJwt: "r", handle: "h", did: "d", active: true };
    };
    resumeSession = async () => undefined;
    get hasSession() {
      return Boolean(this.session);
    }
  }
  class MockAgent {
    get did() {
      return agentDid.value;
    }
    listRecords = mockListRecords;
    constructor(public sessionManager: MockCredentialSession) {}
  }
  return { ...actual, CredentialSession: MockCredentialSession, Agent: MockAgent };
});

import { XRPCError } from "../bluesky-xrpc.js";
import { BlueskyError, listRecentPosts, setBlueskyCredentialsResolver } from "../bluesky.js";

beforeEach(() => {
  mockListRecords.mockReset();
  agentDid.value = "did:plc:me";
  setBlueskyCredentialsResolver(async () => ({ identifier: "example.com", password: "app-password" }));
});

afterEach(() => setBlueskyCredentialsResolver(null));

describe("listRecentPosts", () => {
  it("reads the account's own post collection, keeping replies textless and the cursor flagged", async () => {
    mockListRecords.mockResolvedValueOnce({
        cursor: "c1",
        records: [
          { uri: "at://did:plc:me/app.bsky.feed.post/3", cid: "c", value: { text: "Root", createdAt: "2026-11-08T05:01:00.000Z" } },
          {
            uri: "at://did:plc:me/app.bsky.feed.post/2",
            cid: "c",
            value: { text: "A reply", createdAt: "2026-11-08T05:00:30.000Z", reply: { root: {}, parent: {} } },
          },
          { uri: "at://did:plc:me/app.bsky.feed.post/1", cid: "c", value: { text: 7, createdAt: "nonsense" } },
          { uri: "at://did:plc:me/app.bsky.feed.post/0", cid: "c", value: {} },
        ],
    });
    const page = await listRecentPosts();
    expect(mockListRecords).toHaveBeenCalledWith({ repo: "did:plc:me", collection: "app.bsky.feed.post", limit: 25 });
    expect(page).toEqual({
      posts: [
        { id: "at://did:plc:me/app.bsky.feed.post/3", texts: ["Root"], createdAt: "2026-11-08T05:01:00.000Z" },
        { id: "at://did:plc:me/app.bsky.feed.post/2", texts: [], createdAt: "2026-11-08T05:00:30.000Z" },
        { id: "at://did:plc:me/app.bsky.feed.post/1", texts: [], createdAt: null },
        { id: "at://did:plc:me/app.bsky.feed.post/0", texts: [], createdAt: null },
      ],
      more: true,
    });
  });

  it("no cursor is the last page", async () => {
    mockListRecords.mockResolvedValueOnce({ records: [] });
    expect(await listRecentPosts()).toEqual({ posts: [], more: false });
  });

  it("refuses with no session did, before any read", async () => {
    agentDid.value = undefined;
    await expect(listRecentPosts()).rejects.toThrow(BlueskyError);
    expect(mockListRecords).not.toHaveBeenCalled();
  });

  it("a vendor error comes back as a BlueskyError with its status", async () => {
    mockListRecords.mockRejectedValueOnce(new XRPCError(502, "UpstreamFailure", "bad gateway"));
    const err = await listRecentPosts().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BlueskyError);
    expect((err as BlueskyError).status).toBe(502);
    expect((err as Error).message).toContain("com.atproto.repo.listRecords");
  });
});
