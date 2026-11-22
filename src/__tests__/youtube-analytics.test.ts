import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The YouTube Analytics API half of youtube.ts (reports v2): the exact query
 * each reader sends, parsing columnHeaders plus rows into a metric bag, the
 * no-data answers, and the scope refusal a token without the analytics scope gets.
 *
 * `fetch` is stubbed globally and every response is hand-built from bodies the
 * live API returned, so nothing here can reach googleapis.com.
 */

import {
  YouTubeError,
  setYouTubeTokenResolver,
  getVideoAnalytics,
  getChannelAnalytics,
  YT_VIDEO_ANALYTICS_METRICS,
  YT_CHANNEL_ANALYTICS_METRICS,
  YT_CHANNEL_WINDOW_DAYS,
  YT_ANALYTICS_LAG_DAYS,
  YT_ANALYTICS_LIFETIME_START,
} from "../youtube.js";
import { FIXTURE_YOUTUBE_VIDEO } from "./helpers/fixtures.js";

const TOKEN = "test-access-token";
const NOW = new Date("2026-10-02T15:00:00Z");

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

function fetchMock(): ReturnType<typeof vi.fn<FetchFn>> {
  return fetch as unknown as ReturnType<typeof vi.fn<FetchFn>>;
}

function textResponse(status: number, body: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => body,
  } as unknown as Response;
}

function jsonResponse(status: number, body: unknown): Response {
  return textResponse(status, JSON.stringify(body));
}

function header(name: string, dataType = "INTEGER") {
  return { name, columnType: "METRIC", dataType };
}

/** The shape of the live API's per-video answer (values synthetic). */
const VIDEO_REPORT = {
  kind: "youtubeAnalytics#resultTable",
  columnHeaders: [
    header("estimatedMinutesWatched"),
    header("averageViewDuration"),
    header("averageViewPercentage", "FLOAT"),
    header("subscribersGained"),
    header("subscribersLost"),
    header("shares"),
  ],
  rows: [[13, 115, 45.14, 0, 0, 0]],
};

/** The live 403 body for a token downscoped to youtube.upload. */
const SCOPE_REFUSAL = {
  error: {
    code: 403,
    message: "Request had insufficient authentication scopes.",
    errors: [{ message: "Insufficient Permission", domain: "global", reason: "insufficientPermissions" }],
    status: "PERMISSION_DENIED",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
        domain: "googleapis.com",
      },
    ],
  },
};

function calledUrl(): URL {
  return new URL(fetchMock().mock.calls[0][0]);
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn<FetchFn>());
  setYouTubeTokenResolver(async () => TOKEN);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("YouTube Analytics metric lists", () => {
  // ⛔ One invalid name fails the WHOLE query (proven live: 400 "Unknown
  // identifier"). Each list below was proven as one live call;
  // changing one should fail here first, not in production.
  it("pins the per-video list, which leaves views/likes/comments to the real-time Data API", () => {
    expect(YT_VIDEO_ANALYTICS_METRICS).toEqual([
      "estimatedMinutesWatched",
      "averageViewDuration",
      "averageViewPercentage",
      "subscribersGained",
      "subscribersLost",
      "shares",
    ]);
    expect(YT_VIDEO_ANALYTICS_METRICS).not.toContain("views");
    expect(YT_VIDEO_ANALYTICS_METRICS).not.toContain("likes");
    expect(YT_VIDEO_ANALYTICS_METRICS).not.toContain("comments");
  });

  it("pins the channel list", () => {
    expect(YT_CHANNEL_ANALYTICS_METRICS).toEqual([
      "views",
      "estimatedMinutesWatched",
      "averageViewDuration",
      "averageViewPercentage",
      "subscribersGained",
      "subscribersLost",
      "likes",
      "shares",
      "comments",
    ]);
  });

  it("pins the window, the lag and the lifetime start", () => {
    expect(YT_CHANNEL_WINDOW_DAYS).toBe(28);
    expect(YT_ANALYTICS_LAG_DAYS).toBe(3);
    expect(YT_ANALYTICS_LIFETIME_START).toBe("2005-02-14");
  });
});

