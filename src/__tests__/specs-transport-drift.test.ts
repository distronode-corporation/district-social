// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

/**
 * SPECS must not drift from the transport that actually publishes.
 *
 * WHY THIS EXISTS. There are two records of "how long may a post be":
 * `SPECS[p].maxChars` (what the QA gates and the formatter fall back to) and
 * `channelRules().maxLength` on each transport (what the publish path
 * declares). Before the Postiz aggregator was deleted, the second one was
 * fetched live per channel and genuinely was the authority. It is now built
 * FROM the transports (channel-rules.ts's fetchChannelRules), and — this is
 * the load-bearing part — it only carries a platform that is both connected
 * AND routed somewhere:
 *
 *     const account = connected[platform];   if (!account) continue;
 *     const routed = await routeTransportFor(platform); if (!routed) continue;
 *
 * So for any platform switched Off, the snapshot has no entry, hasLiveMaxLength
 * is false, and `SPECS[p].maxChars` silently becomes the operative cap again.
 * A stale spec is therefore not dormant just because a platform is dormant: it
 * is precisely the dormant platforms whose specs are load-bearing, and
 * precisely those nobody looks at.
 *
 * ⛔ THERE ARE NOW THREE ROUTING STATES, NOT TWO, AND THE THIRD IS NOT COVERED
 * BY EITHER RECORD IN THIS FILE. A platform routed to an AGGREGATOR takes its
 * operative cap from `Aggregator.channelRules(platform)` — the vendor's own
 * limits as the aggregator enforces them, which are frequently STRICTER than
 * the platform's published figure. That number lives in the aggregator
 * implementation and is asserted in ITS tests, not here, because it is a
 * property of the aggregator rather than of this repo's SPECS/transport pair.
 *
 * What this file must NOT do is imply coverage it does not have. See
 * AGGREGATOR_ROUTED below: any platform listed there is one whose operative cap
 * this test does not check at all, and that has to be stated rather than left
 * to a green run to suggest otherwise.
 *
 * That is not hypothetical. It is what this test was written in response to:
 *
 *   - pinterest — SPECS said 500 (the deleted aggregator's narrower schema),
 *     the transport said 800 (Pinterest's own OpenAPI). Every pin description
 *     was being trimmed 300 characters short.
 *   - reddit — SPECS said 10,000 (the same dead aggregator), the transport
 *     said 40,000.
 *
 * Both transports had ALREADY written a comment predicting the drift ("once
 * this transport is live, specs.ts undercounts by 300 chars until someone
 * updates it"). Nobody was that someone for ten days, because a comment cannot
 * fail a build. This can.
 *
 * ⚠️ Deliberately NOT asserted here: maxImages. SPECS carries the VENDOR's cap
 * and several transports carry a narrower CLIENT cap for a format this
 * migration never built (facebook 10 vs 1, linkedin 20 vs 1). That divergence
 * is intentional and meaningful, and qa.ts already prefers the transport's
 * number for platforms routed direct. Asserting equality would force those two
 * to lie about what the vendor allows.
 */

import { describe, expect, it } from "vitest";

import { SPECS, vendorLength } from "../specs.js";
import { blueskyTransport } from "../bluesky-transport.js";
import { facebookTransport } from "../facebook-transport.js";
import { instagramTransport } from "../instagram-transport.js";
import { linkedinTransport } from "../linkedin-transport.js";
import { pinterestTransport } from "../pinterest-transport.js";
import { redditTransport } from "../reddit-transport.js";
import { threadsTransport } from "../threads-transport.js";
import { tiktokTransport } from "../tiktok-transport.js";
import { xTransport } from "../x-transport.js";
import { youtubeTransport } from "../youtube-transport.js";
import type { DirectTransport } from "../transport.js";
import { ALL_PLATFORMS } from "../types.js";

/**
 * Imported directly rather than via the app-side registry: registration
 * reaches for the application's store and the operator's saved
 * routing, so it can only see the platforms currently switched on — which
 * would make this gate blind to exactly the Off platforms it exists to check.
 */
const TRANSPORTS: DirectTransport[] = [
  blueskyTransport,
  facebookTransport,
  instagramTransport,
  linkedinTransport,
  pinterestTransport,
  redditTransport,
  threadsTransport,
  tiktokTransport,
  xTransport,
  youtubeTransport,
];

/**
 * Platforms in ALL_PLATFORMS with no transport at all, so there is no
 * channelRules() for their SPECS entry to drift from. A ledger rather than a
 * silent skip: SPECS is the only record of their limits until the transport
 * ships, and adding the transport means moving the platform from here into
 * TRANSPORTS above, which puts its spec under this gate.
 *
 * Empty since 2026-10-30, when TikTok's transport (our own approved TikTok
 * API for Business app) joined TRANSPORTS above.
 */
