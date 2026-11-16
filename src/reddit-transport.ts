/**
 * Reddit's DirectTransport -- mirrors pinterest-transport.ts's split: what a
 * submission/delete/lookup MEANS on this platform lives here; everything
 * about *talking* to Reddit lives in reddit.ts.
 *
 * ⚠️ FIRST-TIME ENABLEMENT. Reddit publishing has never succeeded anywhere
 * in this system -- the one post ever attempted, through the Postiz
 * aggregator, ended in `state: ERROR` with nothing else recorded. Nothing
 * here inherits correctness from that path or any other prior Reddit code in
 * this repo; every behaviour below was decided from reddit.ts's
 * vendor-verified facts and this engine's own existing conventions
 * (pinterest-transport.ts, x-transport.ts), not from what publish.ts's
 * aggregator-era Reddit handling already assumed.
 *
 * Building this surfaced two genuine holes in `publishDestination()`, both
 * since FIXED there rather than worked around here:
 *
 *   1. Its `reddit` case never set `.title`, though Reddit requires a title on
 *      every submission kind. It now falls back to `draft.source.title`, the
 *      same way the `youtube` case does.
 *   2. Its `reddit` case never set `.link` — and deliberately still does not.
 *      A Reddit LINK post carries a URL and no body, so populating it would
 *      have turned every publish into a body-less submission that silently
 *      discarded the copy. Reddit renders links clickably inside a self post,
 *      so the link travels in the body where the formatter put it, and the
 *      link-post branch below is reserved for a render with no copy at all.
 *
 * Engine rules apply: relative imports only.
 */

import {
  RedditError,
  deleteThing,
  INFO_BATCH_LIMIT,
  getInfo,
  getLinkFlair,
  getMe,
  getPostRequirements,
  getPostStats,
  getSubredditAbout,
  isRedditNotFound,
  redditMediaUploadEnabled,
  submitPost,
  uploadMediaAsset,
  type RedditPostKind,
} from "./reddit.js";
import { normalizeSubreddit } from "./specs.js";
import type {
  DirectConnectStatus,
  DirectPostFacts,
  DirectPublishInput,
  DirectPublishResult,
  DirectTransport,
  TransportChannelRules,
} from "./transport.js";
import type { MediaAsset } from "./types.js";
import { getErrorMessage } from "./error-message.js";

const MB = 1024 * 1024;

function channelRules(): TransportChannelRules {
  return {
    // Reddit's own self-post body cap. NOT vendor-confirmed on an official
    // page -- POST /api/submit's own parameter table (reddit.ts's
    // submitPost docblock) describes `text` only as "raw markdown text",
    // no length figure anywhere near it on the full page. 40,000 is the
    // figure specs.ts already carried ("Reddit's own self-post body limit
    // is ~40,000") before this transport existed, itself uncited there too.
    // Kept as the best available guard, the same honesty
    // pinterest-transport.ts applies to its own byte/duration caps.
    //
    // Once this transport is live, specs.ts's 10,000 undercounts: that
    // number is a POSTIZ artifact (that channel's own reported schema max,
    // per specs.ts's own comment on the reddit entry), not Reddit's real
    // limit -- the exact same "specs.ts goes stale the moment a transport
    // cuts over" situation pinterest-transport.ts's channelRules() flagged
    // for its own maxLength.
    maxLength: 40_000,
    countMode: "utf16",
    // Real platform ceilings (specs.ts's existing, Postiz-schema-verified
    // figures), declared here for QA to check against exactly like
    // pinterest-transport.ts declares video limits while refusing video --
    // this transport uploads at most one image, only for a post with no copy
    // and only with SOCIALMETA_REDDIT_MEDIA_UPLOAD=1, and refuses video, so
    // these numbers describe the PLATFORM, not what this client can send.
    maxImages: 20,
    maxImageBytes: 20 * MB,
    maxVideoBytes: 1024 * MB,
    maxVideoSec: 900,
  };
}

async function connectStatus(): Promise<DirectConnectStatus> {
  try {
    const profile = await getMe();
    return { connected: true, accountId: profile.id, displayName: profile.name };
  } catch (err) {
    // A transport that cannot report status must not throw: publish.ts's
    // directConnectedAccounts() treats the whole platform as unreachable and
    // moves on to the other eight, but only if this resolves rather than rejects.
    return {
      connected: false,
      accountId: "",
      displayName: "",
      reason: getErrorMessage(err),
    };
  }
}

