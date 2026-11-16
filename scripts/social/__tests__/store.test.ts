/**
 * scripts/social/store.ts: the local drafts/ store. PKG_ROOT is pointed at a
 * fresh temp directory, so the real drafts/ beside the CLI is never touched and
 * the file operations under test are real.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Draft } from "../../../src/index.js";

vi.mock("../config.js", async () => {
  const nodeFs = await import("node:fs");
  const os = await import("node:os");
  const nodePath = await import("node:path");
  return { PKG_ROOT: nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "social-store-test-")) };
});

import { PKG_ROOT } from "../config.js";
import {
  deleteDraft,
  listDraftIds,
  listDrafts,
  loadDraft,
  newDraftId,
  saveDraft,
} from "../store.js";

const DRAFTS = path.join(PKG_ROOT, "drafts");

function draft(id: string, text = "hello"): Draft {
  return {
    id,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    status: "draft",
    source: { text, hashtags: [], media: [] },
    targets: ["linkedin"],
    renders: [],
  } as Draft;
}

beforeEach(() => {
  fs.rmSync(DRAFTS, { recursive: true, force: true });
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  fs.rmSync(PKG_ROOT, { recursive: true, force: true });
});

describe("newDraftId", () => {
  it("is sm-<date>-<first four words>-<4 hex>", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-24T12:00:00Z"));
    const id = newDraftId("Hello, World! Our NEW launch is here");
    expect(id).toMatch(/^sm-20260924-hello-world-our-new-[0-9a-f]{4}$/);
  });

  it("falls back to 'post' when nothing survives the slug filter", () => {
    expect(newDraftId("!!! 🎉")).toMatch(/^sm-\d{8}-post-[0-9a-f]{4}$/);
  });

  it("caps the slug at 40 characters", () => {
    const long = "a".repeat(30) + " " + "b".repeat(30);
    const slug = newDraftId(long).split("-").slice(2, -1).join("-");
    expect(slug).toHaveLength(40);
  });

  it("gives two drafts of the same text different ids", () => {
    const seen = new Set(Array.from({ length: 20 }, () => newDraftId("same")));
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe("saveDraft / loadDraft", () => {
  it("creates drafts/ on first save, stamps updatedAt and round-trips the draft", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-24T12:00:00Z"));
    const d = draft("sm-1");
    saveDraft(d);
    expect(d.updatedAt).toBe("2026-09-24T12:00:00.000Z");
    const raw = fs.readFileSync(path.join(DRAFTS, "sm-1.json"), "utf8");
    expect(raw.endsWith("}\n")).toBe(true);
    expect(loadDraft("sm-1")).toEqual(d);
  });

  it("resolves a unique prefix or substring of an id", () => {
    saveDraft(draft("sm-20260901-alpha-1234"));
    saveDraft(draft("sm-20260901-beta-5678"));
    expect(loadDraft("sm-20260901-al").id).toBe("sm-20260901-alpha-1234");
    expect(loadDraft("5678").id).toBe("sm-20260901-beta-5678");
  });

  it("refuses an ambiguous id, naming every match", () => {
    saveDraft(draft("sm-a-1"));
    saveDraft(draft("sm-a-2"));
    expect(() => loadDraft("sm-a")).toThrow('ambiguous draft id "sm-a": sm-a-1, sm-a-2');
  });

  it("reports a draft that does not exist, with or without a drafts/ directory", () => {
    expect(() => loadDraft("nope")).toThrow("draft not found: nope");
    saveDraft(draft("sm-x"));
    expect(() => loadDraft("nope")).toThrow("draft not found: nope");
  });
});

describe("listing and deleting", () => {
  it("lists nothing when drafts/ does not exist", () => {
    expect(listDraftIds()).toEqual([]);
    expect(listDrafts()).toEqual([]);
  });

  it("lists only .json files, sorted", () => {
    saveDraft(draft("sm-b"));
    saveDraft(draft("sm-a"));
    fs.writeFileSync(path.join(DRAFTS, "notes.txt"), "x");
    expect(listDraftIds()).toEqual(["sm-a", "sm-b"]);
    expect(listDrafts().map((d) => d.id)).toEqual(["sm-a", "sm-b"]);
  });

  it("deletes by resolved id, so a prefix deletes the one draft it names", () => {
    saveDraft(draft("sm-keep"));
    saveDraft(draft("sm-gone-1234"));
    deleteDraft("sm-gone");
    expect(listDraftIds()).toEqual(["sm-keep"]);
    expect(() => deleteDraft("sm-gone")).toThrow("draft not found: sm-gone");
  });
});
