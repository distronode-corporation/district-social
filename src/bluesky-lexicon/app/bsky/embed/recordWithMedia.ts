/**
 * Vendored from @atproto/api 0.20.44 (dist/client/types/app/bsky/embed/recordWithMedia.d.ts), generated
 * lexicon types, copyright Bluesky Social PBC and contributors, MIT licence (see
 * NOTICE). Types only: the generated is/validate functions and constants are
 * dropped, and BlobRef is this package's JSON form (src/bluesky-lexicon/blob-ref.ts).
 *
 * Kept so the types district-social 0.1.0 exported from @atproto/api keep their
 * exact shape. Do not edit by hand.
 */
import type { $Typed } from "../../../util.js";
import type * as AppBskyEmbedRecord from "./record.js";
import type * as AppBskyEmbedImages from "./images.js";
import type * as AppBskyEmbedVideo from "./video.js";
import type * as AppBskyEmbedGallery from "./gallery.js";
import type * as AppBskyEmbedExternal from "./external.js";
export interface Main {
    $type?: 'app.bsky.embed.recordWithMedia';
    record: AppBskyEmbedRecord.Main;
    media: $Typed<AppBskyEmbedImages.Main> | $Typed<AppBskyEmbedVideo.Main> | $Typed<AppBskyEmbedGallery.Main> | $Typed<AppBskyEmbedExternal.Main> | {
        $type: string;
    };
}
export interface View {
    $type?: 'app.bsky.embed.recordWithMedia#view';
    record: AppBskyEmbedRecord.View;
    media: $Typed<AppBskyEmbedImages.View> | $Typed<AppBskyEmbedVideo.View> | $Typed<AppBskyEmbedGallery.View> | $Typed<AppBskyEmbedExternal.View> | {
        $type: string;
    };
}
