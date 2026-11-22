/**
 * Bluesky (AT Protocol) vendor client.
 *
 * Every raw call to the vendor lives here or in the XRPC client under it
 * (`./bluesky-xrpc.ts`), and nothing above this file speaks the protocol
 * (publishing is direct per platform). Two things this file owns that an
 * aggregator never has to think about:
 *
 *   - a session. An aggregator holds one static API key; Bluesky needs a logged-in
 *     account, and com.atproto.server.createSession is rate-limited per
 *     account. See getAgent() for why the session is opened lazily and cached
 *     for the life of the process rather than per call.
 *   - facets. Bluesky does not autolink. A post with a bare URL and no facet
 *     is dead text (scripts/social/platform-reference.md), so
 *     buildRichText is the one place a real facet gets attached.
 *
 * Engine rules apply: relative imports only.
 */

import { createHash } from "node:crypto";
import { getErrorMessage } from "./error-message.js";
import type { RecentPostsPage } from "./recent-posts.js";
// The engine's own capped reader (read-capped.ts), shared with media-fetch.ts.
import { readCappedBody } from "./read-capped.js";
import {
  Agent,
  CredentialSession,
  XRPCError,
  type AtpSessionData,
  type BlobRef,
  type Facet,
  type PostRecord,
  type PostView,
  type StrongRef,
} from "./bluesky-xrpc.js";
import { detectFacets, resolveMentions } from "./bluesky-richtext.js";
import { ResponseShapeError } from "./http/shape.js";
import { graphemeCount } from "./length.js";

export type { StrongRef, Facet, PostView };

/**
 * ⛔ NOT public.api.bsky.app. That AppView host 403s authenticated writes and
 * even some authenticated reads (searchPosts, verified live). bsky.social is
 * the entryway every real
 * Bluesky client talks to; it proxies both the com.atproto.* PDS operations
 * and the app.bsky.* AppView reads for an authenticated session.
 */
const SERVICE_URL = "https://bsky.social";

// A hung connection must not hold a publish request open indefinitely. Applied via a wrapped fetch
// (below) so it covers session management calls and data calls alike.
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * The cap on any ONE Bluesky response body: a hostile or broken answer cannot
 * hold more than this in memory, whatever the parser does with it.
 *
 * Sized generously off the largest payload the callers legitimately read: a
 * 100-post searchPosts or 25-URI getPosts page is a few hundred KB of JSON,
 * so 5 MiB is an order of magnitude of headroom while still a bound. Enforced
 * by readCappedBody, which refuses before the first byte when a declared
 * Content-Length is over the cap and mid-stream otherwise, never truncating.
 */
const RESPONSE_CAP_BYTES = 5 * 1024 * 1024;

export class BlueskyError extends Error {
  constructor(
    public status: number,
    public body: string,
    method: string,
    path: string,
    /** Raw `Retry-After`, verbatim. retry.ts owns the grammar; see RetryAfterCarrier. */
    public retryAfter: string | null = null,
  ) {
    super(`Bluesky ${method} ${path} -> ${status}: ${body.slice(0, 500)}`);
  }
}

/**
 * Every call through the XRPC client (session management included) fails with
 * an XRPCError, a request that got no answer included (status 1, with the
 * cause's message), so this one branch covers network failures, timeouts and
 * real vendor error responses alike.
 *
 * ⛔ A ResponseShapeError passes through unchanged: a 2xx answer the client
 * could not read is an unknown outcome to retry.ts (a create may have landed),
 * and wrapping it would hide that.
 */
function wrapError(err: unknown, method: string, path: string): BlueskyError | ResponseShapeError {
  if (err instanceof ResponseShapeError) return err;
  if (err instanceof XRPCError) {
    return new BlueskyError(
      err.status,
      `${err.error ?? "Error"}: ${err.message ?? ""}`,
      method,
      path,
      // The client keeps the answer's headers as a lowercased map, so this is
      // the ONE client that can recover Retry-After without the Response
      // object, and the one place it would otherwise be dropped, because
      // everything above this line sees a BlueskyError only.
      err.headers["retry-after"] ?? null,
    );
  }
  return new BlueskyError(0, getErrorMessage(err), method, path);
}

