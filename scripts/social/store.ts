import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { PKG_ROOT } from "./config.js";
import type { Draft } from "../../src/index.js";

const DRAFTS_DIR = path.join(PKG_ROOT, "drafts");

function draftPath(id: string): string {
  return path.join(DRAFTS_DIR, `${id}.json`);
}

export function newDraftId(text: string): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const slug =
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .trim()
      .split(/\s+/)
      .slice(0, 4)
      .join("-") || "post";
  const suffix = crypto.randomBytes(2).toString("hex");
  return `sm-${date}-${slug.slice(0, 40)}-${suffix}`;
}

export function saveDraft(draft: Draft): void {
  fs.mkdirSync(DRAFTS_DIR, { recursive: true });
  draft.updatedAt = new Date().toISOString();
  fs.writeFileSync(draftPath(draft.id), JSON.stringify(draft, null, 2) + "\n");
}

export function loadDraft(id: string): Draft {
  const p = draftPath(id);
  if (!fs.existsSync(p)) {
    // allow unique prefix match for convenience
    const matches = listDraftIds().filter((d) => d.startsWith(id) || d.includes(id));
    if (matches.length === 1) return loadDraft(matches[0]!);
    if (matches.length > 1) {
      throw new Error(`ambiguous draft id "${id}": ${matches.join(", ")}`);
    }
    throw new Error(`draft not found: ${id}`);
  }
  return JSON.parse(fs.readFileSync(p, "utf8")) as Draft;
}

export function listDraftIds(): string[] {
  if (!fs.existsSync(DRAFTS_DIR)) return [];
  return fs
    .readdirSync(DRAFTS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}

export function listDrafts(): Draft[] {
  return listDraftIds().map((id) => loadDraft(id));
}

export function deleteDraft(id: string): void {
  fs.rmSync(draftPath(loadDraft(id).id));
}
