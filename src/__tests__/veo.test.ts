import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Coverage for veo.ts, the P5 Vertex AI Veo (video generation) client.
 *
 * Everything here is against a mocked `fetch` and a mocked `GoogleAuth` — the
 * real Vertex API is never called (per the phase brief). The shape pinned by
 * these tests (URLs, request bodies, response parsing) is exactly the shape
 * documented in veo.ts's own top-of-file vendor-facts block; see that
 * docblock for the doc URLs each assertion traces back to.
 */

const mockGetAccessToken = vi.hoisted(() => vi.fn());
vi.mock("google-auth-library", () => ({
  GoogleAuth: class {
    getAccessToken = mockGetAccessToken;
  },
}));

import { startVideoGeneration, pollVideoOperation, VeoError, type VeoGenerationRequest } from "../veo.js";
import { setEngineDeployment } from "../settings.js";
import { FIXTURE_GCP_PROJECT } from "./helpers/fixtures.js";

const ENV_KEYS = ["VERTEX_PROJECT_ID", "SOCIALMETA_VEO_LOCATION", "SOCIALMETA_VEO_MODEL"] as const;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let fetchMock: ReturnType<typeof vi.fn>;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  setEngineDeployment({ vertexProject: FIXTURE_GCP_PROJECT });
  mockGetAccessToken.mockReset();
  mockGetAccessToken.mockResolvedValue("fake-adc-token");
  fetchMock = vi.fn(async () => jsonResponse({ name: "projects/p/locations/us-central1/publishers/google/models/m/operations/op-1" }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function lastCall(): { url: string; init: RequestInit } {
  const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  return { url: String(url), init: init as RequestInit };
}

function sentBody(): Record<string, unknown> {
  return JSON.parse(String(lastCall().init.body));
}

describe("startVideoGeneration", () => {
  it("refuses before any request when no GCP project is configured", async () => {
    setEngineDeployment({});
    await expect(startVideoGeneration({ prompt: "p" } as VeoGenerationRequest)).rejects.toThrow(/Veo needs a GCP project/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  const MINIMAL: VeoGenerationRequest = { prompt: "a cat reading a book" };

  it("hits predictLongRunning at the default project/location/model", async () => {
    await startVideoGeneration(MINIMAL);
    const { url } = lastCall();
    expect(url).toBe(
      "https://us-central1-aiplatform.googleapis.com/v1/projects/example-project/locations/us-central1/publishers/google/models/veo-3.1-fast-generate-001:predictLongRunning",
    );
  });

  it("honors env overrides for project, location and model", async () => {
    process.env.VERTEX_PROJECT_ID = "my-project";
    process.env.SOCIALMETA_VEO_LOCATION = "us-west1";
    process.env.SOCIALMETA_VEO_MODEL = "veo-2.0-generate-001";
    await startVideoGeneration(MINIMAL);
    const { url } = lastCall();
    expect(url).toBe(
      "https://us-west1-aiplatform.googleapis.com/v1/projects/my-project/locations/us-west1/publishers/google/models/veo-2.0-generate-001:predictLongRunning",
    );
  });

  it("lets a per-call model override win over the configured default", async () => {
    await startVideoGeneration({ ...MINIMAL, model: "veo-3.1-generate-preview" });
    const { url } = lastCall();
    expect(url).toContain("/models/veo-3.1-generate-preview:predictLongRunning");
  });

  it("sends the prompt inside instances[0], not parameters", async () => {
    await startVideoGeneration(MINIMAL);
    const body = sentBody();
    expect(body.instances).toEqual([{ prompt: "a cat reading a book" }]);
  });

  it("sends the POST body with the documented instances/parameters split, omitting unset optional fields", async () => {
    await startVideoGeneration(MINIMAL);
    const body = sentBody();
    expect(body).toEqual({ instances: [{ prompt: "a cat reading a book" }], parameters: {} });
  });

  it("maps every optional field into parameters when provided", async () => {
    await startVideoGeneration({
      prompt: "a dog surfing",
      aspectRatio: "9:16",
      durationSeconds: 6,
      enhancePrompt: false,
      storageUri: "gs://bucket/prefix",
      sampleCount: 2,
      negativePrompt: "no logos",
      seed: 42,
      personGeneration: "allow_adult",
    });
    const body = sentBody();
    expect(body.parameters).toEqual({
      aspectRatio: "9:16",
      durationSeconds: 6,
      enhancePrompt: false,
      storageUri: "gs://bucket/prefix",
      sampleCount: 2,
      negativePrompt: "no logos",
      seed: 42,
      personGeneration: "allow_adult",
    });
  });

  // The whole point of leaving enhancePrompt unset when the caller doesn't
  // pass it: Vertex's own default (ON) must be what actually happens, not a
  // value this client silently injects. See VeoGenerationRequest's docblock.
  it("does NOT inject a default for enhancePrompt when the caller omits it", async () => {
    await startVideoGeneration(MINIMAL);
    const body = sentBody();
    expect(body.parameters).not.toHaveProperty("enhancePrompt");
  });

  it("sends the ADC bearer token and JSON content-type", async () => {
    await startVideoGeneration(MINIMAL);
    const { init } = lastCall();
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer fake-adc-token");
    expect(headers["content-type"]).toBe("application/json");
  });

  it("returns the operation name from the response", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ name: "projects/example-project/locations/us-central1/publishers/google/models/veo-3.1-fast-generate-001/operations/abc123" }),
    );
    const name = await startVideoGeneration(MINIMAL);
    expect(name).toBe(
      "projects/example-project/locations/us-central1/publishers/google/models/veo-3.1-fast-generate-001/operations/abc123",
    );
  });

  it("throws VeoError, not a silent failure, when the response carries no operation name", async () => {
    fetchMock.mockImplementation(async () => jsonResponse({}));
    await expect(startVideoGeneration(MINIMAL)).rejects.toThrow(VeoError);
    await expect(startVideoGeneration(MINIMAL)).rejects.toThrow(/no operation name/);
  });

  it("throws VeoError when no ADC token is available", async () => {
    mockGetAccessToken.mockResolvedValueOnce(null);
    await expect(startVideoGeneration(MINIMAL)).rejects.toThrow(/Application Default Credentials/);
  });

  it("throws VeoError with the vendor message on a non-2xx response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: "quota exceeded" } }, 429));
    await expect(startVideoGeneration(MINIMAL)).rejects.toThrow(/quota exceeded/);
  });

  it("throws VeoError with a status-shaped message when the error envelope has no message", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 500));
    await expect(startVideoGeneration(MINIMAL)).rejects.toThrow(/HTTP 500/);
  });

  it("throws VeoError on a non-JSON response", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html>not json</html>", { status: 200 }));
    await expect(startVideoGeneration(MINIMAL)).rejects.toThrow(/non-JSON response/);
  });

  it("throws VeoError on a transport failure", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    await expect(startVideoGeneration(MINIMAL)).rejects.toThrow(/network down/);
  });
});

