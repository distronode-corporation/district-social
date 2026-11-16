/**
 * Deterministic routing for generated card sets.
 *
 * The bug these pin: the formatter model controlled mediaIndices with an
 * "omit to attach all" default, so posts shipped three near-identical crops of
 * one card on a single render (seen live on X, Threads and Bluesky).
 * Routing a card set is code's decision now, and these tests are what keep it
 * from quietly becoming a model opinion again.
 */
import { describe, it, expect } from "vitest";
import {
  isGeneratedCardSet,
  normalizeCardMediaIndices,
  pickMediaForPlatform,
  routeModelMediaIndices,
  unpublishableVideoIndices,
} from "../media-pick.js";
import { SPECS } from "../specs.js";
import type { MediaAsset, Platform } from "../types.js";

function card(path: string, width: number, height: number): MediaAsset {
  return { path, type: "image", mimeType: "image/png", size: 1000, width, height };
}

/** The exact set the cadence pipeline generates: square, 4:5, 2:3. */
const CARD_SET: MediaAsset[] = [
  card("ai-card-aaaaaaaaaaaa.png", 1080, 1080),
  card("ai-card-bbbbbbbbbbbb.png", 1080, 1350),
  card("ai-card-cccccccccccc.png", 1080, 1620),
];

describe("isGeneratedCardSet", () => {
  it("recognises a multi-crop generated set", () => {
    expect(isGeneratedCardSet(CARD_SET)).toBe(true);
  });

  it("is false for a single card (nothing to route)", () => {
    expect(isGeneratedCardSet(CARD_SET.slice(0, 1))).toBe(false);
  });

  it("is false the moment any operator asset is in the mix", () => {
    expect(isGeneratedCardSet([...CARD_SET, card("photo.jpg", 800, 600)])).toBe(false);
  });

  it("is false for an empty list and for videos", () => {
    expect(isGeneratedCardSet([])).toBe(false);
    const vid: MediaAsset = {
      path: "ai-card-video.mp4",
      type: "video",
      mimeType: "video/mp4",
      size: 5000,
    };
    expect(isGeneratedCardSet([vid, CARD_SET[0]!])).toBe(false);
  });
});

