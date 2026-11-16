/**
 * anthropic-wif.ts: Social HQ's workload identity federation credentials.
 *
 * ⛔ THE REAL SDK, NOT A MOCK. The exchange is `oidcFederationProvider` and the
 * token file reader is `identityTokenFromFile`, both from the installed
 * @anthropic-ai/sdk; only the network is stubbed, at `fetch`, so these tests
 * prove the request the SDK actually builds (endpoint, grant, the four IDs, the
 * identity token as the assertion) and how its errors reach the log. The
 * metadata server and the token endpoint answer with the shapes Google and
 * Anthropic document.
 *
 * `google-auth-library` is the one module replaced: its `GoogleAuth#request`
 * would sign with this machine's ADC and call IAM Credentials for real. The
 * stub answers the documented `generateIdToken` shape (`{ token }`) and throws
 * the errors the library throws (a GaxiosError carrying `status`, or the
 * no-credentials Error that carries none).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkloadIdentityError } from "@anthropic-ai/sdk/lib/credentials/types";

const g = vi.hoisted(() => ({ request: vi.fn(), ctorArgs: [] as unknown[] }));
vi.mock("google-auth-library", () => ({
  GoogleAuth: class {
    request = g.request;
    constructor(opts: unknown) {
      g.ctorArgs.push(opts);
    }
  },
}));

import {
  ANTHROPIC_API_BASE_URL,
  ANTHROPIC_IDENTITY_TOKEN_FILE_ENV,
  ANTHROPIC_WIF_KEYS,
  EXCHANGE_TIMEOUT_MS,
  GCE_METADATA_IDENTITY_URL,
  IAM_CREDENTIALS_URL,
  ID_TOKEN_TIMEOUT_MS,
  METADATA_TIMEOUT_MS,
  SOCIAL_HQ_ID_TOKEN_SA_ENV,
  WifSetupError,
  gceMetadataIdentityToken,
  impersonatedIdToken,
  tokenSource,
  wifCredentials,
  wifSettingsFromEnv,
  type WifSettings,
} from "../anthropic-wif.js";

const RULE = "fdrl_01TestRuleSocialHq";
const ORG = "00000000-0000-4000-8000-000000000000";
const SA = "svac_01TestSocialHqWebsite";
const WS = "wrkspc_01TestWorkspace";

/** JWT-shaped, never a real token. */
const GCE_JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJnY2UifQ.c2lnLWdjZQ";
const FILE_JWT_1 = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJrM3MtMSJ9.c2lnLTE";
const FILE_JWT_2 = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJrM3MtMiJ9.c2lnLTI";
const ACCESS = "sk-ant-oat01-test-access-token";
const OPERATOR_JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJvcGVyYXRvciJ9.c2lnLW9w";
const OPERATOR_SA = "operator@example-project.iam.gserviceaccount.com";

const ALL_ENV = [...ANTHROPIC_WIF_KEYS, ANTHROPIC_IDENTITY_TOKEN_FILE_ENV, SOCIAL_HQ_ID_TOKEN_SA_ENV];

interface Seen {
  url: string;
  init: RequestInit;
}
const seen: Seen[] = [];
let answer: (url: string) => Response | Promise<Response>;

const tokenEndpoint = `${ANTHROPIC_API_BASE_URL}/v1/oauth/token`;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** The documented happy path: metadata answers a JWT, the endpoint mints a 600 s token. */
function happy(url: string): Response {
  if (url === GCE_METADATA_IDENTITY_URL) return new Response(`${GCE_JWT}\n`);
  if (url === tokenEndpoint) return json({ access_token: ACCESS, token_type: "Bearer", expires_in: 600 });
  throw new Error(`unexpected fetch ${url}`);
}

let dir: string;
let info: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

function settings(over: Partial<WifSettings> = {}): WifSettings {
  return {
    federationRuleId: RULE,
    organizationId: ORG,
    serviceAccountId: SA,
    workspaceId: WS,
    tokenFile: null,
    idTokenServiceAccount: null,
    ...over,
  };
}

function exchangeBodies(): Array<Record<string, string>> {
  return seen.filter((s) => s.url === tokenEndpoint).map((s) => JSON.parse(String(s.init.body)));
}

