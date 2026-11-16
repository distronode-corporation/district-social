/**
 * Direct-vendor transports, and the codec for the ids they produce.
 *
 * "Platform" and "how a platform is reached" are separate ideas: a platform
 * can be served by its own vendor API or by an aggregator. This module is the
 * seam that lets those two ideas separate, one platform at a time, without a
 * big-bang cutover.
 *
 * Three pieces, deliberately in one file because they are meaningless apart:
 *
 *   1. `DirectTransport` — what a platform's own API has to implement.
 *   2. The registry + override resolver — which implementation (if any) is
 *      LIVE for a platform right now. Cutover is a `SocialSetting` flip, not a
 *      deploy, and rollback is the same flip in reverse.
 *   3. The `providerPostId` codec: how a direct post's id survives in the same
 *      comma-joined column that holds legacy bare aggregator ids, with no
 *      migration.
 *
 * Engine rules apply here: relative imports only, no `@/`, no prisma, no next.
 * The app wires the resolver in; this file never reads a database.
 */

import { withRetry } from "./retry.js";
import { ALL_PLATFORMS, type MediaAsset, type Platform, type PlatformRender } from "./types.js";

/* -------------------------------------------------------------------------- */
/*  providerPostId codec                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A leg that has not reached the platform yet.
 *
 * `publishing` is a claim marker, not a status: publish-due writes it with a
 * compare-and-swap on the exact entry string so two pods cannot release the
 * same leg. A `publishing` entry older than the claim-stale window is reclaimed
 * rather than trusted, because the only way to produce a durable one is a pod
 * dying mid-publish.
 */
export type DirectPendingState = "pending" | "publishing" | "failed";

/**
 * One entry from the comma-joined `SocialDraft.providerPostId`.
 *
 * `raw` is carried on every variant and is load-bearing three times over: the
 * reconcile keys its facts map by the full entry string, publish-due's CAS
 * matches on it exactly, and the "these legs died" operator message prints it.
 * Reconstructing it from the parts would work today and rot the first time the
 * encoding changes.
 */
export type ProviderPostEntry =
  /** A bare aggregator id from before this codec existed. Opaque on purpose. */
  | { kind: "legacy"; raw: string; id: string }
  /** A direct leg that exists on the platform. `ref` is the vendor's own id. */
  | { kind: "direct"; raw: string; platform: Platform; state: "live"; ref: string }
  /** A direct leg that does not exist on the platform (yet, or ever). */
  | { kind: "direct"; raw: string; platform: Platform; state: DirectPendingState; ref: null }
  /** An aggregator-held leg that exists. `ref` is the AGGREGATOR's id, not the vendor's. */
  | {
      kind: "aggregator";
      raw: string;
      aggregatorId: string;
      platform: Platform;
      state: "live";
      ref: string;
    }
  /** An aggregator-held leg that does not exist on the platform (yet, or ever). */
  | {
      kind: "aggregator";
      raw: string;
      aggregatorId: string;
      platform: Platform;
      state: DirectPendingState;
      ref: null;
    };

const PENDING_STATES = new Set<string>(["pending", "publishing", "failed"]);
const PLATFORM_SET = new Set<string>(ALL_PLATFORMS);

/**
 * The namespace marker for an aggregator-held leg: `via:<aggregatorId>:<platform>:<ref>`.
 *
 * ⛔ THIS EXISTS SO A FUTURE AGGREGATOR'S POSTS ARE NOT BORN UNDELETABLE.
 *
 * Bare cuids parse as `legacy`, and the app answers "no longer reachable" for
 * every legacy entry, so a post stored that way can never be deleted from the
 * product. Reusing that shape for an aggregator would reproduce the same dead
 * end on day one.
 *
 * `via` is safe as a discriminator because it is not a Platform, so it can never
 * collide with a direct entry, and a bare cuid has no colon at all so it can
 * never be mistaken for one of these. An OLD pod mid-rolling-update falls into
 * the unrecognised-namespace branch below and treats the leg as opaque, which
 * is precisely the "leave it alone rather than blow up" degradation that branch
 * was written for.
 */
const AGGREGATOR_PREFIX = "via";

/** Aggregator ids are operator-facing and go in a colon-delimited field. */
const AGGREGATOR_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Why splitting on the FIRST colon is safe in both directions:
 *
 *   - Aggregator ids are cuids: `c` followed by base36. No colons, ever, so a
 *     legacy entry can never be mistaken for a namespaced one.
 *   - Every vendor ref we store is comma-free, so the comma join is unambiguous
 *     even though refs themselves are full of colons and slashes
 *     (`urn:li:share:7311…`, `at://did:plc:…/app.bsky.feed.post/3kx…`).
 *
 * The pair of properties is the whole reason this needed no migration.
 */
function parseEntry(raw: string): ProviderPostEntry {
  const colon = raw.indexOf(":");
  if (colon === -1) return { kind: "legacy", raw, id: raw };

  const prefix = raw.slice(0, colon);
  const rest = raw.slice(colon + 1);

  if (prefix === AGGREGATOR_PREFIX) {
    const parsed = parseAggregatorEntry(raw, rest);
    // A malformed `via:` entry degrades to opaque rather than throwing, for the
    // same reason an unknown namespace does: this runs inside publish and
    // reconcile, and one unparseable leg must not take the batch with it.
    if (parsed) return parsed;
    console.warn(`[transport] malformed aggregator providerPostId entry "${raw}", treating as opaque`);
    return { kind: "legacy", raw, id: raw };
  }

  if (!PLATFORM_SET.has(prefix)) {
    // Not ours. Could be a future namespace written by a newer deploy during a
    // rolling update, so it must not throw: an old pod that cannot parse an id
    // should leave that leg alone, not blow up the whole publish or reconcile.
    console.warn(`[transport] unrecognised providerPostId namespace "${prefix}", treating as opaque`);
    return { kind: "legacy", raw, id: raw };
  }

  const platform = prefix as Platform;

  if (rest === "") {
    // A namespace with no ref says nothing about a real post. Same reasoning as
    // above: degrade to opaque rather than throwing inside a publish path.
    console.warn(`[transport] empty ref in providerPostId entry "${raw}", treating as opaque`);
    return { kind: "legacy", raw, id: raw };
  }

  if (PENDING_STATES.has(rest)) {
    return { kind: "direct", raw, platform, state: rest as DirectPendingState, ref: null };
  }

  return { kind: "direct", raw, platform, state: "live", ref: rest };
}

