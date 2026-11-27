// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

/**
 * claude.ts: Social HQ's one text path (Claude Sonnet 5.5, effort high,
 * structured output, direct Anthropic API).
 *
 * The SDK client is replaced by a class whose `messages.create` returns the
 * Message shapes the API documents (end_turn, refusal with and without a
 * category, max_tokens), and the injected secret getter by a stub, so nothing
 * here reaches api.anthropic.com or a secret store. The live request shape was proven once
 * by hand against the real API.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";

const h = vi.hoisted(() => ({
  create: vi.fn(),
  ctorArgs: [] as unknown[],
  getSecret: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: h.create };
    constructor(opts: unknown) {
      h.ctorArgs.push(opts);
    }
  },
}));

type ClaudeModule = typeof import("../claude.js");
let claude: ClaudeModule;

function message(over: Partial<Anthropic.Message>): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content: [],
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 10, output_tokens: 5 },
    ...over,
  } as Anthropic.Message;
}

function text(t: string): Anthropic.TextBlock {
  return { type: "text", text: t, citations: null };
}

const SCHEMA = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
  additionalProperties: false,
};

/** The four WIF IDs (anthropic-wif.ts); a CI job may carry any of them, so each test starts with none. */
const WIF_ENV = {
  ANTHROPIC_FEDERATION_RULE_ID: "fdrl_01TestRuleSocialHq",
  ANTHROPIC_ORGANIZATION_ID: "00000000-0000-4000-8000-000000000000",
  ANTHROPIC_SERVICE_ACCOUNT_ID: "svac_01TestSocialHqWebsite",
  ANTHROPIC_WORKSPACE_ID: "wrkspc_01TestWorkspace",
};

function setWif(): void {
  for (const [name, value] of Object.entries(WIF_ENV)) vi.stubEnv(name, value);
}

