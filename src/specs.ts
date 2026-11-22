import { NO_BRAND, fillBrandPlaceholders, type BrandContext } from "./brand-context.js";
import { countUnit, measureLength } from "./length.js";
import type { CountMode } from "./transport.js";
import type { Platform } from "./types.js";
import { trimLeading, trimTrailing } from "./trim.js";

export interface PlatformSpec {
  platform: Platform;
  displayName: string;
  /** Hard limit for body/caption, in the unit named by `countMode`. */
  maxChars: number;
  /**
   * What `maxChars` is measured IN, and therefore how vendorLength counts.
   *
   * ⛔ REQUIRED, so a new platform cannot inherit a silently wrong unit. The
   * unit used to be implicit and uniform (UTF-16 code units for everyone,
   * plus a hardcoded special case for X), which meant a platform counting
   * anything else had no way to say so:
   *
   *   - YouTube's 5000 is BYTES. Declaring it as characters made the gate agree
   *     with the transport on ASCII and disagree on everything else — the
   *     number matched, so nothing looked wrong.
   *   - Bluesky's 300 is GRAPHEME CLUSTERS (the AT Protocol lexicon's
   *     `maxGraphemes`).
   *
   * Must equal the transport's own `channelRules().countMode`; enforced by
   * specs-transport-drift.test.ts.
   */
  countMode: CountMode;
  /** Approx chars visible before "see more" truncation in feed (mobile, conservative). */
  truncationPoint?: number;
  /** Hard cap on hashtags (platform-rejected/stripped beyond this). */
  maxHashtags?: number;
  /** [min, max] recommended hashtag count. */
  idealHashtags: [number, number];
  hashtagPlacement: "inline" | "end" | "firstComment" | "none";
  linksClickable: boolean;
  /**
   * What to do with a URL instead, when links are not clickable. Without this
   * the dead-link QA finding advised "link in bio" everywhere, which is
   * Instagram's remedy and wrong on Pinterest, where the destination URL is a
   * separate publish setting rather than something to work around.
   */
  linkAdvice?: string;
  /** Body links carry an algorithmic reach penalty on this platform. */
  linkPenalty?: string;
  /**
   * The first-comment workaround is penalized too, so moving a link there buys
   * nothing. Set on LinkedIn: as of 2026 the algorithm reads the comments
   * immediately and treats an author's link comment as "bridge behaviour",
   * applying the same reach hit as a body link. Anything that would relocate a
   * link must check this, or it pays the penalty twice and gains nothing.
   */
  firstCommentLinkPenalized?: boolean;
  requiresMedia: boolean;
  requiresVideo: boolean;
  /**
   * Whether OUR publish path for this platform can send a video: the
   * transport implements the upload, so a render that selects a video goes
   * out as a video post. The vendor accepting video is not enough; the
   * `maxVideo*` fields describe the vendor, this describes us.
   *
   * ⛔ THE ONE PLACE THAT DECISION LIVES. media-pick.ts routes a draft's video
   * to every platform where this is true (and never to one where it is
   * false), video-attach.ts re-points exactly these renders when a clip lands,
   * qa.ts fails a render that selects a video where this is false
   * (`video-unsupported`), and publish.ts refuses that leg before any network
   * call. A transport that gains a video upload flips this and nothing else.
   * `requiresVideo` implies it (specs.test.ts pins that).
   */
  publishesVideo: boolean;
  maxImages?: number;
  mixedMediaAllowed: boolean;
  maxImageBytes?: number;
  maxVideoBytes?: number;
  maxVideoSec?: number;
  /**
   * Hard cap on URLs in the body, where the vendor refuses the post beyond it.
   * Threads is the reason it exists: since 2025-12-22 a text post with more
   * than 5 links fails with THREADS_API__LINK_LIMIT_EXCEEDED (Threads API
   * changelog; developers.facebook.com/docs/threads/posts, read 2026-09-17).
   * QA's `too-many-links` gate reads this; absent means no vendor cap known.
   */
  maxLinks?: number;
  titleMaxChars?: number;
  titleRequired: boolean;
  supportsFirstComment: boolean;
  supportsThreads: boolean;
  threadItemMaxChars?: number;
  /** Guidance lines injected into the formatter/QA prompts. */
  notes: string[];
}

const MB = 1024 * 1024;

/*
 * Numbers a platform's prompt notes quote, held once so a note cannot drift
 * from the field it describes (it did: Threads, Bluesky and Pinterest notes
 * all quoted figures the fields had since moved past).
 */
