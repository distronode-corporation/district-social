// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

import type { Command } from "commander";
import type { ApiClient } from "./api.js";

/**
 * `social unschedule <id>`: POST /api/internal/social/drafts/<id>/unschedule,
 * which takes an agent's scheduled draft off the publish ring while every leg
 * is still `<platform>:pending`, and cancels the approval it spent.
 * Publishing it again needs a new approval from a person. Its own module so
 * cli.ts only registers it.
 */
export function registerUnschedule(program: Command, api: () => ApiClient): void {
  program
    .command("unschedule <id>")
    .description("Take a scheduled agent draft off the ring before any leg goes out; its approval is cancelled")
    .option("--session <id>", "your session id (default: CLAUDE_CODE_SESSION_ID)")
    .option("--json", "print the API's answer as JSON")
    .action(async (id: string, o: { session?: string; json?: boolean }) => {
      const sessionId = o.session ?? process.env.CLAUDE_CODE_SESSION_ID;
      if (!sessionId) throw new Error("unschedule needs --session <id> (or CLAUDE_CODE_SESSION_ID)");
      const out = await api().request<{ draftId: string; status: string; removedLegs: string[] }>(
        "POST",
        `/drafts/${encodeURIComponent(id)}/unschedule`,
        { sessionId },
      );
      console.log(
        o.json
          ? JSON.stringify(out, null, 2)
          : `unscheduled ${out.draftId}: now ${out.status}; removed ${out.removedLegs.join(", ")}. Its approval is cancelled.`,
      );
    });
}