/**
 * `https://redd.it/{id36}` -- Reddit's own short-link form, which needs only
 * the id and (unlike `https://www.reddit.com/r/<sr>/comments/<id36>/`)
 * nothing else. Chosen deliberately over reading a permalink back from the
 * vendor: reddit.ts's submitPost docblock explains why relying on a
 * `json.data.url` field would be guessing (its meaning for a link post vs. a
 * self post was never confirmed against a worked example), so this always
 * derives the short link from the id instead. `ref` here is the fullname
 * (`t3_xxx`, this transport's chosen `ref` shape -- see publishNow); the
 * `t3_` type prefix is stripped since redd.it wants the bare id.
 *
 * NOT a field any API response returns -- same honesty caveat
 * pinterest-transport.ts's postUrl and x-transport.ts's postUrl apply to
 * their own constructed permalinks. This one at least rests on an OFFICIALLY
 * confirmed prefix table (reddit-archive/reddit/wiki/JSON: "t3_" = Link) for
 * knowing where the id starts.
 */
function postUrl(ref: string): string {
  const id36 = ref.startsWith("t3_") ? ref.slice(3) : ref;
  return `https://redd.it/${id36}`;
}

/**
 * Uploads the first image, when the undocumented media path is explicitly
 * enabled. Returns null on any failure, INCLUDING when the flag is off.
 *
 * ⚠️ Never throws. `/api/media/asset.json` is absent from Reddit's public API
 * reference (see reddit.ts), so this is speculative code in a publish path;
 * a failure here must degrade to the self post this transport already makes,
 * not take the post down with it.
 */
