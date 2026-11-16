import { GoogleAuth } from "google-auth-library";
import { vertexVideoConfig } from "./settings.js";
import { vendorFetch } from "./vendor-fetch.js";

/**
 * Vertex AI Veo (video generation) client. Text calls go through claude.ts;
 * video is on Vertex.
 *
 * WHY THIS IS RAW `fetch`, NOT `@google/genai` (a website dependency, used
 * elsewhere for Gemini): video generation is a long-running operation (LRO), not a
 * synchronous call, and the @google/genai SDK (v2.11.0, installed here) has
 * two properties that make it the wrong tool for THIS half of the job:
 *
 *   1. `operations.getVideosOperation()` takes a whole `GenerateVideosOperation`
 *      *instance* (a class with a `_fromAPIResponse` method), not a bare
 *      operation-name string — reconstructing one from a string persisted in
 *      a job row (by a separate scheduled releaser) is awkward for no
 *      benefit, whereas the raw REST `fetchPredictOperation` call needs only
 *      the name (confirmed by reading the SDK's own
 *      `getVideosOperationInternal`/`fetchPredictVideosOperationInternal` in
 *      node_modules/@google/genai/dist/node/index.cjs: for Vertex it derives
 *      `resourceName` by splitting `operation.name` on `/operations/` and
 *      needs nothing else off the object).
 *   2. The SDK's own response mapper for video
 *      (`videoFromVertex`/`generatedVideoFromVertex` in that same file) maps
 *      ONLY `gcsUri` -> `uri`, `bytesBase64Encoded` -> `videoBytes`, and
 *      `mimeType` — no prompt-rewrite field, unlike its Imagen counterpart
 *      (`generatedImageFromVertex`, which explicitly maps a `prompt` field to
 *      `enhancedPrompt`). Since this client's whole job includes capturing the
 *      enhanced prompt if Vertex sends one back (see `extractEnhancedPrompt`
 *      below), going through the SDK would silently discard it even if a
 *      future Veo response includes it under a key the SDK hasn't been taught
 *      yet. A raw client sees the whole JSON body and can defend against that.
 *
 * Auth: this file cannot import the app's Google auth helpers (no `@/`
 * aliases inside the engine), so it goes straight to `google-auth-library`'s
 * `GoogleAuth` (already a direct dependency, and the same library
 * @google/genai itself uses internally for `vertexai: true` clients). No
 * impersonation: Veo calls run as the process's own identity, its
 * Application Default Credentials. `GoogleAuth` caches its resolved client and that client
 * caches/refreshes its own token internally, so a bare module-level instance
 * is sufficient; see `accessToken()`.
 *
 * ⛔ THE LOCATION TRAP: Veo has NO `global` endpoint and 404s THERE, serving
 * only from regional hosts (`us-central1` etc), which is why
 * `vertexVideoConfig()` in settings.ts pins a region.
 *
 * ⛔ THE OPERATION-NAME TRAP: `startVideoGeneration` kicks off a PAID
 * generation and returns only the operation name. That name is the ONLY
 * handle on that in-flight job — there is no "list my running operations"
 * call used here, and nothing in this module retries losing it. If the
 * caller drops the returned name (a crash between the API call and writing
 * it to storage, a swallowed exception, ...), the generation still runs and
 * still bills, but becomes unreachable: it can never be polled, its result
 * can never be fetched, and it cannot be identified for cleanup. Persist the
 * returned name BEFORE doing anything else with it.
 *
 * Engine rules apply: relative imports only, no `@/`, no prisma, no next.
 *
 * ---
 * VENDOR FACTS: verified against official Google Cloud docs unless marked
 * ASSUMED. Doc URLs are under
 * docs.cloud.google.com/gemini-enterprise-agent-platform/... (cloud.google.com
 * redirects there as of this writing) and the equivalent REST reference
 * mirror at cloud.google.com/vertex-ai/generative-ai/docs/reference/rest/...
 *
 *  - Kickoff URL/verb (PROVEN — .../models/video/remove-objects-from-videos,
 *    a PowerShell example, and the SDK source at
 *    node_modules/@google/genai/dist/node/index.cjs:13594 all agree):
 *      POST https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/publishers/google/models/{model}:predictLongRunning
 *    Body: `{"instances": [{"prompt": "..."}], "parameters": {...}}`.
 *    Response: an `Operation`-shaped body; the field this client needs is
 *    `name` (PROVEN — the general Operation resource reference, and every
 *    fetchPredictOperation example, both key off it).
 *
 *  - Poll URL/verb (PROVEN — .../models/video/generate-videos-from-text):
 *      POST https://{location}-aiplatform.googleapis.com/v1/{resourceName}:fetchPredictOperation
 *      body: {"operationName": "projects/{p}/locations/{l}/publishers/google/models/{m}/operations/{id}"}
 *    where `resourceName` is that same string with the `/operations/{id}`
 *    suffix removed — i.e. fully recoverable from the operation name alone
 *    (also PROVEN from the SDK's own `fetchPredictVideosOperationInternal`,
 *    which derives it the same way). This is why `pollVideoOperation` below
 *    takes only `operationName` and no separate project/location/model
 *    arguments — they are encoded in the name Vertex already gave us.
 *
 *  - Running vs. done (PROVEN — the general Operation resource doc): `done`
 *    is `false` (or, per that same doc, may simply be absent) while in
 *    progress; once `true`, exactly one of `error` or `response` is set.
 *    This client treats anything other than `done === true` as "running",
 *    which covers both cases.
 *
 *  - Success response shape (PROVEN — response example on
 *    .../models/video/generate-videos-from-text and
 *    .../models/video/extend-a-veo-video, byte for byte identical):
 *      { "name": "...", "done": true,
 *        "response": { "raiMediaFilteredCount": 0,
 *                       "videos": [{ "gcsUri": "gs://...", "mimeType": "video/mp4" }] } }
 *
 *  - GCS URI vs inline base64 (PROVEN, and OBSERVED LIVE:
 *    .../models/video/use-reference-images-to-guide-video-generation: "Output
 *    can be directed to a specified Cloud Storage bucket, or returned
 *    directly as base64-encoded video data if no bucket is provided."):
 *    `parameters.storageUri` set -> each video has `gcsUri`; omitted -> each
 *    video has `bytesBase64Encoded` instead. Both map to `mimeType` too.
 *    Field names (`gcsUri`/`bytesBase64Encoded`) cross-checked against
 *    @google/genai's own `videoFromVertex` mapper, which reads exactly those
 *    two keys.
 *    LIVE RUN: one `veo-3.1-fast-generate-001` generation, 8s at 9:16, no
 *    `storageUri`, took ~68s wall clock over 4 polls and came back inline as
 *    documented — 4,358,104 base64 chars decoding to a 3.12 MB valid mp4
 *    (`ftypisom`). `response.@type` is
 *    `type.googleapis.com/cloud.ai.large_models.vision.GenerateVideoResponse`
 *    and `raiMediaFilteredCount` was 0. So the inline branch is the live path
 *    at this size, and the 30s REQUEST_TIMEOUT_MS is comfortable for it.
 *
 *  - Failure response shape (ASSUMED, not independently found rendered for
 *    Veo specifically): the general Operation resource doc documents an
 *    `error` field "in case of failure or cancellation" without expanding its
 *    schema on the page fetched. This is the standard `google.rpc.Status`
 *    envelope (`{code, message, details}`) used across every Google Cloud
 *    long-running operation, which is why it's assumed here rather than
 *    invented from nothing — but no Veo-specific example response showing a
 *    populated `error` was found to confirm it byte-for-byte.
 *
 *  - `enhancePrompt` default (PROVEN —
 *    .../models/video/turn-the-prompt-rewriter-off: "this feature is enabled
 *    by default... to improve video quality") and its return condition
 *    (documented, same page: "the system only delivers a rewritten prompt via
 *    API response if the original input is fewer than 30 words long").
 *    ⛔ THAT RETURN CONDITION DOES NOT HOLD, ON ANY TIER. Live runs with a
 *    deliberately 22-word prompt (i.e. inside the documented threshold)
 *    on ALL THREE of `veo-3.1-fast-generate-001`, `veo-3.1-generate-001` and
 *    `veo-3.1-lite-generate-001` each came back with a `videos[0]` object
 *    carrying EXACTLY TWO KEYS, `bytesBase64Encoded` and `mimeType`. No
 *    rewritten prompt under any spelling, and nothing at the `response` level
 *    either. Treat `enhancedPrompt` as "never populated by the 3.1 family"
 *    rather than "populated for short prompts" — see `extractEnhancedPrompt`.
 *
 *  - `durationSeconds` / `aspectRatio` for veo-3.1-fast-generate-001 (PROVEN —
 *    .../models/veo/3-1-generate, "3.1 Fast Generate > Technical
 *    specifications": "support for 4, 6, or 8-second video lengths... Supported
 *    aspect ratios are 9:16 and 16:9"). Not modeled as a TypeScript literal
 *    union here because `model` is itself overridable per call and other Veo
 *    models validate differently (the same docs, elsewhere, describe Veo 2 as
 *    accepting 5-8 continuous seconds) — Vertex is the real validator; a
 *    wrong value surfaces as a `VeoError` from a 400 response.
 *
 *  - API version: every fetched official example (PowerShell snippet, the two
 *    REST APIDOC blocks) uses `/v1/`. Note @google/genai's OWN default Vertex
 *    REST version for everything it calls (text, image, video alike) is
 *    `v1beta1` (node_modules/@google/genai/dist/node/index.cjs:13529) — this
 *    client uses `/v1/` on the strength of the Veo-specific docs rather than
 *    the SDK's unrelated umbrella default, but the discrepancy is worth
 *    knowing about if this ever needs to move to `v1beta1`.
 */

