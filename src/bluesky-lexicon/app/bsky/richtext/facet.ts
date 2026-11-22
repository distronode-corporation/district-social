/**
 * Vendored from @atproto/api 0.20.44 (dist/client/types/app/bsky/richtext/facet.d.ts), generated
 * lexicon types, copyright Bluesky Social PBC and contributors, MIT licence (see
 * NOTICE). Types only: the generated is/validate functions and constants are
 * dropped, and BlobRef is this package's JSON form (src/bluesky-lexicon/blob-ref.ts).
 *
 * Kept so the types district-social 0.1.0 exported from @atproto/api keep their
 * exact shape. Do not edit by hand.
 */
import type { $Typed } from "../../../util.js";
/** Annotation of a sub-string within rich text. */
export interface Main {
    $type?: 'app.bsky.richtext.facet';
    index: ByteSlice;
    features: ($Typed<Mention> | $Typed<Link> | $Typed<Tag> | {
        $type: string;
    })[];
}
/** Facet feature for mention of another account. The text is usually a handle, including a '@' prefix, but the facet reference is a DID. */
export interface Mention {
    $type?: 'app.bsky.richtext.facet#mention';
    did: string;
}
/** Facet feature for a URL. The text URL may have been simplified or truncated, but the facet reference should be a complete URL. */
export interface Link {
    $type?: 'app.bsky.richtext.facet#link';
    uri: string;
}
/** Facet feature for a hashtag. The text usually includes a '#' prefix, but the facet reference should not (except in the case of 'double hash tags'). */
export interface Tag {
    $type?: 'app.bsky.richtext.facet#tag';
    tag: string;
}
/** Specifies the sub-string range a facet feature applies to. Start index is inclusive, end index is exclusive. Indices are zero-indexed, counting bytes of the UTF-8 encoded text. NOTE: some languages, like Javascript, use UTF-16 or Unicode codepoints for string slice indexing; in these languages, convert to byte arrays before working with facets. */
export interface ByteSlice {
    $type?: 'app.bsky.richtext.facet#byteSlice';
    byteStart: number;
    byteEnd: number;
}
