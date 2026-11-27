// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { assertPublishable, PublishPreflightError } from "../publish.js";
import { normalizeSubreddit } from "../specs.js";
import type { Draft, MediaAsset, PlatformRender } from "../types.js";

function render(overrides: Partial<PlatformRender> = {}): PlatformRender {
  return { platform: "reddit", content: "body copy", mediaIndices: [], ...overrides };
}

function draft(overrides: Partial<Draft> = {}): Draft {
  return {
    id: "d1",
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
    status: "draft",
    source: { text: "body copy", hashtags: [], media: [] },
    targets: ["reddit"],
    renders: [],
    ...overrides,
  };
}

function image(path: string): MediaAsset {
  return { path, type: "image", mimeType: "image/png", size: 1000, url: `https://cdn/${path}` };
}

const ORIGINAL_DEFAULT = process.env.SOCIALMETA_DEFAULT_SUBREDDIT;

afterEach(() => {
  if (ORIGINAL_DEFAULT === undefined) delete process.env.SOCIALMETA_DEFAULT_SUBREDDIT;
  else process.env.SOCIALMETA_DEFAULT_SUBREDDIT = ORIGINAL_DEFAULT;
});
beforeEach(() => {
  delete process.env.SOCIALMETA_DEFAULT_SUBREDDIT;
});

describe("normalizeSubreddit", () => {
  it("accepts every form an operator might type", () => {
    expect(normalizeSubreddit("/r/SaaS")).toBe("saas");
    expect(normalizeSubreddit("r/SaaS")).toBe("saas");
    expect(normalizeSubreddit("SaaS")).toBe("saas");
    expect(normalizeSubreddit("  r/IndieHackers  ")).toBe("indiehackers");
  });

  it("returns undefined for nothing usable", () => {
    expect(normalizeSubreddit(undefined)).toBeUndefined();
    expect(normalizeSubreddit(null)).toBeUndefined();
    expect(normalizeSubreddit("   ")).toBeUndefined();
    expect(normalizeSubreddit("r/")).toBeUndefined();
  });
});

/**
 * ⚠️ `platformSettings` BECAME `assertPublishable`, and this suite shrank with
 * it. The old function built the aggregator's per-platform `settings` object
 * AND raised the preflight refusals as a side effect of building it, so most of
 * these tests asserted the SHAPE of that object: `type: "self"` vs `"media"`,
 * the `subreddit[0].value` nesting, `is_flair_required`, the title fallback
 * chain. None of that payload is sent to anything any more — a direct transport
 * takes a `PublishDestination` — so asserting it would be pinning a value
 * nobody reads.
 *
 * The refusals are what was always load-bearing, and they are all that is left:
 * a Reddit publish that would be rejected must fail HERE, before anything is
 * sent, with a message naming what to fix.
 */
describe("assertPublishable — reddit", () => {
  it("refuses when no subreddit is configured anywhere", () => {
    expect(() => assertPublishable(render(), draft())).toThrow(PublishPreflightError);
    expect(() => assertPublishable(render(), draft())).toThrow(/needs a target subreddit/);
  });

  it("accepts a subreddit on the render", () => {
    expect(() => assertPublishable(render({ subreddit: "saas" }), draft())).not.toThrow();
  });

  it("accepts the configured default when the render carries none", () => {
    process.env.SOCIALMETA_DEFAULT_SUBREDDIT = "indiehackers";
    expect(() => assertPublishable(render(), draft())).not.toThrow();
  });

  it("normalizes what an operator typed, so /r/SaaS is not a missing subreddit", () => {
    expect(() => assertPublishable(render({ subreddit: "r/SaaS" }), draft())).not.toThrow();
  });

  it("refuses a link-only subreddit rather than sending a post it will reject", () => {
    // r/x answering allow:["link"] rejects both a text post and an image post.
    // Discovered the hard way: a publish to such a subreddit comes back as a
    // bare ERROR with no message anywhere.
    expect(() =>
      assertPublishable(render({ subreddit: "linksonly" }), draft(), {
        subreddit: "linksonly",
        allow: ["link"],
        isFlairRequired: false,
        flairs: [],
      }),
    ).toThrow(/accepts only link/);
  });

  it("refuses when the subreddit mandates a flair, and names the choices", () => {
    expect(() =>
      assertPublishable(render({ subreddit: "saas" }), draft(), {
        subreddit: "saas",
        allow: ["self", "media"],
        isFlairRequired: true,
        flairs: [{ id: "f1", name: "Discussion" }],
      }),
      // `[\s\S]` rather than `.` with the `s` flag: dotAll needs an es2018
      // target and tsconfig targets ES2017. Identical match semantics.
    ).toThrow(/requires a post flair[\s\S]*Discussion/);
  });

  it("accepts once a flair is set", () => {
    expect(() =>
      assertPublishable(render({ subreddit: "saas", flair: { id: "f1", name: "Discussion" } }), draft(), {
        subreddit: "saas",
        allow: ["self", "media"],
        isFlairRequired: true,
        flairs: [{ id: "f1", name: "Discussion" }],
      }),
    ).not.toThrow();
  });

  it("keeps the old behaviour when restrictions could not be read", () => {
    // A failed lookup must never become a new way for publishing to fail: the
    // check is an enhancement, not a gate of its own.
    expect(() => assertPublishable(render({ subreddit: "saas" }), draft(), null)).not.toThrow();
  });

  it("still accepts a one-image post where the subreddit allows media", () => {
    const d = draft({ source: { text: "body", hashtags: [], media: [image("a.png")] } });
    expect(() =>
      assertPublishable(render({ subreddit: "saas", mediaIndices: [0] }), d, {
        subreddit: "saas",
        allow: ["self", "media"],
        isFlairRequired: false,
        flairs: [],
      }),
    ).not.toThrow();
  });
});
