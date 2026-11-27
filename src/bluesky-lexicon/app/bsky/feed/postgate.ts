// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Vendored from @atproto/api 0.20.44 (dist/client/types/app/bsky/feed/postgate.d.ts), generated
 * lexicon types, copyright Bluesky Social PBC and contributors, MIT licence (see
 * NOTICE). Types only: the generated is/validate functions and constants are
 * dropped, and BlobRef is this package's JSON form (src/bluesky-lexicon/blob-ref.ts).
 *
 * Kept so the types district-social 0.1.0 exported from @atproto/api keep their
 * exact shape. Do not edit by hand.
 */
import type { $Typed } from "../../../util.js";
export interface Main {
    $type: 'app.bsky.feed.postgate';
    createdAt: string;
    /** Reference (AT-URI) to the post record. */
    post: string;
    /** List of AT-URIs embedding this post that the author has detached from. */
    detachedEmbeddingUris?: string[];
    /** List of rules defining who can embed this post. If value is an empty array or is undefined, no particular rules apply and anyone can embed. */
    embeddingRules?: ($Typed<DisableRule> | {
        $type: string;
    })[];
    [k: string]: unknown;
}
export type { Main as Record };
/** Disables embedding of this post. */
export interface DisableRule {
    $type?: 'app.bsky.feed.postgate#disableRule';
}
