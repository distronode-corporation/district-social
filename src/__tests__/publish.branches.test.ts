import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The publish path's edges: what the transport is actually TOLD, what happens
 * when a per-destination lookup cannot answer, and what a failure that is not an
 * `Error` leaves behind.
 *
 * `publish.test.ts` covers the guards and the bookkeeping. This file covers the
 * places where publish is a translator rather than a gatekeeper, and every one
 * of them has the same failure shape: nothing throws, a post goes out, and it is
 * WRONG in a way nobody can see from our side.
 *
 *   - `publishDestination` is the only thing that fills a Pinterest board, a
 *     pin's click-through link, a Reddit title and flair, and a YouTube title.
 *     A dropped field there is a pin that goes nowhere or a Reddit submission
 *     rejected for a missing field, reported by the vendor as a bare error.
 *   - The Reddit-rules and Pinterest-boards lookups exist to STOP a publish
 *     being refused. If the lookup itself starts refusing publishes it has
 *     inverted its own purpose, so every way it can fail has to degrade to
 *     "publish on the defaults".
 *   - A vendor client that rejects with a string rather than an `Error` is
 *     common (a thrown fetch body, a rejected promise from a hand-rolled SDK).
 *     Read carelessly that becomes `lastError: "bluesky: undefined"`, which
 *     tells an operator nothing at all.
 */

vi.mock("../media.js", () => ({
  ensureUploaded: vi.fn(async (asset: { path: string; url?: string }) => {
    asset.url ??= `https://cdn.example.test/${asset.path.split("/").pop()}`;
    return asset;
  }),
}));

import { ensureUploaded } from "../media.js";
import { BlueskyError } from "../bluesky.js";
import {
  assertPinterestBoard,
  assertPublishable,
  connectedAccounts,
  invalidateConnectedAccounts,
  publishDestination,
  publishDraft,
  PublishNotSentError,
  resolveRedditRestrictions,
  type ConnectedMap,
} from "../publish.js";
import {
  registerAggregator,
  registerTransport,
  resetTransports,
  setTransportOverridesResolver,
} from "../transport.js";
import type { Aggregator, DirectTransport } from "../transport.js";
import type { Draft, MediaAsset, Platform, PlatformRender, SourcePost } from "../types.js";

const publishNow = vi.fn<DirectTransport["publishNow"]>(async () => ({ ref: "post-1" }));
const connectStatus = vi.fn<DirectTransport["connectStatus"]>(async () => ({
  connected: true,
  accountId: "acct-1",
  displayName: "Acme",
}));

