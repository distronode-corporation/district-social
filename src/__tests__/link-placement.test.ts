import { describe, it, expect } from "vitest";
import { moveLinkToFirstComment, moveLinkToThread, extractLink, trimHashtags, URL_RE } from "../link-placement.js";
import type { PlatformRender } from "../types.js";

function render(overrides: Partial<PlatformRender> = {}): PlatformRender {
  return { platform: "linkedin", content: "", mediaIndices: [], ...overrides };
}

describe("moveLinkToFirstComment", () => {
  it("appends the link under an existing link-free first comment instead of replacing it", () => {
    const r = render({
      content: "We shipped the setup wizard.\nSee it: https://example.com/wizard",
      firstComment: "Questions welcome below.",
    });

    expect(moveLinkToFirstComment(r)).toBe("moved the link out of the body into the first comment");
    expect(r.content).toBe("We shipped the setup wizard.");
    expect(r.firstComment).toBe("Questions welcome below.\nSee it: https://example.com/wizard");
  });

  /**
   * This used to leave the comment alone because it carried SOME link, and
   * strip the body anyway, so https://example.com/a was deleted outright.
   */
  it("appends a body link a first comment holding a different link lacks", () => {
    const r = render({
      content: "Body.\nhttps://example.com/a",
      firstComment: "More at https://example.com/b",
    });

    moveLinkToFirstComment(r);

    expect(r.content).toBe("Body.");
    expect(r.firstComment).toBe("More at https://example.com/b\nhttps://example.com/a");
  });

  it("does not repeat a link the first comment already carries", () => {
    const r = render({
      content: "Body.\nhttps://example.com/a",
      firstComment: "More at https://example.com/a",
    });

    moveLinkToFirstComment(r);

    expect(r.content).toBe("Body.");
    expect(r.firstComment).toBe("More at https://example.com/a");
  });

  it("still moves a link the first comment only carries a longer URL beginning with", () => {
    const r = render({
      content: "Body.\nhttps://example.com",
      firstComment: "Pricing: https://example.com/pricing",
    });

    moveLinkToFirstComment(r);

    expect(r.content).toBe("Body.");
    expect(r.firstComment).toBe("Pricing: https://example.com/pricing\nhttps://example.com");
  });

  it("does not repeat a link the body ends with a full stop", () => {
    const r = render({
      content: "Body.\nSee it: https://example.com/a.",
      firstComment: "More at https://example.com/a",
    });

    moveLinkToFirstComment(r);

    expect(r.content).toBe("Body.");
    expect(r.firstComment).toBe("More at https://example.com/a");
  });

  it("moves every link line, so a second pass has nothing left to drop", () => {
    const r = render({
      platform: "facebook",
      content: "Pricing: https://example.com/pricing\nWe shipped it.\nDocs: https://example.com/docs",
    });

    moveLinkToFirstComment(r);
    expect(r.content).toBe("We shipped it.");
    expect(r.firstComment).toBe("Pricing: https://example.com/pricing\nDocs: https://example.com/docs");

    expect(moveLinkToFirstComment(r)).toBeNull();
    expect(r.firstComment).toContain("https://example.com/pricing");
  });
});

