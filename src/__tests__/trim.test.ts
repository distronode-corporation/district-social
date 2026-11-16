import { describe, it, expect } from "vitest";

import { trimLeading, trimLineEnds, trimTrailing } from "../trim.js";
import { isTrackedLinkFalsePositive } from "../qa.js";
import { moveLinkToFirstComment } from "../link-placement.js";
import { normalizeSubreddit } from "../specs.js";
import { inMemoryMediaStore } from "../ports.js";
import { liftTopicTag } from "../threads-transport.js";
import type { Draft } from "../types.js";

/**
 * The trims that replaced five anchored regexes CodeQL flagged as
 * js/polynomial-redos. Each old regex is quadratic on a long run of its
 * character that is followed by something else: about two seconds for 50,000
 * characters on V8. The pins below run that input through each call site and
 * hold it under 200 ms, and the equivalence tests hold each helper to the exact
 * output of the regex it replaced.
 */
const N = 50_000;
const BOUND_MS = 200;

function timed<T>(fn: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}

const PUNCT = ".,;:!?";
const SAMPLES = [
  "",
  "x",
  ".",
  "...",
  "!?;:,.",
  "https://example.com.",
  "https://example.com/path?!",
  "https://example.com/a.b",
  "mid.dle. text",
  "café…!",
  "日本語。.",
  "emoji 🎉..",
  "/",
  "///",
  "/r/sub/",
  "//a//b//",
  "a/",
  " ",
  "\t",
  "a \n",
  "a\t \nb  \n\tc",
  " \n \n",
  "\n",
  "no newline   ",
  "tabs\t\t\n",
  "unicode é \n ü\t",
];

describe("trimTrailing", () => {
  it("matches /[.,;:!?]+$/ on normal input", () => {
    for (const s of SAMPLES) expect(trimTrailing(s, PUNCT)).toBe(s.replace(/[.,;:!?]+$/, ""));
  });

  it("matches /\\/+$/ on normal input", () => {
    for (const s of SAMPLES) expect(trimTrailing(s, "/")).toBe(s.replace(/\/+$/, ""));
  });

  it("is linear on a long run followed by another character, and on one at the end", () => {
    const mid = timed(() => trimTrailing(`${".".repeat(N)}x`, PUNCT));
    expect(mid.value).toBe(`${".".repeat(N)}x`);
    expect(mid.ms).toBeLessThan(BOUND_MS);
    const end = timed(() => trimTrailing(".".repeat(N), PUNCT));
    expect(end.value).toBe("");
    expect(end.ms).toBeLessThan(BOUND_MS);
  });
});

describe("trimLeading", () => {
  it("with trimTrailing matches /^\\/+|\\/+$/g on normal input", () => {
    for (const s of SAMPLES) expect(trimLeading(trimTrailing(s, "/"), "/")).toBe(s.replace(/^\/+|\/+$/g, ""));
  });

  it("is linear on a long run followed by another character, and on one alone", () => {
    const mid = timed(() => trimLeading(`${"/".repeat(N)}x`, "/"));
    expect(mid.value).toBe("x");
    expect(mid.ms).toBeLessThan(BOUND_MS);
    const all = timed(() => trimLeading("/".repeat(N), "/"));
    expect(all.value).toBe("");
    expect(all.ms).toBeLessThan(BOUND_MS);
  });
});

describe("trimLineEnds", () => {
  it("matches .replace(/[ \\t]+\\n/g, \"\\n\") on normal input", () => {
    for (const s of SAMPLES) expect(trimLineEnds(s)).toBe(s.replace(/[ \t]+\n/g, "\n"));
  });

  it("is linear on a long run of spaces followed by another character, and on one at the end", () => {
    const mid = timed(() => trimLineEnds(`${" ".repeat(N)}x`));
    expect(mid.value).toBe(`${" ".repeat(N)}x`);
    expect(mid.ms).toBeLessThan(BOUND_MS);
    const end = timed(() => trimLineEnds(" ".repeat(N)));
    expect(end.value).toBe(" ".repeat(N));
    expect(end.ms).toBeLessThan(BOUND_MS);
    const nl = timed(() => trimLineEnds(`${" \t".repeat(N)}\nx`));
    expect(nl.value).toBe("\nx");
    expect(nl.ms).toBeLessThan(BOUND_MS);
  });
});

