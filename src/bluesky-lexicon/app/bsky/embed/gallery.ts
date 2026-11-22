/**
 * Vendored from @atproto/api 0.20.44 (dist/client/types/app/bsky/embed/gallery.d.ts), generated
 * lexicon types, copyright Bluesky Social PBC and contributors, MIT licence (see
 * NOTICE). Types only: the generated is/validate functions and constants are
 * dropped, and BlobRef is this package's JSON form (src/bluesky-lexicon/blob-ref.ts).
 *
 * Kept so the types district-social 0.1.0 exported from @atproto/api keep their
 * exact shape. Do not edit by hand.
 */
import type { BlobRef } from "../../../blob-ref.js";
import type { $Typed } from "../../../util.js";
import type * as AppBskyEmbedDefs from "./defs.js";
export interface Main {
    $type?: 'app.bsky.embed.gallery';
    /** The schema-level maxLength of 20 is a future-proof ceiling. Clients should currently enforce a soft limit of 10 items in authoring UIs. */
    items: ($Typed<Image> | {
        $type: string;
    })[];
}
export interface Image {
    $type?: 'app.bsky.embed.gallery#image';
    image: BlobRef;
    /** Alt text description of the image, for accessibility. */
    alt: string;
    aspectRatio: AppBskyEmbedDefs.AspectRatio;
}
export interface View {
    $type?: 'app.bsky.embed.gallery#view';
    items: ($Typed<ViewImage> | {
        $type: string;
    })[];
}
export interface ViewImage {
    $type?: 'app.bsky.embed.gallery#viewImage';
    /** Fully-qualified URL where a thumbnail of the image can be fetched. For example, CDN location provided by the App View. */
    thumbnail: string;
    /** Fully-qualified URL where a large version of the image can be fetched. May or may not be the exact original blob. For example, CDN location provided by the App View. */
    fullsize: string;
    /** Alt text description of the image, for accessibility. */
    alt: string;
    aspectRatio: AppBskyEmbedDefs.AspectRatio;
}
