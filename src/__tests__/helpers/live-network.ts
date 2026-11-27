// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Real network access for the live proofs, without knowing how the host test
 * setup mocks HTTP.
 *
 * A test harness commonly installs a request interceptor for the whole suite
 * (MSW's `setupServer` with `onUnhandledRequest: "error"` is the usual one). It
 * works by replacing `globalThis.fetch`, so every vendor call a proof makes
 * would be refused as unhandled, and the refusal reads like a vendor error
 * rather than a harness one. The proofs need the opposite: every call must go
 * to the real vendor.
 *
 * So for the duration of a proof file `globalThis.fetch` is swapped for
 * undici's `fetch`, which opens its own sockets and is not the function any
 * fetch interceptor patched. Every engine module calls `fetch` at request time
 * (none captures it at import), so the swap reaches all of them. This needs no
 * handle on the host's mock server and no per-host passthrough list: a
 * passthrough list is the thing that silently goes stale when a vendor moves
 * an endpoint to a new host.
 *
 * ⛔ THE SWEEP RUNS BEFORE THE RESTORE, IN THE SAME HOOK. Stray-post cleanup
 * (helpers/proof-artifacts.ts) runs in `afterAll`, and a cleanup DELETE sent
 * after the interceptor is back in place is refused, leaving the post live.
 * `useLiveNetwork(cleanup)` therefore runs `cleanup` first and restores fetch
 * only afterwards, whatever order the runner gives separate hooks.
 */
import { afterAll, beforeAll } from "vitest";
import { fetch as undiciFetch } from "undici";

/** Swap in a real-network fetch. Returns the function that puts the previous one back. */
export function enableLiveNetwork(): () => void {
  const previous = globalThis.fetch;
  globalThis.fetch = undiciFetch as unknown as typeof fetch;
  return () => {
    globalThis.fetch = previous;
  };
}

/**
 * Register at the top of a gated `describe`: real network from `beforeAll`
 * until `afterAll`, with `cleanup` (normally `artifacts.sweep`) run while the
 * real network is still in place.
 */
export function useLiveNetwork(cleanup?: () => Promise<void>): void {
  let restore: (() => void) | undefined;
  beforeAll(() => {
    restore = enableLiveNetwork();
  });
  afterAll(async () => {
    try {
      await cleanup?.();
    } finally {
      restore?.();
    }
  });
}
