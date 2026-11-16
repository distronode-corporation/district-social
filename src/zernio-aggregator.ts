/**
 * Zernio as an `Aggregator`.
 *
 * One credential spanning several platforms, which is why this is an
 * `Aggregator` and not ten `DirectTransport`s — see the interface's own
 * docblock. Registration alone routes nothing: a platform reaches this only by
 * being set to `aggregator:zernio` in `transportOverrides`.
 *
 * Engine rules apply: relative imports only.
 */

import type { Aggregator, DirectConnectStatus, DirectPostFacts, DirectPublishInput, DirectPublishResult, TransportChannelRules } from "./transport.js";
import { threadReplies, type Platform } from "./types.js";
import {
  createPost,
  getAnalytics,
  getPost,
  listAccounts,
  listPinterestBoards,
  listRedditFlairs,
  unpublishPost,
  ZernioError,
  type ZernioAccount,
  type ZernioAnalyticsReport,
  type ZernioPlatformData,
  type ZernioPlatformResult,
} from "./zernio.js";
import { youtubeDescription, youtubeSafeText } from "./youtube.js";
import { isAiGeneratedAsset } from "./instagram-transport.js";
import { getErrorMessage } from "./error-message.js";
import { SENDS_FIRST_COMMENT } from "./specs.js";
import { PublishPreflightError } from "./publish.js";

/**
 * ⛔ PERMANENT. This string is written into `providerPostId` by
 * `aggregatorEntry` as `via:zernio:<platform>:<ref>`, so changing it orphans
 * every leg already carrying the old one.
 */
export const ZERNIO_ID = "zernio";

/**
 * Zernio's platform names, which happen to match the engine's one for one.
 *
 * ⚠️ Checked, not assumed. Zernio's connect enum is `[facebook, instagram,
 * linkedin, twitter, tiktok, youtube, threads, reddit, pinterest, bluesky,
 * googlebusiness, telegram, snapchat, discord, slack, whatsapp]` and every one
 * of the engine's ten appears with the identical spelling, including `twitter`
 * rather than `x`, which is also the engine's platform id. The mapping is therefore the identity
 * function, and this comment exists so that stays a verified fact rather than a
 * coincidence somebody later relies on.
 *
 * TikTok is here because Zernio's TikTok for Business app can publish for an
 * operator whose own app is not connected yet. Once it is, tiktok-transport.ts
 * takes the route (the app's routing decides); legs already published here
 * stay this aggregator's to look up.
 */
const SUPPORTED = new Set<string>([
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
]);

/**
 * Separator inside a composite ref: `<zernioPostId>~<platformPostId>`.
 *
 * ⛔ BOTH IDS HAVE TO SURVIVE, and neither alone is sufficient. Deleting needs
 * Zernio's own post id (`/posts/{id}/unpublish`); the calendar permalink needs
 * the NATIVE id, and `postUrl(ref)` is synchronous and pure so it cannot fetch
 * one. Storing only Zernio's id would make every calendar link point at a
 * dashboard the operator cannot deep-link into; storing only the native id
 * would make the post undeletable from this product.
 *
 * `~` is safe where `,` is not: the codec splits the column on commas, and
 * `aggregatorEntry` already refuses a comma-bearing ref. Colons would also have
 * been safe (everything after the second colon is untouched) but would read as
 * part of a vendor urn.
 */
const REF_SEP = "~";

/**
 * ⚠️ THE REF IS IMMUTABLE ONCE WRITTEN, and three separate mechanisms depend on
 * it: publish-due's compare-and-swap matches the exact entry string,
 * `confirmedLegs` is keyed by the raw string and deliberately does not re-parse
 * it, and `swapEntry` callers snapshot the column before mutating. Never
 * "upgrade" a half-populated ref later — `postUrl` falls back instead.
 */
function composeRef(zernioPostId: string, platformPostId: string | undefined): string {
  const native = platformPostId ?? "";
  if (zernioPostId.includes(REF_SEP) || native.includes(REF_SEP)) {
    throw new ZernioError(
      `Zernio ids cannot contain "${REF_SEP}": ${zernioPostId} / ${native}`,
      0,
    );
  }
  return `${zernioPostId}${REF_SEP}${native}`;
}

