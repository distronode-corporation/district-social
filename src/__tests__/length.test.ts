import { describe, it, expect } from "vitest";
import { graphemeCount, measureLength, xWeightedLength } from "../length.js";

/**
 * X's rule, from docs.x.com/fundamentals/counting-characters: NFC first, every URL 23, Latin and common punctuation 1,
 * everything else (CJK included) 2, every emoji sequence 2.
 */
describe("xWeightedLength", () => {
  it("charges Latin text 1 per character", () => {
    expect(xWeightedLength("sales & support")).toBe(15);
  });

  it("charges every URL a flat 23, short or long", () => {
    expect(xWeightedLength("https://a.co")).toBe(23);
    expect(xWeightedLength(`https://example.com/?${"u".repeat(60)}`)).toBe(23);
    expect(xWeightedLength("a https://a.co b https://b.co c")).toBe(1 + 1 + 23 + 3 + 23 + 2);
  });

  it("leaves trailing sentence punctuation outside the link", () => {
    expect(xWeightedLength("see https://example.com/pricing.")).toBe(4 + 23 + 1);
    expect(xWeightedLength("(https://example.com)")).toBe(1 + 23 + 1);
  });

  it("charges CJK and other non-Latin scripts 2", () => {
    expect(xWeightedLength("\u6BCE\u901A\u8A71")).toBe(6);
  });

  it("charges the weight-1 punctuation ranges 1 and the ellipsis 2", () => {
    // U+2014 em dash and U+2019 quote sit in 0x2010-0x201F; U+2033 in 0x2032-0x2037;
    // U+200B in 0x2000-0x200D. U+2026 is outside every range.
    expect(xWeightedLength("\u2014\u2019\u2033\u200B")).toBe(4);
    expect(xWeightedLength("\u2026")).toBe(2);
  });

  it("charges every emoji sequence 2, however many code points it carries", () => {
    expect(xWeightedLength("\u{1F680}")).toBe(2);
    expect(xWeightedLength("\u{1F468}\u200D\u{1F469}\u200D\u{1F467}")).toBe(2);
    expect(xWeightedLength("\u{1F5E3}\uFE0F")).toBe(2);
    expect(xWeightedLength("\u{1F5E3}")).toBe(2);
    expect(xWeightedLength("\u{1F1E8}\u{1F1E6}")).toBe(2);
    expect(xWeightedLength("1\uFE0F\u20E3")).toBe(2);
    expect(xWeightedLength("\u{1F44D}\u{1F3FD}")).toBe(2);
  });

  it("charges a bare BMP pictograph as text, not emoji", () => {
    expect(xWeightedLength("\u00A9")).toBe(1);
  });

  it("normalizes to NFC before counting", () => {
    expect(xWeightedLength("cafe\u0301")).toBe(4);
  });
});

describe("graphemeCount", () => {
  it("counts extended grapheme clusters", () => {
    expect(graphemeCount("")).toBe(0);
    expect(graphemeCount("hello world")).toBe(11);
    expect(graphemeCount("\u{1F468}\u200D\u{1F469}\u200D\u{1F467}")).toBe(1);
  });
});

describe("measureLength", () => {
  it("measures the raw string in each unit", () => {
    const text = "R&D\u00A0<b> \u00E9 \u{1F680}";
    expect(measureLength(text, "utf16")).toBe(text.length);
    expect(measureLength(text, "utf8bytes")).toBe(new TextEncoder().encode(text).length);
    expect(measureLength(text, "grapheme")).toBe(11);
    expect(measureLength(text, "weighted")).toBe(xWeightedLength(text));
  });
});