const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const VERTEX_API_VERSION = "v1";
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * ADC client for calling Vertex AI directly. `GoogleAuth` memoizes both the
 * resolved client (`getClient()`) and that client's token internally, so a
 * bare module-level instance needs no extra caching layer on top.
 */
const auth = new GoogleAuth({ scopes: [CLOUD_PLATFORM_SCOPE] });

async function accessToken(): Promise<string> {
  const token = await auth.getAccessToken();
  if (!token) {
    throw new VeoError(
      "no access token from Application Default Credentials " +
        "(run `gcloud auth application-default login` locally, or check the runtime's workload identity binding in prod)",
      0,
      null,
    );
  }
  return token;
}

function veoHost(location: string): string {
  return `https://${location}-aiplatform.googleapis.com`;
}

/** A Vertex AI / Veo request error: transport failure, non-2xx, or a malformed operation name. */
export class VeoError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown = null,
  ) {
    super(message);
    this.name = "VeoError";
  }
}

async function postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  const token = await accessToken();
  const response = await vendorFetch(
    url,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
    {
      timeoutMs: REQUEST_TIMEOUT_MS,
      label: "Vertex AI",
      wrap: (status, message) => new VeoError(message, status, null),
    },
  );

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new VeoError(
      `Vertex AI returned a non-JSON response (${response.status}): ${text.slice(0, 200)}`,
      response.status,
      text,
    );
  }

  if (!response.ok) {
    // Standard Google Cloud REST error envelope: {"error": {"code","message","status"}}.
    const envelope = parsed as { error?: { message?: string } };
    throw new VeoError(
      envelope.error?.message ?? `Vertex AI request failed with HTTP ${response.status}`,
      response.status,
      parsed,
    );
  }

  return parsed as Record<string, unknown>;
}