/**
 * Parse the body of a `via:` entry — `<aggregatorId>:<platform>:<ref>`.
 *
 * Returns null on anything malformed so the caller can degrade to opaque. The
 * ref is whatever remains after the second colon, untouched: aggregator ids are
 * as colon-happy as vendor refs and splitting further would corrupt them.
 */
function parseAggregatorEntry(raw: string, rest: string): ProviderPostEntry | null {
  const idEnd = rest.indexOf(":");
  if (idEnd === -1) return null;
  const aggregatorId = rest.slice(0, idEnd);
  if (!AGGREGATOR_ID_RE.test(aggregatorId)) return null;

  const afterId = rest.slice(idEnd + 1);
  const platformEnd = afterId.indexOf(":");
  if (platformEnd === -1) return null;
  const platform = afterId.slice(0, platformEnd);
  if (!PLATFORM_SET.has(platform)) return null;

  const ref = afterId.slice(platformEnd + 1);
  if (ref === "") return null;

  if (PENDING_STATES.has(ref)) {
    return {
      kind: "aggregator",
      raw,
      aggregatorId,
      platform: platform as Platform,
      state: ref as DirectPendingState,
      ref: null,
    };
  }
  return {
    kind: "aggregator",
    raw,
    aggregatorId,
    platform: platform as Platform,
    state: "live",
    ref,
  };
}

/**
 * An entry that still names a route, i.e. anything but `legacy`.
 *
 * Every cleanup path (release, reclaim, expire, delete, reconcile) is written
 * against this rather than against `{kind: "direct"}`. Narrowing to direct was
 * how aggregator legs got silently skipped: the filter looked like a type guard
 * and behaved like a dropped case.
 */
export type RoutableEntry = Exclude<ProviderPostEntry, { kind: "legacy" }>;

/** Parse the stored column. Empty/null yields `[]`, never a `[""]`. */
export function parseProviderPostIds(value: string | null | undefined): ProviderPostEntry[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseEntry);
}

/**
 * Encode back to the column.
 *
 * Returns `undefined` rather than `""` for an empty list, matching what
 * publish.ts has always written: `providerPostId` is nullable and an empty
 * string there would make the terminal guard at publish.ts:362 read as "already
 * sent" while naming no post.
 */
export function encodeProviderPostIds(entries: ProviderPostEntry[]): string | undefined {
  if (!entries.length) return undefined;
  return joinProviderPostIds(entries);
}

/**
 * The column encoding itself, always a string. For callers that already hold a
 * non-empty list and must never write `undefined` (to Prisma that means "leave
 * the column alone"), such as publish-due's compare-and-swap. Everyone else
 * uses encodeProviderPostIds, which maps an empty list to `undefined`.
 */
export function joinProviderPostIds(entries: ProviderPostEntry[]): string {
  return entries.map((e) => e.raw).join(",");
}

/** Build a live direct entry. `ref` must be comma-free; callers pass vendor ids. */
export function directEntry(platform: Platform, ref: string): ProviderPostEntry {
  if (ref.includes(",")) {
    // A comma in a ref would silently split one leg into two on the next parse,
    // and the second half would then be an unparseable orphan. Fail loudly here
    // instead: no vendor in this system issues comma-bearing ids, so hitting
    // this means the caller passed something that is not an id at all.
    throw new Error(`[transport] ${platform} ref contains a comma, which the codec cannot round-trip: ${ref}`);
  }
  const raw = `${platform}:${ref}`;
  return { kind: "direct", raw, platform, state: "live", ref };
}

/** Build a non-live direct entry (`pending` / `publishing` / `failed`). */
export function directStateEntry(platform: Platform, state: DirectPendingState): ProviderPostEntry {
  return { kind: "direct", raw: `${platform}:${state}`, platform, state, ref: null };
}

/** Build an opaque aggregator entry from a bare id. */
export function legacyEntry(id: string): ProviderPostEntry {
  return { kind: "legacy", raw: id, id };
}

/** Build a live aggregator-held entry. `ref` is the aggregator's id for the post. */
export function aggregatorEntry(
  aggregatorId: string,
  platform: Platform,
  ref: string,
): ProviderPostEntry {
  assertAggregatorId(aggregatorId);
  if (ref.includes(",")) {
    throw new Error(
      `[transport] ${aggregatorId}/${platform} ref contains a comma, which the codec cannot round-trip: ${ref}`,
    );
  }
  if (PENDING_STATES.has(ref)) {
    // A ref that is literally "pending" would round-trip as a pending entry and
    // silently lose a live post. No aggregator issues such an id; a caller that
    // gets here is passing a state where a ref belongs.
    throw new Error(`[transport] ${aggregatorId}/${platform} ref "${ref}" collides with a pending state`);
  }
  return {
    kind: "aggregator",
    raw: `${AGGREGATOR_PREFIX}:${aggregatorId}:${platform}:${ref}`,
    aggregatorId,
    platform,
    state: "live",
    ref,
  };
}

/** Build a non-live aggregator-held entry (`pending` / `publishing` / `failed`). */
export function aggregatorStateEntry(
  aggregatorId: string,
  platform: Platform,
  state: DirectPendingState,
): ProviderPostEntry {
  assertAggregatorId(aggregatorId);
  return {
    kind: "aggregator",
    raw: `${AGGREGATOR_PREFIX}:${aggregatorId}:${platform}:${state}`,
    aggregatorId,
    platform,
    state,
    ref: null,
  };
}

/**
 * Rebuild an entry in a NEW state, keeping whatever route it was published by.
 *
 * ⛔ THE ONLY SANCTIONED WAY TO BUILD A REPLACEMENT ENTRY, and the reason is a
 * failure mode with no symptom. `publish-due` rewrites a leg's state seven times
 * (claim, publish, fail, reclaim, expire…), and every one of those rewrites used
 * to call `directStateEntry(entry.platform, …)` — reconstructing the entry from
 * its PLATFORM and silently discarding the `via:<aggregatorId>:` prefix.
 *
 * That matters because `swapEntry` is a compare-and-swap on the WHOLE column
 * string. A replacement built from the platform produces a column the database
 * does not contain, so the UPDATE matches zero rows, and the caller reads zero
 * rows as "another pod won the claim" — which is a normal, unremarkable outcome.
 * The leg would then never release, never fail, never be reclaimed, and never
 * increment any counter. Silent, and permanent.
 *
 * Deriving from the entry instead makes that unrepresentable: an aggregator leg
 * can only ever be rewritten as an aggregator leg.
 *
 * A `legacy` entry has no state to move to and is returned untouched — those ids
 * predate this codec and nothing can act on them (see `legacyIds`).
 */
