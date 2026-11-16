import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../claude.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../claude.js")>()),
  genJson: vi.fn(),
}));

import { NO_BRAND, type BrandContext } from "../brand-context.js";
import { genJson, ModelRefusedError } from "../claude.js";
import { invalidateConnectedAccounts } from "../publish.js";
import { registerTransport, resetTransports } from "../transport.js";
import type { DirectTransport, TransportChannelRules } from "../transport.js";
import {
  deterministicChecks,
  detectPlaceholderText,
  mediaFixKind,
  isMechanicallyFixable,
  isTextFixable,
  isTrackedLinkFalsePositive,
  llmReview,
  runQa,
} from "../qa.js";
import type { Draft, MediaAsset, Platform, PlatformRender, QAIssue, QAReport } from "../types.js";

/** A brand context with a name and tracked-link domains, as a pack would bind them. */
const ACME: BrandContext = {
  ...NO_BRAND,
  brandName: () => "Acmebrands",
  linkDomains: () => ["acmebrands.com", "acmebrands.ca"],
};

const genJsonMock = genJson as unknown as ReturnType<typeof vi.fn>;

/**
 * The reddit rules lookup used to go through the aggregator's channel-tool
 * endpoint (`subredditRestrictions`); it now goes through the transport's
 * `destinationRules`, which reads Reddit's own /about and /post_requirements.
 * So the seam to stub is the transport, and `restrictionsMock` returns the raw
 * record that resolveRedditRestrictions normalises rather than the normalised
 * shape itself.
 */
const restrictionsMock = vi.fn();

function redditTransport(): DirectTransport {
  return {
    platform: "reddit",
    channelRules: () => ({ maxLength: 40000, countMode: "utf16" }),
    connectStatus: async () => ({ connected: true, accountId: "rd-1", displayName: "acmebrands" }),
    publishNow: async () => ({ ref: "t3_x" }),
    deletePost: async () => {},
    postFacts: async () => new Map(),
    postUrl: (r: string) => `https://reddit.com/${r}`,
    destinationRules: restrictionsMock,
  };
}

/** allow:[...] in the OLD vocabulary, expressed as the transport's raw record. */
function rules(opts: {
  allowSelf?: boolean;
  allowLink?: boolean;
  isFlairRequired?: boolean;
  flairs?: Array<{ id: string; name: string }>;
}) {
  return {
    subreddit: "saas",
    submissionType: opts.allowSelf === false ? "link" : "any",
    allowSelf: opts.allowSelf !== false,
    allowLink: opts.allowLink !== false,
    isFlairRequired: opts.isFlairRequired === true,
    flairs: opts.flairs ?? [],
  };
}

function draftWith(renders: PlatformRender[], media: MediaAsset[] = []): Draft {
  return {
    id: "d1",
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
    status: "draft",
    source: { text: "source text", hashtags: [], media },
    targets: renders.map((r) => r.platform),
    renders,
  };
}

function render(overrides: Partial<PlatformRender> & { platform: PlatformRender["platform"] }): PlatformRender {
  return { content: "", mediaIndices: [], ...overrides };
}

function image(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return { path: "/tmp/photo.jpg", type: "image", mimeType: "image/jpeg", size: 1000, ...overrides };
}

function video(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return { path: "/tmp/clip.mp4", type: "video", mimeType: "video/mp4", size: 1000, durationSec: 10, ...overrides };
}

