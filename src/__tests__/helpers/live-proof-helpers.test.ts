// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { enableLiveNetwork, useLiveNetwork } from "./live-network.js";
import { requireEnv } from "./proof-env.js";

/**
 * The two helpers every live proof stands on. Both fail in the dangerous
 * direction if they break: a fetch swap that does not bypass the suite's
 * interceptor makes the stray-post sweep a no-op, and an env check that passes
 * an empty value lets a proof write to whatever account a vendor defaults to.
 *
 * The network checks talk only to a loopback server this file starts itself.
 */
let srv: Server;
let url: string;

beforeAll(async () => {
  srv = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("real");
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => srv.close(() => resolve()));
});

// This repository's suite installs no request interceptor of its own (its tests stub fetch
// per file), so this file stands one in for the run: a fetch that refuses every request, as
// MSW's `onUnhandledRequest: "error"` does in a host suite. Without it the baseline below
// would have nothing to beat.
let suiteFetch: typeof fetch;
beforeAll(() => {
  suiteFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new TypeError("unhandled request"));
});

afterAll(() => {
  globalThis.fetch = suiteFetch;
});

describe("enableLiveNetwork", () => {
  it("reaches a real server the suite's fetch interceptor would refuse", async () => {
    // The suite-wide interceptor refuses unhandled requests; this is the
    // baseline the helper has to beat, asserted so the test cannot pass
    // vacuously in a harness that mocks nothing.
    await expect(fetch(url)).rejects.toThrow();

    const restore = enableLiveNetwork();
    try {
      const res = await fetch(url);
      expect(await res.text()).toBe("real");
    } finally {
      restore();
    }
  });

  it("puts the previous fetch back", () => {
    const before = globalThis.fetch;
    const restore = enableLiveNetwork();
    expect(globalThis.fetch).not.toBe(before);
    restore();
    expect(globalThis.fetch).toBe(before);
  });
});

describe("useLiveNetwork", () => {
  // Read in a hook, not at collection time: the suite's interceptor replaces
  // fetch in its own beforeAll, after this file is collected.
  let original: typeof fetch;
  const seen: string[] = [];
  beforeAll(() => {
    original = globalThis.fetch;
  });

  describe("inside a proof", () => {
    useLiveNetwork(async () => {
      // The sweep must still have the real network.
      const res = await fetch(url);
      seen.push(await res.text());
    });

    it("has the real network for the tests", async () => {
      const res = await fetch(url);
      expect(await res.text()).toBe("real");
    });
  });

  it("ran the cleanup on the real network, then restored fetch", () => {
    expect(seen).toEqual(["real"]);
    expect(globalThis.fetch).toBe(original);
  });
});

describe("requireEnv", () => {
  const NAMES = ["PROOF_HELPER_TEST_A", "PROOF_HELPER_TEST_B"] as const;

  afterEach(() => {
    for (const n of NAMES) delete process.env[n];
  });

  it("returns every value when all are set", () => {
    process.env.PROOF_HELPER_TEST_A = "a";
    process.env.PROOF_HELPER_TEST_B = "b";
    expect(requireEnv(NAMES)).toEqual({ PROOF_HELPER_TEST_A: "a", PROOF_HELPER_TEST_B: "b" });
  });

  it("names every missing variable in one line, and treats empty as missing", () => {
    process.env.PROOF_HELPER_TEST_A = "";
    expect(() => requireEnv(NAMES)).toThrow(
      "live proof: set PROOF_HELPER_TEST_A, PROOF_HELPER_TEST_B (export them from your own secret store)",
    );
  });
});