describe("getVideoAnalytics", () => {
  it("sends the exact lifetime query for one video, on the Analytics host, with the shared bearer token", async () => {
    fetchMock().mockResolvedValue(jsonResponse(200, VIDEO_REPORT));
    await getVideoAnalytics(FIXTURE_YOUTUBE_VIDEO, NOW);

    const url = calledUrl();
    expect(`${url.origin}${url.pathname}`).toBe("https://youtubeanalytics.googleapis.com/v2/reports");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      ids: "channel==MINE",
      startDate: "2005-02-14",
      endDate: "2026-10-02",
      metrics:
        "estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained,subscribersLost,shares",
      filters: `video==${FIXTURE_YOUTUBE_VIDEO}`,
    });
    const init = fetchMock().mock.calls[0][1];
    expect(init?.method).toBe("GET");
    expect(init?.headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
  });

  it("parses columnHeaders plus the row into a bag keyed by YouTube's metric names", async () => {
    fetchMock().mockResolvedValue(jsonResponse(200, VIDEO_REPORT));
    await expect(getVideoAnalytics(FIXTURE_YOUTUBE_VIDEO, NOW)).resolves.toEqual({
      estimatedMinutesWatched: 13,
      averageViewDuration: 115,
      averageViewPercentage: 45.14,
      subscribersGained: 0,
      subscribersLost: 0,
      shares: 0,
    });
  });

  it("ends the lifetime window today when no clock is passed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-12-31T23:59:59Z"));
    fetchMock().mockResolvedValue(jsonResponse(200, VIDEO_REPORT));
    await getVideoAnalytics("v1");
    expect(calledUrl().searchParams.get("endDate")).toBe("2026-12-31");
  });

  it("reads `rows: []` (what the live API sends for a video with no data) as an EMPTY bag, not zeros", async () => {
    fetchMock().mockResolvedValue(jsonResponse(200, { ...VIDEO_REPORT, rows: [] }));
    await expect(getVideoAnalytics("new-video", NOW)).resolves.toEqual({});
  });

  it("reads an omitted `rows` (the documented no-data form) as an EMPTY bag", async () => {
    const { rows: _rows, ...noRows } = VIDEO_REPORT;
    fetchMock().mockResolvedValue(jsonResponse(200, noRows));
    await expect(getVideoAnalytics("new-video", NOW)).resolves.toEqual({});
  });

  it("reads an empty 200 body as an EMPTY bag", async () => {
    fetchMock().mockResolvedValue(textResponse(200, ""));
    await expect(getVideoAnalytics("v1", NOW)).resolves.toEqual({});
  });

  it("reads a row with no columnHeaders as an EMPTY bag rather than guessing names", async () => {
    fetchMock().mockResolvedValue(jsonResponse(200, { rows: [[1, 2]] }));
    await expect(getVideoAnalytics("v1", NOW)).resolves.toEqual({});
  });

  it("refuses a metric cell that is not a number", async () => {
    fetchMock().mockResolvedValue(
      jsonResponse(200, { columnHeaders: [header("shares")], rows: [["n/a"]] }),
    );
    await expect(getVideoAnalytics("v1", NOW)).rejects.toThrow(/at rows\[0\]\[0\]: expected a count/);
  });

  it.each([
    ["rows that is not an array", { rows: "x" }, /at rows: expected an array, got a string/],
    ["a row that is not an array", { rows: [{ a: 1 }] }, /at rows\[0\]: expected an array, got an object/],
    ["a header name that is a number", { columnHeaders: [{ name: 5 }], rows: [[1]] }, /at columnHeaders\[0\]\.name: expected a string/],
  ])("refuses a report with %s", async (_label, body, why) => {
    fetchMock().mockResolvedValue(jsonResponse(200, body));
    await expect(getVideoAnalytics("v1", NOW)).rejects.toThrow(why);
  });

  it("skips dimension columns, unnamed headers and null cells instead of inventing a value", async () => {
    fetchMock().mockResolvedValue(
      jsonResponse(200, {
        columnHeaders: [
          { name: "video", columnType: "DIMENSION", dataType: "STRING" },
          { columnType: "METRIC", dataType: "INTEGER" },
          header("shares"),
          header("averageViewPercentage", "FLOAT"),
          header("estimatedMinutesWatched"),
        ],
        rows: [["v1", 5, null, "12.5", 40]],
      }),
    );
    await expect(getVideoAnalytics("v1", NOW)).resolves.toEqual({ averageViewPercentage: 12.5, estimatedMinutesWatched: 40 });
  });

  it("rewrites the scope refusal into a message naming yt-analytics.readonly", async () => {
    fetchMock().mockResolvedValue(jsonResponse(403, SCOPE_REFUSAL));
    const err = await getVideoAnalytics("v1", NOW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(YouTubeError);
    expect((err as YouTubeError).status).toBe(403);
    expect((err as YouTubeError).message).toBe(
      "YouTube GET /reports -> 403: the YouTube token lacks an Analytics scope (ACCESS_TOKEN_SCOPE_INSUFFICIENT); " +
        "re-consent YOUTUBE_REFRESH_TOKEN with https://www.googleapis.com/auth/yt-analytics.readonly",
    );
  });

  it("recognises the refusal by the legacy `insufficientPermissions` reason alone", async () => {
    fetchMock().mockResolvedValue(
      jsonResponse(403, { error: { code: 403, errors: [{ reason: "insufficientPermissions" }] } }),
    );
    await expect(getVideoAnalytics("v1", NOW)).rejects.toThrow(/yt-analytics\.readonly/);
  });

  it("keeps the vendor's own body for any OTHER 403 (the API disabled on the project, say)", async () => {
    const disabled = { error: { code: 403, errors: [{ reason: "accessNotConfigured" }], status: "PERMISSION_DENIED" } };
    fetchMock().mockResolvedValue(jsonResponse(403, disabled));
    const err = (await getVideoAnalytics("v1", NOW).catch((e: unknown) => e)) as YouTubeError;
    expect(err).toBeInstanceOf(YouTubeError);
    expect(err.message).toMatch(/accessNotConfigured/);
    expect(err.message).not.toMatch(/yt-analytics/);
  });

  it("passes an invalid-metric 400 through untouched", async () => {
    const invalid = { error: { code: 400, message: "Unknown identifier (bogusMetric) given in field parameters.metrics." } };
    fetchMock().mockResolvedValue(jsonResponse(400, invalid));
    await expect(getVideoAnalytics("v1", NOW)).rejects.toThrow(/-> 400: .*Unknown identifier \(bogusMetric\)/);
  });

  it("passes a non-YouTubeError failure (no token resolver) through untouched", async () => {
    setYouTubeTokenResolver(null);
    await expect(getVideoAnalytics("v1", NOW)).rejects.toThrow(/no YouTube token resolver/);
    expect(fetchMock()).not.toHaveBeenCalled();
  });
});

