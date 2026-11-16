import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  deterministicChecks,
  fitForTransport,
  hasMediaFitter,
  registerTransport,
  resetTransports,
  setMediaFitter,
  type Draft,
  type DirectTransport,
  type MediaAsset,
  type MediaFitRequest,
  type Platform,
  type TransportChannelRules,
} from "../index.js";

/**
 * Publish-time, per-platform image fitting.
 *
 * The behaviour being replaced: every generated card was re-encoded ONCE at
 * compose time to 1MB, which is Bluesky's limit and the smallest of the nine,
 * so the tightest platform set the image quality for all of them. And an
 * operator's 5MB photo could not publish ANYWHERE, because QA failed the
 * Bluesky leg and stopped the whole draft.
 */

const MB = 1024 * 1024;

function asset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    path: "/tmp/card.png",
    type: "image",
    mimeType: "image/png",
    size: 500_000,
    url: "https://media.example.com/card.png",
    ...overrides,
  };
}

function rules(overrides: Partial<TransportChannelRules> = {}): TransportChannelRules {
  return { maxLength: 300, countMode: "utf16", ...overrides };
}

function transport(
  platform: DirectTransport["platform"],
  channelRuleOverrides: Partial<TransportChannelRules> = {},
): DirectTransport {
  return {
    platform,
    channelRules: () => rules(channelRuleOverrides),
    connectStatus: async () => ({ connected: true, accountId: "a", displayName: "d" }),
    publishNow: async () => ({ ref: "x" }),
    deletePost: async () => {},
    postFacts: async () => new Map(),
    postUrl: (r) => `https://example.test/${r}`,
  };
}

beforeEach(() => {
  resetTransports();
  setMediaFitter(null);
});
afterEach(() => {
  resetTransports();
  setMediaFitter(null);
});

