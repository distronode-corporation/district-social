import {
  SPECS,
  effectiveMaxChars,
  threadReplies,
  vendorLength,
  type ChannelRulesSnapshot,
  type Draft,
  type QAReport,
} from "../../src/index.js";

const SEV_ICON = { fail: "✗", warn: "⚠", info: "·" } as const;

/**
 * @param rules Live vendor rules, when the caller has a snapshot. The header
 * counter has to show the cap the formatter TRIMMED to and QA measures against,
 * which is the vendor's where we have one. Printing SPECS[p].maxChars showed
 * "1200/280" on the X Premium account for copy that was deliberately kept and
 * passes every gate.
 */
export function renderDraft(draft: Draft, rules: ChannelRulesSnapshot | null = null): string {
  const lines: string[] = [];
  lines.push(`Draft ${draft.id}  [${draft.status}]`);
  lines.push(
    `  targets: ${draft.targets.join(", ")}  media: ${draft.source.media.length}  ` +
      (draft.scheduledFor ? `scheduled: ${draft.scheduledFor}  ` : "") +
      (draft.providerPostId ? `postiz: ${draft.providerPostId}` : ""),
  );
  lines.push("");
  lines.push(`SOURCE: ${draft.source.text.slice(0, 200)}${draft.source.text.length > 200 ? "…" : ""}`);
  if (draft.source.link) lines.push(`LINK:   ${draft.source.link}`);
  lines.push("");

  for (const r of draft.renders) {
    const s = SPECS[r.platform];
    const len = vendorLength(r.platform, r.content);
    const cap = effectiveMaxChars(rules, r.platform, s.maxChars);
    const bar = "─".repeat(Math.max(4, 60 - s.displayName.length));
    lines.push(`┌─ ${s.displayName} ${bar} ${len}/${cap}`);
    if (r.title) lines.push(`│ TITLE: ${r.title}`);
    if (r.subreddit) lines.push(`│ SUBREDDIT: r/${r.subreddit}`);
    for (const line of r.content.split("\n")) lines.push(`│ ${line}`);
    // The root above, then every reply as the transports send them (types.ts):
    // a leading copy of the body in a stored row is not a reply, and a platform
    // without reply chains sends none of them.
    const replies = threadReplies(r);
    const unsent = s.supportsThreads ? "" : " (not sent)";
    replies.forEach((t, i) => {
      lines.push(`│ ── reply ${i + 1}/${replies.length}${unsent} ──`);
      for (const line of t.split("\n")) lines.push(`│ ${line}`);
    });
    if (r.firstComment) {
      lines.push(`│ ┄ first comment ┄`);
      for (const line of r.firstComment.split("\n")) lines.push(`│ ${line}`);
    }
    if (r.mediaIndices.length) {
      lines.push(`│ media: [${r.mediaIndices.join(", ")}]`);
    }
    lines.push(`└${"─".repeat(70)}`);
    lines.push("");
  }

  if (draft.qa) lines.push(renderQa(draft.qa));
  return lines.join("\n");
}

export function renderQa(qa: QAReport): string {
  const lines: string[] = [];
  lines.push(`QA ${qa.pass ? "PASS" : "FAIL"} (${qa.ranAt})`);
  if (qa.llmSummary) lines.push(`  ${qa.llmSummary}`);
  for (const i of qa.issues) {
    lines.push(
      `  ${SEV_ICON[i.severity]} ${i.platform ? `[${i.platform}] ` : ""}${i.code}: ${i.message}`,
    );
  }
  if (!qa.issues.length) lines.push("  no issues");
  return lines.join("\n");
}
