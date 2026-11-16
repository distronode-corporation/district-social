import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Alt text on the last three platforms that sent none: Facebook, X and
 * Pinterest. Bluesky, Instagram, LinkedIn and Threads already send it.
 *
 * Every assertion here pins a VENDOR FIELD NAME, because all three of these
 * fail silently when the name is wrong:
 *
 *   - Graph IGNORES unknown POST parameters, so `alt_text` instead of
 *     `alt_text_custom` publishes a Facebook photo with no description and
 *     returns success.
 *   - X has no alt parameter on upload at all; miss the separate metadata call
 *     and the image simply has no description, with nothing to notice.
 *   - Pinterest accepts one alt per pin, so sending the first image's text for
 *     a five-image carousel looks correct at the call site and is wrong.
 *
 * A test that only asserted "we passed altText somewhere" would pass in all
 * three broken cases.
 */

import { setMetaCredentialsResolver } from "../meta-graph.js";
import { facebookTransport } from "../facebook-transport.js";
import { setXTokenResolver, X_ALT_TEXT_MAX } from "../x.js";
import type { MediaAsset } from "../types.js";

const PAGE_ID = "1122334455";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function image(url: string, altText?: string): MediaAsset {
  return { type: "image", url, mimeType: "image/jpeg", size: 1000, altText } as MediaAsset;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => jsonResponse({ id: "1", post_id: `${PAGE_ID}_1` }));
  vi.stubGlobal("fetch", fetchMock);
  setMetaCredentialsResolver(async () => ({
    appSecret: "meta-secret",
    pageToken: "page-token",
    pageId: PAGE_ID,
  }));
  setXTokenResolver(async () => "x-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  setMetaCredentialsResolver(null);
  setXTokenResolver(null);
});

/** Graph writes send params as a form body, so the alt lands in the body. */
function lastBody(): string {
  const init = fetchMock.mock.calls.at(-1)![1] as RequestInit;
  return String(init?.body ?? "");
}

describe("facebook alt text", () => {
  it("sends alt_text_custom on the photo upload", async () => {
    await facebookTransport.publishNow({
      render: { content: "a caption" },
      media: [image("https://cdn.example.com/a.jpg", "A red bicycle against a wall")],
    } as never);

    // Parsed, not string-matched: a form body encodes spaces as "+", which
    // decodeURIComponent does not reverse, so a raw substring check would fail
    // on correct output.
    const params = new URLSearchParams(lastBody());
    expect(params.get("alt_text_custom")).toBe("A red bicycle against a wall");
  });

  it("⛔ does not use Instagram's `alt_text` field name", async () => {
    await facebookTransport.publishNow({
      render: { content: "a caption" },
      media: [image("https://cdn.example.com/a.jpg", "described")],
    } as never);

    // Graph ignores unknown params rather than rejecting them, so the wrong
    // name here would publish with no alt text and still report success.
    const params = new URLSearchParams(lastBody());
    expect(params.get("alt_text_custom")).toBe("described");
    expect(params.has("alt_text")).toBe(false);
  });

  it("omits the field entirely when the asset has no alt text", async () => {
    await facebookTransport.publishNow({
      render: { content: "a caption" },
      media: [image("https://cdn.example.com/a.jpg")],
    } as never);
    expect(new URLSearchParams(lastBody()).has("alt_text_custom")).toBe(false);
  });
});

describe("x alt text", () => {
  it("posts /2/media/metadata with the documented nested body", async () => {
    const { setMediaAltText } = await import("../x.js");
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    await setMediaAltText("media-77", "A red bicycle");

    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(String(url)).toContain("/media/metadata");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      id: "media-77",
      metadata: { alt_text: { text: "A red bicycle" } },
    });
  });

  it("truncates rather than letting X reject the whole call", async () => {
    const { setMediaAltText } = await import("../x.js");
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    await setMediaAltText("media-77", "x".repeat(X_ALT_TEXT_MAX + 500));

    const init = fetchMock.mock.calls.at(-1)![1] as RequestInit;
    const sent = JSON.parse(String(init.body)).metadata.alt_text.text;
    expect(sent).toHaveLength(X_ALT_TEXT_MAX);
  });

  it("skips the call entirely for empty or whitespace-only alt text", async () => {
    const { setMediaAltText } = await import("../x.js");
    await setMediaAltText("media-77", "   ");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("pinterest alt text", () => {
  it("labels each slide when a carousel has several described images", async () => {
    // Pinterest allows ONE alt per pin, so a 5-image carousel described only by
    // image 1 tells a screen-reader user about one slide and hides four.
    const { combinedAltText } = await import("../pinterest-transport.js");
    expect(
      combinedAltText(3, [
        image("a.jpg", "A red bicycle"),
        image("b.jpg", "A blue door"),
        image("c.jpg", "A grey cat"),
      ]),
    ).toBe("1. A red bicycle 2. A blue door 3. A grey cat");
  });

  it("reads naturally with no numbering for a single image", async () => {
    const { combinedAltText } = await import("../pinterest-transport.js");
    expect(combinedAltText(1, [image("a.jpg", "A red bicycle")])).toBe("A red bicycle");
  });

  it("marks undescribed slides instead of silently skipping them", async () => {
    const { combinedAltText } = await import("../pinterest-transport.js");
    // Skipping slide 2 would renumber the rest and misalign every description
    // that follows it.
    expect(combinedAltText(3, [image("a.jpg", "Red bike"), image("b.jpg"), image("c.jpg", "Grey cat")])).toBe(
      "1. Red bike 2. (no description provided) 3. Grey cat",
    );
  });

  it("returns undefined when nothing is described, rather than an empty string", async () => {
    const { combinedAltText } = await import("../pinterest-transport.js");
    expect(combinedAltText(2, [image("a.jpg"), image("b.jpg")])).toBeUndefined();
  });

  it("truncates to the vendor's 500-char cap so a long description cannot lose the pin", async () => {
    const { combinedAltText } = await import("../pinterest-transport.js");
    const out = combinedAltText(1, [image("a.jpg", "y".repeat(900))]);
    expect(out).toHaveLength(500);
  });
});
