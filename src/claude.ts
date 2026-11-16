import Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_API_BASE_URL, tokenSource, wifCredentials, wifSettingsFromEnv } from "./anthropic-wif.js";
import type { ModelStamp } from "./types.js";

/**
 * Social HQ's text model: every draft, format, revise, QA review, idea,
 * triage, card and video plan, and the copilot, on Claude Sonnet 5.5 at effort
 * high.
 *
 * The DIRECT Anthropic API, with `ANTHROPIC_API_KEY` read through the injected
 * secret getter. Not Vertex: image generation and Veo stay on Google, and
 * nothing here touches them. A workload that carries the four WIF IDs
 * authenticates by workload identity federation instead (anthropic-wif.ts).
 *
 * ⛔ NO MODEL OR EFFORT ENV OVERRIDE, ON PURPOSE. The Gemini engine read
 * `SOCIALMETA_MODEL`, and every operator's local scripts/social/config.json
 * still names a Gemini model; honouring a variable here would let one stray
 * value send "gemini-3.5-flash-lite" to api.anthropic.com and 404 every call.
 *
 * ⛔ THINKING IS LEFT ADAPTIVE (the `thinking` field is omitted). On this model
 * `{type: "disabled"}` and `budget_tokens` are both a 400; effort is the knob.
 */
export const SOCIAL_TEXT_MODEL = "claude-sonnet-5-5";
export const SOCIAL_TEXT_EFFORT = "high";

/** The stamp a render or QA report carries when this module wrote it (types.ts ModelStamp). */
export function modelStamp(): ModelStamp {
  return { model: SOCIAL_TEXT_MODEL, effort: SOCIAL_TEXT_EFFORT };
}

/**
 * Output ceiling for one request, thinking included. Below the SDK's
 * non-streaming limit (it refuses a request whose `max_tokens` implies more than
 * ten minutes), and far above any reply these prompts ask for, so the ceiling
 * is there for runaway thinking, not for the answer.
 */
export const SOCIAL_TEXT_MAX_TOKENS = 16000;

/** The secret name of the key, as the injected getSecret reads it. */
export const ANTHROPIC_KEY_SECRET = "ANTHROPIC_API_KEY";

/** Reads a secret by name; rejects when it cannot be read. */
export type SecretGetter = (name: string) => Promise<string>;

let _getSecret: SecretGetter | null = null;

/**
 * How the key path reads ANTHROPIC_KEY_SECRET. The engine imports nothing
 * outside its own folder, so the application injects its own `getSecret` (for
 * example env first, then its secret store), the same way the transports get
 * their credential resolvers. The WIF path never reads a secret and does not need
 * it. Unset, the key path throws rather than build a client without a key.
 */
export function setSecretGetter(getter: SecretGetter | null): void {
  _getSecret = getter;
}

/** `wif:<settings>` or `key:<key>`: what the cached client was built from. */
let cached: { id: string; client: Anthropic } | null = null;

/**
 * The Anthropic client, on workload identity federation when the pod carries
 * the four WIF IDs, else on the key. Rebuilt only when its source changes.
 *
 * ⛔ WIF FIRST, AND THEN NOTHING ELSE (anthropic-wif.ts holds the reasons). A
 * workload with the four IDs never reads the key, and its client is built with
 * `apiKey: null, authToken: null` beside `credentials`. SDK v1 (0.135.0 ->
 * 1.7.0) holds one credential per client: with `credentials`
 * passed, the constructor never reads `ANTHROPIC_API_KEY` or
 * `ANTHROPIC_AUTH_TOKEN` from the environment (client.d.ts: "not read when one
 * of those options is passed"), so the two nulls no longer block anything;
 * they stay as the explicit no-key/no-token declaration, and claude.wif.test.ts
 * still runs the real SDK with both variables set to prove neither is sent. A
 * partial set throws here, before any client exists, and a refused exchange
 * throws from the request: neither falls back to the key. The client's
 * TokenCache exchanges once and refreshes 120 s before the token expires.
 *
 * Without the IDs the key path runs: the injected getSecret per call, so a
 * getter that reads a secret store (with a short cache) picks up a rotated key
 * without a restart, as long as the process environment does not pin the
 * name. In v1 the key goes out as `Authorization: Bearer` (never `x-api-key`);
 * pinned by the key-path test in claude.wif.test.ts.
 */
