/**
 * Shared fixture ids for the engine's unit tests.
 *
 * Every value here is synthetic and shaped like the real thing (same length,
 * same alphabet), so a parser, an encoder or a length check sees what it would
 * see from the platform. None of them identifies a real account, page, board,
 * video or post.
 */

/** A LinkedIn organization id (digits only, as the REST API returns it). */
export const FIXTURE_LINKEDIN_ORG = "100000001";

/** The organization URN built from FIXTURE_LINKEDIN_ORG. */
export const FIXTURE_LINKEDIN_ORG_URN = `urn:li:organization:${FIXTURE_LINKEDIN_ORG}`;

/** A 19-digit LinkedIn activity id, the numeric tail of a post URN. */
export const FIXTURE_LINKEDIN_POST_ID = "7000000000000000001";

/** A second 19-digit id, for tests that need two distinct posts. */
export const FIXTURE_LINKEDIN_POST_ID_2 = "7000000000000000002";

/** A third 19-digit id, for a post the API reports as gone. */
export const FIXTURE_LINKEDIN_POST_ID_3 = "7000000000000000003";

/** A share URN (`urn:li:share:<19 digits>`). */
export const FIXTURE_LINKEDIN_SHARE_URN = `urn:li:share:${FIXTURE_LINKEDIN_POST_ID}`;

/** A ugcPost URN (`urn:li:ugcPost:<19 digits>`). */
export const FIXTURE_LINKEDIN_UGC_URN = `urn:li:ugcPost:${FIXTURE_LINKEDIN_POST_ID_2}`;

/** A Bluesky DID (`did:plc:` plus 24 base32 characters). */
export const FIXTURE_BLUESKY_DID = "did:plc:fixtureaaaaaaaaaaaaaaaaa";

/** A Bluesky record key (13 base32 characters, a TID). */
export const FIXTURE_BLUESKY_RKEY = "3fixturepost2";

/** An at:// post URI built from the two values above. */
export const FIXTURE_BLUESKY_AT_URI = `at://${FIXTURE_BLUESKY_DID}/app.bsky.feed.post/${FIXTURE_BLUESKY_RKEY}`;

/** A 19-digit Pinterest board id. */
export const FIXTURE_PINTEREST_BOARD = "1000000000000000001";

/** An 11-character YouTube video id. */
export const FIXTURE_YOUTUBE_VIDEO = "FIXTUREvid1";

/** A 19-digit TikTok post id. */
export const FIXTURE_TIKTOK_POST = "7000000000000000009";

/** A Zernio account id (24 hex characters, a Mongo ObjectId). */
export const FIXTURE_ZERNIO_ACCOUNT = "0000000000000000000000a1";

/** A Reddit User-Agent in Reddit's documented form, naming a fixture app and account. */
export const FIXTURE_REDDIT_USER_AGENT = "server:com.example.social:v1.0 (by /u/example)";

/** A GCP project id for the Veo request URL. */
export const FIXTURE_GCP_PROJECT = "example-project";
