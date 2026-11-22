/**
 * Reddit API vendor client.
 *
 * Plays the same role for this platform that pinterest.ts and x.ts play for
 * theirs: every raw call to oauth.reddit.com lives here, and nothing above
 * this file touches `fetch` directly.
 *
 * ⚠️ Written from Reddit's documentation, not ported from an aggregator.
 * Nothing in this file assumes an aggregator's Reddit provider got anything
 * right, including the `/r/` prefix some providers need
 * (`subreddit.split('/r/')[1]`), which this client does NOT send; see
 * submitPost's docblock.
 *
 * Every vendor fact cited below was checked directly against Reddit's own
 * documentation on 2026-08-02/03 -- the live https://www.reddit.com/dev/api
 * reference page (fetched with a plain GET) and
 * the official `reddit-archive/reddit` wiki on GitHub, which is Reddit's own
 * archived copy of what used to live at reddit.com/wiki/api and
 * reddit.com/wiki/oauth2 -- not assumed from training data or third-party
 * blogs. Anywhere the official page did not spell something out, the comment
 * says so explicitly rather than asserting it.
 *
 * Engine rules apply: relative imports only.
 */

import type { Agent as UndiciAgent } from "undici";
import { preparePinnedHttpsFetch } from "./ssrf.js";
import { shape, type JsonObject, type Shape } from "./http/shape.js";
import { retryAfterHeader } from "./retry.js";
import { engineDeployment } from "./settings.js";
import { vendorFetch, vendorText, type VendorFetchOptions } from "./vendor-fetch.js";

const BASE_URL = "https://oauth.reddit.com";

// Generous next to the JSON calls: this one puts image bytes on the wire to S3,
// the same reasoning pinterest.ts gives for its own 120s create ceiling.
const MEDIA_UPLOAD_TIMEOUT_MS = 120_000;

/**
 * PROVEN: https://github.com/reddit-archive/reddit/wiki/OAuth2 (fetched
 * 2026-08-03) -- "API requests with a bearer token should be made to
 * `https://oauth.reddit.com`, NOT www.reddit.com."
 */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Reddit's own required User-Agent format. PROVEN against
 * https://github.com/reddit-archive/reddit/wiki/API (fetched 2026-08-03),
 * quoted directly:
 *
 *   "Change your client's User-Agent string to something unique and
 *   descriptive, including the target platform, a unique application
 *   identifier, a version string, and your username as contact information,
 *   in the following format: `<platform>:<app ID>:<version string>
 *   (by /u/<reddit username>)`"
 *   "NEVER lie about your user-agent... We will ban liars with extreme
 *   prejudice."
 *
 * So there is no default: the value names the operator's own registered app
 * and account. `SOCIALMETA_REDDIT_USER_AGENT` wins, else the application's
 * `setEngineDeployment({ redditUserAgent })`; with neither, every Reddit call
 * throws before it is sent rather than go out under someone else's name.
 */
/** The posting User-Agent. Exported so the token refresh presents the same identity. */
export function redditUserAgent(): string {
  const ua = process.env.SOCIALMETA_REDDIT_USER_AGENT || engineDeployment().redditUserAgent;
  if (!ua) {
    throw new Error(
      "Reddit needs a User-Agent naming your app and account: set SOCIALMETA_REDDIT_USER_AGENT or setEngineDeployment({ redditUserAgent })",
    );
  }
  return ua;
}

export class RedditError extends Error {
  constructor(
    public status: number,
    public body: string,
    method: string,
    path: string,
    /** Raw `Retry-After`, verbatim. retry.ts owns the grammar; see RetryAfterCarrier. */
    public retryAfter: string | null = null,
  ) {
    super(`Reddit ${method} ${path} -> ${status}: ${body.slice(0, 500)}`);
    this.name = "RedditError";
  }
}

/** True for a plain HTTP-level 404. NOT what a rejected /api/submit looks like -- see RedditApiError. */
export function isRedditNotFound(err: unknown): boolean {
  return err instanceof RedditError && err.status === 404;
}

export interface RedditApiErrorEntry {
  code: string;
  message: string;
  field: string | null;
}

/**
 * Reddit's `api_type=json` endpoints answer HTTP 200 even when they reject
 * the request, with the real failure embedded in `json.errors`. This is
 * exactly the failure mode the task's own briefing calls out as the single
 * most likely one here, given the one Reddit post this system ever attempted
 * came back `state: ERROR` with nothing else recorded -- a client that only
 * checks `res.ok` cannot see this at all. See submitPost's docblock for what
 * is and is not proven about this envelope's shape.
 */
export class RedditApiError extends RedditError {
  constructor(
    public errors: RedditApiErrorEntry[],
    method: string,
    path: string,
  ) {
    super(200, JSON.stringify(errors), method, path);
    this.name = "RedditApiError";
    this.message = errors.length
      ? `Reddit ${method} ${path} -> 200 OK but rejected the request: ${errors
          .map((e) => `${e.code}: ${e.message}${e.field ? ` (field: ${e.field})` : ""}${SUBMIT_HINTS.get(e.code) ?? ""}`)
          .join("; ")}`
      : this.message;
  }

  /** True when the subreddit refused the post for lacking a flair. */
  get flairRequired(): boolean {
    return this.errors.some((e) => e.code === "SUBMIT_VALIDATION_FLAIR_REQUIRED");
  }
}

