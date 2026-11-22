/**
 * The AT Protocol client Bluesky publishing runs on: XRPC calls over fetch, a
 * credential session that logs in, resumes and refreshes itself, and the
 * handful of methods the engine uses. It replaces `@atproto/api`, which pulled
 * a large dependency tree in for nine endpoints.
 *
 * What it keeps from `@atproto/api`'s CredentialSession, on purpose:
 *
 *   - the session events (`create`, `create-failed`, `update`, `expired`,
 *     `network-error`) and when each fires, which bluesky.ts's session store
 *     depends on;
 *   - a refused refresh token (a 401, ExpiredToken, InvalidToken, a DID that
 *     changed) ends the session, and anything else keeps it, bar a refresh
 *     answer the client cannot read, which ends it too;
 *   - an expired access token is refreshed once and the request sent once
 *     more, only after the refresh succeeded;
 *   - the account's PDS, read off the DID document a session answer carries,
 *     is where data calls go, while session calls stay on the entryway.
 *
 * What it does differently:
 *
 *   - the PDS is followed only over HTTPS and only to a public destination
 *     (`./ssrf.ts`); anything else keeps the calls on the entryway, which
 *     proxies to the right PDS. No XRPC call follows a redirect, so the bearer
 *     token never travels to a host the client did not choose;
 *   - every response is checked against its schema (`./bluesky-schemas.ts`);
 *   - an error keeps the vendor's real HTTP status.
 *
 * Relative imports only, like the rest of this folder.
 */

import type { z } from "zod";
import { getErrorMessage } from "./error-message.js";
import { assertPublicHttpsUrl } from "./ssrf.js";
import {
  deleteRecordOutput,
  didDocument,
  getPostsOutput,
  getProfileOutput,
  getSessionOutput,
  listRecordsOutput,
  readResponse,
  resolveHandleOutput,
  searchPostsOutput,
  sessionOutput,
  strongRefOutput,
  uploadBlobOutput,
  xrpcErrorBody,
} from "./bluesky-schemas.js";
import { ResponseShapeError } from "./http/shape.js";
import type { BlobRef } from "./bluesky-lexicon/blob-ref.js";
import type * as AppBskyFeedDefs from "./bluesky-lexicon/app/bsky/feed/defs.js";
import type * as AppBskyRichtextFacet from "./bluesky-lexicon/app/bsky/richtext/facet.js";
import type * as ComAtprotoRepoStrongRef from "./bluesky-lexicon/com/atproto/repo/strongRef.js";

export type { BlobRef };
export type StrongRef = ComAtprotoRepoStrongRef.Main;
export type Facet = AppBskyRichtextFacet.Main;
export type PostView = AppBskyFeedDefs.PostView;

/** A session's data, field for field what `@atproto/api` stored, so a stored session still resumes. */
export interface AtpSessionData {
  refreshJwt: string;
  accessJwt: string;
  handle: string;
  did: string;
  email?: string;
  emailConfirmed?: boolean;
  emailAuthFactor?: boolean;
  active: boolean;
  status?: string;
}

export type AtpSessionEvent = "create" | "create-failed" | "update" | "expired" | "network-error";
export type AtpPersistSessionHandler = (evt: AtpSessionEvent, session: AtpSessionData | undefined) => void;

/** `status` for a request that got no HTTP answer at all (a timeout, a refused connection). */
export const XRPC_NO_RESPONSE = 1;

/** The error names XRPC uses for an answer with no error body of its own. */
const STATUS_NAMES: Record<number, string> = {
  400: "InvalidRequest",
  401: "AuthenticationRequired",
  403: "Forbidden",
  404: "XRPCNotSupported",
  413: "PayloadTooLarge",
  429: "RateLimitExceeded",
  500: "InternalServerError",
  501: "MethodNotImplemented",
  502: "UpstreamFailure",
  503: "NotEnoughResources",
  504: "UpstreamTimeout",
};

/**
 * An XRPC failure. `status` is the HTTP status, or XRPC_NO_RESPONSE (1) when
 * no answer arrived. `error` is the XRPC error name, `headers` the answer's
 * headers, lowercased (bluesky.ts reads Retry-After from them).
 */
export class XRPCError extends Error {
  override readonly name = "XRPCError";