/**
 * Request shape for `startVideoGeneration`. Mirrors the documented
 * `predictLongRunning` `instances[0]`/`parameters` split — `prompt` rides in
 * `instances`, everything else in `parameters` (see `buildParameters`).
 */
export interface VeoGenerationRequest {
  /** The text prompt. Required — Veo also supports image/video-conditioned generation, not modeled here. */
  prompt: string;
  /** Defaults to vertexVideoConfig().model (veo-3.1-fast-generate-001). */
  model?: string;
  /** "16:9" (landscape) or "9:16" (portrait) — the only two values documented for the Veo 3.x family. */
  aspectRatio?: "16:9" | "9:16";
  /**
   * Seconds of output. Valid sets are MODEL-DEPENDENT (Veo 3.x family,
   * including veo-3.1-fast-generate-001: 4, 6, or 8; Veo 2: 5-8) — see the
   * top-of-file vendor-facts block. Not narrowed to a literal type since
   * `model` above can override the default and Vertex is the real validator.
   */
  durationSeconds?: number;
  /**
   * ⚠️ Defaults to `true` ON VERTEX'S SIDE when omitted — this client does
   * NOT send a default for this field, it only sends what the caller passes.
   * A `true` (or omitted) value means the prompt Vertex actually generates
   * from is NOT necessarily the `prompt` string above: Vertex may rewrite it
   * first. That makes a generation irreproducible from the stored request
   * alone unless the rewritten prompt is captured from the result — see
   * `VeoGeneratedVideo.enhancedPrompt` and `extractEnhancedPrompt`'s
   * docblock. Set explicitly to `false` to guarantee the sent prompt is the
   * one used.
   */
  enhancePrompt?: boolean;
  /**
   * GCS URI prefix (e.g. "gs://bucket/prefix") to write output video(s) to.
   * OMITTING this returns the video inline as base64
   * (`VeoGeneratedVideo.videoBytes`) instead of as a GCS URI
   * (`VeoGeneratedVideo.uri`) — see the top-of-file vendor-facts block.
   */
  storageUri?: string;
  /** Number of videos to generate for this prompt (1-4 per Google's docs). */
  sampleCount?: number;
  negativePrompt?: string;
  /** 0-4294967295, for deterministic output when held constant across calls with unchanged inputs. */
  seed?: number;
  personGeneration?: "dont_allow" | "allow_adult";
}

