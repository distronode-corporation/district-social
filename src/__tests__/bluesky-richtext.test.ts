import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { detectFacets, resolveMentions } from "../bluesky-richtext.js";
import type { Facet } from "../bluesky-xrpc.js";

/**
 * ⛔ THE OFFSETS ARE PROVEN, NOT RE-DERIVED. `fixtures/bluesky-facets.sdk.json`
 * was captured from `@atproto/api`'s own `RichText.detectFacets` (version in
 * the file) before the library was removed, with a resolver that knows three
 * handles. Each case is that library's output for one text: emoji, CJK,
 * Hangul, combining accents, ZWJ sequences, URLs with trailing punctuation and
 * parentheses, bare domains, handles, tags and cashtags. This port must give
 * the same facets, byte offsets included, with the deliberate differences
 * below and nothing else.
 *
 * Difference 1, every case: a mention that does not resolve is dropped instead
 * of kept with `did: ""` (see `expected`).
 *
 * Difference 2, LINK_EXCEPTIONS: three fixture texts where the library's link
 * output is wrong, decided by the maintainer (2026-11-22) and fixed here:
 *   - a bare domain that starts with "http" (`httpbin.org`): the library adds
 *     `https://` only when the text does not start with "http", so it linked
 *     the scheme-less `httpbin.org`, a relative target;
 *   - a link with an upper-case scheme (`HTTP://`, `HTTPS://`): the library's
 *     pattern matches it case-insensitively but its `startsWith("http")` test
 *     does not, so it skipped the link and left it as plain text.
 * Here a bare domain always gets `https://`, and a scheme link matches in any
 * case, with its scheme and host lower-cased and its path kept as written.
 */
interface Fixture {
  capturedFrom: string;
  resolvedHandles: Record<string, string>;
  cases: Array<{ text: string; facets: Facet[] | null }>;
}

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/bluesky-facets.sdk.json", import.meta.url), "utf8"),
) as Fixture;

async function resolve(handle: string): Promise<string> {
  const did = fixture.resolvedHandles[handle];
  if (!did) throw new Error(`unresolved: ${handle}`);
  return did;
}

/**
 * The facets this port gives for the three fixture texts the library links
 * wrongly (Difference 2 above). Offsets are the library's own where it linked
 * at all; the new facets' offsets were counted from the text.
 */
const LINK_EXCEPTIONS: Record<string, Facet[]> = {
  "httpbin.org is a bare domain starting with http": [
    { index: { byteStart: 0, byteEnd: 11 }, features: [{ $type: "app.bsky.richtext.facet#link", uri: "https://httpbin.org" }] },
  ],
  "upper-case scheme HTTP://example.com and HTTPS://EXAMPLE.COM/x": [
    { index: { byteStart: 18, byteEnd: 36 }, features: [{ $type: "app.bsky.richtext.facet#link", uri: "http://example.com" }] },
    { index: { byteStart: 41, byteEnd: 62 }, features: [{ $type: "app.bsky.richtext.facet#link", uri: "https://example.com/x" }] },
  ],
  "Visit HTTPS://example.com now, or https://example.com.": [
    { index: { byteStart: 6, byteEnd: 25 }, features: [{ $type: "app.bsky.richtext.facet#link", uri: "https://example.com" }] },
    { index: { byteStart: 34, byteEnd: 53 }, features: [{ $type: "app.bsky.richtext.facet#link", uri: "https://example.com" }] },
  ],
};

/** The library's output with its one difference applied: unresolved mentions removed. */
function expected(facets: Facet[] | null): Facet[] | undefined {
  const kept = (facets ?? []).filter(
    (f) => !f.features.some((x) => x.$type === "app.bsky.richtext.facet#mention" && (x as { did: string }).did === ""),
  );
  return kept.length > 0 ? kept : undefined;
}

describe("detectFacets against @atproto/api's own output", () => {
  it("was captured from the library, and covers the hard cases", () => {
    expect(fixture.capturedFrom).toMatch(/^@atproto\/api \d+\.\d+\.\d+ RichText\.detectFacets/);
    expect(fixture.cases.length).toBeGreaterThanOrEqual(40);
    const texts = fixture.cases.map((c) => c.text).join("\n");
    for (const sample of ["🚀", "👨‍👩‍👧‍👦", "中文", "한국어", "café", "https://example.com/a,", "(disambiguation)"]) {
      expect(texts).toContain(sample);
    }
  });

  it.each(fixture.cases.map((c) => [JSON.stringify(c.text).slice(0, 70), c] as const))(
    "matches the library, with the documented differences, for %s",
    async (_label, c) => {
      const facets = await resolveMentions(detectFacets(c.text), resolve);
      expect(facets).toEqual(LINK_EXCEPTIONS[c.text] ?? expected(c.facets));
    },
  );

  it("names exactly the three link exceptions, each a captured fixture text", () => {
    const texts = new Set(fixture.cases.map((c) => c.text));
    expect(Object.keys(LINK_EXCEPTIONS)).toHaveLength(3);
    for (const text of Object.keys(LINK_EXCEPTIONS)) expect(texts.has(text)).toBe(true);
  });

  it("byte offsets index UTF-8: the facet's bytes decode back to the linked text", async () => {
    const text = "👨‍👩‍👧‍👦 中文 https://example.com/👍 after";
    const [facet] = detectFacets(text)!;
    const bytes = new TextEncoder().encode(text).slice(facet!.index.byteStart, facet!.index.byteEnd);
    expect(new TextDecoder().decode(bytes)).toBe("https://example.com/👍");
  });

  it("gives the same answer on a second call (the patterns' lastIndex does not leak)", () => {
    const text = "#one https://example.com @alice.bsky.social $AAPL";
    expect(detectFacets(text)).toEqual(detectFacets(text));
  });
});

