import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { zernioAggregator, ZERNIO_ID, resetZernioAccounts } from "../zernio-aggregator.js";
import { setZernioTokenResolver } from "../zernio.js";
import { aggregatorEntry } from "../transport.js";
import { publishDestination } from "../publish.js";
import type { DirectPublishInput } from "../transport.js";
import { FIXTURE_TIKTOK_POST, FIXTURE_ZERNIO_ACCOUNT } from "./helpers/fixtures.js";

/**
 * The Zernio aggregator, against a mocked `fetch`.
 *
 * These are about the seams that fail SILENTLY, not about coverage for its own
 * sake: the wrong delete verb, a per-platform rejection inside a 2xx envelope,
 * and the composite ref that has to carry two ids because neither alone is
 * sufficient.
 */

const ACCOUNTS = {
  accounts: [
    { _id: "acc_reddit", platform: "reddit", username: "examplebrand", isActive: true },
    { _id: "acc_x", platform: "twitter", username: "examplebrand", isActive: true },
  ],
};

let calls: Array<{ url: string; method: string; body: unknown }>;

function mockFetch(handler: (url: string, method: string, body: unknown) => { status?: number; json: unknown }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { method?: string; body?: string } = {}) => {
      const method = init.method ?? "GET";
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ url, method, body });
      const { status = 200, json } = handler(url, method, body);
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => JSON.stringify(json),
      } as unknown as Response;
    }),
  );
}

function publishInput(overrides: Partial<DirectPublishInput> = {}): DirectPublishInput {
  return {
    render: { platform: "reddit", content: "hello world", mediaIndices: [] },
    media: [],
    draftId: "d1",
    destination: { subreddit: "smallbusiness", title: "A title" },
    ...overrides,
  } as DirectPublishInput;
}

beforeEach(() => {
  calls = [];
  resetZernioAccounts();
  setZernioTokenResolver(async () => "sk_test");
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetZernioAccounts();
  setZernioTokenResolver(null);
});

describe("publishNow", () => {
  it("returns a ref carrying BOTH the Zernio id and the native id", async () => {
    mockFetch((url) =>
      url.includes("/accounts")
        ? { json: ACCOUNTS }
        : {
            json: {
              message: "Post created",
              post: {
                _id: "zp_1",
                status: "published",
                platforms: [
                  {
                    platform: "reddit",
                    status: "published",
                    platformPostId: "t3_abc",
                    platformPostUrl: "https://reddit.com/x",
                  },
                ],
              },
            },
          },
    );

    const out = await zernioAggregator.publishNow("reddit", publishInput());

    // ⛔ Neither id alone is sufficient: unpublish needs Zernio's, the calendar
    // permalink needs the native one, and postUrl is sync so it cannot fetch.
    expect(out.ref).toBe("zp_1~t3_abc");
    expect(out.url).toBe("https://reddit.com/x");
  });

  it("publishes immediately rather than silently creating a draft", async () => {
    mockFetch((url) =>
      url.includes("/accounts")
        ? { json: ACCOUNTS }
        : { json: { post: { _id: "zp_1", status: "published", platforms: [{ platform: "reddit", status: "published", platformPostId: "t3_a" }] } } },
    );

    await zernioAggregator.publishNow("reddit", publishInput());

    // Omitting publishNow/scheduledFor/queuedFromProfile makes Zernio create a
    // DRAFT: the request succeeds, returns an id, and nothing ever publishes.
    const create = calls.find((c) => c.method === "POST")!;
    expect((create.body as { publishNow?: boolean }).publishNow).toBe(true);
  });

  /**
   * ⛔ A 2xx MEANS THE REQUEST SUCCEEDED, NOT THAT REDDIT ACCEPTED THE POST.
   * Zernio's own docs put Reddit's failure rate above 50% (subreddit rules,
   * karma, missing flair), and every one of those arrives as a per-platform
   * `failed` inside an otherwise fine 200 envelope.
   */
  it("throws when the platform leg failed inside a successful response", async () => {
    mockFetch((url) =>
      url.includes("/accounts")
        ? { json: ACCOUNTS }
        : {
            json: {
              post: {
                _id: "zp_1",
                status: "failed",
                platforms: [{ platform: "reddit", status: "failed", error: "SUBMIT_VALIDATION_FLAIR_REQUIRED" }],
              },
            },
          },
    );

    await expect(zernioAggregator.publishNow("reddit", publishInput())).rejects.toThrow(
      /FLAIR_REQUIRED/,
    );
  });

  it("sends the subreddit, title and flair as per-platform options", async () => {
    mockFetch((url) =>
      url.includes("/accounts")
        ? { json: ACCOUNTS }
        : { json: { post: { _id: "zp_1", status: "published", platforms: [{ platform: "reddit", status: "published", platformPostId: "t3_a" }] } } },
    );

    await zernioAggregator.publishNow(
      "reddit",
      publishInput({ destination: { subreddit: "smallbusiness", title: "T", flair: { id: "f1", name: "News" } } }),
    );

    const create = calls.find((c) => c.method === "POST")!;
    const target = (create.body as { platforms: Array<{ platformSpecificData: Record<string, string> }> }).platforms[0];
    expect(target.platformSpecificData).toMatchObject({
      subreddit: "smallbusiness",
      title: "T",
      flairId: "f1",
    });
  });

  it("refuses to publish a platform with no connected account", async () => {
    mockFetch(() => ({ json: { accounts: [] } }));
    await expect(zernioAggregator.publishNow("reddit", publishInput())).rejects.toThrow(
      /no active Zernio account/,
    );
  });
});

