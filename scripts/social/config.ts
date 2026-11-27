// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ANTHROPIC_IDENTITY_TOKEN_FILE_ENV,
  SOCIAL_HQ_ID_TOKEN_SA_ENV,
} from "../../src/anthropic-wif.js";

/**
 * This package's directory. Anchors config.json, so the CLI works from any
 * cwd. Resolved from
 * import.meta.url rather than process.cwd() because it is normally invoked
 * through a package script from another directory.
 */
export const PKG_ROOT = path.dirname(fileURLToPath(import.meta.url));

export interface SocialHqConfig {
  /** "draft" = publish requires prior approve; "auto" = publish/--now allowed directly */
  approvalMode: "draft" | "auto";
  timezone: string;
  /**
   * The agent API this CLI talks to, when the entry point does not inject it.
   * See resolveApiSettings in cli.ts for the precedence.
   */
  api?: ApiConfig;
  /**
   * The Vertex project for Veo (video); VERTEX_PROJECT_ID wins over it. There
   * is no default project. Text runs on Claude (src/claude.ts) and takes no
   * model setting: an old config.json's `location` and `model` are ignored.
   */
  vertex: { project: string };
  defaults: {
    platforms: string[];
    subreddit?: string;
    youtubeVisibility: "public" | "unlisted" | "private";
    youtubeCategoryId: string;
  };
  /**
   * Claude by Anthropic workload identity federation instead of the key
   * (src/anthropic-wif.ts). Absent: ANTHROPIC_API_KEY. Present: all five
   * are required, and the key is never read again.
   */
  anthropicWif?: AnthropicWifConfig;
}

/** config.json's optional `api` block. */
export interface ApiConfig {
  baseUrl?: string;
  audience?: string;
}

/** The operator's WIF IDs (all non-secret), bridged into the engine's env by wireEngineEnv. */
export interface AnthropicWifConfig {
  federationRuleId: string;
  organizationId: string;
  serviceAccountId: string;
  workspaceId: string;
  /** The role-less GCP service account whose ID token the caller's ADC mints, e.g. operator@example-project.iam.gserviceaccount.com. */
  idTokenServiceAccount: string;
}

/** Each config.json field and the engine variable it becomes (src/anthropic-wif.ts). */
const WIF_CONFIG_ENV: ReadonlyArray<readonly [keyof AnthropicWifConfig, string]> = [
  ["federationRuleId", "ANTHROPIC_FEDERATION_RULE_ID"],
  ["organizationId", "ANTHROPIC_ORGANIZATION_ID"],
  ["serviceAccountId", "ANTHROPIC_SERVICE_ACCOUNT_ID"],
  ["workspaceId", "ANTHROPIC_WORKSPACE_ID"],
  ["idTokenServiceAccount", SOCIAL_HQ_ID_TOKEN_SA_ENV],
];

const CONFIG_PATH = path.join(PKG_ROOT, "config.json");

let _config: SocialHqConfig | null = null;

export function loadConfig(): SocialHqConfig {
  if (_config) return _config;
  // config.json is machine-local (approval mode and defaults) and never
  // committed, so a clean checkout has only the template. Say that, rather than surfacing a
  // bare ENOENT on a path the operator has no reason to recognize.
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(
      `No config.json at ${CONFIG_PATH}.\n` +
        `Create one: cp ${path.join(PKG_ROOT, "config.example.json")} ${CONFIG_PATH}`,
    );
  }
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  // Every override here must name the variable the ENGINE reads
  // (src/settings.ts), or the CLI reports a configuration the engine never
  // used.
  _config = {
    ...raw,
    vertex: { project: process.env.VERTEX_PROJECT_ID || raw.vertex?.project || "" },
  } as SocialHqConfig;
  return _config!;
}

export function saveConfig(patch: Partial<SocialHqConfig>): SocialHqConfig {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  const next = { ...raw, ...patch };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + "\n");
  _config = null;
  return loadConfig();
}

/**
 * config.json's `api` block, for the agent API client. Unlike loadConfig this
 * never requires the file: an entry point that injects its origin and
 * audience, or a shell that sets them, needs no config.json at all. A block
 * that is present must hold strings.
 */
export function readApiConfig(): ApiConfig {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  const api: unknown = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")).api;
  if (api === undefined) return {};
  const ok =
    api !== null &&
    typeof api === "object" &&
    !Array.isArray(api) &&
    ["baseUrl", "audience"].every((k) => {
      const v = (api as Record<string, unknown>)[k];
      return v === undefined || typeof v === "string";
    });
  if (!ok) throw new Error("config.json api: expected { baseUrl?: string, audience?: string }");
  return api as ApiConfig;
}

export interface WireEngineOptions {
  /**
   * Gives the engine its secret reader (the Claude key path needs one). The
   * host application supplies it; without it only the WIF path or a key the
   * engine reads itself can reach the model.
   */
  wireSecrets?: () => void;
}

/**
 * Bridges this CLI's config.json into the env vars the engine reads lazily.
 * Must run before any engine call; the engine itself never touches
 * config.json. Publishing credentials are not wired here: the host resolves
 * those when it registers the transports.
 */
export function wireEngineEnv(opts: WireEngineOptions = {}): void {
  opts.wireSecrets?.();
  const cfg = loadConfig();
  if (!process.env.VERTEX_PROJECT_ID && cfg.vertex.project) {
    process.env.VERTEX_PROJECT_ID = cfg.vertex.project;
  }
  if (!process.env.SOCIALMETA_DEFAULT_SUBREDDIT && cfg.defaults.subreddit) {
    process.env.SOCIALMETA_DEFAULT_SUBREDDIT = cfg.defaults.subreddit;
  }
  wireAnthropicWif(cfg.anthropicWif);
}

/**
 * config.json's `anthropicWif` into the engine's WIF variables.
 *
 * ⛔ ALL OR NOTHING, BOTH WAYS. If the shell already sets any WIF variable
 * (the four IDs, the token file or the ID token service account), the shell's
 * set is used whole and the block is ignored: mixing two half-sets would build
 * a config nobody wrote. An incomplete block throws here, naming the missing
 * fields, rather than reaching the engine as a partial set; either way nothing
 * falls back to ANTHROPIC_API_KEY once WIF is asked for.
 */
function wireAnthropicWif(wif: AnthropicWifConfig | undefined): void {
  if (wif === undefined) return;
  const envNames = [...WIF_CONFIG_ENV.map(([, name]) => name), ANTHROPIC_IDENTITY_TOKEN_FILE_ENV];
  if (envNames.some((name) => process.env[name])) return;
  const missing = WIF_CONFIG_ENV.filter(([field]) => typeof wif[field] !== "string" || wif[field] === "").map(
    ([field]) => field,
  );
  if (missing.length > 0) {
    throw new Error(
      `config.json anthropicWif is incomplete: ${missing.join(", ")} missing. ` +
        "Set all five, or remove the block to stay on ANTHROPIC_API_KEY.",
    );
  }
  for (const [field, name] of WIF_CONFIG_ENV) process.env[name] = wif[field];
}
