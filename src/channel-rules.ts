// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

import { connectedAccounts } from "./publish.js";
import { routeTransportFor } from "./transport.js";
import { ALL_PLATFORMS, type Platform } from "./types.js";
import { countUnit } from "./length.js";
import type { CountMode } from "./transport.js";

/**
 * The vendor limits a platform will actually enforce, for the platforms that
 * are routed and connected right now.
 *
 * ⚠️ They come from each transport's own `channelRules()`, which is precisely
 * why that method is NOT optional on `DirectTransport`: a transport that forgot
 * to supply them would not fail, the length gate would just stop checking that
 * platform, silently, which is the worst possible failure for a gate.
 *
 * Our hand-kept SPECS are researched best-practice; THIS is the contract each
 * transport declares against its own vendor's documentation. Where they
 * disagree this wins, because this is the number the publish path enforces
 * (media-fit.ts reads the same object).
 *
 * ⛔ There is deliberately no `settingsSchema`. A direct transport takes a
 * `PublishDestination`, not a settings blob, so no request this system makes
 * carries a vendor `settings` object. Validating against a schema for a
 * payload nobody sends is worse than not validating: it reads like a gate and
 * enforces nothing. The refusals that mattered (a missing Pinterest board, a
 * subreddit that will not take this post) live in `assertPublishable`.
 */
export interface ChannelRules {
  platform: Platform;
  /** The vendor's hard cap, in `countMode`'s unit. Authoritative over SPECS[p].maxChars. */
  maxLength?: number;
  /**
   * The unit `maxLength` is counted in. Optional because a stored snapshot can
   * predate it; absent reads as plain characters.
   */
  countMode?: CountMode;
}

export type ChannelRulesMap = Partial<Record<Platform, ChannelRules>>;

export interface ChannelRulesSnapshot {
  fetchedAt: string;
  channels: ChannelRulesMap;
}

/**
 * Build the snapshot from the registered transports.
 *
 * Still async and still shaped like a fetch, because it still asks
 * `connectedAccounts()` which platforms are actually routed: a limit for a
 * platform nothing publishes to is not a rule anyone needs. There is no
 * network call per channel, so there are no per-channel failures to report
 * and the `failures` array is always empty; it keeps the refresh job's
 * reporting shape stable.
 */
export async function fetchChannelRules(
  now: () => Date = () => new Date(),
): Promise<{ snapshot: ChannelRulesSnapshot; failures: Array<{ platform: string; error: string }> }> {
  const connected = await connectedAccounts({ fresh: true });
  const channels: ChannelRulesMap = {};

  for (const platform of ALL_PLATFORMS) {
    const account = connected[platform];
    if (!account) continue;
    // ⚠️ `routeTransportFor`, so an AGGREGATOR-routed platform contributes the
    // AGGREGATOR's limits. Asking only for a direct transport would leave
    // those platforms out of the snapshot entirely, and `effectiveMaxChars` would
    // fall back to SPECS (the engine's researched number for the vendor, not the
    // aggregator's, which is frequently stricter). The formatter would be told
    // it had more room than the thing doing the publishing would accept.
    const routed = await routeTransportFor(platform);
    if (!routed) continue;
    const limits = routed.transport.channelRules();
    channels[platform] = {
      platform,
      maxLength: limits.maxLength,
      countMode: limits.countMode,
    };
  }

  return { snapshot: { fetchedAt: now().toISOString(), channels }, failures: [] };
}

/**
 * Vendor rules as a prompt section, appended after our researched SPECS block.
 * Deliberately labelled as authoritative so the model resolves any conflict with
 * our own guidance in the vendor's favour.
 */
export function rulesBlock(snapshot: ChannelRulesSnapshot | null, platforms: Platform[]): string {
  if (!snapshot) return "";
  const lines: string[] = [];
  for (const p of platforms) {
    const r = snapshot.channels[p];
    if (!r) continue;
    const parts: string[] = [];
    if (r.maxLength !== undefined) {
      parts.push(`- HARD limit from the platform: ${r.maxLength} ${countUnit(r.countMode ?? "utf16")}`);
    }
    if (parts.length) lines.push(`### ${p}\n${parts.join("\n")}`);
  }
  if (!lines.length) return "";
  return [
    "## LIVE PLATFORM RULES (authoritative)",
    "Each network's own documented limit, as the transport that publishes there",
    "declares it. Where these conflict with the guidance above, THESE WIN — a",
    "violation is rejected at publish time.",
    "",
    lines.join("\n\n"),
  ].join("\n");
}

/**
 * The effective character cap: the transport's number when we have it,
 * otherwise our researched one. Callers pass SPECS[p].maxChars as the fallback.
 */
export function effectiveMaxChars(
  snapshot: ChannelRulesSnapshot | null,
  platform: Platform,
  fallback: number,
): number {
  const live = snapshot?.channels[platform]?.maxLength;
  return typeof live === "number" && live > 0 ? live : fallback;
}
