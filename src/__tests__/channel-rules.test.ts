// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from "vitest";

/**
 * Channel rules after the aggregator.
 *
 * ⚠️ THE SOURCE CHANGED AND THIS SUITE CHANGED WITH IT. These limits used to be
 * fetched per channel from the aggregator's `GET /integration-settings/:id`, so
 * the old tests mocked that HTTP call and asserted the parsing of its response
 * — including a `settingsSchema` that drove a `vendor-schema` QA check. Both
 * are gone: the limits now come from each transport's own `channelRules()`, and
 * there is no settings blob left to validate because a direct transport takes a
 * `PublishDestination`.
 *
 * What survives is the part that was always load-bearing: a transport's number
 * BEATS our researched SPECS number, and QA reports the difference.
 */

import { invalidateConnectedAccounts } from "../publish.js";
import { fetchChannelRules, rulesBlock, effectiveMaxChars } from "../channel-rules.js";
import { channelRuleChecks } from "../qa.js";
import { registerTransport, resetTransports } from "../transport.js";
import type { DirectTransport } from "../transport.js";
import type { ChannelRulesSnapshot } from "../channel-rules.js";
import type { Draft, Platform, PlatformRender } from "../types.js";

function transport(platform: Platform, maxLength: number): DirectTransport {
  return {
    platform,
    channelRules: () => ({ maxLength, countMode: "utf16" }),
    connectStatus: async () => ({
      connected: true,
      accountId: `${platform}-1`,
      displayName: `${platform} acct`,
    }),
    publishNow: async () => ({ ref: "x" }),
    deletePost: async () => {},
    postFacts: async () => new Map(),
    postUrl: (r: string) => `https://example.test/${r}`,
  };
}

beforeEach(() => {
  invalidateConnectedAccounts();
  resetTransports();
  process.env.SOCIALMETA_TRANSPORT_OVERRIDES = JSON.stringify({ twitter: "direct", reddit: "direct" });
});

afterEach(() => {
  resetTransports();
  delete process.env.SOCIALMETA_TRANSPORT_OVERRIDES;
  invalidateConnectedAccounts();
});

function snapshot(channels: ChannelRulesSnapshot["channels"]): ChannelRulesSnapshot {
  return { fetchedAt: "2026-08-03T00:00:00.000Z", channels };
}

function draft(renders: PlatformRender[]): Draft {
  return {
    id: "d1",
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:00.000Z",
    status: "draft",
    source: { text: "body", hashtags: [], media: [] },
    targets: renders.map((r) => r.platform),
    renders,
  };
}

describe("fetchChannelRules", () => {
  it("reads the limit from each ROUTED transport, and skips the rest", async () => {
    registerTransport(transport("twitter", 4000));
    // Registered but NOT routed (no override for it), so it must not appear: a
    // limit for a platform nothing publishes to is not a rule anyone needs.
    registerTransport(transport("bluesky", 300));

    const { snapshot: snap, failures } = await fetchChannelRules(
      () => new Date("2026-08-03T00:00:00.000Z"),
    );
    expect(Object.keys(snap.channels)).toEqual(["twitter"]);
    expect(snap.channels.twitter).toEqual({ platform: "twitter", maxLength: 4000, countMode: "utf16" });
    // No per-channel network call left to fail.
    expect(failures).toEqual([]);
  });

  it("returns an empty snapshot when nothing is routed", async () => {
    delete process.env.SOCIALMETA_TRANSPORT_OVERRIDES;
    invalidateConnectedAccounts();
    registerTransport(transport("twitter", 4000));
    const { snapshot: snap } = await fetchChannelRules(() => new Date("2026-08-03T00:00:00.000Z"));
    expect(snap.channels).toEqual({});
  });
});

describe("effectiveMaxChars", () => {
  it("prefers the transport's number over the researched fallback", () => {
    const snap = snapshot({ twitter: { platform: "twitter", maxLength: 4000 } });
    expect(effectiveMaxChars(snap, "twitter", 280)).toBe(4000);
  });

  it("falls back when the snapshot is missing, empty, or carries a nonsense limit", () => {
    expect(effectiveMaxChars(null, "twitter", 280)).toBe(280);
    expect(effectiveMaxChars(snapshot({}), "twitter", 280)).toBe(280);
    expect(
      effectiveMaxChars(
        snapshot({ twitter: { platform: "twitter", maxLength: 0 } }),
        "twitter",
        280,
      ),
    ).toBe(280);
  });
});

