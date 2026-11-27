// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * publishDraft's guards and bookkeeping.
 *
 * ⚠️ This suite asserts nothing about an aggregator's WIRE FORMAT (the
 * `posts[].value[]` chain, `settings.who_can_reply_post`,
 * `shortLink:false`, `type: "now" | "schedule" | "draft"`, the comma-joined id
 * extraction from its response). None of that is sent to anything: a direct
 * transport takes a render, its media and a `PublishDestination`, and each
 * transport's own suite covers its own payload.
 *
 * What is covered here is what publishDraft itself owns: the
 * terminal-state guard that stops a double publish, the connected/skipped
 * arithmetic, `at` validation happening BEFORE anything is sent, and the status
 * bookkeeping that decides whether a draft is `published` or left `scheduled`.
 */

vi.mock("../media.js", () => ({
  ensureUploaded: vi.fn(async (asset: { path: string; url?: string }) => {
    asset.url ??= `https://cdn.example.test/${asset.path.split("/").pop()}`;
    return asset;
  }),
}));

import {
  connectedAccounts,
  invalidateConnectedAccounts,
  publishDraft,
  PublishPreflightError,
} from "../publish.js";
import { registerAggregator, registerTransport, resetTransports } from "../transport.js";
import type { Aggregator } from "../transport.js";
import type { DirectTransport } from "../transport.js";
import type { Draft, MediaAsset, Platform, PlatformRender } from "../types.js";

// Typed to the DirectTransport members rather than left to inference. Inferred
// from the default implementations alone these lock to `{ref: string}` and
// `{connected, accountId, displayName}`, so a later mockResolvedValue carrying
// `threadRoot`/`queued` or a `reason` is rejected, and `publishNow.mock.calls`
// infers as a zero-length tuple.
const publishNow = vi.fn<DirectTransport["publishNow"]>(async () => ({ ref: "post-1" }));
const connectStatus = vi.fn<DirectTransport["connectStatus"]>(async () => ({
  connected: true,
  accountId: "acct-1",
  displayName: "Acme",
}));

function fakeTransport(platform: Platform): DirectTransport {
  return {
    platform,
    channelRules: () => ({ maxLength: 5000, countMode: "utf16" }),
    connectStatus,
    publishNow,
    deletePost: async () => {},
    postFacts: async () => new Map(),
    postUrl: (r: string) => `https://example.test/${r}`,
  };
}

function render(overrides: Partial<PlatformRender> & { platform: Platform }): PlatformRender {
  return { content: "hello", mediaIndices: [], ...overrides };
}

function image(): MediaAsset {
  return { path: "/tmp/a.jpg", type: "image", mimeType: "image/jpeg", size: 1000 };
}

function draft(overrides: Partial<Draft> = {}): Draft {
  return {
    id: "d1",
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:00.000Z",
    status: "draft",
    source: { text: "Body text", hashtags: [], media: [] },
    targets: [],
    renders: [],
    ...overrides,
  };
}

/** An ISO time comfortably in the future, so the `at` guard passes. */
const FUTURE = new Date(Date.now() + 3_600_000).toISOString();

beforeEach(() => {
  vi.clearAllMocks();
  invalidateConnectedAccounts();
  resetTransports();
  publishNow.mockResolvedValue({ ref: "post-1" });
  connectStatus.mockResolvedValue({ connected: true, accountId: "acct-1", displayName: "Acme" });
  process.env.SOCIALMETA_TRANSPORT_OVERRIDES = JSON.stringify({
    bluesky: "direct",
    facebook: "direct",
  });
  registerTransport(fakeTransport("bluesky"));
  registerTransport(fakeTransport("facebook"));
});

afterEach(() => {
  resetTransports();
  delete process.env.SOCIALMETA_TRANSPORT_OVERRIDES;
  invalidateConnectedAccounts();
});

describe("connectedAccounts caching", () => {
  it("serves a second call from cache instead of re-asking every vendor", async () => {
    await connectedAccounts();
    await connectedAccounts();
    // Two platforms, one round of connectStatus calls.
    expect(connectStatus).toHaveBeenCalledTimes(2);
  });

  it("re-asks when the caller wants a fresh map", async () => {
    await connectedAccounts();
    await connectedAccounts({ fresh: true });
    expect(connectStatus).toHaveBeenCalledTimes(4);
  });

  it("publishDraft always reads a fresh map even when one is cached", async () => {
    // Publishing against a stale map could target an account that has since
    // been disconnected, and one extra round trip is irrelevant next to the
    // cost of a misdirected post.
    await connectedAccounts();
    connectStatus.mockClear();
    await publishDraft(draft({ renders: [render({ platform: "bluesky" })] }), { now: true });
    expect(connectStatus).toHaveBeenCalled();
  });

  it("omits a platform whose transport reports it disconnected", async () => {
    connectStatus.mockResolvedValue({
      connected: false,
      accountId: "",
      displayName: "",
      reason: "token expired",
    });
    expect(await connectedAccounts()).toEqual({});
  });

  it("omits a platform whose transport THROWS, rather than failing the whole map", async () => {
    // One unreachable vendor must not stop a publish to the other eight. The
    // platform lands in `skipped`, which an operator can act on, instead of a
    // stack trace. Without this property one dead vendor takes down all nine
    // platforms.
    connectStatus.mockRejectedValue(new Error("vendor 500"));
    expect(await connectedAccounts()).toEqual({});
  });
});