const THREADS_MAX_CHARS = 500;
const BLUESKY_VIDEO_BYTES = 100 * MB;
const BLUESKY_VIDEO_SEC = 180;
const PINTEREST_MAX_CHARS = 800;
const TIKTOK_MAX_CHARS = 2200;

/**
 * Limits and best practices as of 2026-07. Verified values and provenance:
 * see scripts/social/platform-reference.md (researched 2026-07-19).
 * Notable 2026 changes baked in: Instagram hashtag cap is now 5 (was 30),
 * Facebook caps non-verified pages at ~2 body-link posts/month, LinkedIn's
 * first-comment link workaround is also penalized, X body links are heavily
 * suppressed (put links in a reply), YouTube strips ALL hashtags beyond 15,
 * Bluesky counts full URL length via API (no automatic shortening).
 *
 * Threads' 500-char cap is not researched; it was taken from the Postiz
 * aggregator's reported channel schema. That aggregator is deleted, so the
 * authority the publish call is validated against is now
 * threads-transport.ts's channelRules(), which independently declares 500 —
 * the value agrees, only its provenance changed.
 *
 * ⚠️ THIS FILE IS THE FALLBACK, NOT THE AUTHORITY. Since the aggregator was
 * removed, the live snapshot QA measures against (channel-rules.ts's
 * fetchChannelRules) is built from the registered transports' channelRules().
 * But it only carries a platform that is BOTH connected AND routed direct — so
 * for anything switched Off, SPECS.maxChars silently becomes the operative cap
 * again. That is exactly how the Reddit and Pinterest entries below drifted
 * unnoticed: their transports had the right numbers, their specs did not, and
 * nothing compared the two. specs-transport-drift.test.ts now does.
 */
