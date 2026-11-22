import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHmac } from "node:crypto";

/**
 * Coverage for the new threads.ts vendor client (threads-transport.ts's "how
 * do we talk to it" half).
 *
 * Named threads-client.test.ts, NOT threads.test.ts: that filename is already
 * taken by pre-existing coverage of SPECS.threads (the aggregator-era spec
 * pinning) and the marketing-site "Threads stays off the footer" guard — both
 * unrelated to this vendor client and neither safe to overwrite. Same
 * precedent as pinterest-client.test.ts alongside the older pinterest.test.ts
 * (see that file's own header comment).
 */

import {
  THREADS_API_VERSION,
  ThreadsError,
  isThreadsNotFound,
  setThreadsCredentialsResolver,
  threadsCredentials,
  createContainer,
  publishContainer,
  getContainerStatus,
  pollContainerUntilFinished,
  deleteThread,
  getPermalink,
  getProfile,
  getMediaInsights,
  getUserInsights,
} from "../threads.js";
import { appsecretProof } from "../meta-graph.js";

const TOKEN = "threads-user-token-abc";
const SECRET = "threads-app-secret-xyz";
const USER_ID = "17841400000000000";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => jsonResponse({ id: "123" }));
  vi.stubGlobal("fetch", fetchMock);
  setThreadsCredentialsResolver(async () => ({ appSecret: SECRET, accessToken: TOKEN, userId: USER_ID }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setThreadsCredentialsResolver(null);
});

describe("threadsCredentials", () => {
  it("refuses with a directive error when no resolver is registered", async () => {
    setThreadsCredentialsResolver(null);
    await expect(threadsCredentials()).rejects.toThrow(/setThreadsCredentialsResolver/);
  });

  it("returns whatever the app layer injected", async () => {
    await expect(threadsCredentials()).resolves.toEqual({ appSecret: SECRET, accessToken: TOKEN, userId: USER_ID });
  });
});

describe("request plumbing (via createContainer)", () => {
  it("hits graph.threads.net at the pinned version, under the credential's userId", async () => {
    await createContainer({ mediaType: "TEXT", text: "hello" });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url.startsWith(`https://graph.threads.net/${THREADS_API_VERSION}/${USER_ID}/threads`)).toBe(true);
    expect(THREADS_API_VERSION).toBe("v1.0");
  });

  it("sends appsecret_proof and access_token on a POST, in the body — never the request line", async () => {
    await createContainer({ mediaType: "TEXT", text: "hello" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).not.toContain("appsecret_proof");
    const body = new URLSearchParams(String((init as RequestInit).body));
    expect(body.get("appsecret_proof")).toBe(appsecretProof(TOKEN, SECRET));
    expect(body.get("access_token")).toBe(TOKEN);
    expect(body.get("media_type")).toBe("TEXT");
    expect(body.get("text")).toBe("hello");
  });

  it("resolves credentials fresh on every call rather than caching them", async () => {
    const resolver = vi.fn(async () => ({ appSecret: SECRET, accessToken: TOKEN, userId: USER_ID }));
    setThreadsCredentialsResolver(resolver);
    await createContainer({ mediaType: "TEXT", text: "a" });
    await createContainer({ mediaType: "TEXT", text: "b" });
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it("omits undefined params instead of sending the string 'undefined'", async () => {
    await createContainer({ mediaType: "TEXT", text: "hello" });
    const body = new URLSearchParams(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body.has("image_url")).toBe(false);
    expect(body.has("reply_to_id")).toBe(false);
    expect(body.has("is_carousel_item")).toBe(false);
  });

  it("decodes a Meta-style error envelope even on an HTTP 200", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        error: { message: "Invalid OAuth access token", type: "OAuthException", code: 190, error_subcode: 460, fbtrace_id: "AbCd" },
      }),
    );
    await expect(createContainer({ mediaType: "TEXT", text: "x" })).rejects.toMatchObject({
      name: "ThreadsError",
      code: 190,
      subcode: 460,
      type: "OAuthException",
      traceId: "AbCd",
    });
  });

  it("turns a non-JSON body into a status-shaped error rather than throwing SyntaxError", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html>502 Bad Gateway</html>", { status: 502 }));
    const err = await createContainer({ mediaType: "TEXT", text: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(ThreadsError);
    expect(err.status).toBe(502);
    expect(err.retryable).toBe(true);
  });
});