describe("deletePost", () => {
  /**
   * ⛔ THE VERB. `DELETE /posts/{id}` only removes Zernio-side drafts and
   * scheduled posts; a published post needs `/unpublish`. Wiring the obvious one
   * would leave the post live on Reddit while this system recorded a successful
   * delete, and because every transport treats an already-gone post as success,
   * nothing would ever notice.
   */
  it("calls unpublish, never DELETE, and sends the platform", async () => {
    mockFetch(() => ({ json: { success: true } }));

    await zernioAggregator.deletePost("reddit", "zp_1~t3_abc");

    const call = calls.at(-1)!;
    expect(call.url).toContain("/posts/zp_1/unpublish");
    expect(call.method).toBe("POST");
    expect(call.body).toEqual({ platform: "reddit" });
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("is idempotent: an already-gone post is a success", async () => {
    mockFetch(() => ({ status: 404, json: { error: "not found" } }));
    await expect(zernioAggregator.deletePost("reddit", "zp_1~t3_abc")).resolves.toBeUndefined();
  });

  /**
   * ⛔ ZERNIO SIGNALS ALREADY-GONE AS A 400, NOT A 404: the post record still
   * exists on their side, it is just no longer publishable. Verified live by
   * deleting the same proof post twice.
   *
   * Treating only 404 as gone broke the idempotence contract in the direction
   * that matters: deleteProviderEntries would report the leg FAILED and keep it
   * in providerPostId, so a draft whose post was already removed looked
   * permanently half-deleted and every retry failed identically.
   */
  it("treats the 400 'already cancelled' answer as gone, not as a failure", async () => {
    mockFetch(() => ({
      status: 400,
      json: {
        error: 'Can only unpublish posts with "published" status. Current status: cancelled',
        code: "invalid_field_value",
      },
    }));

    await expect(zernioAggregator.deletePost("reddit", "zp_1~t3_abc")).resolves.toBeUndefined();
  });

  it("still throws on a DIFFERENT 400, so a real refusal is not swallowed", async () => {
    mockFetch(() => ({ status: 400, json: { error: "platform is required", code: "invalid_field_value" } }));
    await expect(zernioAggregator.deletePost("reddit", "zp_1~t3_abc")).rejects.toThrow(/platform is required/);
  });

  it("still throws on a real failure, so a delete is not reported as clean", async () => {
    mockFetch(() => ({ status: 500, json: { error: "upstream" } }));
    await expect(zernioAggregator.deletePost("reddit", "zp_1~t3_abc")).rejects.toThrow(/upstream/);
  });
});

describe("postFacts", () => {
  it("reports a published leg, keyed by the FULL composite ref", async () => {
    mockFetch(() => ({
      json: { post: { _id: "zp_1", status: "published", platforms: [{ platform: "reddit", status: "published" }] } },
    }));

    const out = await zernioAggregator.postFacts("reddit", ["zp_1~t3_abc"]);

    expect(out.get("zp_1~t3_abc")).toMatchObject({ state: "PUBLISHED", released: true });
  });

  it("reads a failed leg as ERROR and a pending one as QUEUE", async () => {
    mockFetch((url) => ({
      json: url.includes("zp_fail")
        ? { post: { _id: "zp_fail", status: "failed", platforms: [{ platform: "reddit", status: "failed" }] } }
        : { post: { _id: "zp_wait", status: "scheduled", platforms: [{ platform: "reddit", status: "pending" }] } },
    }));

    const out = await zernioAggregator.postFacts("reddit", ["zp_fail~a", "zp_wait~b"]);

    expect(out.get("zp_fail~a")).toMatchObject({ state: "ERROR" });
    expect(out.get("zp_wait~b")).toMatchObject({ state: "QUEUE" });
  });

  /**
   * `absent` is set while `state` stays QUEUE. The caller owns the grace window
   * and the decision to call a post dead; a transport that promoted this to
   * ERROR itself would be overriding a policy it cannot read.
   */
  it("marks a 404 absent without calling it an error", async () => {
    mockFetch(() => ({ status: 404, json: { error: "not found" } }));

    const out = await zernioAggregator.postFacts("reddit", ["zp_gone~t3_x"]);

    expect(out.get("zp_gone~t3_x")).toMatchObject({ state: "QUEUE", absent: true });
  });

  it("says nothing at all when the vendor is unreachable, so nothing is marked dead", async () => {
    mockFetch(() => ({ status: 503, json: { error: "down" } }));

    const out = await zernioAggregator.postFacts("reddit", ["zp_1~t3_abc"]);

    expect(out.has("zp_1~t3_abc")).toBe(false);
  });
});

describe("postUrl", () => {
  it("builds the NATIVE permalink from the second half of the ref", () => {
    expect(zernioAggregator.postUrl("reddit", "zp_1~t3_abc")).toBe(
      "https://www.reddit.com/comments/abc",
    );
    expect(zernioAggregator.postUrl("twitter", "zp_1~1000000001")).toContain("1000000001");
  });

  /**
   * The ref is immutable once written (publish-due's CAS, confirmedLegs and
   * swapEntry all depend on it), so a leg whose native id was never returned
   * cannot be "upgraded" later. Falling back is the honest answer; fabricating
   * a platform URL from a Zernio id would produce a dead link.
   */
  it("falls back to the Zernio link rather than inventing a platform URL", () => {
    expect(zernioAggregator.postUrl("reddit", "zp_1~")).toBe("https://zernio.com/posts/zp_1");
  });
});

describe("channelRules", () => {
  it("declares the AGGREGATOR's limits, which are not our direct transport's", () => {
    // Zernio's own docs call the 300-char cap the single largest cause of
    // Bluesky failures, and it counts URLs in full.
    expect(zernioAggregator.channelRules("bluesky")).toMatchObject({
      maxLength: 300,
      countMode: "grapheme",
    });
    expect(zernioAggregator.channelRules("reddit").maxLength).toBe(40_000);
  });

  it("declares TikTok's 2,200-character caption, with no image limits on a video-only platform", () => {
    expect(zernioAggregator.channelRules("tiktok")).toEqual({ maxLength: 2_200, countMode: "utf16" });
  });

  it("throws rather than returning a permissive default for an unknown platform", () => {
    // A fallback here would let QA validate against a limit nothing enforces.
    expect(() => zernioAggregator.channelRules("snapchat" as never)).toThrow(/no declared limits/);
  });
});

describe("connectStatus", () => {
  it("reports connected without throwing", async () => {
    mockFetch(() => ({ json: ACCOUNTS }));
    await expect(zernioAggregator.connectStatus("reddit")).resolves.toMatchObject({
      connected: true,
      accountId: "acc_reddit",
    });
  });

  /**
   * Contractually forbidden from throwing: it reports failure in its return
   * value, which is why the bound view does not retry-wrap it. A throw here
   * would take out `connectedAccounts` for every platform at once.
   */
  it("reports disconnected instead of throwing when the vendor is unreachable", async () => {
    mockFetch(() => ({ status: 401, json: { error: "bad key" } }));

    const status = await zernioAggregator.connectStatus("reddit");

    expect(status.connected).toBe(false);
    expect(status.reason).toMatch(/bad key/);
  });
});

describe("identity", () => {
  it("keeps the permanent aggregator id, which is written into every leg", () => {
    // Changing this orphans every `via:zernio:...` entry already in the column.
    expect(zernioAggregator.id).toBe("zernio");
    expect(ZERNIO_ID).toBe("zernio");
  });

  /**
   * ⛔ THE DISPLAY NAME IS NOT THE ID, AND THE ID CAN NEVER CARRY CAPITALS.
   * `aggregatorEntry` matches the id against `^[a-z0-9][a-z0-9-]*$` and writes
   * it into `providerPostId`, so "Zernio" is unencodable AND unchangeable once
   * legs exist. Operator-facing text reads `displayName`; anything that renders
   * the id shows "Via zernio" forever.
   */
  it("separates the brand casing from the permanent id", () => {
    expect(zernioAggregator.displayName).toBe("Zernio");
    expect(zernioAggregator.id).toBe(zernioAggregator.displayName!.toLowerCase());
    // The id round-trips through the codec; the display name would not.
    expect(() => aggregatorEntry(zernioAggregator.id, "reddit", "t3_a")).not.toThrow();
    expect(() => aggregatorEntry(zernioAggregator.displayName!, "reddit", "t3_a")).toThrow(
      /must match/,
    );
  });
});

/**
 * Response-shape regressions, both found by calling the live API; each one,
 * misread, loses track of a post that did go out.
 */
describe("vendor response shapes", () => {
  /**
   * ⛔ THE ENVELOPE. Create and get return `{message, post}`; only the LIST
   * endpoint returns items at the top level. Reading the envelope as the post
   * leaves `_id` undefined, and because the post is created before the response
   * is parsed, that surfaces as a throw with a LIVE post already published and
   * unrecorded.
   */
  it("unwraps the {message, post} envelope on create", async () => {
    mockFetch((url) =>
      url.includes("/accounts")
        ? { json: ACCOUNTS }
        : {
            json: {
              message: "Post created successfully",
              post: {
                _id: "zp_env",
                status: "published",
                platforms: [{ platform: "reddit", status: "published", platformPostId: "t3_env" }],
              },
            },
          },
    );

    const out = await zernioAggregator.publishNow("reddit", publishInput());
    expect(out.ref).toBe("zp_env~t3_env");
  });

  it("unwraps the same envelope on read-back", async () => {
    mockFetch(() => ({
      json: { post: { _id: "zp_env", status: "published", platforms: [{ platform: "reddit", status: "published" }] } },
    }));

    const out = await zernioAggregator.postFacts("reddit", ["zp_env~t3_env"]);
    expect(out.get("zp_env~t3_env")).toMatchObject({ state: "PUBLISHED" });
  });

  it("says the post may be LIVE when the vendor returns no id", async () => {
    // The recovery is manual and time-sensitive, so the message has to say so
    // rather than reporting a generic publish failure.
    mockFetch((url) => (url.includes("/accounts") ? { json: ACCOUNTS } : { json: { message: "ok" } }));

    await expect(zernioAggregator.publishNow("reddit", publishInput())).rejects.toThrow(
      /may be LIVE and unrecorded/,
    );
  });

  /**
   * ⛔ AN UNKNOWN PATH ANSWERS 200 WITH THE DASHBOARD SPA, NOT 404, because
   * zernio.com serves both from one origin. Swallowing that returned null, which
   * `listAccounts` reported as NO CONNECTED ACCOUNTS — every platform would go
   * disconnected and publishing would stop, blaming the credential.
   */
  it("throws on a 200 that is not JSON, instead of reading it as empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, text: async () => "<!DOCTYPE html><html>" }) as unknown as Response),
    );

    await expect(zernioAggregator.connectStatus("reddit")).resolves.toMatchObject({
      connected: false,
      reason: expect.stringContaining("non-JSON"),
    });
  });

  it("sends page and limit together, which the API requires", async () => {
    mockFetch(() => ({ json: ACCOUNTS }));
    await zernioAggregator.connectStatus("reddit");

    // `limit` alone is a 400 invalid_field_value — not in the OpenAPI spec, only
    // discoverable by calling it.
    const accountsCall = calls.find((c) => c.url.includes("/accounts"))!;
    expect(accountsCall.url).toContain("page=1");
    expect(accountsCall.url).toContain("limit=100");
  });
});

