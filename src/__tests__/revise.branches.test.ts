// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The repair pass on inputs it did not expect.
 *
 * `revise.test.ts` covers the happy shape: an issue fires, the render is
 * repaired. This file covers the other half of `applyMechanicalFixes`'s
 * contract, which is the half that decides whether the /fix loop is safe to run
 * repeatedly.
 *
 * ⛔ THE FIX LOOP RUNS `applyMechanicalFixes` WITH A CALLER-SUPPLIED ISSUE LIST,
 * ROUND AFTER ROUND. `outstandingIssues` recomputes deterministic findings, but
 * a caller is free to pass a previous round's list, and every round that reports
 * `changed` rewrites the render's rationale (the "Why this version" text the
 * operator reads verbatim) and can re-run QA. So an issue whose CONDITION no
 * longer holds must be a genuine no-op: not "harmlessly re-applied", but zero
 * edits, zero log lines, zero rationale churn. Each guard below is one of those,
 * and a reader who "simplifies" one away turns a converging loop into one that
 * reports progress forever.
 *
 * The other group here is the model-response boundary in `reviseRenders`. A bad
 * roll must degrade to "no change", never to a half-applied render: an empty
 * first comment publishes a blank comment, and a non-string body publishes
 * nothing at all.
 */

vi.mock("../claude.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../claude.js")>()),
  genJson: vi.fn(),
}));

import { genJson } from "../claude.js";
import { applyMechanicalFixes, reviseRenders } from "../revise.js";
import type { Draft, MediaAsset, Platform, PlatformRender, QAIssue } from "../types.js";

const MB = 1024 * 1024;
const genJsonMock = genJson as unknown as ReturnType<typeof vi.fn>;

function draftWith(
  renders: PlatformRender[],
  media: MediaAsset[] = [],
  // ⚠️ `null`, not `undefined`, for "no link": passing undefined to an
  // optional parameter selects the DEFAULT, which is the opposite of what a
  // caller writing `undefined` means here.
  link: string | null = "https://acmebrands.com",
): Draft {
  return {
    id: "d1",
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
    status: "draft",
    source: { text: "source text", hashtags: [], media, ...(link ? { link } : {}) },
    targets: renders.map((r) => r.platform),
    renders,
  };
}

function render(overrides: Partial<PlatformRender> & { platform: Platform }): PlatformRender {
  return { content: "", mediaIndices: [], ...overrides };
}

function image(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return { path: "/tmp/photo.jpg", type: "image", mimeType: "image/jpeg", size: 1000, ...overrides };
}

function video(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return { path: "/tmp/clip.mp4", type: "video", mimeType: "video/mp4", size: 1000, ...overrides };
}

/** A mechanical issue with an exact code, rather than whatever the checks find. */
function issue(code: string, platform?: Platform): QAIssue {
  return { severity: "warn", code, message: `${code} on ${platform ?? "all"}`, platform };
}

beforeEach(() => {
  vi.clearAllMocks();
});

/* -------------------------------------------------------------------------- */
/* Findings whose condition no longer holds                                   */
/* -------------------------------------------------------------------------- */