describe("createContainer", () => {
  it("builds a TEXT container from just media_type + text", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "container-1" }));
    const ref = await createContainer({ mediaType: "TEXT", text: "shipping notes" });
    expect(ref).toEqual({ id: "container-1" });
  });

  it("builds an IMAGE container with image_url", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "container-2" }));
    await createContainer({ mediaType: "IMAGE", imageUrl: "https://cdn.example.com/card.png", text: "caption" });
    const body = new URLSearchParams(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body.get("media_type")).toBe("IMAGE");
    expect(body.get("image_url")).toBe("https://cdn.example.com/card.png");
  });

  it("builds a VIDEO container with video_url and no image_url", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "container-v" }));
    await createContainer({
      mediaType: "VIDEO",
      videoUrl: "https://media.example.com/clip.mp4",
      text: "caption",
      altText: "a phone answering itself",
    });
    const body = new URLSearchParams(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body.get("media_type")).toBe("VIDEO");
    expect(body.get("video_url")).toBe("https://media.example.com/clip.mp4");
    expect(body.get("alt_text")).toBe("a phone answering itself");
    expect(body.has("image_url")).toBe(false);
  });

  it("builds a CAROUSEL container with comma-joined children", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "carousel-1" }));
    await createContainer({ mediaType: "CAROUSEL", children: ["c1", "c2", "c3"] });
    const body = new URLSearchParams(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body.get("children")).toBe("c1,c2,c3");
  });

  it("sets reply_to_id when replying, using the exact vendor parameter name", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "reply-1" }));
    await createContainer({ mediaType: "TEXT", text: "a reply", replyToId: "root-123" });
    const body = new URLSearchParams(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body.get("reply_to_id")).toBe("root-123");
  });

  it("marks a carousel child with is_carousel_item=true", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "child-1" }));
    await createContainer({ mediaType: "IMAGE", imageUrl: "https://cdn.example.com/a.png", isCarouselItem: true });
    const body = new URLSearchParams(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body.get("is_carousel_item")).toBe("true");
  });

  it("throws when the response carries no id", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    await expect(createContainer({ mediaType: "TEXT", text: "x" })).rejects.toThrow(/at id: expected a non-empty string, got missing/);
  });
});

describe("publishContainer", () => {
  it("POSTs to threads_publish with creation_id and returns the published id", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "published-1" }));
    const ref = await publishContainer("container-1");
    expect(ref).toEqual({ id: "published-1" });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain(`/${USER_ID}/threads_publish`);
    const body = new URLSearchParams(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body.get("creation_id")).toBe("container-1");
  });
});

describe("getContainerStatus", () => {
  it("reads status + error_message via GET with fields=status,error_message", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: "FINISHED" }));
    const status = await getContainerStatus("container-1");
    expect(status).toEqual({ status: "FINISHED", errorMessage: undefined });
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toBe(`/${THREADS_API_VERSION}/container-1`);
    expect(url.searchParams.get("fields")).toBe("status,error_message");
  });

  it("carries error_message through for the ERROR state", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: "ERROR", error_message: "FAILED_DOWNLOADING_VIDEO" }));
    const status = await getContainerStatus("container-1");
    expect(status).toEqual({ status: "ERROR", errorMessage: "FAILED_DOWNLOADING_VIDEO" });
  });
});

describe("pollContainerUntilFinished", () => {
  it("returns immediately once the first check reads FINISHED", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: "FINISHED" }));
    await expect(pollContainerUntilFinished("c1")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("also accepts PUBLISHED as a terminal success", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: "PUBLISHED" }));
    await expect(pollContainerUntilFinished("c1")).resolves.toBeUndefined();
  });

  it("polls again while IN_PROGRESS, up to maxAttempts, waiting intervalMs between checks", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ status: "IN_PROGRESS" }))
      .mockResolvedValueOnce(jsonResponse({ status: "IN_PROGRESS" }))
      .mockResolvedValueOnce(jsonResponse({ status: "FINISHED" }));

    const done = pollContainerUntilFinished("c1", { maxAttempts: 5, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("throws a named error and stops polling on ERROR, carrying error_message", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: "ERROR", error_message: "FAILED_PROCESSING_VIDEO" }));
    await expect(pollContainerUntilFinished("c1")).rejects.toMatchObject({
      name: "ThreadsError",
      message: expect.stringContaining("FAILED_PROCESSING_VIDEO"),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws on EXPIRED without retrying", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: "EXPIRED" }));
    await expect(pollContainerUntilFinished("c1")).rejects.toThrow(/expired/);
  });

  it("gives up after maxAttempts of persistent IN_PROGRESS, never publishing an unready container", async () => {
    vi.useFakeTimers();
    // A fresh Response per call — a Response body can only be read once, and
    // mockResolvedValue (unlike mockResolvedValueOnce) would otherwise hand
    // back the SAME already-consumed Response on every poll attempt.
    fetchMock.mockImplementation(async () => jsonResponse({ status: "IN_PROGRESS" }));
    const done = pollContainerUntilFinished("c1", { maxAttempts: 3, intervalMs: 500 });
    const assertion = expect(done).rejects.toThrow(/still IN_PROGRESS/);
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("deleteThread", () => {
  it("DELETEs /{id} with the credential's access_token as a query param", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, deleted_id: "post-1" }));
    await expect(deleteThread("post-1")).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0];
    expect((init as RequestInit).method).toBe("DELETE");
    const parsed = new URL(String(url));
    expect(parsed.pathname).toBe(`/${THREADS_API_VERSION}/post-1`);
    expect(parsed.searchParams.get("access_token")).toBe(TOKEN);
  });

  it("throws for a real failure rather than swallowing it", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { message: "Invalid OAuth access token", code: 190 } }, 401),
    );
    await expect(deleteThread("post-1")).rejects.toThrow(/Invalid OAuth access token/);
  });
});