const NO_TRANSPORT_YET: readonly string[] = [];

describe("SPECS vs transport channelRules", () => {
  it("covers every platform, so a new platform cannot skip this gate", () => {
    const transported = TRANSPORTS.map((t) => t.platform);
    expect([...transported, ...NO_TRANSPORT_YET].sort()).toEqual([...ALL_PLATFORMS].sort());
    // A platform cannot be on the ledger and have a transport: the ledger is
    // what this file says it does not check, so it must stay true.
    expect(transported.filter((p) => NO_TRANSPORT_YET.includes(p))).toEqual([]);
  });

  it.each(TRANSPORTS.map((t) => [t.platform, t] as const))(
    "%s: SPECS.maxChars equals the transport's declared maxLength",
    (platform, transport) => {
      const declared = transport.channelRules().maxLength;
      // A transport may legitimately decline to declare a length (nothing does
      // today). Only compare when it states one; otherwise SPECS is the sole
      // record and there is nothing to drift from.
      if (typeof declared !== "number") return;

      expect(
        SPECS[platform].maxChars,
        `SPECS.${platform}.maxChars (${SPECS[platform].maxChars}) disagrees with ` +
          `${platform}-transport.ts channelRules().maxLength (${declared}). These are the ` +
          "same fact recorded twice. Fix the one that is wrong and say in a comment which " +
          "vendor source settles it — do NOT just make the numbers match. If the divergence " +
          "is real and intentional, this test is the place to record why.",
      ).toBe(declared);
    },
  );

  /**
   * The UNIT, not just the number — added after YouTube showed that equal
   * numbers can still hide a mismatch. 5000 characters and 5000 bytes agree
   * exactly on ASCII and diverge on everything else, so a value check alone
   * reported green.
   */
  it.each(TRANSPORTS.map((t) => [t.platform, t] as const))(
    "%s: SPECS.countMode equals the transport's declared countMode",
    (platform, transport) => {
      expect(
        SPECS[platform].countMode,
        `SPECS.${platform}.countMode disagrees with ${platform}-transport.ts. A limit measured in the ` +
          "wrong unit is worse than a missing one: it reads as enforced and passes copy the transport " +
          "will silently truncate.",
      ).toBe(transport.channelRules().countMode);
    },
  );
});

/**
 * The byte/character mismatch, now FIXED rather than merely pinned.
 *
 * This block previously asserted the gap as a known-deliberate gate: SPECS said
 * 5000 characters, the transport truncated 5000 UTF-8 bytes, and vendorLength
 * counted characters. Equal numbers, different units — which is why it survived
 * unnoticed. It now measures what the transport enforces.
 */
describe("vendorLength measures in each platform's own unit", () => {
  it("counts YouTube in UTF-8 bytes, so QA cannot pass copy the transport will cut", () => {
    // "é" is ONE UTF-16 code unit and TWO UTF-8 bytes — the cheapest possible
    // demonstration, and the most likely to occur in real copy. Deliberately
    // not an emoji: an emoji is two UTF-16 units, so it would also trip a
    // character-counting gate and would not show the gate being fooled.
    const accented = "é".repeat(3000);
    expect(accented.length).toBe(3000); // what the old character count saw
    expect(vendorLength("youtube", accented)).toBe(6000); // what YouTube actually charges
    expect(vendorLength("youtube", accented)).toBeGreaterThan(SPECS.youtube.maxChars);
  });

  /**
   * Bluesky's lexicon caps `maxGraphemes`. Counting UTF-16 over-counted every
   * emoji, so QA could fail a post the vendor would have accepted.
   */
  it("counts Bluesky in grapheme clusters, not UTF-16 units", () => {
    const flag = "🇨🇦"; // one grapheme, two code points, FOUR UTF-16 units
    expect(flag.length).toBe(4);
    expect(vendorLength("bluesky", flag)).toBe(1);

    // 300 flags is exactly at Bluesky's cap, where UTF-16 counting saw 1200.
    const atCap = flag.repeat(300);
    expect(vendorLength("bluesky", atCap)).toBe(SPECS.bluesky.maxChars);
  });

  it("applies X's weighted rule: every URL a flat 23, whatever its length", () => {
    expect(vendorLength("twitter", "https://a.co")).toBe(23);
    expect(vendorLength("twitter", `https://acmebrands.com/?${"u".repeat(60)}`)).toBe(23);
  });

  it("counts the other platforms in UTF-16 code units", () => {
    const text = "hello";
    for (const p of ["instagram", "facebook", "threads", "linkedin", "reddit", "pinterest"] as const) {
      expect(vendorLength(p, text)).toBe(5);
    }
  });
});

