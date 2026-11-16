import { identityTokenFromFile } from "@anthropic-ai/sdk/lib/credentials/identity-token";
import {
  oidcFederationProvider,
  type OIDCFederationConfig,
} from "@anthropic-ai/sdk/lib/credentials/oidc-federation";
import type { AccessTokenProvider, IdentityTokenProvider } from "@anthropic-ai/sdk/lib/credentials/types";
import { GoogleAuth } from "google-auth-library";

/**
 * Social HQ's Anthropic credentials: Workload Identity Federation (WIF).
 *
 * The engine's Claude calls (claude.ts) can authenticate with a short-lived
 * Anthropic access token minted from the workload's own identity instead of a
 * static `ANTHROPIC_API_KEY`. The operator creates an Anthropic service account
 * and one federation rule per identity source, then sets the four IDs below.
 * Three identity sources are supported:
 *
 * - A GCE VM: the metadata server's identity token for the instance's service
 *   account, fetched with `format=full` (`GCE_METADATA_IDENTITY_URL`). A rule
 *   whose CEL reads `google.compute_engine.project_id` or `instance_name` needs
 *   a `format=full` token, so a `format=standard` fetch is a 401.
 * - A Kubernetes pod: a projected service-account token, audience
 *   `https://api.anthropic.com`, read from `ANTHROPIC_IDENTITY_TOKEN_FILE` on
 *   every exchange (the kubelet rotates it in place).
 * - An off-cluster operator machine (the CLI): a Google ID token for the
 *   role-less service account named in `SOCIAL_HQ_ID_TOKEN_SERVICE_ACCOUNT`,
 *   minted through IAM Credentials `generateIdToken` with the caller's ADC.
 *   Only principals holding `roles/iam.serviceAccountOpenIdTokenCreator` on
 *   that account can mint one, so the grant list is the access list. The CLI
 *   bridges this from its config.json (scripts/social/config.ts).
 *
 * ⛔ WIF IS CONFIGURED BY THE FOUR IDS IN `ANTHROPIC_WIF_KEYS`, AND ONCE IT IS
 * CONFIGURED IT IS THE ONLY CREDENTIAL. claude.ts builds the client with
 * `apiKey: null, authToken: null` beside `credentials`. In SDK 0.x both nulls
 * were load-bearing in THIS SDK, unlike the Python one: the TypeScript
 * constructor read `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from the
 * environment whenever the option was `undefined`, and a key or token it found
 * there WON over `credentials`. Since SDK v1 (0.135.0 -> 1.7.0) a
 * client holds one credential: with `credentials` passed, the environment is
 * never read, null or no null, so the two stay only as the explicit no-key /
 * no-token declaration. A failed exchange therefore never falls back to a key:
 * the call throws, and every Social HQ caller treats a throw as "no answer"
 * (QA blocks with `llm-qa-unavailable`).
 *
 * ⛔ A PARTIAL SET THROWS, never reads as "not configured": a pod with a rule ID
 * and no service account ID is a broken WIF config, and treating it as absent
 * would put Social HQ on the key without a word. An empty value counts as
 * unset, so a manifest can carry the four names with empty values (inert)
 * until a rollout fills all four.
 *
 * ⚠️ A pod rule depends on `check_jti` being OFF on the cluster's issuer. The SDK re-exchanges about every 8 minutes (a 600 s
 * token, refreshed 120 s early) while the kubelet rewrites the projected file
 * only at about 80 % of its 3600 s, so a pod presents the same JWT (with the
 * same `jti`) several times per rotation. The GCE token carries no `jti`.
 *
 * Nothing here logs or returns an identity token or an access token (the tests
 * below assert it). Error log lines name the error class and message; since
 * SDK v1 the WorkloadIdentityError message includes the token endpoint's error
 * body, but the SDK passes it through redactSensitive first (a safe-key
 * allowlist plus a length cap, oidc-federation.js), so no token or secret can
 * appear in it.
 */

/** The four IDs that switch Social HQ onto WIF: all set, or none. */
export const ANTHROPIC_WIF_KEYS = [
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_ORGANIZATION_ID",
  "ANTHROPIC_SERVICE_ACCOUNT_ID",
  "ANTHROPIC_WORKSPACE_ID",
] as const;

/** Where a pod's projected identity token is; unset means the GCE metadata server. */
export const ANTHROPIC_IDENTITY_TOKEN_FILE_ENV = "ANTHROPIC_IDENTITY_TOKEN_FILE";

/**
 * The operator CLI's identity token source: a GCP service account whose ID
 * token the caller's ADC mints through `generateIdToken`. Not an SDK variable,
 * hence our own prefix. At most one of this and the token file may be set.
 */
