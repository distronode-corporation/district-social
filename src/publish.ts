import { defaults } from "./settings.js";
import { normalizeCardMediaIndices, unpublishableVideoIndices } from "./media-pick.js";
import { SENDS_FIRST_COMMENT, SPECS, normalizeSubreddit } from "./specs.js";
import { ensureUploaded } from "./media.js";
import { fitForTransport } from "./media-fit.js";
import { isUnknownOutcome } from "./retry.js";
import {
  directStateEntry,
  encodeProviderPostIds,
  isTerminalEntry,
  noRouteMessage,
  resolveRoute,
  routeTransportFor,
  type DirectConnectStatus,
  type DirectQueuedReply,
  type ProviderPostEntry,
  type PublishDestination,
  type RoutedPublish,
} from "./transport.js";
import { ALL_PLATFORMS, threadReplies } from "./types.js";
import type { Draft, Platform, PlatformRender, SourcePost } from "./types.js";
import { getErrorMessage } from "./error-message.js";

export interface ConnectedMap {
  [platform: string]: { accountId: string; displayName: string };
}

/**
 * Short TTL because this sits on the serial path of every draft creation, every
 * idea -> draft conversion (resolveDefaultTargets) and every QA run, and each
 * miss costs one vendor round trip per routed platform. Connection state changes
 * only when an operator connects or disconnects an account.
 */
const CONNECTED_TTL_MS = 60_000;

/**
 * One sweep's answer: the connected map, plus why each platform missing from it
 * is missing. The reasons never leave this module through `connectedAccounts`
 * (every caller reads only the map); runPublish reads them so a platform that
 * skipUnconnected drops is recorded with the vendor's own words.
 */
interface ConnectedSweep {
  map: ConnectedMap;
  /** One entry per platform absent from `map`: the sweep walks ALL_PLATFORMS. */
  reasons: Map<Platform, string>;
}

let _connectedCache: { sweep: ConnectedSweep; expiresAt: number } | null = null;

/**
 * Bumped by every invalidate. A sweep writes the cache only if no invalidate
 * happened while it ran: one started before the OAuth connect callback was built
 * against the old state, and caching its answer made the account just connected
 * read as "not connected" for the next minute (the 409 oauth-routes.ts names).
 */
let _connectedGeneration = 0;

/**
 * The sweep currently running, if one is.
 *
 * ⚠️ THIS IS A SINGLE-FLIGHT, NOT A SECOND CACHE, and the difference is the
 * whole reason it is safe next to `{fresh: true}`. It holds an IN-PROGRESS
 * promise and is cleared the moment that promise settles, so two callers that
 * overlap share one round of vendor calls while two callers in different ticks
 * still get two sweeps — the deliberate cache bypass is untouched. Caching the
 * RESULT here instead would silently turn `fresh` into "up to one tick stale",
 * which is exactly what publishing against a disconnected account looks like.
 *
 * The same shape as a token-refresh single-flight map, and for the same
 * reason: a per-process bound on concurrent identical work.
 */
let _connectedInFlight: Promise<ConnectedSweep> | null = null;

/** Drop the cached map. For a disconnect flow, or to isolate tests. */
export function invalidateConnectedAccounts(): void {
  _connectedCache = null;
  _connectedGeneration += 1;
  // A sweep already in progress was started against the old routing, so a
  // caller arriving after the invalidation must not be handed it.
  _connectedInFlight = null;
}

/**
 * Everything that can be published to right now.
 *
 * ⛔ A PLATFORM WITH NO ROUTE IS ABSENT FROM THIS MAP, and that is the single
 * fact the whole publish path is built on: `sendable` is `renders.filter(r =>
 * connected[r.platform])`, so an absent platform is skipped with a message
 * rather than attempted.
 *
 * Two conditions put a platform here, both required: something is registered to
 * serve it, AND `transportOverrides` routes the platform there. Registration
 * alone is not routing — all nine transports register at boot, so keying off the
 * registry would report every platform as live regardless of whether an operator
 * had ever verified its credential. `resolveRoute` consults the override;
 * `registeredTransportFor` does not, and mixing them up silently softens a QA
 * gate for all nine platforms.
 *
 * A transport that cannot ANSWER is treated as disconnected rather than allowed
 * to throw: one unreachable vendor must not stop a publish to the other eight.
 * The platform lands in `skipped`, which an operator can act on, instead of a
 * stack trace. The same holds for an unreachable AGGREGATOR: it must not take
 * down publishing for platforms that never touch it.
 */
export async function connectedAccounts(
  opts: { fresh?: boolean } = {},
): Promise<ConnectedMap> {
  return (await connectedSweep(opts)).map;
}

/** connectedAccounts with the reasons kept. See ConnectedSweep. */
async function connectedSweep(opts: { fresh?: boolean }): Promise<ConnectedSweep> {
  if (!opts.fresh && _connectedCache && _connectedCache.expiresAt > Date.now()) {
    return _connectedCache.sweep;
  }
  // Join a sweep already underway rather than starting a second one. A publish
  // and the channel-rules refresh both ask for a fresh map, and overlapping
  // them would otherwise mean two full rounds of vendor calls against the same
  // credentials in the same tick.
  const running = _connectedInFlight;
  if (running) return running;

  const sweep = sweepConnectedAccounts();
  _connectedInFlight = sweep;
  try {
    return await sweep;
  } finally {
    // Only if it is still ours: an `invalidateConnectedAccounts()` mid-sweep may
    // already have cleared it and a newer sweep may already own the slot.
    if (_connectedInFlight === sweep) _connectedInFlight = null;
  }
}

