import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Coverage for the youtube.ts vendor client (youtube-transport.ts's "how do
 * we talk to it" half) — mirrors pinterest-client.test.ts's shape.
 */

import {
  YouTubeError,
  isYouTubeNotFound,
  setYouTubeTokenResolver,
  insertVideo,
  getVideos,
  deleteVideo,
  getMyChannel,
} from "../youtube.js";

const TOKEN = "test-access-token";
const UPLOAD_URL = "https://www.googleapis.com/upload/youtube/v3/videos";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function emptyResponse(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => "",
  } as unknown as Response;
}

/** The resumable-session POST's response: 200, no body, a Location header naming the upload URL. */
function sessionResponse(status: number, location: string | null): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === "location" ? location : null) },
    text: async () => "",
  } as unknown as Response;
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  setYouTubeTokenResolver(async () => TOKEN);
});

describe("youtube client", () => {
  describe("token resolver", () => {
    it("throws a clear YouTubeError when no resolver is registered", async () => {
      setYouTubeTokenResolver(null);
      await expect(getVideos(["v1"])).rejects.toThrow(/no YouTube token resolver/);
    });

    it("throws when the resolver returns an empty token", async () => {
      setYouTubeTokenResolver(async () => "");
      await expect(getVideos(["v1"])).rejects.toThrow(/empty token/);
    });

    it("calls the resolver fresh on every request rather than caching it", async () => {
      const resolver = vi.fn(async () => TOKEN);
      setYouTubeTokenResolver(resolver);
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(jsonResponse(200, { items: [] }));
      await getVideos(["v1"]);
      await getVideos(["v2"]);
      expect(resolver).toHaveBeenCalledTimes(2);
    });

    it("sends the token as a Bearer header", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        jsonResponse(200, { items: [{ id: "v1" }] }),
      );
      await getVideos(["v1"]);
      const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    });
  });

  describe("insertVideo", () => {
    const uploadInput = {
      title: "A demo video",
      description: "some description",
      tags: ["ai", "demo"],
      categoryId: "28",
      privacyStatus: "public" as const,
      videoBytes: new Uint8Array([1, 2, 3, 4]),
      mimeType: "video/mp4",
    };

    it("opens a resumable session, PUTs the bytes to the Location URL, and returns the created video", async () => {
      const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
      fetchMock
        .mockResolvedValueOnce(sessionResponse(200, `${UPLOAD_URL}?upload_id=abc123`))
        .mockResolvedValueOnce(
          jsonResponse(201, {
            id: "vid-1",
            snippet: { title: "A demo video", categoryId: "28" },
            status: { privacyStatus: "public" },
          }),
        );

      const video = await insertVideo(uploadInput);

      expect(video).toEqual({ id: "vid-1", title: "A demo video", privacyStatus: "public" });
      expect(fetchMock).toHaveBeenCalledTimes(2);

      const [initUrl, initInit] = fetchMock.mock.calls[0];
      expect(initUrl).toBe(`${UPLOAD_URL}?uploadType=resumable&part=snippet,status`);
      expect(initInit.method).toBe("POST");
      const initHeaders = initInit.headers as Record<string, string>;
      expect(initHeaders.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(initHeaders["Content-Type"]).toBe("application/json; charset=UTF-8");
      expect(initHeaders["X-Upload-Content-Length"]).toBe("4");
      expect(initHeaders["X-Upload-Content-Type"]).toBe("video/mp4");
      const initBody = JSON.parse(initInit.body as string);
      expect(initBody).toEqual({
        snippet: { title: "A demo video", description: "some description", tags: ["ai", "demo"], categoryId: "28" },
        status: { privacyStatus: "public" },
      });

      const [uploadUrl, uploadInit] = fetchMock.mock.calls[1];
      expect(uploadUrl).toBe(`${UPLOAD_URL}?upload_id=abc123`);
      expect(uploadInit.method).toBe("PUT");
      const uploadHeaders = uploadInit.headers as Record<string, string>;
      expect(uploadHeaders.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(uploadHeaders["Content-Type"]).toBe("video/mp4");
      expect(uploadInit.body).toBe(uploadInput.videoBytes);
    });

    it("omits empty description/tags from the metadata body rather than sending blanks", async () => {
      const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
      fetchMock
        .mockResolvedValueOnce(sessionResponse(200, UPLOAD_URL))
        .mockResolvedValueOnce(jsonResponse(201, { id: "vid-2" }));

      await insertVideo({
        title: "No extras",
        categoryId: "22",
        privacyStatus: "unlisted",
        videoBytes: new Uint8Array([9]),
        mimeType: "video/mp4",
      });

      const initBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(initBody).toEqual({
        snippet: { title: "No extras", categoryId: "22" },
        status: { privacyStatus: "unlisted" },
      });
    });

    it("throws a YouTubeError when the session-open POST fails", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        jsonResponse(401, { error: { message: "invalid credentials" } }),
      );
      await expect(insertVideo(uploadInput)).rejects.toMatchObject({ status: 401 });
    });

    it("throws when the session response carries no Location header", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(sessionResponse(200, null));
      await expect(insertVideo(uploadInput)).rejects.toThrow(/no Location header/);
    });

    it("throws a clear error on a 308 Resume Incomplete rather than reporting success", async () => {
      const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
      fetchMock
        .mockResolvedValueOnce(sessionResponse(200, UPLOAD_URL))
        .mockResolvedValueOnce(emptyResponse(308));
      await expect(insertVideo(uploadInput)).rejects.toThrow(/Resume Incomplete/);
    });

    it("throws a YouTubeError when the byte PUT itself fails", async () => {
      const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
      fetchMock
        .mockResolvedValueOnce(sessionResponse(200, UPLOAD_URL))
        .mockResolvedValueOnce(jsonResponse(500, { error: { message: "internal error" } }));
      await expect(insertVideo(uploadInput)).rejects.toMatchObject({ status: 500 });
    });

    it("throws when the upload succeeds but the response body is empty", async () => {
      const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
      fetchMock.mockResolvedValueOnce(sessionResponse(200, UPLOAD_URL)).mockResolvedValueOnce(emptyResponse(201));
      await expect(insertVideo(uploadInput)).rejects.toThrow(/no video resource body/);
    });
  });

  describe("getVideos", () => {
    it("returns [] and makes no request for an empty id list", async () => {
      const videos = await getVideos([]);
      expect(videos).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
    });

    it("requests part=id and a comma-joined id list, mapping items to YouTubeVideo", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        jsonResponse(200, { items: [{ id: "v1" }, { id: "v2" }] }),
      );
      const videos = await getVideos(["v1", "v2"]);
      expect(videos).toEqual([{ id: "v1" }, { id: "v2" }]);
      const [url] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe("https://www.googleapis.com/youtube/v3/videos?part=id&id=v1%2Cv2");
    });

    it("returns an empty array (not a throw) when the vendor reports zero items", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(jsonResponse(200, { items: [] }));
      const videos = await getVideos(["gone"]);
      expect(videos).toEqual([]);
    });

    it("throws a YouTubeError when the lookup itself fails", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        jsonResponse(500, { error: { message: "internal error" } }),
      );
      await expect(getVideos(["v1"])).rejects.toBeInstanceOf(YouTubeError);
    });
  });

  describe("deleteVideo", () => {
    it("resolves on a 204 with no body", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(emptyResponse(204));
      await expect(deleteVideo("vid-1")).resolves.toBeUndefined();
      const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe("https://www.googleapis.com/youtube/v3/videos?id=vid-1");
      expect(init.method).toBe("DELETE");
    });

    it("throws a YouTubeError with status 404 for a missing video, detectable via isYouTubeNotFound", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        jsonResponse(404, { error: { message: "videoNotFound" } }),
      );
      let caught: unknown;
      try {
        await deleteVideo("gone");
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(YouTubeError);
      expect(isYouTubeNotFound(caught)).toBe(true);
    });

    it("does not classify a non-404 failure as not-found", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        jsonResponse(401, { error: { message: "token expired" } }),
      );
      let caught: unknown;
      try {
        await deleteVideo("x");
      } catch (err) {
        caught = err;
      }
      expect(isYouTubeNotFound(caught)).toBe(false);
    });
  });

  describe("getMyChannel", () => {
    it("returns the authenticated user's channel id and title", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        jsonResponse(200, { items: [{ id: "chan-1", snippet: { title: "Acme" } }] }),
      );
      const channel = await getMyChannel();
      expect(channel).toEqual({ id: "chan-1", title: "Acme" });
      const [url] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true");
    });

    it("throws when mine=true returns zero channels", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(jsonResponse(200, { items: [] }));
      await expect(getMyChannel()).rejects.toThrow(/no channel found/);
    });

    it("rejects with a YouTubeError on a vendor failure", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        jsonResponse(401, { error: { message: "invalid token" } }),
      );
      await expect(getMyChannel()).rejects.toBeInstanceOf(YouTubeError);
    });
  });
});