describe("publishDraft guards", () => {
  it("refuses to send a draft that already has a providerPostId", async () => {
    // Without this a second publish creates a SECOND real post and overwrites
    // providerPostId with its id, leaving the first live and unreachable from
    // this system.
    const d = draft({
      renders: [render({ platform: "bluesky" })],
      status: "scheduled",
      providerPostId: "bluesky:already",
    });
    await expect(publishDraft(d, { now: true })).rejects.toThrow(PublishPreflightError);
    await expect(publishDraft(d, { now: true })).rejects.toThrow(/already sent/);
    expect(publishNow).not.toHaveBeenCalled();
    expect(d.providerPostId).toBe("bluesky:already");
  });

  it("throws when none of the target platforms are connected", async () => {
    const d = draft({ renders: [render({ platform: "linkedin" })] });
    await expect(publishDraft(d, { now: true })).rejects.toThrow(
      /none of the target platforms are connected/,
    );
  });

  it("throws when some platforms are unroutable and skipUnconnected is not set", async () => {
    const d = draft({
      renders: [render({ platform: "bluesky" }), render({ platform: "linkedin" })],
    });
    await expect(publishDraft(d, { now: true })).rejects.toThrow(/platforms not connected: linkedin/);
    expect(publishNow).not.toHaveBeenCalled();
  });

  it("proceeds and reports skipped platforms when skipUnconnected is set", async () => {
    const d = draft({
      renders: [render({ platform: "bluesky" }), render({ platform: "linkedin" })],
    });
    const res = await publishDraft(d, { now: true, skipUnconnected: true });
    expect(res.sent.map((s) => s.platform)).toEqual(["bluesky"]);
    expect(res.skipped).toEqual(["linkedin"]);
  });

  it("rejects an unparseable or past scheduled time BEFORE anything is sent", async () => {
    // This used to flow through unchecked and was only assigned to the draft
    // afterwards, so a malformed value created a real scheduled post and then
    // blew up on persistence, leaving a live post with no local record of it.
    const d = draft({ renders: [render({ platform: "bluesky" })] });
    await expect(publishDraft(d, { at: "not-a-date" })).rejects.toThrow(/not a valid datetime/);
    await expect(publishDraft(d, { at: "2020-01-01T00:00:00.000Z" })).rejects.toThrow(
      /must be in the future/,
    );
    expect(publishNow).not.toHaveBeenCalled();
  });

  it("throws when neither now nor at is set", async () => {
    const d = draft({ renders: [render({ platform: "bluesky" })] });
    await expect(publishDraft(d, {})).rejects.toThrow(/needs --now or --at/);
  });

  it("refuses both now and at, before anything is uploaded or sent", async () => {
    const { ensureUploaded } = await import("../media.js");
    const d = draft({
      source: { text: "Body", hashtags: [], media: [image()] },
      renders: [render({ platform: "bluesky", mediaIndices: [0] })],
    });
    await expect(publishDraft(d, { now: true, at: FUTURE })).rejects.toThrow(
      /either --now or --at, not both/,
    );
    expect(ensureUploaded).not.toHaveBeenCalled();
    expect(publishNow).not.toHaveBeenCalled();
  });
});