export const SPECS: Record<Platform, PlatformSpec> = {
  instagram: {
    platform: "instagram",
    displayName: "Instagram",
    countMode: "utf16",
    maxChars: 2200,
    truncationPoint: 125,
    maxHashtags: 5,
    idealHashtags: [3, 5],
    hashtagPlacement: "end",
    linksClickable: false,
    requiresMedia: true,
    requiresVideo: false,
    publishesVideo: true,
    maxImages: 10,
    mixedMediaAllowed: false,
    // ⚠️ NOT the help-centre figures (30 MB / 4 GB / no duration), which
    // describe the app. The Content Publishing API's own reference
    // (developers.facebook.com/docs/instagram-platform/instagram-graph-api/
    // reference/ig-user/media, read 2026-09-17) is what the publish call is
    // validated against: image "File size: 8 MB maximum", Reels "300MB
    // maximum", "15 mins maximum, 3 seconds minimum". The old figures
    // over-permit, so an oversized asset would fail at Meta instead of at QA.
    maxImageBytes: 8 * MB,
    maxVideoBytes: 300 * MB,
    maxVideoSec: 900,
    titleRequired: false,
    supportsFirstComment: true,
    supportsThreads: false,
    notes: [
      "HASHTAG CAP IS 5 (Dec 2025 change, caption + comments combined). Use up to 5 highly specific niche tags in the CAPTION (captions are search-indexed; first-comment placement gives no advantage anymore).",
      "Links in captions are NOT clickable; use 'link in bio' phrasing, never a bare URL expecting clicks.",
      "First ~125 chars show before '...more' — front-load the hook, then blank-line paragraph breaks.",
      "B2B sweet spot: tight 400-900 char captions, 2-4 short paragraphs, 1-3 emoji as visual breaks.",
      "Carousels up to 10 items (images or videos, not mixed). Reels over 3 minutes are throttled to non-followers; keep discovery Reels short.",
      "End with ONE clear CTA ('Link in bio', 'Save this', 'Comment X').",
      "No engagement bait ('like if you agree', 'tag a friend') — Meta demotes it.",
    ],
  },
  facebook: {
    platform: "facebook",
    displayName: "Facebook",
    countMode: "utf16",
    maxChars: 63206,
    truncationPoint: 125,
    idealHashtags: [0, 2],
    hashtagPlacement: "inline",
    linksClickable: true,
    linkPenalty:
      "non-verified Pages get ~2 organic body-link posts/month before near-zero reach; there is no cap on links in comments",
    requiresMedia: false,
    requiresVideo: false,
    publishesVideo: true,
    // Page Reels (facebook-transport.ts): "Duration 3 to 90 seconds",
    // the Reels Publishing API guide. The transport's channelRules() declares the same.
    maxVideoSec: 90,
    maxImages: 10,
    mixedMediaAllowed: false,
    // ⚠️ NOT 30 MB (help-centre prose). The transport posts
    // through the Page /photos edge, whose reference says "Files can not exceed
    // 10MB" (developers.facebook.com/docs/graph-api/reference/page/photos, read
    // 2026-09-17), so that is the figure a publish is actually held to.
    maxImageBytes: 10 * MB,
    maxVideoBytes: 4 * 1024 * MB,
    titleRequired: false,
    supportsFirstComment: true,
    supportsThreads: false,
    notes: [
      "2026 RULE: non-Meta-Verified Pages are limited to ~2 organic posts with body links per MONTH before reach collapses. Default: put the link in firstComment, keep the body link-free. Save body links for major launches.",
      "Posts under ~80 chars get the highest engagement; ~125 chars visible on mobile before 'See more'.",
      "Hashtags carry little weight: 0-2 inline max, never a wall.",
      "Conversational community tone; native image/video beats link posts; questions drive comments.",
      "Cannot mix videos and images in one post.",
      "No engagement bait — same Meta classifier as Instagram.",
    ],
  },
  threads: {
    platform: "threads",
    displayName: "Threads",
    countMode: "utf16",
    maxChars: THREADS_MAX_CHARS,
    truncationPoint: 140,
    maxHashtags: 1,
    idealHashtags: [0, 1],
    hashtagPlacement: "inline",
    linksClickable: true,
    requiresMedia: false,
    requiresVideo: false,
    publishesVideo: true,
    maxImages: 20,
    // Threads carousels accept images and videos as children in the same post,
    // unlike Instagram/Facebook. Postiz's provider passes children straight
    // through (createCarouselContent), so mixing is safe here.
    mixedMediaAllowed: true,
    maxImageBytes: 8 * MB,
    // 1 GB / 300 s, now VENDOR-STATED rather than assumed: the Threads posts
    // page (read 2026-09-17) says "1 GB" and "300 seconds (5 minutes) maximum".
    maxVideoBytes: 1024 * MB,
    maxVideoSec: 300,
    // "The number of links is restricted to 5 or less"; more than 5 has been a
    // hard API error since 2025-12-22 (Threads changelog). See PlatformSpec.
    maxLinks: 5,
    titleRequired: false,
    // Both map to the same underlying mechanism on Threads: value[1..] is
    // posted as a reply via the provider's comment() path (reply_to_id).
    supportsFirstComment: true,
    supportsThreads: true,
    threadItemMaxChars: THREADS_MAX_CHARS,
    notes: [
      `${THREADS_MAX_CHARS} chars max per post and per reply. Replies chain into a thread, so long-form goes in thread items rather than a truncated single post.`,
      `At most 5 links per post; the API refuses a sixth outright (Dec 2025 change). Meta charges each emoji its UTF-8 bytes (up to 4) toward the ${THREADS_MAX_CHARS}, more than the character count shows, so keep emoji sparse in a post near the cap.`,
      "ONE topic tag per post — Threads surfaces a single tag, so extra hashtags are dead weight. Prefer zero and let the copy carry the topic.",
      "Links are clickable and unfurl to a card. Keep the canonical URL short; no UTM soup in the visible text.",
      "Audience overlaps Instagram but the register is text-first and conversational, closer to Bluesky than to IG. Build-in-public notes, opinions, and short technical takes land; polished brand copy does not.",
      "First ~140 chars carry the post in-feed — front-load the hook.",
      "No engagement bait — same Meta classifier as Instagram and Facebook demotes it.",
      "Media is optional. Carousels take up to 20 items and MAY mix images and video.",
    ],
  },
  twitter: {
    platform: "twitter",
    displayName: "X / Twitter",
    countMode: "weighted",
    maxChars: 280,
    // 280 free, 25,000 on Premium. The number here is the FREE floor; the live
    // channel-rules cap overrides it where the account has more (this one does),
    // which is why the trim reads effectiveMaxChars rather than this.
    // The fold stays 280 either way: a long post shows its first 280 characters
    // in the timeline behind a "Show more", so the hook has to land inside that
    // however long the post is allowed to be.
    truncationPoint: 280,
    idealHashtags: [0, 2],
    hashtagPlacement: "inline",
    linksClickable: true,
    linkPenalty:
      "severe body-link suppression (30-94% reach loss in 2026 testing); put the link in a reply/thread item instead",
    requiresMedia: false,
    requiresVideo: false,
    publishesVideo: true,
    maxImages: 4,
    mixedMediaAllowed: false,
    maxImageBytes: 5 * MB,
    // ⚠️ NOT 512 MB / 140 s, which is X's DIRECT-MESSAGE video limit, not the
    // post limit. docs.x.com/changelog (Sep 1 2026 entry, read
    // 2026-09-17): posts on default accounts take video up to 20 minutes and
    // 8 GB (Premium 125 minutes / 16 GB); DM video stays at 140 s / 512 MB.
    // The transport publishes video through x.ts's chunked upload
    // (publishesVideo above); assertNoUnsupportedMedia refuses only the shapes
    // X itself refuses (more than one video/GIF, or video beside images).
    maxVideoBytes: 8 * 1024 * MB,
    maxVideoSec: 1200,
    titleRequired: false,
    supportsFirstComment: false,
    supportsThreads: true,
    threadItemMaxChars: 280,
    notes: [
      "280 chars per tweet (free tier). Any URL counts as a flat 23 chars.",
      "CRITICAL: body links are heavily reach-suppressed. Keep the root tweet link-free and put the URL in a second thread item (acts as the first reply). Since April 2026 a post containing a URL also costs more on pay-per-use ($0.20 versus $0.015), so one link reply per post, not one per idea.",
      "Punchy, direct, opinionated; 0-2 inline hashtags max — hashtag stacks read as spam.",
      "Threads are the strong format for technical/B2B content; the first tweet must hook alone.",
      "Up to 4 images (5MB each) or 1 video (20 min / 8 GB on a default account; the 140 s figure is for DMs).",
    ],
  },
  linkedin: {
    platform: "linkedin",
    displayName: "LinkedIn",
    countMode: "utf16",
    maxChars: 3000,
    truncationPoint: 140,
    idealHashtags: [3, 5],
    hashtagPlacement: "end",
    linksClickable: true,
    linkPenalty:
      "~60% reach loss for body links, and the first-comment workaround is penalized JUST AS HEAVILY (2026: the algorithm reads comments immediately and treats an author link comment as bridge behaviour), so there is no free placement",
    firstCommentLinkPenalized: true,
    requiresMedia: false,
    requiresVideo: false,
    publishesVideo: false,
    maxImages: 20,
    mixedMediaAllowed: false,
    titleRequired: false,
    supportsFirstComment: true,
    supportsThreads: false,
    notes: [
      "~140 chars visible on mobile before '...see more'. A paragraph break (two newlines) ENDS the visible snippet early — keep the hook as ONE unbroken paragraph.",
      "Body links cost ~60% reach AND the first-comment trick is now detected/penalized too. Default: post the substance natively with no link; accept the penalty only for major CTAs.",
      "Dwell time is the primary ranking signal — substantive posts that hold attention win. Comments weigh ~15x likes: end with a discussion question, not 'like this'.",
      "Founder/practitioner voice outperforms corporate voice. Professional but human; short paragraphs after the hook.",
      "3-5 hashtags at the END (end-placed tags do not eat the visible snippet).",
      "Document/PDF carousels are the highest-engagement format for B2B; native video also rewarded.",
    ],
  },
  youtube: {
    platform: "youtube",
    displayName: "YouTube",
    countMode: "utf8bytes",
    maxChars: 5000,
    truncationPoint: 157,
    maxHashtags: 15,
    idealHashtags: [2, 3],
    hashtagPlacement: "end",
    linksClickable: true,
    requiresMedia: true,
    requiresVideo: true,
    publishesVideo: true,
    mixedMediaAllowed: false,
    // ⛔ THESE WERE ABSENT, WHICH SILENTLY DISABLED TWO QA GATES.
    //
    // `video-too-long` and `video-too-large` in qa.ts are both guarded by
    // `if (s.maxVideoSec)` / `if (s.maxVideoBytes)`, reading THIS object. With
    // neither set, YouTube was the one platform requiring video and the one
    // platform whose video was never checked, so an oversized or over-long
    // upload only failed at the far end after the bytes had been sent.
    //
    // ⚠️ And they read SPECS, not `DirectTransport.channelRules()`. A transport
    // declaring real limits does NOT light these gates — that wiring does not
    // exist yet and is P6 work (driving QA from channelRules once the
    // aggregator's live rules feed is gone). Until then, a limit has to be in
    // BOTH places to be both enforced and checked.
    //
    // 256GB is the vendor's real ceiling (the discovery document's
    // `mediaUpload.maxSize`), so nothing this pipeline can produce will trip it
    // — that is honest rather than useless: inventing a smaller number would
    // reject uploads YouTube would have accepted.
    maxVideoBytes: 274_877_906_944,
    // 900s is the limit for an UNVERIFIED account. A verified channel goes to
    // 12 hours, so this is the conservative reading and may need raising once
    // the channel's verification status is known. Veo clips are 8 seconds, so
    // it is generous for everything this pipeline generates today.
    maxVideoSec: 900,
    titleMaxChars: 100,
    titleRequired: true,
    supportsFirstComment: true,
    supportsThreads: false,
    notes: [
      "Requires a video. Title <= 100 chars but only ~70 show in search tiles (~40 on Shorts shelf) — strongest keyword/hook first.",
      "Description: first ~157 chars show above the fold — hook + product link early, then keywords/timestamps.",
      "HASHTAGS: hard cap 15 — exceeding it strips ALL of them. Use 2-3 in the description; the first 3 display as chips on Shorts.",
      "Tags field (separate from hashtags): max 500 chars combined.",
      "Shorts (<=3 min, vertical) get far more feed distribution than long-form in 2026; B2B ladder = Shorts for awareness, mid-form for consideration.",
      "Description links are normal and expected (no penalty).",
    ],
  },
  reddit: {
    platform: "reddit",
    displayName: "Reddit",
    countMode: "utf16",
    // 40,000, matching reddit-transport.ts's channelRules(). ⚠️ [unverified] —
    // and deliberately recorded as such rather than dressed up.
    //
    // Reddit publishes NO body-length figure anywhere in its API documentation.
    // Both plausible sources were checked on 2026-08-05:
    //   - POST /api/submit's parameter table describes `text` only as "raw
    //     markdown text". It gives a figure for `title` ("up to 300 characters
    //     long") and for `flair_text`/`flair_id`, so the omission on `text` is
    //     conspicuous rather than accidental.
    //   - GET /api/v1/{subreddit}/post_requirements, which does return
    //     `title_text_max_length`/`title_text_min_length`, has NO body-length
    //     counterpart. Its only body field is `body_restriction_policy`
    //     ("required"/"notAllowed"/"none").
    // So 40,000 is the best available guard and cannot currently be upgraded to
    // vendor-verified by reading docs. Only a live over-length submission would
    // settle it, and Reddit is Off.
    //
    // ⚠️ Was 10,000, justified here as "we publish THROUGH Postiz, whose Reddit
    // channel reports 10,000 and enforces it". Postiz has been DELETED, so that
    // sentence stopped being true and the number lost the only thing that made
    // it the operative limit. Same defect as the Pinterest entry below: a value
    // whose justification names a system that no longer exists.
    maxChars: 40000,
    idealHashtags: [0, 0],
    hashtagPlacement: "none",
    linksClickable: true,
    requiresMedia: false,
    requiresVideo: false,
    publishesVideo: false,
    maxImages: 20,
    mixedMediaAllowed: false,
    maxImageBytes: 20 * MB,
    maxVideoBytes: 1024 * MB,
    maxVideoSec: 900,
    titleMaxChars: 300,
    titleRequired: true,
    supportsFirstComment: false,
    supportsThreads: false,
    notes: [
      "ZERO hashtags, ZERO marketing voice — Reddit punishes ad-speak brutally. Write as a builder/founder sharing genuinely useful info and ALWAYS disclose affiliation.",
      "Title cap is 300 chars but 60-80 chars performs best: specific, honest, curiosity-driven.",
      "Prefer a text (self) post with the link in context over a bare link post — better discussion, less spam-flagging.",
      "90/10 rule: ~9 genuine contributions per 1 promotional post. Never cross-post identical promo to multiple subreddits.",
      "Subreddit fit for {brand}: r/SaaS and r/indiehackers tolerate build-in-public updates with metrics/lessons; r/startups and r/Entrepreneur restrict promo to weekly threads; technical subs (r/sysadmin etc.) only via genuinely technical writeups.",
      "Check the target subreddit's own rules (karma minimums, flair requirements) before posting.",
    ],
  },
  bluesky: {
    platform: "bluesky",
    displayName: "Bluesky",
    countMode: "grapheme",
    maxChars: 300,
    idealHashtags: [0, 2],
    hashtagPlacement: "inline",
    linksClickable: true,
    requiresMedia: false,
    requiresVideo: false,
    publishesVideo: false,
    maxImages: 4,
    mixedMediaAllowed: false,
    // 2,000,000 BYTES, and deliberately not `2 * MB`. VENDOR-VERIFIED
    // 2026-08-05 against the `app.bsky.embed.images` lexicon shipped in
    // @atproto/api 0.20.x (`maxSize: 2000000`, `accept: ["image/*"]`), the
    // schema Bluesky validates records against.
    //
    // ⚠️ Was `1 * MB`, which was both wrong and the wrong KIND of number. It
    // under-permitted by nearly half, needlessly blocking every image between
    // 1.0 and 1.9 MB, and MB here is 1,048,576 while the lexicon limit is a
    // round decimal 2,000,000 — so `2 * MB` would over-permit by 97,152 bytes
    // and fail at the vendor.
    //
    // ⛔ Do not "correct" this to Bluesky's advertised 5 MB. That is the PDS
    // TRANSPORT limit (`blobUploadLimit`, configurable per host); the lexicon
    // states plainly that blob restrictions are enforced when the RECORD is
    // created, not at upload — so uploadBlob accepting the bytes proves
    // nothing, and the post is what fails.
    maxImageBytes: 2_000_000,
    // ⚠️ NOT 50 MB / 60 s, the original 2024 launch limits.
    // The Bluesky app raised its own cap to 3 minutes / 100 MB
    // (bluesky-social/social-app PR #7916, merged 2025-03-06) and the
    // `app.bsky.embed.video` lexicon permits blobs up to 300,000,000 bytes with
    // no duration field at all. 100 MB / 180 s is the app's figure, the one a
    // human posting the same file would be held to; the lexicon's 300 MB is the
    // ceiling above it. These describe the VENDOR: Bluesky accepts video, but
    // our transport has no video upload (`app.bsky.embed.video` is never
    // built), so publishesVideo is false and a render that selects a video
    // fails QA and is refused by bluesky-transport.ts with a
    // PublishPreflightError rather than posting text-only.
    maxVideoBytes: BLUESKY_VIDEO_BYTES,
    maxVideoSec: BLUESKY_VIDEO_SEC,
    titleRequired: false,
    supportsFirstComment: false,
    supportsThreads: true,
    threadItemMaxChars: 300,
    notes: [
      "300 chars max (graphemes). URLs count at FULL length when posting via API — use the shortest canonical URL (e.g. {domain}, no UTM tags) and budget for it.",
      "Links are clickable and the first URL unfurls to a card; no known link reach penalty.",
      "Feed is chronological — no algorithm to game; plain-spoken, early-Twitter energy, dev-heavy audience.",
      "Build-in-public updates, changelogs, and technical notes land best; corporate polish does not.",
      `Up to 4 images (each under 2,000,000 bytes) OR 1 video (${BLUESKY_VIDEO_SEC}s/${BLUESKY_VIDEO_BYTES / MB}MB), never both. 0-2 inline hashtags.`,
      "Threads supported for longer content.",
    ],
  },
  pinterest: {
    platform: "pinterest",
    displayName: "Pinterest",
    countMode: "utf16",
    // 800. VENDOR-VERIFIED 2026-08-02 against Pinterest's own OpenAPI
    // description (github.com/pinterest/api-description, `PinCreate.description`
    // maxLength), and matched by pinterest-transport.ts's channelRules().
    //
    // ⚠️ NOT 500, which is one aggregator's narrower channel schema: a
    // middleman's cap is not the platform's, and copying it costs 300
    // characters of pin description. A number is only as good as the system
    // its provenance names.
    //
    // titleMaxChars 100, requiresMedia and maxImages 5 came from that same dead
    // schema and are left as-is: unlike maxChars they agree with Pinterest's own
    // OpenAPI, so they are correct values that merely have stale provenance. The
    // byte/duration limits below are NOT vendor-verified — Pinterest states them
    // in prose help-center pages, not in the schema's field constraints, so they
    // are guards, not contract. See scripts/social/platform-reference.md.
    maxChars: PINTEREST_MAX_CHARS,
    idealHashtags: [0, 0],
    hashtagPlacement: "none",
    // A URL inside the description is inert text on Pinterest. The clickable
    // destination is `settings.link`, which the publisher fills from the
    // draft's source link, so a URL in the copy is pure waste.
    linksClickable: false,
    linkAdvice:
      "the pin's destination URL is a separate field (taken from the draft's link), so drop the URL from the description",
    requiresMedia: true,
    requiresVideo: false,
    publishesVideo: false,
    maxImages: 5,
    // Deliberately true, and it does NOT mean "anything goes". Pinterest's one
    // legal mixed shape is a video plus its cover image, which the generic
    // mixed-media check would reject outright. The real rule (1-5 images, OR
    // exactly one video with exactly one cover) cannot be expressed in these
    // fields, so pinterestMediaShape() in qa.ts enforces it instead.
    mixedMediaAllowed: true,
    maxImageBytes: 20 * MB,
    maxVideoBytes: 2048 * MB,
    maxVideoSec: 900,
    titleMaxChars: 100,
    // The vendor schema requires only `board`, so a missing title cannot refuse
    // the pin and this stays false. It is still the single most valuable field
    // on Pinterest, which the notes and the formatter prompt both push for.
    titleRequired: false,
    supportsFirstComment: false,
    supportsThreads: false,
    notes: [
      "MEDIA IS MANDATORY: a pin with no image or video cannot be created. Pinterest is an image-first surface, so the visual carries the post.",
      `The feed shows the IMAGE and the title, not the description. Put the hook in the title (<=100 chars) and treat the ${PINTEREST_MAX_CHARS}-char description as secondary context and keywords.`,
      "Tall 2:3 images (1000x1500) are the native format; square works, landscape gets cropped badly in feed.",
      "ZERO hashtags. Pinterest deprecated them: they are not clickable and carry no ranking weight, so they only eat description space.",
      "Pinterest is a SEARCH engine, not a social feed. Write plain keyword-rich copy describing what the image shows and what the reader gets, not conversational build-in-public voice.",
      "URLs in the description are dead text. The destination link is a separate publish field, so never spend description characters on one.",
      "Every pin needs a destination board, and the board is chosen by id, not name.",
      "Video pins need TWO attachments: the video and a separate cover image, and only one video per pin.",
      "Pins have a long tail (months, not hours), so evergreen explainer content outperforms time-bound announcements.",
    ],
  },
  tiktok: {
    platform: "tiktok",
    displayName: "TikTok",
    // Two routes, one set of figures: tiktok-transport.ts (our own TikTok API
    // for Business app, direct once connected) declares the same 2,200 UTF-16
    // caption, 1 GB and 600 s, checked by specs-transport-drift.test.ts, and
    // Zernio's own documented caption cap (zernio-aggregator.ts RULES) matches
    // while it still holds the route.
    countMode: "utf16",
    maxChars: TIKTOK_MAX_CHARS,
    // The caption overlays the video and folds after roughly two lines on a
    // phone [training], so the hook has to land in the first line.
    truncationPoint: 100,
    idealHashtags: [3, 5],
    hashtagPlacement: "end",
    linksClickable: false,
    linkAdvice: "a URL in a TikTok caption is plain text, so point to the link in the profile instead",
    requiresMedia: true,
    requiresVideo: true,
    // Both routes hand TikTok a public video URL: our transport's `video_url`,
    // Zernio's `mediaItems`.
    publishesVideo: true,
    mixedMediaAllowed: false,
    // "The maximum video size is 1 GB" (TikTok API for Business, Publish a
    // public video post doc), declared as 10^9 bytes, the
    // smaller reading. No maxImageBytes: the payload is a video (UNDECLARED in
    // specs-transport-drift.test.ts).
    maxVideoBytes: 1_000_000_000,
    // "the maximum video duration is 600 seconds" (same doc), the most any
    // account gets. The real cap is per account (`max_video_post_duration_sec`
    // from /business/video/settings/), which can be shorter.
    maxVideoSec: 600,
    titleRequired: false,
    supportsFirstComment: false,
    supportsThreads: false,
    notes: [
      "VIDEO ONLY: a TikTok post is one vertical video with a caption. No video, no post.",
      `Caption up to ${TIKTOK_MAX_CHARS} chars, but it sits over the video and folds after about two lines, so the first line is the hook and must work alone.`,
      "Write like a person talking to camera: short, plain, specific. Corporate polish reads as an ad and gets scrolled past.",
      "3-5 hashtags at the END of the caption; they are clickable and feed TikTok search. Mix one broad tag with specific ones.",
      "Links in captions are NOT clickable. Never put a URL in the caption; point to the link in the profile instead.",
      "Every post is labelled as promoting our own business (TikTok's Brand organic disclosure), so the copy must not pretend to be anything else.",
    ],
  },
};