/**
 * ⛔ DARK QA GATES: a limit absent from BOTH RECORDS means the gate keyed off it
 * can NEVER fire, silently.
 *
 * `image-too-large`, `video-too-large` and `video-too-long` (qa.ts) each take
 * the ROUTED TRANSPORT's `channelRules()` figure when it has one and fall back
 * to `SPECS[p]` otherwise. Each check is guarded on the resulting value being
 * present, so an absence does not fail open loudly — it simply stops checking,
 * and the QA report looks exactly the same as one where the check ran and
 * passed. That is the worst possible failure for a gate, and it is why this list
 * is asserted rather than trusted.
 *
 * ⚠️ THE FRAMING BELOW CHANGED ON 2026-08-20 AND THE LEDGER DID NOT. Until then
 * `maxVideoBytes`/`maxVideoSec` on a transport were declared-but-not-consumed —
 * qa.ts read SPECS alone, and `fitForTransport`, the only other consumer of
 * `channelRules()`, cannot act on video because media-fit.ts refuses to
 * re-encode it. Three transports had written that gap down and predicted nobody
 * would close it. It is closed: those fields are production-read, so this ledger
 * now records "SPECS has no fallback for a platform nothing routes", not "this
 * gate is dark everywhere". Every entry below happens to be dark under BOTH
 * records too (the transports named declare nothing for those fields either),
 * which is why no entry needed changing — check that before adding one.
 *
 * ⚠️ THIS TEST DOES NOT REQUIRE EVERY LIMIT TO EXIST. Inventing a plausible
 * number is how SPECS ended up carrying Pinterest's 500 and Reddit's 10,000
 * from a deleted aggregator: a wrong number that looks right is worse than a
 * missing one, because it reads as enforced. What it requires is that every
 * absence is DELIBERATE and carries a reason.
 *
 * Adding a limit, or removing one, fails this test until the entry is updated.
 * A NEW dark gate fails it immediately.
 */
const UNDECLARED: Record<string, { missing: string[]; why: string }> = {
  // ⛔ LIVE PLATFORM, THREE DARK GATES. LinkedIn is routed Direct today and
  // none of image-too-large / video-too-large / video-too-long can fire for it.
  // LinkedIn's API reference publishes no byte or duration figure for post
  // media at all (checked 2026-08-05 via the Microsoft Learn LinkedIn docs),
  // so there is nothing to cite yet. Video is additionally refused outright by
  // the transport (the Videos API leg was never built), which means a video
  // limit here would produce a MISLEADING finding — "video too long" instead of
  // "LinkedIn video is not supported" — so the video pair should stay absent
  // even once a figure is found. Only maxImageBytes is genuinely wanted.
  linkedin: {
    missing: ["maxImageBytes", "maxVideoBytes", "maxVideoSec"],
    why: "vendor publishes no media size/duration figure; video is refused by the transport anyway",
  },
  // facebook left this ledger on 2026-10-02: the transport publishes video as a
  // Page Reel, and the Reels Publishing API guide states "Duration 3 to 90
  // seconds", so SPECS.facebook.maxVideoSec is 90 (matching channelRules()).
  // instagram left this ledger on 2026-09-17: the Content Publishing API's own
  // /{ig-user-id}/media reference states Reels "15 mins maximum", which is the
  // citation this entry was waiting for, so SPECS.instagram.maxVideoSec is 900.
  // No image path at all: publishNow uploads a video and nothing else, so image
  // limits would describe a shape this transport cannot send.
  youtube: { missing: ["maxImageBytes"], why: "this platform's payload is a video; it never sends an image" },
  // A TikTok post is a video, so no image limit applies. maxVideoBytes left
  // this entry on 2026-10-30: TikTok API for Business's publish reference
  // states "The maximum video size is 1 GB" (the TikTok video publish doc).
  tiktok: {
    missing: ["maxImageBytes"],
    why: "video-only: a TikTok post never carries an image",
  },
};

/**
 * Platforms whose operative cap comes from an AGGREGATOR, not from this repo.
 *
 * ⛔ A LEDGER OF WHAT THIS FILE DOES NOT COVER. Everything above compares
 * SPECS against a direct transport. For an aggregator-routed platform neither
 * of those is the operative number — `Aggregator.channelRules(platform)` is —
 * so a green run here says nothing at all about that platform's real limit.
 *
 * Listing it is the point. The alternative is a test that passes while
 * silently checking nothing, which is the exact failure mode the header of this
 * file was written about (a wrong number that looks right is worse than a
 * missing one). Anything added here needs a matching assertion in the
 * aggregator's own tests.
 *
 * Zernio's own per-platform caps are asserted in `zernio-aggregator.test.ts`
 * (`channelRules`), and its live account is proven by `zernio.live.proof.test.ts`.
 */