/**
 * The whole account list this key can serve, including a platform Zernio holds
 * that this product does not model (`telegram`) and one connected-but-disabled
 * account. Both are routing decisions, not cosmetic details.
 */
const ALL_ACCOUNTS = {
  accounts: [
    { _id: "acc_reddit", platform: "reddit", username: "examplebrand", displayName: "r/examplebrand", isActive: true },
    { _id: "acc_x", platform: "twitter", username: "examplebrand", isActive: true },
    { _id: "acc_pin", platform: "pinterest", username: "examplebrand" },
    { _id: "acc_yt", platform: "youtube", displayName: "District AI" },
    { _id: "acc_li", platform: "linkedin", username: "examplebrand" },
    { _id: "acc_tg", platform: "telegram", username: "examplebrand", isActive: true },
    { _id: "acc_ig_off", platform: "instagram", username: "examplebrand", isActive: false },
  ],
};

/** Route the accounts call to a fixture and everything else to one payload. */
function mockAccountsAnd(
  accountsJson: unknown,
  rest: (url: string, method: string, body: unknown) => { status?: number; json: unknown },
) {
  mockFetch((url, method, body) =>
    url.includes("/accounts") && !url.includes("boards") && !url.includes("flairs")
      ? { json: accountsJson }
      : rest(url, method, body),
  );
}

/** A 200 create/read response in the vendor's `{message, post}` envelope. */
const PUBLISHED = (id: string, platform: string, native?: string) => ({
  json: {
    post: {
      _id: id,
      status: "published",
      platforms: [{ platform, status: "published", ...(native ? { platformPostId: native } : {}) }],
    },
  },
});

/* -------------------------------------------------------------------------- */
/*  Per-platform payload mapping                                               */
/* -------------------------------------------------------------------------- */

