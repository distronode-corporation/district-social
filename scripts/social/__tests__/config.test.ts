// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

/**
 * scripts/social/config.ts: the social CLI's machine-local config.json and the
 * bridge that copies it into the env vars the engine reads.
 *
 * node:fs is replaced by an in-memory file map, so the real (gitignored)
 * scripts/social/config.json is never read or written. The module caches the
 * parsed config, so each test re-imports it after vi.resetModules().
 */
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const files = vi.hoisted(() => new Map<string, string>());

vi.mock("node:fs", () => {
  const fs = {
    existsSync: (p: string) => files.has(p),
    readFileSync: (p: string) => {
      const v = files.get(p);
      if (v === undefined) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
      return v;
    },
    writeFileSync: (p: string, data: string) => {
      files.set(p, data);
    },
  };
  return { default: fs, ...fs };
});

const SOCIAL_DIR = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(SOCIAL_DIR, "config.json");

const BASE = {
  approvalMode: "draft",
  timezone: "America/Toronto",
  vertex: { project: "cfg-project" },
  defaults: {
    platforms: ["instagram"],
    subreddit: "saas",
    youtubeVisibility: "public",
    youtubeCategoryId: "28",
  },
};

const ENGINE_VARS = ["VERTEX_PROJECT_ID", "SOCIALMETA_DEFAULT_SUBREDDIT"] as const;

/** The engine's WIF variables (src/anthropic-wif.ts) the anthropicWif block becomes. */
const WIF_VARS = [
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_ORGANIZATION_ID",
  "ANTHROPIC_SERVICE_ACCOUNT_ID",
  "ANTHROPIC_WORKSPACE_ID",
  "SOCIAL_HQ_ID_TOKEN_SERVICE_ACCOUNT",
] as const;

const WIF = {
  federationRuleId: "fdrl_01TestOperatorRule",
  organizationId: "00000000-0000-4000-8000-000000000000",
  serviceAccountId: "svac_01TestSocialHqOperator",
  workspaceId: "wrkspc_01TestWorkspace",
  idTokenServiceAccount: "operator@example-project.iam.gserviceaccount.com",
};

/** Variables the Gemini-era bridge used to set; nothing sets them now. */
const RETIRED_VARS = ["SOCIALMETA_VERTEX_LOCATION", "SOCIALMETA_MODEL"] as const;

function writeConfig(cfg: unknown) {
  files.set(CONFIG_PATH, JSON.stringify(cfg));
}

async function load() {
  vi.resetModules();
  return import("../config.js");
}

