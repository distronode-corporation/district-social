// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

/**
 * claude.ts on workload identity federation, through the REAL Anthropic SDK.
 *
 * claude.test.ts replaces the SDK with a stub to pin the request body; this
 * file keeps the real client and stubs only `fetch`, because the property that
 * matters here lives inside the SDK: which credential the client sends.
 *
 * ⛔ THE TRAP THIS PINS. Every test below runs with `ANTHROPIC_API_KEY` and
 * `ANTHROPIC_AUTH_TOKEN` set in the environment, and the Messages requests
 * must still carry only the credential claude.ts passed. In SDK 0.x a key or
 * token found in the environment won over `credentials` unless both options
 * were explicitly nulled (remove either `null` and it leaked). Since SDK v1
 * (2026-11-09, 0.135.0 -> 1.7.0) a client holds one credential and never
 * reads the environment when `credentials` (or `apiKey`) is passed; the
 * key-path test also pins v1's wire change, the key sent as
 * `Authorization: Bearer` where 0.x sent it as `x-api-key`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkloadIdentityError } from "@anthropic-ai/sdk/lib/credentials/types";

const h = vi.hoisted(() => ({ getSecret: vi.fn() }));

import {
  ANTHROPIC_IDENTITY_TOKEN_FILE_ENV,
  ANTHROPIC_WIF_KEYS,
  GCE_METADATA_IDENTITY_URL,
  SOCIAL_HQ_ID_TOKEN_SA_ENV,
} from "../anthropic-wif.js";

type ClaudeModule = typeof import("../claude.js");
let claude: ClaudeModule;
/** The fresh instance claude.ts loads after vi.resetModules(), so `instanceof` compares the same class. */
let wif: typeof import("../anthropic-wif.js");

const RULE = "fdrl_01TestRuleSocialHq";
const GCE_JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJnY2UifQ.c2lnLWdjZQ";
const ACCESS = "sk-ant-oat01-test-access-token";
const ENV_KEY = "sk-ant-api03-env-key-that-must-not-be-sent";
const ENV_TOKEN = "env-auth-token-that-must-not-be-sent";
const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
const MESSAGES_URL = "https://api.anthropic.com/v1/messages";

const SCHEMA = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
  additionalProperties: false,
};