/** Each call site, fed the input that made its old regex quadratic. */
describe("the call sites the trims replaced", () => {
  it("qa normalizeUrl (via isTrackedLinkFalsePositive) on a long punctuation run", () => {
    const TRACKED = "https://acmebrands.com/l/abc123";
    const brand = { linkDomains: () => ["acmebrands.com"] };
    const draft = (link: string): Draft => ({
      id: "d1",
      createdAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-20T00:00:00.000Z",
      status: "draft",
      source: { text: "t", hashtags: [], media: [], link },
      targets: ["linkedin"],
      renders: [{ platform: "linkedin", content: `See ${TRACKED}`, mediaIndices: [] }],
    });
    const issue = (url: string) => ({ code: "wrong-link", message: `${TRACKED} instead of ${url}`, fix: "f" });

    // A run followed by "x" stays in the URL, so it equals the source only verbatim.
    const longMid = `https://acmebrands.com/news${".".repeat(N)}x`;
    const mid = timed(() => isTrackedLinkFalsePositive(issue(longMid), draft(longMid), brand));
    expect(mid.value).toBe(true);
    expect(mid.ms).toBeLessThan(BOUND_MS);
    const other = isTrackedLinkFalsePositive(issue(longMid), draft("https://acmebrands.com/news"), brand);
    expect(other).toBe(false);

    // A run at the end is sentence punctuation and is trimmed off.
    const end = timed(() =>
      isTrackedLinkFalsePositive(issue(`https://acmebrands.com/news${".".repeat(N)}`), draft("https://www.acmebrands.com/news"), brand),
    );
    expect(end.value).toBe(true);
    expect(end.ms).toBeLessThan(BOUND_MS);
  });

  it("link-placement urlSet (via moveLinkToFirstComment) on a long punctuation run", () => {
    const mid = `https://example.com/a${".".repeat(N)}x`;
    const r = { platform: "facebook" as const, content: `Read this ${mid}`, mediaIndices: [], firstComment: mid };
    const t1 = timed(() => moveLinkToFirstComment(r));
    expect(t1.value).not.toBeNull();
    expect(r.firstComment).toBe(mid);
    expect(t1.ms).toBeLessThan(BOUND_MS);

    // The comment's link with a trailing run is the same URL, so nothing is appended.
    const r2 = {
      platform: "facebook" as const,
      content: "Read this https://example.com/a",
      mediaIndices: [],
      firstComment: `https://example.com/a${".".repeat(N)}`,
    };
    const t2 = timed(() => moveLinkToFirstComment(r2));
    expect(t2.value).not.toBeNull();
    expect(r2.firstComment).toBe(`https://example.com/a${".".repeat(N)}`);
    expect(t2.ms).toBeLessThan(BOUND_MS);
  });

  it("specs normalizeSubreddit on a long slash run", () => {
    const mid = timed(() => normalizeSubreddit(`a${"/".repeat(N)}x`));
    expect(mid.value).toBe(`a${"/".repeat(N)}x`);
    expect(mid.ms).toBeLessThan(BOUND_MS);
    const end = timed(() => normalizeSubreddit(`r/Sub${"/".repeat(N)}`));
    expect(end.value).toBe("sub");
    expect(end.ms).toBeLessThan(BOUND_MS);
    expect(normalizeSubreddit("/")).toBeUndefined();
  });

  it("specs normalizeSubreddit matches the old chain on normal input", () => {
    const old = (input: string) =>
      input.trim().replace(/^\/?r\//i, "").replace(/^\/+|\/+$/g, "").toLowerCase() || undefined;
    for (const s of [...SAMPLES, " /r/Foo/ ", "R/bar", "r//baz//", "r/", "/r/"]) expect(normalizeSubreddit(s)).toBe(old(s));
  });

  it("ports inMemoryMediaStore base URL on a long slash run", async () => {
    const mid = `memory://m${"/".repeat(N)}x`;
    const t1 = timed(() => inMemoryMediaStore(mid).put("k", new Uint8Array([1]), "image/png"));
    expect((await t1.value).url).toBe(`${mid}/k`);
    expect(t1.ms).toBeLessThan(BOUND_MS);
    const t2 = timed(() => inMemoryMediaStore(`memory://m${"/".repeat(N)}`).put("k", new Uint8Array([1]), "image/png"));
    expect((await t2.value).url).toBe("memory://m/k");
    expect(t2.ms).toBeLessThan(BOUND_MS);
  });

  it("threads liftTopicTag on a long run of spaces", () => {
    const mid = timed(() => liftTopicTag(`a${" ".repeat(N)}x #tag`));
    expect(mid.value).toEqual({ text: "a x", topicTag: "tag" });
    expect(mid.ms).toBeLessThan(BOUND_MS);
    const nl = timed(() => liftTopicTag(`a #tag${" \t".repeat(N)}\nb`));
    expect(nl.value).toEqual({ text: "a\nb", topicTag: "tag" });
    expect(nl.ms).toBeLessThan(BOUND_MS);
  });
});