export function stateEntryLike(
  entry: ProviderPostEntry,
  state: DirectPendingState,
): ProviderPostEntry {
  if (entry.kind === "legacy") return entry;
  if (entry.kind === "aggregator") {
    return aggregatorStateEntry(entry.aggregatorId, entry.platform, state);
  }
  return directStateEntry(entry.platform, state);
}

/** Promote an entry to `live` on the same route it was published by. See `stateEntryLike`. */
export function liveEntryLike(entry: ProviderPostEntry, ref: string): ProviderPostEntry {
  if (entry.kind === "legacy") return entry;
  if (entry.kind === "aggregator") {
    return aggregatorEntry(entry.aggregatorId, entry.platform, ref);
  }
  return directEntry(entry.platform, ref);
}

function assertAggregatorId(aggregatorId: string): void {
  if (!AGGREGATOR_ID_RE.test(aggregatorId)) {
    // Thrown, not warned: an id with a colon in it would write an entry that
    // parses back as a DIFFERENT aggregator and platform, which is worse than
    // refusing to encode it.
    throw new Error(
      `[transport] aggregator id "${aggregatorId}" must match ${String(AGGREGATOR_ID_RE)}`,
    );
  }
}

/** True when a single raw string parses as one of our namespaced entries. */
export function isDirectEntry(raw: string): boolean {
  return parseEntry(raw.trim()).kind === "direct";
}

/**
 * The bare pre-codec ids. Nothing can act on these any more: the aggregator that
 * issued them is unreachable, which is why the app reports them as no longer
 * reachable. Kept so those legs can still be NAMED, not resolved.
 */
export function legacyIds(entries: ProviderPostEntry[]): string[] {
  return entries.filter((e) => e.kind === "legacy").map((e) => e.id);
}

/**
 * True when every leg is a direct one.
 *
 * Deliberately excludes `aggregator` legs as well as `legacy` ones. A caller
 * asking this is asking "can I finish without reaching a third party", and an
 * aggregator-held leg needs the aggregator exactly as a legacy leg needs its
 * issuer. The difference is that an aggregator leg is RESOLVABLE (see
 * `aggregatorEntry`), so a future reconcile can handle it rather than
 * abandoning the batch. That is a separate question from this one.
 */
export function isFullyDirect(entries: ProviderPostEntry[]): boolean {
  return entries.length > 0 && entries.every((e) => e.kind === "direct");
}

/**
 * A leg is terminal when nothing will move it again without operator action.
 * `failed` counts: the retry path rewrites the entry rather than waiting.
 */
export function isTerminalEntry(entry: ProviderPostEntry): boolean {
  if (entry.kind === "legacy") return true;
  return entry.state === "live" || entry.state === "failed";
}

/* -------------------------------------------------------------------------- */
/*  DirectTransport                                                            */
/* -------------------------------------------------------------------------- */

/**
 * How a transport counts a post against its length limit.
 *
 * Every transport states its own rule, and length.ts's `measureLength` counts
 * the raw string in it (no HTML serialization):
 *
 *   utf16    — code units, the common case.
 *   grapheme — Bluesky, which counts 300 grapheme clusters.
 *   weighted — X's twitter-text weighting: every URL a flat 23, CJK and
 *              emoji 2.
 */
/**
 * How a platform counts the length of a post.
 *
 * `utf8bytes` exists for YouTube, whose real cap is 5000 UTF-8 BYTES. Declared
 * as `utf16` the number would match (5000 vs 5000) so nothing would look
 * wrong, and for ASCII copy the two agree exactly; non-ASCII copy would pass QA
 * and then be silently truncated by the transport, because an accented
 * character costs 2 bytes and an emoji up to 4.
 */
export type CountMode = "utf16" | "grapheme" | "weighted" | "utf8bytes";

/**
 * Static per-channel limits.
 *
 * NOT optional on the interface. They are the only source of vendor limits,
 * and a transport that forgot to supply them would not fail: the QA length
 * gate would just stop checking that platform, silently, which is the worst
 * possible failure for a gate.
 */
export interface TransportChannelRules {
  maxLength: number;
  countMode: CountMode;
  maxImages?: number;
  maxImageBytes?: number;
  /**
   * Mime types this platform accepts for an image, when it is fussy about it.
   *
   * Absent means "no constraint this client knows of", which is most platforms.
   * Set it only from a vendor statement, because it is enforced: media-fit.ts
   * re-encodes anything outside the list at publish time. Instagram is the
   * reason it exists ("JPEG is the only image format supported"), and Threads
   * is the reason it is a LIST rather than one format (JPEG and PNG).
   */
  imageFormats?: readonly string[];
  maxVideoBytes?: number;
  maxVideoSec?: number;
}

/** Whether the platform is reachable right now, in `connectedAccounts()` shape. */
export interface DirectConnectStatus {
  connected: boolean;
  /** Stable id for this destination (page id, org urn, DID, channel id). */
  accountId: string;
  displayName: string;
  /** Operator-readable reason when `connected` is false. */
  reason?: string;
}

/** A thread reply that could not go out with the root and must be released later. */
export interface DirectQueuedReply {
  position: number;
  text: string;
  dueAt: string;
  /** Vendor handles the reply needs to attach itself to the chain. */
  parent: Record<string, string>;
  /**
   * The render's language tags (Bluesky `langs`), persisted so a reply
   * released later is tagged like the root it hangs from. Absent when the
   * render carried none.
   */
  langs?: string[];
}

/**
 * Publish-time facts that live on the DRAFT or in Social HQ settings rather
 * than on the render, resolved once by publish.ts and handed to the transport.
 *
 * This exists because the aggregator path had a second, invisible input the
 * direct path did not. `platformSettings()` built `{board, title, link}` for
 * Pinterest and `{subreddit, flair}` for Reddit out of `draft.source` plus the
 * operator's defaults, and none of it is reachable from a `PlatformRender`.
 * A transport given only the render therefore published a Pinterest pin with
 * no destination link and no settings-default board — it succeeded, returned a
 * real id, and produced a pin that goes nowhere when clicked.
 *
 * Deliberately NOT optional on DirectPublishInput. A transport that silently
 * loses the operator's click-through URL fails in a way nothing alerts on, so
 * forgetting to pass this is a compile error rather than a quiet regression.
 */