describe("qa", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("deterministicChecks", () => {
    it("flags over-limit when content exceeds the hard char limit", () => {
      const draft = draftWith([render({ platform: "twitter", content: "a".repeat(300) })]);
      const issue = deterministicChecks(draft).find((i) => i.code === "over-limit");
      expect(issue).toMatchObject({ severity: "fail", platform: "twitter" });
      expect(issue!.message).toContain("300 chars");
      expect(issue!.fix).toBeTruthy();
    });

    it("fails duplicate-media-attach when several crops of one card set land on a render", () => {
      const cards = [
        image({ path: "ai-card-aaa.png", mimeType: "image/png", width: 1080, height: 1080 }),
        image({ path: "ai-card-bbb.png", mimeType: "image/png", width: 1080, height: 1350 }),
      ];
      const draft = draftWith(
        [render({ platform: "twitter", content: "Body", mediaIndices: [0, 1] })],
        cards,
      );
      const issue = deterministicChecks(draft).find((i) => i.code === "duplicate-media-attach");
      // Within X's 4-image cap, so too-many-images never catches this; without
      // the dedicated rule, three crops of one design read as a broken post.
      expect(issue).toMatchObject({ severity: "fail", platform: "twitter" });
    });

    it("does not flag duplicate-media-attach for a single card or operator media", () => {
      const cards = [
        image({ path: "ai-card-aaa.png", mimeType: "image/png", width: 1080, height: 1080 }),
        image({ path: "ai-card-bbb.png", mimeType: "image/png", width: 1080, height: 1350 }),
      ];
      const single = draftWith(
        [render({ platform: "twitter", content: "Body", mediaIndices: [0] })],
        cards,
      );
      expect(deterministicChecks(single).some((i) => i.code === "duplicate-media-attach")).toBe(false);

      const operator = draftWith(
        [render({ platform: "twitter", content: "Body", mediaIndices: [0, 1] })],
        [image({ path: "a.jpg" }), image({ path: "b.jpg" })],
      );
      expect(deterministicChecks(operator).some((i) => i.code === "duplicate-media-attach")).toBe(false);
    });

    it("flags truncation (info) when content exceeds the feed truncation point but not the hard limit", () => {
      const draft = draftWith([render({ platform: "facebook", content: "b".repeat(130) })]);
      const issue = deterministicChecks(draft).find((i) => i.code === "truncation");
      expect(issue).toMatchObject({ severity: "info", platform: "facebook" });
      expect(issue!.message).toContain("125 chars");
      expect(issue!.fix).toBeTruthy();
    });

    it("flags hashtag-cap (fail) when hashtag count exceeds the platform's hard cap", () => {
      const media = [image({ altText: "alt" })];
      const draft = draftWith(
        [render({ platform: "instagram", content: "Launch day #a #b #c #d #e #f", mediaIndices: [0] })],
        media,
      );
      const issue = deterministicChecks(draft).find((i) => i.code === "hashtag-cap");
      expect(issue).toMatchObject({ severity: "fail", platform: "instagram" });
      expect(issue!.message).toContain("6 hashtags exceeds hard cap 5");
      expect(issue!.fix).toBeTruthy();
    });

    it("flags hashtag-heavy (warn) when hashtag count exceeds the ideal but there's no hard cap", () => {
      const draft = draftWith([
        render({ platform: "linkedin", content: "#one #two #three #four #five #six" }),
      ]);
      const issue = deterministicChecks(draft).find((i) => i.code === "hashtag-heavy");
      expect(issue).toMatchObject({ severity: "warn", platform: "linkedin" });
      expect(issue!.message).toContain("ideal 3-5 on LinkedIn");
      expect(issue!.fix).toBeTruthy();
    });

    it("flags reddit-hashtags (fail) whenever a reddit render contains any hashtag", () => {
      const draft = draftWith([
        render({ platform: "reddit", content: "Cool #stuff here", title: "A title", subreddit: "test" }),
      ]);
      const issue = deterministicChecks(draft).find((i) => i.code === "reddit-hashtags");
      expect(issue).toMatchObject({ severity: "fail", platform: "reddit" });
      expect(issue!.fix).toBeTruthy();
    });

    it("flags title-missing when a title-required platform has no title", () => {
      const draft = draftWith([
        render({ platform: "reddit", content: "Just sharing something", subreddit: "test" }),
      ]);
      const issue = deterministicChecks(draft).find((i) => i.code === "title-missing");
      expect(issue).toMatchObject({ severity: "fail", platform: "reddit" });
      expect(issue!.message).toContain("Reddit requires a title");
      expect(issue!.fix).toBeTruthy();
    });

    it("flags title-over-limit when a title exceeds the platform's title max chars", () => {
      const draft = draftWith([
        render({
          platform: "reddit",
          content: "Just sharing",
          title: "T".repeat(310),
          subreddit: "test",
        }),
      ]);
      const issue = deterministicChecks(draft).find((i) => i.code === "title-over-limit");
      expect(issue).toMatchObject({ severity: "fail", platform: "reddit" });
      expect(issue!.message).toContain("310 chars (max 300)");
      expect(issue!.fix).toBeTruthy();
    });

    it("warns when a YouTube title or description carries < or >, which the upload swaps", () => {
      for (const [title, content] of [["A <b> title", "plain"], [undefined, "5 > 4"]] as const) {
        const draft = draftWith([render({ platform: "youtube", content, title })]);
        const issue = deterministicChecks(draft).find((i) => i.code === "youtube-angle-brackets");
        expect(issue).toMatchObject({ severity: "warn", platform: "youtube" });
        expect(issue!.fix).toBeTruthy();
      }
    });

    it("does not raise the YouTube angle-bracket warning for clean copy or other platforms", () => {
      const draft = draftWith([
        render({ platform: "youtube", content: "clean", title: "Clean" }),
        render({ platform: "linkedin", content: "5 < 10" }),
      ]);
      expect(deterministicChecks(draft).some((i) => i.code === "youtube-angle-brackets")).toBe(false);
    });

    it("flags media-required when a media-required platform has no attached media", () => {
      const draft = draftWith([
        render({ platform: "instagram", content: "New feature drop soon", mediaIndices: [] }),
      ]);
      const issue = deterministicChecks(draft).find((i) => i.code === "media-required");
      expect(issue).toMatchObject({ severity: "fail", platform: "instagram" });
      expect(issue!.message).toContain("Instagram requires media");
      expect(issue!.fix).toBeTruthy();
    });

    it("flags video-required when a video-required platform's selected media has no video", () => {
      const media = [image({ altText: "alt" })];
      const draft = draftWith(
        [render({ platform: "youtube", content: "Watch this", title: "A Title", mediaIndices: [0] })],
        media,
      );
      const issue = deterministicChecks(draft).find((i) => i.code === "video-required");
      expect(issue).toMatchObject({ severity: "fail", platform: "youtube" });
      expect(issue!.fix).toBeTruthy();
    });

    // Bluesky's transport used to keep only the images and post a video render
    // text-only. A hand-written selection of a video where the transport
    // cannot send one must fail QA by name, never reach that silent drop.
    it("fails video-unsupported when a platform that cannot publish video selects one", () => {
      const media = [image({ altText: "alt" }), video({ altText: "alt" })];
      const draft = draftWith(
        [render({ platform: "bluesky", content: "Watch this", mediaIndices: [1] })],
        media,
      );
      const issue = deterministicChecks(draft).find((i) => i.code === "video-unsupported");
      expect(issue).toMatchObject({ severity: "fail", platform: "bluesky" });
      expect(issue!.message).toContain("Bluesky cannot publish video");
      expect(issue!.fix).toContain("Select an image for Bluesky");
      // A media selection, not copy: the AI rewrite cannot resolve it.
      expect(isTextFixable(issue!)).toBe(false);
      expect(isMechanicallyFixable(issue!)).toBe(false);
    });

    it("does not flag video-unsupported where the platform publishes video, or no video is selected", () => {
      const media = [image({ altText: "alt" }), video({ altText: "alt" })];
      const draft = draftWith(
        [
          render({ platform: "twitter", content: "Watch this", mediaIndices: [1] }),
          render({ platform: "bluesky", content: "Look at this", mediaIndices: [0] }),
        ],
        media,
      );
      expect(deterministicChecks(draft).some((i) => i.code === "video-unsupported")).toBe(false);
    });

    it("flags too-many-images when selected image count exceeds the platform max", () => {
      const media = [image(), image(), image(), image(), image()];
      const draft = draftWith(
        [render({ platform: "twitter", content: "Photo dump", mediaIndices: [0, 1, 2, 3, 4] })],
        media,
      );
      const issue = deterministicChecks(draft).find((i) => i.code === "too-many-images");
      expect(issue).toMatchObject({ severity: "fail", platform: "twitter" });
      expect(issue!.message).toContain("5 images (max 4)");
      expect(issue!.fix).toBeTruthy();
    });

    it("flags mixed-media when a platform that disallows it gets both images and video", () => {
      const media = [image(), video()];
      const draft = draftWith(
        [render({ platform: "facebook", content: "Mixed post", mediaIndices: [0, 1] })],
        media,
      );
      const issue = deterministicChecks(draft).find((i) => i.code === "mixed-media");
      expect(issue).toMatchObject({ severity: "fail", platform: "facebook" });
      expect(issue!.fix).toBeTruthy();
    });

    it("flags video-too-long when selected video duration exceeds the platform max", () => {
      // X posts take 20 minutes on a default account (docs.x.com changelog,
      // Sep 2026); 140 s was the DM figure this test used to pin.
      const media = [video({ durationSec: 1500 })];
      const draft = draftWith(
        [render({ platform: "twitter", content: "Video drop", mediaIndices: [0] })],
        media,
      );
      const issue = deterministicChecks(draft).find((i) => i.code === "video-too-long");
      expect(issue).toMatchObject({ severity: "fail", platform: "twitter" });
      expect(issue!.message).toContain("1500s (max 1200s)");
      expect(issue!.fix).toBeTruthy();
    });

    it("flags image-too-large when a selected image exceeds the platform's max image bytes", () => {
      const media = [image({ size: 6 * 1024 * 1024, path: "/tmp/big.jpg" })];
      const draft = draftWith(
        [render({ platform: "twitter", content: "Big image", mediaIndices: [0] })],
        media,
      );
      const issue = deterministicChecks(draft).find((i) => i.code === "image-too-large");
      expect(issue).toMatchObject({ severity: "fail", platform: "twitter" });
      expect(issue!.message).toContain("big.jpg");
      expect(issue!.fix).toBeTruthy();
    });

    it("flags video-too-large when a selected video exceeds the platform's max video bytes", () => {
      // 9 GB: over X's 8 GB post ceiling (was 600 MB against the old 512 MB DM figure).
      const media = [video({ size: 9 * 1024 * 1024 * 1024, durationSec: 10, path: "/tmp/big.mp4" })];
      const draft = draftWith(
        [render({ platform: "twitter", content: "Huge video", mediaIndices: [0] })],
        media,
      );
      const issue = deterministicChecks(draft).find((i) => i.code === "video-too-large");
      expect(issue).toMatchObject({ severity: "fail", platform: "twitter" });
      expect(issue!.message).toContain("big.mp4");
      expect(issue!.fix).toBeTruthy();
    });

    it("flags dead-link (warn) when a platform whose links aren't clickable has a URL in the body", () => {
      const media = [image({ altText: "alt" })];
      const draft = draftWith(
        [
          render({
            platform: "instagram",
            content: "Check it out https://acmebrands.com",
            mediaIndices: [0],
          }),
        ],
        media,
      );
      const issue = deterministicChecks(draft).find((i) => i.code === "dead-link");
      expect(issue).toMatchObject({ severity: "warn", platform: "instagram" });
      expect(issue!.fix).toBeTruthy();
    });

    it("flags link-penalty (warn) when a platform with a link penalty has a URL in the body", () => {
      const draft = draftWith([
        render({ platform: "facebook", content: "More info at https://acmebrands.com" }),
      ]);
      const issue = deterministicChecks(draft).find((i) => i.code === "link-penalty");
      expect(issue).toMatchObject({ severity: "warn", platform: "facebook" });
      expect(issue!.fix).toBeTruthy();
      // facebook links ARE clickable, so dead-link must not also fire
      expect(deterministicChecks(draft).find((i) => i.code === "dead-link")).toBeUndefined();
    });

    it("flags subreddit-missing when a reddit render has a title but no subreddit", () => {
      // ⛔ STATE THE ENVIRONMENT THIS ASSERTION DEPENDS ON. settings.ts reads
      // `SOCIALMETA_DEFAULT_SUBREDDIT` as the fallback subreddit, so with that
      // variable set in the shell the render is NOT missing a subreddit and no
      // issue is produced. The test then fails on `issue!` being undefined,
      // which reads as a broken check rather than as inherited state. Found by a
      // hostile-env run; the two tests further down that need the variable SET
      // manage it the same way.
      const previous = process.env.SOCIALMETA_DEFAULT_SUBREDDIT;
      delete process.env.SOCIALMETA_DEFAULT_SUBREDDIT;
      try {
        const draft = draftWith([
          render({ platform: "reddit", content: "No subreddit set here", title: "Valid title" }),
        ]);
        const issue = deterministicChecks(draft).find((i) => i.code === "subreddit-missing");
        expect(issue).toMatchObject({ severity: "fail", platform: "reddit" });
        expect(issue!.fix).toBeTruthy();
      } finally {
        if (previous === undefined) delete process.env.SOCIALMETA_DEFAULT_SUBREDDIT;
        else process.env.SOCIALMETA_DEFAULT_SUBREDDIT = previous;
      }
    });

    it("flags thread-item-over-limit for the specific over-limit thread item only", () => {
      const draft = draftWith([
        render({
          platform: "twitter",
          content: "Thread starter",
          threadItems: ["short one", "x".repeat(300)],
        }),
      ]);
      const issues = deterministicChecks(draft).filter((i) => i.code === "thread-item-over-limit");
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({ severity: "fail", platform: "twitter" });
      // Numbered among the replies: the root is `content`, not a thread item.
      expect(issues[0].message).toContain("thread reply 2 is 300 chars (hard limit 280)");
      expect(issues[0].fix).toBeTruthy();
    });

    it("does not measure thread items on a platform whose transport never sends them", () => {
      // LinkedIn has no reply chain, so a chain the fix loop leaves on its render
      // never leaves the building, and flagging it would send the operator to
      // edit a field that is not published.
      const draft = draftWith([
        render({ platform: "linkedin", content: "Thread starter", threadItems: ["x".repeat(3001)] }),
      ]);
      expect(
        deterministicChecks(draft).filter((i) => i.code === "thread-item-over-limit"),
      ).toHaveLength(0);
    });

    it("does not count a stored leading copy of the body as a reply", () => {
      const draft = draftWith([
        render({ platform: "twitter", content: "y".repeat(300), threadItems: ["y".repeat(300), "short"] }),
      ]);
      const codes = deterministicChecks(draft).map((i) => i.code);
      expect(codes.filter((c) => c === "over-limit")).toHaveLength(1);
      expect(codes).not.toContain("thread-item-over-limit");
    });

    /**
     * The production failure this whole check exists for: 300 code points read
     * as "exactly at the limit" and passed, while Postiz counted 301 UTF-16
     * units and refused the post.
     */
    /**
     * ⚠️ REWRITTEN 2026-08-05, and the rewrite is the point.
     *
     * This used to post 298 chars + "🗣️" to Bluesky and assert "content is 301
     * chars (hard limit 300)" — because the emoji is 3 UTF-16 units. That was
     * the AGGREGATOR's arithmetic. Bluesky's lexicon caps 300 GRAPHEMES, so
     * that body is 299 and the vendor would have taken it; the old assertion
     * pinned us to refusing valid posts.
     *
     * The behaviour worth keeping is the one the name describes: a body that
     * looks fine by a naive count and is over once measured the vendor's way.
     * On YouTube that is now genuinely true, because its cap is UTF-8 BYTES.
     */
    it("flags over-limit on a body that is only over once counted the vendor's way", () => {
      // 3,000 accented characters: 3,000 by String.length, 6,000 bytes to
      // YouTube, against a 5,000-byte cap.
      const draft = draftWith([render({ platform: "youtube", content: "é".repeat(3000) })]);
      const issue = deterministicChecks(draft).find((i) => i.code === "over-limit");
      expect(issue).toMatchObject({ severity: "fail", platform: "youtube" });
      expect(issue!.message).toContain("content is 6000 chars (hard limit 5000)");
    });

    /** The converse: emoji no longer inflate a Bluesky body past its real cap. */
    it("does not flag a Bluesky body that is within 300 GRAPHEMES", () => {
      const draft = draftWith([
        render({ platform: "bluesky", content: "x".repeat(298) + "🗣️" }),
      ]);
      expect(deterministicChecks(draft).find((i) => i.code === "over-limit")).toBeUndefined();
    });

    it("flags first-comment-over-limit, since the vendor caps every value it is sent", () => {
      const draft = draftWith([
        render({
          platform: "threads",
          content: "short body",
          firstComment: "c".repeat(501),
        }),
      ]);
      const issues = deterministicChecks(draft).filter(
        (i) => i.code === "first-comment-over-limit",
      );
      expect(issues).toHaveLength(1);
      expect(issues[0].message).toContain("first comment is 501 chars (hard limit 500)");
      expect(issues[0].fix).toBeTruthy();
    });

    /**
     * Threads' chainItems appends the first comment to the reply chain, so a
     * thread does not supersede it there: it is sent last and capped like any
     * other value.
     */
    it("flags a Threads first comment that closes a thread", () => {
      const draft = draftWith([
        render({
          platform: "threads",
          content: "short body",
          firstComment: "c".repeat(501),
          threadItems: ["one", "two"],
        }),
      ]);
      expect(
        deterministicChecks(draft).filter((i) => i.code === "first-comment-over-limit"),
      ).toHaveLength(1);
    });

    /** LinkedIn's transport drops the first comment, so its length is not checked. */
    it("ignores a first comment on a platform whose transport drops it", () => {
      const draft = draftWith([
        render({ platform: "linkedin", content: "short body", firstComment: "c".repeat(3001) }),
      ]);
      expect(
        deterministicChecks(draft).filter((i) => i.code === "first-comment-over-limit"),
      ).toHaveLength(0);
    });

    it("flags brand-em-dash (warn) once when content contains an em-dash", () => {
      const draft = draftWith([
        render({ platform: "bluesky", content: "We shipped this — finally" }),
      ]);
      const issues = deterministicChecks(draft).filter((i) => i.code === "brand-em-dash");
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({ severity: "warn", platform: "bluesky" });
      expect(issues[0].fix).toBeTruthy();
    });

    // Raised from `info` to `warn` on 2026-08-05: it was advisory-only and
    // nothing surfaced it, while alt text was being dropped in transit on
    // several platforms. Still not `fail` — a missing alt should not block a
    // publish, just be visible before it ships.
    it("flags alt-missing (warn) for each image with no alt text, independent of renders", () => {
      const media = [image({ altText: undefined })];
      const draft = draftWith([render({ platform: "facebook", content: "hi" })], media);
      const issue = deterministicChecks(draft).find((i) => i.code === "alt-missing");
      expect(issue).toMatchObject({ severity: "warn" });
      expect(issue!.platform).toBeUndefined();
      expect(issue!.message).toContain("[0]");
      expect(issue!.fix).toBeTruthy();
    });

    it("flags target-skipped (fail) for a target the formatter produced no render for", () => {
      // The formatter drops requiresMedia platforms on a text-only draft, so the
      // per-render checks below never see them and the platform would otherwise
      // vanish from the previews with no explanation.
      const draft = draftWith([render({ platform: "facebook", content: "hello" })]);
      draft.targets = ["facebook", "instagram"];
      const issue = deterministicChecks(draft).find((i) => i.code === "target-skipped");
      expect(issue).toMatchObject({ severity: "fail", platform: "instagram" });
      expect(issue!.message).toMatch(/requires an image or video/);
      expect(issue!.fix).toBeTruthy();
    });

    it("does not flag target-skipped when every target has a render", () => {
      const draft = draftWith([render({ platform: "facebook", content: "hello" })]);
      expect(deterministicChecks(draft).some((i) => i.code === "target-skipped")).toBe(false);
    });

    it("says WHY each target was skipped, because the three causes have different remedies", () => {
      // The operator's next action differs per cause: attach a video, attach an
      // image, or go look at why the formatter produced nothing. One generic
      // "skipped" message sends all three to the same dead end.
      const draft = draftWith([render({ platform: "facebook", content: "hello" })]);
      draft.targets = ["facebook", "youtube", "instagram", "twitter"];
      const byPlatform = new Map(
        deterministicChecks(draft)
          .filter((i) => i.code === "target-skipped")
          .map((i) => [i.platform, i.message] as const),
      );
      expect(byPlatform.get("youtube")).toMatch(/requires a video/);
      expect(byPlatform.get("instagram")).toMatch(/requires an image or video/);
      // Neither flag set: X takes text happily, so media is not the remedy and
      // the message must not imply it is.
      expect(byPlatform.get("twitter")).toMatch(/the formatter produced no version/);
      expect(byPlatform.get("twitter")).not.toMatch(/requires/);
    });

    /**
     * ⚠️ A platform this build has no spec for.
     *
     * `ALL_PLATFORMS`, the SPECS table and the transport registry are three
     * separate lists, and a platform reaches `draft.targets` from stored data
     * rather than from the type. A draft saved before a platform was removed
     * (or a target added ahead of its spec) therefore arrives here with no
     * spec, and the per-target loops are the first thing to touch it. Without
     * the guards, `s.requiresVideo` throws a TypeError and the ENTIRE QA run
     * dies for a draft whose other eight platforms are fine.
     */
    it("names an unmodelled target instead of printing undefined, and skips its spec checks", () => {
      // ⚠️ Through `unknown`: a literal outside the union is not comparable to
      // it, so a direct `as Platform` does not compile.
      const alien = "mastodon" as unknown as Platform;
      const draft = draftWith([render({ platform: "facebook", content: "hello" })]);
      draft.targets = ["facebook", alien];

      const issues = deterministicChecks(draft, null, undefined, new Set<Platform>(["facebook"]));
      const noRoute = issues.find((i) => i.code === "no-route");
      expect(noRoute).toMatchObject({ severity: "fail", platform: alien });
      // The bare platform id is the fallback for a missing displayName. The
      // thing being pinned is the absence of "undefined has no way to publish".
      expect(noRoute!.message).toContain("mastodon");
      expect(noRoute!.message).not.toContain("undefined");
      expect(noRoute!.fix).not.toContain("undefined");
      // No spec means no rule to check it against, so it produces no
      // target-skipped finding rather than a guess about media.
      expect(issues.some((i) => i.code === "target-skipped")).toBe(false);
    });

    /**
     * QA had thirty checks on what a post SAYS and none on whether it could be
     * delivered. When the aggregator account was deleted, every draft passed QA
     * and then failed at publish with a vendor subscription 401 naming neither
     * the platform nor the cause.
     */
    describe("no-route", () => {
      const routable = (...p: Platform[]) => new Set<Platform>(p);

      it("fails a target that is neither direct nor held by the aggregator", () => {
        const draft = draftWith([
          render({ platform: "bluesky", content: "hi" }),
          render({ platform: "facebook", content: "hi" }),
        ]);
        const issues = deterministicChecks(draft, null, undefined, routable("bluesky"));
        const issue = issues.find((i) => i.code === "no-route");
        expect(issue).toMatchObject({ severity: "fail", platform: "facebook" });
        expect(issue!.fix).toBeTruthy();
        expect(issues.filter((i) => i.code === "no-route")).toHaveLength(1);
      });

      it("is silent when every target is routable", () => {
        const draft = draftWith([render({ platform: "bluesky", content: "hi" })]);
        const issues = deterministicChecks(draft, null, undefined, routable("bluesky"));
        expect(issues.some((i) => i.code === "no-route")).toBe(false);
      });

      it("is skipped entirely when the caller could not resolve routing", () => {
        // null, not an empty set. A caller that does not know (the CLI, a unit
        // test with no settings table) must not have every target failed for it.
        const draft = draftWith([render({ platform: "bluesky", content: "hi" })]);
        expect(deterministicChecks(draft).some((i) => i.code === "no-route")).toBe(false);
        expect(
          deterministicChecks(draft, null, undefined, null).some((i) => i.code === "no-route"),
        ).toBe(false);
        // An EMPTY set is a real answer ("nothing is reachable") and does fail.
        expect(
          deterministicChecks(draft, null, undefined, routable()).some((i) => i.code === "no-route"),
        ).toBe(true);
      });

      /**
       * TikTok publishes through Zernio, so it is an ordinary platform here: an
       * unrouted TikTok target fails `no-route` like any other, with the same
       * fix, and a routed one is silent. There is no softer "awaiting approval"
       * state any more.
       */
      describe("a TikTok target", () => {
        function tiktokDraft(): Draft {
          return draftWith(
            [
              render({ platform: "bluesky", content: "Shipped a small fix today.", mediaIndices: [1] }),
              render({ platform: "tiktok", content: "Shipped a small fix today.", mediaIndices: [0] }),
            ],
            [
              video({ url: "https://cdn.acmebrands.com/clip.mp4", altText: "A demo clip" }),
              image({ altText: "A branded card" }),
            ],
          );
        }

        it("fails no-route, with the connect fix, when TikTok has no route", () => {
          const issues = deterministicChecks(tiktokDraft(), null, undefined, routable("bluesky"));

          expect(issues.filter((i) => i.code === "no-route")).toEqual([
            expect.objectContaining({
              severity: "fail",
              platform: "tiktok",
              message: "TikTok has no way to publish: no direct connection, and no aggregator channel for it",
              fix: "Connect TikTok in Social HQ settings, or remove it from this post's targets.",
            }),
          ]);
        });

        it("is silent once TikTok is routable", () => {
          const issues = deterministicChecks(
            tiktokDraft(),
            null,
            undefined,
            routable("bluesky", "tiktok"),
          );

          expect(issues.some((i) => i.code === "no-route")).toBe(false);
        });

        it("blocks the report when TikTok is unrouted, and passes once it is routed", async () => {
          const blocked = await runQa(tiktokDraft(), {
            skipLlm: true,
            channelRules: null,
            routablePlatforms: routable("bluesky"),
          });
          expect(blocked.pass).toBe(false);

          const routed = await runQa(tiktokDraft(), {
            skipLlm: true,
            channelRules: null,
            routablePlatforms: routable("bluesky", "tiktok"),
          });
          expect(routed.issues.filter((i) => i.severity === "fail")).toEqual([]);
          expect(routed.pass).toBe(true);
        });
      });

      it("is not offered to the text fix loop", () => {
        // Rewriting copy cannot connect an account, and an attempt would count
        // against the draft's budget on its way to quarantine for the wrong
        // reason.
        const draft = draftWith([render({ platform: "facebook", content: "hi" })]);
        const issue = deterministicChecks(draft, null, undefined, routable())
          .find((i) => i.code === "no-route")!;
        expect(isTextFixable(issue)).toBe(false);
      });
    });

    it("returns no issues for a clean, fully-compliant draft", () => {
      // Carries a visual: under the brand rule a text-only post is not compliant
      // however clean its copy is, because every post is a marketing asset.
      const draft = draftWith(
        [
          render({
            platform: "bluesky",
            content: "Shipped a small fix today.",
            mediaIndices: [0],
          }),
        ],
        [image({ altText: "A branded card" })],
      );
      expect(deterministicChecks(draft)).toEqual([]);
    });
  });

  describe("brand media policy", () => {
    it("fails a draft with no media at all, whatever the platform allows", () => {
      // Bluesky is perfectly happy with text, so no spec flag would catch this.
      const draft = draftWith([render({ platform: "bluesky", content: "Text only." })]);
      const issue = deterministicChecks(draft).find((i) => i.code === "brand-media-missing");
      expect(issue?.severity).toBe("fail");
      // Draft-level, not per-platform: the post as a whole is the asset.
      expect(issue?.platform).toBeUndefined();
    });

    it("does not fire once a visual is attached", () => {
      const draft = draftWith(
        [render({ platform: "bluesky", content: "With a card.", mediaIndices: [0] })],
        [image({ altText: "card" })],
      );
      expect(deterministicChecks(draft).some((i) => i.code === "brand-media-missing")).toBe(false);
    });

    it("warns, not fails, when a platform sends none of the post's media", () => {
      // This is the shape the oversized-image mechanical fix leaves behind (it
      // drops the asset from platforms that can publish without one) and the shape
      // a text-only subreddit produces. Failing would strand both.
      const draft = draftWith(
        [render({ platform: "bluesky", content: "No image on this one.", mediaIndices: [] })],
        [image({ altText: "card" })],
      );
      const issue = deterministicChecks(draft).find((i) => i.code === "render-media-missing");
      expect(issue?.severity).toBe("warn");
      expect(issue?.platform).toBe("bluesky");
    });

    it("reports the platform's own requirement instead of the brand warn", () => {
      // Instagram genuinely requires media, so the existing hard failure stands
      // and is not duplicated by the softer brand warn.
      const draft = draftWith(
        [render({ platform: "instagram", content: "caption", mediaIndices: [] })],
        [image({ altText: "card" })],
      );
      const codes = deterministicChecks(draft).map((i) => i.code);
      expect(codes).toContain("media-required");
      expect(codes).not.toContain("render-media-missing");
    });

    it("surfaces a nonzero follow-up delay, whose failure is otherwise invisible", () => {
      // The root reports success the moment it is live, so a delayed reply that
      // never lands looks exactly like success. The operator has to be told the
      // delay is there.
      const draft = draftWith(
        [
          render({
            platform: "twitter",
            content: "root",
            threadItems: ["the link"],
            followupDelayMinutes: 5,
            mediaIndices: [0],
          }),
        ],
        [image({ altText: "card" })],
      );
      const issue = deterministicChecks(draft).find((i) => i.code === "followup-delay");
      expect(issue?.severity).toBe("info");
      expect(issue?.message).toMatch(/5 min/);
    });

    it("warns when a delay is set but nothing will ever use it", () => {
      const draft = draftWith(
        [
          render({
            platform: "bluesky",
            content: "single value",
            followupDelayMinutes: 10,
            mediaIndices: [0],
          }),
        ],
        [image({ altText: "card" })],
      );
      const codes = deterministicChecks(draft).map((i) => i.code);
      expect(codes).toContain("followup-delay-unused");
      expect(codes).not.toContain("followup-delay");
    });

    it.each([
      // Facebook posts its first comment with the post; no transport defers it.
      ["a Facebook first comment", { platform: "facebook" as const, firstComment: "the link" }],
      // A chain that is only a stored copy of the body has no reply to defer.
      ["a thread that only repeats the body", { platform: "twitter" as const, threadItems: ["root"] }],
    ])("warns that the delay is unused for %s", (_label, over) => {
      const draft = draftWith(
        [render({ content: "root", followupDelayMinutes: 10, mediaIndices: [0], ...over })],
        [image({ altText: "card" })],
      );
      const codes = deterministicChecks(draft).map((i) => i.code);
      expect(codes).toContain("followup-delay-unused");
      expect(codes).not.toContain("followup-delay");
    });

    it("says nothing when the delay is zero or absent", () => {
      const draft = draftWith(
        [
          render({
            platform: "twitter",
            content: "root",
            threadItems: ["root", "link"],
            mediaIndices: [0],
          }),
        ],
        [image({ altText: "card" })],
      );
      const codes = deterministicChecks(draft).map((i) => i.code);
      expect(codes).not.toContain("followup-delay");
      expect(codes).not.toContain("followup-delay-unused");
    });

    it("routes both brand codes to the image affordance and away from text fixes", () => {
      for (const code of ["brand-media-missing", "render-media-missing"]) {
        const issue: QAIssue = { severity: "fail", code, message: "m", fix: "attach an image" };
        expect(mediaFixKind(issue)).toBe("image");
        // A rewrite cannot attach a picture, so the AI fix pass must not claim it.
        expect(isTextFixable(issue)).toBe(false);
      }
    });
  });

  // These two used to go through textFixableIssues, a one-line filter nothing in
  // production called; the rule they pin is isTextFixable's.
  describe("isTextFixable over a mixed report", () => {
    it("excludes NON_TEXT_FIX_CODES and issues with no recommended fix, keeping the rest regardless of severity", () => {
      const report: QAReport = {
        ranAt: "t",
        pass: false,
        issues: [
          { severity: "fail", code: "over-limit", message: "too long", fix: "trim it" },
          { severity: "warn", code: "hashtag-heavy", message: "too many tags", fix: "cut tags" },
          { severity: "fail", code: "media-required", message: "needs media", fix: "attach media" },
          { severity: "info", code: "truncation", message: "gets truncated", fix: "front-load hook" },
          { severity: "info", code: "alt-missing", message: "no alt text", fix: "add alt text" },
          { severity: "fail", code: "target-skipped", message: "instagram skipped", fix: "attach media" },
          { severity: "warn", code: "no-fix-available", message: "nothing actionable" },
        ],
      };
      const fixable = report.issues.filter((i) => isTextFixable(i));
      // "truncation" is info-tier but a rewrite genuinely resolves it, so it is
      // included: severity does not decide fixability, the code does.
      expect(fixable.map((i) => i.code)).toEqual(["over-limit", "hashtag-heavy", "truncation"]);
    });

    it("keeps a brand gate's issues out of the AI rewrite, fix text or not", () => {
      const gate = { code: "brand-word", severity: "fail" as const, message: "m", fix: "f", detect: () => true };
      const brand = { ...NO_BRAND, qaGates: () => [gate] };
      const issues: QAIssue[] = [
        { severity: "fail", code: "brand-word", message: "held term", fix: "rephrase" },
        { severity: "fail", code: "over-limit", message: "too long", fix: "trim it" },
      ];
      expect(issues.filter((i) => isTextFixable(i, brand)).map((i) => i.code)).toEqual(["over-limit"]);
      // The code is the brand's, not the engine's: without that brand it is ordinary copy.
      expect(issues.filter((i) => isTextFixable(i)).map((i) => i.code)).toEqual(["brand-word", "over-limit"]);
    });
  });

  describe("mediaFixKind", () => {
    it("flags the media-blocked codes with the kind of media that unblocks them", () => {
      expect(
        mediaFixKind({ severity: "fail", code: "media-required", message: "m" }),
      ).toBe("image");
      expect(
        mediaFixKind({ severity: "fail", code: "video-required", message: "m" }),
      ).toBe("video");
    });

    it("resolves target-skipped against the platform's own media rule", () => {
      expect(
        mediaFixKind({ severity: "fail", platform: "instagram", code: "target-skipped", message: "m" }),
      ).toBe("image");
      expect(
        mediaFixKind({ severity: "fail", platform: "youtube", code: "target-skipped", message: "m" }),
      ).toBe("video");
    });

    // target-skipped also fires when the formatter simply produced no version,
    // where offering "Add an image" would send the operator down a dead end.
    it("returns null for a skipped platform that does not require media", () => {
      expect(
        mediaFixKind({ severity: "fail", platform: "twitter", code: "target-skipped", message: "m" }),
      ).toBeNull();
    });

    it("returns null for ordinary copy issues", () => {
      expect(
        mediaFixKind({ severity: "fail", platform: "twitter", code: "over-limit", message: "m" }),
      ).toBeNull();
    });

    it("returns null for a platform this build has no spec for", () => {
      // The same guard as the target-skipped loop, in the other place EVERY
      // issue passes through: runQa stamps needsMedia on every issue in the
      // report, so an unspecced platform reaching `s.requiresVideo` would throw
      // inside the stamping loop and lose the whole report, not one finding.
      expect(
        mediaFixKind({
          severity: "fail",
          platform: "mastodon" as unknown as Platform,
          code: "target-skipped",
          message: "m",
        }),
      ).toBeNull();
    });
  });

  /**
   * ⛔ The mechanical fixer's only remedy for an oversized asset is to DROP it,
   * which is safe only on a platform that can still publish without media. So
   * this answer depends entirely on knowing WHICH platform, and an issue that
   * does not name one has to be treated as unfixable.
   */
  describe("isMechanicallyFixable", () => {
    it("refuses a size issue that names no platform, rather than guessing", () => {
      // runQa stamps `fixable` from this, and `fixable` lights the composer's
      // fix button. Saying yes here offers a one-click fix that has no render
      // to remove the asset from.
      expect(
        isMechanicallyFixable({ severity: "fail", code: "image-too-large", message: "m" }),
      ).toBe(false);
      expect(
        isMechanicallyFixable({ severity: "fail", code: "video-too-large", message: "m" }),
      ).toBe(false);
    });

    it("drops an oversized asset where the platform can publish without it, and not where it cannot", () => {
      expect(
        isMechanicallyFixable({
          severity: "fail",
          platform: "bluesky",
          code: "image-too-large",
          message: "m",
        }),
      ).toBe(true);
      // Instagram requires media, so dropping the image is not a fix, it is a
      // different failure. It has to stay a blocker.
      expect(
        isMechanicallyFixable({
          severity: "fail",
          platform: "instagram",
          code: "image-too-large",
          message: "m",
        }),
      ).toBe(false);
    });
  });

  describe("llmReview", () => {
    it("asks the model to review the draft and returns its issues + summary", async () => {
      genJsonMock.mockResolvedValue({
        issues: [{ platform: "linkedin", code: "weak-hook", message: "First line is flat.", fix: "Lead with a number." }],
        summary: "Mostly solid, one weak hook.",
      });
      const draft = draftWith([render({ platform: "linkedin", content: "We did a thing." })]);
      const result = await llmReview(draft, ACME);
      expect(result.summary).toBe("Mostly solid, one weak hook.");
      expect(result.issues).toHaveLength(1);
      const prompt = genJsonMock.mock.calls[0][0] as string;
      expect(prompt).toContain("You are the QA editor for Acmebrands's social media.");
      expect(prompt).toContain("linkedin");
    });

    it("asks for structured output with closed code and platform enums and NO severity field", async () => {
      genJsonMock.mockResolvedValue({ issues: [], summary: "clean" });
      await llmReview(draftWith([render({ platform: "linkedin", content: "x" })]));
      const opts = genJsonMock.mock.calls[0][1] as { schema: Record<string, unknown> };
      expect(Object.keys(opts)).toEqual(["schema"]);
      const item = (opts.schema as {
        properties: { issues: { items: { properties: Record<string, { enum?: string[] }>; required: string[] } } };
      }).properties.issues.items;
      // Severity is ours (LLM_ISSUE_SEVERITY); the model is never asked for it.
      expect(Object.keys(item.properties).sort()).toEqual(["code", "fix", "message", "platform"]);
      expect(item.required).toEqual(["code", "platform", "message", "fix"]);
      expect(item.properties.code!.enum).toEqual(
        expect.arrayContaining(["factual-drift", "wrong-link", "grammar", "link-placement", "style-nit"]),
      );
      expect(item.properties.code!.enum).toHaveLength(16);
      expect(item.properties.platform!.enum).toEqual(expect.arrayContaining(["linkedin", "twitter", "global"]));
      expect(opts.schema).toMatchObject({ required: ["issues", "summary"], additionalProperties: false });
    });

    it("tells the reviewer that the brand's own /l/ short link is not a wrong link", async () => {
      genJsonMock.mockResolvedValue({ issues: [], summary: "clean" });
      await llmReview(draftWith([render({ platform: "linkedin", content: "x" })]), ACME);
      const prompt = genJsonMock.mock.calls[0][0] as string;
      expect(prompt).toContain("tracked short link");
      expect(prompt).toContain("whose path is /l/");
      expect(prompt).toContain("(for example https://www.acmebrands.com/l/Ab3xK9q)");
      expect(prompt).toContain("never report it as a wrong, broken or mismatched link");
    });

    it("names no brand and no tracked links when brandless", async () => {
      genJsonMock.mockResolvedValue({ issues: [], summary: "clean" });
      await llmReview(draftWith([render({ platform: "linkedin", content: "x" })]));
      const prompt = genJsonMock.mock.calls[0][0] as string;
      expect(prompt).toContain("You are the QA editor for this brand's social media.");
      expect(prompt).not.toContain("tracked short link");
      expect(prompt).toContain("platform-norm violations not caught by mechanical limits.\n\nReturn JSON:");
    });
  });

  // Regression cover for the 2026-07-29 audit: severity used to come straight
  // from the model while `code` was a free-form slug, so the same defect could
  // block one draft and warn on the next. `pass` gates publishing, so that made
  // publication non-deterministic for identical copy. The schema now closes the
  // code enum and carries no severity at all.
  describe("llm issue codes are a closed enum with code-derived severity", () => {
    const draft1 = () => draftWith([render({ platform: "twitter", content: "We did a thing." })]);

    it.each([
      ["link-placement", "warn"],
      ["grammar", "fail"],
      ["wrong-link", "fail"],
      ["unbacked-claim", "fail"],
      ["off-brand", "fail"],
      ["platform-norm", "warn"],
      ["emoji-usage", "info"],
      ["style-nit", "info"],
    ])("prices %s as %s, whatever the copy", async (code, severity) => {
      genJsonMock.mockResolvedValue({
        issues: [{ platform: "twitter", code, message: "m", fix: "f" }],
        summary: "s",
      });
      const report = await runQa(draft1());
      expect(report.issues.find((i) => i.code === `llm-${code}`)).toMatchObject({ severity });
    });

    it("drops a finding with a blank message: a blocker nobody can read is not a finding", async () => {
      genJsonMock.mockResolvedValue({
        issues: [
          { platform: "twitter", code: "grammar", message: "   ", fix: "x" },
          { platform: "twitter", code: "weak-hook", message: "flat hook", fix: "punch it" },
        ],
        summary: "s",
      });
      const report = await runQa(draft1());
      expect(report.issues.filter((i) => i.code.startsWith("llm-")).map((i) => i.code)).toEqual(["llm-weak-hook"]);
    });

    it("reads platform \"global\" as a draft-wide finding", async () => {
      genJsonMock.mockResolvedValue({
        issues: [{ platform: "global", code: "weak-hook", message: "flat", fix: "punch it" }],
        summary: "s",
      });
      const report = await runQa(draft1());
      expect(report.issues.find((i) => i.code === "llm-weak-hook")!.platform).toBeUndefined();
    });

    it("treats a blank fix as no fix, so the AI fix button stays dark", async () => {
      // ⚠️ `fixable` is stamped from isTextFixable, which requires a non-empty
      // `fix`. A whitespace fix kept as-is would light the button and hand the
      // formatter an empty instruction, burning an attempt against the draft's
      // budget on its way to quarantine.
      genJsonMock.mockResolvedValue({
        issues: [{ platform: "twitter", code: "weak-hook", message: "flat", fix: "   " }],
        summary: "s",
      });
      const report = await runQa(draft1());
      const issue = report.issues.find((i) => i.code === "llm-weak-hook");
      expect(issue!.fix).toBeUndefined();
      expect(issue!.fixable).toBe(false);
    });

    it("gives the model the enum and forbids inventing codes", async () => {
      genJsonMock.mockResolvedValue({ issues: [], summary: "clean" });
      await llmReview(draft1());
      const prompt = genJsonMock.mock.calls[0][0] as string;
      for (const code of ["factual-drift", "broken-link", "grammar", "link-placement", "style-nit"]) {
        expect(prompt).toContain(code);
      }
      expect(prompt).toContain("do not invent new codes");
      expect(prompt).toContain("do not report severity");
    });
  });

  describe("who ran the review", () => {
    const draft1 = () => draftWith([render({ platform: "twitter", content: "We did a thing." })]);

    it("stamps the report with the reviewer's model and effort", async () => {
      genJsonMock.mockResolvedValue({ issues: [], summary: "clean" });
      const report = await runQa(draft1());
      expect(report.reviewedBy).toEqual({ model: "claude-sonnet-5-5", effort: "high" });
    });

    it("stamps nothing when the review was skipped", async () => {
      const report = await runQa(draft1(), { skipLlm: true });
      expect(report.reviewedBy).toBeUndefined();
    });

    it("fails closed on a refused review: blocked, unstamped, never a clean pass", async () => {
      genJsonMock.mockRejectedValue(new ModelRefusedError("general_harms"));
      const report = await runQa(draft1());
      expect(report.pass).toBe(false);
      expect(report.reviewedBy).toBeUndefined();
      expect(report.llmSummary).toBeUndefined();
      expect(report.issues.find((i) => i.code === "llm-qa-unavailable")).toMatchObject({
        severity: "fail",
        message: expect.stringContaining("the model declined the request (refusal: general_harms)"),
      });
    });
  });

  /**
   * A reviewer model blocks a true post with `llm-wrong-link` on the render's
   * own tracked short link, so runQa screens that one finding out.
   */
  describe("the tracked-link false positive", () => {
    const SOURCE = "https://www.acmebrands.com/news/district-ai-teammates-after-hours-translation";
    const TRACKED = "https://www.acmebrands.com/l/z7VRQa7";
    const tracked = (over: { link?: string | null; content?: string } = {}) => {
      const d = draftWith([
        render({ platform: "linkedin", content: over.content ?? `See how it works at ${TRACKED}` }),
      ]);
      if (over.link !== null) d.source.link = over.link ?? SOURCE;
      return d;
    };
    const wrongLink = (message: string, fix = "Use the source link.") => ({ code: "wrong-link", message, fix });

    it("is the finding that names the render's tracked link against the source link", () => {
      expect(
        isTrackedLinkFalsePositive(
          wrongLink(`The render links to www.acmebrands.com/l/z7VRQa7 instead of ${SOURCE}.`),
          tracked(),
          ACME,
        ),
      ).toBe(true);
    });

    it("is also the finding that names only the tracked link, in any spelling", () => {
      expect(isTrackedLinkFalsePositive(wrongLink("Link https://acmebrands.com/l/z7VRQa7/ diverges."), tracked(), ACME)).toBe(true);
    });

    it("holds without a source link on the draft", () => {
      expect(isTrackedLinkFalsePositive(wrongLink(`Unexpected link ${TRACKED}.`), tracked({ link: null }), ACME)).toBe(true);
    });

    it("is NOT a broken-link finding, which can be real on a tracked link", () => {
      expect(
        isTrackedLinkFalsePositive({ code: "broken-link", message: `${TRACKED}. swallows the period`, fix: "f" }, tracked(), ACME),
      ).toBe(false);
    });

    it("is NOT a wrong-link finding that also names a third URL", () => {
      expect(
        isTrackedLinkFalsePositive(wrongLink(`${TRACKED} and https://example.com/other disagree.`), tracked(), ACME),
      ).toBe(false);
    });

    it("is NOT a tracked link the renders do not carry", () => {
      expect(
        isTrackedLinkFalsePositive(wrongLink("www.acmebrands.com/l/OtherCode points elsewhere."), tracked(), ACME),
      ).toBe(false);
    });

    it("is NOT screened when the renders carry no tracked link at all", () => {
      const plain = tracked({ content: "No link in the body." });
      expect(isTrackedLinkFalsePositive(wrongLink(`Unexpected link ${TRACKED}.`), plain, ACME)).toBe(false);
    });

    it("is never screened for a brand with no link domains", () => {
      expect(isTrackedLinkFalsePositive(wrongLink(`Unexpected link ${TRACKED}.`), tracked())).toBe(false);
    });

    it("is NOT a wrong-link finding that names no URL at all", () => {
      expect(isTrackedLinkFalsePositive(wrongLink("The CTA link looks wrong."), tracked(), ACME)).toBe(false);
    });

    it("finds the tracked link in a first comment or a thread reply too", () => {
      const d = tracked({ content: "No link in the body." });
      d.renders[0]!.firstComment = `Read more: ${TRACKED}`;
      d.renders.push(render({ platform: "twitter", content: "x", threadItems: ["https://www.acmebrands.com/l/Thr34d9"] }));
      expect(isTrackedLinkFalsePositive(wrongLink(`${TRACKED} is not the source.`), d, ACME)).toBe(true);
      expect(isTrackedLinkFalsePositive(wrongLink("acmebrands.com/l/Thr34d9 is odd."), d, ACME)).toBe(true);
    });

    it("is dropped by runQa, so the true post passes, while a real wrong link still blocks", async () => {
      genJsonMock.mockResolvedValue({
        issues: [
          { platform: "linkedin", code: "wrong-link", message: `Render uses ${TRACKED}, not ${SOURCE}.`, fix: "Swap it." },
          { platform: "linkedin", code: "wrong-link", message: "Points to https://example.com/elsewhere.", fix: "Fix it." },
        ],
        summary: "s",
      });
      const report = await runQa(tracked(), { brand: ACME });
      const wrong = report.issues.filter((i) => i.code === "llm-wrong-link");
      expect(wrong.map((i) => i.message)).toEqual(["Points to https://example.com/elsewhere."]);
    });
  });

  /**
   * Reddit's rules are per-destination, so they cannot live in the nightly
   * channel-rules snapshot: they change with the subreddit on the draft. These
   * run as a live lookup inside runQa, and every failure path has to degrade to
   * silence rather than block a draft or invent a finding.
   */
  describe("runQa subreddit checks", () => {
    beforeEach(() => {
      invalidateConnectedAccounts();
      resetTransports();
      process.env.SOCIALMETA_TRANSPORT_OVERRIDES = JSON.stringify({ reddit: "direct" });
      registerTransport(redditTransport());
    });
    afterEach(() => {
      resetTransports();
      delete process.env.SOCIALMETA_TRANSPORT_OVERRIDES;
      invalidateConnectedAccounts();
    });

    function redditDraft(overrides: Partial<PlatformRender> = {}) {
      return draftWith([
        render({ platform: "reddit", content: "body", title: "A title", subreddit: "saas", ...overrides }),
      ]);
    }

    it("warns that the image is dropped when the subreddit is text-only", async () => {
      // ⛔ Fires for EVERY subreddit, because the reddit transport refuses all
      // media publishing (reddit-transport.ts) — not because this particular
      // sub is text-only. The warning is what stops an operator attaching a
      // card and finding a text-only post.
      restrictionsMock.mockResolvedValue(rules({}));
      const draft = redditDraft({ mediaIndices: [0] });
      draft.source.media = [
        { path: "a.png", type: "image", mimeType: "image/png", size: 10, url: "https://cdn/a.png" },
      ];
      const report = await runQa(draft, { skipLlm: true });
      const issue = report.issues.find((i) => i.code === "subreddit-no-media");
      expect(issue).toMatchObject({ severity: "warn", platform: "reddit" });
      // A warning, not a blocker: publish falls back to a text post.
      expect(report.issues.some((i) => i.code === "subreddit-no-media" && i.severity === "fail")).toBe(false);
    });

    it("fails when the subreddit takes no post we can produce", async () => {
      restrictionsMock.mockResolvedValue(rules({ allowSelf: false }));
      const report = await runQa(redditDraft(), { skipLlm: true });
      expect(report.issues.find((i) => i.code === "subreddit-type-not-allowed")).toMatchObject({
        severity: "fail",
      });
    });

    it("fails when a flair is mandatory and none is set, naming the options", async () => {
      restrictionsMock.mockResolvedValue(
        rules({ isFlairRequired: true, flairs: [{ id: "f1", name: "Discussion" }] }),
      );
      const report = await runQa(redditDraft(), { skipLlm: true });
      const issue = report.issues.find((i) => i.code === "subreddit-flair-required");
      expect(issue).toMatchObject({ severity: "fail" });
      expect(issue!.message).toContain("Discussion");
    });

    it("says nothing when the flair is set", async () => {
      restrictionsMock.mockResolvedValue(
        rules({ isFlairRequired: true, flairs: [{ id: "f1", name: "Discussion" }] }),
      );
      const report = await runQa(redditDraft({ flair: { id: "f1", name: "Discussion" } }), {
        skipLlm: true,
      });
      expect(report.issues.some((i) => i.code === "subreddit-flair-required")).toBe(false);
    });

    it("stays silent when the lookup fails, rather than blocking the draft", async () => {
      restrictionsMock.mockRejectedValue(new Error("reddit 502"));
      const report = await runQa(redditDraft(), { skipLlm: true });
      expect(report.issues.some((i) => i.code.startsWith("subreddit-"))).toBe(false);
    });

    it("does not call Reddit at all for a draft with no reddit render", async () => {
      await runQa(draftWith([render({ platform: "bluesky", content: "hi" })]), { skipLlm: true });
      expect(restrictionsMock).not.toHaveBeenCalled();
    });

    it("does not ask Reddit anything when no subreddit is set, and reports it once", async () => {
      // There is nothing to ask ABOUT, and asking with an empty target would
      // either 404 or answer for the wrong sub. The deterministic pass has
      // already said `subreddit-missing`, so a second finding here would be the
      // same problem twice, worded differently, in the same panel.
      //
      // ⚠️ The lookup consults the SAME default the publisher would fall back
      // to, so the env var has to be controlled here: with one set, this draft
      // is not missing a subreddit at all and the test would pass for entirely
      // the wrong reason.
      const previous = process.env.SOCIALMETA_DEFAULT_SUBREDDIT;
      delete process.env.SOCIALMETA_DEFAULT_SUBREDDIT;
      try {
        const report = await runQa(redditDraft({ subreddit: undefined }), { skipLlm: true });
        expect(restrictionsMock).not.toHaveBeenCalled();
        expect(
          report.issues.some((i) => i.code.startsWith("subreddit-") && i.code !== "subreddit-missing"),
        ).toBe(false);
        expect(report.issues.some((i) => i.code === "subreddit-missing")).toBe(true);
      } finally {
        if (previous === undefined) delete process.env.SOCIALMETA_DEFAULT_SUBREDDIT;
        else process.env.SOCIALMETA_DEFAULT_SUBREDDIT = previous;
      }
    });

    it("falls back to the configured default subreddit, so QA and publish agree", async () => {
      // ⛔ Both sides of this read `r.subreddit ?? defaults().subreddit`. When
      // they disagreed, QA failed drafts the publisher would have accepted, and
      // an operator who learns to force past QA stops reading it.
      const previous = process.env.SOCIALMETA_DEFAULT_SUBREDDIT;
      process.env.SOCIALMETA_DEFAULT_SUBREDDIT = "acmebrands";
      restrictionsMock.mockResolvedValue(rules({ isFlairRequired: true }));
      try {
        const report = await runQa(redditDraft({ subreddit: undefined }), { skipLlm: true });
        expect(report.issues.some((i) => i.code === "subreddit-missing")).toBe(false);
        // The lookup ran against the default rather than being skipped.
        expect(restrictionsMock).toHaveBeenCalledWith("acmebrands");
        expect(
          report.issues.find((i) => i.code === "subreddit-flair-required")!.message,
        ).toContain("r/acmebrands");
      } finally {
        if (previous === undefined) delete process.env.SOCIALMETA_DEFAULT_SUBREDDIT;
        else process.env.SOCIALMETA_DEFAULT_SUBREDDIT = previous;
      }
    });

    it("still refuses a link-only subreddit when the draft carries exactly one image", async () => {
      // ⛔ "media" is NEVER in `allow`, whatever the subreddit permits:
      // reddit-transport.ts refuses all media publishing, so publish.ts's
      // normaliser deliberately never claims it. That is what stops the
      // `mediaCount === 1` escape hatch from letting a link-only sub through on
      // the strength of an image we cannot actually send.
      restrictionsMock.mockResolvedValue(rules({ allowSelf: false }));
      const draft = redditDraft({ mediaIndices: [0] });
      draft.source.media = [
        { path: "a.png", type: "image", mimeType: "image/png", size: 10, url: "https://cdn/a.png" },
      ];
      const report = await runQa(draft, { skipLlm: true });
      expect(report.issues.find((i) => i.code === "subreddit-type-not-allowed")).toMatchObject({
        severity: "fail",
        platform: "reddit",
      });
      // The softer "your image will be dropped" warning is for subs that DO
      // take our post type. Emitting both would tell the operator to fix the
      // image on a draft that cannot publish there at all.
      expect(report.issues.some((i) => i.code === "subreddit-no-media")).toBe(false);
    });

    it("names the flair requirement even when the vendor lists no flairs to choose from", async () => {
      // A sub can mandate a flair and still return an empty list (restricted,
      // or the endpoint answered thinly). The requirement is still real, so the
      // finding still fires, and the message must not trail an empty
      // "(available: )" that reads like a rendering bug.
      restrictionsMock.mockResolvedValue(rules({ isFlairRequired: true, flairs: [] }));
      const report = await runQa(redditDraft(), { skipLlm: true });
      const issue = report.issues.find((i) => i.code === "subreddit-flair-required");
      expect(issue).toMatchObject({ severity: "fail" });
      expect(issue!.message).toContain("requires a post flair");
      expect(issue!.message).not.toContain("available:");
    });
  });

  describe("runQa", () => {
    it("skipLlm: true runs only mechanical checks and never calls the model", async () => {
      const draft = draftWith([render({ platform: "twitter", content: "a".repeat(300) })]);
      const report = await runQa(draft, { skipLlm: true });
      expect(genJsonMock).not.toHaveBeenCalled();
      expect(report.pass).toBe(false);
      expect(report.issues.some((i) => i.code === "over-limit")).toBe(true);
      expect(report.llmSummary).toBeUndefined();
      expect(report.ranAt).toEqual(expect.any(String));
    });

    it("skipLlm: false success path merges llm issues with an llm- code prefix and sets llmSummary", async () => {
      genJsonMock.mockResolvedValue({
        issues: [{ platform: "linkedin", code: "weak-hook", message: "flat hook", fix: "punch it up" }],
        summary: "Solid overall.",
      });
      const draft = draftWith([render({ platform: "linkedin", content: "We did a thing." })]);
      const report = await runQa(draft);
      expect(report.llmSummary).toBe("Solid overall.");
      const llmIssue = report.issues.find((i) => i.code === "llm-weak-hook");
      expect(llmIssue).toMatchObject({
        severity: "warn",
        platform: "linkedin",
        message: "flat hook",
        fix: "punch it up",
      });
    });

    it("skipLlm: false failure path adds a blocking llm-qa-unavailable and still returns the mechanical report", async () => {
      genJsonMock.mockRejectedValue(new Error("model timed out after waiting a very long time indeed"));
      const draft = draftWith([render({ platform: "twitter", content: "a".repeat(300) })]);
      const report = await runQa(draft);
      const unavailable = report.issues.find((i) => i.code === "llm-qa-unavailable");
      expect(unavailable).toMatchObject({ severity: "fail", fixable: false });
      expect(unavailable!.message).toContain("LLM review failed");
      expect(report.llmSummary).toBeUndefined();
      // mechanical issues are still present
      expect(report.issues.some((i) => i.code === "over-limit")).toBe(true);
      expect(report.pass).toBe(false);
    });

    // Drives the composer's inline "Add or generate an image" action, so the
    // media-blocked platform stops being a dead end the AI fix cannot clear.
    it("stamps needsMedia on media-blocked issues and leaves it off copy issues", async () => {
      const draft = draftWith([render({ platform: "twitter", content: "a".repeat(300) })]);
      draft.targets = ["twitter", "instagram"];
      const report = await runQa(draft, { skipLlm: true });

      const skipped = report.issues.find(
        (i) => i.code === "target-skipped" && i.platform === "instagram",
      );
      expect(skipped?.needsMedia).toBe("image");
      // A rewrite cannot resolve it, which is exactly why the action is needed.
      expect(skipped?.fixable).toBe(false);

      const overLimit = report.issues.find((i) => i.code === "over-limit");
      expect(overLimit?.needsMedia).toBeUndefined();
    });

    it("pass is true only when no fail-severity issues exist", async () => {
      const draft = draftWith(
        [render({ platform: "bluesky", content: "Clean post, no issues.", mediaIndices: [0] })],
        [image({ altText: "A branded card" })],
      );
      const report = await runQa(draft, { skipLlm: true });
      expect(report.issues.some((i) => i.severity === "fail")).toBe(false);
      expect(report.pass).toBe(true);
    });
  });
});

