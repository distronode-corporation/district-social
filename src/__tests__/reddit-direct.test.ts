import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setEngineDeployment } from "../settings.js";
import { FIXTURE_REDDIT_USER_AGENT } from "./helpers/fixtures.js";
import { RedditApiError, RedditError, redditUserAgent, setRedditTokenResolver, submitPost, getMe } from "../reddit.js";
import { redditTransport } from "../reddit-transport.js";
import { isRejection, isUnknownOutcome, retryAfterMs } from "../retry.js";
import type { MediaAsset, PlatformRender } from "../types.js";
import type { DirectPublishInput, PublishDestination } from "../transport.js";

/**
 * The direct Reddit route, cut over 2026-10-21 because Reddit blocks Zernio.
 *
 * What this file pins, beyond reddit-client*.test.ts:
 *   - the honest default User-Agent (Reddit bans dishonest ones);
 *   - a 429's `x-ratelimit-reset` becoming the retry delay, since oauth.reddit.com
 *     sends that rather than Retry-After;
 *   - the operator hints on the two `json.errors` codes a Social HQ post meets
 *     (flair required, RATELIMIT), with no prototype key leaking into a message;
 *   - the image-post websocket handshake, where every failure must stay a 200
 *     that retry.ts never repeats (the submit was accepted, a retry posts twice);
 *   - the clean refusal of a copy-less video post.
 *
 * ⚠️ These prove THIS CLIENT'S behaviour. The websocket protocol is PRAW's
 * observation, not a Reddit contract, and nothing here touched the network.
 */

function response(status: number, body: string, headers?: Record<string, string>): Response {
  return new Response(body, { status, headers });
}

const fetchMock = () => fetch as unknown as ReturnType<typeof vi.fn>;

/** A scripted stand-in for the global WebSocket, one instance per test. */
class FakeSocket {
  static last: FakeSocket | null = null;
  static throwOnConstruct = false;
  static throwOnClose = false;
  url: string;
  closed = false;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  constructor(url: string) {
    if (FakeSocket.throwOnConstruct) throw new Error("refused");
    this.url = url;
    FakeSocket.last = this;
  }
  close() {
    this.closed = true;
    if (FakeSocket.throwOnClose) throw new Error("already closing");
  }
}

function socket(): FakeSocket {
  if (!FakeSocket.last) throw new Error("no websocket was opened");
  return FakeSocket.last;
}

/** Let submitPost's awaits run until it has opened the socket. */
async function opened(): Promise<FakeSocket> {
  for (let i = 0; i < 20 && !FakeSocket.last; i++) await Promise.resolve();
  return socket();
}

const WS = "wss://ws-0a1b.wss.redditmedia.com/rte_images/abc?m=AQ";

function imageSubmitAnswer(data: Record<string, unknown>): Response {
  return response(200, JSON.stringify({ json: { errors: [], data } }));
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  vi.stubGlobal("WebSocket", FakeSocket);
  FakeSocket.last = null;
  FakeSocket.throwOnConstruct = false;
  FakeSocket.throwOnClose = false;
  setRedditTokenResolver(async () => "tok");
  setEngineDeployment({ redditUserAgent: FIXTURE_REDDIT_USER_AGENT });
  delete process.env.SOCIALMETA_REDDIT_USER_AGENT;
});