export interface PublishDestination {
  /** Pinterest board id, AFTER the Social HQ default has been applied. */
  board?: string;
  /**
   * Click-through URL, from `draft.source.link`. Separate from the body text
   * because Pinterest carries it as its own field, and the Pinterest playbook
   * strips URLs out of the copy precisely because it is meant to travel here.
   */
  link?: string;
  /** Draft title, for platforms with a real title field (Pinterest, YouTube). */
  title?: string;
  /** Reddit target, after defaults are applied. */
  subreddit?: string;
  flair?: { id: string; name: string };
}

export interface DirectPublishInput {
  render: PlatformRender;
  /** Only the assets this render selected, already resolved to bytes or URLs. */
  media: MediaAsset[];
  draftId: string;
  destination: PublishDestination;
}

export interface DirectPublishResult {
  /** The vendor's id for the post that now exists. Comma-free. */
  ref: string;
  url?: string;
  /**
   * Replies that were deferred rather than posted inline, because the render
   * carried a follow-up delay. Publish-due releases these; the root is already
   * live by the time this returns.
   */
  queued?: DirectQueuedReply[];
  /** Root handles a later reply needs. Persisted into `threadState`. */
  threadRoot?: Record<string, string>;
  /**
   * Vendor handles for the post THIS call just created.
   *
   * Needed because a reply chain is sequential by nature: reply N+1's parent is
   * reply N, whose handles cannot be known until N is posted. Without this the
   * releaser can only ever point every deferred reply at the root, which renders
   * as a star of siblings rather than a thread. Distinct from `threadRoot`,
   * which always names the head of the chain.
   */
  selfRef?: Record<string, string>;
  /**
   * The refs of the replies this call posted INLINE under the root, in chain
   * order. Set whenever the render's thread went out inline (empty when its
   * first reply failed), absent when there was no thread or it was deferred.
   *
   * ⛔ Deleting the root does not delete its replies on X or Bluesky, so the
   * caller records these where deferred replies land (`threadState.done`) and a
   * delete removes them with the post.
   */
  replyRefs?: string[];
  /**
   * Something that went wrong AFTER the post went live, which must not fail the
   * leg (a retry would publish a second post) but must not vanish either.
   *
   * ⛔ Without this a failed Facebook first comment only reaches console.warn:
   * every first comment can fail with `(#200) You do not have sufficient
   * permissions` while each draft reads `published` with no error. Callers put
   * these in `lastError`.
   */
  warnings?: string[];
}

/**
 * Reconcile facts, structurally compatible with the app's `ProviderPostFacts`.
 *
 * Duplicated rather than imported because that module lives app-side and this
 * folder must stay liftable. The shapes are pinned together by a test.
 *
 * ⚠️ `state` is the only field that can strand a draft. `reconcileVerdict`
 * treats anything outside PUBLISHED/ERROR as pending forever, so a transport
 * that cannot determine a post's fate must answer QUEUE and let publish-due's
 * overdue sweep make the terminal call. Never guess ERROR from a network
 * failure: that marks a live post dead.
 */
export interface DirectPostFacts {
  state: "PUBLISHED" | "ERROR" | "QUEUE";
  released: boolean;
  platform: Platform;
  /**
   * The vendor gave a DEFINITIVE answer that this post does not exist.
   *
   * This is the observation the `state` field cannot carry. Without it a
   * transport has only one way to say "not found" and one way to say "I could
   * not reach the vendor", and both are QUEUE, so the caller can never tell a
   * post somebody deleted from a post it merely failed to look up. The first
   * should eventually become terminal; the second must never be. Collapsing
   * them strands the draft in `scheduled` forever, because reconcileVerdict
   * treats anything outside PUBLISHED/ERROR as pending in perpetuity.
   *
   * ⛔ It stays SEPARATE from `state`, and setting it must never change what
   * `state` says. The transport still answers QUEUE; `absent` only tells the
   * caller which KIND of QUEUE it is, and the caller owns the grace window and
   * the decision to give up. That boundary is the whole reason a transport
   * cannot mark a live post dead by itself.
   *
   * ⚠️ Set it ONLY when the vendor's answer is unambiguous. Meta's Graph API
   * returns one code-100 message that conflates "deleted", "no permission" and
   * "unsupported operation", so Facebook, Instagram and Threads deliberately do
   * NOT set it. Leaving it unset costs a draft that sits pending; setting it
   * wrongly marks a LIVE post dead.
   *
   * ✅ LinkedIn DOES set it: its batch response shape for a missing post is
   * confirmed against a live call, by publishing a real post to the company
   * page, deleting it, and reading it back both times
   * (linkedin.live.proof.test.ts). A deleted URN comes back absent from
   * `results` with an explicit `404` in both `statuses` and `errors`, which is
   * unambiguous in the sense this comment means.
   */
  absent?: boolean;
}

export interface DirectTransport {
  readonly platform: Platform;

  /** Static vendor limits. Required — see TransportChannelRules. */
  channelRules(): TransportChannelRules;

  connectStatus(): Promise<DirectConnectStatus>;

  publishNow(input: DirectPublishInput): Promise<DirectPublishResult>;

  /** Idempotent: an already-gone post is a success, not an error. */
  deletePost(ref: string): Promise<void>;

  /** Batch where the vendor supports it; one call per ref where it does not. */
  postFacts(refs: string[]): Promise<Map<string, DirectPostFacts>>;

  postUrl(ref: string): string;

  /** Release one deferred thread reply. Only for platforms with reply chains. */
  publishReply?(reply: DirectQueuedReply, root: Record<string, string>): Promise<DirectPublishResult>;

  /** A real comment on the post object, which is not the same as a reply. */
  postComment?(ref: string, text: string): Promise<void>;

  analyticsPost?(ref: string): Promise<Record<string, number>>;
  analyticsChannel?(): Promise<Record<string, number>>;
  followerStats?(): Promise<{ followers: number }>;

  /** Pinterest boards, subreddit rules: per-destination config the vendor owns. */
  listBoards?(): Promise<Array<{ id: string; name: string }>>;
  destinationRules?(destination: string): Promise<Record<string, unknown>>;
}

