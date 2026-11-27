// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The zernio.ts client's sparse-answer and failure branches, against a mocked
 * `fetch`. zernio-aggregator.test.ts drives the happy paths through the
 * aggregator; this pins what each call returns or throws when the vendor
 * answers with less than the documented shape.
 */

import {
  ZernioError,
  setZernioTokenResolver,
  listAccounts,
  createPost,
  getPost,
  listRedditFlairs,
} from "../zernio.js";

function response(status: number, text: string, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => text,
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  setZernioTokenResolver(async () => "sk_test");
});

afterEach(() => {
  vi.unstubAllGlobals();
  setZernioTokenResolver(null);
});

describe("token resolver", () => {
  it("refuses with a status-0 ZernioError, before any request, when no resolver is wired", async () => {
    setZernioTokenResolver(null);
    const err = (await listAccounts().catch((e: unknown) => e)) as ZernioError;
    expect(err).toBeInstanceOf(ZernioError);
    expect(err.status).toBe(0);
    expect(err.message).toMatch(/no Zernio token resolver/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("empty and sparse answers", () => {
  it("refuses an empty 200 body rather than reading it as no connected accounts", async () => {
    fetchMock.mockResolvedValue(response(200, ""));
    await expect(listAccounts()).rejects.toThrow(/zernio GET \/accounts: unexpected response shape at \(body\): expected an object, got null/);
  });

  it("reads a body with no accounts key as no accounts", async () => {
    fetchMock.mockResolvedValue(response(200, "{}"));
    await expect(listAccounts()).resolves.toEqual([]);
  });

  it("reads a flairs answer with no flairs key as none", async () => {
    fetchMock.mockResolvedValue(response(200, "{}"));
    await expect(listRedditFlairs("acc_1", "smallbusiness")).resolves.toEqual([]);
  });

  it("returns an empty post, not a crash, for a create that answered 200 with no body", async () => {
    // The aggregator turns a missing _id into its "may be LIVE" error; this layer
    // must hand it something to inspect rather than throwing on null.
    fetchMock.mockResolvedValue(response(200, ""));
    await expect(createPost({ content: "x", platforms: [] })).resolves.toEqual({});
  });

  it("unwraps a bare post that has no {post} envelope", async () => {
    fetchMock.mockResolvedValue(response(200, JSON.stringify({ _id: "zp_1", status: "published" })));
    await expect(getPost("zp_1")).resolves.toMatchObject({ _id: "zp_1" });
  });
});

describe("error messages on a non-2xx", () => {
  it("uses the raw body when it is not JSON", async () => {
    fetchMock.mockResolvedValue(response(502, "Bad Gateway"));
    const err = (await listAccounts().catch((e: unknown) => e)) as ZernioError;
    expect(err.message).toBe("Bad Gateway");
    expect(err.status).toBe(502);
  });

  it("falls back to the status when the body is empty, and carries Retry-After", async () => {
    fetchMock.mockResolvedValue(response(429, "", { "retry-after": "30" }));
    const err = (await listAccounts().catch((e: unknown) => e)) as ZernioError;
    expect(err.message).toBe("Zernio 429");
    expect(err.retryAfter).toBe("30");
    expect(err.code).toBeUndefined();
  });

  it("uses the raw JSON text when the error envelope has no error string", async () => {
    fetchMock.mockResolvedValue(response(400, JSON.stringify({ code: "invalid_field_value" })));
    const err = (await listAccounts().catch((e: unknown) => e)) as ZernioError;
    expect(err.message).toBe('{"code":"invalid_field_value"}');
    expect(err.code).toBe("invalid_field_value");
  });
});

describe("ZernioError.retryable", () => {
  it("is true for a rate limit and any 5xx, false for a 4xx decision and a status-0 failure", () => {
    expect(new ZernioError("x", 429).retryable).toBe(true);
    expect(new ZernioError("x", 500).retryable).toBe(true);
    expect(new ZernioError("x", 503).retryable).toBe(true);
    expect(new ZernioError("x", 400).retryable).toBe(false);
    expect(new ZernioError("x", 0).retryable).toBe(false);
  });
});
