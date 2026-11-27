// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

/**
 * vendor-fetch.ts: the one place a vendor request is bounded and its transport
 * failure becomes the client's own error with `status: 0`.
 *
 * The property that matters most is the cross-file one: what comes out has to
 * classify as an UNKNOWN outcome in retry.ts, so it is asserted against the
 * real `isUnknownOutcome`, not against a copy of its rule.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { noResponseMessage, vendorFetch } from "../vendor-fetch.js";
import { isUnknownOutcome } from "../retry.js";

class ClientError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ClientError";
  }
}

const wrap = (status: 0, message: string) => new ClientError(status, message);

function timeoutError(): Error {
  const err = new Error("The operation was aborted due to timeout");
  err.name = "TimeoutError";
  return err;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("noResponseMessage", () => {
  it("tells the operator to check before retrying a publish", () => {
    expect(noResponseMessage(15_000)).toBe(
      "no response after 15s (the request may still complete server-side; check before retrying a publish)",
    );
  });

  it("names what timed out when given a label", () => {
    expect(noResponseMessage(120_000, "media upload")).toBe(
      "media upload: no response after 120s (the request may still complete server-side; check before retrying a publish)",
    );
  });
});

describe("vendorFetch", () => {
  it("passes the request through with a timeout signal in place of any caller signal", async () => {
    const res = new Response("ok");
    const fetchMock = vi.fn().mockResolvedValue(res);
    vi.stubGlobal("fetch", fetchMock);
    const callerSignal = new AbortController().signal;

    await expect(
      vendorFetch("https://api.example/x", { method: "POST", body: "b", signal: callerSignal }, { timeoutMs: 1000, wrap }),
    ).resolves.toBe(res);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.example/x");
    expect(init.method).toBe("POST");
    expect(init.body).toBe("b");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal).not.toBe(callerSignal);
  });

  it("does not wrap a vendor's HTTP error answer: that is the client's to read", async () => {
    const res = new Response("nope", { status: 503 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res));

    await expect(vendorFetch("https://api.example/x", {}, { timeoutMs: 1000, wrap })).resolves.toBe(res);
  });

  it("⛔ wraps a timeout as the client's error with status 0 and the check-first wording", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(timeoutError()));

    const err = await vendorFetch("https://api.example/x", {}, { timeoutMs: 15_000, label: "Meta GET /me", wrap }).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(ClientError);
    expect((err as ClientError).status).toBe(0);
    expect((err as ClientError).message).toBe(noResponseMessage(15_000, "Meta GET /me"));
    expect(isUnknownOutcome(err)).toBe(true);
  });

  it("⛔ wraps a network failure the same way, never letting a raw TypeError escape", async () => {
    // meta-graph.ts rethrew this as-is, so every caller's instanceof check missed it.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));

    const err = await vendorFetch("https://api.example/x", {}, { timeoutMs: 1000, wrap }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ClientError);
    expect((err as ClientError).status).toBe(0);
    expect((err as ClientError).message).toBe("fetch failed");
    expect(isUnknownOutcome(err)).toBe(true);
  });

  it("reads the message off a non-Error rejection", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("socket hang up"));

    const err = await vendorFetch("https://api.example/x", {}, { timeoutMs: 1000, wrap }).catch((e: unknown) => e);

    expect((err as ClientError).message).toBe("socket hang up");
  });
});