/**
 * What the operator does next, for the rejections a post from this engine actually
 * meets. Codes as Reddit returns them in `json.errors` (PRAW's long-standing
 * observation; see submitPost's docblock on what is and is not proven).
 * ⚠️ RATELIMIT is deliberately NOT marked retryable: its wait is minutes
 * ("try again in 9 minutes"), far past retry.ts's 30s ceiling.
 */
const SUBMIT_HINTS: ReadonlyMap<string, string> = new Map([
  [
    "SUBMIT_VALIDATION_FLAIR_REQUIRED",
    " [this subreddit requires a post flair: set one on the Reddit render; the subreddit's destination rules list its flair ids]",
  ],
  ["RATELIMIT", " [Reddit is throttling this account; nothing was posted, publish again after the stated wait]"],
]);

export type RedditTokenResolver = () => Promise<string>;

let _resolver: RedditTokenResolver | null = null;

/**
 * Register (or clear, with null) the resolver that supplies a bearer access
 * token.
 *
 * INJECTED rather than imported, exactly like setPinterestTokenResolver and
 * setXTokenResolver: this folder is the portable engine and cannot reach an
 * app-side OAuth store directly.
 *
 * ⚠️ Deliberately called fresh on EVERY request, never cached here. PROVEN
 * (reddit-archive/reddit/wiki/OAuth2, fetched 2026-08-03): "All bearer tokens
 * expire after 1 hour" and a `duration=permanent` grant issues a
 * `refresh_token` an app must exchange for a new access token when the
 * current one expires. Whatever application store owns that exchange will
 * own the caching and the expiry check for the
 * token it hands back, same as every other resolver in this engine. A token
 * cached a second time in THIS file would keep serving an expired-or-stale
 * token past that store's own refresh cycle -- the one-hour window makes
 * this a near-certainty rather than an edge case, not a theoretical risk.
 */
export function setRedditTokenResolver(resolver: RedditTokenResolver | null): void {
  _resolver = resolver;
}

async function token(): Promise<string> {
  if (!_resolver) {
    throw new RedditError(0, "no Reddit token resolver registered (call setRedditTokenResolver)", "GET", "(resolver)");
  }
  const t = await _resolver();
  if (!t) {
    throw new RedditError(0, "Reddit token resolver returned an empty token", "GET", "(resolver)");
  }
  return t;
}

/**
 * Reddit's own rate-limit clock: `x-ratelimit-reset` is the seconds until the
 * window resets, and it is what a 429 from oauth.reddit.com carries in place of
 * a `Retry-After`. Rounded up to whole seconds, because retry.ts reads only RFC
 * 9110 delta-seconds and would otherwise discard a fractional value. Tolerates a
 * header bag with no callable `get` for retryAfterHeader's reason: this runs on
 * the error path, where a throw would replace the vendor's message.
 */
function rateLimitReset(res: Response): string | null {
  const headers = res.headers as { get?: unknown } | undefined;
  if (typeof headers?.get !== "function") return null;
  const raw = res.headers.get("x-ratelimit-reset");
  const seconds = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? String(Math.ceil(seconds)) : null;
}

/**
 * All requests go through here, GET and POST alike. `raw_json=1` is forced
 * onto every call (query for GET, form for POST): PROVEN
 * (reddit.com/dev/api's "response body encoding" section, fetched
 * 2026-08-03) -- "For legacy reasons, all JSON response bodies currently
 * have `<`, `>`, and `&` replaced with `&lt;`, `&gt;`, and `&amp;`... If you
 * wish to opt out of this behaviour, add a `raw_json=1` parameter." Without
 * it a title or body containing any of those three characters comes back
 * from the vendor corrupted.
 */
async function request(
  method: string,
  path: string,
  // `query` values are plain strings: every caller passes a defined id list, so
  // there is no undefined value to skip (the type used to allow one nobody sent).
  opts: { query?: Record<string, string>; form?: URLSearchParams; timeoutMs?: number } = {},
): Promise<unknown> {
  const accessToken = await token();
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;

  // Always run, even with no `opts.query` at all: `raw_json=1` has to reach
  // EVERY call (see this function's docblock), and a GET with no other query
  // parameters -- getMe(), getSubredditAbout(), etc. -- is the common case,
  // not an edge case.
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(opts.query ?? {})) params.set(k, v);
  params.set("raw_json", "1");
  const url = `${BASE_URL}${path}?${params.toString()}`;
  const form = opts.form;
  if (form) form.set("raw_json", "1");

  const resOpts: VendorFetchOptions = { timeoutMs, wrap: (status, message) => new RedditError(status, message, method, path) };
  const res = await vendorFetch(
    url,
    {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": redditUserAgent(),
        ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      body: form ? form.toString() : undefined,
    },
    resOpts,
  );
  const text = await vendorText(res, resOpts);
  if (!res.ok) {
    const retryAfter = retryAfterHeader(res) ?? rateLimitReset(res);
    const body =
      res.status === 429
        ? `rate limited by Reddit (${retryAfter === null ? "no reset time given" : `resets in ${retryAfter}s`}); nothing was posted. ${text}`
        : text;
    throw new RedditError(res.status, body, method, path, retryAfter);
  }
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RedditError(res.status, `expected JSON, got: ${text.slice(0, 200)}`, method, path);
  }
}