/**
 * A third party that publishes to several platforms on one credential.
 *
 * ⛔ THIS IS A HOLDING PEN, NOT A FALLBACK. Nothing degrades to an aggregator
 * when a direct transport fails. It exists for platforms an operator cannot
 * reach directly at all (for example Reddit, without an approved API app under
 * its Responsible Builder Policy), and a platform is assigned to one
 * explicitly, per platform, by an operator. Making the aggregator the default
 * and direct the exception would let one deleted aggregator account take down
 * every platform, including the ones already served directly.
 *
 * WHY THIS IS NOT `DirectTransport` KEYED PER PLATFORM. One credential spans
 * every platform the aggregator holds, so connect state, rate limits and
 * outages are shared. Modelling it as N independent transports would report N
 * separate connections for one account, and an operator disconnecting "Reddit"
 * would silently disconnect everything else too.
 *
 * ⚠️ With the seam in place, adopting a vendor is writing one class and a
 * settings flip, not another migration. Every registry lookup below answers
 * null until one is registered.
 */
export interface Aggregator {
  /**
   * Stable vendor slug, lowercase and colon-free. It is written into
   * `providerPostId` by `aggregatorEntry`, so changing it after posts exist
   * orphans every leg that carries the old one — treat it as a permanent id.
   */
  readonly id: string;

  /**
   * The vendor's own brand casing, for operator-facing text.
   *
   * ⛔ SEPARATE FROM `id` ON PURPOSE, and this is the whole reason it exists.
   * `id` is written into `providerPostId` by `aggregatorEntry` and is matched
   * against `AGGREGATOR_ID_RE` (lowercase, colon-free), so it can never carry
   * capitals and can never be changed once legs exist. A UI that rendered the id
   * would show "Via zernio" forever. Defaults to `id` when a vendor does not
   * care.
   */
  readonly displayName?: string;

  /** The platforms this aggregator is configured to hold. */
  platforms(): readonly Platform[];

  /**
   * The aggregator's own limits for a platform, which are its own and are
   * frequently STRICTER than the vendor's: it has to satisfy the strictest
   * account it serves. Never assume they match `SPECS`.
   */
  channelRules(platform: Platform): TransportChannelRules;

  /**
   * Connect state for one platform. Shared-credential failures (an expired
   * account, a lapsed subscription) surface identically on every platform, so
   * callers must tolerate all of them answering disconnected at once.
   */
  connectStatus(platform: Platform): Promise<DirectConnectStatus>;

  publishNow(platform: Platform, input: DirectPublishInput): Promise<DirectPublishResult>;

  /** Idempotent, matching DirectTransport: an already-gone post is a success. */
  deletePost(platform: Platform, ref: string): Promise<void>;

  postFacts(platform: Platform, refs: string[]): Promise<Map<string, DirectPostFacts>>;

  postUrl(platform: Platform, ref: string): string;

  publishReply?(
    platform: Platform,
    reply: DirectQueuedReply,
    root: Record<string, string>,
  ): Promise<DirectPublishResult>;

  postComment?(platform: Platform, ref: string, text: string): Promise<void>;

  analyticsPost?(platform: Platform, ref: string): Promise<Record<string, number>>;
  analyticsChannel?(platform: Platform): Promise<Record<string, number>>;
  followerStats?(platform: Platform): Promise<{ followers: number }>;

  listBoards?(platform: Platform): Promise<Array<{ id: string; name: string }>>;
  destinationRules?(platform: Platform, destination: string): Promise<Record<string, unknown>>;
}

/* -------------------------------------------------------------------------- */
/*  Registry and override resolution                                           */
/* -------------------------------------------------------------------------- */

/**
 * Where a platform's posts go.
 *
 * `"off"` means NO ROUTE: nothing publishes there. `"postiz"` is accepted as a
 * legacy alias for it, because stored settings may still carry that value and
 * rewriting them to rename a constant would be a migration with no upside.
 *
 * ⛔ The override is NOT collapsed into "is a transport registered". All nine
 * register at boot, so dropping it would silently route every platform direct,
 * including X, which can answer 402 (payment required). Cutover stays an
 * explicit per-platform decision an operator makes after
 * verifying the credential.
 *
 * ⚠️ Pinterest is the other example: on Trial access an app cannot create pins
 * at all while every READ answers 200, so registration-implies-routing would
 * route a platform whose credential looks healthy and whose publishes all
 * fail. "Registered" says nothing about the access tier.
 */
/**
 * ⛔ THE VENDOR LIVES IN THIS STRING, NOT IN A SECOND SETTING.
 *
 * `"aggregator:zernio"` names both the mode and which aggregator serves it, so
 * a platform's route is ONE value that moves atomically. The obvious
 * alternative — a sibling `aggregatorSelection` row — was rejected: `setSetting`
 * is a bare upsert with no transaction, the settings PUT full-replaces, and each
 * row would memoise behind its own independent 60s TTL in every process. That
 * gives a real window where a process reads the new mode and the old vendor. It
 * would also allow env to supply the mode while the database supplies the
 * vendor, which `resolveOverrides` is deliberately structured to forbid.
 *
 * Bare `"aggregator"` stays valid and means "the one registered aggregator", so
 * rows written before this existed keep working. With two or more registered and
 * none named, the route is `aggregator-ambiguous` rather than a guess.
 */
export type TransportMode = "direct" | "aggregator" | "off" | "postiz" | `aggregator:${string}`;
export type TransportOverrides = Partial<Record<Platform, TransportMode>>;
export type TransportOverridesResolver = () => Promise<TransportOverrides>;

/**
 * The fixed modes, for UI listing and for the legacy validators.
 *
 * ⚠️ NOT sufficient to validate an override on its own any more — a
 * `aggregator:<id>` value is valid and is not in here. Use `parseTransportMode`,
 * which is the single owner of that rule.
 */
export const TRANSPORT_MODES: readonly TransportMode[] = ["direct", "aggregator", "off", "postiz"];

/** What a mode string means, once parsed. `null` from the parser means "not a mode". */
export type ResolvedMode =
  | { kind: "direct" }
  | { kind: "off" }
  /** `id` absent means bare `"aggregator"`: whichever single one is registered. */
  | { kind: "aggregator"; id?: string };

/**
 * Parse a stored or env-supplied mode string. The ONE place the grammar lives.
 *
 * The env parser here, the app's settings sanitizer and the settings PUT all
 * call it. A literal list in two places silently drops a newly added mode in
 * ONE of them, so a stored `"aggregator"` would sanitize away to unrouted
 * while validating fine in env.
 */
