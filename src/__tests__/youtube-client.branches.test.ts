// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The branches of the youtube.ts vendor client that youtube-client.test.ts does
 * not reach: the two statistics readers, the network/timeout wrapper on all
 * three fetch sites, and the JSON/204/empty-body paths through `request`.
 *
 * Same idiom as the sibling file — `fetch` is stubbed globally and every
 * response is hand-built, so nothing here can touch googleapis.com.
 */

import {
  YouTubeError,
  isYouTubeNotFound,
  setYouTubeTokenResolver,
  insertVideo,
  getVideos,
  getVideoStats,
  getMyChannelStats,
  getMyChannel,
  deleteVideo,
  type YouTubeUploadInput,
} from "../youtube.js";

const TOKEN = "test-access-token";
const UPLOAD_URL = "https://www.googleapis.com/upload/youtube/v3/videos";

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

function fetchMock(): ReturnType<typeof vi.fn<FetchFn>> {
  return fetch as unknown as ReturnType<typeof vi.fn<FetchFn>>;
}

function textResponse(status: number, body: string, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => body,
  } as unknown as Response;
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return textResponse(status, JSON.stringify(body), headers);
}

/** What `AbortSignal.timeout` rejects with when the budget elapses. */
function timeoutError(): Error {
  const err = new Error("The operation was aborted due to timeout");
  err.name = "TimeoutError";
  return err;
}

const uploadInput: YouTubeUploadInput = {
  title: "A demo video",
  categoryId: "28",
  privacyStatus: "public",
  videoBytes: new Uint8Array([1, 2, 3, 4]),
  mimeType: "video/mp4",
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn<FetchFn>());
  setYouTubeTokenResolver(async () => TOKEN);
});