describe("isThreadsNotFound", () => {
  it("is true for a plain 404", () => {
    expect(isThreadsNotFound(new ThreadsError("gone", 404, null, null, null, null))).toBe(true);
  });

  it("is true for the classic Graph-family 'does not exist' wording even without a 404 status", () => {
    expect(
      isThreadsNotFound(new ThreadsError("Unsupported get request. Object does not exist.", 400, 100, null, "GraphMethodException", null)),
    ).toBe(true);
  });

  it("is false for an unrelated error", () => {
    expect(isThreadsNotFound(new ThreadsError("Invalid OAuth access token", 401, 190, null, "OAuthException", null))).toBe(false);
  });

  it("is false for a non-ThreadsError", () => {
    expect(isThreadsNotFound(new Error("boom"))).toBe(false);
  });
});

describe("getPermalink", () => {
  it("returns the permalink field", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ permalink: "https://www.threads.net/@examplebrand/post/abcdefg" }));
    await expect(getPermalink("post-1")).resolves.toBe("https://www.threads.net/@examplebrand/post/abcdefg");
  });

  it("returns undefined, not throw, when the field is simply absent", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    await expect(getPermalink("post-1")).resolves.toBeUndefined();
  });
});

describe("getProfile", () => {
  it("fetches /me?fields=id,username regardless of the credential's userId", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "999", username: "examplebrand" }));
    const profile = await getProfile();
    expect(profile).toEqual({ id: "999", username: "examplebrand" });
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toBe(`/${THREADS_API_VERSION}/me`);
    expect(url.searchParams.get("fields")).toBe("id,username");
  });

  it("throws when id or username is missing from the response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "999" }));
    await expect(getProfile()).rejects.toThrow(/GET \/me: unexpected response shape at username: expected a non-empty string, got missing/);
  });
});

describe("ThreadsError classification", () => {
  const make = (code: number | null, status = 400) => new ThreadsError("x", status, code, null, null, null);

  it("treats rate limits and transient service errors as retryable", () => {
    for (const code of [1, 2, 4, 17, 32, 613]) expect(make(code).retryable).toBe(true);
    expect(make(null, 503).retryable).toBe(true);
  });

  it("does NOT treat a permissions or validation error as retryable", () => {
    for (const code of [100, 200, 190, 368]) expect(make(code).retryable).toBe(false);
  });

  it("flags dead-token codes as needing a human, not a retry", () => {
    for (const code of [190, 102, 10, 200]) expect(make(code).needsReauth).toBe(true);
    expect(make(4).needsReauth).toBe(false);
  });
});

describe("appsecretProof reuse", () => {
  it("computes the identical HMAC meta-graph.ts's own tests verify independently", () => {
    const expected = createHmac("sha256", SECRET).update(TOKEN).digest("hex");
    expect(appsecretProof(TOKEN, SECRET)).toBe(expected);
  });
});

/**
 * ⛔ TWO RESPONSE SHAPES, AND ONLY ONE IS SHOWN IN THE DOCS.
 *
 * Meta's insights family reports "Total Value" metrics as
 * `total_value: { value }` and time-series metrics as `values: [{ value }]`.
 * The Threads docs show the `values` form for media insights and describe
 * several USER metrics as Total Value without ever showing that response.
 *
 * Parsing only the documented shape would return nothing for the other — and on
 * a dashboard "no data" is indistinguishable from genuine zero engagement, so
 * the failure would look like a quiet account rather than a parsing bug. Both
 * are accepted, and anything unparseable is reported ABSENT rather than 0.
 */
describe("insights parsing", () => {
  it("reads the documented values[] shape", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: [{ name: "likes", period: "lifetime", values: [{ value: 12 }] }] }),
    );
    await expect(getMediaInsights("m1")).resolves.toEqual({ likes: 12 });
  });

  it("reads the total_value shape the docs describe but never show", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: [{ name: "followers_count", total_value: { value: 250 } }] }),
    );
    await expect(getUserInsights()).resolves.toEqual({ followers_count: 250 });
  });

  it("omits a metric whose value is missing or not a number, rather than calling it 0", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: [
          { name: "likes", values: [{ value: 5 }] },
          { name: "views", values: [] },
          { name: "quotes", values: [{ value: "12" }] }, // a string is not a count
          { name: "replies" },
        ],
      }),
    );
    const bag = await getMediaInsights("m1");
    expect(bag).toEqual({ likes: 5 });
    for (const absent of ["views", "quotes", "replies"]) {
      expect(absent in bag).toBe(false);
    }
  });

  it("keeps a vendor-reported zero, which is a real datum", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [{ name: "quotes", values: [{ value: 0 }] }] }));
    await expect(getMediaInsights("m1")).resolves.toEqual({ quotes: 0 });
  });

  it("requests the media metrics on the insights path", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));
    await getMediaInsights("m1");
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toBe(`/${THREADS_API_VERSION}/m1/insights`);
  });
});
