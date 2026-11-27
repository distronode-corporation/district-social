// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

import type { Command } from "commander";
import type { ApiClient } from "./api.js";
import type { QAReport } from "../../src/index.js";

/**
 * `social preflight <id>`: GET /api/internal/social/drafts/<id>/preflight, the
 * read-only check an agent runs and shows the approver before they approve in
 * Social HQ. Its own module so cli.ts only registers it.
 */

/** The preflight answer as the API sends it: the fields this terminal view reads. */
export interface PreflightView {
  draftId: string;
  status: string;
  origin: string | null;
  rendersHash: string;
  qa: QAReport | null;
  routes: Array<{ platform: string; route: string; aggregator: string | null; reason: string | null }>;
  linkedin: { granted: boolean; scopes: string[]; reason: string | null } | null;
  pinterest: { board: string | null; onAccount: boolean | null; error: string | null } | null;
  x: { posts: number; postsWithUrl: number; estimateUsd: number } | null;
  duplicates: Array<{ id: string; status: string; reason: string }>;
  ring: { next: string; releaseAt: string | null };
  blockers: string[];
  ready: boolean;
}

/** The preflight as the terminal shows it: verdict first, then each part. */
export function renderPreflight(p: PreflightView): string {
  const lines: string[] = [];
  lines.push(`${p.ready ? "READY" : "NOT READY"}: draft ${p.draftId} [${p.status}] ${p.origin ?? "made by a person"}`);
  lines.push(`rendersHash: ${p.rendersHash}`);
  lines.push(`QA: ${p.qa ? (p.qa.pass ? "pass" : "FAIL") : "not run"}`);
  for (const r of p.routes) {
    lines.push(`  ${r.platform.padEnd(10)} ${r.route}${r.aggregator ? `:${r.aggregator}` : ""}${r.reason ? ` (${r.reason})` : ""}`);
  }
  if (p.linkedin) {
    lines.push(
      `LinkedIn write scope: ${p.linkedin.granted ? "granted" : `MISSING (${p.linkedin.reason})`}; grant: ${p.linkedin.scopes.join(" ") || "none"}`,
    );
  }
  if (p.pinterest) {
    const on =
      p.pinterest.onAccount === null
        ? `unknown (${p.pinterest.error})`
        : p.pinterest.onAccount
          ? "on the account"
          : "NOT on the account";
    lines.push(`Pinterest board: ${p.pinterest.board ?? "none"}, ${on}`);
  }
  if (p.x) lines.push(`X cost: ~$${p.x.estimateUsd.toFixed(3)} (${p.x.posts} posts, ${p.x.postsWithUrl} with a URL)`);
  lines.push(
    p.duplicates.length
      ? `duplicates: ${p.duplicates.map((d) => `${d.id} (${d.status}, same ${d.reason})`).join(", ")}`
      : "duplicates: none",
  );
  lines.push(`ring: next tick ${p.ring.next}${p.ring.releaseAt ? `, releases this draft at ${p.ring.releaseAt}` : ""}`);
  for (const b of p.blockers) lines.push(`  blocker: ${b}`);
  return lines.join("\n");
}

export function registerPreflight(program: Command, api: () => ApiClient): void {
  program
    .command("preflight <id>")
    .description(
      "Read-only check before a person approves: QA, rendersHash, routes, LinkedIn write scope, Pinterest board, X cost, duplicates, ring tick",
    )
    .option("--json", "print the API's answer as JSON")
    .action(async (id: string, o: { json?: boolean }) => {
      const p = await api().request<PreflightView>("GET", `/drafts/${encodeURIComponent(id)}/preflight`);
      console.log(o.json ? JSON.stringify(p, null, 2) : renderPreflight(p));
    });
}