export function parseTransportMode(raw: unknown): ResolvedMode | null {
  if (typeof raw !== "string") return null;
  if (raw === "direct") return { kind: "direct" };
  // "postiz" is the legacy spelling of "off" and may still be the value in
  // stored settings. Accepted and normalised rather than rejected: a
  // rollback must never be the thing that fails.
  if (raw === "off" || raw === "postiz") return { kind: "off" };
  if (raw === "aggregator") return { kind: "aggregator" };

  const prefix = "aggregator:";
  if (!raw.startsWith(prefix)) return null;
  const id = raw.slice(prefix.length);
  return AGGREGATOR_ID_RE.test(id) ? { kind: "aggregator", id } : null;
}

const REGISTRY = new Map<Platform, DirectTransport>();

/**
 * ⛔ KEYED BY AGGREGATOR ID, NOT BY PLATFORM.
 *
 * It was `Map<Platform, Aggregator>` with last-registration-wins, which cannot
 * express "Reddit goes to Zernio, Pinterest goes to Ayrshare" — registering the
 * second vendor would silently steal every platform it declared from the first.
 * Keying by id also means a leg already in the column can be resolved by the
 * aggregator that PUBLISHED it (`transportForEntry`) rather than by whichever
 * one is selected now, which is what makes switching vendors non-destructive.
 */
const AGGREGATORS = new Map<string, Aggregator>();
let _overridesResolver: TransportOverridesResolver | null = null;

/**
 * Wrap a transport's vendor calls in bounded retry.
 *
 * ⛔ APPLIED AT REGISTRATION, not inside each transport, and that is the point.
 * Nine transports each remembering to retry is nine chances to forget, and the
 * tenth platform would start life with none. Doing it here means a transport
 * cannot opt out by omission, and `registeredTransportFor` hands every caller
 * the retrying version by construction.
 *
 * The per-method policies are the safety rule from retry.ts, and are NOT
 * uniform:
 *
 *   - publishNow      → `rejected-only`. It CREATES. A 5xx or a timeout may
 *                       mean the post landed and only the reply was lost, so
 *                       repeating it would publish twice to a real brand
 *                       account. Only a definitive refusal (429, or a vendor
 *                       rate-limit code) is repeated.
 *   - deletePost      → `transient`. Every transport in this engine already
 *                       treats "already gone" as success, so it is idempotent
 *                       by contract and safe to repeat.
 *   - postFacts       → `transient`. A read.
 *   - connectStatus   → NOT wrapped. It is contractually forbidden from
 *                       throwing (it reports failure in its return value), so
 *                       there is nothing for a retry to catch. Wrapping it
 *                       would be dead code that reads as coverage.
 *   - channelRules /
 *     postUrl         → NOT wrapped. Pure, synchronous, no vendor call.
 */
function withTransportRetry(t: DirectTransport): DirectTransport {
  return {
    ...t,
    publishNow: (input) => withRetry(`${t.platform}.publishNow`, "rejected-only", () => t.publishNow(input)),
    deletePost: (ref) => withRetry(`${t.platform}.deletePost`, "transient", () => t.deletePost(ref)),
    postFacts: (refs) => withRetry(`${t.platform}.postFacts`, "transient", () => t.postFacts(refs)),
  };
}

export function registerTransport(transport: DirectTransport): void {
  REGISTRY.set(transport.platform, withTransportRetry(transport));
}

/**
 * Register an aggregator for the platforms it declares.
 *
 * Registration alone routes nothing: a platform still has to be set to
 * `"aggregator"` in `transportOverrides`, the same explicit-cutover rule direct
 * transports follow. Last registration wins per platform, so two aggregators
 * can coexist while one is being replaced.
 */
export function registerAggregator(aggregator: Aggregator): void {
  assertAggregatorId(aggregator.id);
  AGGREGATORS.set(aggregator.id, aggregator);
  _boundCache.clear();
}

/**
 * The aggregator with this id, registered or not selected. Ignores every setting.
 *
 * ⛔ THIS IS HOW A LIVE LEG STAYS DELETABLE ACROSS A VENDOR SWITCH. A
 * `via:zernio:reddit:…` entry names the aggregator that published it, so
 * cleanup resolves through here rather than through whatever is selected today.
 * Without it, flipping Reddit from Zernio to Ayrshare would orphan every live
 * Zernio leg — the exact "born undeletable" outcome the `via:` namespace exists
 * to prevent.
 */
export function aggregatorById(id: string): Aggregator | null {
  return AGGREGATORS.get(id) ?? null;
}

/** Every registered aggregator, for the operator's vendor picker. */
export function registeredAggregators(): Aggregator[] {
  return [...AGGREGATORS.values()];
}

/** The registered aggregators that declare this platform. Ignores the override. */
export function aggregatorsForPlatform(platform: Platform): Aggregator[] {
  return [...AGGREGATORS.values()].filter((a) => a.platforms().includes(platform));
}

/**
 * An aggregator seen as one platform's transport.
 *
 * Structurally `DirectTransport` today, and deliberately a DIFFERENT NAME. Every
 * call site that resolves a route gets one of these, and the name is the warning:
 * this may be an aggregator wearing a platform's mask, so "registration is the
 * gate" reasoning written for direct transports does not transfer unexamined. It
 * also stops a future `disconnect()` on `DirectTransport` from being silently
 * satisfiable by an aggregator, where one credential spans every platform.
 *
 * ⛔ NO `connectStatus`. `connectedAccounts` loops all nine platforms and runs
 * with `{fresh:true}` on EVERY publish, so a per-platform status call over one
 * shared credential turns a single round trip into K against a single rate
 * limit — the "N connections for one account" failure the Aggregator docblock
 * forbids, arriving through the back door and on the hot path. Omitting it makes
 * `connectedAccounts` handle the aggregator explicitly, which is a compile error
 * rather than a silent K-fold amplification.
 */
export type RoutedTransport = Omit<DirectTransport, "connectStatus">;

/**
 * Cache of bound views, keyed `<aggregatorId>|<platform>`.
 *
 * Not an optimisation: `withTransportRetry` returns a new object each call, and
 * callers compare transports by identity in places. Cleared by
 * `registerAggregator` and `resetTransports` so a re-registration cannot be
 * served a view onto the previous instance.
 */
const _boundCache = new Map<string, RoutedTransport>();