describe("publishDraft bookkeeping", () => {
  it("now + every leg terminal => published, with publishedAt and the encoded ids", async () => {
    const d = draft({
      renders: [render({ platform: "bluesky" }), render({ platform: "facebook" })],
    });
    const res = await publishDraft(d, { now: true });
    expect(d.status).toBe("published");
    expect(d.publishedAt).toBeTruthy();
    expect(res.providerPostId).toBe("bluesky:post-1,facebook:post-1");
    expect(d.lastError).toBeUndefined();
  });

  it("at => a leg its own preflight refuses is RECORDED at schedule time, not thrown for the whole draft", async () => {
    // Bluesky cannot publish video. The `now` path refuses that leg alone; the
    // scheduled path used to say nothing until the release ring tried it.
    const d = draft({
      source: {
        text: "Body",
        hashtags: [],
        media: [{ path: "/tmp/v.mp4", type: "video", mimeType: "video/mp4", size: 5000, durationSec: 10 }],
      },
      renders: [render({ platform: "bluesky", mediaIndices: [0] }), render({ platform: "facebook" })],
    });
    const res = await publishDraft(d, { at: FUTURE });
    expect(d.status).toBe("scheduled");
    expect(res.providerPostId).toBe("bluesky:pending,facebook:pending");
    expect(d.lastError).toMatch(/^bluesky: Bluesky cannot publish video yet/);
    expect(d.lastError).not.toContain("facebook");
    expect(publishNow).not.toHaveBeenCalled();
  });

  it("at => scheduled, with every leg pending for the release ring", async () => {
    const d = draft({ renders: [render({ platform: "bluesky" })] });
    const res = await publishDraft(d, { at: FUTURE });
    expect(d.status).toBe("scheduled");
    expect(d.scheduledFor).toBe(new Date(FUTURE).toISOString());
    expect(res.providerPostId).toBe("bluesky:pending");
    expect(publishNow).not.toHaveBeenCalled();
  });

  it("a failing leg becomes pending and is RECORDED, never lost", async () => {
    // Nothing throws out of the per-leg loop: a vendor failing must not cost
    // the legs that already went out, and there is no state in which a leg is
    // both un-sent and forgotten.
    publishNow
      .mockResolvedValueOnce({ ref: "post-ok" })
      .mockRejectedValueOnce(new Error("facebook 500"));
    const d = draft({
      renders: [render({ platform: "bluesky" }), render({ platform: "facebook" })],
    });
    const res = await publishDraft(d, { now: true });

    expect(res.providerPostId).toBe("bluesky:post-ok,facebook:pending");
    expect(d.lastError).toContain("facebook");
    // NOT published: a pending leg must stay visible to the reconcile, which
    // only scans `scheduled` and `publishing`.
    expect(d.status).toBe("scheduled");
  });

  it("uploads each selected source asset before publishing", async () => {
    const d = draft({
      source: { text: "Body", hashtags: [], media: [image()] },
      renders: [render({ platform: "bluesky", mediaIndices: [0] })],
    });
    await publishDraft(d, { now: true });
    expect(d.source.media[0]!.url).toContain("https://cdn.example.test/");
    expect(publishNow).toHaveBeenCalledWith(
      expect.objectContaining({ media: [expect.objectContaining({ url: expect.any(String) })] }),
    );
  });

  it("uploads only the assets a sendable render selected, never the rest", async () => {
    // A skipped (unconnected) render's selection is not uploaded either.
    connectStatus.mockImplementation(async () => ({ connected: true, accountId: "acct-1", displayName: "Acme" }));
    const { ensureUploaded } = await import("../media.js");
    const d = draft({
      source: {
        text: "Body",
        hashtags: [],
        media: [
          { ...image(), path: "/tmp/a.jpg" },
          { ...image(), path: "/tmp/b.jpg" },
          { ...image(), path: "/tmp/c.jpg" },
          { ...image(), path: "/tmp/d.jpg" },
        ],
      },
      renders: [
        render({ platform: "bluesky", mediaIndices: [2] }),
        render({ platform: "facebook", mediaIndices: [2, 0] }),
        render({ platform: "linkedin", mediaIndices: [3] }),
      ],
    });
    await publishDraft(d, { now: true, skipUnconnected: true });
    const uploaded = (ensureUploaded as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => (c[0] as MediaAsset).path,
    );
    expect(uploaded.sort()).toEqual(["/tmp/a.jpg", "/tmp/c.jpg"]);
    expect(d.source.media[1]!.url).toBeUndefined();
    expect(d.source.media[3]!.url).toBeUndefined();
  });

  it("hands the transport only the assets its render selected", async () => {
    const d = draft({
      source: {
        text: "Body",
        hashtags: [],
        media: [image(), { ...image(), path: "/tmp/b.jpg" }],
      },
      renders: [render({ platform: "bluesky", mediaIndices: [1] })],
    });
    await publishDraft(d, { now: true });
    const passed = publishNow.mock.calls[0]![0] as { media: MediaAsset[] };
    expect(passed.media).toHaveLength(1);
    expect(passed.media[0]!.path).toBe("/tmp/b.jpg");
  });

  // SPECS.bluesky.publishesVideo is false. The leg is refused before its
  // transport is called (Bluesky's used to drop the video and post text-only),
  // while the sibling leg still goes out.
  it("refuses a leg that selects a video its platform cannot publish, and sends the rest", async () => {
    const clip: MediaAsset = { path: "/tmp/clip.mp4", type: "video", mimeType: "video/mp4", size: 4_000_000 };
    const d = draft({
      source: { text: "Body", hashtags: [], media: [image(), clip] },
      renders: [render({ platform: "bluesky", mediaIndices: [1] }), render({ platform: "facebook", mediaIndices: [0] })],
    });
    const res = await publishDraft(d, { now: true });

    expect(publishNow).toHaveBeenCalledTimes(1);
    expect((publishNow.mock.calls[0]![0] as { render: PlatformRender }).render.platform).toBe("facebook");
    expect(res.providerPostId).toBe("bluesky:pending,facebook:post-1");
    expect(d.lastError).toContain("bluesky: Bluesky cannot publish video yet");
  });

  it("reports sent as platform + accountId for each leg that went out", async () => {
    const d = draft({
      renders: [render({ platform: "bluesky" }), render({ platform: "facebook" })],
    });
    const res = await publishDraft(d, { now: true });
    expect(res.sent).toEqual([
      { platform: "bluesky", accountId: "acct-1" },
      { platform: "facebook", accountId: "acct-1" },
    ]);
    expect(res.skipped).toEqual([]);
  });
});