/**
 * One round of vendor status calls, across every routed platform AT ONCE.
 *
 * ⚠️ Parallel, and the ordering it must preserve is the MAP's, not the calls'.
 * `ALL_PLATFORMS` order decides key insertion order, and the publish path reads
 * `skipped` out of it, so the results are collected positionally and folded in
 * afterwards rather than written as each vendor answers.
 *
 * The per-platform try/catch stays exactly where it was: a transport that
 * cannot ANSWER is treated as disconnected rather than allowed to throw, so one
 * unreachable vendor lands in `skipped` instead of taking the other eight down
 * with it. `Promise.all` is safe here only because nothing inside can reject.
 */
async function sweepConnectedAccounts(): Promise<ConnectedSweep> {
  const generation = _connectedGeneration;
  /**
   * ⛔ ONE ACCOUNT-LIST ROUND TRIP PER AGGREGATOR, NOT ONE PER PLATFORM.
   *
   * An aggregator serves K platforms on ONE credential and one rate limit, so
   * asking it per platform must not turn a single round trip into K. That is
   * the "N connections for one account" failure the Aggregator docblock
   * forbids, and the aggregator itself carries the guard: its connectStatus
   * reads a memoised, single-flighted account list (zernio-aggregator.ts's
   * `accounts()`), so the K parallel calls below share one vendor request.
   *
   * No second memo keyed by `aggregator|platform` belongs here: each platform
   * appears once per sweep, so that key could never repeat and the memo would
   * never hit.
   */
  type StatusEntry =
    | { platform: Platform; account: NonNullable<ConnectedMap[Platform]> }
    | { platform: Platform; reason: string };
  const found = await Promise.all(
    ALL_PLATFORMS.map(async (platform): Promise<StatusEntry> => {
      const route = await resolveRoute(platform);
      if (route.kind === "no-route") return { platform, reason: noRouteMessage(platform, route.reason) };

      try {
        let status: DirectConnectStatus | null;
        if (route.kind === "direct") {
          status = await route.transport.connectStatus();
        } else {
          // Per platform: each is its own connected account inside the one
          // credential. The shared account list is memoised by the aggregator.
          status = await route.aggregator.connectStatus(platform);
        }
        if (!status?.connected) {
          return { platform, reason: status?.reason ?? "the transport reports it is not connected" };
        }
        return {
          platform,
          account: { accountId: status.accountId, displayName: status.displayName },
        };
      } catch (err) {
        console.warn(`[socialhq] ${platform} transport could not report status: ${String(err)}`);
        return { platform, reason: `status check failed: ${getErrorMessage(err)}` };
      }
    }),
  );

  const map: ConnectedMap = {};
  const reasons = new Map<Platform, string>();
  for (const entry of found) {
    if ("account" in entry) map[entry.platform] = entry.account;
    else reasons.set(entry.platform, entry.reason);
  }
  const sweep = { map, reasons };
  if (generation === _connectedGeneration) {
    _connectedCache = { sweep, expiresAt: Date.now() + CONNECTED_TTL_MS };
  }
  return sweep;
}

/**
 * What a subreddit accepts, in the shape the publish-time refusals consume.
 *
 * `allow` is derived from Reddit's own `/about` and `/post_requirements` by
 * reddit-transport's `destinationRules`, in three values: "self" (a normal
 * text post), "link", "media" (image or video). A sub answering `["self"]`
 * rejects an image post outright, and a publish refused that way can end in an
 * ERROR state with nothing surfaced anywhere.
 */
export interface SubredditRestrictions {
  subreddit: string;
  allow: string[];
  isFlairRequired: boolean;
  flairs: Array<{ id: string; name: string }>;
}

/**
 * Normalise `destinationRules`' loose record into the shape above.
 *
 * The transport returns `Record<string, unknown>` by interface (a Pinterest
 * board list and a subreddit's rules have nothing in common), so this is where
 * the Reddit-specific reading of it lives. Every field degrades rather than
 * throwing: `post_requirements` and the flair list need scopes the token may
 * not carry, and reddit-transport already omits them on failure — a missing
 * field must mean "unknown", never "not required".
 */
function readSubredditRules(subreddit: string, raw: Record<string, unknown>): SubredditRestrictions {
  const allow: string[] = [];
  if (raw.allowSelf !== false) allow.push("self");
  if (raw.allowLink !== false) allow.push("link");
  // ⛔ "media" IS NEVER ALLOWED, and that is about this transport, not the
  // subreddit. reddit-transport.ts refuses all media publishing outright, and
  // reddit.ts deliberately does not read `allow_images` because that field
  // could not be confirmed on any official page. So an image on a Reddit render
  // is dropped at publish time no matter what the subreddit permits.
  //
  // Saying so here is what makes QA warn about it (`subreddit-no-media`) before
  // the post goes out, rather than the operator finding a text-only post where
  // they attached a card. Claiming media is allowed would silence that warning
  // for every subreddit.
  const flairs = Array.isArray(raw.flairs)
    ? (raw.flairs as Array<{ id?: unknown; name?: unknown }>)
        .filter((f) => f && typeof f.id === "string" && typeof f.name === "string")
        .map((f) => ({ id: f.id as string, name: f.name as string }))
    : [];
  return {
    subreddit,
    allow,
    isFlairRequired: raw.isFlairRequired === true,
    flairs,
  };
}

/**
 * Look up what the draft's target subreddit accepts, for the publish path.
 *
 * A failed lookup returns null and publishing proceeds on the defaults: this
 * exists to stop a post being refused, and it would be perverse for the check
 * itself to become the thing that blocks one.
 */
