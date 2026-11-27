// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * `sentContents()` against the transports it describes.
 *
 * QA length-checks exactly what `sentContents()` returns, so it has to be what
 * each platform's transport actually sends, in order. The failure this pins:
 * reading `threadItems` as the whole thread with the root as item 0 while every
 * transport reads it as replies after `content`, so a post opens twice on X,
 * Threads and Bluesky. Each case here publishes ONE render
 * through the real transport against a mocked vendor client, records the text
 * of every value it sends, and compares that list with `sentContents()`.
 */

vi.mock("../x.js", async (importActual) => ({
  ...(await importActual<typeof import("../x.js")>()),
  createTweet: vi.fn(),
}));
vi.mock("../bluesky.js", async (importActual) => ({
  ...(await importActual<typeof import("../bluesky.js")>()),
  buildRichText: vi.fn(async (text: string) => ({ text, facets: undefined })),
  createPost: vi.fn(),
  createReply: vi.fn(),
}));
vi.mock("../threads.js", async (importActual) => ({
  ...(await importActual<typeof import("../threads.js")>()),
  createContainer: vi.fn(),
  publishContainer: vi.fn(),
  pollContainerUntilFinished: vi.fn(),
  getPermalink: vi.fn(),
}));
vi.mock("../meta-graph.js", async (importActual) => ({
  ...(await importActual<typeof import("../meta-graph.js")>()),
  graphRequest: vi.fn(),
  metaCredentials: vi.fn(),
}));
vi.mock("../linkedin.js", async (importActual) => ({
  ...(await importActual<typeof import("../linkedin.js")>()),
  createPost: vi.fn(),
}));

import { createTweet } from "../x.js";
import { createPost as blueskyCreatePost, createReply as blueskyCreateReply } from "../bluesky.js";
import { createContainer, publishContainer } from "../threads.js";
import { graphRequest, metaCredentials } from "../meta-graph.js";
import { createPost as linkedinCreatePost } from "../linkedin.js";
import { xTransport } from "../x-transport.js";
import { blueskyTransport } from "../bluesky-transport.js";
import { threadsTransport } from "../threads-transport.js";
import { facebookTransport } from "../facebook-transport.js";
import { instagramTransport } from "../instagram-transport.js";
import { linkedinTransport } from "../linkedin-transport.js";
import { zernioAggregator, resetZernioAccounts } from "../zernio-aggregator.js";
import { setZernioTokenResolver } from "../zernio.js";
import { sentContents, sentValues } from "../publish.js";
import { SPECS } from "../specs.js";
import { ALL_PLATFORMS, threadReplies, type MediaAsset, type Platform, type PlatformRender } from "../types.js";
import type { DirectPublishInput } from "../transport.js";

const mocked = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

/** Every value a transport sent, in order, filled by the vendor mocks below. */
let sent: string[];
let seq: number;

const ROOT = "Root post.";
const FIRST_COMMENT = "The link: https://example.com/news";

/** Replies-only, the shape every writer now stores. */
function render(platform: Platform, over: Partial<PlatformRender> = {}): PlatformRender {
  return {
    platform,
    content: ROOT,
    threadItems: ["Reply one.", "Reply two."],
    firstComment: FIRST_COMMENT,
    mediaIndices: [],
    ...over,
  };
}

/** A row stored root-first, which must not open twice. */
function legacy(platform: Platform): PlatformRender {
  return render(platform, { threadItems: [ROOT, "Reply one."] });
}

const JPEG: MediaAsset = {
  path: "/tmp/card.jpg",
  type: "image",
  mimeType: "image/jpeg",
  size: 900_000,
  url: "https://cdn.example.com/card.jpg",
  altText: "a card",
};

function input(r: PlatformRender, media: MediaAsset[] = []): DirectPublishInput {
  return { render: r, media, draftId: "draft-1", destination: {} };
}