function buildParameters(input: VeoGenerationRequest): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (input.aspectRatio !== undefined) params.aspectRatio = input.aspectRatio;
  if (input.durationSeconds !== undefined) params.durationSeconds = input.durationSeconds;
  if (input.enhancePrompt !== undefined) params.enhancePrompt = input.enhancePrompt;
  if (input.storageUri !== undefined) params.storageUri = input.storageUri;
  if (input.sampleCount !== undefined) params.sampleCount = input.sampleCount;
  if (input.negativePrompt !== undefined) params.negativePrompt = input.negativePrompt;
  if (input.seed !== undefined) params.seed = input.seed;
  if (input.personGeneration !== undefined) params.personGeneration = input.personGeneration;
  return params;
}

/**
 * Starts a Veo video generation and returns the operation name — the only
 * handle on that (now billing) job. See the top-of-file "OPERATION-NAME TRAP"
 * warning: persist this before doing anything else with it.
 */
export async function startVideoGeneration(input: VeoGenerationRequest): Promise<string> {
  const config = vertexVideoConfig();
  if (!config.project) {
    throw new Error("Veo needs a GCP project: set VERTEX_PROJECT_ID or setEngineDeployment({ vertexProject })");
  }
  const model = input.model ?? config.model;
  const url = `${veoHost(config.location)}/${VERTEX_API_VERSION}/projects/${config.project}/locations/${config.location}/publishers/google/models/${model}:predictLongRunning`;

  const json = await postJson(url, {
    instances: [{ prompt: input.prompt }],
    parameters: buildParameters(input),
  });

  const name = json.name;
  if (typeof name !== "string" || !name) {
    throw new VeoError(
      "predictLongRunning returned no operation name — if this generation actually started on Vertex's side, it is now unreachable (see the OPERATION-NAME TRAP warning at the top of this file)",
      0,
      json,
    );
  }
  return name;
}

/** One generated video from a succeeded operation. */
export interface VeoGeneratedVideo {
  /** GCS URI, present when the originating request set `storageUri`. */
  uri?: string;
  /** Inline base64 video bytes, present when the originating request did NOT set `storageUri`. */
  videoBytes?: string;
  mimeType?: string;
  /**
   * Vertex's rewritten prompt for this video, if it returned one. See this
   * function's own docblock (`extractEnhancedPrompt`, defined below) for the
   * confidence level on this field.
   */
  enhancedPrompt?: string;
}

export interface VeoOperationError {
  code?: number;
  message: string;
  details?: unknown[];
}

/**
 * Outcome of polling one operation. A discriminated union on `status` so
 * callers must branch rather than accidentally reading `.videos` off a
 * still-running or failed result.
 */
export type VeoOperationResult =
  | { status: "running" }
  | {
      status: "succeeded";
      videos: VeoGeneratedVideo[];
      raiFilteredCount?: number;
      raiFilteredReasons?: string[];
    }
  | { status: "failed"; error: VeoOperationError };

// The `locations/` capture is deliberately NARROWER than the others: that one
// segment is interpolated into the HOST by veoHost(), so a stored operation
// name carrying `locations/x@evil.example` would send the request (with an ADC
// bearer token) to `x@evil.example-aiplatform.googleapis.com`. Real serving
// locations are lowercase alphanumerics and hyphens ("us-central1", "global"),
// so nothing legitimate is excluded. project/model stay `[^/]+` — they only
// reach the path.
const OPERATION_NAME_RE =
  /^projects\/([^/]+)\/locations\/([a-z0-9-]+)\/publishers\/google\/models\/([^/]+)\/operations\/([^/]+)$/;