const RUNNING_OPERATION =
  "projects/example-project/locations/us-central1/publishers/google/models/veo-3.1-fast-generate-001/operations/op-42";

describe("pollVideoOperation", () => {
  it("hits fetchPredictOperation at the resource path derived from the operation name", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ name: RUNNING_OPERATION, done: false }));
    await pollVideoOperation(RUNNING_OPERATION);
    const { url } = lastCall();
    expect(url).toBe(
      "https://us-central1-aiplatform.googleapis.com/v1/projects/example-project/locations/us-central1/publishers/google/models/veo-3.1-fast-generate-001:fetchPredictOperation",
    );
  });

  it("derives the host/location from the operation name, NOT from vertexVideoConfig() (self-describing handle)", async () => {
    process.env.SOCIALMETA_VEO_LOCATION = "us-west1"; // must NOT affect polling an existing us-central1 operation
    fetchMock.mockResolvedValueOnce(jsonResponse({ name: RUNNING_OPERATION, done: false }));
    await pollVideoOperation(RUNNING_OPERATION);
    const { url } = lastCall();
    expect(url).toContain("https://us-central1-aiplatform.googleapis.com/");
  });

  it("sends {operationName} as the POST body", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ name: RUNNING_OPERATION, done: false }));
    await pollVideoOperation(RUNNING_OPERATION);
    expect(sentBody()).toEqual({ operationName: RUNNING_OPERATION });
  });

  it("rejects a malformed operation name before ever calling fetch", async () => {
    await expect(pollVideoOperation("not-a-real-operation-name")).rejects.toThrow(VeoError);
    await expect(pollVideoOperation("not-a-real-operation-name")).rejects.toThrow(/does not match the expected shape/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * ⛔ The location segment is interpolated into the HOST (veoHost), so a
   * stored operation name carrying `locations/x@evil.example` would send the
   * ADC bearer token to `x@evil.example-aiplatform.googleapis.com`.
   * OPERATION_NAME_RE's narrow location class is the guard; this pins it.
   */
  it("refuses a location that would redirect the host, before any token is fetched or sent", async () => {
    const hostile = "projects/p/locations/x@evil.example/publishers/google/models/m/operations/op-1";
    await expect(pollVideoOperation(hostile)).rejects.toBeInstanceOf(VeoError);
    await expect(pollVideoOperation(hostile)).rejects.toThrow(/does not match the expected shape/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockGetAccessToken).not.toHaveBeenCalled();
  });

  describe("still running", () => {
    it("reports running when done is false", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ name: RUNNING_OPERATION, done: false }));
      await expect(pollVideoOperation(RUNNING_OPERATION)).resolves.toEqual({ status: "running" });
    });

    it("reports running when done is simply absent", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ name: RUNNING_OPERATION }));
      await expect(pollVideoOperation(RUNNING_OPERATION)).resolves.toEqual({ status: "running" });
    });
  });

  describe("succeeded", () => {
    it("parses a GCS-URI video result (storageUri path)", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          name: RUNNING_OPERATION,
          done: true,
          response: {
            raiMediaFilteredCount: 0,
            videos: [{ gcsUri: "gs://bucket/out/sample_0.mp4", mimeType: "video/mp4" }],
          },
        }),
      );
      const result = await pollVideoOperation(RUNNING_OPERATION);
      expect(result).toEqual({
        status: "succeeded",
        videos: [{ uri: "gs://bucket/out/sample_0.mp4", videoBytes: undefined, mimeType: "video/mp4", enhancedPrompt: undefined }],
        raiFilteredCount: 0,
        raiFilteredReasons: undefined,
      });
    });

    it("parses an inline base64 video result (no storageUri was set on the request)", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          name: RUNNING_OPERATION,
          done: true,
          response: {
            videos: [{ bytesBase64Encoded: "QUJD", mimeType: "video/mp4" }],
          },
        }),
      );
      const result = await pollVideoOperation(RUNNING_OPERATION);
      expect(result.status).toBe("succeeded");
      if (result.status === "succeeded") {
        expect(result.videos[0]).toEqual({
          uri: undefined,
          videoBytes: "QUJD",
          mimeType: "video/mp4",
          enhancedPrompt: undefined,
        });
      }
    });

    it("surfaces raiMediaFilteredCount/Reasons when present", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          name: RUNNING_OPERATION,
          done: true,
          response: {
            raiMediaFilteredCount: 1,
            raiMediaFilteredReasons: ["adult content"],
            videos: [],
          },
        }),
      );
      const result = await pollVideoOperation(RUNNING_OPERATION);
      expect(result).toMatchObject({ raiFilteredCount: 1, raiFilteredReasons: ["adult content"] });
    });

    // extractEnhancedPrompt is explicitly BEST-EFFORT/unverified (see veo.ts's
    // docblock) — it must not throw or drop the video when the field is
    // absent, and must pick it up under any of the plausible key spellings.
    it.each([["prompt"], ["revisedPrompt"], ["enhancedPrompt"]])(
      "picks up a rewritten prompt under the %s key, defensively",
      async (key) => {
        fetchMock.mockResolvedValueOnce(
          jsonResponse({
            name: RUNNING_OPERATION,
            done: true,
            response: { videos: [{ gcsUri: "gs://b/v.mp4", mimeType: "video/mp4", [key]: "a rewritten prompt" }] },
          }),
        );
        const result = await pollVideoOperation(RUNNING_OPERATION);
        expect(result.status).toBe("succeeded");
        if (result.status === "succeeded") {
          expect(result.videos[0].enhancedPrompt).toBe("a rewritten prompt");
        }
      },
    );

    it("leaves enhancedPrompt undefined, not throwing, when no plausible key is present", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          name: RUNNING_OPERATION,
          done: true,
          response: { videos: [{ gcsUri: "gs://b/v.mp4", mimeType: "video/mp4" }] },
        }),
      );
      const result = await pollVideoOperation(RUNNING_OPERATION);
      expect(result.status).toBe("succeeded");
      if (result.status === "succeeded") {
        expect(result.videos[0].enhancedPrompt).toBeUndefined();
      }
    });

    it("tolerates a missing/malformed response object rather than throwing", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ name: RUNNING_OPERATION, done: true }));
      const result = await pollVideoOperation(RUNNING_OPERATION);
      expect(result).toEqual({ status: "succeeded", videos: [], raiFilteredCount: undefined, raiFilteredReasons: undefined });
    });
  });

  describe("failed", () => {
    it("reports failed with the vendor's code/message/details", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          name: RUNNING_OPERATION,
          done: true,
          error: { code: 3, message: "invalid prompt", details: [{ reason: "SAFETY" }] },
        }),
      );
      const result = await pollVideoOperation(RUNNING_OPERATION);
      expect(result).toEqual({
        status: "failed",
        error: { code: 3, message: "invalid prompt", details: [{ reason: "SAFETY" }] },
      });
    });

    it("falls back to a synthesized message when the error has none", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ name: RUNNING_OPERATION, done: true, error: {} }));
      const result = await pollVideoOperation(RUNNING_OPERATION);
      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.error.message).toMatch(/failed with no message/);
        expect(result.error.code).toBeUndefined();
      }
    });
  });

  it("throws VeoError on a non-2xx response from fetchPredictOperation itself", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: "operation not found" } }, 404));
    await expect(pollVideoOperation(RUNNING_OPERATION)).rejects.toThrow(/operation not found/);
  });
});