async function tryUploadFirstImage(media: MediaAsset[]): Promise<string | null> {
  if (!redditMediaUploadEnabled()) return null;
  const asset = media.find((m) => m.type === "image" && m.url);
  if (!asset?.url) return null;

  try {
    const res = await fetch(asset.url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`fetching the asset returned HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer()) as Uint8Array<ArrayBuffer>;
    const filename = asset.url.split("/").pop()?.split("?")[0] || "image.jpg";
    const { url } = await uploadMediaAsset(bytes, filename, asset.mimeType);
    return url;
  } catch (err) {
    console.warn(
      `[reddit] media upload failed, falling back to a self post: ${getErrorMessage(err)}`,
    );
    return null;
  }
}

/**
 * Say loudly that an attached asset is not going to Reddit, then carry on.
 *
 * ⚠️ A WARNING, NOT A HARD REFUSAL. `pickMediaForPlatform`
 * attaches the generated card to EVERY platform's render including Reddit, so
 * refusing on media would fail nearly every Reddit publish while looking like a
 * per-draft problem. A self post is also the better Reddit post: the copy and its
 * clickable link are the payload, the card is the host's own artifact. Loud, because
 * dropped content is never silent here, and the drop is recoverable by hand.
 *
 * Media is dropped when the render has copy (an image post has no body field, so
 * copy wins), or when the image upload is off or failed.
 */
function warnMediaNotUploaded(media: MediaAsset[], uploaded: boolean): void {
  if (!media.length || uploaded) return;
  console.warn(
    `[reddit] ${media.length} attached asset(s) will NOT be uploaded: the render has copy (an image post carries ` +
      `no body), or the image upload is off (SOCIALMETA_REDDIT_MEDIA_UPLOAD) or failed. Publishing as a self post; ` +
      `the copy and its links go out intact.`,
  );
}

/**
 * Root-only. Reddit has neither a thread model nor a first-comment model
 * (specs.ts: `supportsThreads: false`, `supportsFirstComment: false`), so
 * unlike X or Bluesky there is no follow-up chain to branch on here -- the
 * simplest publishNow in this engine after Pinterest's.
 *
 * Link vs. self is decided by `destination.link`: present means "post this
 * as a link", matching the same "destination decides, not the render alone"
 * discipline pinterest-transport.ts's docblock explains for its own board.
 * When it IS present, `render.content` is deliberately NOT sent -- Reddit's
 * `kind: "link"` submission has no body field at all (reddit.ts's
 * submitPost docblock), so there is nothing to put it in. This is not silent
 * data loss: specs.ts's own Reddit notes already say the better answer for
 * commentary-plus-link is a SELF post with the link written into the body
 * ("Prefer a text (self) post with the link in context over a bare link
 * post"), which is the other branch below and does carry `render.content`
 * in full.
 */
async function publishNow(input: DirectPublishInput): Promise<DirectPublishResult> {
  const { render, media, destination } = input;

  const subreddit = normalizeSubreddit(destination.subreddit ?? render.subreddit);
  if (!subreddit) {
    // Should already have been refused upstream (platformSettings /
    // publishDestination both resolve a subreddit before a publish reaches a
    // transport), so reaching this is a caller bug, not a vendor edge case --
    // fail loudly rather than let submitPost() send a request Reddit would
    // reject with a far less specific error.
    throw new Error(
      "reddit: render has no destination subreddit (platformSettings should have refused this publish before it reached the transport)",
    );
  }

  const title = (render.title ?? destination.title ?? "").trim();
  if (!title) {
    // See this file's header docblock (gap 1): destination.title is never
    // populated for reddit by publish.ts today, so render.title is the only
    // source this transport can read. Reddit itself requires a title on
    // every submission kind, so refusing here matches a real vendor
    // constraint, not an invented one.
    throw new Error(
      "reddit: a submission needs a title, and none was set on the render (Reddit's own POST /api/submit " +
        'requires "title" on every kind of post; destination.title is not populated for reddit renders today).',
    );
  }

  const flair = destination.flair ?? render.flair;
  // ⛔ SELF POST WINS WHENEVER THERE IS COPY, and the order matters.
  //
  // A Reddit link post carries a URL and NO body. Choosing `link` merely
  // because a link EXISTS would discard `render.content` entirely — the whole
  // post, silently, on a platform where the body is the value. A link post is
  // only right when there is no copy to lose. Reddit renders links clickably
  // inside a self post, so nothing is lost the other way round.
  const body = render.content.trim();

  // ⛔ AN IMAGE POST HAS NO BODY FIELD, exactly like a link post — so media
  // upload is only reachable when there is no copy to lose. Preferring an
  // image post because an image EXISTS would discard render.content, which is
  // the very silent loss the self-post rule above exists to prevent. The
  // ordering is therefore: copy -> self, else image, else link, else self.
  const uploadedImageUrl = body ? null : await tryUploadFirstImage(media);
  if (!body && !uploadedImageUrl && media.some((m) => m.type === "video")) {
    // A video with no copy IS the post, so dropping it to a bare link or an empty
    // self post would publish something nobody wrote. Reddit's video submit needs
    // a poster-frame upload plus the websocket handshake, and is not built.
    throw new Error(
      "reddit: video posts are not supported by the direct Reddit transport. Add copy to publish a self post " +
        "(the video is then left out, with a warning), or attach an image instead.",
    );
  }
  const kind: RedditPostKind = body
    ? "self"
    : uploadedImageUrl
      ? "image"
      : destination.link
        ? "link"
        : "self";

  // Warned AFTER the decision, so the message can say what actually happened
  // rather than assuming media is always dropped.
  warnMediaNotUploaded(media, kind === "image");

  const post = await submitPost({
    subreddit,
    title,
    kind,
    ...(kind === "image"
      ? { url: uploadedImageUrl! }
      : kind === "link"
        ? { url: destination.link }
        : { text: render.content }),
    ...(flair ? { flairId: flair.id, flairText: flair.name } : {}),
  });

  return { ref: post.name, url: postUrl(post.name) };
}

/**
 * Idempotent by construction, not by anything this function catches.
 *
 * Reddit's own POST /api/del (reddit.ts's deleteThing) documents NO error
 * shape at all for an already-deleted or never-existent id -- no `api_type`
 * envelope, no worked example, nothing to pattern-match the way
 * `isPinterestNotFound`/`isXNotFound` match on a documented 404. There is
 * therefore nothing here to catch: a real failure (bad auth, rate limit,
 * a network error) still throws normally through deleteThing()'s own
 * request() plumbing, and anything that does not throw is success --
 * including, per the vendor's own apparent behaviour, a redelete of a post
 * that is already gone. If Reddit ever starts reporting a distinguishable
 * "not found" for this endpoint, `isRedditNotFound` in reddit.ts is where
 * that check would go; there is nothing to wire it to today.
 */
async function deletePost(ref: string): Promise<void> {
  await deleteThing(ref);
}

/**
 * Chunked into GET /api/info at its (client-chosen, NOT vendor-stated)
 * 100-fullname batch limit -- reddit.ts's getInfo already does the
 * chunking, so this just partitions the result.
 *
 * A ref found in the returned set is PUBLISHED. A ref NOT found is QUEUE
 * WITHOUT `absent` -- deliberately, and differently from
 * pinterest-transport.ts's confirmed-404 case and x-transport.ts's
 * confirmed-resource-not-found case. Both of those rest on a vendor-DOCUMENTED
 * unambiguous "this does not exist" signal (a plain 404; an explicit
 * `resource-not-found` problem type). Reddit's api/info gives no such
 * signal for omission -- getInfo's own docblock explains that a missing
 * fullname could mean deleted, could mean never existed, or could mean this
 * token simply cannot see it for some unrelated reason (a quarantined
 * subreddit, a removed post, a banned author), and the official page does
 * not distinguish those. Given this system's Reddit publishing has never
 * once succeeded, treating an unconfirmed omission as a confirmed deletion
 * is exactly the overconfident call the task's own briefing warns against --
 * so `absent` stays unset here, matching bluesky-transport.ts's discipline
 * for its own ambiguous omission case, not pinterest's or x's.
 *
 * ⚠️ Still never ERROR, for the same reason as every other transport:
 * `state` is the caller's verdict to make (see pinterest-transport.ts's
 * postFacts docblock for the full reasoning).
 */
async function postFacts(refs: string[]): Promise<Map<string, DirectPostFacts>> {
  const out = new Map<string, DirectPostFacts>();
  if (!refs.length) return out;

  /**
   * Chunked HERE, at getInfo's own batch size, rather than handing it the whole
   * list. getInfo chunks internally with no per-chunk try/catch, so a single
   * failing request would reject the entire call, and the catch below would
   * then mark EVERY ref QUEUE, including posts an earlier chunk had already
   * confirmed exist. On a large outstanding-legs list one flaky request would
   * discard every confirmation in the sweep.
   *
   * This is the shape bluesky/linkedin/x/youtube use (catch per batch,
   * `continue`); every transport catches per batch or per ref.
   */
  const found = new Set<string>();
  for (let i = 0; i < refs.length; i += INFO_BATCH_LIMIT) {
    const batch = refs.slice(i, i + INFO_BATCH_LIMIT);
    try {
      for (const name of await getInfo(batch)) found.add(name);
    } catch (err) {
      // A lookup failure says nothing about whether any of these posts exist.
      // Only THIS batch is unknown; earlier confirmations stand.
      const reason = err instanceof RedditError ? err.message : String(err);
      console.warn(`[reddit] postFacts lookup failed for a batch of ${batch.length}: ${reason}`);
      for (const ref of batch) out.set(ref, { state: "QUEUE", released: false, platform: "reddit" });
    }
  }

  for (const ref of refs) {
    // Already settled by a failed batch above — do not overwrite it with the
    // omission branch, which would log the wrong reason for the same verdict.
    if (out.has(ref)) continue;
    if (found.has(ref)) {
      out.set(ref, { state: "PUBLISHED", released: true, platform: "reddit" });
    } else {
      // Unconfirmed omission, not a confirmed absence -- see this function's
      // docblock. Logged distinctly from the lookup-failure branch above so
      // an operator can tell "we couldn't ask" from "we asked and it wasn't
      // in the answer" while `state` itself stays identical either way.
      console.warn(`[reddit] post ${ref} was not in the api/info result; reporting QUEUE (omission is not confirmed deletion here)`);
      out.set(ref, { state: "QUEUE", released: false, platform: "reddit" });
    }
  }
  return out;
}

/**
 * The subreddit's own posting rules -- Reddit's analogue of Pinterest's
 * boards, per the task's own framing.
 *
 * Deliberately reads from TWO vendor endpoints, not the single
 * `/r/<sub>/about.json` the task's briefing named: reddit.ts's
 * getSubredditAbout/getPostRequirements docblocks explain that
 * `is_flair_required` is officially documented on
 * `GET /api/v1/{subreddit}/post_requirements` (scope `submit`), not on
 * `/about` (scope `read`) -- the briefing's guess conflated the two. Using
 * the endpoint the vendor actually documents the field on, rather than
 * guessing it also appears on `/about`, is the whole reason for the split.
 *
 * The `about` lookup is load-bearing enough to propagate a failure (a
 * subreddit that does not exist is a real, useful thing for a caller to
 * learn -- same discipline pinterest-transport.ts's listBoards applies:
 * "propagates a lookup failure rather than reporting an empty list").
 * `post_requirements` and the flair list are NOT: both need scopes
 * (`submit`, `flair`) the injected token might not carry, and per this
 * engine's existing publish.ts precedent (resolveRedditRestrictions,
 * assertPinterestBoard) a narrower lookup failing must not block a caller
 * that only wanted the broader picture -- so those two are best-effort and
 * simply omitted from the result on failure, with a warning.
 *
 * Nothing in publish.ts calls this yet (it is off-limits for this change --
 * see this file's header docblock). It exists so a future preflight can ask
 * the SAME vendor the publish is about to go to, the direct equivalent of
 * what `assertPinterestBoard` already does for Pinterest once cut over;
 * wiring it in is the same kind of handoff pinterest-transport.ts's
 * postFacts docblock leaves for reconcile.
 */
async function destinationRules(destination: string): Promise<Record<string, unknown>> {
  const subreddit = normalizeSubreddit(destination);
  if (!subreddit) {
    throw new Error(`reddit: "${destination}" is not a usable subreddit name`);
  }

  let about;
  try {
    about = await getSubredditAbout(subreddit);
  } catch (err) {
    if (isRedditNotFound(err)) {
      throw new Error(`reddit: r/${subreddit} does not exist (or this token cannot see it)`);
    }
    throw err;
  }

  const out: Record<string, unknown> = {
    subreddit,
    submissionType: about.submissionType,
    allowSelf: about.submissionType !== "link",
    allowLink: about.submissionType !== "self",
  };

  try {
    const req = await getPostRequirements(subreddit);
    out.isFlairRequired = req.isFlairRequired;
    out.bodyRestrictionPolicy = req.bodyRestrictionPolicy;
    if (req.titleMinLength !== undefined) out.titleMinLength = req.titleMinLength;
    if (req.titleMaxLength !== undefined) out.titleMaxLength = req.titleMaxLength;
  } catch (err) {
    console.warn(
      `[reddit] could not read r/${subreddit} post_requirements (needs the "submit" scope), leaving flair/body-policy unknown:`,
      err instanceof Error ? err.message : err,
    );
  }

  try {
    out.flairs = await getLinkFlair(subreddit);
  } catch (err) {
    console.warn(
      `[reddit] could not read r/${subreddit} link flair (needs the "flair" scope):`,
      err instanceof Error ? err.message : err,
    );
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/*  Analytics                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * ⚠️ `score` IS FUZZED BY REDDIT BY DESIGN — the platform perturbs vote counts
 * to frustrate manipulation, so two calls seconds apart can legitimately
 * disagree. Treat it as an approximate signal, never as a reconciliation input
 * and never as an event source. See getPostStats in reddit.ts.
 *
 * Keys are REDDIT's own; "score" has no counterpart on any other platform here.
 * Same rule as the other transports: a counter the listing omits is left out
 * rather than defaulted to 0.
 */
async function analyticsPost(ref: string): Promise<Record<string, number>> {
  const [stats] = await getPostStats([ref]);
  if (!stats) return {};
  const out: Record<string, number> = {};
  if (stats.score !== undefined) out.score = stats.score;
  if (stats.comments !== undefined) out.comments = stats.comments;
  if (stats.upvoteRatio !== undefined) out.upvoteRatio = stats.upvoteRatio;
  return out;
}

/**
 * Account karma, which is the only account-level number Reddit exposes here.
 *
 * ⛔ There is deliberately NO followerStats. Reddit accounts have subscribers
 * only on a user profile subreddit, and `getMe()` carries no follower field at
 * all — inventing one from karma would be a fabricated metric wearing the name
 * of a real one. The interface marks the method optional precisely so a
 * platform can decline it.
 */
async function analyticsChannel(): Promise<Record<string, number>> {
  const me = await getMe();
  const out: Record<string, number> = {};
  if (typeof me.linkKarma === "number") out.linkKarma = me.linkKarma;
  if (typeof me.commentKarma === "number") out.commentKarma = me.commentKarma;
  if (typeof me.totalKarma === "number") out.totalKarma = me.totalKarma;
  return out;
}

export const redditTransport: DirectTransport = {
  platform: "reddit",
  channelRules,
  connectStatus,
  publishNow,
  deletePost,
  postFacts,
  postUrl,
  analyticsPost,
  analyticsChannel,
  destinationRules,
};
