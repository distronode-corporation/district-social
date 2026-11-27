#!/usr/bin/env node

// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { renderDraft, renderQa } from "./render.js";
import { createApiClient, type ApiClient } from "./api.js";
import { readApiConfig } from "./config.js";
import { registerPreflight } from "./preflight.js";
import { registerUnschedule } from "./unschedule.js";
import {
  ALL_PLATFORMS,
  type ChannelRulesSnapshot,
  type Draft,
  type Platform,
  type QAReport,
} from "../../src/index.js";

/**
 * The Social HQ CLI: a client of a Social HQ agent API (/api/internal/social/*).
 * Drafts live behind the API, formatted, checked and published by the same
 * engine as Social HQ's composer, so nothing here reads a database, a setting
 * or a vendor credential.
 *
 * ⛔ PUBLISHING: only on a human's approval of THIS draft, given in Social HQ
 * after seeing its renders and QA. That writes an approval row (the digest,
 * now or a time); `publish` cites its id and nothing else, and the CLI never
 * invents one. There is no agent self-approval.
 *
 * The deployment's facts (the API origin, the token audience, a brand pack,
 * the engine's secret reader) arrive by injection through createProgram, so
 * this module names no deployment.
 */

/** What an entry point injects. Every field is optional: see resolveApiSettings. */
export interface CliDeps {
  /** The agent API origin, e.g. https://social.example.com. */
  baseUrl?: string;
  /** The ID token audience the API verifies. */
  audience?: string;
  /** A brand pack's public profiles. Without one, `profiles` is not registered. */
  profiles?: { summary(): string; checklist(): string };
  /** Wires the engine's secret reader before each command runs. */
  wireSecrets?: () => void;
}

/**
 * Where the client's settings come from. The CONFIGURED origin and audience
 * are, first found wins: the injected deps, then config.json's `api` block,
 * then SOCIAL_API_BASE_URL / SOCIAL_API_AUDIENCE. The per-run origin is
 * `--base-url`, else SOCIAL_API_BASE_URL, and the client refuses it unless it
 * equals the configured origin (api.ts pinnedBaseUrl), so neither can point
 * the token anywhere new once an origin is configured.
 */
export function resolveApiSettings(
  deps: CliDeps,
  flagBaseUrl: string | undefined,
): { baseUrl?: string; audience?: string; requestedBaseUrl?: string } {
  const file = deps.baseUrl && deps.audience ? {} : readApiConfig();
  const env = process.env;
  return {
    baseUrl: deps.baseUrl || file.baseUrl || env.SOCIAL_API_BASE_URL || undefined,
    audience: deps.audience || file.audience || env.SOCIAL_API_AUDIENCE || undefined,
    requestedBaseUrl: flagBaseUrl || env.SOCIAL_API_BASE_URL || undefined,
  };
}

/** Short aliases; every canonical id in ALL_PLATFORMS is accepted as itself. */
const ALIAS: Record<string, Platform> = {
  ig: "instagram", insta: "instagram",
  fb: "facebook",
  th: "threads",
  x: "twitter", tw: "twitter",
  li: "linkedin",
  yt: "youtube",
  rd: "reddit",
  bs: "bluesky", bsky: "bluesky",
  pin: "pinterest", pi: "pinterest",
  tt: "tiktok",
};
const CANONICAL = new Set<string>(ALL_PLATFORMS);

function platformOf(raw: string): Platform {
  const key = raw.trim().toLowerCase();
  // Own keys only: a bare ALIAS[key] answers "constructor" or "toString" with
  // Object.prototype's functions, which would go out as a target.
  const p = CANONICAL.has(key) ? (key as Platform) : Object.hasOwn(ALIAS, key) ? ALIAS[key] : undefined;
  if (!p) throw new Error(`unknown platform "${raw}" (use: ${ALL_PLATFORMS.join(", ")}, or "all")`);
  return p;
}

/** `default` leaves the targets to Social HQ's defaults. */
function parsePlatforms(spec: string): Platform[] | undefined {
  if (spec === "default") return undefined;
  if (spec === "all") return [...ALL_PLATFORMS];
  return spec.split(",").map(platformOf);
}