describe("moveLinkToThread", () => {
  it("moves every link line into one reply", () => {
    const r = render({
      platform: "twitter",
      content: "Pricing: https://example.com/pricing\nWe shipped it.\nDocs: https://example.com/docs",
    });

    moveLinkToThread(r);

    // Replies only: the body is `content`, never repeated as a thread item.
    expect(r.content).toBe("We shipped it.");
    expect(r.threadItems).toEqual([
      "Pricing: https://example.com/pricing\nDocs: https://example.com/docs",
    ]);
  });

  /**
   * The silent drop, end to end: the first pass moved only the last link line,
   * the second found the chain already carrying a URL and stripped the other
   * link from the root without adding it anywhere.
   */
  it("never loses a link across repeated passes", () => {
    const r = render({
      platform: "twitter",
      content: "https://example.com/pricing\nWe shipped it.\nhttps://example.com/docs",
    });

    moveLinkToThread(r);
    moveLinkToThread(r);

    const all = [r.content, ...(r.threadItems ?? [])].join("\n");
    expect(all).toContain("https://example.com/pricing");
    expect(all).toContain("https://example.com/docs");
    expect(r.content).not.toContain("https://");
    expect(r.threadItems).toHaveLength(1);
  });

  it("adds only the links an existing reply lacks", () => {
    const r = render({
      platform: "twitter",
      content: "Root.\nhttps://example.com/a\nhttps://example.com/b",
      threadItems: ["Read more: https://example.com/a"],
    });

    moveLinkToThread(r);

    expect(r.content).toBe("Root.");
    expect(r.threadItems).toHaveLength(2);
    expect(r.threadItems![0]).toBe("Read more: https://example.com/a");
    // A CTA lead-in, then only the missing link.
    expect(r.threadItems![1]).toMatch(/^[A-Za-z ]+: https:\/\/example\.com\/b$/);
  });

  it("drops a stored leading copy of the body instead of keeping it as a reply", () => {
    const content = "Root.\nhttps://example.com/a";
    const r = render({ platform: "twitter", content, threadItems: [content, "More soon."] });

    moveLinkToThread(r);

    expect(r.content).toBe("Root.");
    expect(r.threadItems![0]).toBe("More soon.");
    expect(r.threadItems).toHaveLength(2);
    expect(r.threadItems![1]).toContain("https://example.com/a");
  });
});

describe("extractLink", () => {
  // The first two moved here from revise.test.ts with revise.ts's re-export.
  it("moves a short link line out whole, keeping its lead-in", () => {
    const out = extractLink("Never miss a call.\n\nSee it live: https://example.com");
    expect(out).toEqual({ body: "Never miss a call.", linkText: "See it live: https://example.com" });
  });

  it("returns null when there is no link", () => {
    expect(extractLink("No link in here at all.")).toBeNull();
  });

  it("keeps every line's prose when moving whole link lines would empty the body", () => {
    const out = extractLink("See it: https://a.example/x\nDocs: https://b.example/y");
    expect(out).toEqual({ body: "See it\nDocs", linkText: "https://a.example/x\nhttps://b.example/y" });
  });

  it("returns every URL on a long line and keeps that line's prose", () => {
    const long = `${"word ".repeat(30)}https://a.example/x and https://b.example/y`;
    const out = extractLink(`Intro\n${long}`);
    expect(out?.linkText).toBe("https://a.example/x https://b.example/y");
    expect(out?.body).not.toContain("https://");
  });
});

describe("trimHashtags", () => {
  it("removes the overflow tags whether they open the text or follow whitespace", () => {
    expect(trimHashtags("#one body #two #three", 1)).toEqual({ text: "#one body", removed: 2 });
    expect(trimHashtags("#one #two", 0)).toEqual({ text: "", removed: 2 });
  });
});

describe("URL_RE", () => {
  it("keeps a balanced parenthesis inside a URL and leaves the wrapping ones outside", () => {
    const text = "Background (see https://en.wikipedia.org/wiki/Foo_(bar)) and https://example.com/a.";
    expect(text.match(URL_RE)).toEqual(["https://en.wikipedia.org/wiki/Foo_(bar)", "https://example.com/a."]);
  });

  it("moves the whole parenthesized URL, so the moved link is not cut at its first paren", () => {
    const r = render({ platform: "facebook", content: "Read this.\nhttps://en.wikipedia.org/wiki/Foo_(bar)" });
    moveLinkToFirstComment(r);
    expect(r.content).toBe("Read this.");
    expect(r.firstComment).toBe("https://en.wikipedia.org/wiki/Foo_(bar)");
  });
});