function splitRef(ref: string): { postId: string; nativeId: string } {
  const at = ref.indexOf(REF_SEP);
  // A ref with no separator predates nothing — it would be a bug — but degrade
  // to "all of it is the Zernio id" rather than throwing inside a delete path.
  if (at === -1) return { postId: ref, nativeId: "" };
  return { postId: ref.slice(0, at), nativeId: ref.slice(at + REF_SEP.length) };
}

/* -------------------------------------------------------------------------- */
/*  Channel rules                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Zernio's OWN documented limits, per platform.
 *
 * ⛔ NOT COPIED FROM `SPECS`, and the `Aggregator` interface says why: an
 * aggregator's limits are its own and are frequently STRICTER than the
 * vendor's, because it has to satisfy the strictest account it serves. These
 * are from docs.zernio.com's per-platform pages.
 *
 * ⚠️ `specs-transport-drift.test.ts` does NOT cover these — it compares SPECS
 * against the DIRECT transports. Any platform routed here has to be listed in
 * that file's AGGREGATOR_ROUTED ledger so a green run there does not imply
 * coverage it does not have.
 */
const RULES: Record<string, TransportChannelRules> = {
  // Body 40,000; the 300-char title cap is enforced by Zernio on
  // platformSpecificData.title, not on the body.
  reddit: { maxLength: 40_000, countMode: "utf16", maxImages: 20, maxImageBytes: 20_000_000 },
  // 280 on the free tier. Zernio bills X per create and passes the cost
  // through at exact rate, so a longer allowance would be a spend decision
  // rather than a formatting one.
  twitter: { maxLength: 280, countMode: "weighted", maxImages: 4, maxImageBytes: 5_000_000 },
  linkedin: { maxLength: 3_000, countMode: "utf16", maxImages: 20, maxImageBytes: 8_000_000 },
  // ⚠️ Zernio's own docs call the 300-character cap "the #1 cause of failed
  // posts — 95% of all Bluesky failures", and it counts URLs and mentions in
  // full. Same grapheme rule the direct transport uses.
  bluesky: { maxLength: 300, countMode: "grapheme", maxImages: 4, maxImageBytes: 1_000_000 },
  threads: { maxLength: 500, countMode: "utf16", maxImages: 10, maxImageBytes: 8_000_000 },
  instagram: {
    maxLength: 2_200,
    countMode: "utf16",
    maxImages: 10,
    maxImageBytes: 8_000_000,
    imageFormats: ["image/jpeg"],
  },
  facebook: { maxLength: 63_206, countMode: "utf16", maxImages: 10, maxImageBytes: 4_000_000 },
  // Description cap. The 100-char title is a platformSpecificData field.
  pinterest: { maxLength: 500, countMode: "utf16", maxImages: 1, maxImageBytes: 32_000_000 },
  // YouTube's description is 5,000 UTF-8 BYTES, not code units.
  youtube: { maxLength: 5_000, countMode: "utf8bytes" },
  // A video caption is 2,200 (TikTokPlatformData, Zernio's OpenAPI). No image
  // limits: SPECS.tiktok is video only, so a photo post
  // (up to 35 images, title cut to 90) never reaches this route.
  tiktok: { maxLength: 2_200, countMode: "utf16" },
};

/* -------------------------------------------------------------------------- */
/*  Account cache                                                              */
/* -------------------------------------------------------------------------- */

const ACCOUNTS_TTL_MS = 60_000;
let _accounts: { value: ZernioAccount[]; at: number } | null = null;
let _inFlight: Promise<ZernioAccount[]> | null = null;

/**
 * Connected accounts, memoised.
 *
 * `platforms()` is synchronous by interface and is called on the routing path,
 * so the account list has to be readable without awaiting. The cache is
 * populated by any async call and read synchronously by `platforms()`; before
 * the first refresh it answers with everything Zernio COULD serve, which is the
 * safe direction — the platform still has to be explicitly routed here by an
 * operator, and a publish to an unconnected account fails loudly at the vendor
 * rather than silently going nowhere.
 */