export async function socialClaude(): Promise<Anthropic> {
  const wif = wifSettingsFromEnv();
  if (wif) {
    const id = `wif:${JSON.stringify(wif)}`;
    if (cached?.id !== id) {
      cached = {
        id,
        client: new Anthropic({
          apiKey: null,
          authToken: null,
          baseURL: ANTHROPIC_API_BASE_URL,
          credentials: wifCredentials(wif),
        }),
      };
      console.info(
        `[socialhq] Claude auth: workload identity federation (rule ${wif.federationRuleId}, ${tokenSource(wif)})` +
          `${process.env.ANTHROPIC_API_KEY ? "; ANTHROPIC_API_KEY is set and NOT used" : ""}.`,
      );
    }
    return cached.client;
  }
  if (!_getSecret) {
    throw new Error(
      "no secret getter registered for the Claude key path (the app calls wireEngineSecrets, which calls setSecretGetter)",
    );
  }
  const key = await _getSecret(ANTHROPIC_KEY_SECRET);
  if (cached?.id !== `key:${key}`) cached = { id: `key:${key}`, client: new Anthropic({ apiKey: key }) };
  return cached.client;
}

/**
 * The model declined (`stop_reason: "refusal"`, HTTP 200). Never retried and
 * never read as an empty answer: QA turns any throw into a blocking
 * `llm-qa-unavailable`, so a refused review can never publish.
 */
export class ModelRefusedError extends Error {
  constructor(readonly category: string | null) {
    super(`the model declined the request (refusal${category ? `: ${category}` : ""})`);
    this.name = "ModelRefusedError";
  }
}

/** The model stopped before finishing (`max_tokens`, or any other non-final stop). */
export class ModelIncompleteError extends Error {
  constructor(readonly stopReason: string | null) {
    super(`the model stopped before finishing (stop_reason ${stopReason}); the partial reply was discarded`);
    this.name = "ModelIncompleteError";
  }
}

/**
 * The text of a finished reply, or a throw. Reads `stop_reason` BEFORE the
 * content, so a refusal or a truncated reply can never be parsed as an answer.
 */
export function finishedText(message: Anthropic.Message): string {
  if (message.stop_reason === "refusal") {
    throw new ModelRefusedError(message.stop_details?.category ?? null);
  }
  if (message.stop_reason !== "end_turn") throw new ModelIncompleteError(message.stop_reason);
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/** The image types the Messages API reads. */
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;

function imageBlock(m: { mimeType: string; dataBase64: string }): Anthropic.ImageBlockParam {
  const mediaType = IMAGE_TYPES.find((t) => t === m.mimeType.toLowerCase());
  if (!mediaType) {
    throw new Error(`the model reads only ${IMAGE_TYPES.join(", ")} images, not ${m.mimeType}`);
  }
  return { type: "image", source: { type: "base64", media_type: mediaType, data: m.dataBase64 } };
}

export interface GenJsonOptions {
  /**
   * JSON Schema for the reply, sent as structured output
   * (`output_config.format`). Objects need `additionalProperties: false`.
   * The decoder is constrained to it, so a reply that reaches the caller
   * always has this shape: the old per-caller `validate` retry loop, built for
   * Gemini returning a bare array instead of `{renders: [...]}`, has nothing
   * left to catch.
   */
  schema: Record<string, unknown>;
  system?: string;
  /** Defaults to SOCIAL_TEXT_MAX_TOKENS. */
  maxTokens?: number;
  /** Inline images, sent before the prompt. */
  media?: Array<{ mimeType: string; dataBase64: string }>;
}

/**
 * One structured-output call. Transient failures (429, 5xx, connection) are
 * retried by the SDK itself (2 retries, with backoff); a refusal or a truncated
 * reply throws, and every caller treats a throw as "no answer".
 */
export async function genJson<T>(prompt: string, opts: GenJsonOptions): Promise<T> {
  const client = await socialClaude();
  const message = await client.messages.create({
    model: SOCIAL_TEXT_MODEL,
    max_tokens: opts.maxTokens ?? SOCIAL_TEXT_MAX_TOKENS,
    output_config: {
      effort: SOCIAL_TEXT_EFFORT,
      format: { type: "json_schema", schema: opts.schema },
    },
    ...(opts.system ? { system: opts.system } : {}),
    messages: [
      {
        role: "user",
        content: [...(opts.media ?? []).map(imageBlock), { type: "text", text: prompt }],
      },
    ],
  });
  return JSON.parse(finishedText(message)) as T;
}