describe("fitForTransport", () => {
  it("passes media through untouched when no re-encoder is wired", async () => {
    // The CLI's world. Absence of a fitter must not become a new failure mode.
    const media = [asset({ size: 40 * MB })];
    expect(hasMediaFitter()).toBe(false);
    await expect(fitForTransport(media, rules({ maxImageBytes: 1 * MB }))).resolves.toBe(media);
  });

  it("leaves a compliant asset alone rather than re-encoding it for nothing", async () => {
    const fitter = vi.fn();
    setMediaFitter(fitter);

    const media = [asset({ size: 500_000, mimeType: "image/jpeg" })];
    const out = await fitForTransport(media, rules({ maxImageBytes: 8 * MB, imageFormats: ["image/jpeg"] }));

    expect(fitter).not.toHaveBeenCalled();
    expect(out[0]).toBe(media[0]);
  });

  it("fits an oversized image to THIS platform's ceiling", async () => {
    const fitter = vi.fn(async (req: MediaFitRequest) => ({ ...req.asset, size: 900_000 }));
    setMediaFitter(fitter);

    await fitForTransport([asset({ size: 5 * MB })], rules({ maxImageBytes: 1 * MB }));

    expect(fitter).toHaveBeenCalledWith(expect.objectContaining({ maxBytes: 1 * MB }));
  });

  /**
   * The Instagram case, and the reason `imageFormats` exists: a PNG that is
   * comfortably under the size limit still has to be converted, because
   * Instagram takes JPEG and nothing else.
   */
  it("converts a compliant-size PNG when the platform only accepts JPEG", async () => {
    const fitter = vi.fn(async (req: MediaFitRequest) => ({ ...req.asset, mimeType: "image/jpeg" }));
    setMediaFitter(fitter);

    await fitForTransport(
      [asset({ mimeType: "image/png", size: 200_000 })],
      rules({ maxImageBytes: 30 * MB, imageFormats: ["image/jpeg"] }),
    );

    expect(fitter).toHaveBeenCalledWith(expect.objectContaining({ formats: ["image/jpeg"] }));
  });

  it("does not touch a PNG on a platform that accepts PNG", async () => {
    const fitter = vi.fn();
    setMediaFitter(fitter);

    await fitForTransport(
      [asset({ mimeType: "image/png", size: 200_000 })],
      rules({ maxImageBytes: 8 * MB, imageFormats: ["image/jpeg", "image/png"] }),
    );

    expect(fitter).not.toHaveBeenCalled();
  });

  it("never re-encodes video", async () => {
    const fitter = vi.fn();
    setMediaFitter(fitter);

    await fitForTransport(
      [asset({ type: "video", mimeType: "video/mp4", size: 200 * MB })],
      rules({ maxImageBytes: 1 * MB }),
    );

    expect(fitter).not.toHaveBeenCalled();
  });

  /**
   * A fitter that blows up must not kill the leg. The whole point of moving the
   * fit to publish time was to stop one platform's constraint deciding another
   * platform's outcome; a throwing re-encoder doing exactly that would be an
   * own goal.
   */
  it("sends the ORIGINAL asset when the fitter throws, rather than failing the publish", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setMediaFitter(async () => {
      throw new Error("sharp: unsupported image format");
    });

    const media = [asset({ size: 5 * MB })];
    const out = await fitForTransport(media, rules({ maxImageBytes: 1 * MB }));

    expect(out[0]).toBe(media[0]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

/**
 * The QA gate that would otherwise block before the fit ever runs.
 *
 * `image-too-large` was a hard fail, which was correct while nothing downstream
 * could resize anything. Softening it is only safe under BOTH conditions, so
 * both are tested, including the negatives.
 */
describe("the image-too-large gate", () => {
  function draftWith(size: number): Draft {
    return {
      id: "d1",
      status: "draft",
      source: {
        text: "hello",
        hashtags: [],
        media: [asset({ size, mimeType: "image/jpeg", path: "/tmp/big.jpg" })],
      },
      renders: [{ platform: "bluesky", content: "hello", mediaIndices: [0] }],
      targets: ["bluesky"],
    } as unknown as Draft;
  }

  /**
   * `fitting` is the limits each platform's media will ACTUALLY be fitted to.
   *
   * ⚠️ It replaced a `ReadonlySet<Platform>` of "which platforms are routed
   * direct", which QA then paired with a separate registry lookup for the
   * limits. The two could disagree, and three versions of that disagreement
   * shipped. Passing the rules themselves is what collapses "is it fitted" and
   * "to what" into one fact.
   */
  function imageIssues(draft: Draft, fitting?: ReadonlyMap<Platform, TransportChannelRules>) {
    return deterministicChecks(draft, null, fitting).filter((i) => i.code === "image-too-large");
  }

  /** The routed-somewhere map for a platform, built from the route's own rules. */
  function routed(t: DirectTransport): ReadonlyMap<Platform, TransportChannelRules> {
    return new Map([[t.platform, t.channelRules()]]);
  }

  it("still FAILS hard when no transport is registered (the aggregator path resizes nothing)", () => {
    setMediaFitter(async (req) => req.asset);
    const issues = imageIssues(draftWith(5 * MB));
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe("fail");
  });

  it("still FAILS hard when a transport is registered but no re-encoder is wired", () => {
    // The CLI: a registered transport cannot fit anything on its own.
    // ⚠️ The transport DOES declare maxImageBytes, so the missing fitter is the
    // only reason left for this to fail. Without that the test would pass on the
    // undeclared-limit path instead and stop covering what its name claims.
    const t = transport("bluesky", { maxImageBytes: 2_000_000 });
    registerTransport(t);
    const issues = imageIssues(draftWith(5 * MB), routed(t));
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe("fail");
  });

  /**
   * The bug this gate shipped with, now pinned.
   *
   * The condition used to be `registeredTransportFor(p) !== null`, and
   * transport-wiring registers ALL NINE platforms at boot. So every
   * aggregator-bound platform got its hard failure softened to a warning that
   * promised a re-encode nothing would perform — `publishDraft` only calls
   * `fitForTransport` on the DIRECT branch. Registration is not routing.
   */
  it("still FAILS hard when a transport is registered but the platform is NOT publishing direct", () => {
    registerTransport(transport("bluesky", { maxImageBytes: 2_000_000 }));
    setMediaFitter(async (req) => req.asset);

    // Registered and a fitter wired, but the platform is routed NOWHERE, so it
    // has no entry in the map at all.
    const issues = imageIssues(draftWith(5 * MB), new Map());
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe("fail");
    expect(issues[0].message).not.toMatch(/re-encoded at publish time/);
  });

  it("defaults to FAILING when the caller cannot say which platforms are direct", () => {
    // A QA gate that guesses permissively is worse than one that is too strict,
    // so the omitted-argument path must be the conservative one.
    registerTransport(transport("bluesky"));
    setMediaFitter(async (req) => req.asset);
    expect(imageIssues(draftWith(5 * MB))[0].severity).toBe("fail");
  });

  /**
   * ⛔ THE THIRD CONDITION, and the easy one to miss.
   *
   * Routed direct + a fitter wired was enough to soften this gate, but
   * media-fit's needsWork() re-encodes only when the TRANSPORT's own
   * channelRules declare maxImageBytes. A transport that omits it satisfies
   * both of the other conditions and still resizes nothing, so the operator
   * sees a warning saying the image "will be re-encoded at publish time" and
   * the publish then fails at the vendor.
   *
   * That is exactly a Bluesky transport that forgets to declare its limit, the
   * tightest image limit of the nine platforms.
   */
  it("still FAILS hard when the transport declares no maxImageBytes for the fitter to work to", () => {
    const t = transport("bluesky"); // no maxImageBytes declared
    registerTransport(t);
    setMediaFitter(async (req) => req.asset);

    const issues = imageIssues(draftWith(5 * MB), routed(t));

    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe("fail");
    // The promise is the harmful part: it is what stops an operator resizing
    // the image themselves.
    expect(issues[0].message).not.toMatch(/re-encoded at publish time/);
  });

  /**
   * The sibling of the maxImageBytes case: SPECS is the PLATFORM's limit
   * (LinkedIn 20, Facebook 10) but what a leg can actually send is whatever the
   * CLIENT implements, and neither implements multi-image. Gating on SPECS
   * passed drafts the publish path could not honour — and LinkedIn then
   * silently dropped the extras onto a live company post.
   */
  it("gates too-many-images on the TRANSPORT's cap when the platform is routed direct", () => {
    const capped = transport("bluesky", { maxImages: 1 });
    registerTransport(capped);
    const draft = {
      id: "d1",
      status: "draft",
      source: {
        text: "hello",
        hashtags: [],
        media: [
          asset({ size: 1000, mimeType: "image/jpeg", path: "/tmp/a.jpg" }),
          asset({ size: 1000, mimeType: "image/jpeg", path: "/tmp/b.jpg" }),
        ],
      },
      renders: [{ platform: "bluesky", content: "hello", mediaIndices: [0, 1] }],
      targets: ["bluesky"],
    } as unknown as Draft;

    // SPECS.bluesky allows 4, so without consulting the transport this passes.
    const issues = deterministicChecks(draft, null, routed(capped)).filter(
      (i) => i.code === "too-many-images",
    );

    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe("fail");
  });

  it("softens to a WARN when the publish path will genuinely re-encode it", () => {
    // ⚠️ The maxImageBytes is the point, not scaffolding. media-fit's
    // needsWork() re-encodes only when the TRANSPORT declares a limit, so a
    // transport without one re-encodes nothing. Asserting `warn` against such
    // a transport would contradict this test's own name and pin the bug it
    // was written to prevent.
    const t = transport("bluesky", { maxImageBytes: 2_000_000 });
    registerTransport(t);
    setMediaFitter(async (req) => req.asset);

    const issues = imageIssues(draftWith(5 * MB), routed(t));
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe("warn");
    expect(issues[0].message).toMatch(/re-encoded at publish time/);
  });

  it("says nothing at all about an image that already fits", () => {
    const t = transport("bluesky");
    registerTransport(t);
    setMediaFitter(async (req) => req.asset);
    expect(imageIssues(draftWith(500_000), routed(t))).toHaveLength(0);
  });

  /**
   * ⛔ THE FOURTH VERSION OF THIS BUG, CAUGHT BEFORE IT SHIPPED. An
   * aggregator's limits are its OWN and are frequently stricter than the
   * vendor's. Reading them from our direct transport would validate the draft
   * against a number nothing was going to apply.
   */
  it("uses the AGGREGATOR's limits when the platform is routed to one", () => {
    // Our own transport is generous; the aggregator that will actually publish
    // is not. The strict number has to win.
    registerTransport(transport("bluesky", { maxImageBytes: 8_000_000 }));
    setMediaFitter(async (req) => req.asset);

    const viaAggregator = new Map<Platform, TransportChannelRules>([
      ["bluesky", rules({ maxImageBytes: 1_000_000 })],
    ]);
    const issues = imageIssues(draftWith(5 * MB), viaAggregator);

    expect(issues).toHaveLength(1);
    // Softened, because the aggregator DOES declare a limit to fit to.
    expect(issues[0].severity).toBe("warn");
  });
});

describe("fitForTransport: rules that declare only one constraint", () => {
  it("sends only the format constraint when the platform declares no byte ceiling", async () => {
    let seen: MediaFitRequest | undefined;
    setMediaFitter(async (req) => {
      seen = structuredClone(req);
      return { ...req.asset, mimeType: "image/jpeg" };
    });

    await fitForTransport([asset({ mimeType: "image/png" })], rules({ imageFormats: ["image/jpeg"] }));

    expect(seen).toEqual({ asset: asset({ mimeType: "image/png" }), formats: ["image/jpeg"] });
  });

  it("sends only the byte ceiling when the platform declares no formats", async () => {
    let seen: MediaFitRequest | undefined;
    setMediaFitter(async (req) => {
      seen = structuredClone(req);
      return req.asset;
    });

    await fitForTransport([asset({ size: 5 * MB })], rules({ maxImageBytes: 1 * MB }));

    expect(seen).toEqual({ asset: asset({ size: 5 * MB }), maxBytes: 1 * MB });
  });

  it("keeps the original and logs the stringified reason when the fitter rejects with a non-Error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setMediaFitter(async () => {
      throw "sharp not installed";
    });
    const media = [asset({ size: 5 * MB })];

    const out = await fitForTransport(media, rules({ maxImageBytes: 1 * MB }));

    expect(out[0]).toBe(media[0]);
    expect(warn).toHaveBeenCalledWith(
      "[media-fit] could not fit /tmp/card.png for this platform, sending it as-is: sharp not installed",
    );
    warn.mockRestore();
  });
});
