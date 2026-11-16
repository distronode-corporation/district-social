/**
 * parseRenderLangs: the one rule behind every editor that writes a render's
 * `langs` (the hosted PUT's `renders` and `renderPatch`, and the CLI's
 * `set --langs`).
 *
 * The properties that carry the risk:
 *
 *  • ⛔ A TAG THE PDS WOULD REFUSE NEVER GETS STORED. The record's `langs` is
 *    checked against the lexicon's `format: language` at publish time, after
 *    other legs may already be live, so a bad tag has to fail at edit time.
 *  • ⛔ NO MORE THAN THREE. bluesky.ts slices to three without a word, which
 *    would drop a tag the operator asked for.
 *  • ⛔ BLUESKY ONLY. No other transport sends it, so accepting it elsewhere
 *    stores a value that looks meaningful and does nothing.
 *  • null and [] CLEAR. Both editors rely on `langs: undefined` meaning "remove
 *    the key", never an empty list persisted.
 */
import { describe, it, expect } from "vitest";
import { ALL_PLATFORMS, type Platform } from "../types.js";
import { MAX_RENDER_LANGS, parseRenderLangs } from "../render-langs.js";
import * as engine from "../index.js";

describe("parseRenderLangs: accepted values", () => {
  it.each([
    [["en"], ["en"]],
    [["fr", "en"], ["fr", "en"]],
    [["fr-CA", "en"], ["fr-CA", "en"]],
    [["zh-Hant"], ["zh-Hant"]],
    [["ast"], ["ast"]],
  ])("keeps %j as %j", (raw, expected) => {
    expect(parseRenderLangs("bluesky", raw)).toEqual({ ok: true, langs: expected });
  });

  it("lowercases the primary subtag only, leaving the region as typed", () => {
    // `fr-ca` would also pass the regex; normalising the region too would
    // rewrite what the operator typed for no gain.
    expect(parseRenderLangs("bluesky", ["FR-CA", "EN"])).toEqual({ ok: true, langs: ["fr-CA", "en"] });
    expect(parseRenderLangs("bluesky", ["Fr-ca"])).toEqual({ ok: true, langs: ["fr-ca"] });
  });

  it("trims each tag, so a CLI `fr, en` split on commas is not refused over a space", () => {
    expect(parseRenderLangs("bluesky", [" fr", " en "])).toEqual({ ok: true, langs: ["fr", "en"] });
  });

  it("takes exactly the lexicon's maximum", () => {
    expect(MAX_RENDER_LANGS).toBe(3);
    expect(parseRenderLangs("bluesky", ["fr", "en", "es"])).toEqual({ ok: true, langs: ["fr", "en", "es"] });
  });

  it.each([
    ["null", null],
    ["an empty list", []],
  ])("treats %s as the clear", (_label, raw) => {
    expect(parseRenderLangs("bluesky", raw)).toEqual({ ok: true, langs: undefined });
  });
});

describe("parseRenderLangs: refusals", () => {
  const SHAPE = 'must be 1 to 3 language tags such as "en" or "fr-CA"';

  it.each([
    ["a bare string", "en"],
    ["a number", 42],
    ["an object", { 0: "en" }],
    ["undefined", undefined],
  ])("refuses %s, which is not a list", (_label, raw) => {
    expect(parseRenderLangs("bluesky", raw)).toEqual({ ok: false, error: SHAPE });
  });

  it("refuses a non-string entry", () => {
    expect(parseRenderLangs("bluesky", ["en", 7])).toEqual({ ok: false, error: SHAPE });
  });

  it("refuses a fourth tag rather than letting the client drop it", () => {
    expect(parseRenderLangs("bluesky", ["fr", "en", "es", "de"])).toEqual({
      ok: false,
      error: `${SHAPE}, got 4`,
    });
  });

  it.each([
    ["an underscore separator", "fr_CA"],
    ["a word, not a tag", "english"],
    ["a one-letter primary", "e"],
    ["a trailing dash", "en-"],
    ["a numeric region the narrow rule does not take", "es-419"],
    ["a variant subtag", "de-DE-1901"],
    ["an empty tag, which is what `en,` splits into", ""],
    ["whitespace", "  "],
  ])("refuses %s, naming the tag as typed", (_label, tag) => {
    expect(parseRenderLangs("bluesky", ["en", tag])).toEqual({
      ok: false,
      error: `${SHAPE}, got ${JSON.stringify(tag)}`,
    });
  });

  it.each(ALL_PLATFORMS.filter((p) => p !== "bluesky"))(
    "refuses any langs on %s, including the clear",
    (platform) => {
      const expected = {
        ok: false,
        error: `is only accepted on the bluesky render (${platform} does not send language tags)`,
      };
      // The platform check runs before the value is looked at: a clear aimed
      // at the wrong render is the same mistake as a set aimed at it.
      expect(parseRenderLangs(platform as Platform, ["en"])).toEqual(expected);
      expect(parseRenderLangs(platform as Platform, null)).toEqual(expected);
      expect(parseRenderLangs(platform as Platform, [])).toEqual(expected);
    },
  );
});

describe("the barrel both editors import", () => {
  it("re-exports the same function, so the route and the CLI share one rule", () => {
    // The CLI and the route import from "../index.js", never from this
    // module's path. Identity, not just presence: a second copy of the rule
    // behind the barrel is how the two editors would drift apart again.
    expect(engine.parseRenderLangs).toBe(parseRenderLangs);
    expect(engine.MAX_RENDER_LANGS).toBe(MAX_RENDER_LANGS);
  });
});