/**
 * Publishing through an aggregator.
 *
 * ⛔ THE SCHEDULED BRANCH IS THE DANGEROUS ONE. It used to write
 * `directStateEntry(platform, "pending")` with no route lookup at all, which
 * could not fire while `sendable` required a direct transport — but the moment
 * connectedAccounts learned about aggregators, an aggregator-routed platform
 * became sendable and the leg was stamped direct-shaped. publish-due then
 * releases a direct-shaped leg through `registeredTransportFor`, i.e. our own
 * Reddit app, whose API application was rejected twice. And `!opts.now` is the
 * cadence/autopilot path, which is most of the volume.
 */
describe("publishing to an aggregator-routed platform", () => {
  const aggPublish = vi.fn(async () => ({ ref: "zp_1~t3_abc" }));

  function fakeAggregator(): Aggregator {
    return {
      id: "zernio",
      platforms: () => ["reddit"],
      channelRules: () => ({ maxLength: 40000, countMode: "utf16" }),
      connectStatus: async () => ({ connected: true, accountId: "acc_1", displayName: "u/examplebrand" }),
      publishNow: aggPublish,
      deletePost: async () => {},
      postFacts: async () => new Map(),
      postUrl: (_p, ref) => `https://example.test/${ref}`,
    };
  }

  beforeEach(() => {
    aggPublish.mockClear();
    aggPublish.mockResolvedValue({ ref: "zp_1~t3_abc" });
    registerAggregator(fakeAggregator());
    process.env.SOCIALMETA_TRANSPORT_OVERRIDES = JSON.stringify({
      bluesky: "direct",
      reddit: "aggregator:zernio",
    });
    invalidateConnectedAccounts();
  });

  it("reports an aggregator-held platform as connected", async () => {
    const map = await connectedAccounts({ fresh: true });
    expect(map.reddit).toMatchObject({ accountId: "acc_1" });
  });

  it("stamps an immediate leg with via:<id>, not the bare platform", async () => {
    const d = draft({
      targets: ["reddit"],
      renders: [render({ platform: "reddit", subreddit: "smallbusiness" })],
    });

    await publishDraft(d, { now: true });

    expect(aggPublish).toHaveBeenCalledOnce();
    expect(d.providerPostId).toBe("via:zernio:reddit:zp_1~t3_abc");
  });

  /**
   * ⛔ The row this whole phase exists for. A direct-shaped `reddit:pending`
   * here is released later through our own Reddit app.
   */
  it("stamps a SCHEDULED leg with via:<id> too", async () => {
    const d = draft({
      targets: ["reddit"],
      renders: [render({ platform: "reddit", subreddit: "smallbusiness" })],
    });

    await publishDraft(d, { at: FUTURE });

    expect(aggPublish).not.toHaveBeenCalled();
    expect(d.providerPostId).toBe("via:zernio:reddit:pending");
    expect(d.status).toBe("scheduled");
  });

  it("stamps a FAILED leg with via:<id>, so the retry goes back to the same route", async () => {
    aggPublish.mockRejectedValue(new Error("subreddit requires flair"));
    const d = draft({
      targets: ["reddit"],
      renders: [render({ platform: "reddit", subreddit: "smallbusiness" })],
    });

    await publishDraft(d, { now: true });

    expect(d.providerPostId).toBe("via:zernio:reddit:pending");
    expect(d.lastError).toMatch(/flair/);
  });

  it("keeps direct and aggregator legs apart on one draft", async () => {
    const d = draft({
      targets: ["bluesky", "reddit"],
      renders: [
        render({ platform: "bluesky" }),
        render({ platform: "reddit", subreddit: "smallbusiness" }),
      ],
    });

    await publishDraft(d, { now: true });

    const legs = (d.providerPostId ?? "").split(",");
    expect(legs).toContain("bluesky:post-1");
    expect(legs).toContain("via:zernio:reddit:zp_1~t3_abc");
  });

  /**
   * ⛔ REFUSING BEATS FALLING BACK. A mode naming a vendor nothing registered is
   * `aggregator-ambiguous`, so the platform is absent from `connectedAccounts`
   * and never reaches a transport. Publishing it through the platform's own API
   * instead would send the post from an account the operator did not choose.
   */
  it("refuses outright when the named aggregator is not the registered one", async () => {
    process.env.SOCIALMETA_TRANSPORT_OVERRIDES = JSON.stringify({
      reddit: "aggregator:ayrshare",
    });
    invalidateConnectedAccounts();
    const d = draft({
      targets: ["reddit"],
      renders: [render({ platform: "reddit", subreddit: "smallbusiness" })],
    });

    // Reddit is the only target and it has no route, so there is nothing to send.
    await expect(publishDraft(d, { now: true })).rejects.toThrow(PublishPreflightError);
    expect(aggPublish).not.toHaveBeenCalled();
    expect(d.providerPostId).toBeUndefined();
  });

  it("skips the unrouted platform and still publishes the others", async () => {
    process.env.SOCIALMETA_TRANSPORT_OVERRIDES = JSON.stringify({
      bluesky: "direct",
      reddit: "aggregator:ayrshare",
    });
    invalidateConnectedAccounts();
    const d = draft({
      targets: ["bluesky", "reddit"],
      renders: [
        render({ platform: "bluesky" }),
        render({ platform: "reddit", subreddit: "smallbusiness" }),
      ],
    });

    // `skipUnconnected` is required for a PARTIAL publish: without it, an
    // unrouted target refuses the whole draft rather than quietly dropping a leg.
    const result = await publishDraft(d, { now: true, skipUnconnected: true });

    expect(aggPublish).not.toHaveBeenCalled();
    expect(result.skipped).toContain("reddit");
    expect(d.providerPostId).toBe("bluesky:post-1");
  });
});