export function specFor(platform: Platform): PlatformSpec {
  return SPECS[platform];
}

/**
 * The length the VENDOR will charge, which is the only count that can refuse a
 * post. Measured in the platform's declared unit (PlatformSpec.countMode) by
 * length.ts, which the composer shares so the two cannot drift.
 *
 * Measures the raw string. It used to port Postiz's validator (HTML-escape,
 * then `String.length`, and for X `max(weighted, raw)`), which charged `&` as
 * 5, a non-breaking space as 6 and a UTM-stamped link at full length on X.
 * No live transport serializes HTML, so those posts were trimmed and failed by
 * QA when every vendor would have accepted them.
 */
export function vendorLength(platform: Platform, content: string): number {
  return measureLength(content, SPECS[platform].countMode);
}

/**
 * The platforms whose direct transport actually sends `firstComment`:
 * facebook-transport.ts and instagram-transport.ts post it as a comment, and
 * threads-transport.ts `chainItems` appends it to the reply chain. NOT the
 * same as `supportsFirstComment`: LinkedIn and YouTube declare it but their
 * transports drop it. Pinned against each transport by sent-contents.test.ts
 * (through publish.ts `sentValues`).
 *
 * Lives here, not in publish.ts, because the prompts (specBlock) and the fix
 * pass have to tell the model the same thing the publisher does: a prompt that
 * said "firstComment supported" for LinkedIn is how a LinkedIn link was moved
 * into a field that never goes out.
 */
