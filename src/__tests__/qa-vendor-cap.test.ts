/**
 * The QA length gate has to agree with the formatter about what "too long" is.
 *
 * format.ts trims to `effectiveMaxChars(channelRules, p, SPECS[p].maxChars)` —
 * the LIVE vendor cap — and says so in a comment: "Where Postiz allows MORE (X
 * Premium), this stops us trimming copy the platform would have accepted."
 * deterministicChecks then measured that same text against the hardcoded
 * SPECS[p].maxChars (280 for X) and emitted `severity: "fail"`, while
 * channelRuleChecks measured it against the live `rules.maxLength` and passed
 * it. One report, two contradictory findings, on the account that HAS Premium —
 * and the "fail" is unactionable, because trimming to 280 is exactly what the
 * formatter deliberately declined to do.
 *
 * The rule now: where a live cap exists, channelRuleChecks owns the finding
 * (code `vendor-length`, in the vendor's own numbers); where it does not, the
 * researched spec is still enforced by deterministicChecks. Exactly one of the
 * two fires, never both, never neither.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../claude.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../claude.js")>()),
  genJson: vi.fn(),
}));

import { deterministicChecks } from "../qa.js";
import { SPECS } from "../specs.js";
import type { Draft, Platform, PlatformRender } from "../types.js";
import type { ChannelRules, ChannelRulesSnapshot } from "../channel-rules.js";

function draftWith(renders: PlatformRender[]): Draft {
  return {
    id: "d1",
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
    status: "draft",
    source: { text: "source text", hashtags: [], media: [] },
    targets: renders.map((r) => r.platform),
    renders,
  };
}

function render(platform: Platform, extra: Partial<PlatformRender> = {}): PlatformRender {
  return { platform, content: "", mediaIndices: [], ...extra };
}

function snapshot(platform: Platform, maxLength?: number): ChannelRulesSnapshot {
  // `integrationId`, `settingsSchema` and `tools` were on this fixture until
  // 2026-08-06. All three were the aggregator's fields and channel-rules.ts
  // dropped them when the vendor limits moved to each transport's own
  // channelRules(); deterministicChecks only ever read maxLength.
  const channel: ChannelRules = {
    platform,
    maxLength,
  };
  return { fetchedAt: "2026-07-29T00:00:00.000Z", channels: { [platform]: channel } };
}

const lengthCodes = (draft: Draft, rules: ChannelRulesSnapshot | null = null) =>
  deterministicChecks(draft, rules)
    .filter((i) => i.code === "over-limit" || i.code === "vendor-length")
    .map((i) => i.code);

/** X Premium: the live cap is far above our researched free-tier 280. */
const PREMIUM = 25_000;

describe("the length gate agrees with the formatter's cap", () => {
  it("does NOT fail copy the live cap allows, even though it is over SPECS.maxChars", () => {
    // The bug, stated directly. 1,200 chars on X: SPECS says 280, Postiz says
    // 25,000, and format.ts kept all 1,200 on purpose.
    const draft = draftWith([render("twitter", { content: "a".repeat(1200) })]);

    expect(lengthCodes(draft, snapshot("twitter", PREMIUM))).toEqual([]);
  });

  it("reports the same text exactly ONCE when it exceeds the live cap", () => {
    // Both rules now read the same number, so the risk flips from disagreement
    // to duplication: one issue, from channelRuleChecks, in the vendor's terms.
    const draft = draftWith([render("twitter", { content: "a".repeat(PREMIUM + 1) })]);
    const issues = deterministicChecks(draft, snapshot("twitter", PREMIUM)).filter(
      (i) => i.code === "over-limit" || i.code === "vendor-length",
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: "vendor-length", severity: "fail", platform: "twitter" });
    expect(issues[0]!.message).toContain(String(PREMIUM));
  });

  it("still enforces the researched spec when there is NO snapshot", () => {
    // Removing the snapshot must never silently remove the length gate. This is
    // the degradation path: nightly refresh failing, or a cold system.
    const draft = draftWith([render("twitter", { content: "a".repeat(300) })]);

    expect(lengthCodes(draft, null)).toEqual(["over-limit"]);
  });

  it("still enforces the researched spec when the snapshot has no cap for that channel", () => {
    // Postiz answers with `maxLength` absent for some providers. That is "we do
    // not know", not "unlimited".
    const draft = draftWith([render("twitter", { content: "a".repeat(300) })]);

    expect(lengthCodes(draft, snapshot("twitter", undefined))).toEqual(["over-limit"]);
  });

  it("still enforces the researched spec for a platform missing from the snapshot", () => {
    // A partial snapshot is normal: fetchChannelRules keeps going when one
    // channel fails. Platforms it did not cover must not lose their gate.
    const draft = draftWith([render("twitter", { content: "a".repeat(300) })]);

    expect(lengthCodes(draft, snapshot("reddit", 10_000))).toEqual(["over-limit"]);
  });

  it("uses a live cap that is LOWER than the spec, and reports it once", () => {
    // The other direction, and the one that motivated channel rules: Postiz
    // reports 10,000 for Reddit against Reddit's own 40,000. Our spec already
    // says 10,000, so use a deliberately lower live cap to prove which wins.
    const draft = draftWith([render("reddit", { content: "a".repeat(600), title: "t" })]);

    const issues = deterministicChecks(draft, snapshot("reddit", 500)).filter(
      (i) => i.code === "over-limit" || i.code === "vendor-length",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: "vendor-length" });
    expect(issues[0]!.message).toContain("500");
    // …and the same copy is clean against the researched 10,000 alone.
    expect(lengthCodes(draft, null)).toEqual([]);
  });

  it("treats a zero or negative live cap as no cap at all", () => {
    // effectiveMaxChars requires `> 0`; a 0 from the vendor would otherwise fail
    // every post ever written.
    const draft = draftWith([render("twitter", { content: "a".repeat(300) })]);

    expect(lengthCodes(draft, snapshot("twitter", 0))).toEqual(["over-limit"]);
  });

  it("applies the live cap to a first comment too, since the vendor caps every value it is sent", () => {
    // Facebook, because its transport posts the first comment (X's never sends one).
    const LIVE = 2000;
    const overLong = draftWith([
      render("facebook", { content: "body", firstComment: "c".repeat(LIVE + 1) }),
    ]);
    const withinLive = draftWith([
      render("facebook", { content: "body", firstComment: "c".repeat(1000) }),
    ]);
    const rules = snapshot("facebook", LIVE);

    expect(
      deterministicChecks(overLong, rules).filter((i) => i.code === "vendor-length"),
    ).toHaveLength(1);
    expect(lengthCodes(withinLive, rules)).toEqual([]);
  });

  it("leaves the feed-truncation info finding on the researched fold, not the cap", () => {
    // truncationPoint is where the timeline shows "Show more". Premium raises
    // the hard cap and does NOT move the fold, so the hook still has to land
    // inside 280 and the operator still needs to be told.
    const draft = draftWith([render("twitter", { content: "a".repeat(1200) })]);
    const issues = deterministicChecks(draft, snapshot("twitter", PREMIUM));

    const truncation = issues.find((i) => i.code === "truncation");
    expect(truncation).toMatchObject({ severity: "info", platform: "twitter" });
    expect(truncation!.message).toContain(String(SPECS.twitter.truncationPoint));
  });
});