function fakeTransport(platform: Platform): DirectTransport {
  return {
    platform,
    channelRules: () => ({ maxLength: 40000, countMode: "utf16" }),
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

function source(overrides: Partial<SourcePost> = {}): SourcePost {
  return { text: "Body text", hashtags: [], media: [], ...overrides };
}

function image(path = "/tmp/a.jpg"): MediaAsset {
  return { path, type: "image", mimeType: "image/jpeg", size: 1000 };
}

function draft(overrides: Partial<Draft> = {}): Draft {
  return {
    id: "d1",
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
    status: "draft",
    source: source(),
    targets: [],
    renders: [],
    ...overrides,
  };
}

/** The connected map the publish path builds, in the shape the helpers take. */
function connected(...platforms: Platform[]): ConnectedMap {
  return Object.fromEntries(
    platforms.map((p) => [p, { accountId: `acct-${p}`, displayName: `Acme ${p}` }]),
  );
}

const FUTURE = new Date(Date.now() + 3_600_000).toISOString();

/** Silence and capture the "publishing on defaults" warnings. Typed by inference. */
function spyWarn() {
  return vi.spyOn(console, "warn").mockImplementation(() => {});
}
let warn: ReturnType<typeof spyWarn>;

beforeEach(() => {
  vi.clearAllMocks();
  invalidateConnectedAccounts();
  resetTransports();
  // ⚠️ `clearAllMocks` empties `mock.calls` but LEAVES the implementation, so a
  // test that made ensureUploaded throw would keep throwing for every test
  // after it. Re-seed the default rather than relying on ordering.
  (ensureUploaded as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    async (asset: MediaAsset) => {
      asset.url ??= `https://cdn.example.test/${asset.path.split("/").pop()}`;
      return asset;
    },
  );
  publishNow.mockResolvedValue({ ref: "post-1" });
  connectStatus.mockResolvedValue({
    connected: true,
    accountId: "acct-1",
    displayName: "Acme",
  });
  warn = spyWarn();
  process.env.SOCIALMETA_TRANSPORT_OVERRIDES = JSON.stringify({
    bluesky: "direct",
    reddit: "direct",
    pinterest: "direct",
  });
  registerTransport(fakeTransport("bluesky"));
});

afterEach(() => {
  warn.mockRestore();
  resetTransports();
  delete process.env.SOCIALMETA_TRANSPORT_OVERRIDES;
  delete process.env.SOCIALMETA_DEFAULT_SUBREDDIT;
  delete process.env.SOCIALMETA_DEFAULT_PINTEREST_BOARD;
  invalidateConnectedAccounts();
});

/* -------------------------------------------------------------------------- */
/* publishDestination: the fields only this function can fill                  */
/* -------------------------------------------------------------------------- */

describe("what publishDestination hands a Pinterest publish", () => {
  it("prefers the render's own board and title, and carries the source link", () => {
    const dest = publishDestination(
      render({ platform: "pinterest", title: "T".repeat(140), board: { id: "board-render" } }),
      source({ link: "https://example.com/district", title: "Source title" }),
    );

    expect(dest.board).toBe("board-render");
    // ⛔ THE LINK IS ITS OWN FIELD AND THIS IS THE ONLY PLACE IT IS SET. The
    // Pinterest playbook strips URLs out of the copy precisely because the
    // click-through is meant to travel here. A pin published without it
    // succeeds and goes nowhere.
    expect(dest.link).toBe("https://example.com/district");
    expect(dest.title).toHaveLength(100);
  });

  it("falls back to the Social HQ default board and the source's title", () => {
    process.env.SOCIALMETA_DEFAULT_PINTEREST_BOARD = "board-default";

    const dest = publishDestination(
      render({ platform: "pinterest" }),
      source({ title: "Source title", link: "https://example.com" }),
    );

    expect(dest.board).toBe("board-default");
    expect(dest.title).toBe("Source title");
  });

  it("OMITS link and title entirely rather than sending empty ones", () => {
    process.env.SOCIALMETA_DEFAULT_PINTEREST_BOARD = "board-default";

    const dest = publishDestination(render({ platform: "pinterest" }), source());

    // ⚠️ Assert on key PRESENCE, not on the value. The spread form
    // (`...(x ? {k: v} : {})`) exists so the key is absent; asserting
    // `dest.link === undefined` passes either way and would let a future
    // `link: source.link` refactor through, which sends `link: undefined` to a
    // vendor that treats a present-but-empty field as a clear.
    expect("link" in dest).toBe(false);
    expect("title" in dest).toBe(false);
    expect(dest.board).toBe("board-default");
  });

  /**
   * A pin links straight to the post, with the UTMs its tracked link would have
   * carried (Pinterest blocks or warns on redirecting links).
   * The stamp is used only while it still points at the post's link.
   */
  const POST = "https://example.ca/fr/blog/x?ref=a";
  const STAMP = `${POST}&utm_source=pinterest&utm_medium=social&utm_campaign=socialhq_1&utm_content=pinCode`;

  it("sends the render's pinLink, UTMs and all, while it points at the post's link", () => {
    const dest = publishDestination(render({ platform: "pinterest", pinLink: STAMP }), source({ link: POST }));
    expect(dest.link).toBe(STAMP);
  });

  it("sends the plain link when the render carries no pinLink", () => {
    const dest = publishDestination(render({ platform: "pinterest" }), source({ link: POST }));
    expect(dest.link).toBe(POST);
  });

  // ensureDraftLinks does nothing once the link stops being trackable, so the
  // old stamp survives an edit to source.link. It must not win over the edit.
  it("ignores a stale pinLink stamped for a previous link", () => {
    const dest = publishDestination(
      render({ platform: "pinterest", pinLink: STAMP }),
      source({ link: "https://example.org/elsewhere" }),
    );
    expect(dest.link).toBe("https://example.org/elsewhere");
  });

  it("falls back to the link when either side does not parse", () => {
    expect(
      publishDestination(render({ platform: "pinterest", pinLink: "not a url" }), source({ link: POST })).link,
    ).toBe(POST);
    expect(
      publishDestination(render({ platform: "pinterest", pinLink: STAMP }), source({ link: "not a url" })).link,
    ).toBe("not a url");
  });

  it("gives no other platform a link from pinLink", () => {
    for (const platform of ["reddit", "bluesky", "facebook"] as const) {
      const dest = publishDestination(render({ platform, pinLink: STAMP }), source({ link: POST }));
      expect("link" in dest).toBe(false);
    }
  });
});

describe("what publishDestination hands a Reddit publish", () => {
  it("caps the title at Reddit's 300 and passes the flair through", () => {
    // ⛔ TITLE IS REQUIRED BY REDDIT ON EVERY SUBMISSION KIND. Nothing else
    // populates it, so a draft whose render carries no title of its own used to
    // fail with a vendor error about a missing field rather than about the
    // missing default.
    const dest = publishDestination(
      render({
        platform: "reddit",
        subreddit: "r/SmallBusiness/",
        title: "T".repeat(400),
        flair: { id: "f1", name: "Discussion" },
      }),
      source(),
    );

    expect(dest.subreddit).toBe("smallbusiness");
    expect(dest.title).toHaveLength(300);
    expect(dest.flair).toEqual({ id: "f1", name: "Discussion" });
  });

  it("never sets link on Reddit, even when the source has one", () => {
    const dest = publishDestination(
      render({ platform: "reddit", subreddit: "smallbusiness" }),
      source({ link: "https://example.com" }),
    );

    // ⛔ Reddit models a link post and a self post as DIFFERENT THINGS: a link
    // post has a URL and no body. Populating `link` here turns every Reddit
    // publish into a body-less link submission and silently discards the copy.
    expect("link" in dest).toBe(false);
  });

  it("leaves subreddit undefined, not null, when nothing names one", () => {
    // ⚠️ `normalizeSubreddit` answers `undefined` for junk and for nothing at
    // all, and the `?? undefined` is what keeps that from reaching a transport
    // as a null it would have to special-case. The REFUSAL for a missing
    // subreddit is assertPublishable's job, not this function's.
    const dest = publishDestination(render({ platform: "reddit", subreddit: "  /  " }), source());

    expect(dest.subreddit).toBeUndefined();
  });
});

describe("what publishDestination hands a YouTube publish", () => {
  it("titles the upload from the render, then the source, then the body's first 90 characters", () => {
    const body = "B".repeat(200);

    expect(
      publishDestination(render({ platform: "youtube", title: "Render title", content: body }), source({ title: "Source title" })).title,
    ).toBe("Render title");

    expect(
      publishDestination(render({ platform: "youtube", content: body }), source({ title: "Source title" })).title,
    ).toBe("Source title");

    // The last resort. YouTube refuses an upload with no title at all, so there
    // is no "leave it empty" option here the way there is for Pinterest.
    expect(publishDestination(render({ platform: "youtube", content: body }), source()).title).toHaveLength(90);
  });
});

/* -------------------------------------------------------------------------- */
/* Reddit restrictions: a lookup that must never become a refusal              */
/* -------------------------------------------------------------------------- */

describe("resolving what the target subreddit accepts", () => {
  function redditTransport(rules: DirectTransport["destinationRules"]): DirectTransport {
    return { ...fakeTransport("reddit"), destinationRules: rules };
  }

  it("asks about the Social HQ default subreddit when the render does not name one", async () => {
    process.env.SOCIALMETA_DEFAULT_SUBREDDIT = "SmallBusiness";
    // ⚠️ Typed to the interface member, not left to inference: a zero-argument
    // `vi.fn(async () => x)` types `mock.calls[0]` as a length-0 tuple, and the
    // argument assertion below is the whole point of this test.
    const destinationRules = vi.fn<NonNullable<DirectTransport["destinationRules"]>>(async () => ({
      allowSelf: true,
    }));
    registerTransport(redditTransport(destinationRules));

    const out = await resolveRedditRestrictions([render({ platform: "reddit" })], connected("reddit"));

    // Normalised on the way in, so the default may be written however the
    // operator typed it into settings.
    expect(destinationRules).toHaveBeenCalledWith("smallbusiness");
    expect(out?.subreddit).toBe("smallbusiness");
  });

  it("answers nothing, and asks nobody, when no subreddit is configured anywhere", async () => {
    const destinationRules = vi.fn<NonNullable<DirectTransport["destinationRules"]>>(async () => ({}));
    registerTransport(redditTransport(destinationRules));

    const out = await resolveRedditRestrictions([render({ platform: "reddit" })], connected("reddit"));

    expect(out).toBeNull();
    expect(destinationRules).not.toHaveBeenCalled();
    // ⛔ The refusal for a missing subreddit belongs to assertPublishable,
    // which words it in terms of what to SET. This lookup returning null is
    // what lets that message be the one the operator sees.
    expect(() =>
      assertPublishable(render({ platform: "reddit" }), draft(), null),
    ).toThrow(/needs a target subreddit/);
  });

  it("leaves link out of the allow list when the subreddit refuses link posts", async () => {
    registerTransport(redditTransport(async () => ({ allowSelf: true, allowLink: false })));

    const out = await resolveRedditRestrictions(
      [render({ platform: "reddit", subreddit: "smallbusiness" })],
      connected("reddit"),
    );

    // ⚠️ A MISSING FIELD MEANS "UNKNOWN", NEVER "NOT ALLOWED": the reads behind
    // `allowLink` need scopes the token may not carry, so only an explicit
    // `false` removes a kind. Flipping that default would refuse publishes on
    // subreddits nobody has a reading for.
    expect(out?.allow).toEqual(["self"]);
    // ⛔ "media" is never allowed regardless of the subreddit, because
    // reddit-transport refuses all media publishing outright. Claiming it here
    // would silence the `subreddit-no-media` QA warning for every subreddit.
    expect(out?.allow).not.toContain("media");
  });

  it("reports a mandatory flair with no list when the token could not read the flairs", async () => {
    registerTransport(redditTransport(async () => ({ isFlairRequired: true })));

    const out = await resolveRedditRestrictions(
      [render({ platform: "reddit", subreddit: "smallbusiness" })],
      connected("reddit"),
    );

    expect(out).toMatchObject({ isFlairRequired: true, flairs: [] });
    // The refusal still has to be actionable with no names to offer, so it ends
    // at "Set one on the draft." rather than trailing an empty "available:".
    expect(() =>
      assertPublishable(render({ platform: "reddit", subreddit: "smallbusiness" }), draft(), out),
    ).toThrow(/requires a post flair\. Set one on the draft\.$/);
  });

  it("publishes on the defaults when the rules lookup rejects with a bare string", async () => {
    // A hand-rolled vendor client rejecting with its response body rather than
    // an Error. `err.message` is undefined on those, so the warning has to fall
    // back to the value itself or the operator learns nothing from the log.
    registerTransport(
      redditTransport(async () => {
        throw "reddit 503 Service Unavailable";
      }),
    );

    const out = await resolveRedditRestrictions(
      [render({ platform: "reddit", subreddit: "smallbusiness" })],
      connected("reddit"),
    );

    expect(out).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("r/smallbusiness"), "reddit 503 Service Unavailable");
  });

  it("allows a single-image Reddit draft when the subreddit's rules could not be read", () => {
    // ⛔ THE LOOKUP IS AN ENHANCEMENT AND MUST NOT BECOME A NEW WAY TO FAIL.
    // With no restrictions loaded this keeps the pre-lookup behaviour, so a
    // Reddit outage cannot start refusing drafts that used to publish.
    const d = draft({ source: source({ media: [image()] }) });

    expect(() =>
      assertPublishable(
        render({ platform: "reddit", subreddit: "smallbusiness", mediaIndices: [0] }),
        d,
        null,
      ),
    ).not.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* Pinterest boards: the same rule, the other vendor                          */
/* -------------------------------------------------------------------------- */

describe("asserting a Pinterest board exists", () => {
  it("skips the check entirely when the route's transport cannot list boards", async () => {
    // ⚠️ `listBoards` is OPTIONAL on the transport interface, and an
    // aggregator-bound view of Pinterest does not carry it. Treating a missing
    // method as "no boards" would refuse every Pinterest publish with "the
    // account has no boards", which looks like a Pinterest problem and is not.
    registerTransport(fakeTransport("pinterest"));

    await expect(
      assertPinterestBoard(
        [render({ platform: "pinterest", board: { id: "board-1" } })],
        connected("pinterest"),
      ),
    ).resolves.toBeUndefined();
  });

  it("publishes on the defaults when the boards lookup rejects with a bare string", async () => {
    registerTransport({
      ...fakeTransport("pinterest"),
      listBoards: async () => {
        throw "pinterest 429";
      },
    });

    await expect(
      assertPinterestBoard(
        [render({ platform: "pinterest", board: { id: "board-1" } })],
        connected("pinterest"),
      ),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Pinterest boards"), "pinterest 429");
  });
});

/* -------------------------------------------------------------------------- */
/* Failures that are not Error instances                                      */
/* -------------------------------------------------------------------------- */

describe("a failure that is not an Error", () => {
  it("records the transport's own words on the leg rather than 'undefined'", async () => {
    publishNow.mockImplementation(async () => {
      throw "bluesky refused the record";
    });
    const d = draft({ renders: [render({ platform: "bluesky" })] });

    await publishDraft(d, { now: true });

    // ⚠️ `err.message` on a thrown string is undefined, so reading it without
    // the instanceof check leaves the operator with "bluesky: undefined" and
    // nothing to act on. lastError is the only surface this reaches.
    expect(d.lastError).toBe("bluesky: bluesky refused the record");
    expect(d.providerPostId).toBe("bluesky:pending");
  });

  it("carries the same words through PublishNotSentError when nothing was dispatched", async () => {
    const upload = ensureUploaded as unknown as ReturnType<typeof vi.fn>;
    upload.mockImplementation(async () => {
      throw "the asset store refused the upload";
    });
    const d = draft({
      source: source({ media: [image()] }),
      renders: [render({ platform: "bluesky", mediaIndices: [0] })],
    });

    // ⛔ PublishNotSentError is how the CALLER learns the draft can safely go
    // back to its previous status: nothing reached a vendor, so restoring it
    // cannot cause a double post. Its message is the only explanation the
    // operator gets, so a non-Error cause has to be stringified, not read for a
    // `.message` it does not have.
    await expect(publishDraft(d, { now: true })).rejects.toThrow(PublishNotSentError);
    await expect(publishDraft(d, { now: true })).rejects.toThrow("the asset store refused the upload");
    expect(publishNow).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* Half a thread chain                                                        */
/* -------------------------------------------------------------------------- */

/**
 * ⛔ A DRAFT WITH QUEUED REPLIES IS NOT PUBLISHED, AND SAYING IT IS LOSES THEM.
 *
 * `runPublish` used to decide `published` from `entries.every(isTerminalEntry)`
 * alone, never looking at the chain it had just collected. A `--now` publish
 * whose transport deferred its replies therefore settled as `published` with
 * `threadState.queued` still populated, and `releaseDuePosts` scans
 * `status in ("scheduled","publishing")` only — so nothing ever drained it and
 * the replies were never sent. Nothing reported it either: the root post WAS
 * live, so the draft looked entirely successful.
 *
 * The status assertions below are the regression pin. `publish-due.ts`'s own
 * `isSettleable` had the rule right all along
 * (`entries.every(isTerminalEntry) && !chainOutstanding(state)`), and its
 * docblock says explicitly that a gate applying a narrower rule than the thing
 * it guards is how a draft gets stranded. The inline path now shares it.
 */
describe("a transport that returns only half of a deferred chain", () => {
  it("records the queued replies even with no root handle to attach them to", async () => {
    const queued = [{ position: 1, text: "second", dueAt: FUTURE, parent: { ref: "post-1" } }];
    publishNow.mockResolvedValue({ ref: "post-1", queued });
    const d = draft({ renders: [render({ platform: "bluesky" })] });

    const res = await publishDraft(d, { now: true });

    // ⛔ Assert the key is ABSENT, not undefined. A platform whose replies
    // attach by post ref has no separate root handle, and writing
    // `root: undefined` into threadState persists a null the releaser then has
    // to special-case. Dropping the whole entry instead is what loses the
    // replies, which is the bug this whole channel exists to stop.
    expect(res.threads).toHaveLength(1);
    expect("root" in res.threads[0]!).toBe(false);
    expect(res.threads[0]!.queued).toEqual(queued);
    // The root leg itself is still recorded as live, so a retry cannot resend it.
    expect(d.providerPostId).toBe("bluesky:post-1");

    // ⛔ THE REGRESSION PIN. Every leg is terminal here, so the leg-only rule
    // would say "published" and hide this draft from the only scan that could
    // release the reply above.
    expect(d.status).toBe("scheduled");
    expect(d.publishedAt).toBeUndefined();
  });

  it("stays publishable-by-the-releaser until the last queued reply has gone", async () => {
    const queued = [
      { position: 1, text: "second", dueAt: FUTURE, parent: { ref: "post-1" } },
      { position: 2, text: "third", dueAt: FUTURE, parent: { ref: "post-1" } },
    ];
    publishNow.mockResolvedValue({ ref: "post-1", queued });
    const d = draft({ renders: [render({ platform: "bluesky" })] });

    await publishDraft(d, { now: true });

    // ⚠️ A deferred leg has no scheduled time of its own and is due
    // immediately; publish-due reads a null scheduledFor as exactly that. So
    // the draft must not carry a future date it never asked for.
    expect(d.status).toBe("scheduled");
    expect(d.scheduledFor).toBeUndefined();
  });

  it("records an empty queue when the transport hands back a root and defers nothing", async () => {
    publishNow.mockResolvedValue({ ref: "post-1", threadRoot: { uri: "at://root", cid: "c1" } });
    const d = draft({ renders: [render({ platform: "bluesky" })] });

    const res = await publishDraft(d, { now: true });

    // `queued: []` rather than undefined, so the caller persists a chain that is
    // complete rather than one whose replies are unknown.
    expect(res.threads).toEqual([
      { platform: "bluesky", root: { uri: "at://root", cid: "c1" }, queued: [] },
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* Routing that changes under a publish already in flight                     */
/* -------------------------------------------------------------------------- */

describe("a platform unrouted between the connect sweep and the dispatch", () => {
  it("leaves the leg at the retryable pending seed rather than sending it somewhere nobody chose", async () => {
    // ⛔ THE ROUTE IS RESOLVED AFTER THE CONNECT SWEEP, so an operator changing
    // a platform's routing in Social HQ during a publish (or a settings read
    // failing, which answers `{}` and unroutes everything) leaves a leg that is
    // connected but has nowhere to go. The seed is the failure behaviour: it is
    // already recorded as retryable by the 15-minute ring, so the leg is never
    // both un-sent and forgotten.
    delete process.env.SOCIALMETA_TRANSPORT_OVERRIDES;
    let routed = true;
    setTransportOverridesResolver(async () => (routed ? { bluesky: "direct" } : {}));

    const upload = ensureUploaded as unknown as ReturnType<typeof vi.fn>;
    upload.mockImplementation(async (asset: MediaAsset) => {
      // The uploads run AFTER the connect sweep and BEFORE the route lookup,
      // which is exactly the window this is about.
      routed = false;
      asset.url ??= "https://cdn.example.test/a.jpg";
      return asset;
    });

    const d = draft({
      source: source({ media: [image()] }),
      renders: [render({ platform: "bluesky", mediaIndices: [0] })],
    });

    const res = await publishDraft(d, { now: true });

    expect(publishNow).not.toHaveBeenCalled();
    // The PLATFORM namespace, not a route's: nothing can stamp an unrouted leg,
    // so publish-due reports it unroutable instead of releasing it through
    // whichever transport happens to be registered for the platform.
    expect(res.providerPostId).toBe("bluesky:pending");
    expect(d.status).toBe("scheduled");
    // Not sent, and said so: it used to leave lastError empty and still list
    // the leg under `sent`.
    expect(res.sent).toEqual([]);
    expect(d.lastError).toBe("bluesky: no transport route to publish through; left pending");
  });
});

/* -------------------------------------------------------------------------- */
/* What `sent` actually means                                                 */
/* -------------------------------------------------------------------------- */

describe("the sent list in the result", () => {
  it("names only the legs a vendor accepted, never one whose send failed", async () => {
    registerTransport(fakeTransport("reddit"));
    process.env.SOCIALMETA_DEFAULT_SUBREDDIT = "smallbusiness";
    publishNow.mockImplementation(async (input) => {
      if (input.render.platform === "reddit") throw new Error("reddit 500");
      return { ref: "post-ok" };
    });
    const d = draft({
      renders: [render({ platform: "bluesky" }), render({ platform: "reddit" })],
    });

    const res = await publishDraft(d, { now: true });

    // ⛔ `sent` used to be every connected target whatever happened, so the CLI
    // and the copilot reported reddit as published here. It is now the delivery
    // receipt; the failed leg stays pending with its reason in lastError.
    expect(res.sent.map((s) => s.platform)).toEqual(["bluesky"]);
    expect(d.providerPostId).toBe("bluesky:post-ok,reddit:pending");
    expect(d.lastError).toContain("reddit 500");
  });

  it("names every target on the SCHEDULED path too, where nothing was sent at all", async () => {
    const d = draft({ renders: [render({ platform: "bluesky" })] });

    const res = await publishDraft(d, { at: FUTURE });

    expect(publishNow).not.toHaveBeenCalled();
    expect(res.sent.map((s) => s.platform)).toEqual(["bluesky"]);
    expect(res.providerPostId).toBe("bluesky:pending");
  });
});

/* -------------------------------------------------------------------------- */
/* An unknown outcome on "post now"                                           */
/* -------------------------------------------------------------------------- */

/**
 * ⛔ A CREATE WHOSE ANSWER WAS LOST IS NEVER SENT AGAIN BY THE RING.
 *
 * A 5xx, a timeout or a dropped connection on publishNow may mean the post
 * landed and only the answer went missing (retry.ts). The inline path used to
 * leave every failed leg at the seeded `pending`, so publish-due re-sent it on
 * its next tick: a second live post. It now records `failed` with the same
 * operator text publish-due writes for a scheduled leg, and only the Retry
 * button (the rearm route) puts it back in the ring.
 */
describe("an unknown outcome on post now", () => {
  const UNKNOWN_502 =
    "bluesky: outcome unknown, the post may already be live (Bluesky POST createRecord -> 502: Bad Gateway). " +
    "It was not retried, to avoid a duplicate. Check bluesky, and use Retry only if the post is not there.";

  it("fails the leg (not pending) on a vendor 5xx, and the draft with it when nothing went live", async () => {
    publishNow.mockRejectedValue(new BlueskyError(502, "Bad Gateway", "POST", "createRecord"));
    const d = draft({ renders: [render({ platform: "bluesky" })] });

    const res = await publishDraft(d, { now: true });

    expect(d.providerPostId).toBe("bluesky:failed");
    expect(res.providerPostId).toBe("bluesky:failed");
    expect(res.sent).toEqual([]);
    expect(d.lastError).toBe(UNKNOWN_502);
    // Every leg is terminal and none is live: `failed`, as publish-due's
    // settleDraft would write it, never `published` with nothing posted.
    expect(d.status).toBe("failed");
    expect(d.publishedAt).toBeUndefined();
  });

  it("fails the leg on a timeout, which every client reports as status 0", async () => {
    publishNow.mockRejectedValue(new BlueskyError(0, "The operation was aborted due to timeout", "POST", "createRecord"));
    const d = draft({ renders: [render({ platform: "bluesky" })] });

    await publishDraft(d, { now: true });

    expect(d.providerPostId).toBe("bluesky:failed");
    expect(d.lastError).toContain("bluesky: outcome unknown, the post may already be live");
    expect(d.status).toBe("failed");
  });

  it("settles as published when another leg went live, with the unknown leg failed beside it", async () => {
    registerTransport(fakeTransport("reddit"));
    process.env.SOCIALMETA_DEFAULT_SUBREDDIT = "smallbusiness";
    publishNow.mockImplementation(async (input) => {
      if (input.render.platform === "bluesky") {
        throw new BlueskyError(502, "Bad Gateway", "POST", "createRecord");
      }
      return { ref: "post-ok" };
    });
    const d = draft({
      renders: [render({ platform: "bluesky" }), render({ platform: "reddit" })],
    });

    const res = await publishDraft(d, { now: true });

    expect(d.providerPostId).toBe("bluesky:failed,reddit:post-ok");
    expect(res.sent.map((s) => s.platform)).toEqual(["reddit"]);
    expect(d.lastError).toBe(UNKNOWN_502);
    expect(d.status).toBe("published");
  });

  it("still leaves a clear rejection at pending for the ring to retry", async () => {
    publishNow.mockRejectedValue(new BlueskyError(400, "InvalidRequest", "POST", "createRecord"));
    const d = draft({ renders: [render({ platform: "bluesky" })] });

    await publishDraft(d, { now: true });

    expect(d.providerPostId).toBe("bluesky:pending");
    expect(d.lastError).toBe("bluesky: Bluesky POST createRecord -> 400: InvalidRequest");
    expect(d.status).toBe("scheduled");
  });
});

/* -------------------------------------------------------------------------- */
/* The aggregator sweep                                                       */
/* -------------------------------------------------------------------------- */

describe("sweeping an aggregator that holds several platforms", () => {
  it("asks it once PER PLATFORM, because a connected account is per platform inside one credential", async () => {
    // ⚠️ The sweep memoises the in-flight promise, but its key is
    // `<aggregatorId>|<platform>` and ALL_PLATFORMS has no duplicates, so the
    // memo can never collapse two platforms into one call and is not what keeps
    // the round trip cheap. What IS shared is the account list underneath the
    // vendor's per-platform answer. If this ever becomes one call for two
    // platforms, check first that the vendor really reports both accounts from
    // a single response.
    const aggConnect = vi.fn<Aggregator["connectStatus"]>(async (p) => ({
      connected: true,
      accountId: `acc_${p}`,
      displayName: "u/examplebrand",
    }));
    registerAggregator({
      id: "zernio",
      platforms: () => ["reddit", "twitter"],
      channelRules: () => ({ maxLength: 40000, countMode: "utf16" }),
      connectStatus: aggConnect,
      publishNow: async () => ({ ref: "zp_1" }),
      deletePost: async () => {},
      postFacts: async () => new Map(),
      postUrl: (_p, ref) => `https://example.test/${ref}`,
    });
    process.env.SOCIALMETA_TRANSPORT_OVERRIDES = JSON.stringify({
      reddit: "aggregator:zernio",
      twitter: "aggregator:zernio",
    });
    invalidateConnectedAccounts();

    const map = await connectedAccounts({ fresh: true });

    expect(aggConnect.mock.calls.map((c) => c[0]).sort()).toEqual(["reddit", "twitter"]);
    expect(map.reddit).toMatchObject({ accountId: "acc_reddit" });
    expect(map.twitter).toMatchObject({ accountId: "acc_twitter" });
  });
});