/**
 * Recovers the pieces `fetchPredictOperation` needs (resource path + serving
 * location) straight out of the operation name Vertex handed back from
 * `startVideoGeneration` — no separately-stored project/location/model
 * required. See the top-of-file vendor-facts block for why this is safe
 * (confirmed against both the official docs and the SDK's own derivation).
 */
function parseOperationName(operationName: string): { resourceName: string; location: string } {
  const match = OPERATION_NAME_RE.exec(operationName);
  if (!match) {
    throw new VeoError(
      `operation name does not match the expected shape "projects/{project}/locations/{location}/publishers/google/models/{model}/operations/{id}": ${operationName}`,
      0,
      null,
    );
  }
  const [, project, location, model] = match;
  return {
    resourceName: `projects/${project}/locations/${location}/publishers/google/models/${model}`,
    location,
  };
}

/**
 * Best-effort extraction of the prompt-rewriter's output for one generated
 * video.
 *
 * ⛔ A REAL RESPONSE PAYLOAD SETTLES THIS, and the answer is that the field
 * does not appear at all. A live run on `veo-3.1-fast-generate-001`,
 * with a 22-word prompt chosen specifically to sit INSIDE the documented
 * "fewer than 30 words" threshold at which Google says a rewritten prompt is
 * returned. The response's `videos[0]` had exactly two keys:
 * `bytesBase64Encoded` and `mimeType`. Nothing prompt-shaped anywhere in the
 * body. So the documented return condition is either wrong, model-specific,
 * or silently disabled for this model.
 *
 * This function is therefore expected to return `undefined` ALWAYS in current
 * practice, and a caller's stored `enhancedPrompt` is expected to stay null. It
 * is kept rather than deleted for two reasons: it costs nothing, and the
 * moment Vertex does start returning a rewrite, silently discarding it would
 * make generations irreproducible, which is the whole reason a caller stores
 * it. The one confirmed sibling spelling is Imagen's
 * `generatedImages[].prompt` (which @google/genai v2.11.0 maps to
 * `enhancedPrompt`); its video mapper has no equivalent, i.e. the SDK does
 * not claim to know this field for Veo either. The three spellings below are
 * defensive guesses, not observed keys.
 */
function extractEnhancedPrompt(raw: Record<string, unknown>): string | undefined {
  for (const key of ["prompt", "revisedPrompt", "enhancedPrompt"]) {
    const value = raw[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function parseGeneratedVideo(raw: unknown): VeoGeneratedVideo {
  const v = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    uri: typeof v.gcsUri === "string" ? v.gcsUri : undefined,
    videoBytes: typeof v.bytesBase64Encoded === "string" ? v.bytesBase64Encoded : undefined,
    mimeType: typeof v.mimeType === "string" ? v.mimeType : undefined,
    enhancedPrompt: extractEnhancedPrompt(v),
  };
}

/**
 * Checks an operation ONCE and returns its current state. Does NOT loop or
 * sleep internally — polling cadence belongs to the caller (the cron
 * releaser being built separately). A client that blocks inside a request
 * waiting on a minutes-long video render is the exact bug this design is
 * meant to avoid; compare claude.ts's synchronous `genJson` (fine for a
 * text call) with the LRO shape this file exists for.
 */
export async function pollVideoOperation(operationName: string): Promise<VeoOperationResult> {
  const { resourceName, location } = parseOperationName(operationName);
  const url = `${veoHost(location)}/${VERTEX_API_VERSION}/${resourceName}:fetchPredictOperation`;

  const json = await postJson(url, { operationName });

  if (json.done !== true) {
    return { status: "running" };
  }

  if (json.error) {
    const err = json.error as Record<string, unknown>;
    return {
      status: "failed",
      error: {
        code: typeof err.code === "number" ? err.code : undefined,
        message: typeof err.message === "string" ? err.message : `operation ${operationName} failed with no message`,
        details: Array.isArray(err.details) ? err.details : undefined,
      },
    };
  }

  const resp = (json.response && typeof json.response === "object" ? json.response : {}) as Record<
    string,
    unknown
  >;
  const rawVideos = Array.isArray(resp.videos) ? resp.videos : [];
  return {
    status: "succeeded",
    videos: rawVideos.map(parseGeneratedVideo),
    raiFilteredCount: typeof resp.raiMediaFilteredCount === "number" ? resp.raiMediaFilteredCount : undefined,
    raiFilteredReasons: Array.isArray(resp.raiMediaFilteredReasons)
      ? (resp.raiMediaFilteredReasons as string[])
      : undefined,
  };
}