async function accounts(): Promise<ZernioAccount[]> {
  const now = Date.now();
  if (_accounts && now - _accounts.at < ACCOUNTS_TTL_MS) return _accounts.value;
  if (_inFlight) return _inFlight;

  _inFlight = (async () => {
    try {
      const value = await listAccounts();
      _accounts = { value, at: Date.now() };
      return value;
    } finally {
      _inFlight = null;
    }
  })();
  return _inFlight;
}

/** Drop the memo. Exported for tests and for a post-connect refresh. */
export function resetZernioAccounts(): void {
  _accounts = null;
  _inFlight = null;
  _analytics = null;
  _analyticsInFlight = null;
}

async function accountFor(platform: Platform): Promise<ZernioAccount> {
  const all = await accounts();
  const hit = all.find((a) => a.platform === platform && a.isActive !== false);
  if (!hit) {
    throw new ZernioError(
      `no active Zernio account is connected for ${platform}. Connect it in the Zernio dashboard.`,
      0,
    );
  }
  return hit;
}

/* -------------------------------------------------------------------------- */
/*  Publish payload                                                            */
/* -------------------------------------------------------------------------- */

/** Map our per-destination facts onto Zernio's per-platform options. */
function platformData(
  platform: Platform,
  input: DirectPublishInput,
  media: ReturnType<typeof mediaItems>,
): ZernioPlatformData {
  const d = input.destination;
  switch (platform) {
    case "twitter": {
      // Same convention as x-transport.ts: `content` is the root and every
      // threadItem is a reply, in order. Zernio wants the whole chain root-first
      // and publishes nothing from the top-level `content` once threadItems is
      // set, so the root is spelled out here with its media.
      const replies = threadReplies(input.render);
      if (!replies.length) return {};
      return {
        threadItems: [
          { content: input.render.content, ...(media.length ? { mediaItems: media } : {}) },
          ...replies.map((content) => ({ content })),
        ],
      };
    }
    case "reddit":
      return {
        ...(d.subreddit ? { subreddit: d.subreddit } : {}),
        // Reddit posts REQUIRE a title. Zernio defaults it to the first line of
        // the body truncated to 300, which is a worse title than the draft's own.
        ...(d.title ? { title: d.title.slice(0, 300) } : {}),
        ...(d.flair?.id ? { flairId: d.flair.id } : {}),
      };
    case "pinterest":
      return {
        ...(d.board ? { boardId: d.board } : {}),
        ...(d.title ? { title: d.title.slice(0, 100) } : {}),
        ...(d.link ? { link: d.link } : {}),
      };
    case "youtube":
      return {
        ...(d.title ? { title: [...youtubeSafeText(d.title)].slice(0, 100).join("") } : {}),
        // ⛔ Never `public`. The direct YouTube transport is deliberately
        // conservative about visibility for the same reason: an upload that goes
        // out public cannot be un-seen, and a private one can always be promoted.
        visibility: "private",
      };
    case "tiktok":
      return {
        // ⛔ PUBLIC IS THE ONLY LEVEL THIS ACCOUNT HAS. It is connected through
        // Zernio's TikTok for Business app, and creator-info for it lists only
        // PUBLIC_TO_EVERYONE (Zernio rejects a non-public video from a business
        // connection at creation). Unlike YouTube there is no private-first
        // option, so a TikTok leg is live to everyone the moment it publishes.
        privacyLevel: "PUBLIC_TO_EVERYONE",
        // TikTok requires all three on a video post, so each is sent
        // explicitly. The render's opt-outs are the composer's TikTok toggles.
        allowComment: !input.render.tiktokDisableComment,
        allowDuet: !input.render.tiktokDisableDuet,
        allowStitch: !input.render.tiktokDisableStitch,
        // ⚠️ "Your Brand", always: every post is the operator promoting its own
        // brand, which is why the composer shows this label locked on. With it
        // on, TikTok allows Commercial Music Library audio only, so no
        // `autoAddMusic` is sent.
        commercialContentType: "brand_organic",
        // The same disclosure Instagram's `is_ai_generated` reads: a Veo clip
        // carries `aiGenerated` on the draft's media.
        videoMadeWithAi: input.media.some(isAiGeneratedAsset),
        // The operator previewed the render and approved it in the host application,
        // which is what these two attest.
        contentPreviewConfirmed: true,
        expressConsentGiven: true,
      };
    default:
      return {};
  }
}