/** Everything this module wrote to the console, for "never logs a token" checks. */
function logged(): string {
  return [...info.mock.calls, ...error.mock.calls].flat().map(String).join("\n");
}

beforeEach(() => {
  // A CI job inherits the pipeline's environment: start from none of these set.
  for (const name of ALL_ENV) vi.stubEnv(name, undefined);
  seen.length = 0;
  answer = happy;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      seen.push({ url, init });
      return answer(url);
    }),
  );
  info = vi.spyOn(console, "info").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
  dir = mkdtempSync(path.join(tmpdir(), "socialhq-wif-"));
  g.ctorArgs.length = 0;
  g.request.mockReset().mockResolvedValue({ status: 200, data: { token: OPERATOR_JWT } });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("constants", () => {
  it("names the SDK's own four ID variables, the token file variable, and the API host", () => {
    expect(ANTHROPIC_WIF_KEYS).toEqual([
      "ANTHROPIC_FEDERATION_RULE_ID",
      "ANTHROPIC_ORGANIZATION_ID",
      "ANTHROPIC_SERVICE_ACCOUNT_ID",
      "ANTHROPIC_WORKSPACE_ID",
    ]);
    expect(ANTHROPIC_IDENTITY_TOKEN_FILE_ENV).toBe("ANTHROPIC_IDENTITY_TOKEN_FILE");
    expect(ANTHROPIC_API_BASE_URL).toBe("https://api.anthropic.com");
    expect(SOCIAL_HQ_ID_TOKEN_SA_ENV).toBe("SOCIAL_HQ_ID_TOKEN_SERVICE_ACCOUNT");
    expect(IAM_CREDENTIALS_URL).toBe("https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts");
    expect(ID_TOKEN_TIMEOUT_MS).toBe(10000);
  });

  it("asks the metadata server for a format=full token for the Anthropic audience (the us rule's CEL reads compute_engine)", () => {
    expect(GCE_METADATA_IDENTITY_URL).toBe(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity" +
        "?audience=https://api.anthropic.com&format=full",
    );
    expect(METADATA_TIMEOUT_MS).toBe(2000);
    expect(EXCHANGE_TIMEOUT_MS).toBe(10000);
  });
});

describe("wifSettingsFromEnv", () => {
  it("is null when none of the four IDs is set, even with a token file", () => {
    expect(wifSettingsFromEnv()).toBeNull();
    vi.stubEnv(ANTHROPIC_IDENTITY_TOKEN_FILE_ENV, "/var/run/secrets/anthropic/token");
    expect(wifSettingsFromEnv()).toBeNull();
  });

  it("is null when all four are empty, which is how a manifest carries them before a rollout", () => {
    for (const name of ANTHROPIC_WIF_KEYS) vi.stubEnv(name, "");
    expect(wifSettingsFromEnv()).toBeNull();
  });

  it("throws on a partial set, naming every missing ID, instead of reading it as 'use the key'", () => {
    vi.stubEnv("ANTHROPIC_FEDERATION_RULE_ID", RULE);
    vi.stubEnv("ANTHROPIC_WORKSPACE_ID", WS);
    vi.stubEnv("ANTHROPIC_SERVICE_ACCOUNT_ID", "");
    expect(() => wifSettingsFromEnv()).toThrow(WifSetupError);
    expect(() => wifSettingsFromEnv()).toThrow(
      "Anthropic workload identity federation is partly configured: " +
        "ANTHROPIC_ORGANIZATION_ID, ANTHROPIC_SERVICE_ACCOUNT_ID unset. " +
        "Set all of ANTHROPIC_FEDERATION_RULE_ID, ANTHROPIC_ORGANIZATION_ID, ANTHROPIC_SERVICE_ACCOUNT_ID, " +
        "ANTHROPIC_WORKSPACE_ID or none.",
    );
    let err: unknown;
    try {
      wifSettingsFromEnv();
    } catch (e) {
      err = e;
    }
    expect((err as Error).name).toBe("WifSetupError");
  });

  it("reads all four, on the GCE metadata server when no token file is set (or it is empty)", () => {
    vi.stubEnv("ANTHROPIC_FEDERATION_RULE_ID", RULE);
    vi.stubEnv("ANTHROPIC_ORGANIZATION_ID", ORG);
    vi.stubEnv("ANTHROPIC_SERVICE_ACCOUNT_ID", SA);
    vi.stubEnv("ANTHROPIC_WORKSPACE_ID", WS);
    expect(wifSettingsFromEnv()).toEqual(settings());
    vi.stubEnv(ANTHROPIC_IDENTITY_TOKEN_FILE_ENV, "");
    const s = wifSettingsFromEnv();
    expect(s?.tokenFile).toBeNull();
    expect(tokenSource(s!)).toBe("gce-metadata");
  });

  it("reads the projected token's path when one is set", () => {
    vi.stubEnv("ANTHROPIC_FEDERATION_RULE_ID", RULE);
    vi.stubEnv("ANTHROPIC_ORGANIZATION_ID", ORG);
    vi.stubEnv("ANTHROPIC_SERVICE_ACCOUNT_ID", SA);
    vi.stubEnv("ANTHROPIC_WORKSPACE_ID", WS);
    vi.stubEnv(ANTHROPIC_IDENTITY_TOKEN_FILE_ENV, "/var/run/secrets/anthropic/token");
    const s = wifSettingsFromEnv();
    expect(s).toEqual(settings({ tokenFile: "/var/run/secrets/anthropic/token" }));
    expect(tokenSource(s!)).toBe("file /var/run/secrets/anthropic/token");
  });
});