describe("getChannelAnalytics", () => {
  it("asks for the 28 processed days ending three days back, with no video filter", async () => {
    fetchMock().mockResolvedValue(
      jsonResponse(200, {
        columnHeaders: YT_CHANNEL_ANALYTICS_METRICS.map((m) => header(m, m === "averageViewPercentage" ? "FLOAT" : "INTEGER")),
        rows: [[1, 0, 46, 18.24, 0, 0, 0, 0, 0]],
      }),
    );

    await expect(getChannelAnalytics(NOW)).resolves.toEqual({
      views: 1,
      estimatedMinutesWatched: 0,
      averageViewDuration: 46,
      averageViewPercentage: 18.24,
      subscribersGained: 0,
      subscribersLost: 0,
      likes: 0,
      shares: 0,
      comments: 0,
    });

    const url = calledUrl();
    expect(`${url.origin}${url.pathname}`).toBe("https://youtubeanalytics.googleapis.com/v2/reports");
    // 2026-10-02 minus 3 = 09-29; 09-29 back 27 more = 09-02; 28 days inclusive.
    expect(Object.fromEntries(url.searchParams)).toEqual({
      ids: "channel==MINE",
      startDate: "2026-09-02",
      endDate: "2026-09-29",
      metrics:
        "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained,subscribersLost,likes,shares,comments",
    });
  });

  it("uses the current clock when none is passed, across a month boundary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-02T01:00:00Z"));
    fetchMock().mockResolvedValue(jsonResponse(200, { columnHeaders: [], rows: [] }));
    await expect(getChannelAnalytics()).resolves.toEqual({});
    expect(calledUrl().searchParams.get("startDate")).toBe("2026-01-31");
    expect(calledUrl().searchParams.get("endDate")).toBe("2026-02-27");
  });

  it("rewrites the scope refusal on the channel query too", async () => {
    fetchMock().mockResolvedValue(jsonResponse(403, SCOPE_REFUSAL));
    await expect(getChannelAnalytics(NOW)).rejects.toThrow(/yt-analytics\.readonly/);
  });
});