describe("a mechanical finding that no longer describes the render", () => {
  it("leaves the copy alone when a dead-link finding names a body with no link", () => {
    // A previous round already moved it. Re-running must not append a second
    // "Link in bio." to copy that has one, nor claim an edit it did not make.
    const draft = draftWith([
      render({ platform: "instagram", content: "Book while you sleep. Link in bio." }),
    ]);
    const before = draft.renders[0]!.content;

    const out = applyMechanicalFixes(draft, [issue("dead-link", "instagram")]);

    expect(draft.renders[0]!.content).toBe(before);
    expect(out).toEqual({ changed: [], applied: [] });
    // ⚠️ The rationale is the tell. Any reported change rewrites it, so a
    // no-op that still reports would make the operator's "Why this version"
    // text grow a sentence per fix round.
    expect(draft.renders[0]!.rationale).toBeUndefined();
  });

  it("reports nothing when a reddit-hashtags finding lands on copy that has none", () => {
    const draft = draftWith([
      render({ platform: "reddit", content: "Built this for my own clinic.", subreddit: "SaaS" }),
    ]);

    const out = applyMechanicalFixes(draft, [issue("reddit-hashtags", "reddit")]);

    expect(draft.renders[0]!.content).toBe("Built this for my own clinic.");
    expect(out).toEqual({ changed: [], applied: [] });
  });

  it("leaves a render alone when a hashtag-cap finding is already satisfied", () => {
    const draft = draftWith(
      [render({ platform: "instagram", content: "Caption #a #b", mediaIndices: [0] })],
      [image()],
    );

    const out = applyMechanicalFixes(draft, [issue("hashtag-cap", "instagram")]);

    expect(draft.renders[0]!.content).toBe("Caption #a #b");
    expect(out).toEqual({ changed: [], applied: [] });
  });

  it("leaves a homogeneous selection alone when a mixed-media finding no longer applies", () => {
    const draft = draftWith(
      [render({ platform: "facebook", content: "Two photos", mediaIndices: [0, 1] })],
      [image(), image({ path: "/tmp/photo2.jpg" })],
    );

    const out = applyMechanicalFixes(draft, [issue("mixed-media", "facebook")]);

    expect(draft.renders[0]!.mediaIndices).toEqual([0, 1]);
    expect(out).toEqual({ changed: [], applied: [] });
  });

  it("leaves the attachments alone when a too-many-images finding is already satisfied", () => {
    const draft = draftWith(
      [render({ platform: "twitter", content: "Two", mediaIndices: [0, 1] })],
      [image(), image({ path: "/tmp/photo2.jpg" })],
    );

    const out = applyMechanicalFixes(draft, [issue("too-many-images", "twitter")]);

    expect(draft.renders[0]!.mediaIndices).toEqual([0, 1]);
    expect(out).toEqual({ changed: [], applied: [] });
  });

  it("leaves the attachments alone when a size finding no longer applies", () => {
    const draft = draftWith(
      [render({ platform: "twitter", content: "Small", mediaIndices: [0] })],
      [image({ size: 1000 })],
    );

    const out = applyMechanicalFixes(draft, [issue("image-too-large", "twitter")]);

    expect(draft.renders[0]!.mediaIndices).toEqual([0]);
    expect(out).toEqual({ changed: [], applied: [] });
  });

  it("does NOT shrink the operator's own attachments on a duplicate-media-attach finding", () => {
    // ⛔ THE RULE IS ONLY DETERMINISTIC ON A GENERATED CARD SET, where the crops
    // are the same image and picking one is an aspect-ratio match with no
    // judgment in it. On two photos an operator chose, "keep the best-fitting
    // one" is a judgment, and silently discarding one of them is the kind of
    // edit nobody would find until after the post was live. normalizeCardMedia-
    // Indices returns nothing here, and nothing is what must happen.
    const draft = draftWith(
      [render({ platform: "instagram", content: "Before and after", mediaIndices: [0, 1] })],
      [image({ path: "/tmp/before.jpg" }), image({ path: "/tmp/after.jpg" })],
    );

    const out = applyMechanicalFixes(draft, [issue("duplicate-media-attach", "instagram")]);

    expect(draft.renders[0]!.mediaIndices).toEqual([0, 1]);
    expect(out).toEqual({ changed: [], applied: [] });
  });
});

/* -------------------------------------------------------------------------- */
/* Hashtag trimming across the caption and the first comment                  */
/* -------------------------------------------------------------------------- */