describe("rulesBlock", () => {
  it("renders only the platforms asked for, and nothing at all when it has no numbers", () => {
    const snap = snapshot({
      twitter: { platform: "twitter", maxLength: 4000 },
      reddit: { platform: "reddit", maxLength: 40000 },
    });
    const block = rulesBlock(snap, ["twitter"]);
    expect(block).toContain("### twitter");
    expect(block).toContain("4000");
    expect(block).not.toContain("### reddit");

    expect(rulesBlock(null, ["twitter"])).toBe("");
    expect(rulesBlock(snapshot({}), ["twitter"])).toBe("");
    // A stored snapshot entry can predate maxLength (the field is optional on
    // the map); with nothing to state, the platform contributes no section.
    expect(rulesBlock(snapshot({ twitter: { platform: "twitter" } }), ["twitter"])).toBe("");
  });

  it("names the UNIT each limit is counted in, so 300 graphemes never reads as 300 characters", () => {
    const snap = snapshot({
      twitter: { platform: "twitter", maxLength: 280, countMode: "weighted" },
      bluesky: { platform: "bluesky", maxLength: 300, countMode: "grapheme" },
      youtube: { platform: "youtube", maxLength: 5000, countMode: "utf8bytes" },
      // A stored snapshot can predate countMode: plain characters, as before.
      reddit: { platform: "reddit", maxLength: 40000 },
    });
    const block = rulesBlock(snap, ["twitter", "bluesky", "youtube", "reddit"]);
    expect(block).toContain("HARD limit from the platform: 280 weighted chars (X weighting: every link 23, emoji and CJK 2)");
    expect(block).toContain("HARD limit from the platform: 300 graphemes (each emoji counts 1)");
    expect(block).toContain("HARD limit from the platform: 5000 UTF-8 bytes (accented letters 2, emoji 4)");
    expect(block).toContain("HARD limit from the platform: 40000 chars");
  });
});

describe("channelRuleChecks", () => {
  it("fails a value over the transport's limit, quoting that number", () => {
    const snap = snapshot({ twitter: { platform: "twitter", maxLength: 50 } });
    const issues = channelRuleChecks(
      draft([{ platform: "twitter", content: "a".repeat(51), mediaIndices: [] }]),
      snap,
    );
    const hit = issues.find((i) => i.code === "vendor-length");
    expect(hit).toMatchObject({ severity: "fail", platform: "twitter" });
    expect(hit!.message).toContain("50");
  });

  it("says nothing when the copy fits", () => {
    const snap = snapshot({ twitter: { platform: "twitter", maxLength: 50 } });
    const issues = channelRuleChecks(
      draft([{ platform: "twitter", content: "short", mediaIndices: [] }]),
      snap,
    );
    expect(issues.filter((i) => i.code === "vendor-length")).toEqual([]);
  });

  it("is inert without a snapshot, rather than guessing", () => {
    expect(
      channelRuleChecks(
        draft([{ platform: "twitter", content: "a".repeat(9000), mediaIndices: [] }]),
        null,
      ),
    ).toEqual([]);
  });

  it("raises destination-invalid for a reddit render with no subreddit", () => {
    // The refusal `assertPublishable` owns, surfaced at QA time rather than at
    // publish time. This is what replaced `vendor-schema`: the publish path's
    // own preflight, not a second model of it built from a vendor JSON Schema.
    const snap = snapshot({ reddit: { platform: "reddit", maxLength: 40000 } });
    const issues = channelRuleChecks(
      draft([{ platform: "reddit", content: "body", mediaIndices: [] }]),
      snap,
    );
    const hit = issues.find((i) => i.code === "destination-invalid");
    expect(hit).toMatchObject({ severity: "fail", platform: "reddit" });
    expect(hit!.message).toMatch(/subreddit/i);
  });

  it("stays quiet for a reddit render that names its subreddit", () => {
    const snap = snapshot({ reddit: { platform: "reddit", maxLength: 40000 } });
    const issues = channelRuleChecks(
      draft([{ platform: "reddit", content: "body", subreddit: "saas", mediaIndices: [] }]),
      snap,
    );
    expect(issues).toEqual([]);
  });
});
