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
 * the same facets, byte offsets included, with one deliberate difference: a
 * mention that does not resolve is dropped instead of kept with `did: ""`.
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
    "matches the library for %s",
    async (_label, c) => {
      const facets = await resolveMentions(detectFacets(c.text), resolve);
      expect(facets).toEqual(expected(c.facets));
    },
  );

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