interface Seen {
  url: string;
  headers: Headers;
}
const seen: Seen[] = [];
let tokenStatus = 200;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function answer(url: string): Response {
  if (url === GCE_METADATA_IDENTITY_URL) return new Response(GCE_JWT);
  if (url === TOKEN_URL) {
    return tokenStatus === 200
      ? json({ access_token: ACCESS, token_type: "Bearer", expires_in: 600 })
      : json({ type: "error", error: { type: "authentication_error", message: "Authentication failed" } }, tokenStatus);
  }
  if (url === MESSAGES_URL) {
    return json({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5-5",
      content: [{ type: "text", text: '{"ok":true}' }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  }
  throw new Error(`unexpected fetch ${url}`);
}

function urls(): string[] {
  return seen.map((s) => s.url);
}

beforeEach(async () => {
  vi.resetModules();
  for (const name of [...ANTHROPIC_WIF_KEYS, ANTHROPIC_IDENTITY_TOKEN_FILE_ENV, SOCIAL_HQ_ID_TOKEN_SA_ENV, "ANTHROPIC_BASE_URL"]) {
    vi.stubEnv(name, undefined);
  }
  vi.stubEnv("ANTHROPIC_API_KEY", ENV_KEY);
  vi.stubEnv("ANTHROPIC_AUTH_TOKEN", ENV_TOKEN);
  vi.stubEnv("ANTHROPIC_FEDERATION_RULE_ID", RULE);
  vi.stubEnv("ANTHROPIC_ORGANIZATION_ID", "00000000-0000-4000-8000-000000000000");
  vi.stubEnv("ANTHROPIC_SERVICE_ACCOUNT_ID", "svac_01TestSocialHqWebsite");
  vi.stubEnv("ANTHROPIC_WORKSPACE_ID", "wrkspc_01TestWorkspace");
  seen.length = 0;
  tokenStatus = 200;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      seen.push({ url, headers: new Headers(init.headers) });
      return answer(url);
    }),
  );
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  h.getSecret.mockReset().mockRejectedValue(new Error("getSecret must not be called on the WIF path"));
  claude = await import("../claude.js");
  claude.setSecretGetter(h.getSecret);
  wif = await import("../anthropic-wif.js");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("genJson on workload identity federation (real SDK)", () => {
  it("sends the federated bearer token, never the key or token in the environment, and exchanges once", async () => {
    await expect(claude.genJson<{ ok: boolean }>("Say ok.", { schema: SCHEMA })).resolves.toEqual({ ok: true });
    await expect(claude.genJson<{ ok: boolean }>("Again.", { schema: SCHEMA })).resolves.toEqual({ ok: true });

    // One metadata read and one exchange for both calls: the client's TokenCache holds the token.
    expect(urls()).toEqual([GCE_METADATA_IDENTITY_URL, TOKEN_URL, MESSAGES_URL, MESSAGES_URL]);
    for (const call of seen.filter((s) => s.url === MESSAGES_URL)) {
      expect(call.headers.get("authorization")).toBe(`Bearer ${ACCESS}`);
      expect(call.headers.get("x-api-key")).toBeNull();
      expect(call.headers.get("anthropic-beta")?.split(",")).toContain("oauth-2025-04-20");
      expect([...call.headers.values()].join(" ")).not.toContain(ENV_KEY);
      expect([...call.headers.values()].join(" ")).not.toContain(ENV_TOKEN);
    }
    expect(h.getSecret).not.toHaveBeenCalled();
    expect(console.info).toHaveBeenCalledWith(
      `[district-social] Claude auth: workload identity federation (rule ${RULE}, gce-metadata); ANTHROPIC_API_KEY is set and NOT used.`,
    );
  });

  it("fails closed on a refused exchange: no Messages request, no key fallback", async () => {
    tokenStatus = 401;
    const err = await claude.genJson("Say ok.", { schema: SCHEMA }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkloadIdentityError);
    expect(urls()).not.toContain(MESSAGES_URL);
    expect(urls()).toContain(TOKEN_URL);
    expect(h.getSecret).not.toHaveBeenCalled();
  });

  it("fails closed on a partial set, before any request and without reading the key", async () => {
    vi.stubEnv("ANTHROPIC_SERVICE_ACCOUNT_ID", "");
    await expect(claude.genJson("Say ok.", { schema: SCHEMA })).rejects.toThrow(wif.WifSetupError);
    expect(seen).toEqual([]);
    expect(h.getSecret).not.toHaveBeenCalled();
  });
});

describe("genJson on the API key (real SDK)", () => {
  it("sends the key as Authorization: Bearer, never as x-api-key, and ignores the env key and token", async () => {
    for (const name of ANTHROPIC_WIF_KEYS) vi.stubEnv(name, undefined);
    h.getSecret.mockReset().mockResolvedValue("sk-ant-api03-test-key");
    await expect(claude.genJson<{ ok: boolean }>("Say ok.", { schema: SCHEMA })).resolves.toEqual({ ok: true });

    expect(seen.map((s) => s.url)).toEqual([MESSAGES_URL]);
    const headers = seen[0]!.headers;
    // v1 of the SDK sends the API key as Authorization: Bearer (the 2026-10-21
    // API version change); in 0.x it went out as x-api-key. A client built with
    // one credential never reads ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN.
    expect(headers.get("authorization")).toBe("Bearer sk-ant-api03-test-key");
    expect(headers.get("x-api-key")).toBeNull();
    expect([...headers.values()].join(" ")).not.toContain(ENV_KEY);
    expect([...headers.values()].join(" ")).not.toContain(ENV_TOKEN);
    expect(h.getSecret).toHaveBeenCalledWith("ANTHROPIC_API_KEY");
  });
});
