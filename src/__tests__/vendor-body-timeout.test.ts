import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * ⛔ A BODY READ THAT TIMES OUT LEAVES EACH CLIENT AS ITS OWN ERROR, STATUS 0.
 *
 * `AbortSignal.timeout` covers the body as well as the headers, so a vendor
 * that answers headers and then stalls aborts inside `res.text()`. A bare
 * `await res.text()` let that escape as a raw DOMException, past every
 * caller's `instanceof XxxError` handling (vendor-fetch.ts `vendorText`). One
 * request per client that reads through `vendorFetch`.
 */

const mockGetAccessToken = vi.hoisted(() => vi.fn(async () => "fake-adc-token"));
vi.mock("google-auth-library", () => ({
  GoogleAuth: class {
    getAccessToken = mockGetAccessToken;
  },
}));

import { getMe as xGetMe, setXTokenResolver, XError } from "../x.js";
import { getMe as redditGetMe, setRedditTokenResolver, RedditError } from "../reddit.js";
import { getOrganizationUrn, setLinkedInTokenResolver, LinkedInError } from "../linkedin.js";
import { getUserAccount, setPinterestTokenResolver, PinterestError } from "../pinterest.js";
import { getProfile as threadsGetProfile, setThreadsCredentialsResolver, ThreadsError } from "../threads.js";
import { publishStatus, setTikTokCredentialsResolver, TikTokError } from "../tiktok.js";
import { getMyChannel, setYouTubeTokenResolver, YouTubeError } from "../youtube.js";
import { graphRequest, MetaGraphError } from "../http/meta-graph.js";
import { startVideoGeneration, VeoError } from "../veo.js";
import { setEngineDeployment } from "../settings.js";
import { isUnknownOutcome } from "../retry.js";
import { FIXTURE_GCP_PROJECT, FIXTURE_REDDIT_USER_AGENT } from "./helpers/fixtures.js";

function timeoutError(): Error {
  const err = new Error("The operation was aborted due to timeout");
  err.name = "TimeoutError";
  return err;
}

/** Headers arrived (200), then the body stalled past the request's budget. */
function stalledBody(): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    text: async () => {
      throw timeoutError();
    },
  } as unknown as Response;
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => stalledBody()));
  setXTokenResolver(async () => "t");
  setRedditTokenResolver(async () => "t");
  setLinkedInTokenResolver(async () => "t");
  setPinterestTokenResolver(async () => "t");
  setThreadsCredentialsResolver(async () => ({ appSecret: "s", accessToken: "t", userId: "1" }));
  setTikTokCredentialsResolver(async () => ({ accessToken: "t", businessId: "b", scopes: ["video.publish"] }));
  setYouTubeTokenResolver(async () => "t");
  setEngineDeployment({ vertexProject: FIXTURE_GCP_PROJECT, redditUserAgent: FIXTURE_REDDIT_USER_AGENT });
});

afterEach(() => {
  vi.unstubAllGlobals();
  setXTokenResolver(null);
  setRedditTokenResolver(null);
  setLinkedInTokenResolver(null);
  setPinterestTokenResolver(null);
  setThreadsCredentialsResolver(null);
  setTikTokCredentialsResolver(null);
  setYouTubeTokenResolver(null);
});

const CASES: Array<[string, () => Promise<unknown>, abstract new (...args: never[]) => Error]> = [
  ["x", () => xGetMe(), XError],
  ["reddit", () => redditGetMe(), RedditError],
  ["linkedin", () => getOrganizationUrn(), LinkedInError],
  ["pinterest", () => getUserAccount(), PinterestError],
  ["threads", () => threadsGetProfile(), ThreadsError],
  ["tiktok", () => publishStatus("v_pub_url~v1.1"), TikTokError],
  ["youtube", () => getMyChannel(), YouTubeError],
  ["meta graph", () => graphRequest("me", { method: "GET", accessToken: "t", appSecret: "s" }), MetaGraphError],
  ["veo", () => startVideoGeneration({ prompt: "p" }), VeoError],
];

describe("a body read that times out", () => {
  it.each(CASES)("arrives from %s as its own status-0 error, an unknown outcome", async (_name, call, ErrorClass) => {
    const err = await call().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ErrorClass);
    expect((err as { status: number }).status).toBe(0);
    expect((err as Error).message).toMatch(/no response after \d+s .*check before retrying a publish/);
    expect(isUnknownOutcome(err)).toBe(true);
  });
});
