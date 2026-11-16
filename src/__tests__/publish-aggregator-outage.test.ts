import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The regression suite for an aggregator that starts answering 401 to
 * everything (its account deleted, say).
 *
 * ⛔ The failure it guards against: a `connectedAccounts()` that calls the
 * aggregator's `listChannels()` unconditionally and only overlays the direct
 * transports afterwards throws first and takes down publishing for ALL NINE
 * platforms, including ones that publish direct and never touch the
 * aggregator. One `await` decides the blast radius.
 *
 * So the first block pins the property that prevents it: ONE source of routing, and a platform with no route is
 * absent from the map rather than able to throw on everyone else's behalf.
 *
 * The second block covers the other side of the same failure: when a publish
 * breaks before anything is sent, the draft must go back to the status it had,
 * not to `failed`. Autopilot marks `failed` drafts as needing attention and
 * never retries them, so a broken shared dependency would burn an entire
 * night's queue on one run.
 */

vi.mock("../media.js", () => ({
  ensureUploaded: vi.fn(async (asset: { path: string; url?: string }) => {
    asset.url ??= `https://cdn.example.test/${asset.path.split("/").pop()}`;
    return asset;
  }),
}));

import { ensureUploaded } from "../media.js";
import {
  connectedAccounts,
  invalidateConnectedAccounts,
  publishDraft,
  PublishNotSentError,
  PublishPreflightError,
} from "../publish.js";
import { registerTransport, resetTransports } from "../transport.js";
import type { DirectTransport } from "../transport.js";
import type { Draft, MediaAsset } from "../types.js";

const ensureUploadedMock = ensureUploaded as unknown as ReturnType<typeof vi.fn>;

const publishNow = vi.fn(async () => ({ ref: "at://post/1" }));

function blueskyTransport(): DirectTransport {
  return {
    platform: "bluesky",
    channelRules: () => ({ maxLength: 300, countMode: "grapheme" }),
    connectStatus: async () => ({ connected: true, accountId: "did:plc:x", displayName: "examplebrand" }),
    publishNow,
    deletePost: async () => {},
    postFacts: async () => new Map(),
    postUrl: (r: string) => `https://bsky.app/${r}`,
  };
}

function image(): MediaAsset {
  return { path: "/tmp/card.png", type: "image", mimeType: "image/png", size: 1000 };
}

function blueskyDraft(overrides: Partial<Draft> = {}): Draft {
  return {
    id: "d-outage",
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:00.000Z",
    status: "scheduled",
    source: { text: "Body", hashtags: [], media: [image()] },
    targets: ["bluesky"],
    renders: [{ platform: "bluesky", content: "Body", mediaIndices: [0] }],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  invalidateConnectedAccounts();
  resetTransports();
  // The override is what makes a registered transport the ACTIVE route.
  // Registration alone is not routing; see transport.ts.
  process.env.SOCIALMETA_TRANSPORT_OVERRIDES = JSON.stringify({ bluesky: "direct" });
  registerTransport(blueskyTransport());
  publishNow.mockResolvedValue({ ref: "at://post/1" });
});

afterEach(() => {
  resetTransports();
  delete process.env.SOCIALMETA_TRANSPORT_OVERRIDES;
  invalidateConnectedAccounts();
});

describe("routing", () => {
  it("connectedAccounts reports only the routed platforms", async () => {
    const map = await connectedAccounts();
    expect(map.bluesky).toEqual({ accountId: "did:plc:x", displayName: "examplebrand" });
    // Nothing else has a route, so nothing else is claimed connected. If an
    // aggregator's channels landed here too, its 401 would throw before the
    // direct overlay ran and take Bluesky down with it.
    expect(Object.keys(map)).toEqual(["bluesky"]);
  });

  it("publishes a direct-only draft end to end", async () => {
    const d = blueskyDraft();
    const result = await publishDraft(d, { now: true });
    expect(publishNow).toHaveBeenCalledTimes(1);
    expect(result.sent.map((s) => s.platform)).toEqual(["bluesky"]);
    expect(d.status).toBe("published");
  });

  it("refuses a draft whose only target has no route", async () => {
    // Degrading is not the same as pretending. A facebook-only draft has no
    // route here, and must say so in words the operator can act on rather than
    // silently publishing nothing.
    const d = blueskyDraft({
      targets: ["facebook"],
      renders: [{ platform: "facebook", content: "Body", mediaIndices: [0] }],
    });
    await expect(publishDraft(d, { now: true })).rejects.toThrow(PublishPreflightError);
    expect(publishNow).not.toHaveBeenCalled();
  });
});

describe("PublishNotSentError", () => {
  it("is raised, not a bare error, when the publish breaks before any send", async () => {
    // Media upload is the realistic case: it runs after preflight and before
    // the first vendor call, and it depends on a host that can be down on its
    // own.
    ensureUploadedMock.mockRejectedValueOnce(new Error("asset upload failed"));
    const err = await publishDraft(blueskyDraft(), { now: true }).catch((e) => e);
    expect(err).toBeInstanceOf(PublishNotSentError);
    expect((err as PublishNotSentError).cause).toBeInstanceOf(Error);
    expect(publishNow).not.toHaveBeenCalled();
  });

  it("carries a plain-object rejection's message, not [object Object]", async () => {
    // Not every dependency rejects with an Error. The inline ternary this
    // message used to come from rendered this case as "[object Object]".
    const cause = { message: "asset bucket unreachable", code: "ECONNRESET" };
    ensureUploadedMock.mockRejectedValueOnce(cause);
    const err = await publishDraft(blueskyDraft(), { now: true }).catch((e) => e);
    expect(err).toBeInstanceOf(PublishNotSentError);
    expect((err as PublishNotSentError).message).toBe("asset bucket unreachable");
    expect((err as PublishNotSentError).cause).toBe(cause);
  });

  it("is NOT raised once a transport has been entered, so a sent post is never retried", async () => {
    // publishNow's own failures are caught per leg and recorded as `pending`;
    // nothing escapes. The guard that matters is that `dispatched` is set
    // BEFORE the call, so any later throw stays a real failure.
    publishNow.mockRejectedValueOnce(new Error("bluesky 500"));
    const d = blueskyDraft();
    await expect(publishDraft(d, { now: true })).resolves.toBeTruthy();
    expect(d.lastError).toContain("bluesky");
  });

  it("leaves a PublishPreflightError alone", async () => {
    // Preflight refusals carry an operator-readable message and already have a
    // caller contract; wrapping them would swallow it.
    const d = blueskyDraft({ providerPostId: "already-sent" });
    const err = await publishDraft(d, { now: true }).catch((e) => e);
    expect(err).toBeInstanceOf(PublishPreflightError);
    expect(err).not.toBeInstanceOf(PublishNotSentError);
  });
});