beforeEach(() => {
  files.clear();
  // Unset, not empty: the bridge treats an already-set variable as authoritative.
  for (const name of [...ENGINE_VARS, ...RETIRED_VARS, ...WIF_VARS, "ANTHROPIC_IDENTITY_TOKEN_FILE"]) {
    vi.stubEnv(name, undefined);
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("PKG_ROOT", () => {
  it("anchors on the scripts/social directory, not the cwd", async () => {
    const { PKG_ROOT } = await load();
    expect(PKG_ROOT).toBe(SOCIAL_DIR);
  });
});

describe("loadConfig", () => {
  it("explains how to create a missing config.json instead of a bare ENOENT", async () => {
    const { loadConfig } = await load();
    expect(() => loadConfig()).toThrow(
      `No config.json at ${CONFIG_PATH}.\nCreate one: cp ${path.join(SOCIAL_DIR, "config.example.json")} ${CONFIG_PATH}`,
    );
  });

  it("returns the file's values when no env override is set, and caches them", async () => {
    writeConfig(BASE);
    const { loadConfig } = await load();
    const cfg = loadConfig();
    expect(cfg).toEqual(BASE);
    // Cached: a later change on disk is not seen until saveConfig resets it.
    writeConfig({ ...BASE, approvalMode: "auto" });
    expect(loadConfig()).toBe(cfg);
  });

  it("lets the variable the ENGINE reads override the vertex project", async () => {
    writeConfig(BASE);
    vi.stubEnv("VERTEX_PROJECT_ID", "env-project");
    const { loadConfig } = await load();
    expect(loadConfig().vertex).toEqual({ project: "env-project" });
  });

  it("has no default vertex project: a config without one reads as empty", async () => {
    const { vertex: _omitted, ...noVertex } = BASE;
    writeConfig(noVertex);
    const { loadConfig } = await load();
    expect(loadConfig().vertex).toEqual({ project: "" });
  });

  it("ignores an old config.json's Gemini location and model (text runs on Claude)", async () => {
    writeConfig({ ...BASE, vertex: { project: "cfg-project", location: "global", model: "gemini-3.5-flash-lite" } });
    vi.stubEnv("SOCIALMETA_MODEL", "env-model");
    const { loadConfig } = await load();
    expect(loadConfig().vertex).toEqual({ project: "cfg-project" });
  });
});

describe("saveConfig", () => {
  it("merges the patch into the file on disk and returns the re-read config", async () => {
    writeConfig(BASE);
    vi.stubEnv("VERTEX_PROJECT_ID", "env-project");
    const { loadConfig, saveConfig } = await load();
    expect(loadConfig().approvalMode).toBe("draft");

    const next = saveConfig({ approvalMode: "auto" });
    expect(next.approvalMode).toBe("auto");
    expect(loadConfig()).toBe(next);
    const onDisk = files.get(CONFIG_PATH)!;
    expect(onDisk.endsWith("}\n")).toBe(true);
    // The env override is applied on read, never persisted.
    expect(JSON.parse(onDisk)).toEqual({ ...BASE, approvalMode: "auto" });
  });
});

describe("wireEngineEnv", () => {
  it("copies every configured value into an unset engine variable", async () => {
    writeConfig(BASE);
    const { wireEngineEnv } = await load();
    wireEngineEnv();
    expect(process.env.VERTEX_PROJECT_ID).toBe("cfg-project");
    expect(process.env.SOCIALMETA_DEFAULT_SUBREDDIT).toBe("saas");
    // No model or location is bridged any more: text runs on Claude (claude.ts).
    for (const name of RETIRED_VARS) expect(process.env[name]).toBeUndefined();
  });

  it("never overwrites a variable the operator already set", async () => {
    writeConfig(BASE);
    vi.stubEnv("VERTEX_PROJECT_ID", "p");
    vi.stubEnv("SOCIALMETA_DEFAULT_SUBREDDIT", "s");
    const { wireEngineEnv } = await load();
    wireEngineEnv();
    expect(ENGINE_VARS.map((n) => process.env[n])).toEqual(["p", "s"]);
  });

  it("leaves a variable unset when the config has no value for it", async () => {
    writeConfig({
      ...BASE,
      vertex: { project: "" },
      defaults: { ...BASE.defaults, subreddit: undefined },
    });
    const { wireEngineEnv } = await load();
    wireEngineEnv();
    for (const name of ENGINE_VARS) expect(process.env[name]).toBeUndefined();
  });

  it("throws the missing-config error before touching env", async () => {
    const { wireEngineEnv } = await load();
    expect(() => wireEngineEnv()).toThrow(/^No config\.json at /);
    expect(process.env.VERTEX_PROJECT_ID).toBeUndefined();
  });

  it("runs the host's secret reader wiring first, when one is given", async () => {
    writeConfig(BASE);
    const { wireEngineEnv } = await load();
    const wireSecrets = vi.fn(() => {
      // Runs before the config is read: the bridge has set nothing yet.
      expect(process.env.VERTEX_PROJECT_ID).toBeUndefined();
    });
    wireEngineEnv({ wireSecrets });
    expect(wireSecrets).toHaveBeenCalledTimes(1);
    expect(process.env.VERTEX_PROJECT_ID).toBe("cfg-project");
  });
});

describe("readApiConfig", () => {
  it("answers {} with no config.json, or one without an api block", async () => {
    const { readApiConfig } = await load();
    expect(readApiConfig()).toEqual({});
    writeConfig(BASE);
    expect(readApiConfig()).toEqual({});
  });

  it("returns the api block, either field optional", async () => {
    const { readApiConfig } = await load();
    writeConfig({ ...BASE, api: { baseUrl: "https://social.example.com", audience: "aud" } });
    expect(readApiConfig()).toEqual({ baseUrl: "https://social.example.com", audience: "aud" });
    writeConfig({ ...BASE, api: { audience: "aud" } });
    expect(readApiConfig()).toEqual({ audience: "aud" });
  });

  it.each([[null], [[]], ["https://social.example.com"], [{ baseUrl: 1 }], [{ audience: false }]])(
    "refuses a malformed api block: %o",
    async (api) => {
      const { readApiConfig } = await load();
      writeConfig({ ...BASE, api });
      expect(() => readApiConfig()).toThrow("config.json api: expected { baseUrl?: string, audience?: string }");
    },
  );
});

describe("wireEngineEnv: anthropicWif (Claude by workload identity federation)", () => {
  it("sets none of the WIF variables when config.json has no block (the key path)", async () => {
    writeConfig(BASE);
    const { wireEngineEnv } = await load();
    wireEngineEnv();
    for (const name of WIF_VARS) expect(process.env[name]).toBeUndefined();
  });

  it("bridges all five fields into the engine's variables", async () => {
    writeConfig({ ...BASE, anthropicWif: WIF });
    const { wireEngineEnv } = await load();
    wireEngineEnv();
    expect(WIF_VARS.map((n) => process.env[n])).toEqual([
      WIF.federationRuleId,
      WIF.organizationId,
      WIF.serviceAccountId,
      WIF.workspaceId,
      WIF.idTokenServiceAccount,
    ]);
  });

  it.each([["ANTHROPIC_FEDERATION_RULE_ID"], ["SOCIAL_HQ_ID_TOKEN_SERVICE_ACCOUNT"], ["ANTHROPIC_IDENTITY_TOKEN_FILE"]])(
    "uses the shell's set whole and ignores the block when %s is already set",
    async (name) => {
      writeConfig({ ...BASE, anthropicWif: WIF });
      vi.stubEnv(name, "from-shell");
      const { wireEngineEnv } = await load();
      wireEngineEnv();
      for (const other of WIF_VARS.filter((n) => n !== name)) expect(process.env[other]).toBeUndefined();
      expect(process.env[name]).toBe("from-shell");
    },
  );

  it("refuses an incomplete block, naming every missing field, before setting anything", async () => {
    const { idTokenServiceAccount: _omitted, ...rest } = WIF;
    writeConfig({ ...BASE, anthropicWif: { ...rest, workspaceId: "", organizationId: 42 } });
    const { wireEngineEnv } = await load();
    expect(() => wireEngineEnv()).toThrow(
      "config.json anthropicWif is incomplete: organizationId, workspaceId, idTokenServiceAccount missing. " +
        "Set all five, or remove the block to stay on ANTHROPIC_API_KEY.",
    );
    for (const name of WIF_VARS) expect(process.env[name]).toBeUndefined();
  });
});