/**
 * Media as public HTTPS URLs.
 *
 * ⚠️ Zernio also offers a presigned upload, and this deliberately does not use
 * it. The app's media fitter already re-uploads fitted bytes to the media store
 * and returns a fresh public URL, and the uploader hard-fails without a media
 * store, so a public URL is guaranteed by the time a leg reaches here, and the
 * presigned path would be a
 * SECOND upload of bytes that are already addressable.
 */
function mediaItems(input: DirectPublishInput) {
  return input.media
    .filter((m) => Boolean(m.url))
    .map((m) => ({
      type: (m.mimeType?.startsWith("video/") ? "video" : "image") as "video" | "image",
      url: m.url!,
      ...(m.altText ? { altText: m.altText } : {}),
    }));
}

/**
 * The body Zernio publishes.
 *
 * ⛔ ZERNIO HAS NO FIRST-COMMENT FIELD (no `firstComment` on its create payload
 * or on any `ZernioPlatformData`), and the playbook moves Facebook's link and
 * Instagram's hashtag overflow into `render.firstComment`, which the direct
 * transports post as a comment. Sending `content` alone published the post
 * without them, with a real native id, so nothing downstream noticed. On the
 * platforms whose transports send a first comment (SENDS_FIRST_COMMENT), it is
 * appended to the body instead, and refused before any create when the folded
 * body passes Zernio's own cap (QA measured the two values separately).
 */
function bodyFor(platform: Platform, input: DirectPublishInput): string {
  const { content, firstComment } = input.render;
  // Zernio forwards the body as the YouTube description, which refuses < and >
  // and caps at 5000 bytes, so it gets the same sanitize-then-cut as the
  // direct upload. QA measures before the swap, so a body at the cap with
  // brackets in it would otherwise go out over it.
  if (platform === "youtube") return youtubeDescription(content);
  if (!firstComment || !SENDS_FIRST_COMMENT.has(platform)) return content;
  const body = `${content}\n\n${firstComment}`;
  // Every folding platform counts utf16 in RULES.
  const cap = zernioAggregator.channelRules(platform).maxLength;
  if (body.length > cap) {
    throw new PublishPreflightError(
      `${platform} via Zernio: the first comment has to ride in the body (Zernio cannot post one), ` +
        `and together they are ${body.length} characters, over Zernio's ${cap}. Shorten the body or the first comment.`,
    );
  }
  return body;
}

/* -------------------------------------------------------------------------- */
/*  The aggregator                                                             */
/* -------------------------------------------------------------------------- */

function legFor(post: { platforms?: ZernioPlatformResult[] }, platform: Platform) {
  return post.platforms?.find((p) => p.platform === platform);
}

