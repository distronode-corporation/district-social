/**
 * scripts/social/api.ts: the CLI's keyless client for a Social HQ agent API.
 * fetch and google-auth-library are stubbed; nothing leaves the process.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const g = vi.hoisted(() => ({
  fetchIdToken: vi.fn(async () => "adc-id-token"),
  getIdTokenClient: vi.fn(),
}));
vi.mock("google-auth-library", () => ({
  GoogleAuth: class {
    getIdTokenClient = g.getIdTokenClient;
  },
}));

import { ApiError, configuredOrigin, createApiClient, pinnedBaseUrl } from "../api.js";

const ORIGIN = "https://social.example.com";
const AUDIENCE = "https://social.example.com/api/internal/social";
const BASE = { baseUrl: ORIGIN, audience: AUDIENCE };

function reply(status: number, body: string) {
  return { ok: status >= 200 && status < 300, status, text: async () => body } as Response;
}

let fetchImpl: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  g.getIdTokenClient.mockResolvedValue({ idTokenProvider: { fetchIdToken: g.fetchIdToken } });
  fetchImpl = vi.fn(async () => reply(200, '{"ok":true}'));
});
afterEach(() => vi.unstubAllEnvs());

describe("createApiClient", () => {
  it("talks to the configured origin, mints the ADC ID token for the configured audience once, and sends JSON", async () => {
    const client = createApiClient({ ...BASE, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(client.baseUrl).toBe(ORIGIN);
    expect(await client.request("POST", "/drafts", { text: "t" })).toEqual({ ok: true });
    await client.request("GET", "/accounts");
    expect(g.getIdTokenClient).toHaveBeenCalledTimes(1);
    expect(g.getIdTokenClient).toHaveBeenCalledWith(AUDIENCE);
    expect(g.fetchIdToken).toHaveBeenCalledWith(AUDIENCE);
    expect(fetchImpl).toHaveBeenNthCalledWith(1, `${ORIGIN}/api/internal/social/drafts`, {
      method: "POST",
      headers: { authorization: "Bearer adc-id-token", "content-type": "application/json" },
      body: '{"text":"t"}',
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(2, `${ORIGIN}/api/internal/social/accounts`, {
      method: "GET",
      headers: { authorization: "Bearer adc-id-token" },
      body: undefined,
    });
  });

  it("drops trailing slashes from the configured origin and accepts a requested origin equal to it", () => {
    expect(createApiClient({ ...BASE, baseUrl: `${ORIGIN}//` }).baseUrl).toBe(ORIGIN);
    expect(createApiClient({ ...BASE, requestedBaseUrl: `${ORIGIN}/` }).baseUrl).toBe(ORIGIN);
  });

  it.each([
    [{ audience: AUDIENCE }, "no agent API origin configured: set api.baseUrl in config.json, or SOCIAL_API_BASE_URL"],
    [{ baseUrl: "", audience: AUDIENCE }, "no agent API origin configured"],
    [{ baseUrl: ORIGIN }, "no ID token audience configured: set api.audience in config.json, or SOCIAL_API_AUDIENCE"],
    [{ baseUrl: ORIGIN, audience: "" }, "no ID token audience configured"],
  ])("refuses a missing origin or audience in one line, before minting a token: %o", (opts, message) => {
    const idToken = vi.fn(async () => "t");
    expect(() => createApiClient({ ...opts, idToken })).toThrow(message);
    expect(idToken).not.toHaveBeenCalled();
  });

  it("sends a form as multipart, leaving its content type to fetch", async () => {
    const client = createApiClient({ ...BASE, fetchImpl: fetchImpl as unknown as typeof fetch, idToken: async () => "t" });
    const form = new FormData();
    await client.request("POST", "/media", form);
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect(init.body).toBe(form);
    expect(init.headers).toEqual({ authorization: "Bearer t" });
  });

  it("answers null for an empty body", async () => {
    fetchImpl.mockResolvedValue(reply(200, ""));
    const client = createApiClient({ ...BASE, fetchImpl: fetchImpl as unknown as typeof fetch, idToken: async () => "t" });
    expect(await client.request("GET", "/accounts")).toBeNull();
  });

  it("throws the API's own sentence on a refusal", async () => {
    fetchImpl.mockResolvedValue(reply(409, '{"error":"This draft changed after the renders were approved"}'));
    const client = createApiClient({ ...BASE, fetchImpl: fetchImpl as unknown as typeof fetch, idToken: async () => "t" });
    const err = await client.request("POST", "/drafts/x/publish", {}).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, message: "HTTP 409: This draft changed after the renders were approved" });
  });

  it("keeps a non-JSON refusal (an edge page) as text in the message", async () => {
    fetchImpl.mockResolvedValue(reply(502, "<html>Bad gateway</html>"));
    const client = createApiClient({ ...BASE, fetchImpl: fetchImpl as unknown as typeof fetch, idToken: async () => "t" });
    await expect(client.request("GET", "/accounts")).rejects.toThrow('HTTP 502: "<html>Bad gateway</html>"');
  });

  it("uses the global fetch when none is given", async () => {
    vi.stubGlobal("fetch", fetchImpl);
    try {
      await createApiClient({ ...BASE, idToken: async () => "t" }).request("GET", "/accounts");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("configuredOrigin: the configured origin must be a bare https origin", () => {
  it.each([
    "http://social.example.com",
    "https://social.example.com/api",
    "https://social.example.com?x=1",
    "https://social.example.com#x",
    "https://x@social.example.com",
    "https://Social.Example.com",
    "https://social.example.com:443",
    "not a url",
    "ftp://social.example.com",
  ])("refuses %s, before minting a token", (url) => {
    expect(() => configuredOrigin(url)).toThrow(`refusing configured API base URL "${url}": it must be a bare https origin`);
    const idToken = vi.fn(async () => "t");
    expect(() => createApiClient({ baseUrl: url, audience: AUDIENCE, idToken })).toThrow(/refusing configured/);
    expect(idToken).not.toHaveBeenCalled();
  });

  it("keeps an https origin with a port, and a local server under NODE_ENV=test only", () => {
    expect(configuredOrigin("https://social.example.com:8443/")).toBe("https://social.example.com:8443");
    vi.stubEnv("NODE_ENV", "test");
    expect(configuredOrigin("http://localhost:3000/")).toBe("http://localhost:3000");
    vi.stubEnv("NODE_ENV", "production");
    expect(() => configuredOrigin("http://localhost:3000")).toThrow(/refusing configured/);
  });
});

describe("pinnedBaseUrl: ⛔ the ID token goes to the configured origin only", () => {
  it.each([
    "https://staging.example",
    "https://evil.com",
    "http://social.example.com",
    "https://example.com",
    "https://api.social.example.com",
    "https://social.example.com.evil.com",
    "https://evil.com#social.example.com",
    "https://x@social.example.com",
    "https://social.example.com@evil.com",
    "https://social.example.com/api",
    "https://social.example.com:8443",
    "https://social.example.com?x=1",
    "not a url",
    "ftp://localhost",
    "http://user@localhost:3000",
    "http://u:p@localhost:3000",
    "http://localhost:3000/path",
    "http://localhost:3000?x=1",
    "http://localhost:3000#x",
    "http://localhost.evil.com",
  ])("refuses a requested %s (the --base-url flag or SOCIAL_API_BASE_URL) before minting a token", (url) => {
    expect(() => pinnedBaseUrl(url, ORIGIN)).toThrow(
      `refusing API base URL "${url}": the agent API is ${ORIGIN} only, because every request carries the agent's ID token`,
    );
    const idToken = vi.fn(async () => "t");
    expect(() => createApiClient({ ...BASE, requestedBaseUrl: url, idToken })).toThrow(/refusing API base URL/);
    expect(idToken).not.toHaveBeenCalled();
  });

  it("allows a local server (http or https, localhost or 127.0.0.1) only under NODE_ENV=test", () => {
    for (const url of ["http://localhost:3000", "https://localhost", "http://127.0.0.1:3000/"]) {
      vi.stubEnv("NODE_ENV", "test");
      expect(pinnedBaseUrl(url, ORIGIN)).toBe(url.replace(/\/+$/, ""));
      expect(createApiClient({ ...BASE, requestedBaseUrl: url }).baseUrl).toBe(url.replace(/\/+$/, ""));
      vi.stubEnv("NODE_ENV", "production");
      expect(() => pinnedBaseUrl(url, ORIGIN), url).toThrow(/refusing API base URL/);
      vi.stubEnv("NODE_ENV", "development");
      expect(() => pinnedBaseUrl(url, ORIGIN), url).toThrow(/refusing API base URL/);
    }
  });

  it("keeps the configured origin in every environment", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(pinnedBaseUrl(`${ORIGIN}//`, ORIGIN)).toBe(ORIGIN);
  });
});