describe("trimming hashtags across a caption and its first comment", () => {
  it("removes a first comment that was nothing but hashtags rather than leaving it empty", () => {
    // The cap counts caption plus first comment together, so the comment (lower
    // value) is trimmed first. With the caption already at the limit the comment
    // keeps nothing, and what is left of it is an empty string.
    const draft = draftWith(
      [
        render({
          platform: "instagram",
          content: "Never miss a call. #calls #ai #voice #smallbiz #clinic",
          firstComment: "#more #tags",
          mediaIndices: [0],
        }),
      ],
      [image()],
    );

    const out = applyMechanicalFixes(draft, [issue("hashtag-cap", "instagram")]);

    // ⛔ undefined, NOT "". An empty-string first comment is still a first
    // comment: the publish path posts it, so the operator gets a blank reply
    // under their own post.
    expect(draft.renders[0]!.firstComment).toBeUndefined();
    expect(draft.renders[0]!.content).toBe("Never miss a call. #calls #ai #voice #smallbiz #clinic");
    expect(out.applied.join(" ")).toContain("cut 2 hashtags down to the platform's limit of 5");
  });

  it("trims a platform with no hard cap to the TOP of its ideal range, not the bottom", () => {
    // ⛔ Facebook has no `maxHashtags`, so the cap comes from
    // `idealHashtags[1]`. Reading `[0]` instead would be a defensible-looking
    // one-character change that strips EVERY hashtag from Facebook, Bluesky and
    // X, all of which sit at an ideal of [0, 2].
    const draft = draftWith([
      render({ platform: "facebook", content: "District answers every call. #ai #voice #smallbiz #clinic" }),
    ]);

    const out = applyMechanicalFixes(draft, [issue("hashtag-heavy", "facebook")]);

    expect(draft.renders[0]!.content.match(/#\w+/g)).toHaveLength(2);
    expect(out.applied.join(" ")).toContain("down to the platform's limit of 2");
  });

  it("says hashtag, not hashtags, when exactly one is cut", () => {
    const draft = draftWith(
      [
        render({
          platform: "instagram",
          content: "Caption #a #b #c #d #e #f",
          mediaIndices: [0],
        }),
      ],
      [image()],
    );

    const out = applyMechanicalFixes(draft, [issue("hashtag-cap", "instagram")]);

    // The log lines are shown to the operator verbatim in the fix panel.
    expect(out.applied.join(" ")).toContain("cut 1 hashtag down to");
    expect(out.applied.join(" ")).not.toContain("cut 1 hashtags");
  });
});

describe("stripping hashtags from a Reddit post with no title of its own", () => {
  it("cleans the body and leaves the absent title absent", () => {
    const draft = draftWith([
      render({ platform: "reddit", content: "Built this. #saas #ai", subreddit: "SaaS" }),
    ]);

    const out = applyMechanicalFixes(draft, [issue("reddit-hashtags", "reddit")]);

    expect(draft.renders[0]!.content).toBe("Built this.");
    // ⚠️ Not `title: ""`. A Reddit submission with an empty title is rejected
    // outright, and publishDestination's fallback to the source title only
    // fires while the render's own title is absent.
    expect(draft.renders[0]!.title).toBeUndefined();
    expect(out.applied.join(" ")).toContain("removed 2 hashtags");
  });
});

/* -------------------------------------------------------------------------- */
/* Media rules where the first attachment is a video                          */
/* -------------------------------------------------------------------------- */

describe("a mixed selection whose FIRST attachment is a video", () => {
  it("keeps the videos and drops the stills", () => {
    // The mirror of the covered image-first case, and the one that actually
    // matters: dropping the video would turn a video post into a photo post,
    // which is a different piece of content rather than a trimmed one.
    const draft = draftWith(
      [render({ platform: "facebook", content: "Clip", mediaIndices: [0, 1, 2] })],
      [video(), image(), video({ path: "/tmp/clip2.mp4" })],
    );

    const out = applyMechanicalFixes(draft, [issue("mixed-media", "facebook")]);

    expect(draft.renders[0]!.mediaIndices).toEqual([0, 2]);
    expect(out.changed).toEqual(["facebook"]);
  });
});

describe("dropping attachments over a platform's file-size limit", () => {
  it("drops a video over the video limit and says so in the plural", () => {
    // ⚠️ The image limit and the video limit are separate numbers on the spec,
    // and a video is measured against maxVideoBytes: X allows 5MB of image and
    // 8GB of post video (since 2026-09-17; 512MB was the DM figure), so reading
    // a video against the image limit would drop every clip we publish.
    const draft = draftWith(
      [render({ platform: "twitter", content: "Clips", mediaIndices: [0, 1] })],
      [video({ size: 9 * 1024 * MB }), video({ path: "/tmp/clip2.mp4", size: 9 * 1024 * MB })],
    );

    const out = applyMechanicalFixes(draft, [issue("video-too-large", "twitter")]);

    expect(draft.renders[0]!.mediaIndices).toEqual([]);
    expect(out.applied.join(" ")).toContain("removed 2 attachments over X / Twitter's file-size limit");
  });

  it("measures a gif against the image limit, not the video one", () => {
    // A gif is `type: "gif"`, which is neither of the two obvious cases. It is
    // an IMAGE for sizing purposes; treating it as neither would leave a 9MB gif
    // on a platform that caps images at 5MB, and X rejects the upload.
    const draft = draftWith(
      [render({ platform: "twitter", content: "Loop", mediaIndices: [0] })],
      [image({ path: "/tmp/loop.gif", type: "gif", mimeType: "image/gif", size: 9 * MB })],
    );

    applyMechanicalFixes(draft, [issue("image-too-large", "twitter")]);

    expect(draft.renders[0]!.mediaIndices).toEqual([]);
  });

  it("drops an index that points at an asset the draft no longer has", () => {
    // Indices are positions into `draft.source.media`, so removing an asset
    // leaves whatever pointed past it dangling. A dangling index reaching the
    // publish path selects nothing and publishes a text-only post where the
    // operator attached a photo.
    const draft = draftWith(
      [render({ platform: "twitter", content: "One real, one gone", mediaIndices: [0, 7] })],
      [image({ size: 1000 })],
    );

    applyMechanicalFixes(draft, [issue("image-too-large", "twitter")]);

    expect(draft.renders[0]!.mediaIndices).toEqual([0]);
  });
});

/* -------------------------------------------------------------------------- */
/* A platform with no spec                                                    */
/* -------------------------------------------------------------------------- */

describe("a render for a platform that has no spec", () => {
  it("skips it and still fixes every render that does have one", () => {
    // ⛔ THE COST OF GETTING THIS WRONG IS THE WHOLE FIX PASS, NOT ONE RENDER.
    // Every fix below the lookup reads `spec.<something>`, so an unknown
    // platform throws out of the loop and the renders after it are never
    // reached. The guard is what keeps a half-built platform (in `Platform`,
    // not yet in SPECS) from making /fix a 500 for every draft that targets it.
    const draft = draftWith([
      // ⚠️ `as unknown as` is required: "mastodon" and Platform are disjoint
      // literal unions, so a direct `as Platform` is a compile error.
      render({ platform: "mastodon" as unknown as Platform, content: "Call us — now." }),
      render({ platform: "twitter", content: "Call us — now." }),
    ]);

    const out = applyMechanicalFixes(draft, [issue("brand-em-dash")]);

    expect(out.changed).toEqual(["twitter"]);
    expect(draft.renders[1]!.content).toBe("Call us, now.");
    // Untouched, em-dash and all: there is no spec to say what its rules are.
    expect(draft.renders[0]!.content).toBe("Call us — now.");
  });
});

/* -------------------------------------------------------------------------- */
/* The prompt reviseRenders builds                                            */
/* -------------------------------------------------------------------------- */

describe("the revision prompt", () => {
  it("puts a finding with no platform on every render that exists", async () => {
    // Only the em-dash rule produces one today, but a model finding about the
    // draft as a whole has no platform either. Dropping it would leave a
    // blocking issue silently unrevised on every platform at once.
    genJsonMock.mockResolvedValue({
      renders: [
        { platform: "twitter", content: "Fixed X." },
        { platform: "bluesky", content: "Fixed Bluesky." },
      ],
    });
    const draft = draftWith([
      render({ platform: "twitter", content: "Broken X." }),
      render({ platform: "bluesky", content: "Broken Bluesky." }),
    ]);

    const revised = await reviseRenders(draft, [
      { severity: "fail", code: "llm-factual-drift", message: "the claim is not true", fix: "soften it" },
    ]);

    expect([...revised.keys()].sort()).toEqual(["bluesky", "twitter"]);
    const prompt = genJsonMock.mock.calls[0]![0] as string;
    expect(prompt).toContain("Broken X.");
    expect(prompt).toContain("Broken Bluesky.");
  });

  it("lists the blocking issue before the merely important one", async () => {
    // ⛔ ORDER IS THE INSTRUCTION. The model reads the list top-down and spends
    // its edit on what it meets first, so an unordered list let a stylistic
    // nitpick outrank a hard character overrun and the blocker survived the
    // revision.
    genJsonMock.mockResolvedValue({ renders: [{ platform: "twitter", content: "Fixed." }] });
    const draft = draftWith([render({ platform: "twitter", content: "Way too long." })]);

    await reviseRenders(draft, [
      { severity: "warn", platform: "twitter", code: "llm-weak-hook", message: "flat hook", fix: "lead with the outcome" },
      { severity: "fail", platform: "twitter", code: "over-limit", message: "280 exceeded", fix: "trim it" },
    ]);

    const prompt = genJsonMock.mock.calls[0]![0] as string;
    // Read only the versions block: the rules further down name both words too.
    const versions = prompt.slice(
      prompt.indexOf("## Versions to revise"),
      prompt.indexOf("## Output"),
    );
    expect(versions.indexOf("BLOCKING")).toBeGreaterThan(-1);
    expect(versions.indexOf("BLOCKING")).toBeLessThan(versions.indexOf("IMPORTANT"));
  });

  it("says there is no link to promote rather than sending the word undefined", async () => {
    // A draft with no link is ordinary. "Link to promote: undefined" is an
    // instruction to a model that reads it literally, and there is no url for it
    // to put anywhere.
    genJsonMock.mockResolvedValue({ renders: [{ platform: "twitter", content: "Fixed." }] });
    const draft = draftWith([render({ platform: "twitter", content: "Broken." })], [], null);

    await reviseRenders(draft, [issue("llm-tone", "twitter")]);

    const prompt = genJsonMock.mock.calls[0]![0] as string;
    expect(prompt).toContain("Link to promote: (none)");
    expect(prompt).not.toContain("Link to promote: undefined");
  });

  it("asks for structured output, holding platform to the platforms being revised", async () => {
    // The schema is the shape guarantee now (claude.ts): the old validate
    // callback and its retry had nothing left to catch.
    genJsonMock.mockResolvedValue({ renders: [{ platform: "twitter", content: "Fixed." }] });
    const draft = draftWith([
      render({ platform: "twitter", content: "Broken." }),
      render({ platform: "bluesky", content: "Fine." }),
    ]);

    await reviseRenders(draft, [issue("llm-tone", "twitter")]);

    const opts = genJsonMock.mock.calls[0]![1] as { schema: Record<string, unknown> };
    expect(opts).toEqual({ schema: expect.any(Object) });
    const item = (opts.schema as {
      properties: { renders: { items: { properties: { platform: { enum: string[] } }; required: string[] } } };
    }).properties.renders.items;
    expect(item.properties.platform.enum).toEqual(["twitter"]);
    expect(item.required).toEqual(["platform", "content"]);
  });
});

/* -------------------------------------------------------------------------- */
/* What comes back from the model                                             */
/* -------------------------------------------------------------------------- */

describe("what the model sends back", () => {
  it("replaces the first comment on a string and CLEARS it on an empty one", async () => {
    // Facebook, which publishes its first comment: on a platform whose
    // transport drops the field, a new one is refused (revise.test.ts).
    genJsonMock.mockResolvedValueOnce({
      renders: [{ platform: "facebook", content: "new body", firstComment: "  fresh comment  " }],
    });
    const withComment = draftWith([
      render({ platform: "facebook", content: "old body", firstComment: "old comment" }),
    ]);

    const replaced = await reviseRenders(withComment, [issue("llm-tone", "facebook")]);
    expect(replaced.get("facebook")!.firstComment).toBe("fresh comment");

    genJsonMock.mockResolvedValueOnce({
      renders: [{ platform: "facebook", content: "new body", firstComment: "   " }],
    });
    const cleared = await reviseRenders(
      draftWith([render({ platform: "facebook", content: "old body", firstComment: "old comment" })]),
      [issue("llm-tone", "facebook")],
    );

    // ⛔ undefined, NOT "". Omitting the key means "leave it"; an empty string
    // means "clear it". Storing "" instead would publish a blank first comment
    // under the post, which is exactly what the model asked us to remove.
    expect(cleared.get("facebook")!.firstComment).toBeUndefined();
  });
});