function parseHashtags(spec: string | undefined): string[] | undefined {
  if (!spec) return undefined;
  return spec
    .split(/[,\s]+/)
    .filter(Boolean)
    .map((h) => (h.startsWith("#") ? h : `#${h}`));
}

const MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".pdf": "application/pdf",
};

/** The upload type of a file, or a refusal naming the types this CLI uploads. */
function mimeOf(file: string): string {
  const type = MIME[path.extname(file).toLowerCase()];
  if (!type) throw new Error(`${file}: not an image, video or PDF this CLI uploads (${Object.keys(MIME).join(" ")})`);
  return type;
}

/** Upload one file to the asset store; its asset id. */
async function upload(client: ApiClient, file: string, alt: string | undefined): Promise<string> {
  const type = mimeOf(file);
  const form = new FormData();
  form.set("file", new Blob([fs.readFileSync(file)], { type }), path.basename(file));
  if (alt) form.set("altText", alt);
  const { asset } = await client.request<{ asset: { id: string } }>("POST", "/media", form);
  console.error(`uploaded ${file} -> asset ${asset.id}`);
  return asset.id;
}

/** A spec field that must be a list of strings, or absent. */
function stringList(field: string, value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new Error(`${field}: expected a list of strings`);
  }
  return value;
}

/** The spec's `media`: a list of `{ file, alt? }`, or absent. */
function specMedia(value: unknown): Array<{ file: string; alt?: string }> {
  if (value === undefined) return [];
  const ok =
    Array.isArray(value) &&
    value.every(
      (m: unknown) =>
        !!m &&
        typeof m === "object" &&
        typeof (m as { file?: unknown }).file === "string" &&
        ["undefined", "string"].includes(typeof (m as { alt?: unknown }).alt),
    );
  if (!ok) throw new Error("media: expected a list of { file, alt? } with string values");
  return value as Array<{ file: string; alt?: string }>;
}

