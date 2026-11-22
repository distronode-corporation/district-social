/**
 * The shape of every Bluesky (AT Protocol) response the client reads, checked
 * field by field with zod at the client boundary.
 *
 * ⛔ A RESPONSE IS INPUT, NOT A TYPE. Each schema names the fields the lexicon
 * requires and the optional ones the engine reads, with their types. Fields
 * the client never reads are allowed through untouched (`looseObject`): the
 * lexicons grow all the time, and an additive change must never take a
 * publish down.
 *
 * ⛔ A FAILURE IS A ResponseShapeError (`./http/shape.ts`), the engine-wide
 * error for a 2xx answer the client cannot read. It names the path and the
 * KIND of value found there, never the value: a session answer carries tokens.
 * retry.ts counts it as an unknown outcome, so a create whose answer could not
 * be read is never sent again.
 *
 * Relative imports only, like the rest of this folder.
 */

import { z } from "zod";
import { ResponseShapeError, kindOf } from "./http/shape.js";

const nonEmpty = z.string().min(1);
const did = z.string().startsWith("did:");
const atUri = z.string().startsWith("at://");
const optString = z.optional(z.string());
const optNumber = z.optional(z.number());
const optBoolean = z.optional(z.boolean());

/** The XRPC error envelope. Read with `safeParse`: an error page that is not one is still an error. */
export const xrpcErrorBody = z.looseObject({ error: optString, message: optString });

/** com.atproto.server.createSession and com.atproto.server.refreshSession. */
export const sessionOutput = z.looseObject({
  accessJwt: nonEmpty,
  refreshJwt: nonEmpty,
  handle: z.string(),
  did,
  didDoc: z.optional(z.unknown()),
  email: optString,
  emailConfirmed: optBoolean,
  emailAuthFactor: optBoolean,
  active: optBoolean,
  status: optString,
});

/** com.atproto.server.getSession: the session's account, without tokens. */
export const getSessionOutput = z.looseObject({
  handle: z.string(),
  did,
  didDoc: z.optional(z.unknown()),
  email: optString,
  emailConfirmed: optBoolean,
  emailAuthFactor: optBoolean,
  active: optBoolean,
  status: optString,
});

/**
 * The part of a DID document the client reads: its id and its services. Read
 * with `safeParse`, never as a shape error: a session answer with no usable
 * document is still a session, and the client then talks to the entryway.
 */
export const didDocument = z.looseObject({
  id: z.string(),
  service: z.optional(
    z.array(z.looseObject({ id: z.string(), type: z.string(), serviceEndpoint: z.unknown() })),
  ),
});

/** com.atproto.repo.createRecord. */
export const strongRefOutput = z.looseObject({ uri: atUri, cid: nonEmpty });

/** com.atproto.repo.deleteRecord. The body is optional in the lexicon, and so is its commit. */
export const deleteRecordOutput = z.looseObject({
  commit: z.optional(z.looseObject({ cid: z.string(), rev: z.string() })),
});

/** com.atproto.repo.uploadBlob: the blob reference the post record embeds. */
export const uploadBlobOutput = z.looseObject({
  blob: z.looseObject({
    $type: z.literal("blob"),
    ref: z.looseObject({ $link: nonEmpty }),
    mimeType: nonEmpty,
    size: z.number(),
  }),
});

const label = z.looseObject({ src: z.string(), uri: z.string(), val: z.string(), cts: z.string() });

/** app.bsky.actor.defs#profileViewBasic, a post's author. */
const profileViewBasic = z.looseObject({
  did,
  handle: z.string(),
  displayName: optString,
  avatar: optString,
  createdAt: optString,
  labels: z.optional(z.array(label)),
});

/**
 * app.bsky.feed.defs#postView. The counts are optional in the lexicon and
 * stay optional here: a count the AppView has not aggregated reads as
 * unknown, not as zero. The embed is a union of views; its `$type` is checked,
 * its contents pass through.
 */
const postView = z.looseObject({
  uri: atUri,
  cid: nonEmpty,
  author: profileViewBasic,
  record: z.record(z.string(), z.unknown()),
  embed: z.optional(z.looseObject({ $type: z.string() })),
  bookmarkCount: optNumber,
  replyCount: optNumber,
  repostCount: optNumber,
  likeCount: optNumber,
  quoteCount: optNumber,
  indexedAt: z.string(),
  labels: z.optional(z.array(label)),
});

/** app.bsky.feed.getPosts. */
export const getPostsOutput = z.looseObject({ posts: z.array(postView) });

/** app.bsky.feed.searchPosts. */
export const searchPostsOutput = z.looseObject({
  cursor: optString,
  hitsTotal: optNumber,
  posts: z.array(postView),
});

/** app.bsky.actor.getProfile (profileViewDetailed), the fields the engine reads. */
export const getProfileOutput = z.looseObject({
  did,
  handle: z.string(),
  displayName: optString,
  followersCount: optNumber,
  followsCount: optNumber,
  postsCount: optNumber,
});

/** com.atproto.repo.listRecords. A record's value is the record itself, any object. */
export const listRecordsOutput = z.looseObject({
  cursor: optString,
  records: z.array(z.looseObject({ uri: atUri, cid: nonEmpty, value: z.record(z.string(), z.unknown()) })),
});

/** com.atproto.identity.resolveHandle. */
export const resolveHandleOutput = z.looseObject({ did });

/** `body.posts[2].uri`, from zod's path. */
function pathOf(path: PropertyKey[]): string {
  return path.reduce<string>((at, key) => (typeof key === "number" ? `${at}[${key}]` : `${at}.${String(key)}`), "body");
}

/**
 * The value at `path` inside `value`. Every step but the last is an object or
 * an array: zod reports an issue at the first level that does not fit, so a
 * path never runs through a primitive.
 */
function valueAt(value: unknown, path: PropertyKey[]): unknown {
  return path.reduce<unknown>((at, key) => (at as Record<PropertyKey, unknown>)[key], value);
}

const ARTICLE: Record<string, string> = { object: "an object", array: "an array" };

/** What the schema needed at the failing path, in words. Never the value found there. */
function expectedOf(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case "invalid_type":
      return ARTICLE[issue.expected] ?? `a ${issue.expected}`;
    case "too_small":
      return "a non-empty string";
    case "invalid_value":
      return `one of ${issue.values.map((v) => JSON.stringify(v)).join(", ")}`;
    default:
      return "a value of the documented format";
  }
}

/**
 * `value` read through `schema`, or a ResponseShapeError naming the first
 * field that does not fit. `operation` is the XRPC method, as every Bluesky
 * error names it.
 */
export function readResponse<S extends z.ZodType>(schema: S, value: unknown, operation: string): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0]!;
  throw new ResponseShapeError(
    "bluesky",
    operation,
    pathOf(issue.path),
    expectedOf(issue),
    kindOf(valueAt(value, issue.path)),
  );
}