/**
 * View an aggregator as one platform's transport, retry-wrapped.
 *
 * ⛔ RETRY IS APPLIED HERE FOR THE SAME REASON `registerTransport` applies it:
 * so a publisher cannot opt out by omission. `registerAggregator` does not wrap,
 * so without this Zernio would be the first publisher in this engine with no
 * bounded retry — and an aggregator is MORE 429-prone than any single vendor,
 * because one credential serves every platform it holds.
 *
 * ⚠️ Built as a fresh object literal on purpose. `withTransportRetry` spreads
 * its argument (`{...t}`), which drops every prototype method of a class
 * instance and yields a transport whose `publishNow` is `undefined`. Every
 * direct transport is an object literal so nothing has ever hit that; an
 * aggregator written as a class would.
 */
function bindAggregator(aggregator: Aggregator, platform: Platform): RoutedTransport {
  const key = `${aggregator.id}|${platform}`;
  const hit = _boundCache.get(key);
  if (hit) return hit;

  const label = `${aggregator.id}:${platform}`;
  const bound: RoutedTransport = {
    platform,
    channelRules: () => aggregator.channelRules(platform),
    publishNow: (input) =>
      withRetry(`${label}.publishNow`, "rejected-only", () => aggregator.publishNow(platform, input)),
    deletePost: (ref) =>
      withRetry(`${label}.deletePost`, "transient", () => aggregator.deletePost(platform, ref)),
    postFacts: (refs) =>
      withRetry(`${label}.postFacts`, "transient", () => aggregator.postFacts(platform, refs)),
    postUrl: (ref) => aggregator.postUrl(platform, ref),
    ...(aggregator.publishReply
      ? { publishReply: (reply, root) => aggregator.publishReply!(platform, reply, root) }
      : {}),
    ...(aggregator.postComment
      ? { postComment: (ref, text) => aggregator.postComment!(platform, ref, text) }
      : {}),
    ...(aggregator.analyticsPost
      ? { analyticsPost: (ref) => aggregator.analyticsPost!(platform, ref) }
      : {}),
    ...(aggregator.analyticsChannel
      ? { analyticsChannel: () => aggregator.analyticsChannel!(platform) }
      : {}),
    ...(aggregator.followerStats
      ? { followerStats: () => aggregator.followerStats!(platform) }
      : {}),
    ...(aggregator.listBoards ? { listBoards: () => aggregator.listBoards!(platform) } : {}),
    ...(aggregator.destinationRules
      ? { destinationRules: (dest: string) => aggregator.destinationRules!(platform, dest) }
      : {}),
  };

  _boundCache.set(key, bound);
  return bound;
}

export function setTransportOverridesResolver(resolver: TransportOverridesResolver | null): void {
  _overridesResolver = resolver;
}

/**
 * Drop all registrations and the resolver.
 *
 * Module state is shared across every test file in a vitest worker, so without
 * this one file registering a fake transport silently changes another file's
 * publish partition — and the victim is whichever file happens to run second,
 * which makes it look like flake. Call from a shared `beforeEach`.
 */
export function resetTransports(): void {
  REGISTRY.clear();
  AGGREGATORS.clear();
  // Bound views hold a reference to the aggregator they wrap, so leaving this
  // populated would serve a view onto a cleared registry — the module state
  // this function exists to make un-shareable between test files.
  _boundCache.clear();
  _overridesResolver = null;
}

/**
 * Env first, matching the rest of the engine: local dev, tests and the CLI all
 * set env and none of them should reach a database. Malformed JSON is ignored
 * with a warning rather than thrown, because a typo in an env var must not take
 * publishing down — it leaves every platform unrouted, which QA reports as
 * `no-route` before anything is attempted.
 */
function envOverrides(): TransportOverrides | null {
  const raw = process.env.SOCIALMETA_TRANSPORT_OVERRIDES;
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const out: TransportOverrides = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      // parseTransportMode, not a TRANSPORT_MODES membership test: an
      // `aggregator:<id>` value is valid and is not in that array.
      if (PLATFORM_SET.has(key) && parseTransportMode(value)) {
        out[key as Platform] = value as TransportMode;
      }
    }
    return out;
  } catch {
    console.warn("[transport] SOCIALMETA_TRANSPORT_OVERRIDES is not valid JSON, ignoring");
    return null;
  }
}

async function resolveOverrides(): Promise<TransportOverrides> {
  const fromEnv = envOverrides();
  if (fromEnv) return fromEnv;
  if (!_overridesResolver) return {};
  try {
    return await _overridesResolver();
  } catch (err) {
    // Losing the settings read must not silently unroute live platforms
    // mid-publish, which is exactly what answering {} does now that there is no
    // implicit fallback venue. Say so loudly. The caller degrades to `no-route`,
    // which refuses to publish rather than publishing somewhere unintended —
    // the safe direction, and a visible one.
    console.warn(`[transport] override resolver failed, every platform is unrouted: ${String(err)}`);
    return {};
  }
}

/**
 * The transport that should handle this platform's publish RIGHT NOW, or null.
 *
 * ⚠️ null means "not publishing direct" and NOT "use the aggregator" — it used
 * to mean the latter, back when there was an implicit fallback. Callers that
 * need to distinguish "held by an aggregator" from "nowhere to go" must use
 * `resolveRoute`, which says which of the two it is.
 *
 * Two conditions, both required: a transport is registered, and the override
 * says `direct`. That is what makes a cutover a settings flip.
 */
export async function directTransportFor(platform: Platform): Promise<DirectTransport | null> {
  const transport = REGISTRY.get(platform);
  if (!transport) return null;
  const overrides = await resolveOverrides();
  return overrides[platform] === "direct" ? transport : null;
}

/**
 * The single aggregator holding this platform, or null. Ignores the override.
 *
 * ⚠️ Answers null when SEVERAL registered aggregators declare the platform,
 * because there is no single right answer and guessing is how a post lands on an
 * account nobody chose. Callers that need to disambiguate use the mode's
 * `aggregator:<id>` suffix (`resolveRoute`) or the leg's embedded id
 * (`transportForEntry`).
 */
export function registeredAggregatorFor(platform: Platform): Aggregator | null {
  const holders = aggregatorsForPlatform(platform);
  return holders.length === 1 ? holders[0] : null;
}