function readJson(file: string): Record<string, unknown> {
  const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${file}: expected a JSON object`);
  return value as Record<string, unknown>;
}

/** Alias keys in a renders object resolve to canonical ids, so a spec can say `li`. */
function canonicalRenders(renders: unknown): Record<string, unknown> | undefined {
  if (renders === undefined) return undefined;
  if (!renders || typeof renders !== "object" || Array.isArray(renders)) {
    throw new Error("renders: expected an object keyed by platform");
  }
  return Object.fromEntries(Object.entries(renders).map(([k, v]) => [platformOf(k), v]));
}

interface ApprovalRow {
  id: string;
  mode: string;
  scheduledFor: string | null;
  outcome: string;
  approvedBy: string;
  approvedAt: string;
}

interface DraftView {
  draft: Draft;
  rendersHash: string;
  origin: string | null;
  legs: Array<{ platform: string | null; state: string; ref: string | null; url: string | null }>;
  /** Newest first; an `approved` one is unspent, and its id is what `publish` cites. */
  approvals?: ApprovalRow[];
  /** The live vendor rules the formatter trimmed to, when the API sends them. */
  rules?: ChannelRulesSnapshot | null;
}

function printView(view: DraftView): void {
  const rules = view.rules ?? null;
  console.log(renderDraft(view.draft, rules));
  // Without a snapshot the counters show the engine's spec caps, which can
  // differ from the account's real ones (X Premium), so say which they are.
  if (!rules) console.log("  (length caps: the engine's spec fallback; the API sent no live rules snapshot)");
  for (const leg of view.legs) {
    console.log(`  leg ${leg.platform ?? "?"}: ${leg.state}${leg.ref ? ` ${leg.ref}` : ""}${leg.url ? ` ${leg.url}` : ""}`);
  }
  console.log(`\nrendersHash: ${view.rendersHash}`);
  const approvals = view.approvals ?? [];
  if (approvals.length === 0) {
    console.log("approvals: none (a person approves this draft in Social HQ)");
    return;
  }
  console.log("approvals (newest first; an `approved` one is unspent):");
  for (const a of approvals) {
    const when = a.mode === "at" ? `at ${a.scheduledFor ?? "?"}` : "now";
    console.log(`  ${a.id}  ${a.outcome}  ${when}  by ${a.approvedBy} at ${a.approvedAt}`);
  }
}

/** The compose fields the API takes (it refuses any other), plus the spec's own `media` file list. */
const COMPOSE_FIELDS = [
  "text",
  "title",
  "hashtags",
  "link",
  "notes",
  "targets",
  "assetIds",
  "subreddit",
  "pinterestBoard",
  "renders",
] as const;
const SPEC_FIELDS = new Set<string>([...COMPOSE_FIELDS, "media"]);

function json(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function withQuery(base: string, query: URLSearchParams): string {
  const q = query.toString();
  return q ? `${base}?${q}` : base;
}

interface AccountRow {
  platform: string;
  route: string;
  connected: boolean;
  needsReconnection: boolean;
  displayName?: string;
  accountId?: string;
  reason?: string;
}

/**
 * The options commander hands each command's action. Commander types them as `any`; these
 * are what the `.option()` calls below declare: a `<value>` option is a string, a
 * `<value...>` option a list, a bare flag a boolean, and each is absent when not given.
 */
interface GlobalOptions {
  baseUrl?: string;
}

interface JsonOption {
  json?: boolean;
}

interface NewOptions extends JsonOption {
  text?: string;
  title?: string;
  hashtags?: string;
  link?: string;
  notes?: string;
  platforms?: string;
  subreddit?: string;
  board?: string;
  media?: string[];
  asset?: string[];
  renders?: string;
  spec?: string;
}

interface ListOptions extends JsonOption {
  status?: string;
  limit?: string;
}

interface PublishOptions extends JsonOption {
  /** A required option: commander refuses the command without it. */
  approvalId: string;
  session?: string;
}

interface EvidenceOptions {
  platform?: string;
  since?: string;
  limit?: string;
}

export function createProgram(deps: CliDeps = {}): Command {
  const program = new Command();
  program
    .name("social")
    .description(
      "Social posts through a Social HQ agent API: draft, QA, preflight, publish on the operator's approval, evidence",
    )
    .version("0.2.0")
    .option("--base-url <url>", "API origin for this run; must equal the configured one (default: SOCIAL_API_BASE_URL)");
  const wireSecrets = deps.wireSecrets;
  if (wireSecrets) program.hook("preAction", () => wireSecrets());

  const api = (): ApiClient => createApiClient(resolveApiSettings(deps, program.opts<GlobalOptions>().baseUrl));

  program
    .command("new")
    .description("Create a draft on Social HQ: format per platform (or keep hand-written renders), tracked links, QA")
    .option("-t, --text <text>", "source post text (the claims QA checks the copy against)")
    .option("--title <title>", "suggested title (youtube/reddit/pinterest)")
    .option("-H, --hashtags <tags>", "comma/space separated hashtag pool")
    .option("-l, --link <url>", "link to promote")
    .option("-n, --notes <notes>", "extra guidance for the formatter")
    .option("-p, --platforms <list>", 'comma list of ids or aliases (ig,fb,th,x,li,yt,rd,bs,pin,tt), "all", or "default"')
    .option("--subreddit <name>", "target subreddit (reddit)")
    .option("--board <id>", "Pinterest board id")
    .option("-m, --media <path...>", "image/video files to upload, in order (alt text is generated)")
    .option("--asset <id...>", "existing asset ids, after any uploads")
    .option("--renders <file>", "JSON: hand-written renders kept verbatim, { <platform>: { content, mediaIndices, ... } }")
    .option(
      "--spec <file>",
      "JSON release: { text, title, link, hashtags, targets, notes, subreddit, pinterestBoard, media: [{ file, alt }], " +
        "assetIds, renders }; its files are relative to it, and flags override it",
    )
    .option("--json", "print the API's answer as JSON")
    .action(async (o: NewOptions) => {
      const spec = o.spec ? readJson(o.spec) : {};
      const unknown = Object.keys(spec).filter((k) => !SPEC_FIELDS.has(k));
      if (unknown.length > 0) {
        throw new Error(`${o.spec}: unknown fields: ${unknown.join(", ")} (valid: ${[...SPEC_FIELDS].join(", ")})`);
      }
      const specDir = o.spec ? path.dirname(path.resolve(o.spec)) : process.cwd();

      // ⛔ Everything is validated BEFORE the first upload: a refusal after one
      // would leave orphaned assets on Social HQ for a draft that never existed.
      const text: unknown = o.text ?? spec.text;
      if (typeof text !== "string" || !text.trim()) throw new Error("new needs --text (or a spec with text)");
      const targets = o.platforms ? parsePlatforms(o.platforms) : stringList("targets", spec.targets)?.map(platformOf);
      const renders = canonicalRenders(o.renders ? readJson(o.renders) : spec.renders);
      const specAssetIds = stringList("assetIds", spec.assetIds) ?? [];
      const files: Array<{ file: string; alt?: string }> = [
        ...specMedia(spec.media).map((m) => ({ file: path.resolve(specDir, m.file), alt: m.alt })),
        ...((o.media ?? []) as string[]).map((file) => ({ file })),
      ];
      for (const f of files) mimeOf(f.file);

      // Media order is the draft's: the spec's files, then -m files, then
      // existing ids. Hand-written mediaIndices index this list.
      const client = api();
      const assetIds: string[] = [];
      for (const f of files) assetIds.push(await upload(client, f.file, f.alt));
      assetIds.push(...specAssetIds, ...((o.asset ?? []) as string[]));

      // Built from the API's own field list, never a spread of the spec: the API
      // refuses an unknown field, and the CLI refuses it first (above).
      const body: Record<string, unknown> = {
        text,
        title: o.title ?? spec.title,
        link: o.link ?? spec.link,
        notes: o.notes ?? spec.notes,
        hashtags: parseHashtags(o.hashtags) ?? spec.hashtags,
        targets,
        subreddit: o.subreddit ?? spec.subreddit,
        pinterestBoard: o.board ?? spec.pinterestBoard,
        assetIds,
        renders,
      };

      console.error("formatting and checking on Social HQ…");
      const view = await client.request<DraftView>("POST", "/drafts", body);
      if (o.json) return json(view);
      printView(view);
      console.log(`created ${view.draft.id}`);
    });

  program
    .command("list")
    .description("List Social HQ drafts, newest first")
    .option("--status <status>", "only this status (draft, approved, scheduled, published, failed)")
    .option("--limit <n>", "how many (1-200, default 50)")
    .option("--json", "print the API's answer as JSON")
    .action(async (o: ListOptions) => {
      const query = new URLSearchParams();
      if (o.status) query.set("status", o.status);
      if (o.limit) query.set("limit", o.limit);
      const { drafts } = await api().request<{ drafts: Array<Draft & { origin: string | null }> }>(
        "GET",
        withQuery("/drafts", query),
      );
      if (o.json) return json(drafts);
      if (!drafts.length) return console.log("no drafts");
      for (const d of drafts) {
        const qa = d.qa ? (d.qa.pass ? "QA:pass" : "QA:FAIL") : "QA:-";
        console.log(
          `${d.id}  [${d.status}] ${qa}  ${d.targets.join(",")}  ${d.origin ?? "-"}  "${d.source.text.slice(0, 60).replace(/\n/g, " ")}"`,
        );
      }
    });

  program
    .command("show <id>")
    .description("Show a draft: per-platform renders, QA, legs, rendersHash, and its approvals (ids `publish` cites)")
    .option("--json", "print the API's answer as JSON")
    .action(async (id: string, o: JsonOption) => {
      const view = await api().request<DraftView>("GET", `/drafts/${encodeURIComponent(id)}`);
      if (o.json) return json(view);
      printView(view);
    });

  program
    .command("qa <id>")
    .description("Re-run the full QA on Social HQ and store it")
    .option("--json", "print the API's answer as JSON")
    .action(async (id: string, o: JsonOption) => {
      const { qa } = await api().request<{ qa: QAReport }>("POST", `/drafts/${encodeURIComponent(id)}/qa`);
      if (o.json) return json(qa);
      console.log(renderQa(qa));
    });

  program
    .command("publish <id>")
    .description(
      "Publish ONLY on a person's approval of this draft: the approval id their Approve in Social HQ created " +
        "(now, or at the time they chose). The CLI never invents one.",
    )
    .requiredOption("--approval-id <uuid>", "the id of the approval a person's Approve created (`show` lists them)")
    .option("--session <id>", "your session id (default: CLAUDE_CODE_SESSION_ID)")
    .option("--json", "print the API's answer as JSON")
    .action(async (id: string, o: PublishOptions) => {
      const sessionId = o.session ?? process.env.CLAUDE_CODE_SESSION_ID;
      if (!sessionId) throw new Error("publish needs --session <id> (or CLAUDE_CODE_SESSION_ID)");
      const out = await api().request<DraftView & { result: { sent: Array<{ platform: string }> }; approvalId: string }>(
        "POST",
        `/drafts/${encodeURIComponent(id)}/publish`,
        { approvalId: o.approvalId, sessionId },
      );
      if (o.json) return json(out);
      console.log(`${out.draft.status}: ${out.draft.id} (approval ${out.approvalId})`);
      console.log(`  sent: ${out.result.sent.map((s) => s.platform).join(", ") || "none"}`);
      for (const leg of out.legs) console.log(`  ${leg.platform ?? "?"}: ${leg.state}${leg.url ? ` ${leg.url}` : ""}`);
      if (out.draft.lastError) console.log(`  errors: ${out.draft.lastError}`);
    });

  registerPreflight(program, api);
  registerUnschedule(program, api);

  program
    .command("accounts")
    .description(`Publish-readiness of all ${ALL_PLATFORMS.length} platforms, on the route each one uses`)
    .option("--json", "print the API's answer as JSON")
    .action(async (o: JsonOption) => {
      const { platforms } = await api().request<{ platforms: AccountRow[] }>("GET", "/accounts");
      if (o.json) return json(platforms);
      for (const p of platforms) {
        console.log(
          p.connected
            ? `✓ ${p.platform.padEnd(10)} ${p.displayName ?? ""} (${p.accountId ?? "-"}) via ${p.route}`
            : `✗ ${p.platform.padEnd(10)} ${p.needsReconnection ? "needs reconnection" : "not connected"}${p.reason ? `: ${p.reason}` : ""}`,
        );
      }
    });

  program
    .command("evidence [id]")
    .description("Publish evidence as JSON: one draft's approvals, rows, LinkedIn calls and legs, or every row (tier applications)")
    .option("--platform <platform>", "list form: only this platform")
    .option("--since <iso>", "list form: sent at or after")
    .option("--limit <n>", "list form: how many (1-500, default 100)")
    .action(async (id: string | undefined, o: EvidenceOptions) => {
      if (id) return json(await api().request("GET", `/drafts/${encodeURIComponent(id)}/evidence`));
      const query = new URLSearchParams();
      if (o.platform) query.set("platform", platformOf(o.platform));
      if (o.since) query.set("since", o.since);
      if (o.limit) query.set("limit", o.limit);
      json(await api().request("GET", withQuery("/evidence", query)));
    });

  // A brand pack is the deployment's own: with none injected there is nothing
  // to print, so the command does not exist rather than printing nothing.
  const profiles = deps.profiles;
  if (profiles) {
    program
      .command("profiles")
      .description("What every public profile should say, from the brand pack; read-only")
      .option(
        "--checklist",
        "per platform, the fields to paste in the order its settings page shows them, with the apply mode and image sizes",
      )
      .action((o) => {
        // Prints only: nothing here writes to any platform.
        console.log(o.checklist ? profiles.checklist() : profiles.summary());
      });
  }

  return program;
}

/** True when `argv1` is this module run directly (exact basename, so a test file is never it). */
export function isMain(argv1: string | undefined, basename: string): boolean {
  return !!argv1 && path.basename(argv1) === basename;
}

/** Runs a program on process.argv; a command's error prints as `error: <message>` and exits 1. */
export function runCli(program: Command): void {
  program.parseAsync().catch((err) => {
    console.error(`error: ${err.message}`);
    process.exit(1);
  });
}

if (isMain(process.argv[1], "cli.ts")) runCli(createProgram());
