// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Vendored from @atproto/api 0.20.44 (dist/client/types/app/bsky/labeler/defs.d.ts), generated
 * lexicon types, copyright Bluesky Social PBC and contributors, MIT licence (see
 * NOTICE). Types only: the generated is/validate functions and constants are
 * dropped, and BlobRef is this package's JSON form (src/bluesky-lexicon/blob-ref.ts).
 *
 * Kept so the types district-social 0.1.0 exported from @atproto/api keep their
 * exact shape. Do not edit by hand.
 */
import type * as AppBskyActorDefs from "../actor/defs.js";
import type * as ComAtprotoLabelDefs from "../../../com/atproto/label/defs.js";
import type * as ComAtprotoModerationDefs from "../../../com/atproto/moderation/defs.js";
export interface LabelerView {
    $type?: 'app.bsky.labeler.defs#labelerView';
    uri: string;
    cid: string;
    creator: AppBskyActorDefs.ProfileView;
    likeCount?: number;
    viewer?: LabelerViewerState;
    indexedAt: string;
    labels?: ComAtprotoLabelDefs.Label[];
}
export interface LabelerViewDetailed {
    $type?: 'app.bsky.labeler.defs#labelerViewDetailed';
    uri: string;
    cid: string;
    creator: AppBskyActorDefs.ProfileView;
    policies: LabelerPolicies;
    likeCount?: number;
    viewer?: LabelerViewerState;
    indexedAt: string;
    labels?: ComAtprotoLabelDefs.Label[];
    /** The set of report reason 'codes' which are in-scope for this service to review and action. These usually align to policy categories. If not defined (distinct from empty array), all reason types are allowed. */
    reasonTypes?: ComAtprotoModerationDefs.ReasonType[];
    /** The set of subject types (account, record, etc) this service accepts reports on. */
    subjectTypes?: ComAtprotoModerationDefs.SubjectType[];
    /** Set of record types (collection NSIDs) which can be reported to this service. If not defined (distinct from empty array), default is any record type. */
    subjectCollections?: string[];
}
export interface LabelerViewerState {
    $type?: 'app.bsky.labeler.defs#labelerViewerState';
    like?: string;
}
export interface LabelerPolicies {
    $type?: 'app.bsky.labeler.defs#labelerPolicies';
    /** The label values which this labeler publishes. May include global or custom labels. */
    labelValues: ComAtprotoLabelDefs.LabelValue[];
    /** Label values created by this labeler and scoped exclusively to it. Labels defined here will override global label definitions for this labeler. */
    labelValueDefinitions?: ComAtprotoLabelDefs.LabelValueDefinition[];
}