/**
 * Deferred replies on the INLINE path.
 *
 * ⛔ A PRE-EXISTING SILENT DATA LOSS. `transport.publishNow` returns `queued`
 * and `threadRoot` whenever a render carries a follow-up delay: the root goes
 * out immediately and the rest of the chain comes back to be released later.
 * publish-due persists both when IT releases a leg, but the inline (`--now`)
 * path had nowhere to put them and dropped them on the floor.
 *
 * The result was a thread that published its first item and lost every reply
 * after it, with nothing reporting anything — the draft settled as `published`
 * because every leg was terminal. Only the scheduled path ever worked.
 */
describe("thread replies deferred by a follow-up delay", () => {
  const QUEUED = [
    { position: 1, text: "second", dueAt: FUTURE, parent: { uri: "at://root" } },
  ];

  beforeEach(() => {
    publishNow.mockResolvedValue({
      ref: "post-1",
      threadRoot: { uri: "at://root", cid: "cid1" },
      queued: QUEUED,
    });
  });

  it("returns the chain so the caller can persist it", async () => {
    const d = draft({ targets: ["bluesky"], renders: [render({ platform: "bluesky" })] });

    const result = await publishDraft(d, { now: true });

    expect(result.threads).toEqual([
      { platform: "bluesky", root: { uri: "at://root", cid: "cid1" }, queued: QUEUED },
    ]);
  });

  it("still records the root leg as live", async () => {
    const d = draft({ targets: ["bluesky"], renders: [render({ platform: "bluesky" })] });

    await publishDraft(d, { now: true });

    expect(d.providerPostId).toBe("bluesky:post-1");
  });

  it("returns the replies an inline thread posted, so the caller can record them", async () => {
    publishNow.mockResolvedValue({ ref: "post-1", replyRefs: ["at://r1", "at://r2"] });
    const d = draft({ targets: ["bluesky"], renders: [render({ platform: "bluesky" })] });

    const result = await publishDraft(d, { now: true });

    expect(result.threads).toEqual([
      {
        platform: "bluesky",
        queued: [],
        done: [
          { position: 1, ref: "at://r1" },
          { position: 2, ref: "at://r2" },
        ],
      },
    ]);
  });

  it("returns an inline thread whose first reply failed as a chain with no replies", async () => {
    publishNow.mockResolvedValue({ ref: "post-1", replyRefs: [] });
    const d = draft({ targets: ["bluesky"], renders: [render({ platform: "bluesky" })] });

    const result = await publishDraft(d, { now: true });

    expect(result.threads).toEqual([{ platform: "bluesky", queued: [], done: [] }]);
  });

  it("reports nothing when the transport queued nothing", async () => {
    publishNow.mockResolvedValue({ ref: "post-1" });
    const d = draft({ targets: ["bluesky"], renders: [render({ platform: "bluesky" })] });

    const result = await publishDraft(d, { now: true });

    expect(result.threads).toEqual([]);
  });

  it("keeps each platform's chain separate", async () => {
    const d = draft({
      targets: ["bluesky", "facebook"],
      renders: [render({ platform: "bluesky" }), render({ platform: "facebook" })],
    });

    const result = await publishDraft(d, { now: true });

    expect(result.threads.map((t) => t.platform).sort()).toEqual(["bluesky", "facebook"]);
  });

  /**
   * The scheduled path never contacts a transport, so there is no chain to
   * report — publish-due picks it up when it releases the leg.
   */
  it("reports no chain on the scheduled path, where nothing was sent", async () => {
    const d = draft({ targets: ["bluesky"], renders: [render({ platform: "bluesky" })] });

    const result = await publishDraft(d, { at: FUTURE });

    expect(publishNow).not.toHaveBeenCalled();
    expect(result.threads).toEqual([]);
  });
});

/**
 * Concurrency, and the three things it must not cost.
 *
 * The connect sweep and the per-leg dispatch both used to run strictly end to
 * end, so a nine-platform publish paid the SUM of nine vendor latencies twice
 * over. Running them together is only safe while the ordering the callers read
 * out (the map's key order, the leg order inside `providerPostId`), the
 * per-vendor rate limit, and the per-leg failure isolation all survive — which
 * is what this block pins.
 *
 * Every case here drives ordering through a deferred promise rather than a
 * timer: a `setTimeout` would pass on a slow CI runner by accident.
 */
