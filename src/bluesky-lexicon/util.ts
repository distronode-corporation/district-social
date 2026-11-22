/**
 * Vendored from @atproto/api 0.20.44 (dist/client/types/../util.d.ts), generated
 * lexicon types, copyright Bluesky Social PBC and contributors, MIT licence (see
 * NOTICE). Types only: the generated is/validate functions and constants are
 * dropped, and BlobRef is this package's JSON form (src/bluesky-lexicon/blob-ref.ts).
 *
 * Kept so the types district-social 0.1.0 exported from @atproto/api keep their
 * exact shape. Do not edit by hand.
 */
export type OmitKey<T, K extends keyof T> = {
    [K2 in keyof T as K2 extends K ? never : K2]: T[K2];
};
export type $Typed<V, T extends string = string> = V & {
    $type: T;
};
export type Un$Typed<V extends {
    $type?: string;
}> = OmitKey<V, '$type'>;