export async function resolveRedditRestrictions(
  renders: PlatformRender[],
  connected: ConnectedMap,
): Promise<SubredditRestrictions | null> {
  const reddit = renders.find((r) => r.platform === "reddit");
  if (!reddit || !connected.reddit) return null;
  const subreddit = normalizeSubreddit(reddit.subreddit ?? defaults().subreddit);
  if (!subreddit) return null;
  // ⚠️ The ROUTE, so an aggregator-held Reddit reads its flair and rules from
  // the aggregator that will actually publish. Asking the direct transport
  // would return rules for an account the post is not going to.
  const routed = await routeTransportFor("reddit");
  const transport = routed?.transport;
  if (!transport?.destinationRules) return null;
  try {
    return readSubredditRules(subreddit, await transport.destinationRules(subreddit));
  } catch (err) {
    console.warn(
      `[socialhq] could not read r/${subreddit} restrictions, publishing on defaults:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Refuse a Pinterest publish that has nowhere to land, before anything is sent.
 *
 * Pinterest cannot accept a pin without a board id, and the two ways that goes
 * wrong are both invisible at the vendor boundary: the account has no boards at
 * all (a common state for a new account), or the configured
 * default is a stale id. Either produces a generic rejection with no usable
 * cause, so both are named here while the available boards are in hand.
 *
 * A lookup FAILURE is not a publish failure: an unreachable or unreadable boards
 * call returns quietly and publishing proceeds, exactly as the Reddit
 * restrictions lookup does. Only a definitive answer refuses.
 */
export async function assertPinterestBoard(
  renders: PlatformRender[],
  connected: ConnectedMap,
): Promise<void> {
  const pin = renders.find((r) => r.platform === "pinterest");
  const account = connected.pinterest;
  if (!pin || !account) return;
  const wanted = pin.board?.id ?? defaults().pinterestBoard;
  // No board configured at all is assertPublishable's error to raise, and it
  // words it in terms of what to set. Do not pre-empt it with a worse message.
  if (!wanted) return;

  /**
   * ⚠️ Ask the SAME vendor the publish is about to go to.
   *
   * Falling back to an aggregator's boards endpoint when no direct transport
   * is resolved would hand it a PINTEREST account id where it expects one of
   * ITS OWN channel ids. A throw would be harmless (the catch below warns and
   * proceeds), but an empty list reads as a DEFINITIVE answer and refuses
   * every Pinterest publish with "the account has no boards", which looks like
   * a Pinterest problem and is not. Changing a route silently changes what an
   * id MEANS, and every consumer of that id has to be told.
   */
  const routed = await routeTransportFor("pinterest");
  const transport = routed?.transport;
  if (!transport?.listBoards) return;
  let boards;
  try {
    boards = await transport.listBoards();
  } catch (err) {
    console.warn(
      "[socialhq] could not read Pinterest boards, publishing on defaults:",
      err instanceof Error ? err.message : err,
    );
    return;
  }
  return assertBoardAmong(boards, wanted, account.displayName);
}

/** The two definitive refusals. */
function assertBoardAmong(
  boards: Array<{ id: string; name: string }>,
  wanted: string,
  displayName: string,
): void {
  if (!boards.length) {
    throw new PublishPreflightError(
      `the Pinterest account "${displayName}" has no boards, so a pin has nowhere to go. ` +
        `Create a board in Pinterest first, then set it as the default in Social HQ settings.`,
    );
  }
  if (!boards.some((b) => b.id === wanted)) {
    throw new PublishPreflightError(
      `Pinterest board "${wanted}" does not exist on "${displayName}". ` +
        `Available: ${boards.map((b) => `${b.name} (${b.id})`).join(", ")}.`,
    );
  }
}

/**
 * Which kind of Reddit post to submit, or null when the subreddit accepts
 * nothing we can produce.
 *
 * Not just `mediaCount === 1 ? "media" : "self"`, which asks the draft what
 * kind of post it is and never asks the subreddit whether that kind is
 * allowed. Most subreddits are text-only: r/smallbusiness answers
 * `allow: ["self"]`, so attaching a single image would silently turn a valid
 * text post into an image post that Reddit refuses, with no message, no
 * notification, and no `lastError` on this side.
 *
 * With no restrictions loaded this falls back to that media-count rule, since
 * the lookup is an enhancement and must not become a new way for publishing
 * to fail.
 */
function redditPostType(
  mediaCount: number,
  restrictions?: SubredditRestrictions | null,
): "media" | "self" | null {
  const allow = restrictions?.allow;
  if (!allow?.length) return mediaCount === 1 ? "media" : "self";
  if (mediaCount === 1 && allow.includes("media")) return "media";
  // Falling back to a text post drops the image rather than the whole post.
  // QA warns about that before publish so it is not a silent downgrade.
  return allow.includes("self") ? "self" : null;
}

/** A URL with its utm_* parameters removed, for comparing two destinations. */
function withoutUtm(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  for (const key of [...parsed.searchParams.keys()]) {
    if (key.startsWith("utm_")) parsed.searchParams.delete(key);
  }
  return parsed.toString();
}

/**
 * The pin's click-through: the render's tracked `pinLink` (the post's link with
 * its UTMs) while it still points at `link`, else `link` itself.
 *
 * The check is what keeps a stale stamp from publishing: `pinLink` is stamped
 * by the tracking pass, which does nothing once the destination stops being
 * trackable, so after an edit to `source.link` the old stamp would otherwise
 * send the pin to the previous page.
 */
function pinDestination(r: PlatformRender, link: string): string {
  if (!r.pinLink) return link;
  const target = withoutUtm(link);
  return target !== null && withoutUtm(r.pinLink) === target ? r.pinLink : link;
}

/**
 * The draft-and-settings half of a publish: everything a transport needs that
 * lives on the DRAFT or in Social HQ settings rather than on the render.
 *
 * Shares its resolution rules with `assertPublishable()` below rather than
 * restating them — a board or subreddit resolved one way here and another way
 * there is exactly the two-hand-maintained-copies bug provider-map.ts's header
 * records. The REFUSALS live in assertPublishable because a missing board or
 * subreddit must fail identically however the publish was started.
 */
export function publishDestination(r: PlatformRender, source: SourcePost): PublishDestination {
  const def = defaults();
  switch (r.platform) {
    case "pinterest": {
      const title = r.title ?? source.title;
      return {
        board: r.board?.id ?? def.pinterestBoard,
        // The reason this type exists. A Pinterest pin's click-through URL is
        // its own field, and the Pinterest playbook strips URLs out of the copy
        // precisely because the link is meant to travel here. A direct pin
        // published without it succeeds and goes nowhere.
        ...(source.link ? { link: pinDestination(r, source.link) } : {}),
        ...(title ? { title: title.slice(0, 100) } : {}),
      };
    }
    case "reddit": {
      // ⛔ TITLE IS REQUIRED BY REDDIT ON EVERY SUBMISSION KIND, and nothing
      // populated it here. A direct Reddit publish would fail on every draft
      // whose render happened not to carry its own title, with an error about a
      // missing field rather than about the missing default. Same fallback the
      // youtube case uses, capped at Reddit's documented 300.
      const title = r.title ?? source.title;
      return {
        subreddit: normalizeSubreddit(r.subreddit ?? def.subreddit) ?? undefined,
        ...(title ? { title: title.slice(0, 300) } : {}),
        ...(r.flair ? { flair: r.flair } : {}),
      };
      // ⚠️ `link` is DELIBERATELY NOT SET, unlike the pinterest case above.
      // Reddit models a link post and a self post as different things: a link
      // post has a URL and NO body, so populating `link` here would turn every
      // Reddit publish into a body-less link submission and silently discard
      // `render.content` — the actual copy. Reddit's links are clickable inside
      // a self post, so the link already travels in the body where the formatter
      // put it. See reddit-transport.ts's publishNow.
    }
    case "youtube":
      return { title: r.title ?? source.title ?? r.content.slice(0, 90) };
    default:
      // Every other platform carries everything it needs on the render itself.
      return {};
  }
}

/**
 * Every reason to refuse a publish that can be known WITHOUT calling a vendor.
 * Throws `PublishPreflightError`; returns nothing on success.
 *
 * ⚠️ Called for its throw rather than a return value: the refusals are the
 * whole function, with no per-platform `settings` object built alongside.
 *
 * QA calls it too, so a draft is refused at review time rather than at publish
 * time — the same reason the `no-route` check exists.
 */
export function assertPublishable(
  r: PlatformRender,
  draft: Draft,
  /**
   * What the target subreddit actually accepts. Optional because QA calls this
   * synchronously; only the publish path, which can await the lookup, has it.
   */
  restrictions?: SubredditRestrictions | null,
): void {
  const def = defaults();
  switch (r.platform) {
    case "pinterest": {
      // Pinterest cannot accept a pin without a board id. Sending none produces
      // a generic vendor 400 whose cause never reaches the operator, so refuse
      // before anything is sent.
      const board = r.board?.id ?? def.pinterestBoard;
      if (!board) {
        throw new PublishPreflightError(
          `pinterest needs a destination board. Set one on the draft, or set a default ` +
            `(Social HQ settings "defaultPinterestBoard", or SOCIALMETA_DEFAULT_PINTEREST_BOARD).`,
        );
      }
      return;
    }
    case "reddit": {
      const subreddit = normalizeSubreddit(r.subreddit ?? def.subreddit);
      if (!subreddit) {
        throw new PublishPreflightError(
          `reddit needs a target subreddit. Set one on the draft, or set a default ` +
            `(Social HQ settings "defaultSubreddit", or SOCIALMETA_DEFAULT_SUBREDDIT).`,
        );
      }
      const mediaCount = r.mediaIndices.filter((i) => draft.source.media[i]).length;
      if (!redditPostType(mediaCount, restrictions)) {
        // redditPostType only refuses a NON-EMPTY allow list without "self", so the
        // joined list is never empty here (there was no "nothing we can post" case).
        throw new PublishPreflightError(
          `r/${subreddit} accepts only ${restrictions!.allow.join(", ")} ` +
            `(a text post is not allowed there), so this draft cannot be published to it.`,
        );
      }
      // Reddit rejects the submission outright when the sub mandates a flair
      // and none is set, and reports it as a bare error with no message, so
      // refuse here where the available flairs can be named.
      if (restrictions?.isFlairRequired && !r.flair) {
        throw new PublishPreflightError(
          `r/${subreddit} requires a post flair. Set one on the draft` +
            (restrictions.flairs.length
              ? `; available: ${restrictions.flairs.map((f) => f.name).join(", ")}.`
              : "."),
        );
      }
      return;
    }
    default:
      return;
  }
}

/** One value a render is published as, and what it is on the platform. */
export interface SentValue {
  kind: "content" | "reply" | "firstComment";
  text: string;
}

/**
 * The platforms whose direct transport publishes `threadItems` as replies
 * after the root: x-transport.ts and bluesky-transport.ts `publishNow`, and
 * threads-transport.ts `chainItems`. Every other transport ignores them.
 */
const SENDS_REPLIES: ReadonlySet<Platform> = new Set<Platform>(["twitter", "bluesky", "threads"]);

/**
 * Every value this render is published as, in the order the platform's direct
 * transport sends them: the root, then each reply, then the first comment.
 * Pinned against each transport by sent-contents.test.ts.
 *
 * A Zernio-routed leg sends no first comment and threads only X, so for those
 * legs this is a superset, and QA errs strict rather than blind.
 */
export function sentValues(r: PlatformRender): SentValue[] {
  const out: SentValue[] = [{ kind: "content", text: r.content }];
  if (SENDS_REPLIES.has(r.platform)) {
    for (const text of threadReplies(r)) out.push({ kind: "reply", text });
  }
  if (r.firstComment && SENDS_FIRST_COMMENT.has(r.platform)) {
    out.push({ kind: "firstComment", text: r.firstComment });
  }
  return out;
}

/**
 * The content strings this render will be published as, in order. Exported
 * because QA has to length-check exactly these: every platform applies its
 * maximum to every value it receives, and a check that assumes the body is the
 * only one misses most of what it is validating.
 */
export function sentContents(r: PlatformRender): string[] {
  return sentValues(r).map((v) => v.text);
}

export interface PublishOptions {
  /** ISO datetime to schedule; mutually exclusive with now. */
  at?: string;
  now?: boolean;
  /** Continue even if some target platforms are not connected. */
  skipUnconnected?: boolean;
}

/** A platform's reply chain as it stands the moment the root goes live. */
export interface PublishThreadState {
  platform: Platform;
  /** Vendor handles a later reply needs to attach to the chain. */
  root?: Record<string, string>;
  /** Replies deferred by a follow-up delay, for publish-due to release. */
  queued: DirectQueuedReply[];
  /**
   * Replies posted inline with the root (DirectPublishResult.replyRefs), by
   * 1-based position, so a delete can remove them: deleting the root does not
   * delete its replies on X or Bluesky. Present only for an inline thread.
   */
  done?: Array<{ position: number; ref: string }>;
}

export interface PublishResult {
  /**
   * The comma-joined entry list, ONE PER PLATFORM SENT (each platform's post is
   * independent remotely; deleting one does not touch the others). See the
   * codec in transport.ts.
   */
  providerPostId?: string;
  /**
   * The legs that went out (on `now`) or were scheduled (on `at`). A leg whose
   * send failed is NOT here: a refusal stays `pending` in providerPostId for the
   * publish ring to retry, an unknown outcome is `failed` (see
   * unknownOutcomeError), and the reason is in `draft.lastError`.
   *
   * ⛔ Not every sendable leg whatever happened to it: that would make a caller
   * report a platform as published when its vendor threw.
   */
  sent: Array<{ platform: Platform; accountId: string }>;
  skipped: Platform[];
  /**
   * Reply chains the publish opened, for the caller to persist: the replies a
   * deferred chain still owes, and the refs of the ones an inline chain posted.
   *
   * ⛔ WITHOUT THIS, A `--now` PUBLISH OF A THREAD SILENTLY LOSES EVERY
   * DEFERRED REPLY. `transport.publishNow` returns `queued` and `threadRoot`
   * whenever a render carries a follow-up delay, and publish-due persists both
   * when IT releases a leg, but the inline path has nowhere else to put them.
   * The root would go out, the rest of the thread would never exist, and
   * nothing would report it: the draft settles as `published` because every
   * leg is terminal.
   *
   * The engine cannot write `threadState` itself (no prisma), so this is the
   * channel. A caller that ignores it loses the replies, which is why the
   * caller must persist it in the same update as `providerPostId`.
   */
  threads: PublishThreadState[];
}

/**
 * Thrown for failures detected BEFORE anything is sent to a vendor. Callers use
 * this to tell "we refused to send" apart from "the send itself broke", so a
 * rejected request does not get recorded as a failed publish attempt.
 */
export class PublishPreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishPreflightError";
  }
}

/**
 * Thrown when the publish broke BEFORE the first byte reached any vendor, for a
 * reason the operator is not meant to read (a media upload failing, a database
 * read throwing, a transport resolver blowing up).
 *
 * PublishPreflightError already covers "we refused to send, and here is why in
 * plain language". This covers the other half of the same question: an
 * UNEXPECTED throw that still sent nothing. Both must return the draft to its
 * previous status, because a draft nothing was sent for is not a failed
 * publish, and `failed` is a status the UI offers no way out of.
 *
 * ⛔ The distinction is `dispatched`, not the error type. Once createPost or a
 * transport's publishNow has been entered, a real post may exist remotely, and
 * restoring the draft to `scheduled` there would invite a retry that publishes
 * it a SECOND time — the exact duplicate-post failure the terminal-state guard
 * at the top of publishDraft exists to prevent. When in doubt the draft stays
 * `failed`: an operator can see and clear that, where a silent double-post is
 * unrecoverable.
 */
export class PublishNotSentError extends Error {
  constructor(override readonly cause: unknown) {
    super(getErrorMessage(cause));
    this.name = "PublishNotSentError";
  }
}

/** How many source assets upload at once. See the upload loop in runPublish. */
const MEDIA_UPLOAD_CONCURRENCY = 3;

/** One leg's slot in the positional result array. See `outcomes` in runPublish. */
interface LegOutcome {
  entry: ProviderPostEntry;
  /** True once the vendor accepted the post; only these legs count as sent. */
  sent?: boolean;
  error?: string;
  /** Post-live problems (a failed first comment); see DirectPublishResult.warnings. */
  warnings?: string[];
  thread?: PublishThreadState;
}

/**
 * What two legs must NOT be sent concurrently for.
 *
 * Derived from the entry the route itself stamps rather than from the platform,
 * because that entry is the only thing that names the credential: an aggregator
 * leg carries its `aggregatorId`, a direct leg carries only its platform (and
 * each direct transport is its own credential). Reading it back off the encoded
 * entry keeps this in step with the codec for free — a new namespace groups
 * correctly the day it exists, rather than the day someone remembers this
 * function.
 */
function routeKeyOf(entry: ProviderPostEntry): string {
  if (entry.kind === "aggregator") return `aggregator:${entry.aggregatorId}`;
  // Everything else already holds its own credential, and its raw form already
  // distinguishes it: a direct leg's is `<platform>:pending`, one per platform.
  // A legacy entry cannot reach here (`stateEntry` never produces one) and would
  // land in a group of its own rather than serialising every leg behind it.
  return `credential:${entry.raw}`;
}

/**
 * The lastError text for a leg whose create may have landed without an answer.
 *
 * Shared by both publish paths (this inline one and publish-due's release) so
 * the operator reads one instruction whichever path sent the leg.
 */
export function unknownOutcomeError(platform: Platform, reason: string): string {
  return (
    `${platform}: outcome unknown, the post may already be live (${reason}). ` +
    `It was not retried, to avoid a duplicate. Check ${platform}, and use Retry only if the post is not there.`
  );
}

/**
 * Send ONE leg and record its outcome in place.
 *
 * Nothing throws out of here: a vendor failing must not cost the legs that
 * already went out, so a failure leaves the seeded `pending` entry (stamped with
 * the ROUTE, so the retry goes back through the same place it was meant to go)
 * and records the reason.
 *
 * ⛔ EXCEPT AN UNKNOWN OUTCOME, WHICH IS `failed`. A 5xx, a timeout or a dropped
 * connection on a create may mean the post landed and only the answer was lost
 * (retry.ts), and a `pending` leg is re-sent by the ring on its next tick: a
 * second live post. `failed` stops the ring, and the operator's Retry (the
 * rearm route) is the only way back, after they have looked.
 */
async function publishLeg(
  r: PlatformRender,
  routed: RoutedPublish,
  outcome: LegOutcome,
  draft: Draft,
  redditRules: SubredditRestrictions | null,
  state: { dispatched: boolean },
): Promise<void> {
  const transport = routed.transport;
  try {
    // Before anything else: a video on a platform whose transport cannot send
    // one (SPECS.publishesVideo, the single switch) is refused here for every
    // transport alike, rather than trusting each transport to refuse it (a
    // transport that drops it would post text-only). QA fails the same
    // render as `video-unsupported`, so reaching this means QA was bypassed.
    if (unpublishableVideoIndices(r.platform, draft.source.media, r.mediaIndices).length > 0) {
      throw new PublishPreflightError(
        `${SPECS[r.platform].displayName} cannot publish video yet, and this draft's ${r.platform} render selects one. ` +
          "Select an image for it instead, or drop it from the targets, so the other platforms in this publish can still go out.",
      );
    }
    const selected = r.mediaIndices
      .map((i) => draft.source.media[i])
      .filter((m): m is NonNullable<typeof m> => Boolean(m));
    // Fit to THIS platform, not to the tightest platform in the set. The stored
    // asset is shared by every leg, so re-encoding it once at compose time would
    // let Bluesky's 1MB limit decide Instagram's image quality. Here the
    // destination is known. No-ops when the asset already complies, and when no
    // re-encoder is wired (the CLI).
    const assets = await fitForTransport(selected, transport.channelRules());
    // The last preflight refusals, immediately before the send: a missing
    // Pinterest board or a subreddit that will not take this post must fail
    // here, where nothing has gone out yet, rather than as a vendor error.
    assertPublishable(r, draft, r.platform === "reddit" ? redditRules : null);
    // ⚠️ A plain boolean write on a SHARED object, from several legs at once.
    // That is safe on purpose and not an oversight: it is monotonic (nothing
    // ever sets it back to false) and JavaScript gives each leg the event loop
    // uninterrupted between awaits, so there is no interleaving to lose. What it
    // must keep meaning is "at least one leg has reached a vendor", which is the
    // question publishDraft asks when it decides whether a throw can safely
    // restore the draft's previous status.
    state.dispatched = true;
    const published = await transport.publishNow({
      render: r,
      media: assets,
      draftId: draft.id,
      destination: publishDestination(r, draft.source),
    });
    outcome.entry = routed.entry(published.ref);
    outcome.sent = true;
    if (published.warnings?.length) outcome.warnings = published.warnings.map((w) => `${r.platform}: ${w}`);
    // A follow-up delay on the render means the transport posted the root and
    // handed back the rest. Capturing it here is what stops a `--now` thread
    // publish from losing every reply after the first.
    if (published.queued?.length || published.threadRoot) {
      outcome.thread = {
        platform: r.platform,
        ...(published.threadRoot ? { root: published.threadRoot } : {}),
        queued: published.queued ?? [],
      };
    } else if (published.replyRefs) {
      // An inline thread: nothing is owed, but its replies are live posts of
      // their own, and recording them is the only way a delete can reach them.
      outcome.thread = {
        platform: r.platform,
        queued: [],
        done: published.replyRefs.map((ref, i) => ({ position: i + 1, ref })),
      };
    }
  } catch (err) {
    const reason = getErrorMessage(err);
    if (isUnknownOutcome(err)) {
      outcome.entry = routed.stateEntry("failed");
      outcome.error = unknownOutcomeError(r.platform, reason);
      return;
    }
    outcome.error = `${r.platform}: ${reason}`;
  }
}