describe("VeoError", () => {
  it("carries status and body, and names itself VeoError", () => {
    const err = new VeoError("boom", 500, { detail: true });
    expect(err.name).toBe("VeoError");
    expect(err.status).toBe(500);
    expect(err.body).toEqual({ detail: true });
    expect(err).toBeInstanceOf(Error);
  });
});

describe("veo transport failures and sparse video entries", () => {
  it("reports a request timeout as its own status-0 VeoError", async () => {
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    fetchMock.mockRejectedValueOnce(timeout);

    const err = (await startVideoGeneration({ prompt: "p" }).catch((e: unknown) => e)) as VeoError;

    expect(err).toBeInstanceOf(VeoError);
    expect(err.status).toBe(0);
    expect(err.message).toMatch(
      /^Vertex AI: no response after \d+s \(the request may still complete server-side; check before retrying a publish\)$/,
    );
  });

  it("stringifies a non-Error transport rejection", async () => {
    fetchMock.mockRejectedValueOnce("socket hang up");
    const err = (await startVideoGeneration({ prompt: "p" }).catch((e: unknown) => e)) as VeoError;
    expect(err).toBeInstanceOf(VeoError);
    expect(err.message).toBe("socket hang up");
  });

  it("reads an empty 200 body as a response with no operation name", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 200 }));
    await expect(startVideoGeneration({ prompt: "p" })).rejects.toThrow(/no operation name/);
  });

  it("reads a mimeType-less video entry as an all-undefined video, and refuses a null one", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ name: RUNNING_OPERATION, done: true, response: { videos: [{ gcsUri: "gs://b/v.mp4" }] } }),
    );
    await expect(pollVideoOperation(RUNNING_OPERATION)).resolves.toMatchObject({
      status: "succeeded",
      videos: [{ uri: "gs://b/v.mp4", videoBytes: undefined, mimeType: undefined, enhancedPrompt: undefined }],
    });

    fetchMock.mockResolvedValueOnce(
      jsonResponse({ name: RUNNING_OPERATION, done: true, response: { videos: [null] } }),
    );
    await expect(pollVideoOperation(RUNNING_OPERATION)).rejects.toThrow(
      /vertex POST :fetchPredictOperation: unexpected response shape at response\.videos\[0\]: expected an object, got null/,
    );
  });
});
