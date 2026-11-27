// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

/**
 * A blob reference as the AT Protocol sends it in JSON: what
 * `com.atproto.repo.uploadBlob` answers and what a record's embed carries. The
 * client passes it from the upload into the post record untouched.
 */
export interface BlobRef {
  $type: "blob";
  ref: { $link: string };
  mimeType: string;
  size: number;
}