export async function publishDraft(
  draft: Draft,
  opts: PublishOptions,
): Promise<PublishResult> {
  const state = { dispatched: false };
  try {
    return await runPublish(draft, opts, state);
  } catch (err) {
    if (!state.dispatched && !(err instanceof PublishPreflightError)) {
      throw new PublishNotSentError(err);
    }
    throw err;
  }
}

async function runPublish(
  draft: Draft,
  opts: PublishOptions,
  state: { dispatched: boolean },
): Promise<PublishResult> {
  // Terminal-state guard. Every caller (web route, copilot tool, CLI) funnels
  // through here, so this is the one place that can stop a draft being sent
  // twice. A second send creates a SECOND real post and overwrites
  // providerPostId with its id, orphaning the first one: it stays live and
  // nothing in this system can find or cancel it again.
  if (draft.providerPostId) {
    throw new PublishPreflightError(
      `draft ${draft.id} was already sent (post ${draft.providerPostId}, status "${draft.status}"). ` +
        `Delete or reschedule that post instead of publishing again.`,
    );
  }

  // Always live for the actual send: publishing against a stale map could target
  // an account that has since been disconnected, and one extra round trip is
  // irrelevant next to the cost of a misdirected or failed post.
  const { map: connected, reasons: notConnected } = await connectedSweep({ fresh: true });

  const sendable = draft.renders.filter((r) => connected[r.platform]);
  const skipped = draft.renders
    .map((r) => r.platform)
    .filter((p) => !connected[p]);

  if (!sendable.length) {
    throw new PublishPreflightError(
      `none of the target platforms are connected (targets: ${draft.renders.map((r) => r.platform).join(", ")})`,
    );
  }
  if (skipped.length && !opts.skipUnconnected) {
    throw new PublishPreflightError(
      `platforms not connected: ${skipped.join(", ")}. ` +
        `Connect them, or pass --skip-unconnected.`,
    );
  }

  // Belt to formatPost's braces: renders formatted BEFORE deterministic card
  // routing existed can still carry a multi-card selection, and publish is the
  // last point where it can be corrected without republishing. Only shrinks
  // multi-attach selections on generated card sets; see media-pick.ts.
  normalizeCardMediaIndices(draft.source.media, sendable);

  // Assets are independent of each other, so they upload a few at a time rather
  // than one after another: a serial loop makes a three-card draft pay three
  // full media store round trips end to end before the first vendor call.
  // Bounded rather than unbounded because these are whole files in memory and
  // the process serves other requests. ⚠️ A rejection still aborts the publish
  // (nothing has been dispatched yet, so publishDraft raises
  // PublishNotSentError); up to two sibling uploads in the same chunk may
  // finish before it does, which is harmless: their bytes are the operator's
  // own media.
  // Only the union of what the sendable renders SELECT (after the card
  // normalization above): an unselected asset, or one only a skipped render
  // picked, is never published, so uploading it would put the operator's bytes
  // on a public URL for nothing.
  const selectedIndices = new Set(sendable.flatMap((r) => r.mediaIndices));
  const toUpload = draft.source.media.filter((_m, i) => selectedIndices.has(i));
  for (let i = 0; i < toUpload.length; i += MEDIA_UPLOAD_CONCURRENCY) {
    const chunk = toUpload.slice(i, i + MEDIA_UPLOAD_CONCURRENCY);
    await Promise.all(chunk.map((m) => ensureUploaded(m)));
  }

  // Per-destination config, read from the same vendor the publish is going to.
  const redditRules = await resolveRedditRestrictions(sendable, connected);
  await assertPinterestBoard(sendable, connected);

  // `at` is validated BEFORE anything is sent. Assigned to the draft only
  // afterwards and unchecked, a malformed value would create a real scheduled
  // post and then blow up on persistence, leaving a live post with no local
  // record of it.
  if (opts.at) {
    const when = new Date(opts.at);
    if (Number.isNaN(when.getTime())) {
      throw new PublishPreflightError(`scheduled time is not a valid datetime: ${opts.at}`);
    }
    if (when.getTime() <= Date.now()) {
      throw new PublishPreflightError(`scheduled time must be in the future: ${when.toISOString()}`);
    }
  } else if (!opts.now) {
    throw new PublishPreflightError("publish needs --now or --at <ISO datetime>");
  }

  /**
   * ⛔ THE ROUTE IS RESOLVED BEFORE THE `now` BRANCH, NOT INSIDE IT.
   *
   * Writing `directStateEntry(r.platform, "pending")` in the scheduled branch
   * with no route lookup would stamp an aggregator-routed platform (which
   * `connectedAccounts` counts as sendable) `reddit:pending`, direct-shaped.
   * publish-due then releases a direct-shaped leg through
   * `registeredTransportFor`, i.e. the direct Reddit transport, which is not
   * the route the operator chose.
   *
   * And `!opts.now` is the SCHEDULED path: cadence and autopilot, which is most
   * of the volume. So the leg has to be stamped with the route that will
   * actually send it, whether it goes out now or in six hours.
   */
  const routes = await Promise.all(sendable.map((r) => routeTransportFor(r.platform)));

  /**
   * One slot per leg, POSITIONAL, seeded before anything is sent.
   *
   * ⛔ THE SEED IS THE FAILURE BEHAVIOUR, NOT A PLACEHOLDER. Every leg starts as
   * the `pending` entry it would become if its send never happened, so a leg
   * that is skipped, that throws, or whose whole group dies is already recorded
   * as retryable by the 15-minute ring. There is no state in which a leg is both
   * un-sent and forgotten, and no path that can leave a hole in this array —
   * which is what lets the legs run concurrently and still be reassembled in the
   * order the operator's renders were in.
   *
   * A leg with NO route falls back to the platform namespace: nothing can stamp
   * it, so publish-due reports it unroutable rather than sending it somewhere
   * nobody chose.
   */
  const outcomes: LegOutcome[] = sendable.map((r, i) => ({
    entry: routes[i] ? routes[i]!.stateEntry("pending") : directStateEntry(r.platform, "pending"),
  }));

  if (opts.now) {
    /**
     * ⛔ PARALLEL ACROSS ROUTES, SERIAL WITHIN ONE.
     *
     * Two legs held by the same aggregator share a credential and a rate limit,
     * so firing them together is how a publish earns a 429 that neither leg
     * deserved. Two legs on different vendors share nothing, and running them
     * end to end made a five-platform publish cost the sum of five vendor
     * latencies for no reason. Grouping by route key is what separates the two
     * cases, and it has to be the ROUTE rather than the platform: `via:zernio:
     * reddit` and `via:zernio:twitter` are one credential wearing two platform
     * names.
     *
     * `allSettled` rather than `all`: a group is already fully guarded per leg,
     * so this exists to make the isolation structural — one group blowing up in
     * an unexpected place cannot cancel the other groups' bookkeeping, and its
     * own legs stay at the seeded `pending`.
     */
    const groups = new Map<string, number[]>();
    for (let i = 0; i < sendable.length; i += 1) {
      if (!routes[i]) {
        // Not sent and not silently pending either: say why, so lastError
        // carries it rather than the leg vanishing from the report.
        outcomes[i]!.error = `${sendable[i]!.platform}: no transport route to publish through; left pending`;
        continue;
      }
      const key = routeKeyOf(outcomes[i]!.entry);
      const existing = groups.get(key);
      if (existing) existing.push(i);
      else groups.set(key, [i]);
    }

    await Promise.allSettled(
      Array.from(groups.values(), async (indices) => {
        for (const i of indices) {
          await publishLeg(sendable[i]!, routes[i]!, outcomes[i]!, draft, redditRules, state);
        }
      }),
    );
  }

  const entries = outcomes.map((o) => o.entry);
  // A platform skipUnconnected dropped is recorded, with the vendor's reason,
  // and FIRST: publish-due's settleLegError clears lastError only when it
  // starts with the platform that just went live, and this drop is permanent
  // (the terminal guard refuses a second publish), so a sent leg recovering
  // later must not wipe the only record of it.
  const errors = [
    // Non-null: every platform absent from the map has a reason (ConnectedSweep).
    ...skipped.map((p) => `${p}: not connected at publish time (${notConnected.get(p)!}), so it was not sent`),
    ...outcomes.flatMap((o) => [...(o.error ? [o.error] : []), ...(o.warnings ?? [])]),
  ];
  const threads = outcomes.flatMap((o) => (o.thread ? [o.thread] : []));

  const providerPostId = encodeProviderPostIds(entries);
  draft.providerPostId = providerPostId;
  draft.lastError = errors.length ? errors.join(" | ") : undefined;

  // mutate the draft in place; the caller owns persistence (file store for the
  // CLI, database for the web app)
  //
  // ⚠️ A draft is only `published` when every leg is terminal. A deferred leg
  // on the `now` path is possible, and marking such a draft published would
  // hide it from the reconcile forever (that scan only looks at `scheduled`
  // and `publishing`), so the pending leg would never be released and never be
  // reported.
  //
  // ⛔ AND THE SAME IS TRUE OF A QUEUED THREAD REPLY. `threads` is collected
  // immediately above and must be consulted here: a `--now` publish whose
  // transport deferred its replies (a follow-up delay) has every leg terminal,
  // and marked `published` it would drop out of the release scan's
  // `status in ("scheduled","publishing")` filter while its replies sat queued
  // forever. Nothing would report it: the root post is live, so the draft
  // looks completely successful.
  //
  // ⚠️ This is the same rule the scheduled path's settle gate applies
  // (`entries.every(isTerminalEntry) && !chainOutstanding(state)`): the gate
  // and the thing it guards must not apply different rules.
  //
  // A settled draft whose every leg is `failed` (unknown outcomes, see
  // publishLeg) is `failed`, not `published`: the same anyLive rule as
  // publish-due's settleDraft. The caller's rearm path takes it back from there.
  const settled =
    entries.every(isTerminalEntry) && !threads.some((t) => t.queued.length > 0);
  if (opts.now && settled && outcomes.some((o) => o.sent)) {
    draft.status = "published";
    draft.publishedAt = new Date().toISOString();
  } else if (opts.now && settled) {
    draft.status = "failed";
  } else {
    draft.status = "scheduled";
    // A leg deferred by a failed "post now" has no scheduled time of its own and
    // is due immediately; publish-due reads a null here as exactly that.
    draft.scheduledFor = opts.at ? new Date(opts.at).toISOString() : undefined;
  }

  return {
    providerPostId,
    // `sendable` already excludes `skipped` (both derive from `connected`).
    // On the scheduled path nothing is sent yet, so every leg counts as
    // scheduled; on `now` only the legs a vendor accepted.
    sent: sendable
      .filter((_r, i) => !opts.now || outcomes[i]!.sent)
      .map((r) => ({
        platform: r.platform,
        accountId: connected[r.platform]!.accountId,
      })),
    skipped,
    threads,
  };
}