describe("publishing concurrently", () => {
  /** A promise plus the handle to settle it, for driving interleaving by hand. */
  function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  it("asks every platform for its status at once, not one after another", async () => {
    // Both transports must be INSIDE connectStatus before either is allowed to
    // answer. Under the old serial loop the second call never happens until the
    // first resolves, so this deadlocks rather than failing an assertion — which
    // is the strongest form the assertion can take.
    const entered: Platform[] = [];
    const gate = deferred<void>();
    connectStatus.mockImplementation(async () => {
      entered.push(entered.length === 0 ? "bluesky" : "facebook");
      if (entered.length === 2) gate.resolve();
      await gate.promise;
      return { connected: true, accountId: "acct-1", displayName: "Acme" };
    });

    const map = await connectedAccounts({ fresh: true });

    expect(entered).toHaveLength(2);
    // ⛔ ORDERING IS THE MAP'S, NOT THE VENDORS'. The results are collected
    // positionally and folded in afterwards, so whichever vendor answers first
    // cannot reorder the keys the publish path reads `skipped` out of.
    expect(Object.keys(map)).toEqual(["facebook", "bluesky"]);
  });

  it("shares one sweep between two callers that overlap, and still re-sweeps later", async () => {
    // A publish and the channel-rules refresh both ask for a fresh map. Joining
    // a sweep already underway is a single-flight, NOT a second cache: it is
    // dropped the moment the sweep settles, so the deliberate `fresh` bypass is
    // untouched across ticks.
    const [a, b] = await Promise.all([
      connectedAccounts({ fresh: true }),
      connectedAccounts({ fresh: true }),
    ]);
    expect(connectStatus).toHaveBeenCalledTimes(2); // two platforms, ONE sweep
    expect(a).toEqual(b);

    connectStatus.mockClear();
    await connectedAccounts({ fresh: true });
    expect(connectStatus).toHaveBeenCalledTimes(2); // a later tick sweeps again
  });

  it("does not hand a sweep started before an invalidate to a caller that arrives after it", async () => {
    // ⛔ THE ROUTING CHANGED UNDER IT. `invalidateConnectedAccounts` is what the
    // OAuth connect flow calls, so a sweep already in flight was built against
    // the routing the operator has just replaced. Joining it would report the
    // account they just connected as absent, which reads as a broken connect.
    const gate = deferred<void>();
    connectStatus.mockImplementation(async () => {
      await gate.promise;
      return { connected: true, accountId: "acct-1", displayName: "Acme" };
    });

    const first = connectedAccounts({ fresh: true });
    invalidateConnectedAccounts();
    const second = connectedAccounts({ fresh: true });
    gate.resolve();
    await Promise.all([first, second]);

    // Two sweeps of two platforms, not one shared sweep.
    expect(connectStatus).toHaveBeenCalledTimes(4);
  });

  it("still reports a throwing vendor as disconnected when the sweep is parallel", async () => {
    // `Promise.all` is only safe here because nothing inside can reject. One
    // unreachable vendor must land in `skipped`, not take the other eight down.
    connectStatus.mockImplementation(async () => {
      throw new Error("vendor 500");
    });
    expect(await connectedAccounts({ fresh: true })).toEqual({});
  });

  it("publishes legs on DIFFERENT routes at the same time", async () => {
    const entered: Platform[] = [];
    const gate = deferred<void>();
    publishNow.mockImplementation(async (input) => {
      entered.push(input.render.platform);
      if (entered.length === 2) gate.resolve();
      await gate.promise;
      return { ref: `post-${input.render.platform}` };
    });

    const d = draft({
      renders: [render({ platform: "bluesky" }), render({ platform: "facebook" })],
    });
    await publishDraft(d, { now: true });

    expect(entered.sort()).toEqual(["bluesky", "facebook"]);
    // ⛔ POSITIONAL REASSEMBLY. The legs are written into one slot each and
    // joined in render order afterwards, so the column does not depend on which
    // vendor answered first.
    expect(d.providerPostId).toBe("bluesky:post-bluesky,facebook:post-facebook");
  });

  it("keeps the leg order of the RENDERS even when the first leg answers last", async () => {
    const slow = deferred<{ ref: string }>();
    publishNow.mockImplementation(async (input) => {
      if (input.render.platform === "bluesky") return slow.promise;
      slow.resolve({ ref: "post-slow" });
      return { ref: "post-fast" };
    });

    const d = draft({
      renders: [render({ platform: "bluesky" }), render({ platform: "facebook" })],
    });
    const res = await publishDraft(d, { now: true });

    expect(res.providerPostId).toBe("bluesky:post-slow,facebook:post-fast");
    expect(res.sent.map((s) => s.platform)).toEqual(["bluesky", "facebook"]);
  });

  it("isolates a failing leg from a concurrent sibling, and records it in render order", async () => {
    // Keyed on the platform rather than on call order, because with the legs in
    // flight together `mockRejectedValueOnce` no longer names a specific leg.
    publishNow.mockImplementation(async (input) => {
      if (input.render.platform === "facebook") throw new Error("facebook 500");
      return { ref: "post-ok" };
    });

    const d = draft({
      renders: [render({ platform: "bluesky" }), render({ platform: "facebook" })],
    });
    await publishDraft(d, { now: true });

    expect(d.providerPostId).toBe("bluesky:post-ok,facebook:pending");
    expect(d.lastError).toBe("facebook: facebook 500");
    expect(d.status).toBe("scheduled");
  });

  it("puts a live leg's post-live warning in lastError, prefixed by its platform, and keeps the leg live", async () => {
    // A failed Facebook first comment used to reach only console.warn.
    publishNow.mockImplementation(async (input) =>
      input.render.platform === "facebook"
        ? { ref: "fb-live", warnings: ["first comment failed: (#200) nope"] }
        : { ref: "post-ok" },
    );

    const d = draft({
      renders: [render({ platform: "bluesky" }), render({ platform: "facebook" })],
    });
    await publishDraft(d, { now: true });

    expect(d.providerPostId).toBe("bluesky:post-ok,facebook:fb-live");
    expect(d.lastError).toBe("facebook: first comment failed: (#200) nope");
  });

  it("uploads independent assets together rather than one round trip at a time", async () => {
    // Three assets, all three in flight before any of them completes. Serial
    // uploads would deadlock on the gate instead of failing an assertion.
    const gate = deferred<void>();
    let inFlight = 0;
    let peak = 0;
    const { ensureUploaded } = await import("../media.js");
    const mock = ensureUploaded as unknown as ReturnType<typeof vi.fn>;
    mock.mockImplementation(async (asset: MediaAsset) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      if (inFlight === 3) gate.resolve();
      await gate.promise;
      inFlight -= 1;
      asset.url ??= `https://cdn.example.test/${asset.path.split("/").pop()}`;
      return asset;
    });

    const d = draft({
      source: {
        text: "Body",
        hashtags: [],
        media: [
          { ...image(), path: "/tmp/a.jpg" },
          { ...image(), path: "/tmp/b.jpg" },
          { ...image(), path: "/tmp/c.jpg" },
        ],
      },
      renders: [render({ platform: "bluesky", mediaIndices: [0, 1, 2] })],
    });
    await publishDraft(d, { now: true });

    expect(peak).toBe(3);
    expect(d.source.media.every((m) => Boolean(m.url))).toBe(true);
  });
});

