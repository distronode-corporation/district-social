/**
 * Every platform Social HQ can publish to. This is a PUBLISHING surface, not
 * a website's profile list: adding a platform here never advertises an
 * account anywhere.
 *
 * TikTok publishes directly through the operator's TikTok API for Business
 * app once it is connected, and through the Zernio aggregator until then (the
 * app's routing decides); unrouted, QA fails it as `no-route` like any other
 * platform.
 */
export const ALL_PLATFORMS = [
  "instagram",
  "facebook",
  "threads",
  "twitter",
  "linkedin",
  "youtube",
  "reddit",
  "bluesky",
  "pinterest",
  "tiktok",
] as const;

export type Platform = (typeof ALL_PLATFORMS)[number];

export interface MediaAsset {
  path: string;
  type: "image" | "video" | "gif" | "document";
  mimeType: string;
  size: number;
  width?: number;
  height?: number;
  durationSec?: number;
  url?: string;
  altText?: string;
  /**
   * Library asset id this was resolved from. Without it the composer cannot
   * map a draft's media back to library rows, so reopening the picker would
   * show an empty selection and confirming would REPLACE the existing media
   * instead of adding to it. Absent on media stored before this field existed.
   */
  assetId?: string;
  /**
   * True when a generative model made this asset (a Veo clip), read from the
   * SocialAsset's `genMeta.aiGenerated` by assetsToSourceMedia. A transport
   * reads it to set the platform's AI-content disclosure (Instagram's
   * `is_ai_generated`), so it has to ride on the draft's media: the transport
   * never sees the asset row. Absent means not known to be AI-made.
   */
  aiGenerated?: boolean;
}

export interface SourcePost {
  text: string;
  title?: string;
  hashtags: string[];
  link?: string;
  media: MediaAsset[];
  notes?: string;
}

export interface PlatformRender {
  platform: Platform;
  content: string;
  title?: string;
  firstComment?: string;
  /**
   * The REPLIES posted after `content`, in order. `content` is always the root
   * post and is never repeated here: the X, Bluesky and Threads transports and
   * the Zernio X thread all publish `content` first and then one reply per
   * item, so an item 0 equal to the body goes out as the opening post twice
   * (on X, Threads and Bluesky). Read it through `threadReplies`,
   * which drops such a leading copy from rows stored in that shape. Only the
   * platforms with `supportsThreads` send these; the rest ignore them.
   */
  threadItems?: string[];
  /**
   * BCP-47 language tags for the post's text, most-used first. Bluesky's
   * `app.bsky.feed.post` record takes up to three as `langs`, and language
   * feeds and per-user content-language filters read it: a French post with no
   * tag is invisible to a reader who filters to French. Other transports
   * ignore it today.
   */
  langs?: string[];
  /**
   * Threads only: also publish this post as a Story on the linked Instagram
   * account (`crossreshare_to_ig`). A free 24-hour Story per Threads post; the
   * Threads post is published even when the Story fails, and the transport logs
   * the vendor's SUCCESS/FAILED.
   */
  threadsCrossShareToIgStory?: boolean;
  /**
   * Instagram Reels only: publish as a Trial Reel, shown to non-followers first
   * (`trial_params.graduation_strategy`). MANUAL leaves graduation to the app;
   * SS_PERFORMANCE graduates it to followers automatically when it performs.
   * Ignored on an image post.
   */
  instagramTrialReel?: "MANUAL" | "SS_PERFORMANCE";
  /**
   * TikTok only: turn comments off on the video. Maps to the TikTok API for
   * Business `post_info.disable_comment`. Absent means false (comments on).
   */
  tiktokDisableComment?: boolean;
  /** TikTok only: `post_info.disable_duet`. Absent means false (Duet allowed). */
  tiktokDisableDuet?: boolean;
  /** TikTok only: `post_info.disable_stitch`. Absent means false (Stitch allowed). */
  tiktokDisableStitch?: boolean;
  /**
   * TikTok only: the "Brand organic" commercial-content disclosure, "promoting
   * yourself or your own business". Maps to `post_info.is_brand_organic`.
   * Absent means true: every post promotes the operator's own brand.
   */
  tiktokBrandOrganic?: boolean;
  subreddit?: string;
  /**
   * Reddit flair, when the target subreddit mandates one. Postiz submits
   * `flair.id` as the post's flair_id; the name is carried for display. Many
   * subreddits reject a post with no flair, so this is the difference between
   * publishable and not in those.
   */
  flair?: { id: string; name: string };
  /**
   * Pinterest destination board. Postiz's Pinterest schema REQUIRES
   * `settings.board` and its description says "board must be an id", so the id
   * is what gets sent. Shaped like `flair` for the same reason: operators pick
   * by name, the vendor wants an opaque id.
   *
   * `name` is optional and display-only. Stamping a saved default gives just an
   * id, and inventing `name: id` there would put a vendor id where the UI shows
   * a human label. Every message that needs real board names reads them from the
   * live boards lookup instead.
   */
  board?: { id: string; name?: string };
  /**
   * Pinterest only: the pin's click-through URL when tracking is on. It is the
   * post's `source.link` with the UTM parameters the /l/ redirect would append
   * for this draft's Pinterest link, stamped by the app. A pin carries the
   * destination itself rather than the /l/ short link because Pinterest blocks
   * or warns on redirecting links, so a pin's clicks are counted by GA4, not by its SocialLink.
   * `publishDestination` uses it only while it still points at `source.link`.
   */
  pinLink?: string;
  /**
   * Minutes Postiz waits before publishing this render's follow-up value (the
   * thread item or first comment) after the root post.
   *
   * 0 or absent means chain immediately, which is the ONLY behaviour verified
   * against the vendor and is already enough for "the link goes out as a comment
   * after the post". A nonzero value is deliberately hard to reach: a delayed
   * value's failure is unobservable, because Postiz exposes one state per post and
   * `value[1..]` has no separate representation anywhere we can read. So a root
   * that publishes while its delayed reply silently never lands is
   * indistinguishable from success. QA surfaces any nonzero value for that reason.
   */
  followupDelayMinutes?: number;
  mediaIndices: number[];
  platformSpecificData?: Record<string, unknown>;
  rationale?: string;
  /**
   * The model that wrote this version (format or revise pass). Absent on a
   * render written by hand, and on every render from before the stamp existed.
   * A hand edit
   * keeps it, like `rationale`.
   */
  generatedBy?: ModelStamp;
}

