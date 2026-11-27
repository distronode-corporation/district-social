// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

import { ALL_PLATFORMS, type Platform } from "./types.js";

/**
 * The one mapping between Postiz's channel identifiers and our platform ids.
 *
 * This existed in three hand-maintained copies (publish.ts's
 * IDENTIFIER_PREFERENCE, the accounts route's duplicate of it, and the posts
 * route's reverse lookup), each carrying a comment asking the next person to
 * keep them in sync. They drifted exactly as you would expect: adding Threads
 * meant three separate edits, and missing any one of them made a connected
 * channel invisible in that surface only.
 *
 * Order inside each array is PREFERENCE. When two channels map to the same
 * platform (an Instagram business account vs a standalone one, the LinkedIn
 * company page vs a personal profile) the earlier identifier wins, because
 * marketing posts want the company page and the business account.
 */
export const PLATFORM_IDENTIFIERS: Record<Platform, string[]> = {
  instagram: ["instagram", "instagram-standalone"],
  facebook: ["facebook"],
  threads: ["threads"],
  twitter: ["x"],
  linkedin: ["linkedin-page", "linkedin"],
  youtube: ["youtube"],
  reddit: ["reddit"],
  bluesky: ["bluesky"],
  pinterest: ["pinterest"],
  tiktok: ["tiktok"],
};

/** Reverse index, derived so it can never disagree with the table above. */
const BY_IDENTIFIER: ReadonlyMap<string, Platform> = new Map(
  ALL_PLATFORMS.flatMap((platform) =>
    PLATFORM_IDENTIFIERS[platform].map((identifier) => [identifier, platform] as const),
  ),
);

/**
 * Our platform id for a Postiz identifier, or undefined when we do not model it.
 *
 * Undefined is a real answer, not an error: Postiz can hold channels the engine
 * deliberately does not publish to (a Google Business Profile, for instance).
 */
export function platformForIdentifier(identifier: string): Platform | undefined {
  return BY_IDENTIFIER.get(identifier);
}

/**
 * The identifier to use when asking Postiz for a CONNECT url (GET /social/:id).
 *
 * The preferred identifier is also the right one to connect: for LinkedIn that
 * is the company page rather than a personal profile, which is what a marketing
 * account wants. Verified live: all eight return 200.
 */
export function connectIdentifierFor(platform: Platform): string {
  return PLATFORM_IDENTIFIERS[platform][0];
}
