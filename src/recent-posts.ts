/**
 * The account's own recent posts, as each network's read returns them, for one
 * question only: did a publish that crashed mid-send reach this platform? The
 * caller's crash check asks it, and the answer decides between "published" and
 * "nothing sent, ask again".
 *
 * ⛔ "NOT THERE" MUST BE PROVEN, NEVER ASSUMED. A wrong "not sent" re-opens a
 * draft that is already live, and its next publish is a second post. So a read
 * that cannot show the WHOLE window (more pages it did not fetch, an order it
 * cannot vouch for) is `settled: false`, and the checker throws rather than
 * answering "not found".
 *
 * Relative imports only, like the rest of this folder.
 */

/** One post the account published, reduced to what the match needs. */
export interface RecentPost {
  /** The ref in the form the platform's transport stores it (its postUrl takes it). */
  id: string;
  /** The post's text as the platform holds it (a caption, a description, a title). */
  texts: string[];
  /** ISO datetime, or null when the platform gave none (then it counts as inside the window). */
  createdAt: string | null;
  /** The platform's own permalink, when the read returns one. */
  url?: string;
}

/** A read of the newest posts, and whether the platform said there are more. */
export interface RecentPostsPage {
  posts: RecentPost[];
  /** The platform returned a next-page cursor that was not followed. */
  more: boolean;
  /**
   * The platform documents no order for this list (Pinterest's `GET /pins`),
   * so the times on one page cannot prove what the unread pages hold.
   */
  unordered?: boolean;
}

/**
 * A Graph timestamp (`2026-11-08T05:00:00+0000`) as ISO. Graph's offset has no
 * colon, which some parsers refuse; a value no parser reads is kept null, and
 * a null counts as inside the window (see windowCovers).
 */
export function graphTime(value: string | undefined | null): string | null {
  if (!value) return null;
  const fixed = value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const t = new Date(fixed).getTime();
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function time(p: RecentPost): number {
  // A missing or unreadable time is read as "now": inside any window, and
  // never the post that proves the read went past the window's start.
  return p.createdAt ? new Date(p.createdAt).getTime() : Number.POSITIVE_INFINITY;
}

/**
 * Whether `page` saw every post made since `since`.
 *
 * True when the platform had no more pages. With more pages, true only when
 * the list has a documented order, the posts are newest first AND the last
 * one is older than `since`: then the pages not fetched are older still.
 * Anything else is unproven.
 */
export function windowCovers(page: RecentPostsPage, since: Date): boolean {
  if (!page.more) return true;
  if (page.unordered) return false;
  const times = page.posts.map(time);
  const newestFirst = times.every((t, i) => i === 0 || t <= times[i - 1]!);
  const last = times[times.length - 1];
  return newestFirst && last !== undefined && last < since.getTime();
}

/** The posts made at or after `since`. */
export function postsSince(page: RecentPostsPage, since: Date): RecentPost[] {
  return page.posts.filter((p) => time(p) >= since.getTime());
}
