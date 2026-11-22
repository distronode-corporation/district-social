/**
 * Vendored from @atproto/api 0.20.44 (dist/client/types/app/bsky/embed/video.d.ts), generated
 * lexicon types, copyright Bluesky Social PBC and contributors, MIT licence (see
 * NOTICE). Types only: the generated is/validate functions and constants are
 * dropped, and BlobRef is this package's JSON form (src/bluesky-lexicon/blob-ref.ts).
 *
 * Kept so the types district-social 0.1.0 exported from @atproto/api keep their
 * exact shape. Do not edit by hand.
 */
import type { BlobRef } from "../../../blob-ref.js";
import type * as AppBskyEmbedDefs from "./defs.js";
export interface Main {
    $type?: 'app.bsky.embed.video';
    /** The mp4 video file. May be up to 300mb, formerly limited to 100mb. */
    video: BlobRef;
    captions?: Caption[];
    /** Alt text description of the video, for accessibility. */
    alt?: string;
    aspectRatio?: AppBskyEmbedDefs.AspectRatio;
    /** A hint to the client about how to present the video. */
    presentation?: 'default' | 'gif' | (string & {});
}
export interface Caption {
    $type?: 'app.bsky.embed.video#caption';
    lang: string;
    file: BlobRef;
}
export interface View {
    $type?: 'app.bsky.embed.video#view';
    cid: string;
    playlist: string;
    thumbnail?: string;
    alt?: string;
    aspectRatio?: AppBskyEmbedDefs.AspectRatio;
    /** A hint to the client about how to present the video. */
    presentation?: 'default' | 'gif' | (string & {});
}