/* -------------------------------------------------------------------------- */
/*  Submit / delete                                                           */
/* -------------------------------------------------------------------------- */

/**
 * `image` submits a post whose `url` is an asset uploaded via uploadMediaAsset.
 * Like `link` it has no body field, which is why the copy still has to carry
 * itself in the title or a follow-up comment.
 */
export type RedditPostKind = "self" | "link" | "image";

export interface SubmitPostInput {
  /** Bare subreddit name, no `/r/` prefix -- see this function's docblock. */
  subreddit: string;
  title: string;
  kind: RedditPostKind;
  /** Self-post body (markdown). Only sent for kind "self" -- a link post has no body field at all. */
  text?: string;
  /** Only sent for kind "link". */
  url?: string;
  flairId?: string;
  flairText?: string;
  nsfw?: boolean;
  sendReplies?: boolean;
  resubmit?: boolean;
}

export interface RedditPost {
  /** Base36 id, no type prefix, e.g. "1abcde". */
  id: string;
  /** Fullname, e.g. "t3_1abcde" -- what /api/del and /api/info both want directly. */
  name: string;
}

interface RedditSubmitData {
  id?: string;
  name?: string;
  /** Media submissions only: where the processed post's permalink is announced. */
  websocket_url?: string;
}

/** How long to wait for Reddit to announce a processed image post. */
const MEDIA_POST_WS_TIMEOUT_MS = 30_000;

/**
 * Wait for Reddit to announce an image post's permalink.
 *
 * ⚠️ [unverified] like the upload lease it follows: the protocol is what PRAW's
 * `_submit_media` has relied on for years (one JSON message, `{type:"success",
 * payload:{redirect}}` or `{type:"failed"}`), not a documented contract.
 *
 * ⛔ Every failure here is a 200 RedditError, which retry.ts never repeats under
 * `rejected-only`: the submit was ACCEPTED, so the post may well exist, and a
 * retry would post it twice. The message says to check before republishing.
 */
function awaitMediaPost(websocketUrl: string): Promise<RedditPost> {
  const unknownOutcome = (why: string) =>
    new RedditError(
      200,
      `Reddit accepted the image post but its id never arrived (${why}); check the account's posts before publishing again`,
      "POST",
      "/api/submit",
    );
  if (!websocketUrl.startsWith("wss://")) {
    return Promise.reject(unknownOutcome(`the announced websocket is not wss: ${websocketUrl.slice(0, 80)}`));
  }

  return new Promise<RedditPost>((resolve, reject) => {
    let settled = false;
    let ws: WebSocket | null = null;
    const finish = (outcome: RedditPost | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws?.close();
      } catch {
        // Closing is courtesy; the outcome is already decided.
      }
      if (outcome instanceof Error) reject(outcome);
      else resolve(outcome);
    };
    const timer = setTimeout(
      () => finish(unknownOutcome(`no announcement within ${MEDIA_POST_WS_TIMEOUT_MS / 1000}s`)),
      MEDIA_POST_WS_TIMEOUT_MS,
    );

    try {
      ws = new WebSocket(websocketUrl);
    } catch (err) {
      finish(unknownOutcome(`the websocket could not be opened: ${String(err)}`));
      return;
    }
    ws.onerror = () => finish(unknownOutcome("the websocket errored"));
    ws.onclose = () => finish(unknownOutcome("the websocket closed before announcing"));
    ws.onmessage = (event: MessageEvent) => {
      let update: { type?: unknown; payload?: { redirect?: unknown } };
      try {
        update = JSON.parse(String(event.data)) as typeof update;
      } catch {
        finish(unknownOutcome("the announcement was not JSON"));
        return;
      }
      if (update?.type === "failed") {
        finish(new RedditError(200, "Reddit reported that processing the image post failed; nothing was posted", "POST", "/api/submit"));
        return;
      }
      const redirect = typeof update?.payload?.redirect === "string" ? update.payload.redirect : "";
      const id = /\/comments\/([a-z0-9]+)/i.exec(redirect)?.[1];
      // The announcement is a vendor body: it is not echoed into the error.
      finish(id ? { id, name: `t3_${id}` } : unknownOutcome("the announcement named no post"));
    };
  });
}

/** The `api_type=json` envelope of /api/submit: the error list and the data submitPost reads. */
function readSubmitResponse(value: unknown): { errors: Array<Array<string | undefined>>; data?: RedditSubmitData; raw: unknown } {
  const s = shape("reddit", "POST /api/submit");
  const json = s.optObj(s.obj(value, "(body)").json, "json");
  const errors = s.optEach(json?.errors, "json.errors", (entry, at) =>
    s.each(entry, at, (part, partAt) => (part === null ? undefined : s.optStr(part, partAt))),
  );
  // A rejection is read before the success fields: a malformed `data` beside
  // a real `json.errors` must not hide the rejection (and its flair signal).
  if (errors.length) return { errors, raw: value };
  const data = s.optObj(json?.data, "json.data");
  return {
    errors,
    data: data && {
      id: s.optStr(data.id, "json.data.id"),
      name: s.optStr(data.name, "json.data.name"),
      websocket_url: s.optStr(data.websocket_url, "json.data.websocket_url"),
    },
    raw: value,
  };
}

