// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The window between the connected-accounts sweep and the per-platform route
 * lookup in `fetchChannelRules`. The two are separate awaits, and the route
 * reads live settings, so a platform can be switched off (or its transport
 * unregistered) after the sweep reported it connected. It must then drop out
 * of the snapshot, not throw on a null route and lose every other platform's
 * limits with it.
 *
 * `connectedAccounts` is mocked because the only honest way to open that
 * window deterministically is to have the sweep and the route disagree.
 */
const h = vi.hoisted(() => ({ connectedAccounts: vi.fn() }));

vi.mock("../publish.js", async (importActual) => ({
  ...(await importActual<typeof import("../publish.js")>()),
  connectedAccounts: h.connectedAccounts,
}));

import { fetchChannelRules } from "../channel-rules.js";
import { registerTransport, resetTransports, type DirectTransport } from "../transport.js";
import type { Platform } from "../types.js";

function transport(platform: Platform, maxLength: number): DirectTransport {
  return {
    platform,
    channelRules: () => ({ maxLength, countMode: "utf16" }),
    connectStatus: async () => ({ connected: true, accountId: `${platform}-1`, displayName: platform }),
    publishNow: async () => ({ ref: "x" }),
    deletePost: async () => {},
    postFacts: async () => new Map(),
    postUrl: (r: string) => `https://example.test/${r}`,
  };
}

beforeEach(() => {
  resetTransports();
  vi.stubEnv("SOCIALMETA_TRANSPORT_OVERRIDES", JSON.stringify({ twitter: "direct", reddit: "direct" }));
});

afterEach(() => {
  resetTransports();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("fetchChannelRules when the route disappears after the sweep", () => {
  it("skips a platform the sweep called connected but that no longer routes", async () => {
    registerTransport(transport("twitter", 4000));
    // Reddit is reported connected by the sweep, but nothing is registered for
    // it any more, so its route resolves to nothing.
    h.connectedAccounts.mockResolvedValue({
      twitter: { accountId: "twitter-1", displayName: "twitter" },
      reddit: { accountId: "reddit-1", displayName: "reddit" },
    });

    const { snapshot, failures } = await fetchChannelRules(() => new Date("2026-09-24T00:00:00.000Z"));

    expect(Object.keys(snapshot.channels)).toEqual(["twitter"]);
    expect(snapshot.channels.twitter).toEqual({ platform: "twitter", maxLength: 4000, countMode: "utf16" });
    expect(failures).toEqual([]);
    expect(h.connectedAccounts).toHaveBeenCalledWith({ fresh: true });
  });

  it("stamps the snapshot with the real clock when no clock is injected", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-24T12:34:56.000Z"));
    h.connectedAccounts.mockResolvedValue({});

    const { snapshot } = await fetchChannelRules();

    expect(snapshot.fetchedAt).toBe("2026-09-24T12:34:56.000Z");
    expect(snapshot.channels).toEqual({});
  });
});