describe("platformSpecificData per platform", () => {
  function sentBody(): Record<string, unknown> {
    const create = calls.find((c) => c.method === "POST")!;
    const platforms = (create.body as { platforms: Array<{ platformSpecificData: Record<string, unknown> }> })
      .platforms;
    return platforms[0]!.platformSpecificData;
  }

  it("sends the Pinterest board, title and click-through link", async () => {
    // ⚠️ A pin published with no board errors at the vendor, and one with no
    // link is a pin that goes nowhere when clicked — it still returns a real id,
    // so nothing downstream notices.
    mockAccountsAnd(ALL_ACCOUNTS, () => PUBLISHED("zp_pin", "pinterest", "12345"));
    await zernioAggregator.publishNow(
      "pinterest",
      publishInput({
        render: { platform: "pinterest", content: "pin copy", mediaIndices: [] },
        destination: { board: "board_9", title: "A pin title", link: "https://example.com/x" },
      }),
    );
    expect(sentBody()).toEqual({
      boardId: "board_9",
      title: "A pin title",
      link: "https://example.com/x",
    });
  });

  // A pin routed through Zernio carries the same click-through a direct pin
  // does: the post's link with its tracked UTMs, read by publishDestination.
  it("sends a tracked pin's UTM'd link through Zernio, as publishDestination resolves it", async () => {
    mockAccountsAnd(ALL_ACCOUNTS, () => PUBLISHED("zp_pin", "pinterest", "12345"));
    const post = "https://www.example.com/blog/x";
    const pinLink = `${post}?utm_source=pinterest&utm_medium=social&utm_campaign=socialhq_1&utm_content=pinCode`;
    const render = { platform: "pinterest" as const, content: "pin copy", mediaIndices: [], pinLink, board: { id: "board_9" } };
    await zernioAggregator.publishNow(
      "pinterest",
      publishInput({ render, destination: publishDestination(render, { text: "t", hashtags: [], media: [], link: post }) }),
    );
    expect(sentBody()).toEqual({ boardId: "board_9", link: pinLink });
  });

  it("truncates the Pinterest title at the vendor's 100 characters", async () => {
    mockAccountsAnd(ALL_ACCOUNTS, () => PUBLISHED("zp_pin", "pinterest", "1"));
    await zernioAggregator.publishNow(
      "pinterest",
      publishInput({
        render: { platform: "pinterest", content: "c", mediaIndices: [] },
        destination: { board: "b", title: "T".repeat(400) },
      }),
    );
    expect(String(sentBody().title)).toHaveLength(100);
  });

  it("omits Pinterest fields the draft does not carry, rather than sending empties", async () => {
    // An empty boardId is not the same as no boardId: the vendor's validation
    // reads the key's presence.
    mockAccountsAnd(ALL_ACCOUNTS, () => PUBLISHED("zp_pin", "pinterest", "1"));
    await zernioAggregator.publishNow(
      "pinterest",
      publishInput({ render: { platform: "pinterest", content: "c", mediaIndices: [] }, destination: {} }),
    );
    expect(sentBody()).toEqual({});
  });

  it("⛔ never uploads a YouTube video as public", async () => {
    // An upload that goes out public cannot be un-seen; a private one can always
    // be promoted. The direct YouTube transport is conservative for the same
    // reason, and routing through an aggregator must not give that away.
    mockAccountsAnd(ALL_ACCOUNTS, () => PUBLISHED("zp_yt", "youtube", "vid_1"));
    await zernioAggregator.publishNow(
      "youtube",
      publishInput({
        render: { platform: "youtube", content: "desc", mediaIndices: [] },
        destination: { title: "Y".repeat(180) },
      }),
    );
    const data = sentBody();
    expect(data.visibility).toBe("private");
    expect(String(data.title)).toHaveLength(100);
  });

  it("swaps < and > out of a YouTube title and description, which YouTube refuses", async () => {
    mockAccountsAnd(ALL_ACCOUNTS, () => PUBLISHED("zp_yt", "youtube", "vid_1"));
    await zernioAggregator.publishNow(
      "youtube",
      publishInput({
        render: { platform: "youtube", content: "a <b> c", mediaIndices: [] },
        destination: { title: "x > y" },
      }),
    );
    const create = calls.find((c) => c.method === "POST")!;
    expect((create.body as { content: string }).content).toBe("a \u2039b\u203A c");
    expect(sentBody().title).toBe("x \u203A y");
  });

  it("cuts a YouTube description to 5000 bytes AFTER the swap, which costs 3 bytes a bracket", async () => {
    // 4000 bytes as QA measures it, 8000 once every < becomes a 3-byte guillemet.
    mockAccountsAnd(ALL_ACCOUNTS, () => PUBLISHED("zp_yt", "youtube", "vid_1"));
    await zernioAggregator.publishNow(
      "youtube",
      publishInput({
        render: { platform: "youtube", content: `${"<".repeat(2000)}${"a".repeat(2000)}`, mediaIndices: [] },
        destination: {},
      }),
    );
    const create = calls.find((c) => c.method === "POST")!;
    const content = (create.body as { content: string }).content;
    expect(new TextEncoder().encode(content).byteLength).toBe(4998);
    expect(content).toBe("\u2039".repeat(1666));
  });

  it("leaves < and > alone on platforms that accept them", async () => {
    mockAccountsAnd(ALL_ACCOUNTS, () => PUBLISHED("zp_1", "reddit", "t3_a"));
    await zernioAggregator.publishNow(
      "reddit",
      publishInput({ render: { platform: "reddit", content: "5 < 10", mediaIndices: [] }, destination: { subreddit: "s" } }),
    );
    const create = calls.find((c) => c.method === "POST")!;
    expect((create.body as { content: string }).content).toBe("5 < 10");
  });

  it("sets visibility even when the draft has no title at all", async () => {
    mockAccountsAnd(ALL_ACCOUNTS, () => PUBLISHED("zp_yt", "youtube", "vid_1"));
    await zernioAggregator.publishNow(
      "youtube",
      publishInput({ render: { platform: "youtube", content: "desc", mediaIndices: [] }, destination: {} }),
    );
    expect(sentBody()).toEqual({ visibility: "private" });
  });

  describe("TikTok", () => {
    const TIKTOK_ACCOUNTS = {
      accounts: [{ _id: FIXTURE_ZERNIO_ACCOUNT, platform: "tiktok", username: "examplebrand", isActive: true }],
    };
    const CLIP = {
      path: "clip.mp4",
      type: "video" as const,
      mimeType: "video/mp4",
      size: 1,
      url: "https://cdn.example.com/clip.mp4",
    };

    async function publishTikTok(
      render: Partial<DirectPublishInput["render"]> = {},
      media: DirectPublishInput["media"] = [CLIP],
    ) {
      mockAccountsAnd(TIKTOK_ACCOUNTS, () => PUBLISHED("zp_tt", "tiktok", FIXTURE_TIKTOK_POST));
      return zernioAggregator.publishNow(
        "tiktok",
        publishInput({
          render: { platform: "tiktok", content: "caption", mediaIndices: [0], ...render },
          media,
          destination: { title: "ignored" },
        }),
      );
    }

    it("⛔ sends the payload proven live: public, Your Brand, every interaction explicit", async () => {
      // A live publish accepted exactly these fields. Public is the only
      // privacy level a business connection's creator-info allows,
      // and TikTok requires all three allow* flags on a video post.
      const result = await publishTikTok();

      expect(sentBody()).toEqual({
        privacyLevel: "PUBLIC_TO_EVERYONE",
        allowComment: true,
        allowDuet: true,
        allowStitch: true,
        commercialContentType: "brand_organic",
        videoMadeWithAi: false,
        contentPreviewConfirmed: true,
        expressConsentGiven: true,
      });
      // No music: with the brand toggle on TikTok allows Commercial Music only.
      expect(sentBody()).not.toHaveProperty("autoAddMusic");
      const create = calls.find((c) => c.method === "POST")!;
      const body = create.body as {
        platforms: Array<{ platform: string; accountId: string }>;
        mediaItems: Array<{ type: string; url: string }>;
      };
      expect(body.platforms[0]).toMatchObject({ platform: "tiktok", accountId: FIXTURE_ZERNIO_ACCOUNT });
      expect(body.mediaItems).toEqual([{ type: "video", url: "https://cdn.example.com/clip.mp4" }]);
      expect(result.ref).toBe(`zp_tt~${FIXTURE_TIKTOK_POST}`);
    });

    it("turns the composer's TikTok opt-outs into allow* false", async () => {
      await publishTikTok({ tiktokDisableComment: true, tiktokDisableDuet: true, tiktokDisableStitch: true });

      expect(sentBody()).toMatchObject({ allowComment: false, allowDuet: false, allowStitch: false });
    });

    it("keeps the Your Brand disclosure even on a render that says otherwise", async () => {
      // Every post is the brand promoting itself; the composer locks
      // the label on, so a stray false must not under-disclose.
      await publishTikTok({ tiktokBrandOrganic: false });

      expect(sentBody().commercialContentType).toBe("brand_organic");
    });

    it("discloses an AI-generated clip, read the way Instagram reads it", async () => {
      await publishTikTok({}, [{ ...CLIP, aiGenerated: true }]);

      expect(sentBody().videoMadeWithAi).toBe(true);
    });
  });

  it("truncates a Reddit title at 300, which is the vendor's cap", async () => {
    mockAccountsAnd(ALL_ACCOUNTS, () => PUBLISHED("zp_1", "reddit", "t3_a"));
    await zernioAggregator.publishNow(
      "reddit",
      publishInput({ destination: { subreddit: "s", title: "T".repeat(500) } }),
    );
    expect(String(sentBody().title)).toHaveLength(300);
  });

  it("sends no per-platform options for a platform that has none", async () => {
    // twitter/linkedin/bluesky carry nothing bespoke; an empty object is the
    // honest payload rather than a copy of Reddit's fields.
    mockAccountsAnd(ALL_ACCOUNTS, () => PUBLISHED("zp_x", "twitter", "1000000001"));
    await zernioAggregator.publishNow(
      "twitter",
      publishInput({
        render: { platform: "twitter", content: "tweet", mediaIndices: [] },
        destination: { subreddit: "ignored", title: "ignored" },
      }),
    );
    expect(sentBody()).toEqual({});
  });
});