/**
 * POST /api/submit. PROVEN against https://www.reddit.com/dev/api#POST_api_submit
 * (fetched 2026-08-02/03, full page text checked): `api_type` ("the string
 * json", required), `sr`, `kind` (one of link/self/image/video/videogif),
 * `title` ("up to 300 characters long"), `text` ("raw markdown text"),
 * `url`, `flair_id` ("a string no longer than 36 characters"), `flair_text`
 * ("a string no longer than 64 characters"), `nsfw`, `sendreplies`,
 * `resubmit` are exactly the documented parameters and their documented
 * constraints. The scope badge on the page is `submit`.
 *
 * `sr` is sent BARE, deliberately not `/r/${sr}`. The task's own briefing
 * (and postiz.ts's subredditRestrictions docblock, read before writing this)
 * both confirm the `/r/` prefix Postiz's provider needs is that provider's
 * OWN artifact (`subreddit.split('/r/')[1]`), not a Reddit requirement --
 * every parameter on this endpoint that names a subreddit (`sr` here,
 * the `subreddit` path segment on the endpoints below) is documented as
 * just "subreddit name", no prefix shown in any example.
 *
 * ⚠️ NOT proven: the shape of the `api_type=json` response ENVELOPE. The
 * official page documents `api_type` as a parameter but never shows a worked
 * response example for this or any other `api_type=json` endpoint on the
 * whole page (checked: no `"errors"` or similar string appears anywhere in
 * the fetched HTML outside of unrelated signup-form markup). The
 * `{json:{errors:[[code,message,field]], data:{id,name,...}}}` shape parsed
 * below is what every long-lived third-party Reddit client (PRAW, snoowrap)
 * has relied on for over a decade, and it is what this function assumes --
 * but it is INFERRED, not vendor-confirmed against an official worked
 * example, which is exactly why the parsing below refuses to guess:
 *
 *   1. A non-empty `json.errors` throws RedditApiError -- the documented
 *      "200 with the real failure inside the body" case the task flagged as
 *      the single most likely failure mode here.
 *   2. An empty `json.errors` with no usable `id`/`name` in `json.data`
 *      throws too, as a THIRD failure shape distinct from both an HTTP error
 *      and an embedded error list -- 200, no errors, but nothing to point at
 *      either. A client that returned `undefined` here would look exactly
 *      like the one that produced this platform's only prior result:
 *      state ERROR with nothing else ever recorded.
 *
 * Only a response with a real id AND a real name returns normally.
 */
export async function submitPost(input: SubmitPostInput): Promise<RedditPost> {
  const form = new URLSearchParams();
  form.set("api_type", "json");
  form.set("sr", input.subreddit);
  form.set("kind", input.kind);
  form.set("title", input.title);
  if (input.kind === "self") {
    if (input.text) form.set("text", input.text);
  } else {
    if (!input.url) {
      throw new RedditError(0, `submitPost: kind "${input.kind}" requires a url`, "POST", "/api/submit");
    }
    form.set("url", input.url);
  }
  if (input.flairId) form.set("flair_id", input.flairId);
  if (input.flairText) form.set("flair_text", input.flairText);
  if (input.nsfw !== undefined) form.set("nsfw", String(input.nsfw));
  if (input.sendReplies !== undefined) form.set("sendreplies", String(input.sendReplies));
  if (input.resubmit !== undefined) form.set("resubmit", String(input.resubmit));

  const res = readSubmitResponse(await request("POST", "/api/submit", { form }));

  const rawErrors = res.errors;
  if (rawErrors.length) {
    const entries: RedditApiErrorEntry[] = rawErrors.map((e) => ({
      code: e[0] ?? "UNKNOWN",
      message: e[1] ?? "(no message)",
      field: e[2] ?? null,
    }));
    throw new RedditApiError(entries, "POST", "/api/submit");
  }

  const data = res.data;
  // An image submission answers with no id at all: the post is processed
  // asynchronously and its permalink arrives on a websocket (see awaitMediaPost).
  if (input.kind === "image" && !data?.name && data?.websocket_url) {
    return awaitMediaPost(data.websocket_url);
  }
  if (!data?.id || !data?.name) {
    throw new RedditError(
      200,
      "submit returned 200 with no errors but no usable post id/name either",
      "POST",
      "/api/submit",
    );
  }
  return { id: data.id, name: data.name };
}

/**
 * POST /api/del. PROVEN against https://www.reddit.com/dev/api#POST_api_del
 * (fetched 2026-08-03): scope `edit`, single parameter `id` ("fullname of a
 * thing created by the user"). Notably this endpoint has NO `api_type`
 * parameter documented at all, unlike /api/submit -- so it does not appear
 * to use the errors-in-body envelope in the first place.
 *
 * ⚠️ NOT proven: what calling this on an already-deleted or never-existent
 * id returns. The official page documents no response body or error shape
 * for this endpoint whatsoever, worked example or otherwise. This client
 * stays a thin passthrough (throws on any non-2xx, matching pinterest.ts's
 * deletePin / x.ts's deleteTweet); whether "already gone" needs special
 * handling is reddit-transport.ts's call, and its docblock explains why the
 * answer here is "no, because there is nothing to detect."
 */
export async function deleteThing(fullname: string): Promise<void> {
  const form = new URLSearchParams();
  form.set("id", fullname);
  await request("POST", "/api/del", { form });
}