/** The two fixes the maintainer chose over parity (LINK_EXCEPTIONS above). */
describe("link schemes", () => {
  function links(text: string): Array<{ uri: string; bytes: [number, number] }> {
    return (detectFacets(text) ?? []).map((f) => ({
      uri: (f.features[0] as { uri: string }).uri,
      bytes: [f.index.byteStart, f.index.byteEnd],
    }));
  }

  it("gives a bare domain https://, even one that starts with http", () => {
    expect(links("httpbin.org")).toEqual([{ uri: "https://httpbin.org", bytes: [0, 11] }]);
    expect(links("see httpsfoo.com/a")).toEqual([{ uri: "https://httpsfoo.com/a", bytes: [4, 18] }]);
  });

  it("links an upper-case scheme, lower-casing the scheme", () => {
    expect(links("HTTP://example.com")).toEqual([{ uri: "http://example.com", bytes: [0, 18] }]);
  });

  it("lower-cases the host and keeps the path, query and fragment as written", () => {
    expect(links("HTTPS://EXAMPLE.COM/x")).toEqual([{ uri: "https://example.com/x", bytes: [0, 21] }]);
    expect(links("https://Example.Com/Some/Path?Q=A#Frag")).toEqual([
      { uri: "https://example.com/Some/Path?Q=A#Frag", bytes: [0, 38] },
    ]);
  });

  /** A backslash ends the authority in URL parsing (WHATWG), so what follows is path. */
  it("ends the host at a backslash, keeping the rest as written", () => {
    expect(links("https://Example.com\\Some/Path")).toEqual([{ uri: "https://example.com\\Some/Path", bytes: [0, 29] }]);
  });

  it("keeps the user part of an authority as written, lower-casing only the host", () => {
    expect(links("Https://Me@Example.COM:8443/P")).toEqual([{ uri: "https://Me@example.com:8443/P", bytes: [0, 29] }]);
  });

  it("gets both right in one sentence with multi-byte text before the links", () => {
    const text = "🚀 café: HTTPS://Example.COM/Path?Q=1, then httpbin.org/get.";
    expect(links(text)).toEqual([
      { uri: "https://example.com/Path?Q=1", bytes: [12, 40] },
      { uri: "https://httpbin.org/get", bytes: [47, 62] },
    ]);
    const bytes = new TextEncoder().encode(text);
    expect(new TextDecoder().decode(bytes.slice(12, 40))).toBe("HTTPS://Example.COM/Path?Q=1");
    expect(new TextDecoder().decode(bytes.slice(47, 62))).toBe("httpbin.org/get");
  });
});

describe("resolveMentions", () => {
  it("passes undefined through", async () => {
    await expect(resolveMentions(undefined, resolve)).resolves.toBeUndefined();
  });

  it("replaces each handle with its DID, keeping the order", async () => {
    const facets = await resolveMentions(detectFacets("@alice.bsky.social and https://example.com"), resolve);
    expect(facets).toEqual([
      {
        $type: "app.bsky.richtext.facet",
        index: { byteStart: 0, byteEnd: 18 },
        features: [{ $type: "app.bsky.richtext.facet#mention", did: "did:plc:alice" }],
      },
      { index: { byteStart: 23, byteEnd: 42 }, features: [{ $type: "app.bsky.richtext.facet#link", uri: "https://example.com" }] },
    ]);
  });

  /**
   * ⛔ An unresolved mention is DROPPED, not sent with `did: ""`: the lexicon
   * requires a DID there, and the `@handle` reads fine as plain text.
   */
  it("drops a mention whose resolver throws or answers nothing, and answers undefined when none is left", async () => {
    await expect(resolveMentions(detectFacets("@nobody.example.com"), resolve)).resolves.toBeUndefined();
    await expect(resolveMentions(detectFacets("@alice.bsky.social"), async () => "")).resolves.toBeUndefined();
  });
});