afterEach(() => {
  setRedditTokenResolver(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("User-Agent", () => {
  it("throws before any request when neither env nor the deployment names one", async () => {
    setEngineDeployment({});
    expect(() => redditUserAgent()).toThrow(/Reddit needs a User-Agent/);
    await expect(getMe()).rejects.toThrow(/Reddit needs a User-Agent/);
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it("sends the deployment's User-Agent when env sets none", async () => {
    expect(redditUserAgent()).toBe(FIXTURE_REDDIT_USER_AGENT);
    fetchMock().mockResolvedValue(response(200, JSON.stringify({ id: "1", name: "examplebrand" })));
    await getMe();
    const init = fetchMock().mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["User-Agent"]).toBe(redditUserAgent());
  });
});

describe("rate limits", () => {
  async function failWith(status: number, headers?: Record<string, string>, body = "{}"): Promise<RedditError> {
    fetchMock().mockResolvedValue(response(status, body, headers));
    return getMe().then(
      () => {
        throw new Error("expected a rejection");
      },
      (err: RedditError) => err,
    );
  }

  it("a 429 carries x-ratelimit-reset as the retry delay, rounded up, and says nothing was posted", async () => {
    const err = await failWith(429, { "x-ratelimit-reset": "41.2" });
    expect(err.retryAfter).toBe("42");
    // retry.ts then clamps the wait to its 30s ceiling.
    expect(retryAfterMs(err, 0)).toBe(30_000);
    expect(isRejection(err)).toBe(true);
    expect(err.message).toMatch(/rate limited by Reddit \(resets in 42s\); nothing was posted/);
  });

  it("prefers a real Retry-After over the reset header", async () => {
    const err = await failWith(429, { "retry-after": "7", "x-ratelimit-reset": "300" });
    expect(err.retryAfter).toBe("7");
  });

  it("a 429 with no usable clock says so rather than inventing one", async () => {
    for (const headers of [undefined, { "x-ratelimit-reset": "soon" }, { "x-ratelimit-reset": "-3" }]) {
      const err = await failWith(429, headers);
      expect(err.retryAfter).toBeNull();
      expect(err.message).toMatch(/\(no reset time given\); nothing was posted/);
    }
  });

  it("tolerates a response stand-in with no header bag on the error path", async () => {
    fetchMock().mockResolvedValue({ ok: false, status: 429, text: async () => "slow down" } as unknown as Response);
    const err = await getMe().catch((e: RedditError) => e);
    expect(err).toBeInstanceOf(RedditError);
    expect((err as RedditError).retryAfter).toBeNull();
  });

  it("leaves a non-429 failure's body as the vendor sent it", async () => {
    const err = await failWith(403, { "x-ratelimit-reset": "10" }, '{"message":"Forbidden"}');
    expect(err.message).toBe('Reddit GET /api/v1/me -> 403: {"message":"Forbidden"}');
    expect(err.retryAfter).toBe("10");
  });
});

describe("json.errors hints", () => {
  function rejectWith(errors: string[][]): Promise<RedditApiError> {
    fetchMock().mockResolvedValue(response(200, JSON.stringify({ json: { errors, data: {} } })));
    return submitPost({ subreddit: "test", title: "t", kind: "self", text: "x" }).catch((e: RedditApiError) => e) as Promise<RedditApiError>;
  }

  it("tells the operator to set a flair, and flags it", async () => {
    const err = await rejectWith([["SUBMIT_VALIDATION_FLAIR_REQUIRED", "Your post must contain post flair.", "flair"]]);
    expect(err).toBeInstanceOf(RedditApiError);
    expect(err.flairRequired).toBe(true);
    expect(err.message).toMatch(/requires a post flair: set one on the Reddit render/);
  });

  it("says a RATELIMIT posted nothing, and does not make it retryable", async () => {
    const err = await rejectWith([["RATELIMIT", "you are doing that too much. try again in 9 minutes.", "ratelimit"]]);
    expect(err.flairRequired).toBe(false);
    expect(err.message).toMatch(/throttling this account; nothing was posted/);
    expect(isRejection(err)).toBe(false);
  });

  it("adds nothing for an unknown code, including a prototype key", async () => {
    const err = await rejectWith([["constructor", "odd", "x"], ["SUBREDDIT_NOEXIST", "that subreddit doesn't exist", "sr"]]);
    expect(err.message).toBe(
      "Reddit POST /api/submit -> 200 OK but rejected the request: constructor: odd (field: x); " +
        "SUBREDDIT_NOEXIST: that subreddit doesn't exist (field: sr)",
    );
  });
});

describe("image post websocket", () => {
  function submitImage() {
    return submitPost({ subreddit: "u_example", title: "t", kind: "image", url: "https://reddit-uploaded-media.s3-accelerate.amazonaws.com/k" });
  }

  it("resolves the post from the announced permalink and closes the socket", async () => {
    fetchMock().mockResolvedValue(imageSubmitAnswer({ websocket_url: WS, user_submitted_page: "https://www.reddit.com/user/examplebrand/submitted/" }));
    const pending = submitImage();
    const ws = await opened();
    expect(ws.url).toBe(WS);
    ws.onmessage!({ data: JSON.stringify({ type: "success", payload: { redirect: "https://www.reddit.com/r/u_example/comments/1abc2de/t/" } }) });
    await expect(pending).resolves.toEqual({ id: "1abc2de", name: "t3_1abc2de" });
    expect(ws.closed).toBe(true);
  });

  it("a reported failure says nothing was posted", async () => {
    fetchMock().mockResolvedValue(imageSubmitAnswer({ websocket_url: WS }));
    const pending = submitImage();
    (await opened()).onmessage!({ data: '{"type":"failed"}' });
    await expect(pending).rejects.toThrow(/processing the image post failed; nothing was posted/);
  });

  it.each([
    ["not JSON", "<html>", /was not JSON/],
    ["JSON null", "null", /named no post/],
    ["no payload", '{"type":"success"}', /named no post/],
    ["a non-string redirect", '{"type":"success","payload":{"redirect":42}}', /named no post/],
    ["a redirect with no post id", '{"type":"success","payload":{"redirect":"https://www.reddit.com/"}}', /named no post/],
  ])("an announcement with %s is an unknown outcome that is never retried", async (_label, data, why) => {
    fetchMock().mockResolvedValue(imageSubmitAnswer({ websocket_url: WS }));
    const pending = submitImage();
    (await opened()).onmessage!({ data });
    const err = await pending.catch((e: RedditError) => e);
    expect((err as RedditError).message).toMatch(why);
    expect((err as RedditError).message).toMatch(/check the account's posts before publishing again/);
    expect(isRejection(err)).toBe(false);
    expect(isUnknownOutcome(err)).toBe(false);
  });

  it("an error, then a close, settles once with the first reason", async () => {
    FakeSocket.throwOnClose = true;
    fetchMock().mockResolvedValue(imageSubmitAnswer({ websocket_url: WS }));
    const pending = submitImage();
    const ws = await opened();
    ws.onerror!();
    ws.onclose!();
    await expect(pending).rejects.toThrow(/the websocket errored/);
  });

  it("a close before any announcement is an unknown outcome", async () => {
    fetchMock().mockResolvedValue(imageSubmitAnswer({ websocket_url: WS }));
    const pending = submitImage();
    (await opened()).onclose!();
    await expect(pending).rejects.toThrow(/closed before announcing/);
  });

  it("gives up after 30s of silence", async () => {
    vi.useFakeTimers();
    fetchMock().mockResolvedValue(imageSubmitAnswer({ websocket_url: WS }));
    const pending = submitImage().catch((e: Error) => e);
    await opened();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(String(await pending)).toMatch(/no announcement within 30s/);
  });

  it("a socket that cannot be opened is an unknown outcome", async () => {
    FakeSocket.throwOnConstruct = true;
    fetchMock().mockResolvedValue(imageSubmitAnswer({ websocket_url: WS }));
    await expect(submitImage()).rejects.toThrow(/could not be opened: Error: refused/);
  });

  it("refuses a websocket that is not wss", async () => {
    fetchMock().mockResolvedValue(imageSubmitAnswer({ websocket_url: "ws://169.254.169.254/" }));
    await expect(submitImage()).rejects.toThrow(/not wss: ws:\/\/169\.254\.169\.254\//);
    expect(FakeSocket.last).toBeNull();
  });

  it("an image answer that already carries an id needs no socket", async () => {
    fetchMock().mockResolvedValue(imageSubmitAnswer({ id: "9z", name: "t3_9z", websocket_url: WS }));
    await expect(submitImage()).resolves.toEqual({ id: "9z", name: "t3_9z" });
    expect(FakeSocket.last).toBeNull();
  });

  it("a self post never waits on a socket, even if one is announced", async () => {
    fetchMock().mockResolvedValue(imageSubmitAnswer({ websocket_url: WS }));
    await expect(submitPost({ subreddit: "s", title: "t", kind: "self", text: "x" })).rejects.toThrow(/no usable post id\/name/);
    expect(FakeSocket.last).toBeNull();
  });
});

describe("transport: video", () => {
  function input(content: string, media: MediaAsset[], link?: string): DirectPublishInput {
    return {
      render: { platform: "reddit", content, title: "A title", mediaIndices: [] } as unknown as PlatformRender,
      media,
      destination: { subreddit: "u_example", ...(link ? { link } : {}) } as PublishDestination,
    } as DirectPublishInput;
  }
  const video = { path: "/tmp/v.mp4", type: "video", mimeType: "video/mp4", size: 10, url: "https://cdn.example.com/v.mp4" } as MediaAsset;

  it("refuses a copy-less video post with a clear message, before any vendor call", async () => {
    await expect(redditTransport.publishNow(input("  ", [video], "https://example.com"))).rejects.toThrow(
      /video posts are not supported by the direct Reddit transport/,
    );
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it("publishes copy with a video as a self post, dropping the video loudly", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock().mockResolvedValue(imageSubmitAnswer({ id: "5q", name: "t3_5q" }));
    await expect(redditTransport.publishNow(input("The copy", [video]))).resolves.toEqual({
      ref: "t3_5q",
      url: "https://redd.it/5q",
    });
    const form = new URLSearchParams(String((fetchMock().mock.calls[0][1] as RequestInit).body));
    expect(form.get("kind")).toBe("self");
    expect(warn.mock.calls[0][0]).toMatch(/1 attached asset\(s\) will NOT be uploaded/);
    warn.mockRestore();
  });
});