/**
 * ⛔ TWO LEGS HELD BY ONE AGGREGATOR SHARE A CREDENTIAL AND A RATE LIMIT.
 *
 * Which is why the parallelism is grouped by ROUTE and not by platform: firing
 * `via:zernio:reddit` and `via:zernio:twitter` together is how a publish earns a
 * 429 that neither leg deserved. Legs on different vendors share nothing and do
 * run together — proved above.
 */
describe("legs sharing an aggregator are sent one at a time", () => {
  const aggPublish = vi.fn<Aggregator["publishNow"]>();

  beforeEach(() => {
    aggPublish.mockReset();
    registerAggregator({
      id: "zernio",
      platforms: () => ["reddit", "twitter"],
      channelRules: () => ({ maxLength: 40000, countMode: "utf16" }),
      connectStatus: async (p) => ({ connected: true, accountId: `acc_${p}`, displayName: "u/d" }),
      publishNow: aggPublish,
      deletePost: async () => {},
      postFacts: async () => new Map(),
      postUrl: (_p, ref) => `https://example.test/${ref}`,
    });
    process.env.SOCIALMETA_TRANSPORT_OVERRIDES = JSON.stringify({
      bluesky: "direct",
      reddit: "aggregator:zernio",
      twitter: "aggregator:zernio",
    });
    invalidateConnectedAccounts();
  });

  it("never has two legs of the same aggregator in flight at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const order: Platform[] = [];
    aggPublish.mockImplementation(async (platform) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      order.push(platform);
      // Yield the event loop, so a sibling started concurrently would be
      // observed here rather than being hidden by a synchronous return.
      await Promise.resolve();
      await Promise.resolve();
      inFlight -= 1;
      return { ref: `zp_${platform}` };
    });

    const d = draft({
      targets: ["reddit", "twitter"],
      renders: [
        render({ platform: "reddit", subreddit: "smallbusiness" }),
        render({ platform: "twitter" }),
      ],
    });
    await publishDraft(d, { now: true });

    expect(peak).toBe(1);
    expect(order).toEqual(["reddit", "twitter"]);
    expect(d.providerPostId).toBe("via:zernio:reddit:zp_reddit,via:zernio:twitter:zp_twitter");
  });

  it("runs a direct leg alongside the aggregator's serial pair", async () => {
    // The grouping must not accidentally serialise everything: the direct leg is
    // its own group and shares nothing with the aggregator's credential.
    const seen: string[] = [];
    aggPublish.mockImplementation(async (platform) => {
      seen.push(`agg:${platform}`);
      return { ref: `zp_${platform}` };
    });
    publishNow.mockImplementation(async (input) => {
      seen.push(`direct:${input.render.platform}`);
      return { ref: "post-1" };
    });

    const d = draft({
      targets: ["bluesky", "reddit", "twitter"],
      renders: [
        render({ platform: "bluesky" }),
        render({ platform: "reddit", subreddit: "smallbusiness" }),
        render({ platform: "twitter" }),
      ],
    });
    await publishDraft(d, { now: true });

    expect(seen).toContain("direct:bluesky");
    // The aggregator's two stay in render order relative to each other.
    expect(seen.filter((s) => s.startsWith("agg:"))).toEqual(["agg:reddit", "agg:twitter"]);
    expect(d.providerPostId).toBe(
      "bluesky:post-1,via:zernio:reddit:zp_reddit,via:zernio:twitter:zp_twitter",
    );
  });
});

