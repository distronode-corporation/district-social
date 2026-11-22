import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";

/**
 * The XRPC client (bluesky-xrpc.ts) against a fake Bluesky at the FETCH level:
 * every test drives the real CredentialSession and Agent, and the only thing
 * replaced is the fetch they were built on. What is pinned here, because the
 * session store and the publish path above depend on it:
 *
 *   - which host each call goes to, and that the bearer token reaches only
 *     the entryway or a PDS the DID document named over public HTTPS;
 *   - the session events and when each fires;
 *   - the expired-token retry: only after a successful refresh, at most once,
 *     and never after a 5xx or a request that got no answer;
 *   - the error each failure becomes, and the schema check on every answer.
 */

// The DNS half of the PDS check is skipped under NODE_ENV=test, so a test can
// make the guard answer the way it does for a host that resolves privately.
const g = vi.hoisted(() => ({ refuse: undefined as string | undefined }));
vi.mock("../ssrf.js", async (importActual) => {
  const actual = await importActual<typeof import("../ssrf.js")>();
  return {
    ...actual,
    assertPublicHttpsUrl: vi.fn(async (raw: string) => {
      if (g.refuse && raw.includes(g.refuse)) {
        throw new Error(`SSRF guard: "${g.refuse}" resolves to private/reserved address 10.0.0.7`);
      }
      return actual.assertPublicHttpsUrl(raw);
    }),
  };
});

import { Agent, CredentialSession, XRPCError, type AtpSessionData, type AtpSessionEvent } from "../bluesky-xrpc.js";
import { ResponseShapeError } from "../http/shape.js";
import { getPostsOutput } from "../bluesky-schemas.js";
import { isUnknownOutcome } from "../retry.js";

const ENTRYWAY = "https://bsky.social";
const DID = "did:plc:testaccount000";

interface Seen {
  url: URL;
  method: string;
  authorization: string | null;
  contentType: string | null;
  body: unknown;
  redirect: RequestInit["redirect"];
}

type Route = (req: Seen) => Response | Promise<Response>;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function sessionBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    accessJwt: "access-1",
    refreshJwt: "refresh-1",
    handle: "example.com",
    did: DID,
    email: "owner@example.com",
    emailConfirmed: true,
    emailAuthFactor: false,
    active: true,
    ...over,
  };
}

function didDoc(endpoint: unknown, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: DID,
    service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: endpoint }],
    ...over,
  };
}

/**
 * A fake Bluesky: one route per XRPC method name, every request recorded. A 3xx
 * under `redirect: "error"` rejects the way undici does, so a followed redirect
 * would show up as a request to the redirect target, and never does.
 */
