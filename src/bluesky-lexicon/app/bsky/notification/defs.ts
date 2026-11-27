// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Vendored from @atproto/api 0.20.44 (dist/client/types/app/bsky/notification/defs.d.ts), generated
 * lexicon types, copyright Bluesky Social PBC and contributors, MIT licence (see
 * NOTICE). Types only: the generated is/validate functions and constants are
 * dropped, and BlobRef is this package's JSON form (src/bluesky-lexicon/blob-ref.ts).
 *
 * Kept so the types district-social 0.1.0 exported from @atproto/api keep their
 * exact shape. Do not edit by hand.
 */
export interface RecordDeleted {
    $type?: 'app.bsky.notification.defs#recordDeleted';
}
/** Deprecated: use chat.bsky.notification preferences instead. This will only return a default value. */
export interface ChatPreference {
    $type?: 'app.bsky.notification.defs#chatPreference';
    include: 'all' | 'accepted' | (string & {});
    push: boolean;
}
export interface FilterablePreference {
    $type?: 'app.bsky.notification.defs#filterablePreference';
    include: 'all' | 'follows' | (string & {});
    list: boolean;
    push: boolean;
}
export interface Preference {
    $type?: 'app.bsky.notification.defs#preference';
    list: boolean;
    push: boolean;
}
export interface Preferences {
    $type?: 'app.bsky.notification.defs#preferences';
    chat: ChatPreference;
    follow: FilterablePreference;
    like: FilterablePreference;
    likeViaRepost: FilterablePreference;
    mention: FilterablePreference;
    quote: FilterablePreference;
    reply: FilterablePreference;
    repost: FilterablePreference;
    repostViaRepost: FilterablePreference;
    starterpackJoined: Preference;
    subscribedPost: Preference;
    unverified: Preference;
    verified: Preference;
}
export interface ActivitySubscription {
    $type?: 'app.bsky.notification.defs#activitySubscription';
    post: boolean;
    reply: boolean;
}
/** Object used to store activity subscription data in stash. */
export interface SubjectActivitySubscription {
    $type?: 'app.bsky.notification.defs#subjectActivitySubscription';
    subject: string;
    activitySubscription: ActivitySubscription;
}