describe("media items", () => {
  function sentMedia(): Array<Record<string, unknown>> | undefined {
    const create = calls.find((c) => c.method === "POST")!;
    return (create.body as { mediaItems?: Array<Record<string, unknown>> }).mediaItems;
  }

  it("sends public HTTPS URLs, classified by mime, with alt text where present", async () => {
    // ⚠️ Deliberately NOT the presigned upload: fitMediaForPublish has already
    // re-uploaded fitted bytes to the asset store, so a second upload would move bytes that
    // are already addressable.
    mockAccountsAnd(ALL_ACCOUNTS, () => PUBLISHED("zp_1", "reddit", "t3_a"));
    await zernioAggregator.publishNow(
      "reddit",
      publishInput({
        media: [
          { url: "https://cdn.example/a.jpg", mimeType: "image/jpeg", altText: "a chart" },
          { url: "https://cdn.example/b.mp4", mimeType: "video/mp4" },
          { url: "https://cdn.example/c.png" },
        ] as DirectPublishInput["media"],
      }),
    );
    expect(sentMedia()).toEqual([
      { type: "image", url: "https://cdn.example/a.jpg", altText: "a chart" },
      { type: "video", url: "https://cdn.example/b.mp4" },
      { type: "image", url: "https://cdn.example/c.png" },
    ]);
  });

  it("drops an asset with no URL instead of sending a broken item", async () => {
    mockAccountsAnd(ALL_ACCOUNTS, () => PUBLISHED("zp_1", "reddit", "t3_a"));
    await zernioAggregator.publishNow(
      "reddit",
      publishInput({
        media: [{ mimeType: "image/png" }, { url: "" }] as unknown as DirectPublishInput["media"],
      }),
    );
    // No mediaItems key at all, rather than an empty array.
    expect(sentMedia()).toBeUndefined();
  });

  it("omits the mediaItems key entirely for a text-only post", async () => {
    mockAccountsAnd(ALL_ACCOUNTS, () => PUBLISHED("zp_1", "reddit", "t3_a"));
    await zernioAggregator.publishNow("reddit", publishInput({ media: [] }));
    expect(sentMedia()).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/*  The composite ref                                                          */
/* -------------------------------------------------------------------------- */

describe("composite ref", () => {
  it("records a Zernio-only ref when the vendor returns no native id", async () => {
    // The trailing separator is load-bearing: it keeps the ref parseable and
    // makes postUrl fall back rather than fabricate a platform link.
    mockAccountsAnd(ALL_ACCOUNTS, () => PUBLISHED("zp_1", "reddit"));
    const out = await zernioAggregator.publishNow("reddit", publishInput());
    expect(out.ref).toBe("zp_1~");
    // No platformPostUrl came back, so no url is claimed.
    expect(out.url).toBeUndefined();
  });

  /**
   * ⚠️ CONCERN, ASSERTED AS-IS. A separator inside either id throws — and it
   * throws AFTER createPost has already published, so the post is live and its
   * id is discarded. That is the same "born undeletable" outcome the NO_POST_ID
   * branch exists to shout about, but this path reports a validation-shaped
   * message with no recovery instructions. Zernio ids are cuid-like today, so it
   * is not reachable in practice; the test pins the behaviour rather than
   * endorsing it.
   */
  it("refuses to encode an id containing the separator, after the post is already live", async () => {
    mockAccountsAnd(ALL_ACCOUNTS, () => PUBLISHED("zp~1", "reddit", "t3_a"));
    await expect(zernioAggregator.publishNow("reddit", publishInput())).rejects.toThrow(
      /Zernio ids cannot contain "~"/,
    );
  });

  it("refuses a native id containing the separator for the same reason", async () => {
    mockAccountsAnd(ALL_ACCOUNTS, () => PUBLISHED("zp_1", "reddit", "t3~a"));
    await expect(zernioAggregator.publishNow("reddit", publishInput())).rejects.toThrow(
      /cannot contain/,
    );
  });

  it("treats a separator-less ref as all Zernio id rather than throwing in a delete", async () => {
    // Would be a bug upstream, but a delete path must degrade rather than throw.
    mockFetch(() => ({ json: { success: true } }));
    await zernioAggregator.deletePost("reddit", "bare_id");
    expect(calls.at(-1)!.url).toContain("/posts/bare_id/unpublish");
  });
});

/* -------------------------------------------------------------------------- */
/*  postUrl                                                                    */
/* -------------------------------------------------------------------------- */

describe("postUrl per platform", () => {
  it("builds the native permalink for every platform that has a known shape", () => {
    expect(zernioAggregator.postUrl("twitter", "zp~1000000001")).toBe(
      "https://twitter.com/i/web/status/1000000001",
    );
    expect(zernioAggregator.postUrl("youtube", "zp~EXAMPLEvid2")).toBe(
      "https://www.youtube.com/watch?v=EXAMPLEvid2",
    );
    expect(zernioAggregator.postUrl("pinterest", "zp~99887766")).toBe(
      "https://www.pinterest.com/pin/99887766/",
    );
    expect(zernioAggregator.postUrl("linkedin", "zp~urn:li:share:7311")).toBe(
      "https://www.linkedin.com/feed/update/urn:li:share:7311/",
    );
  });

  it("strips Reddit's t3_ thing-prefix, which is not part of the permalink", () => {
    expect(zernioAggregator.postUrl("reddit", "zp~t3_abc")).toBe(
      "https://www.reddit.com/comments/abc",
    );
    // Already bare: the strip is a no-op, not a truncation.
    expect(zernioAggregator.postUrl("reddit", "zp~abc")).toBe("https://www.reddit.com/comments/abc");
  });

  it("falls back to the Zernio link for a platform with no known permalink shape", () => {
    // bluesky/instagram/threads/facebook need a handle we do not store, so a
    // constructed URL would be a dead link on the calendar.
    for (const platform of ["bluesky", "instagram", "threads", "facebook"] as const) {
      expect(zernioAggregator.postUrl(platform, "zp_9~native")).toBe(
        "https://zernio.com/posts/zp_9",
      );
    }
  });

  it("falls back for a ref with no separator at all", () => {
    expect(zernioAggregator.postUrl("twitter", "legacy_id")).toBe(
      "https://zernio.com/posts/legacy_id",
    );
  });
});

/* -------------------------------------------------------------------------- */
/*  platforms() and the account cache                                          */
/* -------------------------------------------------------------------------- */

describe("platforms()", () => {
  it("answers full capability before the first refresh", () => {
    // ⚠️ Read synchronously on the routing path. Reporting nothing here would
    // hide the route from the settings UI and make it unfixable from there.
    const held = zernioAggregator.platforms();
    expect(held).toHaveLength(10);
    expect(held).toContain("reddit");
    expect(held).toContain("twitter");
  });

  it("narrows to the connected accounts once the cache is warm", async () => {
    mockFetch(() => ({ json: ACCOUNTS }));
    await zernioAggregator.connectStatus("reddit");
    expect([...zernioAggregator.platforms()].sort()).toEqual(["reddit", "twitter"]);
  });

  it("excludes a platform Zernio serves that this product does not model", async () => {
    mockFetch(() => ({ json: ALL_ACCOUNTS }));
    await zernioAggregator.connectStatus("reddit");
    expect(zernioAggregator.platforms()).not.toContain("telegram");
    // The disabled Instagram account is not capability either.
    expect(zernioAggregator.platforms()).not.toContain("instagram");
  });

  it("falls back to full capability rather than un-routing everything on an empty list", async () => {
    // A transient blip that returned zero accounts would otherwise silently
    // un-route a live platform.
    mockFetch(() => ({ json: { accounts: [] } }));
    await zernioAggregator.connectStatus("reddit");
    expect(zernioAggregator.platforms()).toHaveLength(10);
  });

  it("falls back when every cached account is deactivated", async () => {
    mockFetch(() => ({ json: { accounts: [{ _id: "a", platform: "reddit", isActive: false }] } }));
    await zernioAggregator.connectStatus("reddit");
    expect(zernioAggregator.platforms()).toHaveLength(10);
  });
});

describe("account cache", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads the account list once for repeated questions", async () => {
    mockFetch(() => ({ json: ACCOUNTS }));
    await zernioAggregator.connectStatus("reddit");
    await zernioAggregator.connectStatus("twitter");
    expect(calls.filter((c) => c.url.includes("/accounts"))).toHaveLength(1);
  });

  it("coalesces concurrent callers onto one in-flight request", async () => {
    // connectedAccounts() asks for every platform at once; N calls for one
    // credential would burn the request budget answering the same question.
    mockFetch(() => ({ json: ACCOUNTS }));
    await Promise.all([
      zernioAggregator.connectStatus("reddit"),
      zernioAggregator.connectStatus("twitter"),
      zernioAggregator.connectStatus("reddit"),
    ]);
    expect(calls.filter((c) => c.url.includes("/accounts"))).toHaveLength(1);
  });

  it("re-reads once the 60s TTL lapses, so a fresh connect is picked up", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-06T12:00:00Z"));
    mockFetch(() => ({ json: ACCOUNTS }));

    await zernioAggregator.connectStatus("reddit");
    vi.setSystemTime(new Date("2026-08-06T12:00:30Z"));
    await zernioAggregator.connectStatus("reddit");
    expect(calls.filter((c) => c.url.includes("/accounts"))).toHaveLength(1);

    vi.setSystemTime(new Date("2026-08-06T12:01:01Z"));
    await zernioAggregator.connectStatus("reddit");
    expect(calls.filter((c) => c.url.includes("/accounts"))).toHaveLength(2);
  });

  it("does not cache a failed lookup, so a blip is not pinned for a minute", async () => {
    let attempt = 0;
    mockFetch(() => {
      attempt += 1;
      return attempt === 1 ? { status: 503, json: { error: "down" } } : { json: ACCOUNTS };
    });

    await expect(zernioAggregator.connectStatus("reddit")).resolves.toMatchObject({ connected: false });
    await expect(zernioAggregator.connectStatus("reddit")).resolves.toMatchObject({ connected: true });
  });
});