  constructor(
    readonly status: number,
    readonly error: string,
    message: string,
    readonly headers: Record<string, string> = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

type Params = Record<string, string | number | string[] | undefined>;

interface CallOptions {
  method: "GET" | "POST";
  params?: Params;
  /** A JSON body, or raw bytes. */
  body?: unknown;
  /** The content type of a raw-bytes body; a JSON body is sent as application/json. */
  encoding?: string;
  /** Session calls name their own bearer token; data calls carry the access token. */
  authorization?: string;
}

/** An answer, read to the end once, so the expiry check and the decode can both look at it. */
interface Answer {
  status: number;
  headers: Record<string, string>;
  text: string;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** The service URL a DID document names as its `#atproto_pds`, by the AT Protocol's rule. */
function pdsEndpoint(doc: unknown, did: string): string | undefined {
  const parsed = didDocument.safeParse(doc);
  if (!parsed.success || parsed.data.id !== did) return undefined;
  const service = parsed.data.service?.find(
    (s) => (s.id === "#atproto_pds" || s.id === `${did}#atproto_pds`) && s.type === "AtprotoPersonalDataServer",
  );
  return typeof service?.serviceEndpoint === "string" ? service.serviceEndpoint : undefined;
}

/**
 * The XRPC transport for one account: a session, the endpoint data calls go
 * to, and the fetch every call goes through.
 */
export class CredentialSession {
  session?: AtpSessionData;
  /** The account's PDS, once a session answer named a public HTTPS one. */
  pdsUrl?: URL;
  private refreshing?: Promise<void>;

  constructor(
    readonly serviceUrl: URL,
    private readonly fetchImpl: typeof fetch,
    readonly persistSession?: AtpPersistSessionHandler,
  ) {}

  get did(): string | undefined {
    return this.session?.did;
  }

  get hasSession(): boolean {
    return Boolean(this.session);
  }

  /** Where data calls go: the account's PDS when one was accepted, the entryway otherwise. */
  get dispatchUrl(): URL {
    return this.pdsUrl ?? this.serviceUrl;
  }

  /** com.atproto.server.createSession, replacing any session held. */
  async login(opts: { identifier: string; password: string }): Promise<void> {
    this.session = undefined;
    this.refreshing = undefined;
    try {
      const data = this.decode(
        "com.atproto.server.createSession",
        await this.send(this.serviceUrl, "com.atproto.server.createSession", {
          method: "POST",
          body: { identifier: opts.identifier, password: opts.password },
        }),
        sessionOutput,
      );
      this.session = {
        accessJwt: data.accessJwt,
        refreshJwt: data.refreshJwt,
        handle: data.handle,
        did: data.did,
        email: data.email,
        emailConfirmed: data.emailConfirmed,
        emailAuthFactor: data.emailAuthFactor,
        active: data.active ?? true,
        status: data.status,
      };
      await this.updateEndpoint(data.didDoc, data.did);
      this.persistSession?.("create", this.session);
    } catch (err) {
      this.session = undefined;
      this.persistSession?.("create-failed", undefined);
      throw err;
    }
  }

  /**
   * Resume a stored session, proven live by refreshing it. A rejection means
   * the refresh failed; `hasSession` then says whether the session survived
   * (a failure that says nothing about the token keeps it).
   */
  async resumeSession(session: AtpSessionData): Promise<void> {
    if (session.refreshJwt !== this.session?.refreshJwt) {
      this.session = session;
      this.refreshing = undefined;
    }
    await this.refreshSession();
    if (session.did !== this.session?.did) {
      throw new Error("DID mismatch on resumeSession");
    }
  }

  /** com.atproto.server.refreshSession, single-flighted: concurrent callers share one refresh. */
  async refreshSession(): Promise<void> {
    if (!this.session) throw new Error("Unexpected state: no session to refresh");
    if (this.refreshing) return this.refreshing;
    const pending = this.refreshInner(this.session).finally(() => {
      if (this.refreshing === pending) this.refreshing = undefined;
    });
    this.refreshing = pending;
    return pending;
  }

  private async refreshInner(session: AtpSessionData): Promise<void> {
    try {
      const data = this.decode(
        "com.atproto.server.refreshSession",
        await this.send(this.serviceUrl, "com.atproto.server.refreshSession", {
          method: "POST",
          authorization: session.refreshJwt,
        }),
        sessionOutput,
      );
      if (data.did !== session.did) {
        throw new XRPCError(400, "InvalidDID", "Invalid session");
      }
      let account: z.infer<typeof getSessionOutput> = data;
      // Some servers leave the email fields or the DID document out of a
      // refresh; getSession has them. Best effort: the refresh stands without it.
      if (data.emailConfirmed === undefined || data.didDoc === undefined) {
        try {
          const extra = this.decode(
            "com.atproto.server.getSession",
            await this.send(this.serviceUrl, "com.atproto.server.getSession", {
              method: "GET",
              authorization: data.accessJwt,
            }),
            getSessionOutput,
          );
          if (extra.did === data.did) account = { ...data, ...extra };
        } catch {
          // Keep what the refresh answered.
        }
      }
      if (this.session !== session) {
        throw new Error("Concurrent session update detected");
      }
      this.session = {
        did: data.did,
        accessJwt: data.accessJwt,
        refreshJwt: data.refreshJwt,
        handle: account.handle,
        email: account.email ?? session.email,
        emailConfirmed: account.emailConfirmed ?? session.emailConfirmed,
        emailAuthFactor: account.emailAuthFactor ?? session.emailAuthFactor,
        active: account.active ?? session.active,
        status: account.status,
      };
      await this.updateEndpoint(account.didDoc, data.did);
      this.persistSession?.("update", this.session);
    } catch (err) {
      if (this.session === session) {
        // ⛔ A refresh answer that could not be read ends the session too: the
        // server may have rotated the tokens already, so the refresh token
        // held is likely dead, and keeping it would leave a session that can
        // neither refresh nor be replaced by a login.
        if (
          err instanceof ResponseShapeError ||
          (err instanceof XRPCError &&
            (err.status === 401 || ["ExpiredToken", "InvalidToken", "InvalidDID"].includes(err.error)))
        ) {
          this.session = undefined;
          this.persistSession?.("expired", undefined);
        } else {
          this.persistSession?.("network-error", session);
        }
      }
      throw err;
    }
  }

  /**
   * Point data calls at the PDS the DID document names, when it is public
   * HTTPS; otherwise at the entryway. ⛔ The bearer token rides every data
   * call, so a document naming plain HTTP, a private or reserved address, or
   * a host that resolves to one, is not followed.
   */
  private async updateEndpoint(doc: unknown, did: string): Promise<void> {
    const endpoint = pdsEndpoint(doc, did);
    if (endpoint === undefined) {
      this.pdsUrl = undefined;
      return;
    }
    try {
      await assertPublicHttpsUrl(endpoint);
      this.pdsUrl = new URL(endpoint);
    } catch (err) {
      console.warn(`[bluesky] not following the account's PDS endpoint (${getErrorMessage(err)}); using ${this.serviceUrl.origin}`);
      this.pdsUrl = undefined;
    }
  }

  /**
   * One authenticated XRPC call to the dispatch URL, decoded through `schema`.
   *
   * ⛔ An expired access token (a 401, or a 400 ExpiredToken) is refreshed and
   * the request sent ONCE more, and only when the refresh succeeded with a new
   * token. Any other answer, a 5xx or no answer at all, is returned as it is:
   * the first request may have been performed, and a second create would be a
   * double post.
   */
  async call<S extends z.ZodType>(nsid: string, opts: CallOptions, schema: S): Promise<z.infer<S>> {
    await this.refreshing?.catch(() => {});
    const token = this.session?.accessJwt;
    let answer = await this.send(this.dispatchUrl, nsid, { ...opts, authorization: token });
    if (token && isExpiredToken(answer)) {
      let refreshed = false;
      try {
        await this.refreshSession();
        refreshed = true;
      } catch {
        // The first answer stands.
      }
      const next = this.session?.accessJwt;
      if (refreshed && next && next !== token) {
        answer = await this.send(this.dispatchUrl, nsid, { ...opts, authorization: next });
      }
    }
    return this.decode(nsid, answer, schema);
  }

  /** The request, read to the end. A request that got no answer is an XRPCError of status 1. */
  private async send(base: URL, nsid: string, opts: CallOptions): Promise<Answer> {
    const url = new URL(`/xrpc/${nsid}`, base);
    for (const [key, value] of Object.entries(opts.params ?? {})) {
      if (value === undefined) continue;
      for (const v of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(v));
    }
    const headers: Record<string, string> = {};
    if (opts.authorization) headers.authorization = `Bearer ${opts.authorization}`;
    let body: string | Uint8Array<ArrayBuffer> | undefined;
    if (opts.body !== undefined) {
      body = opts.body instanceof Uint8Array ? (opts.body as Uint8Array<ArrayBuffer>) : JSON.stringify(opts.body);
      headers["content-type"] = opts.encoding ?? "application/json";
    }
    try {
      // ⛔ redirect "error": no XRPC endpoint redirects, and a followed redirect
      // would carry the bearer token to wherever the answer pointed.
      const res = await this.fetchImpl(url, { method: opts.method, headers, body, redirect: "error" });
      const text = await res.text();
      const map: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        map[key.toLowerCase()] = value;
      });
      return { status: res.status, headers: map, text };
    } catch (err) {
      throw new XRPCError(XRPC_NO_RESPONSE, "Unknown", getErrorMessage(err), {}, { cause: err });
    }
  }

  /** A 2xx answer read through `schema`, or the XRPCError the answer carries. */
  private decode<S extends z.ZodType>(nsid: string, answer: Answer, schema: S): z.infer<S> {
    const json = answer.text === "" ? {} : parseJson(answer.text);
    if (answer.status < 200 || answer.status >= 300) {
      const envelope = xrpcErrorBody.safeParse(json);
      const error = (envelope.success ? envelope.data.error : undefined) ?? STATUS_NAMES[answer.status] ?? "Unknown";
      const message = (envelope.success ? envelope.data.message : undefined) ?? `HTTP ${answer.status}`;
      throw new XRPCError(answer.status, error, message, answer.headers);
    }
    if (json === undefined) {
      throw new ResponseShapeError("bluesky", nsid, "body", "JSON", "a body that is not JSON");
    }
    return readResponse(schema, json, nsid);
  }
}

function isExpiredToken(answer: Answer): boolean {
  if (answer.status === 401) return true;
  if (answer.status !== 400) return false;
  const envelope = xrpcErrorBody.safeParse(parseJson(answer.text));
  return envelope.success && envelope.data.error === "ExpiredToken";
}

/** An app.bsky.feed.post record, as the client sends it. */
export interface PostRecord {
  text: string;
  facets?: Facet[];
  embed?: { $type: "app.bsky.embed.images"; images: Array<{ image: BlobRef; alt: string }> };
  reply?: { root: StrongRef; parent: StrongRef };
  langs?: string[];
}

/** The methods the engine calls, over one CredentialSession. */
export class Agent {
  constructor(readonly sessionManager: CredentialSession) {}

