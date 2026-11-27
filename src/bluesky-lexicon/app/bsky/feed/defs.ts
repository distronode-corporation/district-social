// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Vendored from @atproto/api 0.20.44 (dist/client/types/app/bsky/feed/defs.d.ts), generated
 * lexicon types, copyright Bluesky Social PBC and contributors, MIT licence (see
 * NOTICE). Types only: the generated is/validate functions and constants are
 * dropped, and BlobRef is this package's JSON form (src/bluesky-lexicon/blob-ref.ts).
 *
 * Kept so the types district-social 0.1.0 exported from @atproto/api keep their
 * exact shape. Do not edit by hand.
 */
import type { $Typed } from "../../../util.js";
import type * as AppBskyActorDefs from "../actor/defs.js";
import type * as AppBskyEmbedImages from "../embed/images.js";
import type * as AppBskyEmbedVideo from "../embed/video.js";
import type * as AppBskyEmbedGallery from "../embed/gallery.js";
import type * as AppBskyEmbedExternal from "../embed/external.js";
import type * as AppBskyEmbedRecord from "../embed/record.js";
import type * as AppBskyEmbedRecordWithMedia from "../embed/recordWithMedia.js";
import type * as ComAtprotoLabelDefs from "../../../com/atproto/label/defs.js";
import type * as AppBskyRichtextFacet from "../richtext/facet.js";
import type * as AppBskyGraphDefs from "../graph/defs.js";
export interface PostView {
    $type?: 'app.bsky.feed.defs#postView';
    uri: string;
    cid: string;
    author: AppBskyActorDefs.ProfileViewBasic;
    record: {
        [_ in string]: unknown;
    };
    embed?: $Typed<AppBskyEmbedImages.View> | $Typed<AppBskyEmbedVideo.View> | $Typed<AppBskyEmbedGallery.View> | $Typed<AppBskyEmbedExternal.View> | $Typed<AppBskyEmbedRecord.View> | $Typed<AppBskyEmbedRecordWithMedia.View> | {
        $type: string;
    };
    bookmarkCount?: number;
    replyCount?: number;
    repostCount?: number;
    likeCount?: number;
    quoteCount?: number;
    indexedAt: string;
    viewer?: ViewerState;
    labels?: ComAtprotoLabelDefs.Label[];
    threadgate?: ThreadgateView;
    /** Debug information for internal development */
    debug?: {
        [_ in string]: unknown;
    };
}
/** Metadata about the requesting account's relationship with the subject content. Only has meaningful content for authed requests. */
export interface ViewerState {
    $type?: 'app.bsky.feed.defs#viewerState';
    repost?: string;
    like?: string;
    bookmarked?: boolean;
    threadMuted?: boolean;
    replyDisabled?: boolean;
    embeddingDisabled?: boolean;
    pinned?: boolean;
    knownLikers?: KnownLikers;
}
/** The post's likers whom you also follow */
export interface KnownLikers {
    $type?: 'app.bsky.feed.defs#knownLikers';
    count: number;
    actors: AppBskyActorDefs.ProfileViewBasic[];
}
/** Metadata about this post within the context of the thread it is in. */
export interface ThreadContext {
    $type?: 'app.bsky.feed.defs#threadContext';
    rootAuthorLike?: string;
}
export interface FeedViewPost {
    $type?: 'app.bsky.feed.defs#feedViewPost';
    post: PostView;
    reply?: ReplyRef;
    reason?: $Typed<ReasonRepost> | $Typed<ReasonPin> | {
        $type: string;
    };
    /** Context provided by feed generator that may be passed back alongside interactions. */
    feedContext?: string;
    /** Unique identifier per request that may be passed back alongside interactions. */
    reqId?: string;
}
export interface ReplyRef {
    $type?: 'app.bsky.feed.defs#replyRef';
    root: $Typed<PostView> | $Typed<NotFoundPost> | $Typed<BlockedPost> | {
        $type: string;
    };
    parent: $Typed<PostView> | $Typed<NotFoundPost> | $Typed<BlockedPost> | {
        $type: string;
    };
    grandparentAuthor?: AppBskyActorDefs.ProfileViewBasic;
}
export interface ReasonRepost {
    $type?: 'app.bsky.feed.defs#reasonRepost';
    by: AppBskyActorDefs.ProfileViewBasic;
    uri?: string;
    cid?: string;
    indexedAt: string;
}
export interface ReasonPin {
    $type?: 'app.bsky.feed.defs#reasonPin';
}
export interface ThreadViewPost {
    $type?: 'app.bsky.feed.defs#threadViewPost';
    post: PostView;
    parent?: $Typed<ThreadViewPost> | $Typed<NotFoundPost> | $Typed<BlockedPost> | {
        $type: string;
    };
    replies?: ($Typed<ThreadViewPost> | $Typed<NotFoundPost> | $Typed<BlockedPost> | {
        $type: string;
    })[];
    threadContext?: ThreadContext;
}
export interface NotFoundPost {
    $type?: 'app.bsky.feed.defs#notFoundPost';
    uri: string;
    notFound: true;
}
export interface BlockedPost {
    $type?: 'app.bsky.feed.defs#blockedPost';
    uri: string;
    blocked: true;
    author: BlockedAuthor;
}
export interface BlockedAuthor {
    $type?: 'app.bsky.feed.defs#blockedAuthor';
    did: string;
    viewer?: AppBskyActorDefs.ViewerState;
}
export interface GeneratorView {
    $type?: 'app.bsky.feed.defs#generatorView';
    uri: string;
    cid: string;
    did: string;
    creator: AppBskyActorDefs.ProfileView;
    displayName: string;
    description?: string;
    descriptionFacets?: AppBskyRichtextFacet.Main[];
    avatar?: string;
    likeCount?: number;
    acceptsInteractions?: boolean;
    labels?: ComAtprotoLabelDefs.Label[];
    viewer?: GeneratorViewerState;
    contentMode?: 'app.bsky.feed.defs#contentModeUnspecified' | 'app.bsky.feed.defs#contentModeVideo' | (string & {});
    indexedAt: string;
}
export interface GeneratorViewerState {
    $type?: 'app.bsky.feed.defs#generatorViewerState';
    like?: string;
}
export interface SkeletonFeedPost {
    $type?: 'app.bsky.feed.defs#skeletonFeedPost';
    post: string;
    reason?: $Typed<SkeletonReasonRepost> | $Typed<SkeletonReasonPin> | {
        $type: string;
    };
    /** Context that will be passed through to client and may be passed to feed generator back alongside interactions. */
    feedContext?: string;
}
export interface SkeletonReasonRepost {
    $type?: 'app.bsky.feed.defs#skeletonReasonRepost';
    repost: string;
}
export interface SkeletonReasonPin {
    $type?: 'app.bsky.feed.defs#skeletonReasonPin';
}
export interface ThreadgateView {
    $type?: 'app.bsky.feed.defs#threadgateView';
    uri?: string;
    cid?: string;
    record?: {
        [_ in string]: unknown;
    };
    lists?: AppBskyGraphDefs.ListViewBasic[];
}
export interface Interaction {
    $type?: 'app.bsky.feed.defs#interaction';
    item?: string;
    event?: 'app.bsky.feed.defs#requestLess' | 'app.bsky.feed.defs#requestMore' | 'app.bsky.feed.defs#clickthroughItem' | 'app.bsky.feed.defs#clickthroughAuthor' | 'app.bsky.feed.defs#clickthroughReposter' | 'app.bsky.feed.defs#clickthroughEmbed' | 'app.bsky.feed.defs#interactionSeen' | 'app.bsky.feed.defs#interactionLike' | 'app.bsky.feed.defs#interactionRepost' | 'app.bsky.feed.defs#interactionReply' | 'app.bsky.feed.defs#interactionQuote' | 'app.bsky.feed.defs#interactionShare' | (string & {});
    /** Context on a feed item that was originally supplied by the feed generator on getFeedSkeleton. */
    feedContext?: string;
    /** Unique identifier per request that may be passed back alongside interactions. */
    reqId?: string;
}
/** Request that less content like the given feed item be shown in the feed */
/** Request that more content like the given feed item be shown in the feed */
/** User clicked through to the feed item */
/** User clicked through to the author of the feed item */
/** User clicked through to the reposter of the feed item */
/** User clicked through to the embedded content of the feed item */
/** Declares the feed generator returns any types of posts. */
/** Declares the feed generator returns posts containing app.bsky.embed.video embeds. */
/** Feed item was seen by user */
/** User liked the feed item */
/** User reposted the feed item */
/** User replied to the feed item */
/** User quoted the feed item */
/** User shared the feed item */