/**
 * Placeholder scaffolding gates. A published Reddit post opened
 * "Hey r/SaaS (or similar relevant sub), ..." on 2026-07-26 — model hedge text,
 * live, addressed to the wrong community — and the LLM review passed it. These
 * are the deterministic guarantees that class of artifact cannot ship again.
 */
describe("placeholder and wrong-subreddit gates", () => {
  it("detectPlaceholderText catches the scaffold shapes and spares real copy", () => {
    expect(detectPlaceholderText("Hey r/SaaS (or similar relevant sub), hello")).toBe(true);
    expect(detectPlaceholderText("Visit us (insert city here) today")).toBe(true);
    expect(detectPlaceholderText("Big news [INSERT DATE] for launches")).toBe(true);
    expect(detectPlaceholderText("[TODO: punch this up]")).toBe(true);
    expect(detectPlaceholderText("lorem ipsum dolor sit amet")).toBe(true);
    // Ordinary parentheticals and brackets are not scaffolding.
    expect(detectPlaceholderText("We answer calls 24/7 (yes, weekends too).")).toBe(false);
    expect(detectPlaceholderText("Our stack [Postgres, LiveKit] is boring on purpose.")).toBe(false);
  });

  it("fails a render carrying placeholder text", () => {
    const draft = draftWith(
      [render({ platform: "linkedin", content: "Great for teams (insert your industry) everywhere." })],
      [image()],
    );
    const issues = deterministicChecks(draft);
    const hit = issues.find((i) => i.code === "placeholder-text");
    expect(hit?.severity).toBe("fail");
    expect(hit?.platform).toBe("linkedin");
    // A rewrite can fix it, so the repair loop is allowed to try.
    expect(isTextFixable(hit!)).toBe(true);
  });

  it("fails a Reddit render that greets a different subreddit than it targets", () => {
    const draft = draftWith(
      [
        render({
          platform: "reddit",
          title: "We built an AI receptionist",
          content: "Hey r/SaaS, I build District AI at Acmebrands.",
          subreddit: "acmebrands",
        }),
      ],
      [image()],
    );
    const issues = deterministicChecks(draft);
    const hit = issues.find((i) => i.code === "reddit-wrong-subreddit");
    expect(hit?.severity).toBe("fail");
    expect(hit?.message).toContain("r/SaaS");
    expect(hit?.message).toContain("r/acmebrands");
  });

  it("accepts a Reddit greeting that matches the target", () => {
    const draft = draftWith(
      [
        render({
          platform: "reddit",
          title: "We built an AI receptionist",
          content: "Hey r/acmebrands, quick build update.",
          subreddit: "acmebrands",
        }),
      ],
      [image()],
    );
    const issues = deterministicChecks(draft);
    expect(issues.some((i) => i.code === "reddit-wrong-subreddit")).toBe(false);
  });
});

