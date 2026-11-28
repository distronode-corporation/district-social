// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

/**
 * scripts/social/cli.ts: every command of the `npm run social` CLI, run
 * in-process through commander, against a fake agent API.
 *
 * Mocked at the module boundary: the API client (../api, a fake `request`),
 * config.json's api block (../config) and the previews (../render). The brand
 * pack and the secret reader are injected fakes. Nothing leaves the process.
 * Each run builds a fresh program, so commander's parsed option state never
 * leaks between tests.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { CliDeps } from "../cli.js";

const h = vi.hoisted(() => ({
  request: vi.fn(),
  createApiClient: vi.fn(),
  renderDraft: vi.fn(() => "<draft>"),
  renderQa: vi.fn(() => "<qa>"),
  readApiConfig: vi.fn((): { baseUrl?: string; audience?: string } => ({})),
}));

vi.mock("../api.js", () => ({ createApiClient: h.createApiClient }));
vi.mock("../render.js", () => ({ renderDraft: h.renderDraft, renderQa: h.renderQa }));
vi.mock("../config.js", () => ({ readApiConfig: h.readApiConfig }));
vi.mock("../../../src/index.js", () => ({
  ALL_PLATFORMS: [
    "instagram",
    "facebook",
    "threads",
    "twitter",
    "linkedin",
    "youtube",
    "reddit",
    "bluesky",
    "pinterest",
    "tiktok",
  ],
}));

const ORIGIN = "https://social.example.com";
const AUDIENCE = "https://social.example.com/api/internal/social";
const DEPS: CliDeps = { baseUrl: ORIGIN, audience: AUDIENCE };

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "social-cli-test-"));
afterAll(() => fs.rmSync(DIR, { recursive: true, force: true }));

function file(name: string, content: string | Buffer): string {
  const p = path.join(DIR, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

let log: MockInstance<typeof console.log>;
let err: MockInstance<typeof console.error>;
const logged = () => log.mock.calls.map((c) => c.join(" "));

async function runWith(deps: CliDeps, ...args: string[]) {
  const { createProgram } = await import("../cli.js");
  await createProgram(deps).parseAsync(["node", "cli.ts", ...args]);
}
const run = (...args: string[]) => runWith(DEPS, ...args);

const DRAFT = {
  id: "d1",
  status: "draft",
  targets: ["linkedin"],
  source: { text: "Hello\nworld", hashtags: [], media: [] },
  renders: [],
  qa: null,
};

function view(extra: Record<string, unknown> = {}) {
  return { draft: DRAFT, rendersHash: "h".repeat(64), origin: "agent:x", legs: [], ...extra };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.createApiClient.mockImplementation((opts: { baseUrl?: string }) => ({ baseUrl: opts.baseUrl, request: h.request }));
  h.readApiConfig.mockReturnValue({});
  // Unset, not empty: the precedence treats a set variable as configuration.
  vi.stubEnv("SOCIAL_API_BASE_URL", undefined);
  vi.stubEnv("SOCIAL_API_AUDIENCE", undefined);
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  err = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the API client", () => {
  it("passes the injected origin and audience, and --base-url as the requested origin, which the client pins", async () => {
    h.request.mockResolvedValue({ drafts: [] });
    await run("--base-url", ORIGIN, "list");
    expect(h.createApiClient).toHaveBeenCalledWith({ baseUrl: ORIGIN, audience: AUDIENCE, requestedBaseUrl: ORIGIN });
    await run("list");
    expect(h.createApiClient).toHaveBeenLastCalledWith({ baseUrl: ORIGIN, audience: AUDIENCE, requestedBaseUrl: undefined });
    // Both injected: config.json is never read.
    expect(h.readApiConfig).not.toHaveBeenCalled();
  });
});

describe("resolveApiSettings: injected, then config.json, then the env", () => {
  it("prefers the injected deps over config.json and the env, and asks the env for the requested origin", async () => {
    const { resolveApiSettings } = await import("../cli.js");
    vi.stubEnv("SOCIAL_API_BASE_URL", "https://env.example.com");
    vi.stubEnv("SOCIAL_API_AUDIENCE", "env-aud");
    h.readApiConfig.mockReturnValue({ baseUrl: "https://file.example.com", audience: "file-aud" });
    expect(resolveApiSettings(DEPS, undefined)).toEqual({
      baseUrl: ORIGIN,
      audience: AUDIENCE,
      requestedBaseUrl: "https://env.example.com",
    });
    expect(resolveApiSettings(DEPS, "https://flag.example.com").requestedBaseUrl).toBe("https://flag.example.com");
  });

  it("fills what the deps leave out from config.json, then from the env", async () => {
    const { resolveApiSettings } = await import("../cli.js");
    h.readApiConfig.mockReturnValue({ baseUrl: "https://file.example.com", audience: "file-aud" });
    vi.stubEnv("SOCIAL_API_AUDIENCE", "env-aud");
    expect(resolveApiSettings({ baseUrl: ORIGIN }, undefined)).toEqual({
      baseUrl: ORIGIN,
      audience: "file-aud",
      requestedBaseUrl: undefined,
    });
    expect(resolveApiSettings({}, undefined)).toMatchObject({ baseUrl: "https://file.example.com", audience: "file-aud" });
    h.readApiConfig.mockReturnValue({});
    vi.stubEnv("SOCIAL_API_BASE_URL", "https://env.example.com");
    expect(resolveApiSettings({ audience: AUDIENCE }, undefined)).toEqual({
      baseUrl: "https://env.example.com",
      audience: AUDIENCE,
      requestedBaseUrl: "https://env.example.com",
    });
    expect(resolveApiSettings({}, undefined)).toMatchObject({ baseUrl: "https://env.example.com", audience: "env-aud" });
  });

  it("leaves both unset when nothing configures them, so the client refuses", async () => {
    const { resolveApiSettings } = await import("../cli.js");
    expect(resolveApiSettings({}, undefined)).toEqual({ baseUrl: undefined, audience: undefined, requestedBaseUrl: undefined });
  });
});

describe("wireSecrets", () => {
  it("runs before a command's action when injected", async () => {
    const order: string[] = [];
    const wireSecrets = vi.fn(() => {
      order.push("wire");
    });
    h.request.mockImplementation(async () => {
      order.push("request");
      return { drafts: [] };
    });
    await runWith({ ...DEPS, wireSecrets }, "list");
    expect(order).toEqual(["wire", "request"]);
  });
});

describe("new", () => {
  it("builds the body from the API's fields only, with flags, uploads and aliases resolved", async () => {
    const img = file("card.png", "png");
    const renders = file("renders.json", JSON.stringify({ li: { content: "LI", mediaIndices: [0] } }));
    h.request.mockImplementation(async (_method: string, p: string) =>
      p === "/media" ? { asset: { id: "a-up" } } : view({ approvals: [] }),
    );
    await run(
      "new",
      "-t", "Text",
      "--title", "T",
      "-H", "one, #two three",
      "-l", "https://example.com",
      "-n", "notes",
      "-p", "li,bsky,instagram",
      "--subreddit", "sr",
      "--board", "b1",
      "-m", img,
      "--asset", "a-old",
      "--renders", renders,
    );
    const media = h.request.mock.calls[0]!;
    expect(media[0]).toBe("POST");
    expect(media[1]).toBe("/media");
    const form = media[2] as FormData;
    expect((form.get("file") as File).type).toBe("image/png");
    expect((form.get("file") as File).name).toBe("card.png");
    expect(form.get("altText")).toBeNull();
    expect(h.request).toHaveBeenLastCalledWith("POST", "/drafts", {
      text: "Text",
      title: "T",
      link: "https://example.com",
      notes: "notes",
      hashtags: ["#one", "#two", "#three"],
      targets: ["linkedin", "bluesky", "instagram"],
      subreddit: "sr",
      pinterestBoard: "b1",
      assetIds: ["a-up", "a-old"],
      renders: { linkedin: { content: "LI", mediaIndices: [0] } },
    });
    expect(err).toHaveBeenCalledWith(`uploaded ${img} -> asset a-up`);
    expect(logged()).toContain("created d1");
    expect(logged()).toContain("approvals: none (a person approves this draft in Social HQ)");
  });

  it("takes a spec: its media relative to it (with alt), its asset ids, renders and targets; flags win", async () => {
    file("rel/a.jpg", "jpg");
    file("rel/b.mp4", "mp4");
    const spec = file(
      "rel/spec.json",
      JSON.stringify({
        text: "spec text",
        title: "spec title",
        link: "https://x",
        notes: "n",
        hashtags: ["#h"],
        targets: ["li", "x"],
        subreddit: "s",
        pinterestBoard: "pb",
        media: [{ file: "a.jpg", alt: "A" }, { file: "b.mp4" }],
        assetIds: ["a-spec"],
        renders: { x: { content: "X", mediaIndices: [] } },
      }),
    );
    let n = 0;
    h.request.mockImplementation(async (_m: string, p: string, body: FormData) => {
      if (p === "/media") return { asset: { id: `up${n++}:${String(body.get("altText") ?? "-")}` } };
      return view();
    });
    await run("new", "--spec", spec, "--title", "flag title", "--json");
    expect(h.request).toHaveBeenLastCalledWith("POST", "/drafts", {
      text: "spec text",
      title: "flag title",
      link: "https://x",
      notes: "n",
      hashtags: ["#h"],
      targets: ["linkedin", "twitter"],
      subreddit: "s",
      pinterestBoard: "pb",
      assetIds: ["up0:A", "up1:-", "a-spec"],
      renders: { twitter: { content: "X", mediaIndices: [] } },
    });
    expect(JSON.parse(logged()[0]!)).toEqual(view());
  });

  it("leaves targets to Social HQ with -p default, takes every platform with -p all, and sends no renders by default", async () => {
    h.request.mockResolvedValue(view());
    await run("new", "-t", "x", "-p", "default");
    expect(h.request.mock.calls[0]![2]).toMatchObject({ targets: undefined, renders: undefined, assetIds: [] });
    await run("new", "-t", "x", "-p", "all");
    expect((h.request.mock.calls[1]![2] as { targets: string[] }).targets).toHaveLength(10);
    await run("new", "-t", "x");
    expect(h.request.mock.calls[2]![2]).toMatchObject({ targets: undefined, hashtags: undefined });
  });

  it("⛔ refuses an unknown spec field before any upload or call, naming the valid ones", async () => {
    const spec = file("bad.json", JSON.stringify({ text: "t", skipLlmQa: true, force: 1 }));
    await expect(run("new", "--spec", spec)).rejects.toThrow(
      `${spec}: unknown fields: skipLlmQa, force (valid: text, title, hashtags, link, notes, targets, assetIds, subreddit, pinterestBoard, renders, media)`,
    );
    expect(h.request).not.toHaveBeenCalled();
  });

  it("refuses a draft with no text, a spec that is not an object, renders that are not an object, and an unknown platform", async () => {
    await expect(run("new", "-t", "  ")).rejects.toThrow("new needs --text (or a spec with text)");
    await expect(run("new")).rejects.toThrow("new needs --text");
    const arr = file("arr.json", "[1]");
    await expect(run("new", "--spec", arr)).rejects.toThrow(`${arr}: expected a JSON object`);
    const nul = file("null.json", "null");
    await expect(run("new", "--spec", nul)).rejects.toThrow("expected a JSON object");
    const badRenders = file("badr.json", JSON.stringify({ text: "t", renders: ["li"] }));
    await expect(run("new", "--spec", badRenders)).rejects.toThrow("renders: expected an object keyed by platform");
    const nullRenders = file("nullr.json", JSON.stringify({ text: "t", renders: null }));
    await expect(run("new", "--spec", nullRenders)).rejects.toThrow("renders: expected an object keyed by platform");
    await expect(run("new", "-t", "t", "-p", "li,myspace")).rejects.toThrow(
      'unknown platform "myspace" (use: instagram, facebook, threads, twitter, linkedin, youtube, reddit, bluesky, pinterest, tiktok, or "all")',
    );
    expect(h.request).not.toHaveBeenCalled();
  });

  it("⛔ refuses a bad text, target, renders or spec field before the FIRST upload", async () => {
    const img = file("first.png", "png");
    file("vs/a.jpg", "jpg");
    const specWith = (extra: Record<string, unknown>) =>
      file(`vs/spec-${Math.random().toString(36).slice(2)}.json`, JSON.stringify({ media: [{ file: "a.jpg" }], ...extra }));
    h.request.mockResolvedValue({ asset: { id: "a" } });

    await expect(run("new", "-m", img)).rejects.toThrow("new needs --text");
    await expect(run("new", "-t", "t", "-p", "li,myspace", "-m", img)).rejects.toThrow('unknown platform "myspace"');
    await expect(run("new", "--spec", specWith({ text: "t", targets: ["myspace"] }))).rejects.toThrow(
      'unknown platform "myspace"',
    );
    await expect(run("new", "--spec", specWith({ text: "t", targets: "li" }))).rejects.toThrow(
      "targets: expected a list of strings",
    );
    await expect(run("new", "--spec", specWith({ text: "t", targets: ["li", 3] }))).rejects.toThrow(
      "targets: expected a list of strings",
    );
    await expect(run("new", "--spec", specWith({ text: "t", renders: ["li"] }))).rejects.toThrow(
      "renders: expected an object keyed by platform",
    );
    await expect(run("new", "--spec", specWith({ text: "t", renders: { myspace: {} } }))).rejects.toThrow(
      'unknown platform "myspace"',
    );
    await expect(run("new", "--spec", specWith({ text: "t", assetIds: "a-1" }))).rejects.toThrow(
      "assetIds: expected a list of strings",
    );
    // A second file of a type this CLI does not upload refuses before the first goes up.
    const txt = file("second.txt", "x");
    await expect(run("new", "-t", "t", "-m", img, txt)).rejects.toThrow(`${txt}: not an image, video or PDF`);
    expect(h.request).not.toHaveBeenCalled();
  });

  it("⛔ refuses a spec media list that is not [{ file, alt? }] before any upload", async () => {
    for (const media of [
      "a.jpg",
      [null],
      ["a.jpg"],
      [{ alt: "A" }],
      [{ file: 1 }],
      [{ file: "a.jpg", alt: 2 }],
    ]) {
      const spec = file("vm/spec.json", JSON.stringify({ text: "t", media }));
      await expect(run("new", "--spec", spec)).rejects.toThrow("media: expected a list of { file, alt? } with string values");
    }
    expect(h.request).not.toHaveBeenCalled();
  });

  it("refuses a platform name that is only an Object.prototype key", async () => {
    for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      await expect(run("new", "-t", "t", "-p", name)).rejects.toThrow(`unknown platform "${name}"`);
    }
    await expect(run("evidence", "--platform", "valueOf")).rejects.toThrow('unknown platform "valueOf"');
    expect(h.request).not.toHaveBeenCalled();
  });

  it("refuses a file type it does not upload", async () => {
    const txt = file("notes.txt", "x");
    await expect(run("new", "-t", "t", "-m", txt)).rejects.toThrow(`${txt}: not an image, video or PDF this CLI uploads`);
  });
});

describe("list", () => {
  it("asks with the filters and prints one line per draft", async () => {
    h.request.mockResolvedValue({
      drafts: [
        { ...DRAFT, qa: { pass: true }, origin: "agent:x" },
        { ...DRAFT, id: "d2", qa: { pass: false }, origin: null },
        { ...DRAFT, id: "d3", qa: null, origin: "autopilot" },
      ],
    });
    await run("list", "--status", "draft", "--limit", "5");
    expect(h.request).toHaveBeenCalledWith("GET", "/drafts?status=draft&limit=5");
    expect(logged()).toEqual([
      'd1  [draft] QA:pass  linkedin  agent:x  "Hello world"',
      'd2  [draft] QA:FAIL  linkedin  -  "Hello world"',
      'd3  [draft] QA:-  linkedin  autopilot  "Hello world"',
    ]);
  });

  it("says so when there are none, and prints JSON on --json", async () => {
    h.request.mockResolvedValue({ drafts: [] });
    await run("list");
    expect(h.request).toHaveBeenCalledWith("GET", "/drafts");
    expect(logged()).toEqual(["no drafts"]);
    log.mockClear();
    await run("list", "--json");
    expect(logged()).toEqual(["[]"]);
  });
});

describe("show", () => {
  it("prints the renders, the legs, the hash and every approval, newest first", async () => {
    h.request.mockResolvedValue(
      view({
        legs: [
          { platform: "linkedin", state: "live", ref: "urn:li:share:1", url: "https://li/1" },
          { platform: null, state: "legacy", ref: null, url: null },
        ],
        approvals: [
          { id: "ap2", mode: "at", scheduledFor: "2026-11-09T15:00:00.000Z", outcome: "approved", approvedBy: "approver@example.com", approvedAt: "2026-11-08T06:00:00.000Z" },
          { id: "ap1", mode: "at", scheduledFor: null, outcome: "failed-unsent", approvedBy: "approver@example.com", approvedAt: "2026-11-08T05:00:00.000Z" },
          { id: "ap0", mode: "now", scheduledFor: null, outcome: "published", approvedBy: "approver@example.com", approvedAt: "2026-11-08T04:00:00.000Z" },
        ],
      }),
    );
    await run("show", "d1");
    expect(h.request).toHaveBeenCalledWith("GET", "/drafts/d1");
    expect(h.renderDraft).toHaveBeenCalledWith(DRAFT, null);
    expect(logged()).toEqual([
      "<draft>",
      "  (length caps: the engine's spec fallback; the API sent no live rules snapshot)",
      "  leg linkedin: live urn:li:share:1 https://li/1",
      "  leg ?: legacy",
      `\nrendersHash: ${"h".repeat(64)}`,
      "approvals (newest first; an `approved` one is unspent):",
      "  ap2  approved  at 2026-11-09T15:00:00.000Z  by approver@example.com at 2026-11-08T06:00:00.000Z",
      "  ap1  failed-unsent  at ?  by approver@example.com at 2026-11-08T05:00:00.000Z",
      "  ap0  published  now  by approver@example.com at 2026-11-08T04:00:00.000Z",
    ]);
  });

  it("passes the API's live rules snapshot to the preview, and then prints no fallback label", async () => {
    const rules = { fetchedAt: "2026-11-16T00:00:00.000Z", channels: {} };
    h.request.mockResolvedValue(view({ rules }));
    await run("show", "d1");
    expect(h.renderDraft).toHaveBeenCalledWith(DRAFT, rules);
    expect(logged().join("\n")).not.toContain("spec fallback");
    h.request.mockResolvedValue(view({ rules: null }));
    await run("show", "d1");
    expect(h.renderDraft).toHaveBeenLastCalledWith(DRAFT, null);
    expect(logged()).toContain("  (length caps: the engine's spec fallback; the API sent no live rules snapshot)");
  });

  it("encodes the draft id into the path, on show, qa, publish and evidence", async () => {
    const id = "a/b?c#d";
    const enc = "a%2Fb%3Fc%23d";
    h.request.mockResolvedValue(view({ qa: {}, result: { sent: [] }, approvalId: "ap" }));
    await run("show", id);
    expect(h.request).toHaveBeenLastCalledWith("GET", `/drafts/${enc}`);
    await run("qa", id, "--json");
    expect(h.request).toHaveBeenLastCalledWith("POST", `/drafts/${enc}/qa`);
    await run("publish", id, "--approval-id", "ap", "--session", "s", "--json");
    expect(h.request).toHaveBeenLastCalledWith("POST", `/drafts/${enc}/publish`, { approvalId: "ap", sessionId: "s" });
    await run("evidence", id);
    expect(h.request).toHaveBeenLastCalledWith("GET", `/drafts/${enc}/evidence`);
  });

  it("prints JSON on --json", async () => {
    h.request.mockResolvedValue(view());
    await run("show", "d1", "--json");
    expect(JSON.parse(logged()[0]!)).toEqual(view());
  });
});

describe("qa", () => {
  it("re-runs QA and prints the report, or its JSON", async () => {
    h.request.mockResolvedValue({ qa: { pass: true, results: [] } });
    await run("qa", "d1");
    expect(h.request).toHaveBeenCalledWith("POST", "/drafts/d1/qa");
    expect(logged()).toEqual(["<qa>"]);
    log.mockClear();
    await run("qa", "d1", "--json");
    expect(JSON.parse(logged()[0]!)).toEqual({ pass: true, results: [] });
  });
});

describe("publish", () => {
  const sent = {
    ...view({
      legs: [
        { platform: "linkedin", state: "live", ref: "r", url: "https://li/1" },
        { platform: null, state: "pending", ref: null, url: null },
      ],
    }),
    draft: { ...DRAFT, status: "published", lastError: null },
    result: { sent: [{ platform: "linkedin" }] },
    approvalId: "ap2",
  };

  it("⛔ sends exactly { approvalId, sessionId }, the session from CLAUDE_CODE_SESSION_ID", async () => {
    vi.stubEnv("CLAUDE_CODE_SESSION_ID", "sess-env");
    h.request.mockResolvedValue(sent);
    await run("publish", "d1", "--approval-id", "ap2");
    expect(h.request).toHaveBeenCalledWith("POST", "/drafts/d1/publish", { approvalId: "ap2", sessionId: "sess-env" });
    expect(logged()).toEqual([
      "published: d1 (approval ap2)",
      "  sent: linkedin",
      "  linkedin: live https://li/1",
      "  ?: pending",
    ]);
  });

  it("takes --session over the env, prints JSON, and reports nothing sent and the errors", async () => {
    vi.stubEnv("CLAUDE_CODE_SESSION_ID", "sess-env");
    h.request.mockResolvedValue({ ...sent, draft: { ...sent.draft, status: "failed", lastError: "linkedin: 403" }, result: { sent: [] }, legs: [] });
    await run("publish", "d1", "--approval-id", "ap2", "--session", "sess-flag");
    expect(h.request).toHaveBeenCalledWith("POST", "/drafts/d1/publish", { approvalId: "ap2", sessionId: "sess-flag" });
    expect(logged()).toEqual(["failed: d1 (approval ap2)", "  sent: none", "  errors: linkedin: 403"]);
    log.mockClear();
    h.request.mockResolvedValue(sent);
    await run("publish", "d1", "--approval-id", "ap2", "--json");
    expect(JSON.parse(logged()[0]!)).toEqual(sent);
  });

  it("refuses without a session, and never takes the old quoted-approval flags", async () => {
    vi.stubEnv("CLAUDE_CODE_SESSION_ID", "");
    await expect(run("publish", "d1", "--approval-id", "ap2")).rejects.toThrow(
      "publish needs --session <id> (or CLAUDE_CODE_SESSION_ID)",
    );
    expect(h.request).not.toHaveBeenCalled();
    const { createProgram } = await import("../cli.js");
    const publish = createProgram(DEPS).commands.find((c) => c.name() === "publish")!;
    const flags = publish.options.map((o) => o.long);
    expect(flags).toEqual(["--approval-id", "--session", "--json"]);
    expect(publish.description()).toMatch(/the CLI never invents one/i);
  });
});

describe("accounts", () => {
  it("prints each platform's state on its route, or JSON", async () => {
    const platforms = [
      { platform: "linkedin", route: "direct", connected: true, needsReconnection: false, displayName: "Acme", accountId: "100000001" },
      { platform: "bluesky", route: "direct", connected: true, needsReconnection: false },
      { platform: "x", route: "aggregator:zernio", connected: false, needsReconnection: true, reason: "token expired" },
      { platform: "reddit", route: "off", connected: false, needsReconnection: false },
    ];
    h.request.mockResolvedValue({ platforms });
    await run("accounts");
    expect(h.request).toHaveBeenCalledWith("GET", "/accounts");
    expect(logged()).toEqual([
      "✓ linkedin   Acme (100000001) via direct",
      "✓ bluesky     (-) via direct",
      "✗ x          needs reconnection: token expired",
      "✗ reddit     not connected",
    ]);
    log.mockClear();
    await run("accounts", "--json");
    expect(JSON.parse(logged()[0]!)).toEqual(platforms);
  });
});

describe("evidence", () => {
  it("prints one draft's evidence as JSON", async () => {
    const out = { draftId: "d1", approvals: [], evidence: [], linkedinCalls: [], legs: [] };
    h.request.mockResolvedValue(out);
    await run("evidence", "d1");
    expect(h.request).toHaveBeenCalledWith("GET", "/drafts/d1/evidence");
    expect(JSON.parse(logged()[0]!)).toEqual(out);
  });

  it("lists every row with the filters, the platform alias resolved", async () => {
    h.request.mockResolvedValue({ evidence: [] });
    await run("evidence", "--platform", "li", "--since", "2026-11-01T00:00:00Z", "--limit", "10");
    expect(h.request).toHaveBeenCalledWith("GET", "/evidence?platform=linkedin&since=2026-11-01T00%3A00%3A00Z&limit=10");
    await run("evidence");
    expect(h.request).toHaveBeenLastCalledWith("GET", "/evidence");
  });
});

describe("profiles", () => {
  const profiles = { summary: () => "summary", checklist: () => "checklist a\n\nchecklist b" };

  it("prints the injected brand pack's summary, or its checklist, and calls no API", async () => {
    await runWith({ ...DEPS, profiles }, "profiles");
    await runWith({ ...DEPS, profiles }, "profiles", "--checklist");
    expect(logged()).toEqual(["summary", "checklist a\n\nchecklist b"]);
    expect(h.createApiClient).not.toHaveBeenCalled();
  });

  it("is not a command when no brand pack is injected", async () => {
    const { createProgram } = await import("../cli.js");
    expect(createProgram(DEPS).commands.map((c) => c.name())).not.toContain("profiles");
    expect(createProgram().commands.map((c) => c.name())).toEqual(
      expect.arrayContaining(["new", "list", "show", "qa", "publish", "preflight", "unschedule", "accounts", "evidence"]),
    );
  });
});

describe("main-module wrapper", () => {
  const argv = process.argv;
  let exit: MockInstance<typeof process.exit>;

  beforeEach(() => {
    exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  });
  afterEach(() => {
    process.argv = argv;
  });

  async function importAs(args: string[]) {
    process.argv = args;
    vi.resetModules();
    await import("../cli.js");
    await new Promise((r) => setImmediate(r));
  }

  it("does nothing on import (no argv[1], or another entry point)", async () => {
    await importAs(["node"]);
    await importAs(["node", "/x/cli.test.ts", "list"]);
    expect(h.request).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("runs the command in process.argv", async () => {
    h.request.mockResolvedValue({ drafts: [] });
    await importAs(["node", "/repo/scripts/social/cli.ts", "list"]);
    expect(logged()).toEqual(["no drafts"]);
    expect(exit).not.toHaveBeenCalled();
  });

  it("prints a command's error as `error: <message>` and exits 1", async () => {
    h.request.mockRejectedValue(new Error("HTTP 404: Draft not found"));
    await importAs(["node", "/repo/scripts/social/cli.ts", "show", "nope"]);
    expect(err).toHaveBeenCalledWith("error: HTTP 404: Draft not found");
    expect(exit).toHaveBeenCalledWith(1);
  });
});