describe("pickMediaForPlatform", () => {
  it("routes each platform to its preferred crop", () => {
    expect(pickMediaForPlatform("instagram", CARD_SET)).toEqual([1]); // 4:5
    expect(pickMediaForPlatform("pinterest", CARD_SET)).toEqual([2]); // 2:3
    expect(pickMediaForPlatform("twitter", CARD_SET)).toEqual([0]); // square
    expect(pickMediaForPlatform("bluesky", CARD_SET)).toEqual([0]);
  });

  it("always returns exactly one index for a non-empty set", () => {
    const platforms: Platform[] = ["instagram", "facebook", "threads", "twitter", "linkedin", "bluesky", "pinterest"];
    for (const p of platforms) {
      expect(pickMediaForPlatform(p, CARD_SET)).toHaveLength(1);
    }
  });

  it("treats missing dimensions as square instead of skipping the asset", () => {
    const noDims: MediaAsset[] = [
      { path: "ai-card-x.png", type: "image", mimeType: "image/png", size: 1 },
      card("ai-card-y.png", 1080, 1350),
    ];
    expect(pickMediaForPlatform("twitter", noDims)).toEqual([0]);
    expect(pickMediaForPlatform("instagram", noDims)).toEqual([1]);
  });

  it("returns [] for no media", () => {
    expect(pickMediaForPlatform("twitter", [])).toEqual([]);
  });

  // A video draft's shape: one generated clip for YouTube plus the cards every
  // other platform gets. Ratio alone cannot separate them (the portrait card
  // and the portrait video tie at delta 0), so kind has to be decided first or
  // YouTube selects a PNG it structurally cannot upload.
  describe("kind before shape", () => {
    const CLIP: MediaAsset = {
      path: "ai-video-dddddddddddd.mp4",
      type: "video",
      mimeType: "video/mp4",
      size: 4_000_000,
      width: 1080,
      height: 1920,
      durationSec: 8,
    };
    const MIXED: MediaAsset[] = [...CARD_SET, CLIP];

    it("gives a requiresVideo platform the video, not the closest-ratio card", () => {
      expect(pickMediaForPlatform("youtube", MIXED)).toEqual([3]);
    });

    it("keeps every platform that cannot publish video on a still when both kinds are present", () => {
      expect(pickMediaForPlatform("pinterest", MIXED)).toEqual([2]);
      expect(pickMediaForPlatform("bluesky", MIXED)).toEqual([0]);
    });

    // X does not REQUIRE video, but its transport publishes it, so a draft's
    // video goes there too: SPECS.publishesVideo is the routing switch.
    it("routes the video to a platform that publishes video without requiring it", () => {
      expect(SPECS.twitter.requiresVideo).toBe(false);
      expect(SPECS.twitter.publishesVideo).toBe(true);
      expect(pickMediaForPlatform("twitter", MIXED)).toEqual([3]);
    });

    // Instagram (Reels), Facebook (Page Reels) and Threads (VIDEO) publish
    // video, so a draft with a clip sends them the clip, not a card.
    it("routes the video to the Meta platforms that publish Reels or video", () => {
      for (const p of ["instagram", "facebook", "threads"] as const) {
        expect(SPECS[p].publishesVideo, p).toBe(true);
        expect(pickMediaForPlatform(p, MIXED), p).toEqual([3]);
      }
    });

    // Preference, not a filter: selecting nothing publishes a silent text-only
    // post, while selecting the wrong kind trips QA's own video-required /
    // video-unsupported checks and says so out loud. The loud failure is the
    // better one.
    it("falls back to the full list rather than selecting nothing", () => {
      expect(pickMediaForPlatform("youtube", CARD_SET)).toEqual([0]);
      expect(pickMediaForPlatform("twitter", CARD_SET)).toEqual([0]);
      expect(pickMediaForPlatform("bluesky", [CLIP])).toEqual([0]);
    });

    describe("unpublishableVideoIndices", () => {
      it("names the video indices a platform that cannot publish video selects", () => {
        expect(unpublishableVideoIndices("bluesky", MIXED, [0, 3])).toEqual([3]);
        expect(unpublishableVideoIndices("pinterest", MIXED, [3])).toEqual([3]);
      });

      it("is empty for a platform that publishes video, a still-only selection, or an out-of-range index", () => {
        expect(unpublishableVideoIndices("twitter", MIXED, [3])).toEqual([]);
        expect(unpublishableVideoIndices("youtube", MIXED, [3])).toEqual([]);
        expect(unpublishableVideoIndices("bluesky", MIXED, [0, 1])).toEqual([]);
        expect(unpublishableVideoIndices("bluesky", MIXED, [9])).toEqual([]);
      });
    });

    describe("routeModelMediaIndices", () => {
      it("an omitted selection with no video attaches everything, as before", () => {
        expect(routeModelMediaIndices("bluesky", CARD_SET, undefined)).toEqual([0, 1, 2]);
      });

      it("an omitted selection on a draft with a video is the shape pick, never everything", () => {
        expect(routeModelMediaIndices("bluesky", MIXED, undefined)).toEqual([0]);
        expect(routeModelMediaIndices("twitter", MIXED, undefined)).toEqual([3]);
      });

      it("keeps a selection that holds no unpublishable video untouched", () => {
        expect(routeModelMediaIndices("bluesky", MIXED, [1, 2])).toEqual([1, 2]);
        expect(routeModelMediaIndices("twitter", MIXED, [3])).toEqual([3]);
        expect(routeModelMediaIndices("bluesky", MIXED, [])).toEqual([]);
      });

      it("drops the model's video index where the platform cannot publish one", () => {
        expect(routeModelMediaIndices("bluesky", MIXED, [0, 3])).toEqual([0]);
      });

      it("falls back to the shape pick when only the video was selected", () => {
        expect(routeModelMediaIndices("pinterest", MIXED, [3])).toEqual([2]);
      });
    });
  });
});

describe("normalizeCardMediaIndices", () => {
  it("shrinks a multi-card selection to the platform's best crop", () => {
    const renders = [
      { platform: "twitter" as Platform, mediaIndices: [0, 1, 2] },
      { platform: "instagram" as Platform, mediaIndices: [0, 1, 2] },
    ];
    const changed = normalizeCardMediaIndices(CARD_SET, renders);
    expect(changed).toEqual(["twitter", "instagram"]);
    expect(renders[0]!.mediaIndices).toEqual([0]);
    expect(renders[1]!.mediaIndices).toEqual([1]);
  });

  it("leaves single and EMPTY selections alone (an empty one can be the oversized-image drop)", () => {
    const renders = [
      { platform: "bluesky" as Platform, mediaIndices: [] as number[] },
      { platform: "twitter" as Platform, mediaIndices: [2] },
    ];
    expect(normalizeCardMediaIndices(CARD_SET, renders)).toEqual([]);
    expect(renders[0]!.mediaIndices).toEqual([]);
    expect(renders[1]!.mediaIndices).toEqual([2]);
  });

  it("never touches operator media, however many are attached", () => {
    const operator = [card("a.jpg", 800, 600), card("b.jpg", 800, 600), card("c.jpg", 800, 600)];
    const renders = [{ platform: "instagram" as Platform, mediaIndices: [0, 1, 2] }];
    expect(normalizeCardMediaIndices(operator, renders)).toEqual([]);
    expect(renders[0]!.mediaIndices).toEqual([0, 1, 2]);
  });
});