/**
 * ⛔ THE VIDEO GATES NOW READ THE TRANSPORT THAT WILL PUBLISH, NOT ONLY SPECS.
 *
 * `maxVideoBytes`/`maxVideoSec` were declared on six transports and consumed by
 * nothing: qa.ts read `SPECS[p]` alone, and `fitForTransport` — the only other
 * consumer of `channelRules()` — cannot act on video, because media-fit.ts
 * refuses to re-encode it. Three transports wrote that gap down as a comment and
 * predicted nobody would close it; it stayed open for fifteen days.
 *
 * They are production-read as of 2026-08-20, on the same rule `too-many-images`
 * and `image-too-large` already used: the ROUTED transport's figure when it has
 * one, SPECS as the fallback for a platform nothing routes. `fittingRules` is
 * the seam because it only carries genuinely-routed platforms, so an
 * aggregator-routed platform is measured against the AGGREGATOR's ceiling — the
 * one the post will actually meet.
 */
describe("video gates source their ceiling from the routed transport", () => {
  /** twitter's SPECS are 1200s / 8GB (post video, since 2026-09-17); these are deliberately tighter. */
  function tighterThanSpecs(): ReadonlyMap<Platform, TransportChannelRules> {
    return new Map<Platform, TransportChannelRules>([
      ["twitter", { maxLength: 280, countMode: "weighted", maxVideoSec: 60, maxVideoBytes: 100 * 1024 * 1024 }],
    ]);
  }

  it("fails a video the transport refuses even though SPECS would have passed it", () => {
    // 90s is inside X's own 1200s ceiling, so with SPECS as the only record this
    // draft published and was rejected by the vendor instead.
    const draft = draftWith(
      [render({ platform: "twitter", content: "Clip", mediaIndices: [0] })],
      [video({ durationSec: 90 })],
    );

    const bySpecsAlone = deterministicChecks(draft).find((i) => i.code === "video-too-long");
    expect(bySpecsAlone).toBeUndefined();

    const issue = deterministicChecks(draft, null, tighterThanSpecs()).find(
      (i) => i.code === "video-too-long",
    );
    expect(issue).toMatchObject({ severity: "fail", platform: "twitter" });
    // Both numbers are named, so the operator is not left wondering why a limit
    // they can read on X's own docs is not the one being applied.
    expect(issue!.message).toContain("60s");
    expect(issue!.message).toContain("1200s");
  });

  it("passes a video exactly AT the transport's duration ceiling", () => {
    // The comparison is strictly greater-than. An off-by-one here refuses a post
    // the vendor would have taken, which is the failure operators force past.
    const draft = draftWith(
      [render({ platform: "twitter", content: "Clip", mediaIndices: [0] })],
      [video({ durationSec: 60 })],
    );
    expect(
      deterministicChecks(draft, null, tighterThanSpecs()).find((i) => i.code === "video-too-long"),
    ).toBeUndefined();
  });

  it("fails a video over the transport's byte ceiling and passes one exactly at it", () => {
    const over = draftWith(
      [render({ platform: "twitter", content: "Clip", mediaIndices: [0] })],
      [video({ size: 150 * 1024 * 1024, path: "/tmp/heavy.mp4" })],
    );
    expect(deterministicChecks(over).find((i) => i.code === "video-too-large")).toBeUndefined();

    const issue = deterministicChecks(over, null, tighterThanSpecs()).find(
      (i) => i.code === "video-too-large",
    );
    expect(issue).toMatchObject({ severity: "fail", platform: "twitter" });
    expect(issue!.message).toContain("heavy.mp4");
    expect(issue!.message).toContain("100MB");

    const atLimit = draftWith(
      [render({ platform: "twitter", content: "Clip", mediaIndices: [0] })],
      [video({ size: 100 * 1024 * 1024 })],
    );
    expect(
      deterministicChecks(atLimit, null, tighterThanSpecs()).find((i) => i.code === "video-too-large"),
    ).toBeUndefined();
  });

  it("falls back to SPECS for a platform that is routed but declares no video limits", () => {
    // bluesky declares maxImageBytes and nothing about video, so SPECS' 180s and
    // 100MB (the app's own limits since 2026-09-17; 60s / 50MB were the 2024
    // launch figures) stay operative. An absent transport figure must not read
    // as "no limit" — that is the dark-gate failure
    // specs-transport-drift.test.ts exists to prevent.
    const routedButSilent = new Map<Platform, TransportChannelRules>([
      ["bluesky", { maxLength: 300, countMode: "grapheme", maxImageBytes: 2_000_000 }],
    ]);
    const draft = draftWith(
      [render({ platform: "bluesky", content: "Clip", mediaIndices: [0] })],
      [video({ durationSec: 240, size: 150 * 1024 * 1024, path: "/tmp/long.mp4" })],
    );

    const issues = deterministicChecks(draft, null, routedButSilent);
    expect(issues.find((i) => i.code === "video-too-long")).toMatchObject({
      severity: "fail",
      platform: "bluesky",
    });
    expect(issues.find((i) => i.code === "video-too-long")!.message).toContain("max 180s");
    expect(issues.find((i) => i.code === "video-too-large")).toMatchObject({ severity: "fail" });
  });

  it("uses the transport's LOOSER figure without pretending SPECS still applies", () => {
    // The transport wins in both directions, deliberately: it is the contract
    // the publish path enforces. The message drops the comparison when the
    // transport is not the narrower of the two, because "X allows 1200s" would
    // then read as the refusal rather than the allowance.
    const looser = new Map<Platform, TransportChannelRules>([
      ["twitter", { maxLength: 280, countMode: "weighted", maxVideoSec: 1500 }],
    ]);
    const draft = draftWith(
      [render({ platform: "twitter", content: "Clip", mediaIndices: [0] })],
      [video({ durationSec: 1600 })],
    );
    const issue = deterministicChecks(draft, null, looser).find((i) => i.code === "video-too-long");
    expect(issue!.message).toBe("video is 1600s (max 1500s)");

    const under = draftWith(
      [render({ platform: "twitter", content: "Clip", mediaIndices: [0] })],
      [video({ durationSec: 1300 })],
    );
    expect(
      deterministicChecks(under, null, looser).find((i) => i.code === "video-too-long"),
    ).toBeUndefined();
  });
});