/**
 * skipUnconnected (autopilot, the digest's email approve, the copilot) drops a
 * platform the fresh sweep could not reach. It used to drop it with nothing on
 * the draft: lastError came only from the legs that were sent, the result's
 * `skipped` was discarded by both unattended callers, and the terminal guard
 * then refused any later publish, so the post never reached that platform and
 * nobody was told.
 */
describe("a platform dropped by skipUnconnected", () => {
  function statusTransport(platform: Platform, status: DirectTransport["connectStatus"]): DirectTransport {
    return { ...fakeTransport(platform), connectStatus: status };
  }

  it("is recorded on the draft with the vendor's own reason", async () => {
    process.env.SOCIALMETA_TRANSPORT_OVERRIDES = JSON.stringify({ bluesky: "direct", linkedin: "direct" });
    registerTransport(
      statusTransport("linkedin", async () => ({
        connected: false,
        accountId: "",
        displayName: "",
        reason: "token refresh failed: 503",
      })),
    );
    const d = draft({ renders: [render({ platform: "bluesky" }), render({ platform: "linkedin" })] });

    const res = await publishDraft(d, { now: true, skipUnconnected: true });

    expect(res.skipped).toEqual(["linkedin"]);
    expect(d.lastError).toBe(
      "linkedin: not connected at publish time (token refresh failed: 503), so it was not sent",
    );
  });

  it("names a status check that threw, and an unrouted platform's missing route", async () => {
    process.env.SOCIALMETA_TRANSPORT_OVERRIDES = JSON.stringify({ bluesky: "direct", linkedin: "direct" });
    registerTransport(
      statusTransport("linkedin", async () => {
        throw new Error("token store unreachable");
      }),
    );
    const d = draft({
      renders: [render({ platform: "bluesky" }), render({ platform: "linkedin" }), render({ platform: "reddit" })],
    });

    await publishDraft(d, { at: FUTURE, skipUnconnected: true });

    expect(d.lastError).toBe(
      "linkedin: not connected at publish time (status check failed: token store unreachable), so it was not sent | " +
        "reddit: not connected at publish time (reddit has no route: it is not connected directly and no aggregator holds it), so it was not sent",
    );
  });

  it("says when a transport reports itself disconnected without giving a reason", async () => {
    process.env.SOCIALMETA_TRANSPORT_OVERRIDES = JSON.stringify({ bluesky: "direct", linkedin: "direct" });
    registerTransport(
      statusTransport("linkedin", async () => ({ connected: false, accountId: "", displayName: "" })),
    );
    const d = draft({ renders: [render({ platform: "bluesky" }), render({ platform: "linkedin" })] });

    await publishDraft(d, { now: true, skipUnconnected: true });

    expect(d.lastError).toBe(
      "linkedin: not connected at publish time (the transport reports it is not connected), so it was not sent",
    );
  });

  it("comes before a sent leg's own error, so that leg going live later cannot wipe it", async () => {
    // publish-due's settleLegError clears lastError only when it starts with the
    // platform that just went live. The drop is permanent, so it leads.
    publishNow.mockRejectedValue(new Error("rate limited"));
    const d = draft({ renders: [render({ platform: "bluesky" }), render({ platform: "linkedin" })] });

    await publishDraft(d, { now: true, skipUnconnected: true });

    expect(d.lastError).toMatch(/^linkedin: not connected at publish time \(.*\), so it was not sent \| bluesky: rate limited$/);
  });

  it("leaves lastError empty when nothing was dropped and nothing failed", async () => {
    const d = draft({ renders: [render({ platform: "bluesky" })] });
    await publishDraft(d, { now: true, skipUnconnected: true });
    expect(d.lastError).toBeUndefined();
  });
});

describe("an invalidate while a sweep is in flight", () => {
  it("does not let the old sweep write its stale map into the cache", async () => {
    // The OAuth connect callback invalidates. A sweep started before it was
    // built against the old state, and caching its answer for 60s made the
    // account just connected read as "not connected" (the 409 oauth-routes.ts
    // documents) for every cached reader: QA, draft creation, the idea pipeline.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let connected = false;
    let entered = 0;
    let allInside!: () => void;
    const inside = new Promise<void>((r) => {
      allInside = r;
    });
    connectStatus.mockImplementation(async () => {
      // The vendor answers with the state at the moment it was asked.
      const snapshot = connected;
      if (++entered === 2) allInside();
      await gate;
      return snapshot
        ? { connected: true, accountId: "acct-1", displayName: "Acme" }
        : { connected: false, accountId: "", displayName: "", reason: "not yet" };
    });

    const stale = connectedAccounts({ fresh: true });
    await inside;
    connected = true;
    invalidateConnectedAccounts();
    release();
    expect(await stale).toEqual({});

    // A cached read after the invalidate must go back to the vendors.
    expect(Object.keys(await connectedAccounts())).toEqual(["facebook", "bluesky"]);
  });

  it("still caches a sweep nobody invalidated", async () => {
    await connectedAccounts({ fresh: true });
    connectStatus.mockClear();
    await connectedAccounts();
    expect(connectStatus).not.toHaveBeenCalled();
  });
});