  get did(): string | undefined {
    return this.sessionManager.did;
  }

  private repo(): string {
    const did = this.sessionManager.did;
    if (!did) throw new Error("Not logged in");
    return did;
  }

  /** com.atproto.repo.createRecord of an app.bsky.feed.post, stamped with the time it is sent. */
  async post(record: PostRecord): Promise<StrongRef> {
    const { uri, cid } = await this.sessionManager.call(
      "com.atproto.repo.createRecord",
      {
        method: "POST",
        body: {
          repo: this.repo(),
          collection: "app.bsky.feed.post",
          record: { $type: "app.bsky.feed.post", ...record, createdAt: new Date().toISOString() },
        },
      },
      strongRefOutput,
    );
    return { uri, cid };
  }

  /** com.atproto.repo.deleteRecord of the post an at:// URI names. */
  async deletePost(postUri: string): Promise<void> {
    const match = /^at:\/\/([^/]+)\/[^/]+\/([^/?#]+)$/.exec(postUri);
    if (!match) throw new Error(`Not a post URI: ${postUri}`);
    await this.sessionManager.call(
      "com.atproto.repo.deleteRecord",
      { method: "POST", body: { repo: match[1], collection: "app.bsky.feed.post", rkey: match[2] } },
      deleteRecordOutput,
    );
  }

  /** com.atproto.repo.uploadBlob: the bytes as the body, the MIME type as its content type. */
  async uploadBlob(data: Uint8Array, encoding: string): Promise<BlobRef> {
    const out = await this.sessionManager.call(
      "com.atproto.repo.uploadBlob",
      { method: "POST", body: data, encoding },
      uploadBlobOutput,
    );
    return out.blob;
  }

  async getPosts(uris: string[]): Promise<PostView[]> {
    const out = await this.sessionManager.call("app.bsky.feed.getPosts", { method: "GET", params: { uris } }, getPostsOutput);
    return out.posts as unknown as PostView[];
  }

  async searchPosts(params: { q: string; limit: number }): Promise<PostView[]> {
    const out = await this.sessionManager.call("app.bsky.feed.searchPosts", { method: "GET", params }, searchPostsOutput);
    return out.posts as unknown as PostView[];
  }

  async getProfile(actor: string): Promise<z.infer<typeof getProfileOutput>> {
    return this.sessionManager.call("app.bsky.actor.getProfile", { method: "GET", params: { actor } }, getProfileOutput);
  }

  async listRecords(params: { repo: string; collection: string; limit: number }): Promise<z.infer<typeof listRecordsOutput>> {
    return this.sessionManager.call("com.atproto.repo.listRecords", { method: "GET", params }, listRecordsOutput);
  }

  /** com.atproto.identity.resolveHandle: the DID a handle names. */
  async resolveHandle(handle: string): Promise<string> {
    const out = await this.sessionManager.call(
      "com.atproto.identity.resolveHandle",
      { method: "GET", params: { handle } },
      resolveHandleOutput,
    );
    return out.did;
  }
}