/**
 * Threads refuses a post with more than five links outright (Dec 2025 change,
 * see PlatformSpec.maxLinks), so QA must fail it before the vendor does.
 */
describe("too-many-links", () => {
  const link = (n: number) => `https://acmebrands.com/p/${n}`;

  it("fails a Threads body carrying six links, with the recommended fix attached", () => {
    const content = [1, 2, 3, 4, 5, 6].map(link).join(" ");
    const issue = deterministicChecks(draftWith([render({ platform: "threads", content })])).find(
      (i) => i.code === "too-many-links",
    );
    expect(issue).toMatchObject({
      severity: "fail",
      platform: "threads",
      message: "6 links in the body; Threads refuses a post with more than 5",
      fix: "Keep one canonical link in the body and move the rest to a reply.",
    });
  });

  it("allows exactly five", () => {
    const content = [1, 2, 3, 4, 5].map(link).join(" ");
    const issues = deterministicChecks(draftWith([render({ platform: "threads", content })]));
    expect(issues.some((i) => i.code === "too-many-links")).toBe(false);
  });
});

/**
 * A review that never happened must not
 * read as a clean draft. `pass` is the gate autopilot (step 5) and the digest's
 * email approve both check, so an unavailable review fails it; a human can still
 * publish by re-running QA or force-approving, which is the path that already
 * exists for every other blocker.
 */