/** Why a platform has nowhere to publish, so the operator message can say which. */
export type NoRouteReason =
  /** Mode is `direct` but no transport is registered for it. A wiring bug. */
  | "direct-unregistered"
  /** Mode is `aggregator` but no aggregator holds it. Expected while none exists. */
  | "aggregator-unregistered"
  /**
   * Mode names an aggregator id that is not registered, or is bare `"aggregator"`
   * while several registered aggregators declare the platform. Refusing beats
   * picking: publishing from an unchosen account is discovered late and from the
   * wrong identity.
   */
  | "aggregator-ambiguous"
  /** Mode is `off` (or the `postiz` alias), or no mode is set at all. */
  | "not-routed";

/**
 * Where this platform's posts go right now. The single routing decision.
 *
 * Order is direct → aggregator → no-route, and it is a SELECTION, not a chain
 * of fallbacks: a platform set to `direct` whose transport throws does not
 * silently divert to an aggregator. Publishing somewhere the operator did not
 * choose is worse than not publishing, because it is discovered later and from
 * the wrong account.
 */
export async function resolveRoute(platform: Platform): Promise<PlatformRoute> {
  const overrides = await resolveOverrides();
  const mode = parseTransportMode(overrides[platform]);

  if (mode?.kind === "direct") {
    const transport = REGISTRY.get(platform);
    return transport
      ? { kind: "direct", transport }
      : { kind: "no-route", reason: "direct-unregistered" };
  }

  if (mode?.kind === "aggregator") {
    const holders = aggregatorsForPlatform(platform);
    if (!holders.length) return { kind: "no-route", reason: "aggregator-unregistered" };

    if (mode.id) {
      // An explicitly named vendor that does not hold this platform is an
      // operator error, not an invitation to fall back to the other one.
      const named = holders.find((a) => a.id === mode.id);
      return named
        ? { kind: "aggregator", aggregator: named }
        : { kind: "no-route", reason: "aggregator-ambiguous" };
    }

    // Bare "aggregator": unambiguous only while exactly one holds the platform.
    return holders.length === 1
      ? { kind: "aggregator", aggregator: holders[0] }
      : { kind: "no-route", reason: "aggregator-ambiguous" };
  }

  return { kind: "no-route", reason: "not-routed" };
}

export type PlatformRoute =
  | { kind: "direct"; transport: DirectTransport }
  | { kind: "aggregator"; aggregator: Aggregator }
  | { kind: "no-route"; reason: NoRouteReason };

/** Operator-facing explanation for a `no-route`, used by QA and publish refusals. */
export function noRouteMessage(platform: Platform, reason: NoRouteReason): string {
  switch (reason) {
    case "direct-unregistered":
      return `${platform} is set to publish directly but has no transport registered`;
    case "aggregator-unregistered":
      return `${platform} is assigned to an aggregator, but none is configured`;
    case "aggregator-ambiguous":
      return (
        `${platform} is assigned to an aggregator, but which one is ambiguous: ` +
        `name it as "aggregator:<id>" (registered: ${registeredAggregators().map((a) => a.id).join(", ") || "none"})`
      );
    case "not-routed":
      return `${platform} has no route: it is not connected directly and no aggregator holds it`;
  }
}

/**
 * The route for a platform's NEXT publish, as one uniform transport.
 *
 * The successor to `directTransportFor` for every path that produces a post. The
 * `entry`/`stateEntry` closures are the load-bearing part: they are what make
 * publish write `via:zernio:reddit:…` instead of `reddit:…`, so the leg names the
 * route that created it and can be cleaned up by that route later. A caller that
 * takes `transport` and then encodes with `directEntry` by hand has reintroduced
 * the whole bug.
 */
export interface RoutedPublish {
  transport: RoutedTransport;
  /** How this route stamps a published ref into `providerPostId`. */
  entry(ref: string): ProviderPostEntry;
  /** How this route stamps a pending/publishing/failed leg. */
  stateEntry(state: DirectPendingState): ProviderPostEntry;
}

export async function routeTransportFor(platform: Platform): Promise<RoutedPublish | null> {
  const route = await resolveRoute(platform);

  if (route.kind === "direct") {
    return {
      transport: route.transport,
      entry: (ref) => directEntry(platform, ref),
      stateEntry: (state) => directStateEntry(platform, state),
    };
  }

  if (route.kind === "aggregator") {
    const id = route.aggregator.id;
    return {
      transport: bindAggregator(route.aggregator, platform),
      entry: (ref) => aggregatorEntry(id, platform, ref),
      stateEntry: (state) => aggregatorStateEntry(id, platform, state),
    };
  }

  return null;
}

/**
 * The transport that can act on THIS leg, resolved from the leg itself.
 *
 * ⛔ THE CLEANUP-PATH LOOKUP, AND IT IGNORES EVERY SETTING ON PURPOSE. The
 * override decides what new publishes PRODUCE; it must never decide what can be
 * cleaned up. A direct leg resolves through the registry (so rolling a platform
 * back to an aggregator does not strand live direct posts), and an aggregator leg
 * resolves through the id EMBEDDED IN THE ENTRY (so switching vendors, or turning
 * the platform off entirely, does not strand live aggregator posts).
 *
 * Returns null for `legacy` entries: those are pre-codec bare cuids whose issuer
 * is unreachable, and there is nothing left to call. The app reports that
 * honestly rather than pretending a delete succeeded.
 */
export function transportForEntry(entry: ProviderPostEntry): RoutedTransport | null {
  if (entry.kind === "legacy") return null;
  if (entry.kind === "aggregator") {
    const aggregator = AGGREGATORS.get(entry.aggregatorId);
    return aggregator ? bindAggregator(aggregator, entry.platform) : null;
  }
  return REGISTRY.get(entry.platform) ?? null;
}

/**
 * The transport for a platform IGNORING the override.
 *
 * Publish-due must use this, not `directTransportFor`. The override decides what
 * `publishDraft` PRODUCES; it must not decide what gets cleaned up. Flipping a
 * platform back to the aggregator while legs are still `pending` would otherwise
 * strand them forever — they would never release and never fail, and the daily
 * reconcile would report them pending in perpetuity. Gating release on
 * registration instead is what makes rollback safe.
 */
export function registeredTransportFor(platform: Platform): DirectTransport | null {
  return REGISTRY.get(platform) ?? null;
}

/** Platforms with a registered transport, regardless of override. */
export function registeredPlatforms(): Platform[] {
  return ALL_PLATFORMS.filter((p) => REGISTRY.has(p));
}