describe("network and timeout wrapping", () => {
  it("reports a plain JSON call's timeout as a status-0 error naming the budget in seconds", async () => {
    fetchMock().mockRejectedValue(timeoutError());

    await expect(getVideos(["v1"])).rejects.toMatchObject({ status: 0 });
    await expect(getVideos(["v1"])).rejects.toThrow(/no response after 15s/);
  });

  it("warns in the timeout message that the request may still have completed server-side", async () => {
    // The reason this wording exists: a blind retry after a timeout can double-publish.
    fetchMock().mockRejectedValue(timeoutError());
    await expect(getVideos(["v1"])).rejects.toThrow(/may still complete server-side/);
  });

  it("wraps a non-timeout transport failure with its own message", async () => {
    fetchMock().mockRejectedValue(new Error("ECONNREFUSED"));

    const err = await getVideos(["v1"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(YouTubeError);
    expect((err as YouTubeError).status).toBe(0);
    expect((err as YouTubeError).body).toBe("ECONNREFUSED");
  });

  it("stringifies a thrown non-Error rather than losing it", async () => {
    fetchMock().mockRejectedValue("socket hang up");

    const err = await getVideos(["v1"]).catch((e: unknown) => e);
    expect((err as YouTubeError).body).toBe("socket hang up");
  });

  it("wraps a timeout opening the resumable session against the init budget", async () => {
    fetchMock().mockRejectedValue(timeoutError());

    const err = await insertVideo(uploadInput).catch((e: unknown) => e);
    expect((err as YouTubeError).message).toContain("no response after 15s");
    expect((err as YouTubeError).message).toContain("/upload/videos (init)");
  });

  it("wraps a timeout on the byte PUT against the ten-minute upload budget", async () => {
    // The byte PUT gets a far longer budget than the JSON calls; the message
    // must name the one that actually elapsed.
    fetchMock()
      .mockResolvedValueOnce(textResponse(200, "", { location: UPLOAD_URL }))
      .mockRejectedValueOnce(timeoutError());

    const err = await insertVideo(uploadInput).catch((e: unknown) => e);
    expect((err as YouTubeError).message).toContain("no response after 600s");
    expect((err as YouTubeError).message).toContain("/upload/videos (bytes)");
  });

  it("wraps a transport failure on the byte PUT", async () => {
    fetchMock()
      .mockResolvedValueOnce(textResponse(200, "", { location: UPLOAD_URL }))
      .mockRejectedValueOnce(new Error("connection reset mid-upload"));

    const err = await insertVideo(uploadInput).catch((e: unknown) => e);
    expect((err as YouTubeError).body).toBe("connection reset mid-upload");
  });

  it("throws when the upload response body is not JSON", async () => {
    fetchMock()
      .mockResolvedValueOnce(textResponse(200, "", { location: UPLOAD_URL }))
      .mockResolvedValueOnce(textResponse(201, "<html>proxy error</html>"));

    await expect(insertVideo(uploadInput)).rejects.toThrow(/expected JSON, got: <html>/);
  });
});

describe("request response handling", () => {
  it("carries a Retry-After header verbatim onto the error for retry.ts to parse", async () => {
    fetchMock().mockResolvedValue(jsonResponse(429, { error: "quota" }, { "retry-after": "120" }));

    const err = await getVideos(["v1"]).catch((e: unknown) => e);
    expect((err as YouTubeError).retryAfter).toBe("120");
    expect((err as YouTubeError).status).toBe(429);
  });

  it("leaves retryAfter null when the vendor sent no such header", async () => {
    fetchMock().mockResolvedValue(jsonResponse(500, { error: "boom" }));

    const err = await getVideos(["v1"]).catch((e: unknown) => e);
    expect((err as YouTubeError).retryAfter).toBeNull();
  });

  it("truncates a very long error body in the thrown message while keeping it whole on .body", async () => {
    const long = "x".repeat(900);
    fetchMock().mockResolvedValue(textResponse(400, long));

    const err = await getVideos(["v1"]).catch((e: unknown) => e);
    expect((err as YouTubeError).body).toHaveLength(900);
    expect((err as YouTubeError).message).toContain("x".repeat(500));
    expect((err as YouTubeError).message).not.toContain("x".repeat(501));
  });

  it("does not attempt to parse an empty 200 body as JSON", async () => {
    // `request` short-circuits an empty body to undefined; getVideos then fails
    // on the missing envelope rather than reporting a bogus parse error. The
    // distinction matters when diagnosing a truncated vendor response.
    fetchMock().mockResolvedValue(textResponse(200, ""));
    await expect(getVideos(["v1"])).rejects.toThrow(/unexpected response shape at \(body\): expected an object, got missing/);
  });

  it("survives a 204 on the delete path, which carries no body by design", async () => {
    fetchMock().mockResolvedValue(textResponse(204, ""));
    await expect(deleteVideo("v1")).resolves.toBeUndefined();
  });

  it("throws when a 200 body is present but not JSON", async () => {
    fetchMock().mockResolvedValue(textResponse(200, "not json at all"));
    await expect(getVideos(["v1"])).rejects.toThrow(/expected JSON, got: not json at all/);
  });

  it("tolerates a 200 whose payload omits `items` entirely", async () => {
    fetchMock().mockResolvedValue(jsonResponse(200, {}));
    await expect(getVideos(["v1"])).resolves.toEqual([]);
  });
});

describe("toVideo mapping", () => {
  it("carries a recognised privacyStatus through", async () => {
    fetchMock().mockResolvedValue(
      jsonResponse(200, {
        items: [
          { id: "a", snippet: { title: "A" }, status: { privacyStatus: "private" } },
          { id: "b", snippet: { title: "B" }, status: { privacyStatus: "unlisted" } },
        ],
      }),
    );

    await expect(getVideos(["a", "b"])).resolves.toEqual([
      { id: "a", title: "A", privacyStatus: "private" },
      { id: "b", title: "B", privacyStatus: "unlisted" },
    ]);
  });

  it("refuses a privacyStatus outside the documented enum rather than passing it upward", async () => {
    fetchMock().mockResolvedValue(
      jsonResponse(200, { items: [{ id: "a", status: { privacyStatus: "somethingNew" } }] }),
    );

    await expect(getVideos(["a"])).rejects.toThrow(/items\[0\]\.status\.privacyStatus: expected one of public, unlisted, private, got a string/);
  });
});

describe("getVideoStats", () => {
  it("returns [] and makes no request for an empty id list", async () => {
    await expect(getVideoStats([])).resolves.toEqual([]);
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it("asks for part=statistics only, because YouTube bills per part", async () => {
    fetchMock().mockResolvedValue(jsonResponse(200, { items: [] }));

    await getVideoStats(["v1", "v2"]);

    expect(fetchMock().mock.calls[0][0]).toBe(
      "https://www.googleapis.com/youtube/v3/videos?part=statistics&id=v1%2Cv2",
    );
  });

  it("parses the vendor's string-encoded counters into numbers", async () => {
    // The API sends unsigned longs as JSON strings to survive 2^53.
    fetchMock().mockResolvedValue(
      jsonResponse(200, {
        items: [{ id: "v1", statistics: { viewCount: "9007199254740993", likeCount: "42", commentCount: "7" } }],
      }),
    );

    await expect(getVideoStats(["v1"])).resolves.toEqual([
      { id: "v1", views: Number("9007199254740993"), likes: 42, comments: 7 },
    ]);
  });

  it("leaves a hidden counter ABSENT rather than defaulting it to zero", async () => {
    // A hidden like count and a genuine zero must not look the same on a dashboard.
    fetchMock().mockResolvedValue(
      jsonResponse(200, { items: [{ id: "v1", statistics: { viewCount: "10", commentCount: "0" } }] }),
    );

    const [stats] = await getVideoStats(["v1"]);
    expect(stats).toEqual({ id: "v1", views: 10, comments: 0 });
    expect("likes" in stats).toBe(false);
  });

  it("accepts a counter the vendor happened to send as a JSON number", async () => {
    fetchMock().mockResolvedValue(jsonResponse(200, { items: [{ id: "v1", statistics: { viewCount: 5 } }] }));
    await expect(getVideoStats(["v1"])).resolves.toEqual([{ id: "v1", views: 5 }]);
  });

  it("reads a null counter as absent and refuses one that is neither a string nor a number", async () => {
    fetchMock().mockResolvedValueOnce(jsonResponse(200, { items: [{ id: "v1", statistics: { viewCount: null } }] }));
    await expect(getVideoStats(["v1"])).resolves.toEqual([{ id: "v1" }]);
    fetchMock().mockResolvedValueOnce(jsonResponse(200, { items: [{ id: "v1", statistics: { likeCount: { n: 1 } } }] }));
    await expect(getVideoStats(["v1"])).rejects.toThrow(/items\[0\]\.statistics\.likeCount: expected a count/);
  });

  it("refuses a counter whose string is not a number, without echoing it", async () => {
    fetchMock().mockResolvedValue(
      jsonResponse(200, { items: [{ id: "v1", statistics: { viewCount: "not-a-number" } }] }),
    );
    const err = await getVideoStats(["v1"]).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/viewCount: expected a count .*, got a string/);
    expect((err as Error).message).not.toContain("not-a-number");
  });

  it("returns the id alone for an item carrying no statistics block", async () => {
    fetchMock().mockResolvedValue(jsonResponse(200, { items: [{ id: "v1" }] }));
    await expect(getVideoStats(["v1"])).resolves.toEqual([{ id: "v1" }]);
  });

  it("tolerates a payload with no items key", async () => {
    fetchMock().mockResolvedValue(jsonResponse(200, {}));
    await expect(getVideoStats(["v1"])).resolves.toEqual([]);
  });

  it("propagates a vendor failure as a YouTubeError", async () => {
    fetchMock().mockResolvedValue(jsonResponse(403, { error: { message: "quota exceeded" } }));
    await expect(getVideoStats(["v1"])).rejects.toBeInstanceOf(YouTubeError);
  });
});

describe("getMyChannelStats", () => {
  it("asks for the authenticated channel's statistics", async () => {
    fetchMock().mockResolvedValue(
      jsonResponse(200, { items: [{ statistics: { subscriberCount: "1200", viewCount: "45000", videoCount: "31" } }] }),
    );

    await expect(getMyChannelStats()).resolves.toEqual({ subscribers: 1200, views: 45000, videos: 31 });
    expect(fetchMock().mock.calls[0][0]).toBe(
      "https://www.googleapis.com/youtube/v3/channels?part=statistics&mine=true",
    );
  });

  it("leaves subscribers ABSENT for a channel that hides the count", async () => {
    // hiddenSubscriberCount makes the field absent on some channels and zero on
    // others; an absent value must not become a real 0.
    fetchMock().mockResolvedValue(
      jsonResponse(200, { items: [{ statistics: { viewCount: "45000", videoCount: "31" } }] }),
    );

    const stats = await getMyChannelStats();
    expect(stats).toEqual({ views: 45000, videos: 31 });
    expect("subscribers" in stats).toBe(false);
  });

  it("reports an explicit zero subscriber count as zero", async () => {
    fetchMock().mockResolvedValue(jsonResponse(200, { items: [{ statistics: { subscriberCount: "0" } }] }));
    await expect(getMyChannelStats()).resolves.toEqual({ subscribers: 0 });
  });

  it("throws when the credential resolves to zero channels", async () => {
    fetchMock().mockResolvedValue(jsonResponse(200, { items: [] }));
    await expect(getMyChannelStats()).rejects.toThrow(/no channel found for this credential/);
  });

  it("throws when the single item carries no statistics block", async () => {
    fetchMock().mockResolvedValue(jsonResponse(200, { items: [{}] }));
    await expect(getMyChannelStats()).rejects.toThrow(/no channel found/);
  });

  it("throws when the payload has no items key at all", async () => {
    fetchMock().mockResolvedValue(jsonResponse(200, {}));
    await expect(getMyChannelStats()).rejects.toThrow(/no channel found/);
  });
});

describe("getMyChannel title fallback", () => {
  it("returns an empty title when the snippet omits one, rather than undefined", async () => {
    fetchMock().mockResolvedValue(jsonResponse(200, { items: [{ id: "chan-1" }] }));
    await expect(getMyChannel()).resolves.toEqual({ id: "chan-1", title: "" });
  });
});

describe("isYouTubeNotFound", () => {
  it("is false for anything that is not a YouTubeError", () => {
    expect(isYouTubeNotFound(new Error("404 not found"))).toBe(false);
    expect(isYouTubeNotFound(null)).toBe(false);
    expect(isYouTubeNotFound("404")).toBe(false);
  });

  it("is false for a status-0 transport error even though nothing was found", async () => {
    fetchMock().mockRejectedValue(new Error("dns failure"));

    const err = await deleteVideo("v1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(YouTubeError);
    expect(isYouTubeNotFound(err)).toBe(false);
  });
});

describe("token resolver on the upload path", () => {
  it("refuses to open a resumable session with no resolver registered", async () => {
    setYouTubeTokenResolver(null);
    await expect(insertVideo(uploadInput)).rejects.toThrow(/no YouTube token resolver/);
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it("refuses to open a resumable session on an empty token", async () => {
    setYouTubeTokenResolver(async () => "");
    await expect(insertVideo(uploadInput)).rejects.toThrow(/empty token/);
    expect(fetchMock()).not.toHaveBeenCalled();
  });
});