/** The XRPC error names that mean a dead refresh token (the client's own rule). */
const DEAD_REFRESH_ERRORS = new Set(["ExpiredToken", "InvalidToken", "InvalidDID"]);

/**
 * Whether a failed resume means the stored session is dead, by the client's
 * own rule (CredentialSession's refresh: a 401, or one of the names above).
 * Anything else XRPC raises (a 5xx, a rate limit, a timeout or dropped
 * connection, which XRPC reports as status 1) says nothing about the token. A
 * non-XRPC rejection is the client refusing the session itself (a DID
 * mismatch, or a refresh answer it could not read, whose rotated token is
 * gone with it), so it counts as dead.
 */
function isRefusedRefresh(err: unknown): boolean {
  if (!(err instanceof XRPCError)) return true;
  return err.status === 401 || DEAD_REFRESH_ERRORS.has(err.error);
}

/**
 * The fetch every Bluesky network call goes through: timeboxed on the request,
 * byte-capped on the response. The cap refuses oversize by throwing a plain
 * Error, the same failure shape the timebox's abort arrives as; the XRPC
 * client wraps either in an XRPCError of status 1 (no answer), which
 * wrapError maps to the BlueskyError every caller sees.
 */
function timeboxedFetch(): typeof fetch {
  return async (input, init) => {
    const res = await globalThis.fetch(input, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const capped = await readCappedBody(res, RESPONSE_CAP_BYTES);
    if (!capped.ok) {
      throw new Error(`bluesky: response body exceeds the fetch byte cap (${RESPONSE_CAP_BYTES} bytes)`);
    }
    // readCappedBody refuses rather than truncates, so on ok these bytes ARE
    // the whole body, and the drained stream can be replaced by them. A
    // body-less response (a 204) is handed back untouched: the Response
    // constructor refuses a body on a null-body status.
    if (!res.body) return res;
    return new Response(capped.bytes, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  };
}

export interface BlueskyCredentials {
  identifier: string;
  password: string;
}
export type BlueskyCredentialsResolver = () => Promise<BlueskyCredentials>;

let _resolver: BlueskyCredentialsResolver | null = null;
let _agent: Agent | null = null;
let _loginPromise: Promise<Agent> | null = null;
/**
 * Bumped whenever the resolver or the session store is replaced. A session
 * opened under an older generation is never cached, returned or persisted:
 * the host has stopped using the credential or the store it was opened with.
 */
let _generation = 0;

function invalidateSession(): void {
  _generation++;
  _agent = null;
  _loginPromise = null;
}

/**
 * Register (or clear, with null) the resolver that supplies the app password.
 *
 * INJECTED rather than imported, like every credential resolver here: this
 * folder is the portable engine and cannot reach the app's secret store
 * itself. Clearing also drops the cached session: a credential rotation must not leave the process
 * serving requests on a session built from the password that just got
 * replaced.
 */
export function setBlueskyCredentialsResolver(resolver: BlueskyCredentialsResolver | null): void {
  _resolver = resolver;
  invalidateSession();
}

/**
 * Somewhere durable to keep the session between processes.
 *
 * ⛔ WITHOUT THIS, BLUESKY LOCKS THE ACCOUNT OUT AFTER TEN PAGE LOADS.
 * `com.atproto.server.createSession` is rate-limited at **10 per 24 hours per
 * account** (`RateLimit-Policy: 10;w=86400`, read off a live response): a
 * daily budget, not a burst window. The in-process `_agent` cache below only
 * helps within ONE worker, and a deployment with several processes and
 * restarts can spend the whole day's allowance on cold starts alone. A status
 * endpoint that calls connectStatus() live on every load would spend a login
 * per page view and drive the account into `429 RateLimitExceeded`.
 *
 * Resuming a stored session costs a `refreshSession` instead, which is a
 * different and far more generous limit, and the refresh token is good for
 * months. So logins go from per-page-load to roughly per-credential-rotation.
 *
 * Injected, not imported: this folder is the portable engine and cannot reach
 * the app's database or encryption keys. A deployment that wires nothing
 * still works: it just logs in every cold start.
 *
 * ⛔ A store must keep the whole object it is given, `identifierHash`
 * included (see StoredBlueskySession): a row that comes back without it is
 * dropped and costs a login.
 */
export type BlueskySessionStore = {
  load: () => Promise<StoredBlueskySession | null>;
  save: (session: StoredBlueskySession | null) => Promise<void>;
};

/**
 * The session as stored: the XRPC client's session data (field for field what
 * @atproto/api stored, so a row written by 0.1.0 still resumes) plus the hash of the
 * identifier it was created for (identifierHash). Optional so a row written
 * before the field existed still loads; getAgent drops such a row and logs in
 * once, and every save after that carries the hash.
 */
export type StoredBlueskySession = AtpSessionData & { identifierHash?: string };

/**
 * sha256 (hex) of the identifier as createSession takes it: normalised
 * (normalizeBlueskyIdentifier) and lowercased. A hash rather than the
 * identifier itself, so the stored row does not carry the operator's login
 * email beside its tokens.
 */
export function blueskyIdentifierHash(identifier: string): string {
  return createHash("sha256").update(normalizeBlueskyIdentifier(identifier).toLowerCase()).digest("hex");
}

let _sessionStore: BlueskySessionStore | null = null;

export function setBlueskySessionStore(store: BlueskySessionStore | null): void {
  _sessionStore = store;
  invalidateSession();
}

/**
 * The authenticated agent, opened on first use and cached for the process.
 *
 * ⛔ createSession is rate-limited per account, and a scheduled publish job
 * can fire many times a day across several processes. Opening a session on
 * every tick (including the overwhelming majority that find nothing due)
 * would burn that budget for no reason. Every exported function
 * below only calls this when it has real work to do.
 *
 * The XRPC client refreshes the access token from the refresh token on its
 * own (CredentialSession.call); nothing here re-implements that.
 *
 * Single-flighted so concurrent callers on a cold process share one login
 * rather than each opening their own session.
 *
 * ⛔ Bound to the generation it started in. A resolver or store replaced while
 * the session was opening makes it obsolete: it writes nothing to the store,
 * is not cached, and every caller waiting on it is handed a session opened
 * from the current resolver and store instead.
 */
async function getAgent(): Promise<Agent> {
  if (_agent) return _agent;
  if (_loginPromise) return _loginPromise;

  const generation = _generation;
  const store = _sessionStore;
  const resolver = _resolver;
  const current = () => generation === _generation;
  // null: this attempt went obsolete, and its callers are handed the current pair's.
  const pending = (async (): Promise<Agent | null> => {
    if (!resolver) {
      throw new BlueskyError(
        0,
        "no Bluesky credentials resolver registered (call setBlueskyCredentialsResolver)",
        "POST",
        "com.atproto.server.createSession",
      );
    }
    const raw = await resolver();
    // Normalise HERE, not only in whichever app wired the resolver. Every
    // consumer of this engine reaches Bluesky through getAgent(), including the
    // live proof test which reads process.env directly, so this is the one
    // place that covers all of them.
    const creds = { ...raw, identifier: normalizeBlueskyIdentifier(raw.identifier ?? "") };
    if (!creds.identifier || !creds.password) {
      throw new BlueskyError(
        0,
        "Bluesky credentials resolver returned an empty identifier or password",
        "POST",
        "com.atproto.server.createSession",
      );
    }
    // persistSession fires on every token rotation, not just at login, so the
    // stored copy stays current without anyone calling save() by hand.
    // `expired` clears it: a dead refresh token must not be retried forever,
    // and a null store is what tells the next cold start to log in properly.
    // ⛔ `network-error` leaves it alone: the client fires it when a refresh
    // failed for a reason that says nothing about the token (a timeout, a PDS
    // 5xx) and keeps the session itself, so clearing the shared row there
    // would send every process that saw the blip to createSession.
    // Never allowed to reject — a storage hiccup must not fail a publish that
    // is otherwise fine.
    // Every live session saved carries the hash of the configured identifier,
    // so a refresh (`update`, whose data the client rebuilds field by field)
    // keeps it and the next cold start still resumes.
    const identifierHash = blueskyIdentifierHash(creds.identifier);
    const session = new CredentialSession(new URL(SERVICE_URL), timeboxedFetch(), (evt, data) => {
      if (!store || evt === "network-error") return;
      const live = evt === "create" || evt === "update" ? data : undefined;
      const next: StoredBlueskySession | null = live ? { ...live, identifierHash } : null;
      // ⛔ `.then(() => save(...))`, NOT `Promise.resolve(save(...))`. The latter
      // CALLS save() before Promise.resolve exists to wrap it, so a store that
      // throws SYNCHRONOUSLY escapes the .catch below entirely and rejects
      // straight into the client's token-refresh path, which is exactly what
      // the comment above says must never happen. An async store cannot do
      // this; a plain function that throws can.
      void Promise.resolve()
        // The generation is read when the save runs: a replacement in between wins.
        .then(() => (current() ? store.save(next) : undefined))
        .catch((err) => {
          console.warn("[bluesky] could not persist session:", err);
        });
    });

    // ── Resume before logging in ────────────────────────────────────────────
    // The whole point of the store: a resume spends a refreshSession, a login
    // spends one of only TEN createSession calls per day.
    let saved = store
      ? await store.load().catch((err) => {
          console.warn("[bluesky] could not read stored session:", err);
          return null;
        })
      : null;

    // ⛔ The store is one shared row. After the operator switches the Bluesky
    // credential to another account, resuming the old row would publish as
    // the OLD account. So a session is resumed only when it carries the hash
    // of the identifier configured now. A different hash, or none (a row from
    // before the hash existed, which cannot show whose it is), is dropped
    // (same ordering rule as below) and we log in: fail closed, at the cost of
    // one login when the credential really changed or the row is old.
    if (saved && saved.identifierHash !== identifierHash) {
      console.warn("[bluesky] the stored session was not created for the configured identifier; dropping it and logging in");
      saved = null;
      // Only while this attempt is current: an obsolete one would erase the
      // row a newer credential just stored.
      await Promise.resolve()
        .then(() => (current() ? store!.save(null) : undefined))
        .catch(() => {});
    }

    if (saved) {
      // The hash is ours, not the client's session data.
      const { identifierHash: _ours, ...atpSession } = saved;
      try {
        await session.resumeSession(atpSession);
      } catch (err) {
        // ⛔ ONLY A REFUSED REFRESH TOKEN ENDS THE STORED SESSION. Dropping the
        // shared row on any rejection would send several processes to
        // createSession (10 per day) on a PDS blip and leave Bluesky answering
        // 429 for the rest of the day. A failure that says
        // nothing about the token is thrown instead: the stored session stays,
        // and the next call resumes it again.
        // ⛔ As a plain Error, the one exception to the BlueskyError-only rule
        // below. This runs before any create, so nothing was posted; a
        // BlueskyError(5xx) reads as "outcome unknown" to retry.ts and would make
        // publish-due fail the leg for good instead of leaving it pending.
        if (!isRefusedRefresh(err)) {
          const { message } = wrapError(err, "POST", "com.atproto.server.refreshSession");
          throw new Error(`${message} (no request was sent; the stored session is kept)`, { cause: err });
        }
        // A refused refresh is a session whose access token we cannot trust,
        // so drop it and fall through to login. Checking `session.session` and
        // using it anyway would trade a clean login for an unauthenticated
        // request later.
        // ⛔ Same ordering rule as the persistSession callback above: a store
        // that throws synchronously would otherwise escape this .catch and
        // reject _loginPromise with a RAW Error, breaking this file's contract
        // that everything above it sees a BlueskyError (bar the refresh
        // failure just above, which is deliberate).
        await Promise.resolve()
          .then(() => (current() ? store!.save(null) : undefined))
          .catch(() => {});
      }
    }

    // Obsolete already: no createSession (ten a day) for a pair nobody uses.
    if (!current()) return null;

    if (!session.hasSession) {
      try {
        await session.login({ identifier: creds.identifier, password: creds.password });
      } catch (err) {
        // ⛔ A login answer that could not be read is NOT an unknown outcome:
        // nothing was posted. As a plain Error, like the refresh failure above.
        if (err instanceof ResponseShapeError) {
          throw new Error(`${err.message} (no post was sent)`, { cause: err });
        }
        throw wrapError(err, "POST", "com.atproto.server.createSession");
      }
    }

    // The resolver or store changed while this session was opening: open one
    // from the current pair instead of caching this one.
    if (!current()) return null;
    const agent = new Agent(session);
    _agent = agent;
    return agent;
  })()
    .catch((err: unknown) => {
      // An obsolete attempt's failure is not the current pair's: its callers try that one.
      if (!current()) return null;
      throw err;
    })
    // Checked again here: a replacement can land after the attempt resolved and
    // before this runs, and its callers must then get the current pair's Agent.
    .then((agent) => (agent && current() ? agent : getAgent()));
  _loginPromise = pending;

  try {
    return await pending;
  } finally {
    // Only our own: a newer generation's attempt may already be in flight.
    if (_loginPromise === pending) _loginPromise = null;
  }
}

export interface RichTextResult {
  text: string;
  facets?: Facet[];
}

/**
 * Detects links, mentions, hashtags and cashtags the way the real Bluesky app
 * does (`./bluesky-richtext.ts`), and resolves each mention to its DID.
 *
 * Without this, a link in the post body is inert text: Bluesky does not
 * autolink, it renders exactly the facets a client attaches. This is the one
 * place in the engine that produces a real one (platform-reference.md:412).
 *
 * ⛔ Resolving a mention is an authenticated call, so this opens the session.
 * A mention that does not resolve stays plain text; nothing here throws past
 * the session itself.
 */
export async function buildRichText(text: string): Promise<RichTextResult> {
  const agent = await getAgent();
  const facets = await resolveMentions(detectFacets(text), (handle) => agent.resolveHandle(handle));
  return { text, facets };
}

/**
 * Strip a leading "@" (and surrounding whitespace) from a Bluesky identifier.
 *
 * ⛔ NOT COSMETIC. `com.atproto.server.createSession` accepts EITHER a handle or
 * an email and decides which by looking for an "@". A handle written the way it
 * appears everywhere a human sees it ("@example.com") is therefore parsed
 * as an email whose local part is empty, and login fails with:
 *
 *   400 InvalidEmail: Invalid email address: Address local part cannot be empty
 *
 * The error names EMAIL validation for a credential the operator entered as a
 * HANDLE, so it reads as a dead account rather than one stray character.
 *
 * Calling createSession with the stripped value authenticates as the handle
 * (`example.com`).
 *
 * ⚠️ Lives in the ENGINE, not in the app's credential resolver, because there
 * can be two independent readers of that secret: the publish path (the app's
 * resolver -> getAgent) and any caller that POSTs createSession itself. Both
 * must normalize.
 * A leading "@" is valid in neither accepted form — handles do not carry one,
 * and no email may begin with one — so stripping it unconditionally discards
 * nothing legitimate.
 */
export function normalizeBlueskyIdentifier(raw: string): string {
  return raw.trim().replace(/^@+/, "");
}

export interface PostImage {
  blob: BlobRef;
  alt: string;
}

export interface CreatePostInput {
  text: string;
  facets?: Facet[];
  images?: PostImage[];
  /**
   * `langs` on the record: BCP-47, at most 3 (lexicon `maxLength: 3`). Sent
   * only when given; an absent field means "unknown", which language-scoped
   * feeds skip.
   */
  langs?: string[];
}

export interface CreateReplyInput extends CreatePostInput {
  root: StrongRef;
  parent: StrongRef;
}

function buildEmbed(images: PostImage[] | undefined): PostRecord["embed"] {
  if (!images?.length) return undefined;
  return {
    $type: "app.bsky.embed.images",
    images: images.map((i) => ({ image: i.blob, alt: i.alt })),
  };
}

/** The app.bsky.feed.post lexicon's limits on what one record may carry. */
const MAX_POST_GRAPHEMES = 300;
const MAX_POST_BYTES = 3000;
const MAX_POST_IMAGES = 4;

/**
 * Refuse a record the lexicon would refuse, before anything is sent.
 *
 * ⛔ A plain Error, never a BlueskyError: nothing reached the vendor, and a
 * BlueskyError of status 0 reads as an unknown outcome to retry.ts, which
 * would fail the leg as "may already be live" instead of reporting the copy.
 */
function assertPostFits(input: CreatePostInput): void {
  const why =
    graphemeCount(input.text) > MAX_POST_GRAPHEMES
      ? `the text is ${graphemeCount(input.text)} graphemes (the limit is ${MAX_POST_GRAPHEMES})`
      : new TextEncoder().encode(input.text).byteLength > MAX_POST_BYTES
        ? `the text is over ${MAX_POST_BYTES} UTF-8 bytes`
        : (input.images?.length ?? 0) > MAX_POST_IMAGES
          ? `the post carries ${input.images!.length} images (the limit is ${MAX_POST_IMAGES})`
          : null;
  if (why) throw new Error(`bluesky: refusing to send a post the lexicon does not allow: ${why}. Nothing was sent.`);
}

async function post(
  input: CreatePostInput & { reply?: { root: StrongRef; parent: StrongRef } },
): Promise<StrongRef> {
  assertPostFits(input);
  const agent = await getAgent();
  try {
    return await agent.post({
      text: input.text,
      facets: input.facets,
      embed: buildEmbed(input.images),
      reply: input.reply,
      ...(input.langs?.length ? { langs: input.langs.slice(0, 3) } : {}),
    });
  } catch (err) {
    throw wrapError(err, "POST", "com.atproto.repo.createRecord#app.bsky.feed.post");
  }
}

/** A root post. `uri`/`cid` are both needed: a reply references both. */
export async function createPost(input: CreatePostInput): Promise<StrongRef> {
  return post(input);
}

/** A reply. `root` and `parent` are independent StrongRefs — see ReplyRef. */
export async function createReply(input: CreateReplyInput): Promise<StrongRef> {
  const { root, parent, ...rest } = input;
  return post({ ...rest, reply: { root, parent } });
}

/** GET app.bsky.feed.getPosts — one call, no internal chunking (vendor caps at 25 URIs; callers chunk). */
export async function getPosts(uris: string[]): Promise<PostView[]> {
  if (!uris.length) return [];
  const agent = await getAgent();
  try {
    return await agent.getPosts(uris);
  } catch (err) {
    throw wrapError(err, "GET", "app.bsky.feed.getPosts");
  }
}

/**
 * GET app.bsky.feed.searchPosts — social listening's post search.
 *
 * ⛔ THIS EXISTS TO STOP A SECOND LOGIN PATH. A listening caller that POSTs
 * com.atproto.server.createSession itself and then calls searchPosts with the
 * raw token spends from the SAME budget of only TEN createSession calls per
 * 24h that publishing spends: one login per bluesky-enabled listening rule,
 * per sweep, with no session store behind it, which ends in a 429.
 *
 * Routing it through getAgent() means both paths share one session, one
 * resume-before-login, and one persisted store.
 *
 * ⚠️ Must stay on bsky.social (SERVICE_URL). `public.api.bsky.app` answers 403
 * to searchPosts even with a valid session token (verified live against both
 * hosts), so the "public" appview is not an interchangeable substitute.
 */
export async function searchPosts(query: string, limit = 20): Promise<PostView[]> {
  const agent = await getAgent();
  try {
    // The vendor caps `limit` at 100; clamped here rather than at the caller so
    // every consumer gets the same bound.
    return await agent.searchPosts({ q: query, limit: Math.min(limit, 100) });
  } catch (err) {
    throw wrapError(err, "GET", "app.bsky.feed.searchPosts");
  }
}

/**
 * com.atproto.repo.deleteRecord. Per the lexicon's own description this is
 * "delete a record, or ensure it doesn't exist" — idempotent by spec. This
 * function stays a thin passthrough that throws on a genuine failure; the
 * "already gone is success" business decision belongs to the transport (see
 * bluesky-transport.ts), which is what the DirectTransport contract requires.
 */
export async function deleteRecord(uri: string): Promise<void> {
  const agent = await getAgent();
  try {
    await agent.deletePost(uri);
  } catch (err) {
    throw wrapError(err, "POST", "com.atproto.repo.deleteRecord");
  }
}

export async function uploadBlob(data: Uint8Array, mimeType: string): Promise<BlobRef> {
  const agent = await getAgent();
  try {
    return await agent.uploadBlob(data, mimeType);
  } catch (err) {
    throw wrapError(err, "POST", "com.atproto.repo.uploadBlob");
  }
}

export interface BlueskyProfile {
  did: string;
  handle: string;
  displayName?: string;
  /**
   * Counts from `app.bsky.actor.getProfile`'s ProfileViewDetailed. Optional
   * because the lexicon marks them optional — a profile the appview has not
   * finished aggregating can omit them, and a missing count must read as
   * "unknown" rather than silently becoming a real zero on a dashboard.
   */
  followersCount?: number;
  followsCount?: number;
  postsCount?: number;
}

/** app.bsky.actor.getProfile. Omit `actor` for the authenticated account's own profile. */
export async function getProfile(actor?: string): Promise<BlueskyProfile> {
  const agent = await getAgent();
  const who = actor ?? agent.did;
  if (!who) {
    throw new BlueskyError(
      0,
      "no actor given and the session has no did (login did not complete)",
      "GET",
      "app.bsky.actor.getProfile",
    );
  }
  try {
    const res = await agent.getProfile(who);
    return {
      did: res.did,
      handle: res.handle,
      displayName: res.displayName,
      followersCount: res.followersCount,
      followsCount: res.followsCount,
      postsCount: res.postsCount,
    };
  } catch (err) {
    throw wrapError(err, "GET", "app.bsky.actor.getProfile");
  }
}

/** How many of the newest records one crash-check read asks for. */
const RECENT_RECORDS_LIMIT = 25;

/**
 * `com.atproto.repo.listRecords` on the account's own `app.bsky.feed.post`
 * collection, newest first (the repo's TID record keys sort by time), for the
 * agent publish's crash check. A reply is kept with no text: it never matches
 * a root, but it still counts toward proving how far back the read reached.
 */
export async function listRecentPosts(): Promise<RecentPostsPage> {
  const agent = await getAgent();
  const repo = agent.did;
  if (!repo) {
    throw new BlueskyError(0, "the session has no did (login did not complete)", "GET", "com.atproto.repo.listRecords");
  }
  try {
    const res = await agent.listRecords({
      repo,
      collection: "app.bsky.feed.post",
      limit: RECENT_RECORDS_LIMIT,
    });
    const posts = res.records.map((r) => {
      const value = r.value as { text?: unknown; createdAt?: unknown; reply?: unknown };
      const createdAt = typeof value.createdAt === "string" ? new Date(value.createdAt) : null;
      return {
        id: r.uri,
        texts: !value.reply && typeof value.text === "string" ? [value.text] : [],
        createdAt: createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt.toISOString() : null,
      };
    });
    return { posts, more: Boolean(res.cursor) };
  } catch (err) {
    throw wrapError(err, "GET", "com.atproto.repo.listRecords");
  }
}