describe("wifSettingsFromEnv: the operator CLI's ID token source", () => {
  function setIds() {
    vi.stubEnv("ANTHROPIC_FEDERATION_RULE_ID", RULE);
    vi.stubEnv("ANTHROPIC_ORGANIZATION_ID", ORG);
    vi.stubEnv("ANTHROPIC_SERVICE_ACCOUNT_ID", SA);
    vi.stubEnv("ANTHROPIC_WORKSPACE_ID", WS);
  }

  it("reads the service account whose ID token the caller's ADC mints", () => {
    setIds();
    vi.stubEnv(SOCIAL_HQ_ID_TOKEN_SA_ENV, OPERATOR_SA);
    const s = wifSettingsFromEnv();
    expect(s).toEqual(settings({ idTokenServiceAccount: OPERATOR_SA }));
    expect(tokenSource(s!)).toBe(`id-token ${OPERATOR_SA}`);
  });

  it("refuses two identity token sources instead of picking one", () => {
    setIds();
    vi.stubEnv(SOCIAL_HQ_ID_TOKEN_SA_ENV, OPERATOR_SA);
    vi.stubEnv(ANTHROPIC_IDENTITY_TOKEN_FILE_ENV, "/var/run/secrets/anthropic/token");
    expect(() => wifSettingsFromEnv()).toThrow(
      "Set at most one identity token source: ANTHROPIC_IDENTITY_TOKEN_FILE or SOCIAL_HQ_ID_TOKEN_SERVICE_ACCOUNT, not both.",
    );
  });

  it.each([
    ["a user, not a service account", "person@example.com"],
    ["a path smuggled into the URL", "x/../../y@example-project.iam.gserviceaccount.com"],
    ["the default compute account, which is not user-managed", "123456789012-compute@developer.gserviceaccount.com"],
  ])("refuses %s as the ID token service account", (_why, value) => {
    setIds();
    vi.stubEnv(SOCIAL_HQ_ID_TOKEN_SA_ENV, value);
    expect(() => wifSettingsFromEnv()).toThrow("SOCIAL_HQ_ID_TOKEN_SERVICE_ACCOUNT is not a GCP service account email.");
  });

  it("ignores the ID token service account while the four IDs are unset (the key path)", () => {
    vi.stubEnv(SOCIAL_HQ_ID_TOKEN_SA_ENV, OPERATOR_SA);
    expect(wifSettingsFromEnv()).toBeNull();
  });
});