/**
 * Which model, at which effort, wrote a render or reviewed a draft, stamped
 * when it happened.
 */
export interface ModelStamp {
  model: string;
  effort: string;
}

/**
 * The replies a thread posts after its root, which is `threadItems` with a
 * leading copy of `content` dropped. A reply identical to the root is never
 * intended: it is a row stored in the whole-thread shape (root as item 0), and
 * sending it would publish the opening post twice. Compared trimmed, because
 * the formatter trims `content` and not the items. Every transport that sends
 * replies reads them through here, so such a row cannot double its root.
 *
 * Lives here rather than in publish.ts so the dashboard's client preview can
 * show the same chain without importing the publisher. Always a fresh array,
 * so a caller appending to it (Threads' chainItems) never writes to the render.
 */
export function threadReplies(r: Pick<PlatformRender, "content" | "threadItems">): string[] {
  const items = r.threadItems ?? [];
  const legacyRoot = items.length > 0 && items[0]!.trim() === r.content.trim();
  return items.slice(legacyRoot ? 1 : 0);
}

export type QASeverity = "fail" | "warn" | "info";

export interface QAIssue {
  severity: QASeverity;
  platform?: Platform;
  code: string;
  message: string;
  /** One concrete recommended action to resolve this issue. */
  fix?: string;
  /**
   * Whether the AI fix pass can resolve this by rewriting copy. Stamped by
   * runQa so the UI can decide whether to offer "Fix issues with AI" without
   * duplicating the server's rules. Undefined on reports stored before this
   * field existed.
   */
  fixable?: boolean;
  /**
   * What attaching media to the draft would resolve, when that (and not a
   * rewrite) is the actual remedy. Stamped by runQa for the same reason as
   * `fixable`: the composer can offer an inline "Add image" action without
   * re-deriving each platform's media rules on the client.
   */
  needsMedia?: "image" | "video";
}

export interface QAReport {
  ranAt: string;
  pass: boolean;
  issues: QAIssue[];
  llmSummary?: string;
  /**
   * The model that ran the LLM review. Absent when no review ran (skipped, or
   * it failed and blocked as llm-qa-unavailable), and on every report from
   * before the stamp existed.
   */
  reviewedBy?: ModelStamp;
}

export type DraftStatus =
  | "draft"
  | "approved"
  | "scheduled"
  | "published"
  /** Declined by a human (currently only from the approval digest). Terminal. */
  | "rejected"
  | "failed";

export interface Draft {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: DraftStatus;
  source: SourcePost;
  targets: Platform[];
  renders: PlatformRender[];
  qa?: QAReport;
  providerPostId?: string;
  scheduledFor?: string;
  publishedAt?: string;
  lastError?: string;
}