function fakeServer(routes: Record<string, Route>): { fetch: typeof fetch; seen: Seen[]; calls: (nsid: string) => Seen[] } {
  const seen: Seen[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const raw = init?.body;
    const req: Seen = {
      url,
      method: init?.method ?? "GET",
      authorization: headers.get("authorization"),
      contentType: headers.get("content-type"),
      body: raw instanceof Uint8Array ? raw : typeof raw === "string" ? (JSON.parse(raw) as unknown) : undefined,
      redirect: init?.redirect,
    };
    seen.push(req);
    const nsid = url.pathname.replace(/^\/xrpc\//, "");
    const route = routes[nsid];
    if (!route) return json({ error: "MethodNotImplemented", message: `no route for ${nsid}` }, 501);
    const res = await route(req);
    if (res.status >= 300 && res.status < 400 && init?.redirect === "error") {
      throw new TypeError("unexpected redirect");
    }
    return res;
  };
  return {
    fetch: impl as typeof fetch,
    seen,
    calls: (nsid) => seen.filter((r) => r.url.pathname === `/xrpc/${nsid}`),
  };
}

interface Opened {
  session: CredentialSession;
  agent: Agent;
  events: Array<[AtpSessionEvent, AtpSessionData | undefined]>;
}

function open(fetchImpl: typeof fetch): Opened {
  const events: Opened["events"] = [];
  const session = new CredentialSession(new URL(ENTRYWAY), fetchImpl, (evt, data) => {
    events.push([evt, data ? { ...data } : undefined]);
  });
  return { session, agent: new Agent(session), events };
}

const PROFILE = { did: DID, handle: "example.com" };

let warn: MockInstance<typeof console.warn>;

beforeEach(() => {
  g.refuse = undefined;
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

describe("XRPCError", () => {
  it("carries status, error name, message, lowercased headers and the cause", () => {
    const cause = new Error("root");
    const err = new XRPCError(429, "RateLimitExceeded", "slow down", { "retry-after": "60" }, { cause });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("XRPCError");
    expect([err.status, err.error, err.message, err.headers["retry-after"], err.cause]).toEqual([
      429,
      "RateLimitExceeded",
      "slow down",
      "60",
      cause,
    ]);
    expect(new XRPCError(500, "InternalServerError", "boom").headers).toEqual({});
  });
});

describe("login (com.atproto.server.createSession)", () => {
  it("posts the credential to the entryway with no bearer token, and holds the session it answers", async () => {
    const server = fakeServer({ "com.atproto.server.createSession": () => json(sessionBody({ status: "takendown" })) });
    const { session, events } = open(server.fetch);

    await session.login({ identifier: "example.com", password: "app-password" });

    const [req] = server.calls("com.atproto.server.createSession");
    expect(req!.url.origin).toBe(ENTRYWAY);
    expect(req!.method).toBe("POST");
    expect(req!.authorization).toBeNull();
    expect(req!.contentType).toBe("application/json");
    expect(req!.redirect).toBe("error");
    expect(req!.body).toEqual({ identifier: "example.com", password: "app-password" });
    const held: AtpSessionData = {
      accessJwt: "access-1",
      refreshJwt: "refresh-1",
      handle: "example.com",
      did: DID,
      email: "owner@example.com",
      emailConfirmed: true,
      emailAuthFactor: false,
      active: true,
      status: "takendown",
    };
    expect(session.session).toEqual(held);
    expect(session.hasSession).toBe(true);
    expect(session.did).toBe(DID);
    expect(events).toEqual([["create", held]]);
  });

  it("reads an answer with no `active` as an active account", async () => {
    const { active: _a, ...rest } = sessionBody();
    const server = fakeServer({ "com.atproto.server.createSession": () => json(rest) });
    const { session } = open(server.fetch);

    await session.login({ identifier: "example.com", password: "pw" });

    expect(session.session?.active).toBe(true);
  });

  it("fires create-failed and holds no session when the credential is refused", async () => {
    const server = fakeServer({
      "com.atproto.server.createSession": () =>
        json({ error: "AuthenticationRequired", message: "Invalid identifier or password" }, 401),
    });
    const { session, events } = open(server.fetch);

    const err = (await session.login({ identifier: "x", password: "y" }).catch((e: unknown) => e)) as XRPCError;

    expect(err).toBeInstanceOf(XRPCError);
    expect([err.status, err.error, err.message]).toEqual([401, "AuthenticationRequired", "Invalid identifier or password"]);
    expect(session.hasSession).toBe(false);
    expect(session.did).toBeUndefined();
    expect(events).toEqual([["create-failed", undefined]]);
  });

  it("refuses a session answer without tokens as a shape error, naming the field and never its value", async () => {
    const server = fakeServer({ "com.atproto.server.createSession": () => json(sessionBody({ accessJwt: 12345 })) });
    const { session, events } = open(server.fetch);

    const err = (await session.login({ identifier: "x", password: "y" }).catch((e: unknown) => e)) as ResponseShapeError;

    expect(err).toBeInstanceOf(ResponseShapeError);
    expect(err.message).toBe(
      "bluesky com.atproto.server.createSession: unexpected response shape at body.accessJwt: expected a string, got a number",
    );
    expect(err.message).not.toContain("12345");
    expect(events).toEqual([["create-failed", undefined]]);
  });
});

/**
 * ⛔ THE BEARER TOKEN GOES ONLY WHERE THE CLIENT CHOSE TO SEND IT. A session
 * answer's DID document names the account's PDS, and every data call carries
 * the access token there. The client follows it only to public HTTPS; for
 * anything else it stays on the entryway, which proxies to the right PDS.
 */
describe("the account's PDS, from the DID document", () => {
  function withDoc(doc: unknown): ReturnType<typeof fakeServer> {
    return fakeServer({
      "com.atproto.server.createSession": () => json(sessionBody({ didDoc: doc })),
      "app.bsky.actor.getProfile": () => json(PROFILE),
    });
  }

  /** Every host that saw the access token. */
  function tokenHosts(server: ReturnType<typeof fakeServer>): string[] {
    return [...new Set(server.seen.filter((r) => r.authorization === "Bearer access-1").map((r) => r.url.origin))];
  }

  it("sends data calls to a public HTTPS PDS, and nowhere else", async () => {
    const server = withDoc(didDoc("https://pds.example.net"));
    const { session, agent } = open(server.fetch);
    await session.login({ identifier: "x", password: "y" });

    await agent.getProfile(DID);

    expect(session.pdsUrl?.href).toBe("https://pds.example.net/");
    expect(server.calls("app.bsky.actor.getProfile")[0]!.url.origin).toBe("https://pds.example.net");
    expect(tokenHosts(server)).toEqual(["https://pds.example.net"]);
  });

  it("accepts the service id written in full (`did#atproto_pds`)", async () => {
    const doc = didDoc("https://pds.example.net");
    (doc.service as Array<{ id: string }>)[0]!.id = `${DID}#atproto_pds`;
    const { session } = open(withDoc(doc).fetch);

    await session.login({ identifier: "x", password: "y" });

    expect(session.pdsUrl?.origin).toBe("https://pds.example.net");
  });

  it.each([
    ["plain HTTP", "http://pds.example.net"],
    ["a private IPv4 literal", "https://10.0.0.5"],
    ["the cloud metadata address", "https://169.254.169.254"],
    ["loopback", "https://127.0.0.1:2583"],
    ["localhost", "https://localhost"],
    ["a private IPv6 literal", "https://[fd00::1]"],
    ["not a URL", "pds.example.net"],
  ])("never sends the token to %s: it stays on the entryway", async (_label, endpoint) => {
    const server = withDoc(didDoc(endpoint));
    const { session, agent } = open(server.fetch);
    await session.login({ identifier: "x", password: "y" });

    await agent.getProfile(DID);

    expect(session.pdsUrl).toBeUndefined();
    expect(tokenHosts(server)).toEqual([ENTRYWAY]);
    expect(String(warn.mock.calls[0]![0])).toMatch(/^\[bluesky\] not following the account's PDS endpoint \(.+\); using https:\/\/bsky\.social$/);
  });

  it("never sends the token to a PDS host that resolves to a private address", async () => {
    g.refuse = "pds.internal.example";
    const server = withDoc(didDoc("https://pds.internal.example"));
    const { session, agent } = open(server.fetch);
    await session.login({ identifier: "x", password: "y" });

    await agent.getProfile(DID);

    expect(session.pdsUrl).toBeUndefined();
    expect(tokenHosts(server)).toEqual([ENTRYWAY]);
    expect(String(warn.mock.calls[0]![0])).toContain("resolves to private/reserved address");
  });

  it.each([
    ["no DID document", undefined],
    ["a document that is not an object", "nonsense"],
    ["a document for another DID", didDoc("https://pds.example.net", { id: "did:plc:someoneelse" })],
    ["a service of another type", didDoc("https://pds.example.net", { service: [{ id: "#atproto_pds", type: "Other", serviceEndpoint: "https://pds.example.net" }] })],
    ["a service whose endpoint is not a string", didDoc({ uri: "https://pds.example.net" })],
    ["a document with no services", { id: DID }],
  ])("uses the entryway for %s", async (_label, doc) => {
    const server = withDoc(doc);
    const { session, agent } = open(server.fetch);
    await session.login({ identifier: "x", password: "y" });

    await agent.getProfile(DID);

    expect(session.pdsUrl).toBeUndefined();
    expect(session.dispatchUrl.href).toBe(`${ENTRYWAY}/`);
    expect(tokenHosts(server)).toEqual([ENTRYWAY]);
    expect(warn).not.toHaveBeenCalled();
  });

  /**
   * ⛔ A PDS that answers with a redirect toward an internal address is not
   * followed: every XRPC request is sent with `redirect: "error"`, so the
   * token never reaches the redirect target.
   */
  it("does not follow a redirect from the PDS: the call fails and the target never sees a request", async () => {
    const server = fakeServer({
      "com.atproto.server.createSession": () => json(sessionBody({ didDoc: didDoc("https://pds.example.net") })),
      "app.bsky.actor.getProfile": () =>
        new Response(null, { status: 307, headers: { location: "https://169.254.169.254/xrpc/app.bsky.actor.getProfile" } }),
    });
    const { session, agent } = open(server.fetch);
    await session.login({ identifier: "x", password: "y" });

    const err = (await agent.getProfile(DID).catch((e: unknown) => e)) as XRPCError;

    expect(err).toBeInstanceOf(XRPCError);
    expect([err.status, err.error, err.message]).toEqual([1, "Unknown", "unexpected redirect"]);
    expect(server.seen.every((r) => r.redirect === "error")).toBe(true);
    expect(server.seen.some((r) => r.url.hostname === "169.254.169.254")).toBe(false);
  });

  it("keeps session calls on the entryway after a PDS was accepted", async () => {
    const server = fakeServer({
      "com.atproto.server.createSession": () => json(sessionBody({ didDoc: didDoc("https://pds.example.net") })),
      "com.atproto.server.refreshSession": () =>
        json(sessionBody({ accessJwt: "access-2", refreshJwt: "refresh-2", didDoc: didDoc("https://pds.example.net") })),
    });
    const { session } = open(server.fetch);
    await session.login({ identifier: "x", password: "y" });

    await session.refreshSession();

    expect(server.calls("com.atproto.server.refreshSession")[0]!.url.origin).toBe(ENTRYWAY);
    expect(session.pdsUrl?.origin).toBe("https://pds.example.net");
  });
});

describe("resume and refresh (com.atproto.server.refreshSession)", () => {
  const STORED: AtpSessionData = {
    accessJwt: "access-old",
    refreshJwt: "refresh-old",
    handle: "example.com",
    did: DID,
    email: "owner@example.com",
    emailConfirmed: true,
    emailAuthFactor: false,
    active: true,
  };

  it("proves a stored session live with a refresh sent with the REFRESH token, and fires update", async () => {
    const server = fakeServer({
      "com.atproto.server.refreshSession": () =>
        json(sessionBody({ accessJwt: "access-2", refreshJwt: "refresh-2", handle: "renamed.example.com", didDoc: didDoc("https://pds.example.net") })),
    });
    const { session, events } = open(server.fetch);

    await session.resumeSession(STORED);

    const [req] = server.calls("com.atproto.server.refreshSession");
    expect(req!.authorization).toBe("Bearer refresh-old");
    expect(req!.url.origin).toBe(ENTRYWAY);
    expect(server.calls("com.atproto.server.getSession")).toHaveLength(0);
    const updated = { ...STORED, accessJwt: "access-2", refreshJwt: "refresh-2", handle: "renamed.example.com", status: undefined };
    expect(session.session).toEqual(updated);
    expect(events).toEqual([["update", updated]]);
    expect(session.pdsUrl?.origin).toBe("https://pds.example.net");
  });

  it("fills what the refresh left out from getSession, sent with the NEW access token", async () => {
    const server = fakeServer({
      "com.atproto.server.refreshSession": () =>
        json({ accessJwt: "access-2", refreshJwt: "refresh-2", handle: "example.com", did: DID }),
      "com.atproto.server.getSession": () =>
        json({ handle: "example.com", did: DID, email: "new@example.com", emailConfirmed: false, active: false, status: "deactivated", didDoc: didDoc("https://pds.example.net") }),
    });
    const { session } = open(server.fetch);

    await session.resumeSession(STORED);

    expect(server.calls("com.atproto.server.getSession")[0]!.authorization).toBe("Bearer access-2");
    expect(session.session).toMatchObject({ email: "new@example.com", emailConfirmed: false, active: false, status: "deactivated" });
    expect(session.pdsUrl?.origin).toBe("https://pds.example.net");
  });

  it.each([
    ["fails", () => json({ error: "InternalServerError" }, 500)],
    ["answers for another DID", () => json({ handle: "x", did: "did:plc:someoneelse", email: "other@example.com" })],
  ])("keeps the refresh's own values when getSession %s", async (_label, route) => {
    const server = fakeServer({
      "com.atproto.server.refreshSession": () =>
        json({ accessJwt: "access-2", refreshJwt: "refresh-2", handle: "example.com", did: DID }),
      "com.atproto.server.getSession": route,
    });
    const { session, events } = open(server.fetch);

    await session.resumeSession(STORED);

    expect(session.session).toEqual({ ...STORED, accessJwt: "access-2", refreshJwt: "refresh-2", status: undefined });
    expect(events.map(([e]) => e)).toEqual(["update"]);
  });

  it("does not replace a held session that has the same refresh token, and still rotates its tokens", async () => {
    const { email: _e, ...noEmail } = sessionBody({
      accessJwt: "access-2",
      refreshJwt: "refresh-2",
      didDoc: didDoc("https://pds.example.net"),
    });
    const server = fakeServer({
      "com.atproto.server.createSession": () => json(sessionBody({ refreshJwt: "refresh-old" })),
      "com.atproto.server.refreshSession": () => json(noEmail),
    });
    const { session } = open(server.fetch);
    await session.login({ identifier: "x", password: "y" });

    await session.resumeSession({ ...STORED, email: "candidate@example.com" });

    expect(server.calls("com.atproto.server.getSession")).toHaveLength(0);
    expect(session.session).toMatchObject({ email: "owner@example.com", accessJwt: "access-2", refreshJwt: "refresh-2" });
  });

  it("refuses a resume whose DID differs from the session held for that refresh token", async () => {
    const server = fakeServer({
      "com.atproto.server.createSession": () => json(sessionBody({ refreshJwt: "refresh-old" })),
      "com.atproto.server.refreshSession": () => json(sessionBody({ accessJwt: "access-2", refreshJwt: "refresh-2" })),
    });
    const { session } = open(server.fetch);
    await session.login({ identifier: "x", password: "y" });

    await expect(session.resumeSession({ ...STORED, did: "did:plc:someoneelse" })).rejects.toThrow("DID mismatch on resumeSession");
  });

  it.each([
    ["a 401", () => json({ error: "AuthenticationRequired", message: "nope" }, 401)],
    ["ExpiredToken", () => json({ error: "ExpiredToken", message: "Token has expired" }, 400)],
    ["InvalidToken", () => json({ error: "InvalidToken", message: "Token could not be verified" }, 400)],
    ["an answer for another DID", () => json(sessionBody({ did: "did:plc:someoneelse" }))],
    ["an answer it cannot read", () => json({ accessJwt: "only" })],
    ["a 2xx that is not JSON", () => new Response("<html>ok</html>")],
  ])("ends the session and fires expired when the refresh is refused: %s", async (_label, route) => {
    const server = fakeServer({ "com.atproto.server.refreshSession": route });
    const { session, events } = open(server.fetch);

    const err = await session.resumeSession(STORED).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(session.hasSession).toBe(false);
    expect(events).toEqual([["expired", undefined]]);
  });

  it.each([
    ["a 5xx", () => json({ error: "UpstreamFailure", message: "bad gateway" }, 502)],
    ["a rate limit", () => json({ error: "RateLimitExceeded" }, 429)],
    ["no answer", () => Promise.reject(new TypeError("fetch failed"))],
  ])("keeps the session and fires network-error when the refresh fails on %s", async (_label, route) => {
    const server = fakeServer({ "com.atproto.server.refreshSession": route });
    const { session, events } = open(server.fetch);

    await expect(session.resumeSession(STORED)).rejects.toBeInstanceOf(Error);

    expect(session.session).toEqual(STORED);
    expect(events).toEqual([["network-error", STORED]]);
  });

  it("shares one refresh between concurrent callers", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const server = fakeServer({
      "com.atproto.server.refreshSession": async () => {
        await gate;
        return json(sessionBody({ accessJwt: "access-2", refreshJwt: "refresh-2" }));
      },
    });
    const { session } = open(server.fetch);
    session.session = { ...STORED };

    const both = Promise.all([session.refreshSession(), session.refreshSession()]);
    release();
    await both;

    expect(server.calls("com.atproto.server.refreshSession")).toHaveLength(1);
  });

  it("refuses to refresh with no session", async () => {
    const { session } = open(fakeServer({}).fetch);
    await expect(session.refreshSession()).rejects.toThrow("Unexpected state: no session to refresh");
  });

  /**
   * A second resume that lands while the first one's refresh is in flight wins:
   * the first refresh must not overwrite the session the second one installed,
   * and fires nothing.
   */
  it("drops a refresh whose session was replaced while it was in flight", async () => {
    const gates: Array<() => void> = [];
    const server = fakeServer({
      "com.atproto.server.refreshSession": async (req) => {
        await new Promise<void>((resolve) => gates.push(resolve));
        return req.authorization === "Bearer refresh-old"
          ? json(sessionBody({ accessJwt: "access-A", refreshJwt: "refresh-A" }))
          : json(sessionBody({ accessJwt: "access-B", refreshJwt: "refresh-B" }));
      },
    });
    const { session, events } = open(server.fetch);

    const first = session.resumeSession(STORED);
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    const second = session.resumeSession({ ...STORED, refreshJwt: "refresh-other" });
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    gates[0]!();
    await expect(first).rejects.toThrow("Concurrent session update detected");
    gates[1]!();
    await second;

    expect(session.session?.accessJwt).toBe("access-B");
    expect(events.map(([e]) => e)).toEqual(["update"]);
  });
});

describe("an authenticated call", () => {
  /** A logged-in session against `routes`, plus the session routes. */
  async function loggedIn(routes: Record<string, Route>, refresh?: Route): Promise<Opened & { server: ReturnType<typeof fakeServer> }> {
    const server = fakeServer({
      "com.atproto.server.createSession": () => json(sessionBody()),
      "com.atproto.server.refreshSession": refresh ?? (() => json(sessionBody({ accessJwt: "access-2", refreshJwt: "refresh-2" }))),
      ...routes,
    });
    const opened = open(server.fetch);
    await opened.session.login({ identifier: "x", password: "y" });
    return { ...opened, server };
  }

  it("carries the access token, and encodes query parameters (arrays repeated, undefined left out)", async () => {
    const { session, server } = await loggedIn({ "app.bsky.feed.getPosts": () => json({ posts: [] }) });

    await session.call("app.bsky.feed.getPosts", { method: "GET", params: { uris: ["at://a", "at://b"], limit: 5, cursor: undefined } }, getPostsOutput);

    const [req] = server.calls("app.bsky.feed.getPosts");
    expect(req!.authorization).toBe("Bearer access-1");
    expect(req!.url.searchParams.getAll("uris")).toEqual(["at://a", "at://b"]);
    expect(req!.url.searchParams.get("limit")).toBe("5");
    expect(req!.url.searchParams.has("cursor")).toBe(false);
    expect(req!.body).toBeUndefined();
    expect(req!.contentType).toBeNull();
  });

  it("sends no token before a session exists", async () => {
    const server = fakeServer({ "com.atproto.identity.resolveHandle": () => json({ did: DID }) });
    const { agent } = open(server.fetch);

    await expect(agent.resolveHandle("example.com")).resolves.toBe(DID);
    expect(server.seen[0]!.authorization).toBeNull();
  });

  describe("an expired access token", () => {
    it.each([
      ["a 401", json({ error: "AuthenticationRequired" }, 401)],
      ["a 400 ExpiredToken", json({ error: "ExpiredToken", message: "Token has expired" }, 400)],
    ])("is refreshed, and the request sent once more with the new token, on %s", async (_label, first) => {
      let n = 0;
      const { agent, server, events } = await loggedIn({
        "app.bsky.actor.getProfile": () => (n++ === 0 ? first.clone() : json(PROFILE)),
      });

      await expect(agent.getProfile(DID)).resolves.toEqual(PROFILE);

      expect(server.calls("app.bsky.actor.getProfile").map((r) => r.authorization)).toEqual(["Bearer access-1", "Bearer access-2"]);
      expect(server.calls("com.atproto.server.refreshSession")).toHaveLength(1);
      expect(events.map(([e]) => e)).toEqual(["create", "update"]);
    });

    it("is retried at most ONCE: a second expiry is the answer", async () => {
      const { agent, server } = await loggedIn({
        "app.bsky.actor.getProfile": () => json({ error: "ExpiredToken", message: "still expired" }, 400),
      });

      const err = (await agent.getProfile(DID).catch((e: unknown) => e)) as XRPCError;

      expect([err.status, err.error]).toEqual([400, "ExpiredToken"]);
      expect(server.calls("app.bsky.actor.getProfile")).toHaveLength(2);
      expect(server.calls("com.atproto.server.refreshSession")).toHaveLength(1);
    });

    it("is NOT retried when the refresh fails: the first answer stands", async () => {
      const { agent, server } = await loggedIn(
        { "app.bsky.actor.getProfile": () => json({ error: "AuthenticationRequired", message: "first" }, 401) },
        () => json({ error: "InternalServerError" }, 500),
      );

      const err = (await agent.getProfile(DID).catch((e: unknown) => e)) as XRPCError;

      expect([err.status, err.message]).toEqual([401, "first"]);
      expect(server.calls("app.bsky.actor.getProfile")).toHaveLength(1);
    });

    it("is NOT retried when the refresh answers the same token", async () => {
      const { agent, server } = await loggedIn(
        { "app.bsky.actor.getProfile": () => json({ error: "AuthenticationRequired" }, 401) },
        () => json(sessionBody()),
      );

      await expect(agent.getProfile(DID)).rejects.toBeInstanceOf(XRPCError);
      expect(server.calls("app.bsky.actor.getProfile")).toHaveLength(1);
    });

    it("is NOT retried when the refresh ended the session", async () => {
      const { agent, server, session } = await loggedIn(
        { "app.bsky.actor.getProfile": () => json({ error: "AuthenticationRequired" }, 401) },
        () => json({ error: "ExpiredToken" }, 400),
      );

      await expect(agent.getProfile(DID)).rejects.toBeInstanceOf(XRPCError);
      expect(session.hasSession).toBe(false);
      expect(server.calls("app.bsky.actor.getProfile")).toHaveLength(1);
    });

    it("is not an expiry when a 400 names another error, or carries no JSON", async () => {
      const { agent, server } = await loggedIn({
        "app.bsky.actor.getProfile": () => new Response("<html>bad request</html>", { status: 400 }),
        "app.bsky.feed.getPosts": () => json({ error: "InvalidRequest", message: "bad uri" }, 400),
      });

      await expect(agent.getProfile(DID)).rejects.toMatchObject({ status: 400, error: "InvalidRequest", message: "HTTP 400" });
      await expect(agent.getPosts(["nope"])).rejects.toMatchObject({ status: 400, error: "InvalidRequest", message: "bad uri" });
      expect(server.calls("com.atproto.server.refreshSession")).toHaveLength(0);
    });
  });

  /**
   * ⛔ A CREATE IS NEVER SENT TWICE. A 5xx, or a request that got no answer,
   * may have been performed: the client returns it as it is, with no refresh
   * and no second request, and the caller decides.
   */
  describe("a create that fails without a decision", () => {
    it.each([
      ["a 500", () => json({ error: "InternalServerError", message: "boom" }, 500)],
      ["a 502", () => json({ error: "UpstreamFailure" }, 502)],
      ["a 503", () => new Response("", { status: 503 })],
      ["a timeout", () => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"))],
      ["a dropped connection", () => Promise.reject(new TypeError("fetch failed"))],
    ])("is sent once on %s, for createRecord and for uploadBlob", async (_label, route) => {
      const { agent, server } = await loggedIn({
        "com.atproto.repo.createRecord": route,
        "com.atproto.repo.uploadBlob": route,
      });

      await expect(agent.post({ text: "hello" })).rejects.toBeInstanceOf(XRPCError);
      await expect(agent.uploadBlob(new Uint8Array([1]), "image/png")).rejects.toBeInstanceOf(XRPCError);

      expect(server.calls("com.atproto.repo.createRecord")).toHaveLength(1);
      expect(server.calls("com.atproto.repo.uploadBlob")).toHaveLength(1);
      expect(server.calls("com.atproto.server.refreshSession")).toHaveLength(0);
    });

    it("reports no answer as status 1 with the cause's message and the cause kept", async () => {
      const cause = new TypeError("fetch failed");
      const { agent } = await loggedIn({ "com.atproto.repo.createRecord": () => Promise.reject(cause) });

      const err = (await agent.post({ text: "x" }).catch((e: unknown) => e)) as XRPCError;

      expect([err.status, err.error, err.message, err.cause]).toEqual([1, "Unknown", "fetch failed", cause]);
    });
  });

  it("waits for a refresh already in flight, then sends the new token", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { session, agent, server } = await loggedIn(
      { "app.bsky.actor.getProfile": () => json(PROFILE) },
      async () => {
        await gate;
        return json(sessionBody({ accessJwt: "access-2", refreshJwt: "refresh-2" }));
      },
    );

    const refreshing = session.refreshSession();
    const reading = agent.getProfile(DID);
    release();
    await Promise.all([refreshing, reading]);

    expect(server.calls("app.bsky.actor.getProfile")[0]!.authorization).toBe("Bearer access-2");
  });

  it("still sends, after the failed refresh it waited for, with the token it still holds", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    // Set when the refresh is answered: the read must go out after it.
    let refreshSettled = false;
    let settledAtRead: boolean | undefined;
    const { session, agent, server } = await loggedIn(
      {
        "app.bsky.actor.getProfile": () => {
          settledAtRead = refreshSettled;
          return json(PROFILE);
        },
      },
      async () => {
        await gate;
        refreshSettled = true;
        return json({ error: "InternalServerError" }, 500);
      },
    );

    const refreshing = session.refreshSession().catch(() => "failed");
    const reading = agent.getProfile(DID);
    release();

    await expect(refreshing).resolves.toBe("failed");
    await expect(reading).resolves.toEqual(PROFILE);
    expect(settledAtRead).toBe(true);
    expect(server.calls("app.bsky.actor.getProfile").map((r) => r.authorization)).toEqual(["Bearer access-1"]);
  });

  describe("an error answer", () => {
    it.each([
      [401, "AuthenticationRequired"],
      [403, "Forbidden"],
      [404, "XRPCNotSupported"],
      [413, "PayloadTooLarge"],
      [429, "RateLimitExceeded"],
      [500, "InternalServerError"],
      [501, "MethodNotImplemented"],
      [502, "UpstreamFailure"],
      [503, "NotEnoughResources"],
      [504, "UpstreamTimeout"],
      [418, "Unknown"],
      [408, "Unknown"],
    ])("with no error body keeps HTTP %i, named %s", async (status, name) => {
      const server = fakeServer({ "com.atproto.identity.resolveHandle": () => new Response("", { status }) });
      const { agent } = open(server.fetch);

      const err = (await agent.resolveHandle("x").catch((e: unknown) => e)) as XRPCError;

      expect([err.status, err.error, err.message]).toEqual([status, name, `HTTP ${status}`]);
    });

    it("keeps the headers, lowercased, so Retry-After survives", async () => {
      const server = fakeServer({
        "com.atproto.identity.resolveHandle": () => json({ error: "RateLimitExceeded", message: "slow down" }, 429, { "Retry-After": "3600" }),
      });
      const { agent } = open(server.fetch);

      const err = (await agent.resolveHandle("x").catch((e: unknown) => e)) as XRPCError;

      expect(err.headers["retry-after"]).toBe("3600");
      expect(err.message).toBe("slow down");
    });

    it("ignores an error body whose fields are not strings", async () => {
      const server = fakeServer({ "com.atproto.identity.resolveHandle": () => json({ error: 7, message: ["x"] }, 400) });
      const { agent } = open(server.fetch);

      await expect(agent.resolveHandle("x")).rejects.toMatchObject({ status: 400, error: "InvalidRequest", message: "HTTP 400" });
    });
  });

  it("refuses a 2xx answer that is not JSON as a shape error, which retry.ts counts as an unknown outcome", async () => {
    const { agent } = await loggedIn({ "com.atproto.repo.createRecord": () => new Response("<html>ok</html>") });

    const err = await agent.post({ text: "x" }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ResponseShapeError);
    expect((err as Error).message).toBe(
      "bluesky com.atproto.repo.createRecord: unexpected response shape at body: expected JSON, got a body that is not JSON",
    );
    expect(isUnknownOutcome(err)).toBe(true);
  });
});

describe("the Agent's methods", () => {
  async function agentFor(routes: Record<string, Route>): Promise<{ agent: Agent; server: ReturnType<typeof fakeServer> }> {
    const server = fakeServer({ "com.atproto.server.createSession": () => json(sessionBody()), ...routes });
    const { session, agent } = open(server.fetch);
    await session.login({ identifier: "x", password: "y" });
    return { agent, server };
  }

  const POST_VIEW = {
    uri: `at://${DID}/app.bsky.feed.post/1`,
    cid: "bafy1",
    author: { did: DID, handle: "example.com" },
    record: { $type: "app.bsky.feed.post", text: "hi" },
    indexedAt: "2026-11-22T00:00:00.000Z",
    likeCount: 3,
    embed: { $type: "app.bsky.embed.images#view", images: [] },
    viewer: { like: "at://x" },
  };

  it("reads its did from the session", async () => {
    const { agent } = await agentFor({});
    expect(agent.did).toBe(DID);
  });

  it("post: creates an app.bsky.feed.post record in the account's repo, stamped now, and answers its strong ref", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-22T10:00:00.000Z"));
    try {
      const { agent, server } = await agentFor({
        "com.atproto.repo.createRecord": () => json({ uri: `at://${DID}/app.bsky.feed.post/3k`, cid: "bafyrec", commit: { cid: "c", rev: "r" }, validationStatus: "valid" }),
      });
      const blob = { $type: "blob" as const, ref: { $link: "bafyblob" }, mimeType: "image/png", size: 10 };
      const ref = { uri: `at://${DID}/app.bsky.feed.post/root`, cid: "bafyroot" };

      const out = await agent.post({
        text: "hello",
        facets: [{ index: { byteStart: 0, byteEnd: 5 }, features: [{ $type: "app.bsky.richtext.facet#tag", tag: "x" }] }],
        embed: { $type: "app.bsky.embed.images", images: [{ image: blob, alt: "alt" }] },
        reply: { root: ref, parent: ref },
        langs: ["en"],
      });

      expect(out).toEqual({ uri: `at://${DID}/app.bsky.feed.post/3k`, cid: "bafyrec" });
      const [req] = server.calls("com.atproto.repo.createRecord");
      expect(req!.method).toBe("POST");
      expect(req!.body).toEqual({
        repo: DID,
        collection: "app.bsky.feed.post",
        record: {
          $type: "app.bsky.feed.post",
          text: "hello",
          facets: [{ index: { byteStart: 0, byteEnd: 5 }, features: [{ $type: "app.bsky.richtext.facet#tag", tag: "x" }] }],
          embed: { $type: "app.bsky.embed.images", images: [{ image: blob, alt: "alt" }] },
          reply: { root: ref, parent: ref },
          langs: ["en"],
          createdAt: "2026-11-22T10:00:00.000Z",
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("post: refuses before any request when the session has ended", async () => {
    const server = fakeServer({});
    const agent = new Agent(new CredentialSession(new URL(ENTRYWAY), server.fetch));

    await expect(agent.post({ text: "x" })).rejects.toThrow("Not logged in");
    expect(server.seen).toHaveLength(0);
  });

  it.each([
    ["a uri that is not at://", { uri: "https://example.com/p", cid: "c" }, "body.uri", "a value of the documented format", "a string"],
    ["an empty cid", { uri: `at://${DID}/app.bsky.feed.post/1`, cid: "" }, "body.cid", "a non-empty string", "an empty string"],
    ["no cid", { uri: `at://${DID}/app.bsky.feed.post/1` }, "body.cid", "a string", "missing"],
  ])("post: refuses an answer with %s", async (_label, body, path, expected, got) => {
    const { agent } = await agentFor({ "com.atproto.repo.createRecord": () => json(body) });

    await expect(agent.post({ text: "x" })).rejects.toThrow(
      `bluesky com.atproto.repo.createRecord: unexpected response shape at ${path}: expected ${expected}, got ${got}`,
    );
  });

  it("deletePost: deletes the record the at:// URI names, from the repo it names", async () => {
    const { agent, server } = await agentFor({ "com.atproto.repo.deleteRecord": () => json({ commit: { cid: "c", rev: "r" } }) });

    await agent.deletePost("at://did:plc:other/app.bsky.feed.post/3kabc");

    expect(server.calls("com.atproto.repo.deleteRecord")[0]!.body).toEqual({
      repo: "did:plc:other",
      collection: "app.bsky.feed.post",
      rkey: "3kabc",
    });
  });

  it("deletePost: accepts an empty answer, which the lexicon allows", async () => {
    const { agent } = await agentFor({ "com.atproto.repo.deleteRecord": () => new Response("") });
    await expect(agent.deletePost(`at://${DID}/app.bsky.feed.post/1`)).resolves.toBeUndefined();
  });

  it("deletePost: refuses a URI that names no record, before any request", async () => {
    const { agent, server } = await agentFor({});
    await expect(agent.deletePost("at://x")).rejects.toThrow("Not a post URI: at://x");
    expect(server.calls("com.atproto.repo.deleteRecord")).toHaveLength(0);
  });

  it("uploadBlob: sends the bytes as the body with their MIME type, and answers the blob ref", async () => {
    const blob = { $type: "blob", ref: { $link: "bafyblob" }, mimeType: "image/png", size: 3 };
    const { agent, server } = await agentFor({ "com.atproto.repo.uploadBlob": () => json({ blob }) });

    await expect(agent.uploadBlob(new Uint8Array([1, 2, 3]), "image/png")).resolves.toEqual(blob);

    const [req] = server.calls("com.atproto.repo.uploadBlob");
    expect(req!.contentType).toBe("image/png");
    expect(req!.body).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("uploadBlob: refuses a blob ref of the wrong type", async () => {
    const { agent } = await agentFor({
      "com.atproto.repo.uploadBlob": () => json({ blob: { $type: "link", ref: { $link: "x" }, mimeType: "image/png", size: 1 } }),
    });
    await expect(agent.uploadBlob(new Uint8Array([1]), "image/png")).rejects.toThrow(
      'unexpected response shape at body.blob.$type: expected one of "blob", got a string',
    );
  });

  it("getPosts: asks for each URI and answers the post views, unknown fields kept", async () => {
    const { agent, server } = await agentFor({ "app.bsky.feed.getPosts": () => json({ posts: [POST_VIEW] }) });

    await expect(agent.getPosts(["at://a", "at://b"])).resolves.toEqual([POST_VIEW]);
    expect(server.calls("app.bsky.feed.getPosts")[0]!.url.searchParams.getAll("uris")).toEqual(["at://a", "at://b"]);
  });

  it("getPosts: refuses a post view with a count that is not a number", async () => {
    const { agent } = await agentFor({ "app.bsky.feed.getPosts": () => json({ posts: [POST_VIEW, { ...POST_VIEW, likeCount: "3" }] }) });
    await expect(agent.getPosts(["at://a"])).rejects.toThrow(
      "bluesky app.bsky.feed.getPosts: unexpected response shape at body.posts[1].likeCount: expected a number, got a string",
    );
  });

  it("getPosts: refuses an answer with no posts array", async () => {
    const { agent } = await agentFor({ "app.bsky.feed.getPosts": () => json({ posts: { 0: POST_VIEW } }) });
    await expect(agent.getPosts(["at://a"])).rejects.toThrow("at body.posts: expected an array, got an object");
  });

  it("searchPosts: sends the query and limit and answers the posts", async () => {
    const { agent, server } = await agentFor({ "app.bsky.feed.searchPosts": () => json({ posts: [POST_VIEW], cursor: "1", hitsTotal: 1 }) });

    await expect(agent.searchPosts({ q: "district", limit: 20 })).resolves.toEqual([POST_VIEW]);
    const [req] = server.calls("app.bsky.feed.searchPosts");
    expect([req!.url.searchParams.get("q"), req!.url.searchParams.get("limit")]).toEqual(["district", "20"]);
  });

  it("searchPosts: refuses a post whose author has no handle", async () => {
    const { agent } = await agentFor({
      "app.bsky.feed.searchPosts": () => json({ posts: [{ ...POST_VIEW, author: { did: DID } }] }),
    });
    await expect(agent.searchPosts({ q: "x", limit: 1 })).rejects.toThrow("at body.posts[0].author.handle: expected a string, got missing");
  });

  it("getProfile: answers the profile, counts optional", async () => {
    const { agent, server } = await agentFor({ "app.bsky.actor.getProfile": () => json({ ...PROFILE, followersCount: 4 }) });

    await expect(agent.getProfile("example.com")).resolves.toEqual({ ...PROFILE, followersCount: 4 });
    expect(server.calls("app.bsky.actor.getProfile")[0]!.url.searchParams.get("actor")).toBe("example.com");
  });

  it("getProfile: refuses a did that is not a DID", async () => {
    const { agent } = await agentFor({ "app.bsky.actor.getProfile": () => json({ did: "plc:x", handle: "h" }) });
    await expect(agent.getProfile("x")).rejects.toThrow("at body.did: expected a value of the documented format, got a string");
  });

  it("listRecords: sends repo, collection and limit, and answers records and cursor", async () => {
    const records = [{ uri: `at://${DID}/app.bsky.feed.post/1`, cid: "c", value: { text: "hi" } }];
    const { agent, server } = await agentFor({ "com.atproto.repo.listRecords": () => json({ records, cursor: "next" }) });

    await expect(agent.listRecords({ repo: DID, collection: "app.bsky.feed.post", limit: 25 })).resolves.toEqual({ records, cursor: "next" });
    const params = server.calls("com.atproto.repo.listRecords")[0]!.url.searchParams;
    expect([params.get("repo"), params.get("collection"), params.get("limit")]).toEqual([DID, "app.bsky.feed.post", "25"]);
  });

  it("listRecords: refuses a record whose value is not an object", async () => {
    const { agent } = await agentFor({
      "com.atproto.repo.listRecords": () => json({ records: [{ uri: `at://${DID}/app.bsky.feed.post/1`, cid: "c", value: "text" }] }),
    });
    await expect(agent.listRecords({ repo: DID, collection: "c", limit: 1 })).rejects.toThrow(
      "at body.records[0].value: expected a record, got a string",
    );
  });

  it("resolveHandle: refuses an answer with no did", async () => {
    const { agent } = await agentFor({ "com.atproto.identity.resolveHandle": () => json({}) });
    await expect(agent.resolveHandle("x")).rejects.toThrow("at body.did: expected a string, got missing");
  });
});