describe("connectStatus naming", () => {
  it("prefers the vendor's display name for operator-facing text", async () => {
    mockFetch(() => ({ json: ALL_ACCOUNTS }));
    await expect(zernioAggregator.connectStatus("reddit")).resolves.toMatchObject({
      displayName: "r/examplebrand",
    });
  });

  it("falls back to the username, then to a constructed label", async () => {
    mockFetch(() => ({ json: ALL_ACCOUNTS }));
    await expect(zernioAggregator.connectStatus("twitter")).resolves.toMatchObject({
      displayName: "examplebrand",
    });

    resetZernioAccounts();
    mockFetch(() => ({ json: { accounts: [{ _id: "acc_bare", platform: "bluesky" }] } }));
    await expect(zernioAggregator.connectStatus("bluesky")).resolves.toMatchObject({
      accountId: "acc_bare",
      displayName: `bluesky via ${ZERNIO_ID}`,
    });
  });

  it("reports the deactivated account as disconnected, naming the platform", async () => {
    // isActive: false is a real state in Zernio's dashboard (a lapsed OAuth
    // grant), and publishing to it fails at the vendor.
    mockFetch(() => ({ json: ALL_ACCOUNTS }));
    const status = await zernioAggregator.connectStatus("instagram");
    expect(status).toMatchObject({ connected: false, accountId: "" });
    expect(status.reason).toMatch(/no active Zernio account is connected for instagram/);
  });
});

/* -------------------------------------------------------------------------- */
/*  postFacts, the remaining shapes                                            */
/* -------------------------------------------------------------------------- */