export const SENDS_FIRST_COMMENT: ReadonlySet<Platform> = new Set<Platform>(["facebook", "instagram", "threads"]);

/**
 * Where a reach-penalized body link can move to and still be published without
 * the same penalty: a reply where the platform threads, otherwise a first
 * comment its transport sends and the platform does not penalize. `null` means
 * nowhere, which is LinkedIn: its first comment is penalized as heavily as a
 * body link AND is never sent, so the link stays in the body.
 *
 * The one rule the mechanical fix pass and QA's fixability stamp both read, so
 * the Fix button cannot promise a move the fixer will not make.
 */
export function linkDestination(platform: Platform): "thread" | "firstComment" | null {
  const s = SPECS[platform];
  if (s.supportsThreads) return "thread";
  return SENDS_FIRST_COMMENT.has(platform) && !s.firstCommentLinkPenalized ? "firstComment" : null;
}

/**
 * The platform rules a prompt carries. Notes are filled with the brand's
 * name and domain (fillBrandPlaceholders), so a brandless engine names none.
 */
export function specBlock(platforms: Platform[], brand: Pick<BrandContext, "brandName" | "linkDomains"> = NO_BRAND): string {
  return platforms
    .map((p) => {
      const s = SPECS[p];
      return [
        `### ${s.displayName} (platform id: "${p}")`,
        `- Hard limit: ${s.maxChars} ${countUnit(s.countMode)}${s.truncationPoint ? `; feed truncates at ~${s.truncationPoint} chars ("see more")` : ""}`,
        `- Hashtags: ideal ${s.idealHashtags[0]}-${s.idealHashtags[1]}, placement: ${s.hashtagPlacement}${s.maxHashtags ? `, hard cap ${s.maxHashtags}` : ""}`,
        `- Links clickable: ${s.linksClickable ? "yes" : "NO"}`,
        s.titleRequired ? `- Title REQUIRED (max ${s.titleMaxChars} chars)` : "",
        s.requiresVideo ? "- Requires a VIDEO" : s.requiresMedia ? "- Requires media" : "",
        // The formatter chooses mediaIndices, so it has to know where a video
        // can go: a video index on a platform that cannot publish one is a QA
        // fail, not a quiet text-only post.
        s.publishesVideo ? "" : "- Cannot publish video: never select a video index",
        s.supportsThreads
          ? `- Threads supported (${s.threadItemMaxChars} ${countUnit(s.countMode).split(" (")[0]}/item)`
          : "",
        // From the transport, not from supportsFirstComment: LinkedIn and
        // YouTube declare a first comment that their transports never send.
        SENDS_FIRST_COMMENT.has(p)
          ? "- firstComment supported"
          : s.supportsFirstComment
            ? "- firstComment is NOT published here: leave it empty and never move a link or anything else into it"
            : "",
        ...s.notes.map((n) => `- ${fillBrandPlaceholders(n, brand)}`),
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

/**
 * Reddit accepts "/r/name", "r/name" or a bare name from operators; Postiz's
 * provider strips a leading "/r/" and lowercases before submitting. Normalize to
 * the bare, lowercased name so what we store, show, QA and send all agree.
 *
 * Lives here (rather than next to the publisher) so the QA pass can share it
 * without importing the Postiz client.
 */
/**
 * `unknown` rather than `string | null | undefined`: the callers that matter most
 * are sanitizers reading a render off an unvalidated Json column, where the field
 * is genuinely of unknown type. The body already opens with a typeof guard, so
 * widening costs nothing and makes the function total — narrowing at each call
 * site instead just recreates the hand-rolled variants this replaced.
 */
export function normalizeSubreddit(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const bare = trimLeading(trimTrailing(input.trim().replace(/^\/?r\//i, ""), "/"), "/").toLowerCase();
  return bare || undefined;
}

/**
 * Filter arbitrary input down to known platform ids (deduped, order
 * preserved). Use at API boundaries where targets arrive from loosely
 * validated sources (request bodies, model tool args).
 */
export function sanitizePlatforms(input: unknown): Platform[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<Platform>();
  for (const v of input) {
    if (typeof v === "string" && v in SPECS) seen.add(v as Platform);
  }
  return [...seen];
}