beforeEach(async () => {
  vi.resetModules();
  vi.unstubAllEnvs();
  for (const name of [...Object.keys(WIF_ENV), "ANTHROPIC_IDENTITY_TOKEN_FILE", "SOCIAL_HQ_ID_TOKEN_SERVICE_ACCOUNT", "ANTHROPIC_API_KEY"]) {
    vi.stubEnv(name, undefined);
  }
  h.create.mockReset();
  h.ctorArgs.length = 0;
  h.getSecret.mockReset().mockResolvedValue("sk-ant-test");
  claude = await import("../claude.js");
  claude.setSecretGetter(h.getSecret);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("constants", () => {
  it("pins Claude Sonnet 5.5 at effort high, under the SDK's non-streaming ceiling", () => {
    expect(claude.SOCIAL_TEXT_MODEL).toBe("claude-sonnet-5-5");
    expect(claude.SOCIAL_TEXT_EFFORT).toBe("high");
    expect(claude.SOCIAL_TEXT_MAX_TOKENS).toBe(16000);
    expect(claude.ANTHROPIC_KEY_SECRET).toBe("ANTHROPIC_API_KEY");
  });

  it("stamps the model and effort, as a fresh object each time", () => {
    const a = claude.modelStamp();
    expect(a).toEqual({ model: "claude-sonnet-5-5", effort: "high" });
    expect(claude.modelStamp()).not.toBe(a);
  });
});

describe("socialClaude", () => {
  it("builds the client from the ANTHROPIC_API_KEY secret and reuses it", async () => {
    const first = await claude.socialClaude();
    const second = await claude.socialClaude();
    expect(second).toBe(first);
    expect(h.getSecret).toHaveBeenCalledWith("ANTHROPIC_API_KEY");
    expect(h.ctorArgs).toEqual([{ apiKey: "sk-ant-test" }]);
  });

  it("rebuilds the client when the key rotates", async () => {
    const first = await claude.socialClaude();
    h.getSecret.mockResolvedValue("sk-ant-rotated");
    const second = await claude.socialClaude();
    expect(second).not.toBe(first);
    expect(h.ctorArgs).toEqual([{ apiKey: "sk-ant-test" }, { apiKey: "sk-ant-rotated" }]);
  });

  it("refuses the key path with no secret getter wired, naming wireEngineSecrets, before any client exists", async () => {
    claude.setSecretGetter(null);
    await expect(claude.socialClaude()).rejects.toThrow(
      "no secret getter registered for the Claude key path (the app calls wireEngineSecrets, which calls setSecretGetter)",
    );
    expect(h.getSecret).not.toHaveBeenCalled();
    expect(h.ctorArgs).toEqual([]);
  });

  it("throws when the key cannot be read, before any client exists", async () => {
    h.getSecret.mockRejectedValue(new Error("Could not access required secret: ANTHROPIC_API_KEY"));
    await expect(claude.socialClaude()).rejects.toThrow("ANTHROPIC_API_KEY");
    expect(h.ctorArgs).toEqual([]);
  });

  it("with the four WIF IDs, builds a credentials client with the env key and token nulled, never reads the key, and reuses it", async () => {
    setWif();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const first = await claude.socialClaude();
    const second = await claude.socialClaude();
    expect(second).toBe(first);
    expect(h.getSecret).not.toHaveBeenCalled();
    expect(h.ctorArgs).toEqual([
      { apiKey: null, authToken: null, baseURL: "https://api.anthropic.com", credentials: expect.any(Function) },
    ]);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      "[district-social] Claude auth: workload identity federation (rule fdrl_01TestRuleSocialHq, gce-metadata).",
    );
    info.mockRestore();
  });

  it("says so when ANTHROPIC_API_KEY is also in the pod, and names the projected token as the source", async () => {
    setWif();
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-in-env");
    vi.stubEnv("ANTHROPIC_IDENTITY_TOKEN_FILE", "/var/run/secrets/anthropic/token");
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    await claude.socialClaude();
    expect(info).toHaveBeenCalledWith(
      "[district-social] Claude auth: workload identity federation (rule fdrl_01TestRuleSocialHq, " +
        "file /var/run/secrets/anthropic/token); ANTHROPIC_API_KEY is set and NOT used.",
    );
    expect(h.getSecret).not.toHaveBeenCalled();
    info.mockRestore();
  });

  it("refuses a partial WIF set before any client exists, and does not fall back to the key", async () => {
    vi.stubEnv("ANTHROPIC_FEDERATION_RULE_ID", WIF_ENV.ANTHROPIC_FEDERATION_RULE_ID);
    await expect(claude.socialClaude()).rejects.toThrow("partly configured");
    expect(h.ctorArgs).toEqual([]);
    expect(h.getSecret).not.toHaveBeenCalled();
  });
});

describe("finishedText", () => {
  it("joins the text blocks of a finished reply and skips thinking blocks", () => {
    const m = message({
      content: [
        { type: "thinking", thinking: "", signature: "sig" } as Anthropic.ThinkingBlock,
        text('{"ok":'),
        text("true}"),
      ],
    });
    expect(claude.finishedText(m)).toBe('{"ok":true}');
  });

  it("throws a ModelRefusedError carrying the category on a refusal", () => {
    const m = message({
      stop_reason: "refusal",
      stop_details: { type: "refusal", category: "general_harms", explanation: "x" } as Anthropic.Message["stop_details"],
      content: [text('{"ok":true}')],
    });
    let err: unknown;
    try {
      claude.finishedText(m);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(claude.ModelRefusedError);
    expect((err as InstanceType<ClaudeModule["ModelRefusedError"]>).category).toBe("general_harms");
    expect((err as Error).message).toBe("the model declined the request (refusal: general_harms)");
    expect((err as Error).name).toBe("ModelRefusedError");
  });

  it("throws a ModelRefusedError with no category when the refusal names none", () => {
    expect(() => claude.finishedText(message({ stop_reason: "refusal", stop_details: null }))).toThrow(
      /^the model declined the request \(refusal\)$/,
    );
  });

  it("throws a ModelIncompleteError on a truncated reply instead of returning the fragment", () => {
    const m = message({ stop_reason: "max_tokens", content: [text('{"ok":')] });
    expect(() => claude.finishedText(m)).toThrow(claude.ModelIncompleteError);
    expect(() => claude.finishedText(m)).toThrow(
      "the model stopped before finishing (stop_reason max_tokens); the partial reply was discarded",
    );
  });
});

describe("genJson", () => {
  it("sends one structured-output request at effort high and parses the reply", async () => {
    h.create.mockResolvedValue(message({ content: [text('{"ok":true}')] }));
    await expect(claude.genJson<{ ok: boolean }>("Say ok.", { schema: SCHEMA })).resolves.toEqual({ ok: true });
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.create).toHaveBeenCalledWith({
      model: "claude-sonnet-5-5",
      max_tokens: 16000,
      output_config: { effort: "high", format: { type: "json_schema", schema: SCHEMA } },
      messages: [{ role: "user", content: [{ type: "text", text: "Say ok." }] }],
    });
  });

  it("adds the system prompt when one is given, and sends no thinking or sampling field", async () => {
    h.create.mockResolvedValue(message({ content: [text('{"ok":false}')] }));
    await claude.genJson("p", { schema: SCHEMA, system: "You are QA." });
    const body = h.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(body.system).toBe("You are QA.");
    for (const field of ["thinking", "temperature", "top_p", "top_k", "budget_tokens"]) {
      expect(body).not.toHaveProperty(field);
    }
  });

  it("sends images ahead of the prompt, reading the media type case-insensitively", async () => {
    h.create.mockResolvedValue(message({ content: [text('{"ok":true}')] }));
    await claude.genJson("Describe it.", {
      schema: SCHEMA,
      media: [
        { mimeType: "IMAGE/PNG", dataBase64: "iVBORw0" },
        { mimeType: "image/webp", dataBase64: "UklGR" },
      ],
    });
    const body = h.create.mock.calls[0]![0] as { messages: Array<{ content: unknown[] }> };
    expect(body.messages[0]!.content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0" } },
      { type: "image", source: { type: "base64", media_type: "image/webp", data: "UklGR" } },
      { type: "text", text: "Describe it." },
    ]);
  });

  it("refuses an image type the model cannot read, before spending a request", async () => {
    await expect(
      claude.genJson("Describe it.", { schema: SCHEMA, media: [{ mimeType: "image/heic", dataBase64: "AAAA" }] }),
    ).rejects.toThrow("the model reads only image/jpeg, image/png, image/gif, image/webp images, not image/heic");
    expect(h.create).not.toHaveBeenCalled();
  });

  it("fails closed on a refusal: it throws, once, and returns nothing", async () => {
    h.create.mockResolvedValue(
      message({
        stop_reason: "refusal",
        stop_details: { type: "refusal", category: "cyber", explanation: null } as Anthropic.Message["stop_details"],
      }),
    );
    await expect(claude.genJson("p", { schema: SCHEMA })).rejects.toBeInstanceOf(claude.ModelRefusedError);
    expect(h.create).toHaveBeenCalledTimes(1);
  });

  it("fails closed on a truncated reply", async () => {
    h.create.mockResolvedValue(message({ stop_reason: "max_tokens", content: [text('{"ok":')] }));
    await expect(claude.genJson("p", { schema: SCHEMA })).rejects.toBeInstanceOf(claude.ModelIncompleteError);
  });

  it("passes an API error through unchanged (the SDK already retried what it could)", async () => {
    const apiError = Object.assign(new Error("529 overloaded"), { status: 529 });
    h.create.mockRejectedValue(apiError);
    await expect(claude.genJson("p", { schema: SCHEMA })).rejects.toBe(apiError);
    expect(h.create).toHaveBeenCalledTimes(1);
  });
});
