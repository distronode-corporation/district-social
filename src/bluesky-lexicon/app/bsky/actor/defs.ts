// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Vendored from @atproto/api 0.20.44 (dist/client/types/app/bsky/actor/defs.d.ts), generated
 * lexicon types, copyright Bluesky Social PBC and contributors, MIT licence (see
 * NOTICE). Types only: the generated is/validate functions and constants are
 * dropped, and BlobRef is this package's JSON form (src/bluesky-lexicon/blob-ref.ts).
 *
 * Kept so the types district-social 0.1.0 exported from @atproto/api keep their
 * exact shape. Do not edit by hand.
 */
import type { $Typed } from "../../../util.js";
import type * as ComAtprotoLabelDefs from "../../../com/atproto/label/defs.js";
import type * as AppBskyGraphDefs from "../graph/defs.js";
import type * as ComAtprotoRepoStrongRef from "../../../com/atproto/repo/strongRef.js";
import type * as AppBskyNotificationDefs from "../notification/defs.js";
import type * as AppBskyFeedThreadgate from "../feed/threadgate.js";
import type * as AppBskyFeedPostgate from "../feed/postgate.js";
import type * as AppBskyEmbedExternal from "../embed/external.js";
export interface ProfileViewBasic {
    $type?: 'app.bsky.actor.defs#profileViewBasic';
    did: string;
    handle: string;
    displayName?: string;
    pronouns?: string;
    avatar?: string;
    associated?: ProfileAssociated;
    viewer?: ViewerState;
    labels?: ComAtprotoLabelDefs.Label[];
    createdAt?: string;
    verification?: VerificationState;
    status?: StatusView;
    /** Debug information for internal development */
    debug?: {
        [_ in string]: unknown;
    };
}
export interface ProfileView {
    $type?: 'app.bsky.actor.defs#profileView';
    did: string;
    handle: string;
    displayName?: string;
    pronouns?: string;
    description?: string;
    avatar?: string;
    associated?: ProfileAssociated;
    indexedAt?: string;
    createdAt?: string;
    viewer?: ViewerState;
    labels?: ComAtprotoLabelDefs.Label[];
    verification?: VerificationState;
    status?: StatusView;
    /** Debug information for internal development */
    debug?: {
        [_ in string]: unknown;
    };
}
export interface ProfileViewDetailed {
    $type?: 'app.bsky.actor.defs#profileViewDetailed';
    did: string;
    handle: string;
    displayName?: string;
    description?: string;
    pronouns?: string;
    website?: string;
    avatar?: string;
    banner?: string;
    followersCount?: number;
    followsCount?: number;
    postsCount?: number;
    associated?: ProfileAssociated;
    joinedViaStarterPack?: AppBskyGraphDefs.StarterPackViewBasic;
    indexedAt?: string;
    createdAt?: string;
    viewer?: ViewerState;
    labels?: ComAtprotoLabelDefs.Label[];
    pinnedPost?: ComAtprotoRepoStrongRef.Main;
    verification?: VerificationState;
    status?: StatusView;
    /** Debug information for internal development */
    debug?: {
        [_ in string]: unknown;
    };
}
export interface ProfileAssociated {
    $type?: 'app.bsky.actor.defs#profileAssociated';
    lists?: number;
    feedgens?: number;
    starterPacks?: number;
    labeler?: boolean;
    chat?: ProfileAssociatedChat;
    activitySubscription?: ProfileAssociatedActivitySubscription;
    germ?: ProfileAssociatedGerm;
}
export interface ProfileAssociatedChat {
    $type?: 'app.bsky.actor.defs#profileAssociatedChat';
    allowIncoming: 'all' | 'none' | 'following' | (string & {});
    allowGroupInvites?: 'all' | 'none' | 'following' | (string & {});
}
export interface ProfileAssociatedGerm {
    $type?: 'app.bsky.actor.defs#profileAssociatedGerm';
    messageMeUrl: string;
    showButtonTo: 'usersIFollow' | 'everyone' | (string & {});
}
export interface ProfileAssociatedActivitySubscription {
    $type?: 'app.bsky.actor.defs#profileAssociatedActivitySubscription';
    allowSubscriptions: 'followers' | 'mutuals' | 'none' | (string & {});
}
/** Metadata about the requesting account's relationship with the subject account. Only has meaningful content for authed requests. */
export interface ViewerState {
    $type?: 'app.bsky.actor.defs#viewerState';
    /** Whether the account is fully muted, directly or via a mutelist. False when the mute is scoped to specific kinds; see mutedOnlyReposts and mutedOnlyQuoteposts. */
    muted?: boolean;
    /** Whether the account's reposts are muted. Scoped mutes are exclusive with muted: this can be true while muted is false. If muted is true, this will be false. */
    mutedOnlyReposts?: boolean;
    /** Whether the account's quote posts are muted. Scoped mutes are exclusive with muted: this can be true while muted is false. If muted is true, this will be false. */
    mutedOnlyQuoteposts?: boolean;
    mutedByList?: AppBskyGraphDefs.ListViewBasic;
    blockedBy?: boolean;
    blocking?: string;
    blockingByList?: AppBskyGraphDefs.ListViewBasic;
    following?: string;
    followedBy?: string;
    knownFollowers?: KnownFollowers;
    activitySubscription?: AppBskyNotificationDefs.ActivitySubscription;
}
/** The subject's followers whom you also follow */
export interface KnownFollowers {
    $type?: 'app.bsky.actor.defs#knownFollowers';
    count: number;
    followers: ProfileViewBasic[];
}
/** Represents the verification information about the user this object is attached to. */
export interface VerificationState {
    $type?: 'app.bsky.actor.defs#verificationState';
    /** All verifications issued by trusted verifiers on behalf of this user. Verifications by untrusted verifiers are not included. */
    verifications: VerificationView[];
    /** The user's status as a verified account. */
    verifiedStatus: 'valid' | 'invalid' | 'none' | (string & {});
    /** The user's status as a trusted verifier. */
    trustedVerifierStatus: 'valid' | 'invalid' | 'none' | (string & {});
}
/** An individual verification for an associated subject. */
export interface VerificationView {
    $type?: 'app.bsky.actor.defs#verificationView';
    /** The user who issued this verification. */
    issuer: string;
    /** The display name of the issuer. */
    issuerDisplayName?: string;
    /** The handle of the issuer. */
    issuerHandle?: string;
    /** The AT-URI of the verification record. */
    uri: string;
    /** True if the verification passes validation, otherwise false. */
    isValid: boolean;
    /** Timestamp when the verification was created. */
    createdAt: string;
}
export type Preferences = ($Typed<AdultContentPref> | $Typed<ContentLabelPref> | $Typed<SavedFeedsPref> | $Typed<SavedFeedsPrefV2> | $Typed<PersonalDetailsPref> | $Typed<DeclaredAgePref> | $Typed<FeedViewPref> | $Typed<ThreadViewPref> | $Typed<InterestsPref> | $Typed<MutedWordsPref> | $Typed<HiddenPostsPref> | $Typed<BskyAppStatePref> | $Typed<LabelersPref> | $Typed<PostInteractionSettingsPref> | $Typed<VerificationPrefs> | $Typed<LiveEventPreferences> | {
    $type: string;
})[];
export interface AdultContentPref {
    $type?: 'app.bsky.actor.defs#adultContentPref';
    enabled: boolean;
}
export interface ContentLabelPref {
    $type?: 'app.bsky.actor.defs#contentLabelPref';
    /** Which labeler does this preference apply to? If undefined, applies globally. */
    labelerDid?: string;
    label: string;
    visibility: 'ignore' | 'show' | 'warn' | 'hide' | (string & {});
}
export interface SavedFeed {
    $type?: 'app.bsky.actor.defs#savedFeed';
    id: string;
    type: 'feed' | 'list' | 'timeline' | (string & {});
    value: string;
    pinned: boolean;
}
export interface SavedFeedsPrefV2 {
    $type?: 'app.bsky.actor.defs#savedFeedsPrefV2';
    items: SavedFeed[];
}
export interface SavedFeedsPref {
    $type?: 'app.bsky.actor.defs#savedFeedsPref';
    pinned: string[];
    saved: string[];
    timelineIndex?: number;
}
export interface PersonalDetailsPref {
    $type?: 'app.bsky.actor.defs#personalDetailsPref';
    /** The birth date of account owner. */
    birthDate?: string;
}
/** Read-only preference containing value(s) inferred from the user's declared birthdate. Absence of this preference object in the response indicates that the user has not made a declaration. */
export interface DeclaredAgePref {
    $type?: 'app.bsky.actor.defs#declaredAgePref';
    /** Indicates if the user has declared that they are over 13 years of age. */
    isOverAge13?: boolean;
    /** Indicates if the user has declared that they are over 16 years of age. */
    isOverAge16?: boolean;
    /** Indicates if the user has declared that they are over 18 years of age. */
    isOverAge18?: boolean;
}
export interface FeedViewPref {
    $type?: 'app.bsky.actor.defs#feedViewPref';
    /** The URI of the feed, or an identifier which describes the feed. */
    feed: string;
    /** Hide replies in the feed. */
    hideReplies?: boolean;
    /** Hide replies in the feed if they are not by followed users. */
    hideRepliesByUnfollowed: boolean;
    /** Hide replies in the feed if they do not have this number of likes. */
    hideRepliesByLikeCount?: number;
    /** Hide reposts in the feed. */
    hideReposts?: boolean;
    /** Hide quote posts in the feed. */
    hideQuotePosts?: boolean;
}
export interface ThreadViewPref {
    $type?: 'app.bsky.actor.defs#threadViewPref';
    /** Sorting mode for threads. */
    sort?: 'oldest' | 'newest' | 'most-likes' | 'random' | 'hotness' | (string & {});
}
export interface InterestsPref {
    $type?: 'app.bsky.actor.defs#interestsPref';
    /** The timestamp when the account owner last updated their interests. */
    updatedAt?: string;
    /** A list of tags which describe the account owner's interests gathered during onboarding. */
    tags: string[];
}
export type MutedWordTarget = 'content' | 'tag' | (string & {});
/** A word that the account owner has muted. */
export interface MutedWord {
    $type?: 'app.bsky.actor.defs#mutedWord';
    id?: string;
    /** The muted word itself. */
    value: string;
    /** The intended targets of the muted word. */
    targets: MutedWordTarget[];
    /** Groups of users to apply the muted word to. If undefined, applies to all users. */
    actorTarget: 'all' | 'exclude-following' | (string & {});
    /** The date and time at which the muted word will expire and no longer be applied. */
    expiresAt?: string;
}
export interface MutedWordsPref {
    $type?: 'app.bsky.actor.defs#mutedWordsPref';
    /** A list of words the account owner has muted. */
    items: MutedWord[];
}
export interface HiddenPostsPref {
    $type?: 'app.bsky.actor.defs#hiddenPostsPref';
    /** A list of URIs of posts the account owner has hidden. */
    items: string[];
}
export interface LabelersPref {
    $type?: 'app.bsky.actor.defs#labelersPref';
    labelers: LabelerPrefItem[];
}
export interface LabelerPrefItem {
    $type?: 'app.bsky.actor.defs#labelerPrefItem';
    did: string;
}
/** A grab bag of state that's specific to the bsky.app program. Third-party apps shouldn't use this. */
export interface BskyAppStatePref {
    $type?: 'app.bsky.actor.defs#bskyAppStatePref';
    activeProgressGuide?: BskyAppProgressGuide;
    /** Indicates if the user is participating in the beta features program. */
    isBetaUser?: boolean;
    /** An array of tokens which identify nudges (modals, popups, tours, highlight dots) that should be shown to the user. */
    queuedNudges?: string[];
    /** Storage for NUXs the user has encountered. */
    nuxs?: Nux[];
}
/** If set, an active progress guide. Once completed, can be set to undefined. Should have unspecced fields tracking progress. */
export interface BskyAppProgressGuide {
    $type?: 'app.bsky.actor.defs#bskyAppProgressGuide';
    guide: string;
}
/** A new user experiences (NUX) storage object */
export interface Nux {
    $type?: 'app.bsky.actor.defs#nux';
    id: string;
    completed: boolean;
    /** Arbitrary data for the NUX. The structure is defined by the NUX itself. Limited to 300 characters. */
    data?: string;
    /** The date and time at which the NUX will expire and should be considered completed. */
    expiresAt?: string;
}
/** Preferences for how verified accounts appear in the app. */
export interface VerificationPrefs {
    $type?: 'app.bsky.actor.defs#verificationPrefs';
    /** Hide the blue check badges for verified accounts and trusted verifiers. */
    hideBadges: boolean;
}
/** Preferences for live events. */
export interface LiveEventPreferences {
    $type?: 'app.bsky.actor.defs#liveEventPreferences';
    /** A list of feed IDs that the user has hidden from live events. */
    hiddenFeedIds?: string[];
    /** Whether to hide all feeds from live events. */
    hideAllFeeds: boolean;
}
/** Default post interaction settings for the account. These values should be applied as default values when creating new posts. These refs should mirror the threadgate and postgate records exactly. */
export interface PostInteractionSettingsPref {
    $type?: 'app.bsky.actor.defs#postInteractionSettingsPref';
    /** Matches threadgate record. List of rules defining who can reply to this users posts. If value is an empty array, no one can reply. If value is undefined, anyone can reply. */
    threadgateAllowRules?: ($Typed<AppBskyFeedThreadgate.MentionRule> | $Typed<AppBskyFeedThreadgate.FollowerRule> | $Typed<AppBskyFeedThreadgate.FollowingRule> | $Typed<AppBskyFeedThreadgate.ListRule> | {
        $type: string;
    })[];
    /** Matches postgate record. List of rules defining who can embed this users posts. If value is an empty array or is undefined, no particular rules apply and anyone can embed. */
    postgateEmbeddingRules?: ($Typed<AppBskyFeedPostgate.DisableRule> | {
        $type: string;
    })[];
}
export interface StatusView {
    $type?: 'app.bsky.actor.defs#statusView';
    uri?: string;
    cid?: string;
    /** The status for the account. */
    status: 'app.bsky.actor.status#live' | (string & {});
    record: {
        [_ in string]: unknown;
    };
    embed?: $Typed<AppBskyEmbedExternal.View> | {
        $type: string;
    };
    labels?: ComAtprotoLabelDefs.Label[];
    /** The date when this status will expire. The application might choose to no longer return the status after expiration. */
    expiresAt?: string;
    /** True if the status is not expired, false if it is expired. Only present if expiration was set. */
    isActive?: boolean;
    /** True if the user's go-live access has been disabled by a moderator, false otherwise. */
    isDisabled?: boolean;
}
