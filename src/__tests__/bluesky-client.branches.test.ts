import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The parts of the bluesky.ts vendor client that bluesky.test.ts does not
 * reach: what a caller can CONCLUDE from a failure, the persistSession
 * callback, the single-flighted login, the 15s fetch timebox, the response
 * byte cap, and searchPosts.
 *
 * Why it matters, in the shape a human meets it:
 *
 *   - Every failure above this file arrives as a BlueskyError and nothing
 *     else. `status` is the only machine-readable signal left, and it means
 *     three different things: 0 = we never got into XRPC (bad credentials, a
 *     thrown non-Error), 1 = XRPC could not reach the server (a timeout is
 *     THIS, not 0), and a real HTTP code = the vendor answered. retry.ts
 *     classifies on those, so getting them wrong retries a permanent failure
 *     forever or gives up on a rate limit.
 *   - A publish that could not open a session must not look like a publish.
 *     The login-failure tests assert the vendor was never called, not merely
 *     that something rejected.
 *   - The persistSession callback is the ten-logins-a-day guard. If it saves
 *     on the wrong events, or lets a storage hiccup escape, the account is
 *     back to burning `createSession` calls and hits 429 in production.
 *
 * ⚠️ RichText is MOCKED here, unlike in bluesky.test.ts, purely so
 * detectFacets can be made to fail. The real facet detection swallows its own
 * network errors (rich-text.ts catches around resolveHandle), so there is no
 * honest way to exercise buildRichText's catch with the genuine class. Real
 * facet output and real grapheme counting stay pinned in bluesky.test.ts; do
 * not move those assertions here.
 */

type PersistHandler = (evt: string, data?: unknown) => void;

const h = vi.hoisted(() => ({
  serviceUrls: [] as string[],
  fetchImpls: [] as Array<typeof globalThis.fetch>,
  persistHandlers: [] as PersistHandler[],
  agentDid: undefined as string | undefined,
  /** Runs inside every Agent constructor, so a test can act at that exact point. */
  onAgent: undefined as (() => void) | undefined,
  login: vi.fn(),
  resumeSession: vi.fn(),
  detectFacets: vi.fn(),
  post: vi.fn(),
  getPosts: vi.fn(),
  searchPosts: vi.fn(),
  deletePost: vi.fn(),
  uploadBlob: vi.fn(),
  getProfile: vi.fn(),
}));

vi.mock("@atproto/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@atproto/api")>();

  // ⛔ Declared INSIDE the factory. The factory is hoisted above every
  // top-level binding, so a class declared in module scope is still in its
  // temporal dead zone when this runs.
  class MockCredentialSession {
    session?: unknown;
    constructor(
      public serviceUrl: URL,
      public fetch: typeof globalThis.fetch,
      public persistSession?: PersistHandler,
    ) {
      h.serviceUrls.push(serviceUrl.toString());
      h.fetchImpls.push(fetch);
      if (persistSession) h.persistHandlers.push(persistSession);
    }
    // ⛔ The session is set only AFTER the underlying call resolves, exactly
    // like the real CredentialSession. A mock that sets it first would make a
    // failed login look like a live session and hide the fall-through logic
    // getAgent depends on.
    login = async (...a: unknown[]) => {
      const r = await h.login(...a);
      this.session = { accessJwt: "a", refreshJwt: "r", handle: "h", did: "d", active: true };
      return r;
    };
    resumeSession = async (...a: unknown[]) => {
      const r = await h.resumeSession(...a);
      this.session = { accessJwt: "a", refreshJwt: "r", handle: "h", did: "d", active: true };
      return r;
    };
    get hasSession() {
      return Boolean(this.session);
    }
  }

  class MockAgent {
    constructor(public sessionManager: unknown) {
      h.onAgent?.();
    }
    get did() {
      return h.agentDid;
    }
    post = h.post;
    getPosts = h.getPosts;
    deletePost = h.deletePost;
    uploadBlob = h.uploadBlob;
    getProfile = h.getProfile;
    app = { bsky: { feed: { searchPosts: h.searchPosts } } };
  }

  class MockRichText {
    text: string;
    facets?: unknown;
    constructor(opts: { text: string }) {
      this.text = opts.text;
    }
    get graphemeLength() {
      return [...this.text].length;
    }
    detectFacets = async (agent: unknown) => {
      const out = (await h.detectFacets(agent)) as { facets?: unknown } | undefined;
      if (out && "facets" in out) this.facets = out.facets;
    };
  }

  return {
    ...actual,
    CredentialSession: MockCredentialSession,
    Agent: MockAgent,
    RichText: MockRichText,
  };
});

import { XRPCError, type BlobRef } from "@atproto/api";
import type { BlueskySessionStore } from "../bluesky.js";
import { isUnknownOutcome } from "../retry.js";
import {
  BlueskyError,
  setBlueskyCredentialsResolver,
  setBlueskySessionStore,
  buildRichText,
  createPost,
  getPosts,
  searchPosts,
  deleteRecord,
  uploadBlob,
  getProfile,
  blueskyIdentifierHash,
} from "../bluesky.js";

const CREDS = { identifier: "example.com", password: "app-password" };
/** The hash a session created for CREDS is stored with. */
const CREDS_HASH = blueskyIdentifierHash(CREDS.identifier);
const PROFILE = { data: { did: "did:plc:testaccount000", handle: "example.com" } };

/** Opens a real (mocked) session so the constructed CredentialSession can be inspected. */
async function openSession(): Promise<void> {
  await getProfile("did:plc:someone");
}

/** Lets a fire-and-forget `void Promise...catch()` settle. */
async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  h.serviceUrls.length = 0;
  h.fetchImpls.length = 0;
  h.persistHandlers.length = 0;
  h.agentDid = "did:plc:testaccount000";
  h.onAgent = undefined;
  // ⚠️ mockReset, not clearAllMocks: several tests seed a *Once queue and
  // clearAllMocks would leave it for the next test to inherit.
  h.login.mockReset().mockResolvedValue(undefined);
  h.resumeSession.mockReset().mockResolvedValue(undefined);
  h.detectFacets.mockReset().mockResolvedValue(undefined);
  h.post.mockReset();
  h.getPosts.mockReset();
  h.searchPosts.mockReset();
  h.deletePost.mockReset();
  h.uploadBlob.mockReset();
  h.getProfile.mockReset().mockResolvedValue(PROFILE);
  // Both setters drop the cached agent, so every test starts cold.
  setBlueskySessionStore(null);
  setBlueskyCredentialsResolver(async () => CREDS);
});

