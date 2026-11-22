/**
 * Vendored from @atproto/api 0.20.44 (dist/client/types/app/bsky/embed/record.d.ts), generated
 * lexicon types, copyright Bluesky Social PBC and contributors, MIT licence (see
 * NOTICE). Types only: the generated is/validate functions and constants are
 * dropped, and BlobRef is this package's JSON form (src/bluesky-lexicon/blob-ref.ts).
 *
 * Kept so the types district-social 0.1.0 exported from @atproto/api keep their
 * exact shape. Do not edit by hand.
 */
import type { $Typed } from "../../../util.js";
import type * as ComAtprotoRepoStrongRef from "../../../com/atproto/repo/strongRef.js";
import type * as AppBskyFeedDefs from "../feed/defs.js";
import type * as AppBskyGraphDefs from "../graph/defs.js";
import type * as AppBskyLabelerDefs from "../labeler/defs.js";
import type * as AppBskyActorDefs from "../actor/defs.js";
import type * as ComAtprotoLabelDefs from "../../../com/atproto/label/defs.js";
import type * as AppBskyEmbedImages from "./images.js";
import type * as AppBskyEmbedVideo from "./video.js";
import type * as AppBskyEmbedGallery from "./gallery.js";
import type * as AppBskyEmbedExternal from "./external.js";
import type * as AppBskyEmbedRecordWithMedia from "./recordWithMedia.js";
export interface Main {
    $type?: 'app.bsky.embed.record';
    record: ComAtprotoRepoStrongRef.Main;
}
export interface View {
    $type?: 'app.bsky.embed.record#view';
    record: $Typed<ViewRecord> | $Typed<ViewNotFound> | $Typed<ViewBlocked> | $Typed<ViewDetached> | $Typed<AppBskyFeedDefs.GeneratorView> | $Typed<AppBskyGraphDefs.ListView> | $Typed<AppBskyLabelerDefs.LabelerView> | $Typed<AppBskyGraphDefs.StarterPackViewBasic> | {
        $type: string;
    };
}
export interface ViewRecord {
    $type?: 'app.bsky.embed.record#viewRecord';
    uri: string;
    cid: string;
    author: AppBskyActorDefs.ProfileViewBasic;
    /** The record data itself. */
    value: {
        [_ in string]: unknown;
    };
    labels?: ComAtprotoLabelDefs.Label[];
    replyCount?: number;
    repostCount?: number;
    likeCount?: number;
    quoteCount?: number;
    embeds?: ($Typed<AppBskyEmbedImages.View> | $Typed<AppBskyEmbedVideo.View> | $Typed<AppBskyEmbedGallery.View> | $Typed<AppBskyEmbedExternal.View> | $Typed<View> | $Typed<AppBskyEmbedRecordWithMedia.View> | {
        $type: string;
    })[];
    indexedAt: string;
}
export interface ViewNotFound {
    $type?: 'app.bsky.embed.record#viewNotFound';
    uri: string;
    notFound: true;
}
export interface ViewBlocked {
    $type?: 'app.bsky.embed.record#viewBlocked';
    uri: string;
    blocked: true;
    author: AppBskyFeedDefs.BlockedAuthor;
}
export interface ViewDetached {
    $type?: 'app.bsky.embed.record#viewDetached';
    uri: string;
    detached: true;
}