describe("an LLM review that never happened", () => {
  beforeEach(() => vi.clearAllMocks());

  /** Deterministically clean (the fixture "pass is true only when..." uses), so the review is the only variable. */
  const cleanDraft = () =>
    draftWith(
      [render({ platform: "bluesky", content: "We shipped the French portal.", mediaIndices: [0] })],
      [image({ altText: "A branded card" })],
    );

  it("fails QA on an otherwise clean draft, so no unattended path can publish it", async () => {
    genJsonMock.mockRejectedValue(new Error("Vertex 429 RESOURCE_EXHAUSTED"));
    const draft = cleanDraft();

    const report = await runQa(draft);

    expect(report.issues.map((i) => i.code)).toEqual(["llm-qa-unavailable"]);
    expect(report.pass).toBe(false);
    const issue = report.issues[0]!;
    expect(issue).toMatchObject({ severity: "fail", fixable: false });
    expect(issue.message).toContain("Vertex 429");
    // Says what a human can do about it, since no rewrite can.
    expect(issue.fix).toContain("force-approve");
    expect(isTextFixable(issue)).toBe(false);
    expect(isMechanicallyFixable(issue)).toBe(false);
  });

  it("passes the same draft once the reviewer answers", async () => {
    genJsonMock.mockResolvedValue({ issues: [], summary: "clean" });
    const draft = cleanDraft();

    const report = await runQa(draft);

    expect(report.pass).toBe(true);
    expect(report.issues).toEqual([]);
  });
});

