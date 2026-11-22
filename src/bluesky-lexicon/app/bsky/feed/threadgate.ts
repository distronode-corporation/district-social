/**
 * Vendored from @atproto/api 0.20.44 (dist/client/types/app/bsky/feed/threadgate.d.ts), generated
 * lexicon types, copyright Bluesky Social PBC and contributors, MIT licence (see
 * NOTICE). Types only: the generated is/validate functions and constants are
 * dropped, and BlobRef is this package's JSON form (src/bluesky-lexicon/blob-ref.ts).
 *
 * Kept so the types district-social 0.1.0 exported from @atproto/api keep their
 * exact shape. Do not edit by hand.
 */
import type { $Typed } from "../../../util.js";
export interface Main {
    $type: 'app.bsky.feed.threadgate';
    /** Reference (AT-URI) to the post record. */
    post: string;
    /** List of rules defining who can reply to this post. If value is an empty array, no one can reply. If value is undefined, anyone can reply. */
    allow?: ($Typed<MentionRule> | $Typed<FollowerRule> | $Typed<FollowingRule> | $Typed<ListRule> | {
        $type: string;
    })[];
    createdAt: string;
    /** List of hidden reply URIs. */
    hiddenReplies?: string[];
    [k: string]: unknown;
}
export type { Main as Record };
/** Allow replies from actors mentioned in your post. */
export interface MentionRule {
    $type?: 'app.bsky.feed.threadgate#mentionRule';
}
/** Allow replies from actors who follow you. */
export interface FollowerRule {
    $type?: 'app.bsky.feed.threadgate#followerRule';
}
/** Allow replies from actors you follow. */
export interface FollowingRule {
    $type?: 'app.bsky.feed.threadgate#followingRule';
}
/** Allow replies from actors on a list. */
export interface ListRule {
    $type?: 'app.bsky.feed.threadgate#listRule';
    list: string;
}
