// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Vendored from @atproto/api 0.20.44 (dist/client/types/app/bsky/embed/external.d.ts), generated
 * lexicon types, copyright Bluesky Social PBC and contributors, MIT licence (see
 * NOTICE). Types only: the generated is/validate functions and constants are
 * dropped, and BlobRef is this package's JSON form (src/bluesky-lexicon/blob-ref.ts).
 *
 * Kept so the types district-social 0.1.0 exported from @atproto/api keep their
 * exact shape. Do not edit by hand.
 */
import type { BlobRef } from "../../../blob-ref.js";
import type * as ComAtprotoRepoStrongRef from "../../../com/atproto/repo/strongRef.js";
import type * as ComAtprotoLabelDefs from "../../../com/atproto/label/defs.js";
import type * as AppBskyActorDefs from "../actor/defs.js";
/** A representation of some externally linked content (eg, a URL and 'card'), embedded in a Bluesky record (eg, a post). */
export interface Main {
    $type?: 'app.bsky.embed.external';
    external: External;
}
export interface External {
    $type?: 'app.bsky.embed.external#external';
    uri: string;
    title: string;
    description: string;
    thumb?: BlobRef;
    /** StrongRefs (uri+cid) of the Atmosphere records that backed this view. */
    associatedRefs?: ComAtprotoRepoStrongRef.Main[];
}
export interface View {
    $type?: 'app.bsky.embed.external#view';
    external: ViewExternal;
}
export interface ViewExternal {
    $type?: 'app.bsky.embed.external#viewExternal';
    uri: string;
    title: string;
    description: string;
    thumb?: string;
    /** When the external content was created, if available. Example: a publication date, for an article. */
    createdAt?: string;
    /** When the external content was updated, if available. */
    updatedAt?: string;
    /** Estimated reading time in minutes, if applicable and available. */
    readingTime?: number;
    labels?: ComAtprotoLabelDefs.Label[];
    source?: ViewExternalSource;
    /** StrongRefs (uri+cid) of the Atmosphere records that backed this view. */
    associatedRefs?: ComAtprotoRepoStrongRef.Main[];
    /** Profiles of the owners of the Atmosphere records that backed this view. */
    associatedProfiles?: AppBskyActorDefs.ProfileViewBasic[];
}
/** The source of an external embed, such as a standard.site publication. */
export interface ViewExternalSource {
    $type?: 'app.bsky.embed.external#viewExternalSource';
    /** URI of the source, if available. Example: the https:// URL of a site.standard.publication record. */
    uri: string;
    /** Fully-qualified URL where an icon representing the source can be fetched. For example, CDN location provided by the App View. */
    icon?: string;
    title: string;
    description?: string;
    theme?: ViewExternalSourceTheme;
}
/** The theme colors of an external source, such as a site.standard.publication. These colors may be used when rendering an embed from that source. */
export interface ViewExternalSourceTheme {
    $type?: 'app.bsky.embed.external#viewExternalSourceTheme';
    backgroundRGB?: ColorRGB;
    foregroundRGB?: ColorRGB;
    accentRGB?: ColorRGB;
    accentForegroundRGB?: ColorRGB;
}
/** RGB color definition, inspired by site.standard.theme.color#rgb */
export interface ColorRGB {
    $type?: 'app.bsky.embed.external#colorRGB';
    r: number;
    g: number;
    b: number;
}