/* -------------------------------------------------------------------------- */
/*  Lookup                                                                    */
/* -------------------------------------------------------------------------- */

/** Vendor does not state a per-call cap for this endpoint (see getInfo's docblock) -- chosen defensively, matching the pattern the vendor's own general Rules explicitly ask for (batch over loop). */
/**
 * Exported so reddit-transport.ts's postFacts can chunk at the SAME size and
 * wrap each call in its own try/catch. It cannot be left internal: getInfo's
 * loop has no per-chunk error handling, so one failing chunk rejects the whole
 * call and discards every fullname already confirmed by earlier chunks. Every
 * other transport in this engine catches per batch and continues; Reddit was
 * the sole exception (audited across all nine, 2026-08-05).
 *
 * Deliberately NOT fixed by catching inside this loop: a swallowed chunk would
 * return a partial Set indistinguishable from "the vendor omitted these", and
 * this function's contract is explicitly that it does not editorialize about
 * omissions. The caller must be able to tell "we could not ask" from "we asked
 * and it was not in the answer", so the chunking belongs where that distinction
 * is drawn.
 */
export const INFO_BATCH_LIMIT = 100;

/** The `data` of each child of an /api/info listing, as an object or absent. */
function listingChildren(value: unknown): Array<{ data: JsonObject | undefined; at: string; s: Shape }> {
  const s = shape("reddit", "GET /api/info");
  const data = s.optObj(s.obj(value, "(body)").data, "data");
  return s.optEach(data?.children, "data.children", (child, at) => ({
    data: s.optObj(s.obj(child, at).data, `${at}.data`),
    at: `${at}.data`,
    s,
  }));
}

/**
 * GET /api/info. PROVEN against https://www.reddit.com/dev/api#GET_api_info
 * (fetched 2026-08-03): path `[/r/subreddit]/api/info`, scope `read`,
 * parameter `id` ("A comma-separated list of thing fullnames"). This client
 * calls the subreddit-less form (`/api/info`), since fullnames are globally
 * unique and the transport that calls this does not track which subreddit
 * each ref came from.
 *
 * ⚠️ NOT proven: a maximum fullname count for THIS endpoint specifically
 * (the page states no number, unlike /by_id/{names} which also gives none).
 * INFO_BATCH_LIMIT's 100 is this client's own conservative choice, not a
 * vendor-stated figure -- chosen because the vendor's own Rules page
 * (reddit-archive/reddit/wiki/API) explicitly asks for batching over
 * looping single-resource calls, and 100 matches the convention every other
 * paginated Reddit listing in the official docs uses for its `limit` cap.
 *
 * ⚠️ NOT proven: what happens to a fullname that does not exist (deleted,
 * never existed, or simply inaccessible to this token for some other
 * reason -- a quarantined subreddit, a removed post, a banned author). The
 * page states only that a listing is returned; it does not say a missing
 * fullname is guaranteed omitted rather than, say, causing the whole call to
 * error, and it does not distinguish "gone" from "you can't see this one"
 * among the reasons a fullname could be missing. reddit-transport.ts's
 * postFacts therefore treats an id absent from the returned set as UNKNOWN,
 * never as a confirmed absence -- the same discipline
 * pinterest-transport.ts and bluesky-transport.ts already apply to their own
 * ambiguous-omission cases, for the same reason: a QUEUE that should have
 * been ERROR self-corrects on the next pass, but an ERROR that should have
 * been QUEUE marks a live post dead for good.
 *
 * Returns the SET of fullnames the vendor confirmed exist among those asked
 * for. Callers infer "not in the set" themselves; this function does not
 * editorialize about what that means.
 */
export async function getInfo(fullnames: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < fullnames.length; i += INFO_BATCH_LIMIT) {
    // Never empty: the loop only runs while i < fullnames.length.
    const batch = fullnames.slice(i, i + INFO_BATCH_LIMIT);
    const res = await request("GET", "/api/info", { query: { id: batch.join(",") } });
    for (const { data, at, s } of listingChildren(res)) {
      const name = s.optStr(data?.name, `${at}.name`);
      if (name) found.add(name);
    }
  }
  return found;
}

/**
 * Public counters for posts we own, from the SAME `/api/info` endpoint getInfo
 * already calls.
 *
 * Kept as its own function rather than widening getInfo's return type: that one
 * is on the reconcile path and its contract is deliberately narrow ("returns
 * the SET of fullnames the vendor confirmed exist… does not editorialize"), and
 * postFacts must not start depending on fields whose presence is not
 * guaranteed.
 *
 * ⚠️ `score` is FUZZED BY REDDIT, on purpose and by documented design — the
 * platform perturbs vote counts to frustrate vote manipulation, so two calls
 * seconds apart can legitimately disagree. It is an approximate signal, never
 * a reconciliation input, and nothing here should treat a change in it as an
 * event. `upvote_ratio` is likewise a rounded figure.
 *
 * A field the listing omits is left OUT rather than defaulted to 0 — same rule
 * as the YouTube and Bluesky analytics: a real zero and a missing counter must
 * not look the same on a dashboard.
 */
export interface RedditPostStats {
  name: string;
  score?: number;
  comments?: number;
  upvoteRatio?: number;
}


