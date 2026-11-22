/**
 * Vendored from @atproto/api 0.20.44 (dist/client/types/app/bsky/graph/defs.d.ts), generated
 * lexicon types, copyright Bluesky Social PBC and contributors, MIT licence (see
 * NOTICE). Types only: the generated is/validate functions and constants are
 * dropped, and BlobRef is this package's JSON form (src/bluesky-lexicon/blob-ref.ts).
 *
 * Kept so the types district-social 0.1.0 exported from @atproto/api keep their
 * exact shape. Do not edit by hand.
 */
import type * as ComAtprotoLabelDefs from "../../../com/atproto/label/defs.js";
import type * as AppBskyActorDefs from "../actor/defs.js";
import type * as AppBskyRichtextFacet from "../richtext/facet.js";
import type * as AppBskyFeedDefs from "../feed/defs.js";
export interface ListViewBasic {
    $type?: 'app.bsky.graph.defs#listViewBasic';
    uri: string;
    cid: string;
    name: string;
    purpose: ListPurpose;
    avatar?: string;
    listItemCount?: number;
    labels?: ComAtprotoLabelDefs.Label[];
    viewer?: ListViewerState;
    indexedAt?: string;
}
export interface ListView {
    $type?: 'app.bsky.graph.defs#listView';
    uri: string;
    cid: string;
    creator: AppBskyActorDefs.ProfileView;
    name: string;
    purpose: ListPurpose;
    description?: string;
    descriptionFacets?: AppBskyRichtextFacet.Main[];
    avatar?: string;
    listItemCount?: number;
    labels?: ComAtprotoLabelDefs.Label[];
    viewer?: ListViewerState;
    indexedAt: string;
}
export interface ListItemView {
    $type?: 'app.bsky.graph.defs#listItemView';
    uri: string;
    subject: AppBskyActorDefs.ProfileView;
    /** Set to true when the subject has opted out of appearing in the reference list. Only set when the viewer owns the list. */
    subjectOptedOut?: true;
}
export interface StarterPackView {
    $type?: 'app.bsky.graph.defs#starterPackView';
    uri: string;
    cid: string;
    record: {
        [_ in string]: unknown;
    };
    creator: AppBskyActorDefs.ProfileViewBasic;
    list?: ListViewBasic;
    listItemsSample?: ListItemView[];
    feeds?: AppBskyFeedDefs.GeneratorView[];
    joinedWeekCount?: number;
    joinedAllTimeCount?: number;
    labels?: ComAtprotoLabelDefs.Label[];
    indexedAt: string;
}
export interface StarterPackViewBasic {
    $type?: 'app.bsky.graph.defs#starterPackViewBasic';
    uri: string;
    cid: string;
    record: {
        [_ in string]: unknown;
    };
    creator: AppBskyActorDefs.ProfileViewBasic;
    listItemCount?: number;
    joinedWeekCount?: number;
    joinedAllTimeCount?: number;
    labels?: ComAtprotoLabelDefs.Label[];
    indexedAt: string;
}
export type ListPurpose = 'app.bsky.graph.defs#modlist' | 'app.bsky.graph.defs#curatelist' | 'app.bsky.graph.defs#referencelist' | (string & {});
/** A list of actors to apply an aggregate moderation action (mute/block) on. */
/** A list of actors used for curation purposes such as list feeds or interaction gating. */
/** A list of actors used for only for reference purposes such as within a starter pack. */
export interface ListViewerState {
    $type?: 'app.bsky.graph.defs#listViewerState';
    muted?: boolean;
    blocked?: string;
    /** The authenticated viewer's app.bsky.graph.referencelistoptout record URI for this reference list. Only set for reference lists. A client can delete this record to undo the opt-out. */
    referenceListOptOut?: string;
}
/** indicates that a handle or DID could not be resolved */
export interface NotFoundActor {
    $type?: 'app.bsky.graph.defs#notFoundActor';
    actor: string;
    notFound: true;
}
/** lists the bi-directional graph relationships between one actor (not indicated in the object), and the target actors (the DID included in the object) */
export interface Relationship {
    $type?: 'app.bsky.graph.defs#relationship';
    did: string;
    /** if the actor follows this DID, this is the AT-URI of the follow record */
    following?: string;
    /** if the actor is followed by this DID, contains the AT-URI of the follow record */
    followedBy?: string;
    /** if the actor blocks this DID, this is the AT-URI of the block record */
    blocking?: string;
    /** if the actor is blocked by this DID, contains the AT-URI of the block record */
    blockedBy?: string;
    /** if the actor blocks this DID via a block list, this is the AT-URI of the listblock record */
    blockingByList?: string;
    /** if the actor is blocked by this DID via a block list, contains the AT-URI of the listblock record */
    blockedByList?: string;
}