describe("a LinkedIn body link", () => {
  const url = "https://acmebrands.com/fr";

  it("is reported but never stamped fixable, because no published placement avoids the penalty", async () => {
    // The mechanical pass leaves it in the body on purpose, and the transport
    // publishes no first comment, so "move it" has nowhere real to go.
    const draft = draftWith([render({ platform: "linkedin", content: `We shipped the French portal. ${url}` })]);

    const report = await runQa(draft, { skipLlm: true });
    const issue = report.issues.find((i) => i.code === "link-penalty")!;

    expect(issue).toMatchObject({ severity: "warn", platform: "linkedin", fixable: false });
    expect(issue.fix).not.toContain("first comment");
    expect(isTextFixable(issue)).toBe(false);
    expect(isMechanicallyFixable(issue)).toBe(false);
  });

  it("leaves X and Facebook body links fixable, where a reply or a sent first comment exists", async () => {
    const draft = draftWith([
      render({ platform: "twitter", content: `Shipped. ${url}` }),
      render({ platform: "facebook", content: `Shipped. ${url}` }),
    ]);

    const report = await runQa(draft, { skipLlm: true });
    const penalties = report.issues.filter((i) => i.code === "link-penalty");

    expect(penalties.map((i) => [i.platform, i.fixable])).toEqual([
      ["twitter", true],
      ["facebook", true],
    ]);
  });

  it("treats a platformless link-penalty as fixable, as before", () => {
    expect(isTextFixable({ severity: "warn", code: "link-penalty", message: "m", fix: "f" })).toBe(true);
  });
});