export const SOCIAL_HQ_ID_TOKEN_SA_ENV = "SOCIAL_HQ_ID_TOKEN_SERVICE_ACCOUNT";

/** A user-managed GCP service account email; anything else is refused before it reaches a URL. */
const SERVICE_ACCOUNT_EMAIL = /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/;

/** IAM Credentials, for the operator CLI's ID token. */
export const IAM_CREDENTIALS_URL = "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts";

/** `generateIdToken` answers in well under a second; this bounds a hung call. */
export const ID_TOKEN_TIMEOUT_MS = 10_000;

/** The audience every Social HQ federation rule requires, and the API host. */
export const ANTHROPIC_API_BASE_URL = "https://api.anthropic.com";

/**
 * ⛔ `format=full`: the us rule's CEL matches the `google.compute_engine`
 * claims, which a `format=standard` token does not carry. Byte-identical to the
 * voice agent's URL, so both rules on issuer A see the same claim set.
 */
export const GCE_METADATA_IDENTITY_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity" +
  `?audience=${ANTHROPIC_API_BASE_URL}&format=full`;

/** The metadata server answers in milliseconds; anything near this is a pod that cannot reach it. */
export const METADATA_TIMEOUT_MS = 2_000;

/**
 * The token exchange (`POST /v1/oauth/token`). The SDK sets no timeout of its
 * own on this request, and a Social HQ request waits on it before it can start.
 */
export const EXCHANGE_TIMEOUT_MS = 10_000;

/** The WIF configuration or the identity token source is unusable. */
export class WifSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WifSetupError";
  }
}

/** The non-secret WIF IDs, and where the identity token comes from. */
export interface WifSettings {
  federationRuleId: string;
  organizationId: string;
  serviceAccountId: string;
  workspaceId: string;
  /** The projected token's path (a pod), or null. */
  tokenFile: string | null;
  /** The service account whose ID token the caller's ADC mints (operator CLI), or null. */
  idTokenServiceAccount: string | null;
}

/** `file <path>`, `id-token <service account>` or `gce-metadata`. For log lines. */
export function tokenSource(settings: WifSettings): string {
  if (settings.tokenFile) return `file ${settings.tokenFile}`;
  if (settings.idTokenServiceAccount) return `id-token ${settings.idTokenServiceAccount}`;
  return "gce-metadata";
}

/** The WIF settings from the environment, or null when none of the four IDs is set. Throws on a partial set. */
export function wifSettingsFromEnv(): WifSettings | null {
  const values = ANTHROPIC_WIF_KEYS.map((name) => [name, process.env[name] ?? ""] as const);
  if (values.every(([, value]) => value === "")) return null;
  const missing = values.filter(([, value]) => value === "").map(([name]) => name);
  if (missing.length > 0) {
    throw new WifSetupError(
      `Anthropic workload identity federation is partly configured: ${missing.join(", ")} unset. ` +
        `Set all of ${ANTHROPIC_WIF_KEYS.join(", ")} or none.`,
    );
  }
  const [federationRuleId, organizationId, serviceAccountId, workspaceId] = values.map(([, value]) => value);
  const tokenFile = process.env[ANTHROPIC_IDENTITY_TOKEN_FILE_ENV] || null;
  const idTokenServiceAccount = process.env[SOCIAL_HQ_ID_TOKEN_SA_ENV] || null;
  // ⛔ Two sources is a broken config, not a preference order to guess at.
  if (tokenFile && idTokenServiceAccount) {
    throw new WifSetupError(
      `Set at most one identity token source: ${ANTHROPIC_IDENTITY_TOKEN_FILE_ENV} or ${SOCIAL_HQ_ID_TOKEN_SA_ENV}, not both.`,
    );
  }
  if (idTokenServiceAccount && !SERVICE_ACCOUNT_EMAIL.test(idTokenServiceAccount)) {
    throw new WifSetupError(`${SOCIAL_HQ_ID_TOKEN_SA_ENV} is not a GCP service account email.`);
  }
  return {
    federationRuleId: federationRuleId!,
    organizationId: organizationId!,
    serviceAccountId: serviceAccountId!,
    workspaceId: workspaceId!,
    tokenFile,
    idTokenServiceAccount,
  };
}

/**
 * An identity token provider over the GCE metadata server: a fresh read per
 * exchange. The metadata server caches the token itself and returns the same
 * one until it nears expiry; it carries no `jti`, so presenting it to more than
 * one exchange is fine. Node's fetch takes no proxy from the environment, so
 * the request (and the token in its answer) never leaves the host.
 */