describe("postFacts response shapes", () => {
  it("reads a post-level failure with no per-platform leg as ERROR", async () => {
    // Zernio can fail the whole post (a rejected payload) with no leg to point
    // at; treating that as pending would strand the draft forever.
    mockFetch(() => ({ json: { post: { _id: "zp_1", status: "failed" } } }));
    const out = await zernioAggregator.postFacts("reddit", ["zp_1~a"]);
    expect(out.get("zp_1~a")).toMatchObject({ state: "ERROR", released: false, platform: "reddit" });
  });

  it("reads a post with no platforms array at all as pending", async () => {
    mockFetch(() => ({ json: { post: { _id: "zp_1", status: "scheduled" } } }));
    const facts = (await zernioAggregator.postFacts("reddit", ["zp_1~a"])).get("zp_1~a");
    expect(facts).toMatchObject({ state: "QUEUE", released: false });
    // `absent` stays unset: the post exists, we simply cannot see its leg yet.
    expect(facts!.absent).toBeUndefined();
  });

  it("ignores a leg for a DIFFERENT platform on the same post", async () => {
    // A multi-target Zernio post carries several legs; matching the wrong one
    // would report Reddit as published because X was.
    mockFetch(() => ({
      json: {
        post: {
          _id: "zp_1",
          status: "published",
          platforms: [{ platform: "twitter", status: "published" }],
        },
      },
    }));
    expect((await zernioAggregator.postFacts("reddit", ["zp_1~a"])).get("zp_1~a")).toMatchObject({
      state: "QUEUE",
    });
  });

  it("reads each ref independently, so one bad leg does not blank the batch", async () => {
    mockFetch((url) => {
      if (url.includes("zp_ok")) {
        return { json: { post: { _id: "zp_ok", platforms: [{ platform: "reddit", status: "published" }] } } };
      }
      if (url.includes("zp_gone")) return { status: 404, json: { error: "not found" } };
      return { status: 500, json: { error: "boom" } };
    });

    const out = await zernioAggregator.postFacts("reddit", ["zp_ok~a", "zp_gone~b", "zp_err~c"]);

    expect(out.get("zp_ok~a")).toMatchObject({ state: "PUBLISHED", released: true });
    expect(out.get("zp_gone~b")).toMatchObject({ state: "QUEUE", absent: true });
    // Silence for the unreachable one: one broken credential must not mark live
    // posts dead.
    expect(out.has("zp_err~c")).toBe(false);
    expect(out.size).toBe(2);
  });

  it("returns an empty map for an empty ref list without calling the vendor", async () => {
    mockFetch(() => ({ json: {} }));
    expect((await zernioAggregator.postFacts("reddit", [])).size).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/*  Analytics                                                                  */
/* -------------------------------------------------------------------------- */

const ANALYTICS = {
  posts: [
    {
      _id: "zp_1",
      status: "published",
      analytics: { impressions: 10, likes: 1 },
      platforms: [
        { platform: "reddit", status: "published", analytics: { impressions: 0, likes: 4, comments: 2 } },
        { platform: "twitter", status: "published", analytics: { impressions: 500, likes: 9 } },
      ],
    },
    {
      _id: "zp_2",
      status: "published",
      platforms: [
        { platform: "reddit", status: "published", analytics: { likes: 6, comments: 1 } },
        { platform: "reddit", status: "failed", analytics: { likes: 999 } },
      ],
    },
    { _id: "zp_3", analytics: { likes: 3 } },
  ],
};

describe("analyticsPost", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("matches on the ZERNIO half of the ref and prefers the per-platform leg", async () => {
    // ⚠️ The report keys posts by Zernio's `_id`; the native id lives only on the
    // leg, so matching on it would miss anything the vendor has not synced yet.
    mockFetch(() => ({ json: ANALYTICS }));
    await expect(zernioAggregator.analyticsPost!("reddit", "zp_1~t3_abc")).resolves.toEqual({
      impressions: 0,
      likes: 4,
      comments: 2,
    });
  });

  it("keeps a zero counter rather than dropping it", async () => {
    // Reddit reports impressions: 0 on every post because the vendor does not
    // expose it to this API at all. Omitting it would read as "not measured yet"
    // instead of "never available".
    mockFetch(() => ({ json: ANALYTICS }));
    const out = await zernioAggregator.analyticsPost!("reddit", "zp_1~t3_abc");
    expect(Object.keys(out)).toContain("impressions");
    expect(out.impressions).toBe(0);
  });

  it("falls back to the post-level counters when the platform has no leg", async () => {
    mockFetch(() => ({ json: ANALYTICS }));
    await expect(zernioAggregator.analyticsPost!("bluesky", "zp_1~x")).resolves.toEqual({
      impressions: 10,
      likes: 1,
    });
  });

  it("answers empty for a post the report does not mention", async () => {
    mockFetch(() => ({ json: ANALYTICS }));
    await expect(zernioAggregator.analyticsPost!("reddit", "zp_missing~x")).resolves.toEqual({});
  });

  it("drops non-numeric and non-finite values so a counters map stays numeric", async () => {
    mockFetch(() => ({
      json: {
        posts: [
          {
            _id: "zp_1",
            platforms: [
              {
                platform: "reddit",
                analytics: { likes: 5, impressions: null, reach: "1200", views: undefined, clicks: NaN },
              },
            ],
          },
        ],
      },
    }));
    await expect(zernioAggregator.analyticsPost!("reddit", "zp_1~a")).resolves.toEqual({ likes: 5 });
  });

  it("answers empty rather than throwing when the report carries no posts", async () => {
    mockFetch(() => ({ json: {} }));
    await expect(zernioAggregator.analyticsPost!("reddit", "zp_1~a")).resolves.toEqual({});
  });

  it("serves every leg from one memoised report", async () => {
    // ⚠️ Analytics carries its own per-SECOND cap and this one endpoint serves
    // every post, so a per-leg call would burn the budget re-answering the same
    // question.
    mockFetch(() => ({ json: ANALYTICS }));
    await zernioAggregator.analyticsPost!("reddit", "zp_1~a");
    await zernioAggregator.analyticsPost!("reddit", "zp_2~b");
    await zernioAggregator.analyticsChannel!("reddit");
    expect(calls.filter((c) => c.url.includes("/analytics"))).toHaveLength(1);
  });

  it("coalesces concurrent analytics callers onto one request", async () => {
    mockFetch(() => ({ json: ANALYTICS }));
    await Promise.all([
      zernioAggregator.analyticsPost!("reddit", "zp_1~a"),
      zernioAggregator.analyticsPost!("reddit", "zp_2~b"),
      zernioAggregator.analyticsChannel!("twitter"),
    ]);
    expect(calls.filter((c) => c.url.includes("/analytics"))).toHaveLength(1);
  });

  it("re-reads after the 10 minute TTL, which matches the vendor's own sync", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-06T12:00:00Z"));
    mockFetch(() => ({ json: ANALYTICS }));

    await zernioAggregator.analyticsPost!("reddit", "zp_1~a");
    vi.setSystemTime(new Date("2026-08-06T12:09:00Z"));
    await zernioAggregator.analyticsPost!("reddit", "zp_1~a");
    expect(calls.filter((c) => c.url.includes("/analytics"))).toHaveLength(1);

    vi.setSystemTime(new Date("2026-08-06T12:10:01Z"));
    await zernioAggregator.analyticsPost!("reddit", "zp_1~a");
    expect(calls.filter((c) => c.url.includes("/analytics"))).toHaveLength(2);
  });

  it("drops the memo on reset, so a reconnect is not served stale numbers", async () => {
    mockFetch(() => ({ json: ANALYTICS }));
    await zernioAggregator.analyticsPost!("reddit", "zp_1~a");
    resetZernioAccounts();
    await zernioAggregator.analyticsPost!("reddit", "zp_1~a");
    expect(calls.filter((c) => c.url.includes("/analytics"))).toHaveLength(2);
  });
});

describe("analyticsChannel", () => {
  it("sums PUBLISHED legs for the one platform and counts the posts", async () => {
    // ⚠️ A sum of posts, not a channel-level read: Zernio exposes no audience
    // endpoint, so this is engagement we can actually observe. followerStats is
    // deliberately absent rather than invented.
    mockFetch(() => ({ json: ANALYTICS }));
    await expect(zernioAggregator.analyticsChannel!("reddit")).resolves.toEqual({
      posts: 2,
      impressions: 0,
      likes: 10,
      comments: 3,
    });
    expect(zernioAggregator.followerStats).toBeUndefined();
  });

  it("ignores a failed leg, so an unpublished attempt cannot inflate the totals", async () => {
    mockFetch(() => ({ json: ANALYTICS }));
    const out = await zernioAggregator.analyticsChannel!("reddit");
    expect(out.likes).toBe(10);
    expect(out.likes).not.toBe(1009);
  });

  it("keeps each platform's totals separate", async () => {
    mockFetch(() => ({ json: ANALYTICS }));
    await expect(zernioAggregator.analyticsChannel!("twitter")).resolves.toEqual({
      posts: 1,
      impressions: 500,
      likes: 9,
    });
  });

  it("reports zero posts rather than nothing for a platform with no history", async () => {
    // The shape matters: analytics/route.ts feature-detects the METHOD, so an
    // empty object here would look like a wired-but-broken channel.
    mockFetch(() => ({ json: ANALYTICS }));
    await expect(zernioAggregator.analyticsChannel!("bluesky")).resolves.toEqual({ posts: 0 });
  });

  it("survives a report with no posts key and one with no legs", async () => {
    mockFetch(() => ({ json: { overview: { totalPosts: 0 } } }));
    await expect(zernioAggregator.analyticsChannel!("reddit")).resolves.toEqual({ posts: 0 });

    resetZernioAccounts();
    mockFetch(() => ({ json: { posts: [{ _id: "zp_1", status: "published" }] } }));
    await expect(zernioAggregator.analyticsChannel!("reddit")).resolves.toEqual({ posts: 0 });
  });

  it("propagates a vendor failure instead of reporting zeros as measured", async () => {
    // Zeros here would be indistinguishable from a real quiet channel.
    mockFetch(() => ({ status: 500, json: { error: "analytics down" } }));
    await expect(zernioAggregator.analyticsChannel!("reddit")).rejects.toThrow(/analytics down/);
  });
});

/* -------------------------------------------------------------------------- */
/*  Per-destination lookups                                                    */
/* -------------------------------------------------------------------------- */

describe("listBoards", () => {
  it("returns nothing for a platform without boards, without calling the vendor", async () => {
    mockFetch(() => ({ json: {} }));
    await expect(zernioAggregator.listBoards!("reddit")).resolves.toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("lists the Pinterest boards for the connected account", async () => {
    mockAccountsAnd(ALL_ACCOUNTS, () => ({
      json: { boards: [{ id: "b1", name: "Small business" }, { id: "b2" }] },
    }));

    await expect(zernioAggregator.listBoards!("pinterest")).resolves.toEqual([
      { id: "b1", name: "Small business" },
      // A nameless board falls back to its id rather than rendering "undefined".
      { id: "b2", name: "b2" },
    ]);
    expect(calls.at(-1)!.url).toContain("/accounts/acc_pin/pinterest-boards");
  });

  it("throws when no Pinterest account is connected, rather than answering empty", async () => {
    // An empty list would read as "this account has no boards", which is a
    // different (and unfixable-looking) problem from "connect Pinterest".
    mockFetch(() => ({ json: { accounts: [] } }));
    await expect(zernioAggregator.listBoards!("pinterest")).rejects.toThrow(/no active Zernio account/);
  });

  it("surfaces an empty board list as an empty array", async () => {
    mockAccountsAnd(ALL_ACCOUNTS, () => ({ json: {} }));
    await expect(zernioAggregator.listBoards!("pinterest")).resolves.toEqual([]);
  });
});

describe("destinationRules", () => {
  it("returns nothing for a non-Reddit platform or a missing destination", async () => {
    mockFetch(() => ({ json: {} }));
    await expect(zernioAggregator.destinationRules!("pinterest", "board")).resolves.toEqual({});
    await expect(zernioAggregator.destinationRules!("reddit", "")).resolves.toEqual({});
    expect(calls).toHaveLength(0);
  });

  it("maps the subreddit's flairs into the shape readSubredditRules consumes", async () => {
    mockAccountsAnd(ALL_ACCOUNTS, () => ({
      json: { flairs: [{ id: "f1", text: "News" }, { id: "f2", text: "Discussion" }] },
    }));

    await expect(zernioAggregator.destinationRules!("reddit", "smallbusiness")).resolves.toEqual({
      subreddit: "smallbusiness",
      flairs: [
        { id: "f1", name: "News" },
        { id: "f2", name: "Discussion" },
      ],
    });
    expect(calls.at(-1)!.url).toContain("reddit-flairs?subreddit=smallbusiness");
  });

  /**
   * ⚠️ A missing field must mean "unknown", never "not required". The flair list
   * needs scopes the account may not carry, and claiming no flairs are available
   * would let a post go out that the subreddit rejects for lacking one.
   */
  it("omits flairs entirely when the lookup fails, rather than claiming there are none", async () => {
    mockAccountsAnd(ALL_ACCOUNTS, () => ({ status: 403, json: { error: "insufficient scope" } }));
    const rules = await zernioAggregator.destinationRules!("reddit", "smallbusiness");
    expect(rules).toEqual({ subreddit: "smallbusiness" });
    expect("flairs" in rules).toBe(false);
  });

  it("reports an empty flair list as empty, which is a different answer", async () => {
    mockAccountsAnd(ALL_ACCOUNTS, () => ({ json: { flairs: [] } }));
    await expect(zernioAggregator.destinationRules!("reddit", "smallbusiness")).resolves.toEqual({
      subreddit: "smallbusiness",
      flairs: [],
    });
  });

  it("does not swallow a missing Reddit account, which is fixable and worth saying", async () => {
    mockFetch(() => ({ json: { accounts: [] } }));
    await expect(zernioAggregator.destinationRules!("reddit", "smallbusiness")).rejects.toThrow(
      /no active Zernio account/,
    );
  });
});

describe("channelRules coverage of every routed platform", () => {
  it("declares limits for every platform platforms() reports", () => {
    // A platform routed here with no entry is a wiring bug that would otherwise
    // surface as a thrown error mid-publish.
    for (const platform of zernioAggregator.platforms()) {
      const rules = zernioAggregator.channelRules(platform);
      expect(rules.maxLength).toBeGreaterThan(0);
      expect(["utf16", "grapheme", "weighted", "utf8bytes"]).toContain(rules.countMode);
    }
  });

  it("counts YouTube's description in UTF-8 BYTES, not code units", () => {
    // The numbers match (5000 vs 5000) so utf16 looked right; non-ASCII copy
    // passed QA and was then silently truncated at publish.
    expect(zernioAggregator.channelRules("youtube")).toMatchObject({
      maxLength: 5_000,
      countMode: "utf8bytes",
    });
  });

  it("declares Instagram's JPEG-only image constraint, which media-fit enforces", () => {
    expect(zernioAggregator.channelRules("instagram").imageFormats).toEqual(["image/jpeg"]);
  });
});

describe("degenerate inputs and non-ZernioError failures", () => {
  it("sends an empty Reddit payload when the draft resolved no destination", async () => {
    // Zernio then defaults the title to the first line of the body. Worse than
    // the draft's own title, but it must not be blocked here: the destination
    // resolver upstream owns that decision.
    mockAccountsAnd(ALL_ACCOUNTS, () => PUBLISHED("zp_1", "reddit", "t3_a"));
    await zernioAggregator.publishNow("reddit", publishInput({ destination: {} }));
    const create = calls.find((c) => c.method === "POST")!;
    const target = (create.body as { platforms: Array<{ platformSpecificData: unknown }> }).platforms[0]!;
    expect(target.platformSpecificData).toEqual({});
  });

  it("names the platform when a failed leg carries no error message", async () => {
    // Zernio does not always populate `error` on a rejected leg, and "undefined"
    // in the operator's failure log is worse than a generic sentence.
    mockAccountsAnd(ALL_ACCOUNTS, () => ({
      json: { post: { _id: "zp_1", status: "failed", platforms: [{ platform: "reddit", status: "failed" }] } },
    }));
    await expect(zernioAggregator.publishNow("reddit", publishInput())).rejects.toThrow(
      /^reddit rejected the post$/,
    );
  });

  it("still reports disconnected when the rejection is not an Error at all", async () => {
    // connectStatus is contractually forbidden from throwing; a non-Error
    // rejection (some agents/undici internals) must not sneak past the guard and
    // take out connectedAccounts for every platform at once.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject("socket hang up")),
    );
    const status = await zernioAggregator.connectStatus("reddit");
    expect(status.connected).toBe(false);
    expect(status.reason).toBe("socket hang up");
  });

  it("rethrows a transport failure on delete instead of reporting it as gone", async () => {
    // Idempotence is about the POST being absent, not about the request failing.
    // Swallowing this would drop the leg from providerPostId while the post is
    // still live on the platform, and nothing would ever look again.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("fetch failed"))),
    );
    await expect(zernioAggregator.deletePost("reddit", "zp_1~t3_abc")).rejects.toThrow(/fetch failed/);
  });
});

describe("X threads through Zernio", () => {
  function sentTarget(): { platformSpecificData: Record<string, unknown> } {
    const create = calls.find((c) => c.method === "POST")!;
    return (create.body as { platforms: Array<{ platformSpecificData: Record<string, unknown> }> }).platforms[0]!;
  }
  function sentTopLevel(): Record<string, unknown> {
    return calls.find((c) => c.method === "POST")!.body as Record<string, unknown>;
  }

  it("⛔ forwards the thread root-first, with the media on the root, so the link reply actually exists", async () => {
    // Before this, `content` alone was sent: the root landed on X and the reply
    // holding the URL (which the playbook moved out of the body on purpose)
    // never existed, and the leg still reported a real native id.
    mockAccountsAnd(ALL_ACCOUNTS, () => PUBLISHED("zp_x", "twitter", "1700000000"));
    await zernioAggregator.publishNow(
      "twitter",
      publishInput({
        render: {
          platform: "twitter",
          content: "Root tweet, no link here",
          threadItems: ["Read it: https://example.com/news/x"],
          mediaIndices: [0],
        },
        media: [{ path: "/tmp/card.jpeg", type: "image", mimeType: "image/jpeg", url: "https://media.example.com/card.jpeg", altText: "card" } as never],
        destination: {},
      }),
    );
    expect(sentTarget().platformSpecificData).toEqual({
      threadItems: [
        { content: "Root tweet, no link here", mediaItems: [{ type: "image", url: "https://media.example.com/card.jpeg", altText: "card" }] },
        { content: "Read it: https://example.com/news/x" },
      ],
    });
    // The media is on the root item and NOT also at the top level, so the root
    // cannot end up with the card twice.
    expect(sentTopLevel().mediaItems).toBeUndefined();
    expect(sentTopLevel().content).toBe("Root tweet, no link here");
  });

  it("sends a plain X post the old way when there is nothing to thread", async () => {
    mockAccountsAnd(ALL_ACCOUNTS, () => PUBLISHED("zp_x", "twitter", "1700000001"));
    await zernioAggregator.publishNow(
      "twitter",
      publishInput({
        render: { platform: "twitter", content: "Just a tweet", mediaIndices: [0] },
        media: [{ path: "/tmp/card.jpeg", type: "image", mimeType: "image/jpeg", url: "https://media.example.com/card.jpeg" } as never],
        destination: {},
      }),
    );
    expect(sentTarget().platformSpecificData).toEqual({});
    expect(sentTopLevel().mediaItems).toEqual([{ type: "image", url: "https://media.example.com/card.jpeg" }]);
  });
});

describe("platformSpecificData: X threads and platforms with no options", () => {
  function sentBody(): Record<string, unknown> {
    const create = calls.find((c) => c.method === "POST")!;
    return (create.body as { platforms: Array<{ platformSpecificData: Record<string, unknown> }> }).platforms[0]!
      .platformSpecificData;
  }

  it("spells out a text-only X thread root first, with no mediaItems key on the root", async () => {
    mockAccountsAnd(ALL_ACCOUNTS, () => PUBLISHED("zp_t", "twitter", "1"));
    await zernioAggregator.publishNow(
      "twitter",
      publishInput({
        render: { platform: "twitter", content: "root", threadItems: ["reply one"], mediaIndices: [] },
        destination: {},
      }),
    );
    expect(sentBody()).toEqual({
      threadItems: [{ content: "root" }, { content: "reply one" }],
    });
  });

  it("sends an empty options object for LinkedIn, which has no bespoke fields", async () => {
    mockAccountsAnd(ALL_ACCOUNTS, () => PUBLISHED("zp_l", "linkedin", "urn:li:share:1"));
    await zernioAggregator.publishNow(
      "linkedin",
      publishInput({
        render: { platform: "linkedin", content: "post", mediaIndices: [] },
        destination: { subreddit: "ignored", title: "ignored" },
      }),
    );
    expect(sentBody()).toEqual({});
  });
});