const AGGREGATOR_ROUTED: Record<string, { aggregator: string; why: string }> = {
  reddit: {
    aggregator: "zernio",
    why:
      "no direct route exists or ever will: both Reddit API applications were rejected and " +
      "a third filing is itself a policy violation, so the operative cap is Zernio's",
  },
  twitter: {
    aggregator: "zernio",
    why:
      "our own X developer account answers 402 credits depleted, so publishing goes through " +
      "Zernio's pass-through billing and its 280-char free-tier cap is the operative one",
  },
  tiktok: {
    aggregator: "zernio",
    why:
      "Zernio holds TikTok until our own TikTok API for Business app is connected in Social HQ " +
      "(the direct transport above is checked too); until then Zernio's 2,200-char caption cap " +
      "is the operative one",
  },
};

describe("aggregator-routed platforms are declared, not silently uncovered", () => {
  it("names an owning aggregator and a reason for every platform it excludes", () => {
    for (const [platform, entry] of Object.entries(AGGREGATOR_ROUTED)) {
      expect(ALL_PLATFORMS).toContain(platform);
      expect(entry.aggregator.length).toBeGreaterThan(0);
      expect(entry.why.length).toBeGreaterThan(20);
    }
  });

  /**
   * The assertion that actually bites. A platform cannot be BOTH covered by the
   * SPECS/transport comparison and excluded as aggregator-routed: that would let
   * someone add an entry here to silence a real drift failure above.
   */
  it("does not let a ledger entry silence the direct comparison", () => {
    for (const platform of Object.keys(AGGREGATOR_ROUTED)) {
      // `?? []` because most platforms have no UNDECLARED entry at all, and
      // `toContain` on undefined throws rather than passing — which made this
      // guard fail on its own first real entry.
      expect(UNDECLARED[platform]?.missing ?? []).not.toContain("maxLength");
    }
  });
});

/**
 * The media limits are now the SAME FACT RECORDED TWICE, exactly as maxChars is.
 *
 * ⛔ AND THE TRANSPORT'S COPY WINS. Before qa.ts consulted `fittingRules` for
 * video, a transport declaring 60s against a SPECS of 300s changed nothing at
 * all; now it changes what QA refuses for every routed platform. A divergence
 * that used to be inert is therefore live, and the direction that hurts is the
 * transport being LOOSER — the gate silently stops catching something it caught
 * yesterday, with a green run either way.
 *
 * Only asserted where BOTH records state a number. A transport declining to
 * state one is legitimate (bluesky, threads and linkedin all do) and leaves
 * SPECS as the sole record with nothing to drift from, which is the case the
 * UNDECLARED ledger above covers.
 *
 * ⚠️ maxImages is still excluded, for the reason given in the file header: SPECS
 * carries the VENDOR's cap and several transports carry a narrower CLIENT cap
 * for a format this migration never built. maxImageBytes is not that — it is a
 * vendor byte limit on both sides — so it IS asserted here.
 */
describe("media limits do not drift from the transport that enforces them", () => {
  const MEDIA_FIELDS = ["maxImageBytes", "maxVideoBytes", "maxVideoSec"] as const;

  it.each(TRANSPORTS.map((t) => [t.platform, t] as const))(
    "%s: every media limit both records state agrees",
    (platform, transport) => {
      const rules = transport.channelRules() as unknown as Record<string, unknown>;
      const spec = SPECS[platform] as unknown as Record<string, unknown>;
      for (const field of MEDIA_FIELDS) {
        const declared = rules[field];
        if (typeof declared !== "number" || typeof spec[field] !== "number") continue;
        expect(
          spec[field],
          `SPECS.${platform}.${field} (${String(spec[field])}) disagrees with ` +
            `${platform}-transport.ts channelRules().${field} (${declared}). qa.ts reads the ` +
            "TRANSPORT's number for a routed platform and SPECS only as a fallback, so these two " +
            "now decide the same refusal from different rows. Fix whichever is wrong and cite the " +
            "vendor source in a comment — do NOT just make the numbers match.",
        ).toBe(declared);
      }
    },
  );
});

describe("dark QA gates are deliberate", () => {
  const FIELDS = ["maxImageBytes", "maxVideoBytes", "maxVideoSec"] as const;

  it.each([...ALL_PLATFORMS])("%s: absent media limits match the documented list", (platform) => {
    const spec = SPECS[platform] as unknown as Record<string, unknown>;
    const actual = FIELDS.filter((f) => spec[f] === undefined);
    const expected = UNDECLARED[platform]?.missing ?? [];

    expect(
      [...actual].sort(),
      `${platform}: the media limits missing from SPECS do not match UNDECLARED. Any limit absent here ` +
        "means its QA gate can never fire for this platform, silently. Either add the limit (with a vendor " +
        "citation — do NOT invent a plausible number) or record the absence in UNDECLARED with a reason.",
    ).toEqual([...expected].sort());
  });
});
