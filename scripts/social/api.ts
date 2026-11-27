// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

import { GoogleAuth } from "google-auth-library";

/**
 * The CLI's client for a Social HQ agent API (`/api/internal/social/*`).
 *
 * ⛔ KEYLESS. The credential is a Google ID token for this machine's ADC
 * identity, minted for the API's configured audience. The API decides which
 * identities it admits; nothing is read from a file or an env var holding a
 * secret. A person's own ADC mints a token for that person, which an API that
 * admits only agent identities refuses with 401, as it should.
 */

/** A non-2xx answer, carrying the API's own sentence. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    const said = (body as { error?: unknown } | null)?.error;
    super(`HTTP ${status}: ${typeof said === "string" ? said : JSON.stringify(body)}`);
    this.name = "ApiError";
  }
}

export interface ApiOptions {
  /** The CONFIGURED API origin. Required: every request goes here and only here. */
  baseUrl?: string;
  /** The ID token audience the API verifies. Required. */
  audience?: string;
  /** A per-run origin (`--base-url`, SOCIAL_API_BASE_URL). Pinned: it must equal `baseUrl`. */
  requestedBaseUrl?: string;
  /** For tests. */
  fetchImpl?: typeof fetch;
  /** For tests: the bearer token source. Default: ADC's ID token for the audience. */
  idToken?: () => Promise<string>;
}

export interface ApiClient {
  baseUrl: string;
  request<T>(method: string, path: string, body?: unknown): Promise<T>;
}

async function adcIdToken(audience: string): Promise<string> {
  const client = await new GoogleAuth().getIdTokenClient(audience);
  return client.idTokenProvider.fetchIdToken(audience);
}

/** A local server (http or https on localhost or 127.0.0.1, a bare origin), admitted under NODE_ENV=test only. */
function isLocalTestOrigin(raw: string): boolean {
  if (process.env.NODE_ENV !== "test") return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
    !url.username &&
    !url.password &&
    url.pathname === "/" &&
    !url.search &&
    !url.hash
  );
}

/**
 * The configured origin, normalised (trailing slashes dropped). It must be a
 * bare https origin: no userinfo, path, query or fragment, and spelled the way
 * the URL parser spells it, so the pin below compares one canonical string.
 */
export function configuredOrigin(raw: string): string {
  const trimmed = raw.replace(/\/+$/, "");
  if (isLocalTestOrigin(trimmed)) return trimmed;
  let url: URL | null = null;
  try {
    url = new URL(trimmed);
  } catch {
    // Not a URL at all: refused below.
  }
  if (url !== null && url.protocol === "https:" && url.origin === trimmed) return trimmed;
  throw new Error(`refusing configured API base URL "${raw}": it must be a bare https origin, like https://social.example.com`);
}

/**
 * ⛔ THE BASE URL IS PINNED. Every request carries the agent's Google ID token,
 * so the origin decides who receives a credential that publishes: exactly the
 * configured origin. The one exception is a local server (see
 * isLocalTestOrigin) under NODE_ENV=test. Anything else, a lookalike host,
 * userinfo, a path, a query, is refused before a token is minted.
 */
export function pinnedBaseUrl(raw: string, configured: string): string {
  const trimmed = raw.replace(/\/+$/, "");
  if (trimmed === configured || isLocalTestOrigin(trimmed)) return trimmed;
  throw new Error(
    `refusing API base URL "${raw}": the agent API is ${configured} only, ` +
      "because every request carries the agent's ID token",
  );
}

export function createApiClient(opts: ApiOptions): ApiClient {
  if (!opts.baseUrl) {
    throw new Error("no agent API origin configured: set api.baseUrl in config.json, or SOCIAL_API_BASE_URL");
  }
  if (!opts.audience) {
    throw new Error("no ID token audience configured: set api.audience in config.json, or SOCIAL_API_AUDIENCE");
  }
  const configured = configuredOrigin(opts.baseUrl);
  const baseUrl = opts.requestedBaseUrl ? pinnedBaseUrl(opts.requestedBaseUrl, configured) : configured;
  const audience = opts.audience;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const idToken = opts.idToken ?? (() => adcIdToken(audience));
  let token: Promise<string> | null = null;

  return {
    baseUrl,
    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      // One token per process: it lives an hour, and no command runs that long.
      token ??= idToken();
      const headers: Record<string, string> = { authorization: `Bearer ${await token}` };
      let payload: RequestInit["body"];
      if (body instanceof FormData) {
        payload = body;
      } else if (body !== undefined) {
        headers["content-type"] = "application/json";
        payload = JSON.stringify(body);
      }
      const res = await fetchImpl(`${baseUrl}/api/internal/social${path}`, { method, headers, body: payload });
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        // Not JSON (an edge error page, say): kept as text for the message.
      }
      if (!res.ok) throw new ApiError(res.status, parsed);
      return parsed as T;
    },
  };
}