afterEach(() => {
  setBlueskySessionStore(null);
  setBlueskyCredentialsResolver(null);
});

/**
 * `status` is the whole vocabulary a caller has for "what went wrong", because
 * BlueskyError is the only error shape that escapes this file. retry.ts and
 * the transport both branch on it.
 */
describe("what a caller can conclude from a BlueskyError", () => {
  it("reports a failure that never reached XRPC as status 0 and keeps the original reason", async () => {
    h.post.mockRejectedValue(new TypeError("fetch failed"));

    const err = await createPost({ text: "hello" }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BlueskyError);
    const bsky = err as BlueskyError;
    expect(bsky.status).toBe(0);
    expect(bsky.body).toBe("fetch failed");
    expect(bsky.retryAfter).toBeNull();
    // The path is in the message so a log line says WHICH call died.
    expect(bsky.message).toContain("com.atproto.repo.createRecord#app.bsky.feed.post");
  });

  it("stringifies a thrown non-Error rather than losing the reason entirely", async () => {
    // Undici and worker threads both reject with bare strings in the wild.
    h.post.mockRejectedValue("worker terminated");

    const err = (await createPost({ text: "hello" }).catch((e: unknown) => e)) as BlueskyError;

    expect(err.status).toBe(0);
    expect(err.body).toBe("worker terminated");
  });

  it("keeps the vendor's HTTP status instead of flattening it to 0", async () => {
    h.post.mockRejectedValue(new XRPCError(400, "InvalidRequest", "text too long"));

    const err = (await createPost({ text: "x" }).catch((e: unknown) => e)) as BlueskyError;

    expect(err.status).toBe(400);
    expect(err.body).toBe("InvalidRequest: text too long");
  });

  /**
   * ⛔ THIS IS THE ONLY CLIENT IN THE ENGINE THAT CAN RECOVER Retry-After.
   * XRPCError keeps the response headers as a lowercased map, and the Response
   * object is gone by the time anything above this file sees the error. Drop
   * this and retry.ts falls back to a guessed backoff against an account that
   * is rate limited at ten logins a day.
   */
  it("carries Retry-After verbatim off the XRPC header map", async () => {
    h.post.mockRejectedValue(
      new XRPCError(429, "RateLimitExceeded", "slow down", { "retry-after": "3600" }),
    );

    const err = (await createPost({ text: "x" }).catch((e: unknown) => e)) as BlueskyError;

    expect(err.status).toBe(429);
    // Verbatim. retry.ts owns the grammar (seconds vs HTTP-date); this file
    // must not pre-parse it.
    expect(err.retryAfter).toBe("3600");
  });

  it("leaves retryAfter null when the vendor sent no such header", async () => {
    h.post.mockRejectedValue(new XRPCError(500, "InternalServerError", "boom"));

    const err = (await createPost({ text: "x" }).catch((e: unknown) => e)) as BlueskyError;

    expect(err.retryAfter).toBeNull();
  });

  /**
   * ⚠️ A TIMEOUT IS STATUS 1, NOT 0. The timebox aborts the fetch, XRPC wraps
   * the abort as an XRPCError with ResponseType.Unknown (= 1), and wrapError
   * passes that number straight through. Code that treats 0 as "the network
   * layer failed" will silently miss every timeout.
   */
  it("surfaces a timed-out request as XRPC status 1 (Unknown), not 0", async () => {
    h.post.mockRejectedValue(
      XRPCError.from(new Error("The operation was aborted due to timeout")),
    );

    const err = (await createPost({ text: "x" }).catch((e: unknown) => e)) as BlueskyError;

    expect(err.status).toBe(1);
    expect(err.body).toContain("aborted due to timeout");
  });

  /**
   * ⚠️ Purely defensive: the real XRPCError always assigns a string `error` and
   * Error always assigns a string `message`, so this is not reachable through
   * the vendor SDK. It is pinned anyway because `body` is what lands in the
   * log, and "undefined: undefined" would be an unreadable log line.
   */
  it("never renders 'undefined' into the body when a vendor error is missing its fields", async () => {
    const malformed = new XRPCError(503, "NotEnoughResources", "overloaded");
    Object.assign(malformed, { error: undefined, message: undefined });
    h.post.mockRejectedValue(malformed);

    const err = (await createPost({ text: "x" }).catch((e: unknown) => e)) as BlueskyError;

    expect(err.body).toBe("Error: ");
    expect(err.body).not.toContain("undefined");
  });
});

/**
 * The wrapped fetch. A hung connection must not hold a publish request open
 * forever, and it is applied at the session level so session management calls
 * are covered too, not just data calls.
 */