/** Keep only real numbers, so a null or a string cannot land in a counters map. */
function numeric(a: Record<string, unknown> | object | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries((a ?? {}) as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/**
 * The account-wide analytics report, memoised.
 *
 * ⚠️ Analytics carries its own per-SECOND cap (max(6, req_per_min/60)) and this
 * one endpoint serves every post, so a per-leg call would burn the budget
 * answering the same question repeatedly. The TTL is long because `lastSync` in
 * the payload shows Zernio itself refreshes these roughly hourly — a shorter one
 * would just re-fetch the same numbers.
 */
const ANALYTICS_TTL_MS = 10 * 60_000;
let _analytics: { value: ZernioAnalyticsReport; at: number } | null = null;
let _analyticsInFlight: Promise<ZernioAnalyticsReport> | null = null;

async function analyticsReport(): Promise<ZernioAnalyticsReport> {
  const now = Date.now();
  if (_analytics && now - _analytics.at < ANALYTICS_TTL_MS) return _analytics.value;
  if (_analyticsInFlight) return _analyticsInFlight;

  _analyticsInFlight = (async () => {
    try {
      const value = await getAnalytics();
      _analytics = { value, at: Date.now() };
      return value;
    } finally {
      _analyticsInFlight = null;
    }
  })();
  return _analyticsInFlight;
}

export const zernioAggregator: Aggregator = {
  id: ZERNIO_ID,
  // Brand casing for operator-facing text. `id` stays lowercase forever: it is
  // written into every `via:zernio:...` leg and the codec rejects capitals.
  displayName: "Zernio",

  platforms(): readonly Platform[] {
    // Everything Zernio can serve that we also model. Whether an ACCOUNT is
    // connected is a connectStatus question, not a capability one: reporting a
    // platform as unheld because a cached account list was empty would hide the
    // route from the settings UI entirely and make it unfixable from there.
    const cached = _accounts?.value;
    if (!cached) return [...SUPPORTED] as Platform[];
    const connected = new Set(cached.filter((a) => a.isActive !== false).map((a) => a.platform));
    const held = [...SUPPORTED].filter((p) => connected.has(p)) as Platform[];
    // An empty answer would un-route a live platform on a transient blip, so
    // fall back to full capability rather than reporting none.
    return held.length ? held : ([...SUPPORTED] as Platform[]);
  },

  channelRules(platform: Platform): TransportChannelRules {
    // Falling back to a permissive default would be worse than throwing: QA
    // would validate against a limit nothing enforces. Every SUPPORTED platform
    // has an entry, and a missing one is a wiring bug.
    const rules = RULES[platform];
    if (!rules) throw new ZernioError(`Zernio has no declared limits for ${platform}`, 0);
    return rules;
  },

  async connectStatus(platform: Platform): Promise<DirectConnectStatus> {
    // Contractually forbidden from throwing: it reports failure in its return
    // value, which is why the bound view does not retry-wrap it.
    try {
      const account = await accountFor(platform);
      return {
        connected: true,
        accountId: account._id,
        displayName: account.displayName || account.username || `${platform} via ${ZERNIO_ID}`,
      };
    } catch (err) {
      return {
        connected: false,
        accountId: "",
        displayName: `${platform} via ${ZERNIO_ID}`,
        reason: getErrorMessage(err),
      };
    }
  },

  async publishNow(platform: Platform, input: DirectPublishInput): Promise<DirectPublishResult> {
    const content = bodyFor(platform, input);
    const account = await accountFor(platform);
    const media = mediaItems(input);
    const platformSpecificData = platformData(platform, input, media);
    // When the X thread carries the media on its root item, the top-level
    // mediaItems is left out rather than sent twice: Zernio ignores the
    // top-level content for a threaded X post, and whether it would also attach
    // top-level media to the root is not documented, so it is not risked.
    const topLevelMedia = platformSpecificData.threadItems ? [] : media;
    const post = await createPost({
      content,
      platforms: [
        {
          platform,
          accountId: account._id,
          platformSpecificData,
        },
      ],
      ...(topLevelMedia.length ? { mediaItems: topLevelMedia } : {}),
    });

    const leg = legFor(post, platform);
    // ⛔ A 2xx from Zernio means the REQUEST succeeded, not that the platform
    // accepted the post. Zernio's own docs put Reddit's failure rate above 50%
    // (subreddit rules, karma, missing flair), and every one of those comes back
    // as a per-platform `failed` inside an otherwise fine response. Treating the
    // envelope as success is exactly the "success:true proves nothing" trap.
    if (leg?.status === "failed") {
      throw new ZernioError(
        leg.error || `${platform} rejected the post`,
        502,
        { platform, code: "PLATFORM_REJECTED" },
      );
    }
    if (!post?._id) {
      /**
       * ⛔ THE POST MAY ALREADY BE LIVE, AND THERE IS NO ID TO NAME IT. The
       * create call publishes synchronously, so by the time this runs the
       * platform has usually accepted it; there is simply no id to record, which means no
       * delete, no reconcile, and no calendar link. Exactly the "born
       * undeletable" outcome the `via:` codec exists to prevent, arriving from
       * the vendor's side instead.
       *
       * Reading the response envelope (`{message, post}`) as the post itself
       * lands here, with a live post to find through `GET /posts` and remove by
       * hand. The message says so rather than reporting a generic failure,
       * because the recovery is manual and time-sensitive.
       */
      throw new ZernioError(
        `Zernio accepted the ${platform} publish but returned no post id. ` +
          `A post may be LIVE and unrecorded — check GET /v1/posts and unpublish it by hand.`,
        502,
        { platform, code: "NO_POST_ID" },
      );
    }

    return {
      ref: composeRef(post._id, leg?.platformPostId),
      ...(leg?.platformPostUrl ? { url: leg.platformPostUrl } : {}),
    };
  },

  async deletePost(platform: Platform, ref: string): Promise<void> {
    const { postId } = splitRef(ref);
    try {
      await unpublishPost(postId, platform);
    } catch (err) {
      /**
       * Idempotent by contract: an already-gone post is a success, not an
       * error. That is what makes a double delete, and a retry after a partial
       * failure, safe for every caller in this engine.
       *
       * ⛔ ZERNIO SIGNALS "ALREADY GONE" AS A 400, NOT A 404. A second unpublish
       * answers `400 invalid_field_value: Can only unpublish posts with
       * "published" status. Current status: cancelled` — the post record still
       * exists on their side, it is just no longer publishable, so nothing 404s.
       * Verified live.
       *
       * Treating only 404 as gone would break the contract in the direction
       * that matters: `deleteProviderEntries` would report the leg as FAILED and keep
       * it in `providerPostId`, so a draft whose post was already removed would
       * look permanently half-deleted and every retry would fail the same way.
       *
       * ⚠️ Matched on the vendor's own words rather than on the bare status, so
       * a genuine 400 (an unknown platform, a malformed id) still throws.
       */
      if (err instanceof ZernioError) {
        if (err.status === 404) return;
        if (err.status === 400 && /can only unpublish posts with/i.test(err.message)) return;
      }
      throw err;
    }
  },

  async postFacts(platform: Platform, refs: string[]): Promise<Map<string, DirectPostFacts>> {
    const out = new Map<string, DirectPostFacts>();
    // No batch read on this API, so one call per ref. Reads are cheap here and
    // `confirmedLegs` means a confirmed leg is never re-read.
    await Promise.all(
      refs.map(async (ref) => {
        const { postId } = splitRef(ref);
        try {
          const post = await getPost(postId);
          const leg = legFor(post, platform);
          if (leg?.status === "published") {
            out.set(ref, { state: "PUBLISHED", released: true, platform });
            return;
          }
          if (leg?.status === "failed" || post.status === "failed") {
            out.set(ref, { state: "ERROR", released: false, platform });
            return;
          }
          out.set(ref, { state: "QUEUE", released: false, platform });
        } catch (err) {
          if (err instanceof ZernioError && err.status === 404) {
            // ⚠️ `absent` is set, and `state` stays QUEUE. Zernio's 404 on a post
            // id is unambiguous in the sense DirectPostFacts means — it is our
            // OWN id namespace, not the platform's, so there is no permission or
            // unsupported-operation reading of it. The caller still owns the
            // grace window and the decision to give up.
            out.set(ref, { state: "QUEUE", released: false, platform, absent: true });
            return;
          }
          // Anything else: say nothing, which reads as pending. One broken
          // credential must not mark live posts dead.
        }
      }),
    );
    return out;
  },

  postUrl(platform: Platform, ref: string): string {
    const { postId, nativeId } = splitRef(ref);
    // The native permalink where we have one. `postUrl` is sync and pure by
    // interface, so it cannot fetch a missing native id — the Zernio-side link
    // is the honest fallback rather than a fabricated platform URL.
    if (!nativeId) return `https://zernio.com/posts/${postId}`;
    switch (platform) {
      case "reddit":
        return `https://www.reddit.com/comments/${nativeId.replace(/^t3_/, "")}`;
      case "twitter":
        return `https://twitter.com/i/web/status/${nativeId}`;
      case "youtube":
        return `https://www.youtube.com/watch?v=${nativeId}`;
      case "pinterest":
        return `https://www.pinterest.com/pin/${nativeId}/`;
      case "linkedin":
        return `https://www.linkedin.com/feed/update/${nativeId}/`;
      default:
        return `https://zernio.com/posts/${postId}`;
    }
  },

  /**
   * Counters for one post, from the account-wide analytics report.
   *
   * ⚠️ Matched on the ZERNIO half of the composite ref, not the native id. The
   * report keys posts by Zernio's `_id`, and the native id is only present on
   * the per-platform leg — matching on it would miss any leg Zernio has not
   * finished syncing (`lastSync` in the report is up to an hour old).
   *
   * Zero counters are returned as-is rather than dropped. Reddit reports
   * `impressions: 0` on every post because the vendor does not expose it to this
   * API at all, and silently omitting it would look like "not measured yet"
   * instead of "never available".
   */
  async analyticsPost(platform: Platform, ref: string): Promise<Record<string, number>> {
    const { postId } = splitRef(ref);
    const report = await analyticsReport();
    const post = report.posts?.find((p) => p._id === postId);
    const leg = post?.platforms?.find((p) => p.platform === platform);
    return numeric(leg?.analytics ?? post?.analytics);
  },

  /**
   * Channel totals, summed across every post this account published to the
   * platform.
   *
   * ⚠️ A SUM OF POSTS, NOT A CHANNEL-LEVEL READ. Zernio exposes no
   * follower/audience endpoint, so this is engagement we can actually observe
   * rather than a figure invented to fill the shape — which is why
   * `followerStats` is deliberately NOT implemented. `analytics/route.ts`
   * feature-detects these, so an absent method reports honestly as unwired.
   */
  async analyticsChannel(platform: Platform): Promise<Record<string, number>> {
    const report = await analyticsReport();
    const totals: Record<string, number> = { posts: 0 };
    for (const post of report.posts ?? []) {
      for (const leg of post.platforms ?? []) {
        if (leg.platform !== platform || leg.status !== "published") continue;
        totals.posts += 1;
        for (const [k, v] of Object.entries(numeric(leg.analytics))) {
          totals[k] = (totals[k] ?? 0) + v;
        }
      }
    }
    return totals;
  },

  async listBoards(platform: Platform): Promise<Array<{ id: string; name: string }>> {
    if (platform !== "pinterest") return [];
    const account = await accountFor(platform);
    const boards = await listPinterestBoards(account._id);
    return boards.map((b) => ({ id: b.id, name: b.name ?? b.id }));
  },

  /**
   * Per-destination config, in the shape `readSubredditRules` already consumes.
   *
   * ⚠️ `allowSelf`/`allowLink` are reported as unknown (absent) rather than
   * guessed. `readSubredditRules` reads a missing field as "unknown, allow it",
   * and Zernio does not expose the subreddit's `submission_type`. Claiming a
   * restriction we cannot see would block valid posts; claiming none is what the
   * vendor will enforce anyway, and it enforces it with a real error message.
   */
  async destinationRules(
    platform: Platform,
    destination: string,
  ): Promise<Record<string, unknown>> {
    if (platform !== "reddit" || !destination) return {};
    const account = await accountFor(platform);
    try {
      const flairs = await listRedditFlairs(account._id, destination);
      return {
        subreddit: destination,
        flairs: flairs.map((f) => ({ id: f.id, name: f.text })),
      };
    } catch {
      // A flair list needs scopes the account may not carry, and the direct
      // Reddit transport omits it on failure for the same reason: a missing
      // field must mean "unknown", never "not required".
      return { subreddit: destination };
    }
  },
};