describe("a first comment on a platform that never publishes one", () => {
  it("warns that the text will not go out, and leaves the fix to the operator", () => {
    const draft = draftWith([
      render({ platform: "linkedin", content: "Body.", firstComment: "Read more: https://acmebrands.com/fr" }),
    ]);

    const issue = deterministicChecks(draft).find((i) => i.code === "first-comment-unpublished");

    expect(issue).toMatchObject({ severity: "warn", platform: "linkedin" });
    expect(issue!.message).toContain("LinkedIn");
    expect(isTextFixable(issue!)).toBe(false);
  });

  it("says nothing where the transport sends it", () => {
    const draft = draftWith([render({ platform: "facebook", content: "Body.", firstComment: "Read more." })]);
    expect(deterministicChecks(draft).some((i) => i.code === "first-comment-unpublished")).toBe(false);
  });
});

describe("em-dashes in what is actually published", () => {
  it("flags one in an X thread reply, which goes out as its own post", () => {
    const draft = draftWith([
      render({ platform: "twitter", content: "Root post.", threadItems: ["It handles Quebec law — and invoices in French."] }),
    ]);
    expect(deterministicChecks(draft).filter((i) => i.code === "brand-em-dash")).toHaveLength(1);
  });

  it("still flags the body and the title", () => {
    const body = draftWith([render({ platform: "bluesky", content: "Fast — reliable." })]);
    const title = draftWith([render({ platform: "reddit", content: "Body.", title: "Fast — reliable", subreddit: "saas" })]);
    expect(deterministicChecks(body).some((i) => i.code === "brand-em-dash")).toBe(true);
    expect(deterministicChecks(title).some((i) => i.code === "brand-em-dash")).toBe(true);
  });
});