export function gceMetadataIdentityToken(): IdentityTokenProvider {
  return async () => {
    let response: Response;
    try {
      response = await fetch(GCE_METADATA_IDENTITY_URL, {
        headers: { "Metadata-Flavor": "Google" },
        signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
      });
    } catch (err) {
      // fetch rejects only with an Error (a TypeError, or the timeout's
      // DOMException), so the class name is always there; the message is not
      // logged, only the class.
      throw new WifSetupError(
        `GCE metadata identity token fetch failed (${(err as Error).name}); the pod cannot reach metadata.google.internal`,
      );
    }
    if (response.status !== 200) {
      throw new WifSetupError(`GCE metadata identity token fetch answered HTTP ${response.status}`);
    }
    const token = (await response.text()).trim();
    if (token.split(".").length !== 3) {
      throw new WifSetupError("GCE metadata identity token fetch returned something that is not a JWT");
    }
    return token;
  };
}

/**
 * An identity token provider over IAM Credentials `generateIdToken`, for the
 * operator CLI: a Google-signed ID token for `serviceAccount`, audience
 * `https://api.anthropic.com`, with its email (the rule's CEL reads `sub` and
 * `email`). The caller's ADC signs the request: a user login, or a service
 * account the ADC impersonates. A fresh token per
 * exchange (Google ID tokens carry no `jti`). Errors name the HTTP status or the
 * error class, never a body; a 403 says which grant is missing.
 */
export function impersonatedIdToken(serviceAccount: string): IdentityTokenProvider {
  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  return async () => {
    let token: unknown;
    try {
      const response = await auth.request<{ token?: unknown }>({
        url: `${IAM_CREDENTIALS_URL}/${serviceAccount}:generateIdToken`,
        method: "POST",
        data: { audience: ANTHROPIC_API_BASE_URL, includeEmail: true },
        timeout: ID_TOKEN_TIMEOUT_MS,
      });
      token = response.data.token;
    } catch (err) {
      const { name, status } = err as { name: string; status?: number };
      const why =
        status === undefined
          ? name
          : status === 403
            ? `HTTP 403: the caller's ADC needs roles/iam.serviceAccountOpenIdTokenCreator on ${serviceAccount}`
            : `HTTP ${status}`;
      throw new WifSetupError(`ID token for ${serviceAccount} could not be minted (${why})`);
    }
    if (typeof token !== "string" || token.split(".").length !== 3) {
      throw new WifSetupError(`generateIdToken for ${serviceAccount} returned something that is not a JWT`);
    }
    return token;
  };
}

/** The exchange's fetch, bounded by EXCHANGE_TIMEOUT_MS. */
const exchangeFetch: OIDCFederationConfig["fetch"] = (url, init) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS) });

/** The settings' one identity token source (wifSettingsFromEnv refuses two). */
function identityTokenProvider(settings: WifSettings): IdentityTokenProvider {
  if (settings.tokenFile) return identityTokenFromFile(settings.tokenFile);
  if (settings.idTokenServiceAccount) return impersonatedIdToken(settings.idTokenServiceAccount);
  return gceMetadataIdentityToken();
}

/**
 * The access-token provider claude.ts hands the client as `credentials`. The
 * client wraps it in the SDK's TokenCache (one exchange, refreshed 120 s before
 * expiry, coalesced across concurrent requests, and forced once after an API
 * 401). This wrapper adds the two log lines an operator needs: which rule
 * minted a token, and which rule refused one, with the Console page that holds
 * the deny reason (the 401 itself is opaque by design).
 */
export function wifCredentials(settings: WifSettings): AccessTokenProvider {
  const exchange = oidcFederationProvider({
    identityTokenProvider: identityTokenProvider(settings),
    federationRuleId: settings.federationRuleId,
    organizationId: settings.organizationId,
    serviceAccountId: settings.serviceAccountId,
    workspaceId: settings.workspaceId,
    baseURL: ANTHROPIC_API_BASE_URL,
    fetch: exchangeFetch,
  });
  const source = tokenSource(settings);
  return async (opts) => {
    try {
      const token = await exchange(opts);
      // oidcFederationProvider always sets a numeric expiresAt (it throws on a
      // response without a finite expires_in), so the null of the shared type
      // never reaches here.
      const validFor = Number(token.expiresAt) - Math.floor(Date.now() / 1000);
      console.info(
        `[socialhq] Claude WIF token exchanged for rule ${settings.federationRuleId} (${source}); valid ${validFor}s.`,
      );
      return token;
    } catch (err) {
      // Every source throws an Error: the SDK's WorkloadIdentityError (body
      // already redacted) or AnthropicError (the token file), or WifSetupError.
      const { name, message } = err as Error;
      console.error(
        `[socialhq] Claude WIF token exchange FAILED for rule ${settings.federationRuleId} (${source}, ${name}: ${message}). ` +
          "No API key fallback: the Social HQ call fails. Deny reasons: Claude Console, Workload identity, authentication history.",
      );
      throw err;
    }
  };
}