beforeEach(() => {
  sent = [];
  seq = 0;
  mocked(createTweet).mockReset().mockImplementation(async ({ text }: { text: string }) => {
    sent.push(text);
    return { id: `t${++seq}` };
  });
  const bsky = async ({ text }: { text: string }) => {
    sent.push(text);
    seq += 1;
    return { uri: `at://did:plc:x/app.bsky.feed.post/p${seq}`, cid: `c${seq}` };
  };
  mocked(blueskyCreatePost).mockReset().mockImplementation(bsky);
  mocked(blueskyCreateReply).mockReset().mockImplementation(bsky);
  mocked(createContainer).mockReset().mockImplementation(async ({ text }: { text: string }) => {
    sent.push(text);
    return { id: `container-${++seq}` };
  });
  mocked(publishContainer).mockReset().mockImplementation(async () => ({ id: `post-${++seq}` }));
  mocked(metaCredentials).mockReset().mockResolvedValue({
    appSecret: "s",
    pageToken: "t",
    pageId: "page-1",
    igUserId: "ig-1",
  });
  // Every Graph write carrying copy names it `message` (a post or a comment) or
  // `caption` (an Instagram container); reads and publish calls carry neither.
  mocked(graphRequest).mockReset().mockImplementation(
    async (path: string, opts: { params?: Record<string, unknown> } = {}) => {
      const text = opts.params?.message ?? opts.params?.caption;
      if (typeof text === "string") sent.push(text);
      if (path.endsWith("/feed")) return { id: "page-1_1" };
      if (path.endsWith("/media")) return { id: "container-1" };
      if (path.endsWith("/media_publish")) return { id: "media-1" };
      if (path.endsWith("/comments")) return { id: "comment-1" };
      return { status_code: "FINISHED", permalink: "https://www.instagram.com/p/x/" };
    },
  );
  mocked(linkedinCreatePost).mockReset().mockImplementation(async ({ commentary }: { commentary: string }) => {
    sent.push(commentary);
    return { ref: "urn:li:share:1" };
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetZernioAccounts();
  setZernioTokenResolver(null);
});

const DIRECT: Array<[Platform, (r: PlatformRender) => Promise<unknown>]> = [
  ["twitter", (r) => xTransport.publishNow(input(r))],
  ["bluesky", (r) => blueskyTransport.publishNow(input(r))],
  ["threads", (r) => threadsTransport.publishNow(input(r))],
  ["facebook", (r) => facebookTransport.publishNow(input(r))],
  ["instagram", (r) => instagramTransport.publishNow(input(r, [JPEG]))],
  ["linkedin", (r) => linkedinTransport.publishNow(input(r))],
];

describe("sentContents matches what each direct transport sends", () => {
  it.each(DIRECT)("%s", async (platform, publish) => {
    const r = render(platform);
    await publish(r);
    expect(sent).toEqual(sentContents(r));
  });

  it.each(DIRECT)("%s, for a row stored with its root as item 0", async (platform, publish) => {
    const r = legacy(platform);
    await publish(r);
    expect(sent).toEqual(sentContents(r));
    // The guard itself: the root goes out exactly once.
    expect(sent.filter((t) => t === ROOT)).toHaveLength(1);
  });

  it("pins the per-platform shape the cases above compare against", () => {
    const replies = ["Reply one.", "Reply two."];
    expect(sentContents(render("twitter"))).toEqual([ROOT, ...replies]);
    expect(sentContents(render("bluesky"))).toEqual([ROOT, ...replies]);
    expect(sentContents(render("threads"))).toEqual([ROOT, ...replies, FIRST_COMMENT]);
    expect(sentContents(render("facebook"))).toEqual([ROOT, FIRST_COMMENT]);
    expect(sentContents(render("instagram"))).toEqual([ROOT, FIRST_COMMENT]);
    // LinkedIn and YouTube declare supportsFirstComment, and their transports
    // drop it; the rest support neither.
    for (const p of ["linkedin", "youtube", "reddit", "pinterest", "tiktok"] as const) {
      expect(sentContents(render(p))).toEqual([ROOT]);
    }
  });
});

describe("sentContents matches the Zernio X thread", () => {
  /** Zernio's create call, reduced to the texts it would publish. */
  function zernioTexts(body: {
    content: string;
    platforms: Array<{ platformSpecificData: { threadItems?: Array<{ content: string }> } }>;
  }): string[] {
    const thread = body.platforms[0]!.platformSpecificData.threadItems;
    // With a thread, Zernio publishes the thread and not the top-level content.
    return thread ? thread.map((t) => t.content) : [body.content];
  }

  async function publishViaZernio(r: PlatformRender): Promise<string[]> {
    let created: unknown;
    setZernioTokenResolver(async () => "sk_test");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { method?: string; body?: string } = {}) => {
        const json = url.includes("/accounts")
          ? { accounts: [{ _id: "acc_x", platform: "twitter", username: "d", isActive: true }] }
          : ((created = JSON.parse(init.body!)),
            { post: { _id: "zp_1", platforms: [{ platform: "twitter", status: "published", platformPostId: "1" }] } });
        return { ok: true, status: 200, text: async () => JSON.stringify(json) } as unknown as Response;
      }),
    );
    await zernioAggregator.publishNow("twitter", input(r));
    return zernioTexts(created as Parameters<typeof zernioTexts>[0]);
  }

  it("sends the root then each reply", async () => {
    const r = render("twitter");
    expect(await publishViaZernio(r)).toEqual(sentContents(r));
  });

  it("does not double a root stored as item 0", async () => {
    const r = legacy("twitter");
    expect(await publishViaZernio(r)).toEqual([ROOT, "Reply one."]);
    expect(sentContents(r)).toEqual([ROOT, "Reply one."]);
  });

  it("sends the root alone when there is no thread", async () => {
    const r = render("twitter", { threadItems: undefined });
    expect(await publishViaZernio(r)).toEqual(sentContents(r));
  });
});

describe("sentValues", () => {
  it("sends replies on exactly the platforms that declare reply chains, each with an item cap", () => {
    // qa.ts reads threadItemMaxChars without a fallback on the strength of this.
    for (const p of ALL_PLATFORMS) {
      const replies = sentValues(render(p)).filter((v) => v.kind === "reply");
      expect(replies.length > 0, p).toBe(SPECS[p].supportsThreads);
      if (replies.length) expect(SPECS[p].threadItemMaxChars, p).toBeGreaterThan(0);
    }
  });

  it("labels each value by what it is on the platform", () => {
    expect(sentValues(render("threads")).map((v) => v.kind)).toEqual([
      "content",
      "reply",
      "reply",
      "firstComment",
    ]);
  });
});

describe("threadReplies", () => {
  it("returns the stored replies as they are", () => {
    expect(threadReplies({ content: "a", threadItems: ["b", "c"] })).toEqual(["b", "c"]);
  });

  it("drops a leading copy of the body, compared trimmed", () => {
    expect(threadReplies({ content: "Root.", threadItems: ["  Root.\n", "b"] })).toEqual(["b"]);
  });

  it("drops only a LEADING copy", () => {
    expect(threadReplies({ content: "a", threadItems: ["b", "a"] })).toEqual(["b", "a"]);
  });

  it("returns an empty list for no thread", () => {
    expect(threadReplies({ content: "a" })).toEqual([]);
    expect(threadReplies({ content: "a", threadItems: [] })).toEqual([]);
  });

  it("returns a fresh array, so appending to it never writes to the render", () => {
    const r = { content: "a", threadItems: ["b"] };
    threadReplies(r).push("c");
    expect(r.threadItems).toEqual(["b"]);
  });
});