describe("the request timebox", () => {
  it("attaches an abort signal when the caller supplied none", async () => {
    await openSession();
    const wrapped = h.fetchImpls[0];
    expect(wrapped).toBeTypeOf("function");

    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));
    try {
      await wrapped("https://bsky.social/xrpc/com.atproto.server.getSession", { method: "GET" });

      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(init.signal?.aborted).toBe(false);
      // The original init survives; the wrapper only adds a signal.
      expect(init.method).toBe("GET");
      // ⛔ 15s, the same budget postiz.ts uses. A larger number here lets one
      // stalled vendor connection sit inside a publish request.
      expect(timeoutSpy).toHaveBeenCalledWith(15_000);
    } finally {
      fetchSpy.mockRestore();
      timeoutSpy.mockRestore();
    }
  });

  /**
   * ⛔ The caller's signal WINS. @atproto/api passes its own AbortSignal for
   * calls the app cancels; replacing it would make a cancel silently do
   * nothing and leave the request running to its own timeout instead.
   */
  it("respects a signal the caller already supplied rather than replacing it", async () => {
    await openSession();
    const wrapped = h.fetchImpls[0];
    const controller = new AbortController();

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));
    try {
      await wrapped("https://bsky.social/xrpc/com.atproto.server.getSession", {
        signal: controller.signal,
      });

      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      expect(init.signal).toBe(controller.signal);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

/**
 * ⛔ The response byte cap is the compensating control for the nested zod
 * advisory (GHSA-mrhx-c7xc-m3w5), ACCEPTED with this bound because no
 * in-range fix exists: the @atproto chain pins zod 3.x and the fix is only in
 * 4.6.6. The advisory names memory exhaustion from a crafted response, and
 * the only host this wrapper ever dials is the hard-coded bsky.social
 * AppView, so the cap is what bounds that vector. Like the timebox above, it
 * lives in the wrapped fetch so session management calls are covered too, not
 * just data calls.
 *
 * 5 MiB is several times the largest legitimate response (a 100-post
 * searchPosts page is a few hundred KB of JSON), so nothing real ever hits
 * it, while an endless or hostile body is refused at the first chunk past the
 * bound rather than buffered whole.
 */
describe("the response byte cap", () => {
  const CAP = 5 * 1024 * 1024;

  /** Opens a session and returns the wrapped fetch the session was built on. */
  async function wrappedFetch(): Promise<typeof globalThis.fetch> {
    await openSession();
    const wrapped = h.fetchImpls[0];
    expect(wrapped).toBeTypeOf("function");
    return wrapped;
  }

  it("passes a response under the cap through with status, headers and body intact", async () => {
    const wrapped = await wrappedFetch();
    const body = new Uint8Array([1, 2, 3, 4]);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(body, { headers: { "content-type": "application/json" } }),
      );
    try {
      const res = await wrapped("https://bsky.social/xrpc/app.bsky.feed.getPosts");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/json");
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(body);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  /**
   * The declared branch: a Content-Length already over the cap refuses before
   * a byte is read, so a lying or runaway header cannot make the client buffer
   * the body it describes.
   */
  it("refuses a response that declares more than the cap before a byte is read", async () => {
    const wrapped = await wrappedFetch();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([1]), { headers: { "content-length": String(CAP + 1) } }),
    );
    try {
      await expect(wrapped("https://bsky.social/xrpc/app.bsky.feed.getPosts")).rejects.toThrow(
        /exceeds the fetch byte cap/,
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  /**
   * The streaming branch: a body with no (or lying) Content-Length is caught
   * chunk by chunk, so the cap holds even when the size is only discovered
   * while reading.
   */
  it("refuses a response that streams more than the cap with no content-length", async () => {
    const wrapped = await wrappedFetch();
    // A constructed Response carries no content-length header, so this body
    // can only be caught while streaming.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(new Uint8Array(CAP + 1)));
    try {
      await expect(wrapped("https://bsky.social/xrpc/app.bsky.feed.getPosts")).rejects.toThrow(
        /exceeds the fetch byte cap/,
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  /**
   * ⛔ THE REFUSAL IS THE SAME SHAPE A TIMEOUT IS. The wrapped fetch throws a
   * plain Error (like the timebox's DOMException), the real XRPC client's
   * catch wraps it with XRPCError.from, and wrapError turns that into the one
   * error shape that ever escapes this file: a BlueskyError of status 1
   * (Unknown), never 0 and never a silent pass-through. Getting the status
   * wrong makes retry.ts misclassify the failure.
   */
  it("reaches a caller as the same BlueskyError a timeout does: status 1, reason kept", async () => {
    const wrapped = await wrappedFetch();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([1]), { headers: { "content-length": String(CAP + 1) } }),
    );
    try {
      // What the real xrpc-client.js catch does to anything the fetch handler
      // throws, applied to the genuine refusal.
      const raw = await wrapped("https://bsky.social/xrpc/app.bsky.feed.getPosts").then(
        () => null,
        (e: unknown) => e,
      );
      expect(raw).toBeInstanceOf(Error);
      const xrpc = XRPCError.from(raw);
      expect(xrpc).toBeInstanceOf(XRPCError);
      expect(xrpc.status).toBe(1);
      expect(xrpc.message).toContain("exceeds the fetch byte cap");

      h.post.mockRejectedValue(xrpc);
      const err = (await createPost({ text: "x" }).catch((e: unknown) => e)) as BlueskyError;

      expect(err).toBeInstanceOf(BlueskyError);
      expect(err.status).toBe(1);
      expect(err.body).toContain("exceeds the fetch byte cap");
      expect(err.message).toContain("com.atproto.repo.createRecord#app.bsky.feed.post");
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

/**
 * ⛔ A rotated credential or a replaced store retires every session opened
 * under the old pair, including one still opening when the swap happened.
 * Caching it would keep publishing as an identity the host stopped using, and
 * letting it write would clobber the row the new pair keeps.
 */
describe("a resolver or store replaced while the session is opening", () => {
  const NEW_CREDS = { identifier: "new.example.com", password: "new-app-password" };
  const ROW = { accessJwt: "a", refreshJwt: "r", handle: "h", did: "did:plc:test", active: true };

  function gated(): { gate: Promise<void>; release: () => void } {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { gate, release };
  }

  it("does not cache the obsolete session and hands its callers one from the new resolver", async () => {
    const { gate, release } = gated();
    h.login.mockImplementationOnce(async () => {
      await gate;
    });

    const pending = getProfile("did:plc:x");
    await vi.waitFor(() => expect(h.login).toHaveBeenCalledTimes(1));
    setBlueskyCredentialsResolver(async () => NEW_CREDS);
    release();
    await pending;
    await getProfile("did:plc:x");

    expect(h.login.mock.calls).toEqual([[CREDS], [NEW_CREDS]]);
  });

  it("hands the callers of an obsolete attempt that FAILED a session from the new resolver", async () => {
    const { gate, release } = gated();
    h.login.mockImplementationOnce(async () => {
      await gate;
      throw new XRPCError(401, "AuthenticationRequired", "Invalid identifier or password");
    });

    const pending = getProfile("did:plc:x");
    await vi.waitFor(() => expect(h.login).toHaveBeenCalledTimes(1));
    setBlueskyCredentialsResolver(async () => NEW_CREDS);
    release();

    await expect(pending).resolves.toBeDefined();
    expect(h.login.mock.calls).toEqual([[CREDS], [NEW_CREDS]]);
  });

  it("hands no caller an Agent whose pair was replaced after the attempt finished", async () => {
    // The swap is queued from inside the Agent constructor, after the attempt's
    // last generation check, so it runs once the attempt has resolved but
    // before the completion handler hands the Agent to its callers.
    h.onAgent = () => {
      h.onAgent = undefined;
      queueMicrotask(() => setBlueskyCredentialsResolver(async () => NEW_CREDS));
    };

    await getProfile("did:plc:x");

    expect(h.login.mock.calls).toEqual([[CREDS], [NEW_CREDS]]);
    // The Agent the call used is the one opened for the new resolver.
    expect(h.getProfile.mock.contexts).toHaveLength(1);
    const used = h.getProfile.mock.contexts[0] as { sessionManager: unknown };
    expect(h.persistHandlers).toHaveLength(2);
    expect((used.sessionManager as { persistSession?: unknown }).persistSession).toBe(h.persistHandlers[1]);
  });

  it("drops a save that was queued before the store was replaced", async () => {
    const oldSave = vi.fn(async () => {});
    setBlueskySessionStore({ load: async () => null, save: oldSave });
    await openSession();

    // The callback queues the save; the replacement lands before it runs.
    h.persistHandlers[0]("update", ROW);
    setBlueskySessionStore({ load: async () => null, save: async () => {} });
    await flushMicrotasks();

    expect(oldSave).not.toHaveBeenCalled();
  });

  it("lets an obsolete session persist nothing, to the old store or the new one", async () => {
    const oldSave = vi.fn(async () => {});
    setBlueskySessionStore({ load: async () => null, save: oldSave });
    await openSession();
    const persist = h.persistHandlers[0];

    const newSave = vi.fn(async () => {});
    setBlueskySessionStore({ load: async () => null, save: newSave });
    persist("update", ROW);
    await flushMicrotasks();

    expect(oldSave).not.toHaveBeenCalled();
    expect(newSave).not.toHaveBeenCalled();
  });

  it("does not drop the row a new credential stored when the obsolete one finds it foreign", async () => {
    const { gate, release } = gated();
    const row = { ...ROW, identifierHash: blueskyIdentifierHash(NEW_CREDS.identifier) };
    const save = vi.fn(async () => {});
    const load = vi
      .fn<() => Promise<typeof row>>()
      .mockImplementationOnce(async () => {
        await gate;
        return row;
      })
      .mockImplementation(async () => row);
    setBlueskySessionStore({ load, save });

    const pending = getProfile("did:plc:x");
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    setBlueskyCredentialsResolver(async () => NEW_CREDS);
    release();
    await pending;

    expect(save).not.toHaveBeenCalled();
    // The new credential resumed its own row instead of spending a login.
    expect(h.resumeSession).toHaveBeenCalledTimes(1);
    expect(h.login).not.toHaveBeenCalled();
  });

  it("does not clear the new store when the obsolete session's refresh is refused", async () => {
    const { gate, release } = gated();
    h.resumeSession.mockImplementationOnce(async () => {
      await gate;
      throw new Error("ExpiredToken");
    });
    const oldSave = vi.fn(async () => {});
    setBlueskySessionStore({ load: async () => ({ ...ROW, identifierHash: CREDS_HASH }), save: oldSave });

    const pending = getProfile("did:plc:x");
    await vi.waitFor(() => expect(h.resumeSession).toHaveBeenCalledTimes(1));
    const newSave = vi.fn(async () => {});
    setBlueskySessionStore({ load: async () => null, save: newSave });
    release();
    await pending;

    expect(oldSave).not.toHaveBeenCalled();
    expect(newSave).not.toHaveBeenCalled();
    expect(h.login).toHaveBeenCalledTimes(1);
  });
});

/**
 * ⛔ `com.atproto.server.createSession` is capped at TEN per 24h per account
 * (RateLimit-Policy: 10;w=86400, read live). Every extra session a process
 * opens is one every other process on the same account cannot open later.
 */
describe("opening the session", () => {
  it("shares ONE login between concurrent callers on a cold process", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    setBlueskyCredentialsResolver(async () => {
      await gate;
      return CREDS;
    });
    h.getPosts.mockResolvedValue({ data: { posts: [] } });

    // Both start before either can finish logging in.
    const first = getProfile("did:plc:x");
    const second = getPosts(["at://a"]);
    release();
    await Promise.all([first, second]);

    expect(h.login).toHaveBeenCalledTimes(1);
    // ⛔ Not just one login: one SESSION. A second CredentialSession would be a
    // second createSession call the moment it was used.
    expect(h.serviceUrls).toEqual(["https://bsky.social/"]);
  });

  it("names createSession, and publishes NOTHING, when the login itself is rate limited", async () => {
    h.login.mockRejectedValue(
      new XRPCError(429, "RateLimitExceeded", "createSession", { "retry-after": "86400" }),
    );

    const err = (await createPost({ text: "hello" }).catch((e: unknown) => e)) as BlueskyError;

    expect(err).toBeInstanceOf(BlueskyError);
    expect(err.status).toBe(429);
    expect(err.retryAfter).toBe("86400");
    // ⛔ The operator must be able to tell a dead credential from a rejected
    // post: the path says createSession, not createRecord.
    expect(err.message).toContain("com.atproto.server.createSession");
    // ⛔ The load-bearing half. Nothing reached the vendor, so no caller may
    // conclude anything was published.
    expect(h.post).not.toHaveBeenCalled();
  });

  it("does not cache a broken login, so the next call tries again", async () => {
    h.login.mockRejectedValueOnce(new XRPCError(502, "UpstreamFailure", "pds down"));
    h.post.mockResolvedValue({ uri: "at://did:plc:x/app.bsky.feed.post/ok", cid: "cid-1" });

    await expect(createPost({ text: "first" })).rejects.toThrow(BlueskyError);
    // ⚠️ A cached failed agent would wedge the process until a redeploy. The
    // second attempt must reach the vendor.
    await expect(createPost({ text: "second" })).resolves.toEqual({
      uri: "at://did:plc:x/app.bsky.feed.post/ok",
      cid: "cid-1",
    });
    expect(h.login).toHaveBeenCalledTimes(2);
  });

  /**
   * ⚠️ Without the `?? ""` in getAgent, a resolver that hands back an object
   * with no identifier at all would blow up inside normalizeBlueskyIdentifier
   * with "Cannot read properties of undefined (reading 'trim')", which points
   * at this file rather than at the missing secret.
   */
  it("blames the credential, not the code, when the resolver omits the identifier", async () => {
    setBlueskyCredentialsResolver(
      async () => ({ password: "app-password" }) as unknown as { identifier: string; password: string },
    );

    await expect(createPost({ text: "hello" })).rejects.toThrow(/empty identifier or password/);
    expect(h.login).not.toHaveBeenCalled();
  });

  /** A storage outage on the CLEAR path must not take publishing down either. */
  it("still logs in when the store cannot be cleared after a failed resume", async () => {
    h.resumeSession.mockRejectedValue(new Error("ExpiredToken"));
    setBlueskySessionStore({
      load: async () => ({
        accessJwt: "a",
        refreshJwt: "r",
        handle: "example.com",
        did: "did:plc:test",
        active: true,
        identifierHash: CREDS_HASH,
      }),
      save: async () => {
        throw new Error("database down");
      },
    });

    await expect(getProfile("did:plc:test")).resolves.toBeDefined();
    expect(h.login).toHaveBeenCalledTimes(1);
  });
});

/**
 * persistSession fires on every token rotation, not only at login. Getting the
 * event mapping wrong is how the stored session goes stale and cold starts go
 * back to spending createSession calls.
 */
describe("persisting the session", () => {
  const SESSION_DATA = {
    accessJwt: "access-2",
    refreshJwt: "refresh-2",
    handle: "example.com",
    did: "did:plc:test",
    active: true,
    identifierHash: CREDS_HASH,
  };
  /** What @atproto/api hands persistSession: its own fields, no hash. */
  const { identifierHash: _hash, ...ATP_DATA } = SESSION_DATA;

  it("saves the session on create and again on every token rotation", async () => {
    const save = vi.fn(async () => {});
    setBlueskySessionStore({ load: async () => null, save });
    await openSession();
    const persist = h.persistHandlers[0];

    persist("create", ATP_DATA);
    persist("update", { ...ATP_DATA, accessJwt: "access-3" });
    await flushMicrotasks();

    // ⛔ Both carry the hash: a refresh rebuilds the session field by field,
    // and a row saved without it would be dropped on the next cold start.
    expect(save).toHaveBeenNthCalledWith(1, SESSION_DATA);
    expect(save).toHaveBeenNthCalledWith(2, { ...SESSION_DATA, accessJwt: "access-3" });
  });

  /**
   * ⛔ `expired` must CLEAR the store. A dead refresh token that stays on disk
   * is retried by every cold start forever, and each retry that fails falls
   * through to a real login, which is the budget this whole mechanism exists
   * to protect.
   */
  it("clears the stored session when the vendor reports it expired", async () => {
    const save = vi.fn(async () => {});
    setBlueskySessionStore({ load: async () => null, save });
    await openSession();

    h.persistHandlers[0]("expired", SESSION_DATA);
    await flushMicrotasks();

    expect(save).toHaveBeenCalledWith(null);
  });

  it("clears the stored session when a login fails", async () => {
    const save = vi.fn(async () => {});
    setBlueskySessionStore({ load: async () => null, save });
    await openSession();

    h.persistHandlers[0]("create-failed", undefined);
    await flushMicrotasks();

    expect(save).toHaveBeenCalledWith(null);
  });

  /**
   * ⛔ `network-error` KEEPS the stored session. @atproto/api fires it when a
   * refresh failed for a reason that says nothing about the token (a timeout, a
   * PDS 5xx) and keeps the session itself. Clearing the fleet-shared row on it
   * made every pod that saw a blip log in again, spending the 10-a-day
   * createSession budget.
   */
  it("leaves the stored session alone on a network error", async () => {
    const save = vi.fn(async () => {});
    setBlueskySessionStore({ load: async () => null, save });
    await openSession();

    h.persistHandlers[0]("network-error", SESSION_DATA);
    await flushMicrotasks();

    expect(save).not.toHaveBeenCalled();
  });

  /**
   * ⚠️ A create event with no data is not "keep what you had": it is a session
   * we cannot reconstruct. Storing `undefined` would hand the next cold start
   * an unusable record instead of telling it to log in.
   */
  it("stores an explicit null when a create event arrives with no session data", async () => {
    const save = vi.fn(async () => {});
    setBlueskySessionStore({ load: async () => null, save });
    await openSession();

    h.persistHandlers[0]("create", undefined);
    await flushMicrotasks();

    expect(save).toHaveBeenCalledWith(null);
  });

  /** A deployment that wires no store at all must still work, just without persistence. */
  it("does nothing at all when no session store is wired", async () => {
    const save = vi.fn(async () => {});
    setBlueskySessionStore({ load: async () => null, save });
    await openSession();
    const persist = h.persistHandlers[0];

    setBlueskySessionStore(null);
    expect(() => persist("create", SESSION_DATA)).not.toThrow();
    await flushMicrotasks();

    expect(save).not.toHaveBeenCalled();
  });

  /**
   * ⛔ A storage hiccup must never fail a publish that is otherwise fine. The
   * save is fire-and-forget precisely so it cannot reject into @atproto's
   * token-refresh path, and the warning is the only trace it leaves.
   */
  it("warns and carries on when the store rejects a write", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      setBlueskySessionStore({
        load: async () => null,
        save: async () => {
          throw new Error("session store unavailable");
        },
      });
      await openSession();

      expect(() => h.persistHandlers[0]("create", SESSION_DATA)).not.toThrow();
      await flushMicrotasks();

      expect(warn).toHaveBeenCalledWith(
        "[bluesky] could not persist session:",
        expect.objectContaining({ message: "session store unavailable" }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  /**
   * ⛔ THE SYNCHRONOUS CASE, WHICH IS A DIFFERENT CODE PATH FROM THE ONE ABOVE.
   * `Promise.resolve(store.save(x))` CALLS save() before Promise.resolve exists
   * to wrap it, so a store that throws synchronously escapes the `.catch`
   * entirely. The type says `=> Promise<void>`, so an async store cannot do
   * this, but a plain function that throws can, and the compiler will not stop
   * one being passed from JavaScript or through a cast.
   *
   * ⚠️ If someone "simplifies" either site back to
   * `Promise.resolve(store.save(x))`, the async test above still passes and
   * only this one goes red. That asymmetry is the entire reason it exists.
   */
  it("survives a store whose save throws SYNCHRONOUSLY, not just one that rejects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      setBlueskySessionStore({
        load: async () => null,
        save: (() => {
          throw new Error("sync store failure");
        }) as unknown as BlueskySessionStore["save"],
      });
      await openSession();

      expect(() => h.persistHandlers[0]("create", SESSION_DATA)).not.toThrow();
      await flushMicrotasks();

      expect(warn).toHaveBeenCalledWith(
        "[bluesky] could not persist session:",
        expect.objectContaining({ message: "sync store failure" }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  /**
   * ⛔ ONLY A REFUSED REFRESH TOKEN ENDS THE STORED SESSION. Any resume failure
   * used to wipe the fleet-shared row and log in, so a PDS blip during a
   * four-region rollout spent the 10-a-day createSession budget and left
   * Bluesky answering 429 for the rest of the day.
   */
  it.each([
    ["a PDS 5xx", new XRPCError(502, "UpstreamFailure", "bad gateway")],
    ["a network failure", new XRPCError(1, "Unknown", "fetch failed")],
    ["a rate limit", new XRPCError(429, "RateLimitExceeded", "slow down")],
  ])("keeps the stored session, and does not log in, when the refresh fails on %s", async (_label, failure) => {
    h.resumeSession.mockRejectedValue(failure);
    const save = vi.fn(async () => {});
    setBlueskySessionStore({ load: async () => SESSION_DATA, save });

    const err = await getProfile("did:plc:test").then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("com.atproto.server.refreshSession");
    // The refusal XRPC raised rides along as the cause, the very object resumeSession rejected with.
    expect((err as Error).cause).toBe(failure);
    expect(save).not.toHaveBeenCalledWith(null);
    expect(h.login).not.toHaveBeenCalled();
  });

  /**
   * ⛔ A FAILED REFRESH IS NOT AN UNKNOWN OUTCOME. It happens before any create,
   * so nothing can have been posted. Thrown as a BlueskyError(502) it read as
   * "the post may already be live" to publish-due (retry.ts), which failed the
   * leg for good instead of leaving it pending for the next tick. A plain Error
   * carries no status, the same as transport-wiring's pre-create Page token read.
   */
  it.each([
    ["a PDS 5xx", new XRPCError(502, "UpstreamFailure", "bad gateway")],
    ["a timeout", new XRPCError(1, "Unknown", "The operation was aborted due to timeout")],
  ])("throws a refresh failure on %s as a status-less Error, not an unknown outcome", async (_label, failure) => {
    h.resumeSession.mockRejectedValue(failure);
    setBlueskySessionStore({ load: async () => SESSION_DATA, save: vi.fn(async () => {}) });

    const err = await getProfile("did:plc:test").then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).not.toBeInstanceOf(BlueskyError);
    expect((err as { status?: unknown }).status).toBeUndefined();
    expect(isUnknownOutcome(err)).toBe(false);
  });

  it.each([
    ["an expired refresh token", new XRPCError(400, "ExpiredToken", "Token has expired")],
    ["an invalid refresh token", new XRPCError(400, "InvalidToken", "Token could not be verified")],
    ["a refused credential", new XRPCError(401, "AuthenticationRequired", "nope")],
    ["a session for another account", new XRPCError(400, "InvalidDID", "Invalid session")],
  ])("drops the stored session and logs in when the refresh fails on %s", async (_label, failure) => {
    h.resumeSession.mockRejectedValue(failure);
    const save = vi.fn(async () => {});
    setBlueskySessionStore({ load: async () => SESSION_DATA, save });

    await expect(getProfile("did:plc:test")).resolves.toBeDefined();

    expect(save).toHaveBeenCalledWith(null);
    expect(h.login).toHaveBeenCalledTimes(1);
  });

  /**
   * The second store-write site, in the resumeSession failure path. A sync
   * throw there rejected `_loginPromise` with the RAW Error, so a caller got
   * something that is not a BlueskyError and this file's whole contract with
   * everything above it broke on a storage hiccup.
   */
  it("still logs in when clearing a dead session throws SYNCHRONOUSLY", async () => {
    // Mirrors "still logs in when the store cannot be cleared after a failed
    // resume" directly above, with the one difference that matters: that store
    // REJECTS, this one THROWS. Only the second reaches the ordering bug.
    h.resumeSession.mockRejectedValue(new Error("ExpiredToken"));
    setBlueskySessionStore({
      load: async () => SESSION_DATA,
      save: (() => {
        throw new Error("sync store failure");
      }) as unknown as BlueskySessionStore["save"],
    });

    await expect(getProfile("did:plc:test")).resolves.toBeDefined();
    // Fell through to a real login rather than rejecting out of the catch.
    expect(h.login).toHaveBeenCalledTimes(1);
  });
});

describe("buildRichText", () => {
  /**
   * ⛔ detectFacets needs the AUTHENTICATED agent: resolving an @mention to a
   * DID is an API call. Passing anything else turns every mention into a
   * facet with an empty did, which renders as plain text.
   */
  it("hands the authenticated agent to facet detection and returns what it found", async () => {
    const facet = {
      index: { byteStart: 0, byteEnd: 4 },
      features: [{ $type: "app.bsky.richtext.facet#link", uri: "https://example.com" }],
    };
    h.detectFacets.mockResolvedValue({ facets: [facet] });

    const result = await buildRichText("link");

    expect(h.detectFacets).toHaveBeenCalledTimes(1);
    expect(h.detectFacets.mock.calls[0][0]).toBeDefined();
    expect(result).toEqual({ text: "link", facets: [facet] });
  });

  it("wraps a facet-detection failure as a read of app.bsky.richtext.detectFacets", async () => {
    h.detectFacets.mockRejectedValue(new XRPCError(502, "UpstreamFailure", "appview down"));

    const err = (await buildRichText("hello").catch((e: unknown) => e)) as BlueskyError;

    expect(err).toBeInstanceOf(BlueskyError);
    expect(err.status).toBe(502);
    expect(err.message).toContain("GET app.bsky.richtext.detectFacets");
  });
});

describe("getPosts", () => {
  it("wraps a read failure as a GET on app.bsky.feed.getPosts", async () => {
    h.getPosts.mockRejectedValue(new XRPCError(400, "InvalidRequest", "bad uri"));

    const err = (await getPosts(["at://nope"]).catch((e: unknown) => e)) as BlueskyError;

    expect(err).toBeInstanceOf(BlueskyError);
    expect(err.message).toContain("GET app.bsky.feed.getPosts");
  });
});

/**
 * ⛔ searchPosts EXISTS TO STOP A SECOND LOGIN PATH. social-hq's listening
 * sweep used to POST createSession itself, once per bluesky-enabled rule per
 * sweep, spending the same ten-per-day budget publishing spends. That is what
 * caused the production 429 immediately after the direct cutover.
 */
describe("searchPosts", () => {
  it("reuses the publishing session rather than opening a second one", async () => {
    h.searchPosts.mockResolvedValue({ data: { posts: [] } });

    await getProfile("did:plc:x");
    await searchPosts("examplebrand");

    expect(h.login).toHaveBeenCalledTimes(1);
    // ⚠️ Must stay on bsky.social. public.api.bsky.app answers 403 to
    // searchPosts even with a valid session token, verified live against both
    // hosts, so the "public" appview is not an interchangeable substitute.
    expect(h.serviceUrls).toEqual(["https://bsky.social/"]);
  });

  it("returns the posts the vendor found, for the query given", async () => {
    const posts = [{ uri: "at://did:plc:a/app.bsky.feed.post/1", cid: "c1" }];
    h.searchPosts.mockResolvedValue({ data: { posts } });

    const result = await searchPosts("district ai");

    expect(h.searchPosts).toHaveBeenCalledWith({ q: "district ai", limit: 20 });
    expect(result).toBe(posts);
  });

  it("asks for 20 results when the caller does not choose a limit", async () => {
    h.searchPosts.mockResolvedValue({ data: { posts: [] } });

    await searchPosts("examplebrand");

    expect(h.searchPosts.mock.calls[0][0]).toMatchObject({ limit: 20 });
  });

  /**
   * ⚠️ Clamped HERE, not at the caller, so every consumer gets the same bound.
   * The vendor caps `limit` at 100 and rejects the whole call above it, so an
   * unclamped listening rule asking for 250 would return nothing at all rather
   * than the first 100.
   */
  it("clamps an over-large limit to the vendor's maximum of 100", async () => {
    h.searchPosts.mockResolvedValue({ data: { posts: [] } });

    await searchPosts("examplebrand", 250);

    expect(h.searchPosts).toHaveBeenCalledWith({ q: "examplebrand", limit: 100 });
  });

  it("leaves a smaller limit alone", async () => {
    h.searchPosts.mockResolvedValue({ data: { posts: [] } });

    await searchPosts("examplebrand", 5);

    expect(h.searchPosts).toHaveBeenCalledWith({ q: "examplebrand", limit: 5 });
  });

  it("wraps a search failure as a GET on app.bsky.feed.searchPosts", async () => {
    h.searchPosts.mockRejectedValue(new XRPCError(403, "Forbidden", "wrong host"));

    const err = (await searchPosts("examplebrand").catch((e: unknown) => e)) as BlueskyError;

    expect(err).toBeInstanceOf(BlueskyError);
    expect(err.status).toBe(403);
    expect(err.message).toContain("GET app.bsky.feed.searchPosts");
  });
});

describe("uploadBlob", () => {
  /**
   * ⛔ Must THROW, never resolve with a placeholder. bluesky-transport builds
   * the image embed straight out of what this returns, so a swallowed upload
   * failure would publish a post with an empty embed and report success.
   */
  it("wraps an upload failure as a POST on com.atproto.repo.uploadBlob", async () => {
    h.uploadBlob.mockRejectedValue(new XRPCError(413, "PayloadTooLarge", "blob too big"));

    const err = (await uploadBlob(new Uint8Array([1]), "image/png").catch(
      (e: unknown) => e,
    )) as BlueskyError;

    expect(err).toBeInstanceOf(BlueskyError);
    expect(err.status).toBe(413);
    expect(err.message).toContain("POST com.atproto.repo.uploadBlob");
  });
});

describe("deleteRecord", () => {
  it("names the deleteRecord call in the error so a failed unpublish is legible", async () => {
    h.deletePost.mockRejectedValue(new XRPCError(500, "InternalServerError", "boom"));

    const err = (await deleteRecord("at://x").catch((e: unknown) => e)) as BlueskyError;

    expect(err.message).toContain("POST com.atproto.repo.deleteRecord");
  });
});

describe("getProfile", () => {
  /**
   * ⛔ Refuse rather than guess. Calling getProfile with actor `undefined`
   * gets a lexicon validation error that reads like a broken request; this
   * message points at the real cause, which is that the login never completed.
   */
  it("refuses to look anything up when no actor is given and the session has no did", async () => {
    h.agentDid = undefined;

    const err = (await getProfile().catch((e: unknown) => e)) as BlueskyError;

    expect(err).toBeInstanceOf(BlueskyError);
    expect(err.status).toBe(0);
    expect(err.message).toContain("no actor given and the session has no did");
    expect(h.getProfile).not.toHaveBeenCalled();
  });

  it("wraps a profile read failure as a GET on app.bsky.actor.getProfile", async () => {
    h.getProfile.mockRejectedValue(new XRPCError(400, "InvalidRequest", "unknown actor"));

    const err = (await getProfile("did:plc:ghost").catch((e: unknown) => e)) as BlueskyError;

    expect(err).toBeInstanceOf(BlueskyError);
    expect(err.message).toContain("GET app.bsky.actor.getProfile");
  });

  it("passes the aggregate counts through when the appview supplies them", async () => {
    h.getProfile.mockResolvedValue({
      data: {
        did: "did:plc:test",
        handle: "example.com",
        displayName: "Acme",
        followersCount: 412,
        followsCount: 88,
        postsCount: 1301,
      },
    });

    await expect(getProfile()).resolves.toEqual({
      did: "did:plc:test",
      handle: "example.com",
      displayName: "Acme",
      followersCount: 412,
      followsCount: 88,
      postsCount: 1301,
    });
  });

  /**
   * ⛔ A count the appview has not finished aggregating is OPTIONAL in the
   * lexicon. It must stay undefined so a dashboard can render "unknown"; a
   * `?? 0` here would put a confident, wrong zero in front of an operator.
   */
  it("leaves a missing count undefined rather than turning it into a real zero", async () => {
    h.getProfile.mockResolvedValue({ data: { did: "did:plc:test", handle: "example.com" } });

    const profile = await getProfile();

    expect(profile.followersCount).toBeUndefined();
    expect(profile.postsCount).toBeUndefined();
    expect(profile.followersCount).not.toBe(0);
  });
});

describe("createPost embeds", () => {
  it("sends no embed at all when the post has an empty image list", async () => {
    h.post.mockResolvedValue({ uri: "at://did:plc:x/app.bsky.feed.post/a", cid: "c" });

    await createPost({ text: "text only", images: [] });

    // ⚠️ `embed: undefined`, not `{ images: [] }`. An empty images array is a
    // lexicon validation error, so an empty-media render would fail to post.
    expect(h.post.mock.calls[0][0].embed).toBeUndefined();
  });

  it("returns the vendor's StrongRef verbatim so a reply can reference it", async () => {
    const ref = { uri: "at://did:plc:x/app.bsky.feed.post/root", cid: "bafyreiroot" };
    h.post.mockResolvedValue(ref);
    const blob = { ref: "blob-1" } as unknown as BlobRef;

    await expect(createPost({ text: "hi", images: [{ blob, alt: "alt" }] })).resolves.toBe(ref);
  });
});

/**
 * The vendor caps `langs` at three BCP-47 tags and rejects the record outright
 * past that, so the client trims rather than trusting the render.
 */
describe("post langs", () => {
  it("sends at most three langs, in the caller's order", async () => {
    h.post.mockResolvedValue({ uri: "at://did:plc:x/app.bsky.feed.post/1", cid: "c1" });

    await createPost({ text: "bonjour", langs: ["fr-CA", "en", "fr", "de"] });

    expect(h.post).toHaveBeenCalledWith(expect.objectContaining({ langs: ["fr-CA", "en", "fr"] }));
  });
});

/**
 * ⛔ A STORED SESSION IS RESUMED ONLY FOR THE IDENTIFIER IT WAS CREATED FOR.
 * The store is one shared row, so after the operator switches the Bluesky
 * credential to another account, resuming the old row would publish as the
 * OLD account. Each saved session carries the hash of the identifier it was
 * created with; anything else is dropped and the configured account logs in
 * (fail closed). The session's handle, email and did are not consulted: the
 * PDS can leave the email out, which made that check fail open.
 */
describe("session ownership", () => {
  const ATP = { accessJwt: "a", refreshJwt: "r", handle: "example.com", did: "did:plc:test", active: true };

  it("hashes the identifier as createSession takes it: trimmed, no leading @, lowercased", () => {
    expect(blueskyIdentifierHash(" @Example.COM ")).toBe(CREDS_HASH);
    expect(CREDS_HASH).toMatch(/^[0-9a-f]{64}$/);
    expect(blueskyIdentifierHash("other.example")).not.toBe(CREDS_HASH);
  });

  it("resumes a stored session whose hash matches, with no createSession", async () => {
    const save = vi.fn(async () => {});
    setBlueskySessionStore({ load: async () => ({ ...ATP, identifierHash: CREDS_HASH }), save });
    await openSession();
    expect(h.resumeSession).toHaveBeenCalledWith(ATP);
    expect(h.login).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalledWith(null);
  });

  it.each([
    ["a row from before the hash existed", undefined],
    ["a hash for ANOTHER identifier", blueskyIdentifierHash("previous.bsky.social")],
  ])("drops %s and logs in exactly once as the configured account", async (_label, identifierHash) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const save = vi.fn(async () => {});
      setBlueskySessionStore({ load: async () => ({ ...ATP, identifierHash }), save });
      await openSession();
      expect(h.resumeSession).not.toHaveBeenCalled();
      expect(save).toHaveBeenCalledWith(null);
      expect(h.login).toHaveBeenCalledTimes(1);
      expect(h.login).toHaveBeenCalledWith(CREDS);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/not created for the configured identifier/));

      // The session the login creates is saved WITH the hash, so the next
      // cold start resumes it instead of logging in again.
      h.persistHandlers.at(-1)!("create", { ...ATP, accessJwt: "fresh" });
      await flushMicrotasks();
      expect(save).toHaveBeenLastCalledWith({ ...ATP, accessJwt: "fresh", identifierHash: CREDS_HASH });
    } finally {
      warn.mockRestore();
    }
  });

  it("still logs in when the dropped session cannot be cleared", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      setBlueskySessionStore({
        load: async () => ATP,
        save: (() => {
          throw new Error("sync store failure");
        }) as unknown as BlueskySessionStore["save"],
      });
      await expect(openSession()).resolves.toBeUndefined();
      expect(h.resumeSession).not.toHaveBeenCalled();
      expect(h.login).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