describe("impersonatedIdToken", () => {
  it("asks IAM Credentials for an ID token for the Anthropic audience, with its email, on the caller's ADC", async () => {
    await expect(impersonatedIdToken(OPERATOR_SA)()).resolves.toBe(OPERATOR_JWT);
    expect(g.ctorArgs).toEqual([{ scopes: ["https://www.googleapis.com/auth/cloud-platform"] }]);
    expect(g.request).toHaveBeenCalledWith({
      url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${OPERATOR_SA}:generateIdToken`,
      method: "POST",
      data: { audience: "https://api.anthropic.com", includeEmail: true },
      timeout: 10000,
    });
    expect(seen).toEqual([]);
  });

  it("names the missing grant on a 403, never the body", async () => {
    g.request.mockRejectedValue(Object.assign(new Error("Permission 'iam.serviceAccounts.getOpenIdToken' denied"), { status: 403 }));
    await expect(impersonatedIdToken(OPERATOR_SA)()).rejects.toThrow(
      new RegExp(
        `^ID token for ${OPERATOR_SA} could not be minted \\(HTTP 403: the caller's ADC needs ` +
          `roles/iam\\.serviceAccountOpenIdTokenCreator on ${OPERATOR_SA}\\)$`,
      ),
    );
  });

  it("names any other HTTP status alone", async () => {
    g.request.mockRejectedValue(Object.assign(new Error("Not found; Gaia id not found"), { status: 404 }));
    await expect(impersonatedIdToken(OPERATOR_SA)()).rejects.toThrow(
      new RegExp(`^ID token for ${OPERATOR_SA} could not be minted \\(HTTP 404\\)$`),
    );
  });

  it("names the error class when there is no HTTP status (no ADC on this machine)", async () => {
    g.request.mockRejectedValue(new Error("Could not load the default credentials."));
    const err = await Promise.resolve(impersonatedIdToken(OPERATOR_SA)()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WifSetupError);
    expect((err as Error).message).toBe(`ID token for ${OPERATOR_SA} could not be minted (Error)`);
  });

  it.each([[{}], [{ token: 42 }], [{ token: "not-a-jwt" }]])("refuses an answer that is not a JWT: %j", async (data) => {
    g.request.mockResolvedValue({ status: 200, data });
    await expect(impersonatedIdToken(OPERATOR_SA)()).rejects.toThrow(
      `generateIdToken for ${OPERATOR_SA} returned something that is not a JWT`,
    );
  });
});

describe("gceMetadataIdentityToken", () => {
  it("GETs the format=full URL with Metadata-Flavor and a timeout, and returns the trimmed JWT", async () => {
    await expect(gceMetadataIdentityToken()()).resolves.toBe(GCE_JWT);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(GCE_METADATA_IDENTITY_URL);
    expect(seen[0]!.init.headers).toEqual({ "Metadata-Flavor": "Google" });
    expect(seen[0]!.init.method).toBeUndefined();
    expect(seen[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("names the HTTP status, never the body, on a refusal", async () => {
    answer = () => new Response("secret-looking body", { status: 404 });
    const p = gceMetadataIdentityToken()();
    await expect(p).rejects.toThrow(WifSetupError);
    await expect(gceMetadataIdentityToken()()).rejects.toThrow(/^GCE metadata identity token fetch answered HTTP 404$/);
  });

  it("names the transport error's class, not its message, when the metadata server is unreachable", async () => {
    answer = () => {
      throw new TypeError("fetch failed: getaddrinfo ENOTFOUND metadata.google.internal");
    };
    await expect(gceMetadataIdentityToken()()).rejects.toThrow(
      /^GCE metadata identity token fetch failed \(TypeError\); the pod cannot reach metadata\.google\.internal$/,
    );
  });

  it("refuses an answer that is not a JWT", async () => {
    answer = () => new Response("<html>proxy login</html>");
    await expect(gceMetadataIdentityToken()()).rejects.toThrow(
      "GCE metadata identity token fetch returned something that is not a JWT",
    );
  });
});

describe("wifCredentials", () => {
  it("exchanges the GCE token at the token endpoint with the rule, org, service account and workspace", async () => {
    const before = Math.floor(Date.now() / 1000);
    const token = await wifCredentials(settings())();
    expect(token.token).toBe(ACCESS);
    expect(token.expiresAt).toBeGreaterThanOrEqual(before + 600);

    expect(seen.map((s) => s.url)).toEqual([GCE_METADATA_IDENTITY_URL, tokenEndpoint]);
    const exchange = seen[1]!;
    expect(exchange.init.method).toBe("POST");
    expect(exchange.init.signal).toBeInstanceOf(AbortSignal);
    expect(exchangeBodies()).toEqual([
      {
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: GCE_JWT,
        federation_rule_id: RULE,
        organization_id: ORG,
        service_account_id: SA,
        workspace_id: WS,
      },
    ]);

    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0]![0])).toMatch(
      new RegExp(`^\\[socialhq\\] Claude WIF token exchanged for rule ${RULE} \\(gce-metadata\\); valid (59[89]|600)s\\.$`),
    );
    expect(logged()).not.toContain(ACCESS);
    expect(logged()).not.toContain(GCE_JWT);
  });

  it("re-reads a projected token file on every exchange, so a kubelet rotation is picked up", async () => {
    const file = path.join(dir, "token");
    writeFileSync(file, `${FILE_JWT_1}\n`);
    const creds = wifCredentials(settings({ tokenFile: file }));
    await creds();
    writeFileSync(file, FILE_JWT_2);
    await creds({ forceRefresh: true });

    expect(seen.some((s) => s.url === GCE_METADATA_IDENTITY_URL)).toBe(false);
    expect(exchangeBodies().map((b) => b.assertion)).toEqual([FILE_JWT_1, FILE_JWT_2]);
    expect(String(info.mock.calls[0]![0])).toContain(`(file ${file})`);
    expect(logged()).not.toContain(FILE_JWT_1);
  });

  it("exchanges the operator's minted ID token, never touching the metadata server", async () => {
    await wifCredentials(settings({ idTokenServiceAccount: OPERATOR_SA }))();
    expect(seen.map((s) => s.url)).toEqual([tokenEndpoint]);
    expect(exchangeBodies().map((b) => b.assertion)).toEqual([OPERATOR_JWT]);
    expect(String(info.mock.calls[0]![0])).toContain(`(id-token ${OPERATOR_SA})`);
    expect(logged()).not.toContain(OPERATOR_JWT);
  });

  it("rethrows a refused exchange after one ERROR line naming the rule and where the deny reason is", async () => {
    answer = (url) =>
      url === tokenEndpoint
        ? json({ type: "error", error: { type: "authentication_error", message: "Authentication failed" } }, 401)
        : happy(url);
    const err = await wifCredentials(settings())().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkloadIdentityError);
    expect((err as WorkloadIdentityError).statusCode).toBe(401);
    expect(info).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    const line = String(error.mock.calls[0]![0]);
    expect(line).toMatch(
      new RegExp(`^\\[socialhq\\] Claude WIF token exchange FAILED for rule ${RULE} \\(gce-metadata, WorkloadIdentityError: Token exchange failed with status 401`),
    );
    expect(line).toContain(
      "No API key fallback: the Social HQ call fails. Deny reasons: Claude Console, Workload identity, authentication history.",
    );
    expect(logged()).not.toContain(GCE_JWT);
  });

  it("fails the same way when the identity token cannot be had, before any exchange is attempted", async () => {
    answer = () => new Response("", { status: 503 });
    await expect(wifCredentials(settings())()).rejects.toThrow(WifSetupError);
    expect(seen.map((s) => s.url)).toEqual([GCE_METADATA_IDENTITY_URL]);
    expect(String(error.mock.calls[0]![0])).toContain(
      "(gce-metadata, WifSetupError: GCE metadata identity token fetch answered HTTP 503)",
    );
  });

  it("fails on a missing token file (the projected volume is not mounted), naming the path", async () => {
    const file = path.join(dir, "absent");
    await expect(wifCredentials(settings({ tokenFile: file }))()).rejects.toThrow(
      `Failed to read identity token file at ${file}`,
    );
    expect(seen).toEqual([]);
    expect(String(error.mock.calls[0]![0])).toContain(`(file ${file}, AnthropicError: Failed to read identity token file`);
  });
});