export async function getPostStats(fullnames: string[]): Promise<RedditPostStats[]> {
  if (!fullnames.length) return [];
  const out: RedditPostStats[] = [];
  for (let i = 0; i < fullnames.length; i += INFO_BATCH_LIMIT) {
    const batch = fullnames.slice(i, i + INFO_BATCH_LIMIT);
    const res = await request("GET", "/api/info", { query: { id: batch.join(",") } });
    for (const { data: d, at, s } of listingChildren(res)) {
      const name = s.optStr(d?.name, `${at}.name`);
      if (!d || !name) continue;
      const row: RedditPostStats = { name };
      const score = s.optNum(d.score, `${at}.score`);
      const comments = s.optNum(d.num_comments, `${at}.num_comments`);
      const upvoteRatio = s.optNum(d.upvote_ratio, `${at}.upvote_ratio`);
      if (score !== undefined) row.score = score;
      if (comments !== undefined) row.comments = comments;
      if (upvoteRatio !== undefined) row.upvoteRatio = upvoteRatio;
      out.push(row);
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Per-destination rules (the analogue of Pinterest's listBoards)            */
/* -------------------------------------------------------------------------- */

export interface RedditSubredditAbout {
  displayName?: string;
  /** PROVEN field name and enum (reddit-archive/reddit/wiki/JSON, fetched 2026-08-03): "one of 'any', 'link' or 'self'". */
  submissionType?: "any" | "link" | "self";
  over18?: boolean;
}


/**
 * GET /r/{subreddit}/about. PROVEN endpoint + scope against
 * https://www.reddit.com/dev/api#GET_r_{subreddit}_about (fetched
 * 2026-08-03): scope `read`, "Return information about the subreddit. Data
 * includes the subscriber count, description, and header image." PROVEN
 * field `submission_type` and its three values against
 * reddit-archive/reddit/wiki/JSON's `subreddit` thing table.
 *
 * ⚠️ NOT proven: `allow_images` as a field on this response. The task's own
 * briefing names `allow_images` alongside `submission_type` and
 * `is_flair_required` as what `/r/<sub>/about.json` carries; this client
 * could not confirm `allow_images` on any official page (the JSON wiki's
 * `subreddit` field table, which is the only official field-level reference
 * for this response found, does not list it, though that page also warns
 * its own contents are incomplete). This is not used here for that reason --
 * see reddit-transport.ts's destinationRules docblock for how the gap is
 * closed instead (this transport never needs "does this subreddit accept
 * images" anyway, since it refuses all media publishing regardless).
 */
export async function getSubredditAbout(subreddit: string): Promise<RedditSubredditAbout> {
  const s = shape("reddit", "GET /r/:subreddit/about");
  const d = s.optObj(s.obj(await request("GET", `/r/${encodeURIComponent(subreddit)}/about`), "(body)").data, "data") ?? {};
  const st = s.optStr(d.submission_type, "data.submission_type");
  return {
    displayName: s.optStr(d.display_name, "data.display_name"),
    submissionType: st === "any" || st === "link" || st === "self" ? st : undefined,
    over18: s.optBool(d.over18, "data.over18"),
  };
}

export interface RedditPostRequirements {
  bodyRestrictionPolicy?: "required" | "notAllowed" | "none";
  isFlairRequired?: boolean;
  titleMinLength?: number;
  titleMaxLength?: number;
}


/**
 * GET /api/v1/{subreddit}/post_requirements. PROVEN against
 * https://www.reddit.com/dev/api#GET_api_v1_{subreddit}_post_requirements
 * (fetched 2026-08-03, full field list quoted): scope `submit`,
 * `is_flair_required` (boolean), `body_restriction_policy` (one of
 * "required"/"notAllowed"/"none"), `title_text_max_length`,
 * `title_text_min_length`, plus blacklist/whitelist fields this client does
 * not surface. This is a BETTER and more precisely documented source for
 * "is a flair mandatory here" than `/about` -- see reddit-transport.ts's
 * destinationRules docblock for why this client uses both endpoints rather
 * than the single one the task's briefing named.
 */
export async function getPostRequirements(subreddit: string): Promise<RedditPostRequirements> {
  const s = shape("reddit", "GET /api/v1/:subreddit/post_requirements");
  const res = s.obj(await request("GET", `/api/v1/${encodeURIComponent(subreddit)}/post_requirements`), "(body)");
  const policy = s.optStr(res.body_restriction_policy, "body_restriction_policy");
  return {
    bodyRestrictionPolicy: policy === "required" || policy === "notAllowed" || policy === "none" ? policy : undefined,
    isFlairRequired: s.optBool(res.is_flair_required, "is_flair_required"),
    titleMinLength: s.optNum(res.title_text_min_length, "title_text_min_length"),
    titleMaxLength: s.optNum(res.title_text_max_length, "title_text_max_length"),
  };
}

export interface RedditFlairTemplate {
  id: string;
  text: string;
}

/**
 * GET /r/{subreddit}/api/link_flair_v2. PROVEN endpoint + scope against
 * https://www.reddit.com/dev/api#GET_api_link_flair_v2 (fetched 2026-08-03):
 * scope `flair`, "Return list of available link flair for the current
 * subreddit. Will not return flair if the user cannot set their own link
 * flair and they are not a moderator that can set flair."
 *
 * ⚠️ NOT proven: the field names on each array entry. The page gives no
 * parameter/response table for this endpoint at all (description only), so
 * this parses defensively for both the v2 (`id`/`text`) and legacy v1
 * (`flair_template_id`/`flair_text`) field name pairs rather than asserting
 * one, and silently drops any entry that matches neither shape rather than
 * guessing.
 *
 * That last sentence in the vendor description also means an empty result
 * here is genuinely ambiguous -- "this subreddit has no flair templates" and
 * "this token cannot see them" look identical. Callers should not treat
 * `[]` as proof a subreddit has no flair.
 */
export async function getLinkFlair(subreddit: string): Promise<RedditFlairTemplate[]> {
  const s = shape("reddit", "GET /r/:subreddit/api/link_flair_v2");
  const res = await request("GET", `/r/${encodeURIComponent(subreddit)}/api/link_flair_v2`);
  // An empty body (no flair configured) is no templates; anything else must be the list.
  if (res === undefined) return [];
  return s.each(res, "(body)", (raw, at) => {
    const item = s.obj(raw, at);
    const id = s.id(item.id ?? item.flair_template_id, `${at}.id`);
    const text = s.str(item.text ?? item.flair_text, `${at}.text`);
    return { id, text };
  });
}

/* -------------------------------------------------------------------------- */
/*  Account                                                                    */
/* -------------------------------------------------------------------------- */

export interface RedditProfile {
  id: string;
  name: string;
  /**
   * Karma counters. ⚠️ [unverified] FIELD NAMES — /dev/api documents this
   * endpoint's scope and purpose but publishes no response schema at all (see
   * getMe's docblock: even `id`/`name` sitting at the top level is operational
   * knowledge rather than documented). These are the long-established names.
   *
   * Safe to read on that basis in a way a WRITE parameter would not be: an
   * absent field simply stays undefined and is omitted from the analytics bag,
   * so a wrong guess degrades to "no data" rather than to a silent no-op that
   * looks like it worked.
   */
  linkKarma?: number;
  commentKarma?: number;
  totalKarma?: number;
}


/**
 * GET /api/v1/me. PROVEN endpoint + scope against
 * https://www.reddit.com/dev/api#GET_api_v1_me (fetched 2026-08-03): scope
 * `identity`, "Returns the identity of the user."
 *
 * ⚠️ NOT proven on that page: the exact response shape. This function reads
 * `id`/`name` at the TOP LEVEL of the response rather than nested under a
 * `data` key the way a generic "thing" (reddit-archive/reddit/wiki/JSON) is
 * wrapped -- this is the long-established real shape of this specific
 * endpoint, but that is operational knowledge, not something stated in
 * prose on either official page fetched for this file.
 */
export async function getMe(): Promise<RedditProfile> {
  const s = shape("reddit", "GET /api/v1/me");
  const res = s.obj(await request("GET", "/api/v1/me"), "(body)");
  const id = s.optStr(res.id, "id");
  const name = s.optStr(res.name, "name");
  if (!id || !name) {
    throw new RedditError(0, "GET /api/v1/me returned no id/name", "GET", "/api/v1/me");
  }
  const profile: RedditProfile = { id, name };
  const linkKarma = s.optNum(res.link_karma, "link_karma");
  const commentKarma = s.optNum(res.comment_karma, "comment_karma");
  const totalKarma = s.optNum(res.total_karma, "total_karma");
  if (linkKarma !== undefined) profile.linkKarma = linkKarma;
  if (commentKarma !== undefined) profile.commentKarma = commentKarma;
  if (totalKarma !== undefined) profile.totalKarma = totalKarma;
  return profile;
}

/* -------------------------------------------------------------------------- */
/*  Media upload                                                               */
/* -------------------------------------------------------------------------- */

/**
 * ⛔ THIS ENDPOINT IS NOT IN REDDIT'S PUBLIC API REFERENCE. Re-checked against
 * reddit.com/dev/api on 2026-08-05: the reference documents S3 upload leases
 * for EMOJI (`/api/v1/{sr}/emoji_asset_upload_s3.json`), WIDGETS
 * (`/r/{sr}/api/widget_image_upload_s3`) and subreddit styling
 * (`/r/{sr}/api/upload_sr_img`) — and nothing at all for POST media.
 * `/api/media/asset.json` is known only from client behaviour, so the request
 * and response shapes below are `[unverified]` in the sense this repo means it:
 * derived from observation, not from a vendor contract we can point at.
 *
 * Two consequences, both deliberate:
 *
 *   1. It is OFF unless SOCIALMETA_REDDIT_MEDIA_UPLOAD=1. Shipping speculative
 *      code into a publish path on by default would make every Reddit post
 *      depend on a guess.
 *   2. A failure NEVER fails the publish. The transport falls back to the self
 *      post it makes today, loudly. Losing the card is recoverable by hand;
 *      losing the post is not.
 *
 * ⚠️ Not yet proven live. The upload has not been exercised against the live endpoint,
 * and the tests assert THIS CLIENT'S behaviour, not Reddit's agreement with it.
 * A green suite here is not evidence the upload works.
 */
export function redditMediaUploadEnabled(): boolean {
  return process.env.SOCIALMETA_REDDIT_MEDIA_UPLOAD === "1";
}

interface RedditUploadLease {
  args?: { action?: string; fields?: Array<{ name?: string; value?: string }> };
  asset?: { asset_id?: string };
}

/** The S3 upload lease: where to POST, the policy fields in order, and the asset id. */
function readUploadLease(value: unknown): RedditUploadLease {
  const s = shape("reddit", "POST /api/media/asset.json");
  const body = s.obj(value, "(body)");
  const args = s.optObj(body.args, "args");
  const asset = s.optObj(body.asset, "asset");
  return {
    args: args && {
      action: s.optStr(args.action, "args.action"),
      fields: s.optEach(args.fields, "args.fields", (f, at) => {
        const field = s.obj(f, at);
        return { name: s.optStr(field.name, `${at}.name`), value: s.optStr(field.value, `${at}.value`) };
      }),
    },
    asset: asset && { asset_id: s.optStr(asset.asset_id, "asset.asset_id") },
  };
}

/**
 * Step 1: ask Reddit for an S3 upload lease.
 * Step 2: POST the bytes to the S3 endpoint the lease names, with its fields.
 *
 * Returns the public asset URL, which is what `submitPost({ kind: "image" })`
 * takes as its `url`.
 */
export async function uploadMediaAsset(
  bytes: Uint8Array<ArrayBuffer>,
  filename: string,
  mimeType: string,
): Promise<{ url: string; assetId?: string }> {
  const form = new URLSearchParams();
  form.set("filepath", filename);
  form.set("mimetype", mimeType);
  const lease = readUploadLease(await request("POST", "/api/media/asset.json", { form }));

  const action = lease.args?.action;
  const fields = lease.args?.fields ?? [];
  if (!action || !fields.length) {
    throw new RedditError(
      0,
      "media lease returned no upload action/fields",
      "POST",
      "/api/media/asset.json",
    );
  }

  // The lease's `action` is protocol-relative ("//bucket.s3...."), which is not
  // a URL `fetch` accepts. Normalised here rather than at the call site so a
  // future caller cannot reintroduce the same bug.
  const endpoint = action.startsWith("//") ? `https:${action}` : action;

  // The upload target is whatever the lease response named, so it is remote
  // input deciding where bytes get POSTed. Refuse anything that is not plain
  // https: a `http://169.254.169.254/...` (or `file:`) action would otherwise
  // turn this into a request against the metadata service from inside the pod.
  let endpointUrl: URL;
  try {
    endpointUrl = new URL(endpoint);
  } catch {
    throw new RedditError(0, `media lease named an unparseable upload action: ${endpoint}`, "POST", endpoint);
  }
  if (endpointUrl.protocol !== "https:") {
    throw new RedditError(
      0,
      `media lease named a non-https upload action (${endpointUrl.protocol}//), refusing to upload`,
      "POST",
      endpoint,
    );
  }

  // ⛔ https ALONE IS NOT ENOUGH, and the check above used to be the whole
  // guard. It stops `http://169.254.169.254/` and `file:`, and stops nothing
  // about `https://10.0.0.5/` or a name that resolves into the origin's own
  // private network, so a compromised or spoofed lease response could still
  // aim this multipart POST at an internal service. Reuse the repo's existing
  // guard (src/ssrf.ts) rather than growing a
  // second one here: it resolves the host ONCE, rejects private/reserved
  // addresses, and hands back an undici
  // dispatcher pinned to the address it validated so `fetch` cannot re-resolve
  // to a different one at connect time. `redirect: "error"` is the other half:
  // S3 answers this POST with `success_action_status`, never a 3xx, so refusing
  // redirects costs nothing here and closes the 302-into-the-private-network
  // bypass. A rejection degrades to the self post that submitPost already falls
  // back to when the (undocumented) upload fails.
  //
  // Engine rule check: `./ssrf` is the engine's own module (relative imports
  // only), so the folder stays liftable.
  const { dispatcher, redirect } = await preparePinnedHttpsFetch(endpoint);

  const upload = new FormData();
  // ⚠️ ORDER MATTERS to S3: every policy field must precede `file`, and S3
  // ignores anything sent after it. Appending in the lease's own order and
  // adding the file LAST is not stylistic.
  for (const field of fields) {
    if (field.name) upload.set(field.name, field.value ?? "");
  }
  upload.set("file", new Blob([bytes], { type: mimeType }), filename);

  const res = await fetch(endpoint, {
    method: "POST",
    body: upload,
    signal: AbortSignal.timeout(MEDIA_UPLOAD_TIMEOUT_MS),
    // Both present in production; both undefined under NODE_ENV==="test",
    // where preparePinnedHttpsFetch skips DNS, so the init shape is unchanged
    // for unit tests.
    ...(redirect ? { redirect } : {}),
    ...(dispatcher ? { dispatcher } : {}),
  } as RequestInit & { dispatcher?: UndiciAgent });
  if (!res.ok) {
    throw new RedditError(res.status, `S3 upload rejected the asset (HTTP ${res.status})`, "POST", endpoint);
  }

  const key = fields.find((f) => f.name === "key")?.value;
  if (!key) {
    throw new RedditError(0, "media lease carried no `key` field, so the asset URL cannot be built", "POST", endpoint);
  }

  return { url: `${endpoint.replace(/\/+$/, "")}/${key}`, assetId: lease.asset?.asset_id };
}
