import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setEngineDeployment } from "../settings.js";
import { FIXTURE_REDDIT_USER_AGENT } from "./helpers/fixtures.js";

/**
 * The production half of uploadMediaAsset's SSRF guard. Under NODE_ENV=test
 * the real preparePinnedHttpsFetch skips DNS and returns no dispatcher, so the
 * other suites never see the pinned-dispatcher / `redirect: "error"` init. This
 * stubs the guard to answer the way it does in production and asserts both
 * reach the S3 POST: dropping either reopens the re-resolve or the
 * 302-into-the-private-network bypass the guard exists for.
 */
const h = vi.hoisted(() => ({ prepare: vi.fn() }));

vi.mock("../ssrf.js", async (importActual) => ({
  ...(await importActual<typeof import("../ssrf.js")>()),
  preparePinnedHttpsFetch: h.prepare,
}));

import { setRedditTokenResolver, uploadMediaAsset } from "../reddit.js";

type FetchFn = (input: string, init?: RequestInit & { dispatcher?: unknown }) => Promise<Response>;

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  } as unknown as Response;
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn<FetchFn>());
  setRedditTokenResolver(async () => "token");
  setEngineDeployment({ redditUserAgent: FIXTURE_REDDIT_USER_AGENT });
});

afterEach(() => {
  setRedditTokenResolver(null);
  vi.unstubAllGlobals();
  h.prepare.mockReset();
});

describe("uploadMediaAsset with a pinned dispatcher", () => {
  it("passes the guard's dispatcher and redirect policy through to the S3 POST", async () => {
    const dispatcher = { pinned: true };
    h.prepare.mockResolvedValue({ dispatcher, redirect: "error" });
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn<FetchFn>>;
    fetchMock
      .mockResolvedValueOnce(
        response(200, { args: { action: "https://bucket.s3.amazonaws.com/", fields: [{ name: "key", value: "k.jpg" }] } }),
      )
      .mockResolvedValueOnce(response(201, undefined));

    const result = await uploadMediaAsset(new Uint8Array([1]), "c.jpg", "image/jpeg");

    expect(h.prepare).toHaveBeenCalledWith("https://bucket.s3.amazonaws.com/");
    const init = fetchMock.mock.calls[1]![1]!;
    expect(init.redirect).toBe("error");
    expect(init.dispatcher).toBe(dispatcher);
    expect(result.url).toBe("https://bucket.s3.amazonaws.com/k.jpg");
  });
});
