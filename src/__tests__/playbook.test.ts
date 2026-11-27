// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-platform playbook coverage.
 *
 * These transforms exist because a prompt is a suggestion. The X link rule alone
 * is worth up to ~94% of a post's reach and the formatter prompt left threads to
 * the model's discretion, so the highest-value mechanic on the highest-penalty
 * platform used to be a coin flip. Every test here is really asking "is this
 * still deterministic".
 *
 * Idempotency gets its own test per transform-carrying platform: formatPost runs
 * this pass, and the reformat and fix paths re-enter formatPost, so a
 * non-idempotent playbook would move a link into a reply, then move the reply's
 * link again, and so on.
 */
import { describe, it, expect, afterEach } from "vitest";

import { applyPlaybooks, LINK_POLICIES, LINKEDIN_LINK_POLICY, PLAYBOOK_TUNING } from "../playbook.js";
import { SPECS } from "../specs.js";
import { sentContents } from "../publish.js";
import { ALL_PLATFORMS } from "../types.js";
import type { Platform, PlatformRender, SourcePost } from "../types.js";

const LINK = "https://example.com/district";

function source(overrides: Partial<SourcePost> = {}): SourcePost {
  return { text: "body", hashtags: [], media: [], link: LINK, ...overrides };
}

function render(platform: Platform, overrides: Partial<PlatformRender> = {}): PlatformRender {
  return { platform, content: "copy", mediaIndices: [], ...overrides };
}

/** Run the pass and hand back the single render for convenience. */
function run(r: PlatformRender, src: SourcePost = source()) {
  const result = applyPlaybooks(src, [r]);
  return { r, result };
}

describe("X (twitter)", () => {
  it("strips the link out of the root post and makes it the reply", () => {
    // The transport publishes `content` and chains each thread item as a reply,
    // so a thread item IS "a comment written on the post after it went out".
    const { r, result } = run(
      render("twitter", { content: `District AI answers every call.\nSee it: ${LINK}` }),
    );
    expect(r.content).toBe("District AI answers every call.");
    // Replies only: the root is never repeated as item 0.
    expect(r.threadItems).toHaveLength(1);
    expect(r.threadItems![0]).toContain(LINK);
    expect(result.changed).toEqual(["twitter"]);
  });

  it("leaves a root that has no link alone", () => {
    const { r, result } = run(render("twitter", { content: "No link in this one." }));
    expect(r.threadItems).toBeUndefined();
    expect(result.changed).toEqual([]);
  });

  it("is idempotent", () => {
    const r = render("twitter", { content: `Hook line.\n${LINK}` });
    applyPlaybooks(source(), [r]);
    const afterFirst = JSON.stringify(r);
    const second = applyPlaybooks(source(), [r]);
    expect(JSON.stringify(r)).toBe(afterFirst);
    expect(second.changed).toEqual([]);
  });

  it("keeps an existing thread and does not add a second link item", () => {
    const r = render("twitter", { content: `Point one. ${LINK}`, threadItems: [`More: ${LINK}`] });
    applyPlaybooks(source(), [r]);
    expect(r.content).toBe("Point one.");
    expect(r.threadItems).toEqual([`More: ${LINK}`]);
  });
});

describe("Facebook", () => {
  it("moves the link to the first comment, where links are unlimited", () => {
    // Non-verified Pages get ~2 body-link posts a MONTH before reach collapses.
    const { r } = run(render("facebook", { content: `Read the writeup: ${LINK}` }));
    expect(r.content).not.toContain(LINK);
    expect(r.firstComment).toContain(LINK);
  });

  it("is idempotent", () => {
    const r = render("facebook", { content: `Body text.\n${LINK}` });
    applyPlaybooks(source(), [r]);
    const afterFirst = JSON.stringify(r);
    applyPlaybooks(source(), [r]);
    expect(JSON.stringify(r)).toBe(afterFirst);
  });
});

describe("LinkedIn", () => {
  it("leaves the link in the body, because every relocation is dominated", () => {
    // Researched: the first-comment move is penalized JUST AS HEAVILY
    // as a body link, because the algorithm reads comments immediately and treats
    // an author's link comment as bridge behaviour. So that move pays the same
    // cost, adds a detection signal, and buries the link where fewer people look.
    // Doing nothing is the honest answer; QA still reports the penalty.
    const { result, r } = run(render("linkedin", { content: `Full breakdown: ${LINK}` }));
    expect(LINKEDIN_LINK_POLICY).toBe("body");
    expect(r.content).toContain(LINK);
    expect(r.firstComment).toBeUndefined();
    expect(result.changed).toEqual([]);
  });

  it("is marked so the mechanical fix pass does not relocate it either", () => {
    // Without this flag the fix loop would undo the decision on its next round.
    expect(SPECS.linkedin.firstCommentLinkPenalized).toBe(true);
  });

  it("leaves a link-free post completely alone, inventing no first comment", () => {
    // ⚠️ The early return is the whole LinkedIn playbook for most posts. If it
    // ever fell through to the policy switch, an ordinary text post would come
    // back carrying an empty firstComment, and publish.ts sends firstComment as
    // a second value: LinkedIn would get a blank comment on every post.
    const { r, result } = run(render("linkedin", { content: "No link, just the take." }));
    expect(r.content).toBe("No link, just the take.");
    expect(r.firstComment).toBeUndefined();
    expect(result.changed).toEqual([]);
    expect(result.applied).toEqual([]);
  });
});

describe("Instagram", () => {
  it("drops the unclickable URL and points at the bio instead", () => {
    const { r } = run(render("instagram", { content: `Book a demo: ${LINK}` }));
    expect(r.content).not.toContain(LINK);
    expect(r.content).toMatch(/link in bio/i);
  });

  it("does not add a second bio pointer when one is already there", () => {
    const r = render("instagram", { content: `Link in bio.\nMore here: ${LINK}` });
    applyPlaybooks(source(), [r]);
    expect(r.content.toLowerCase().match(/link in bio/g)).toHaveLength(1);
  });

  it("trims the caption to the 5-hashtag cap", () => {
    const { r } = run(
      render("instagram", {
        content: "Caption. #one #two #three #four #five #six #seven",
      }),
    );
    expect((r.content.match(/#/g) ?? []).length).toBe(5);
  });

  it("says nothing about a bio when the post has no link to point at", () => {
    const { r } = run(
      render("instagram", { content: `See ${LINK}` }),
      source({ link: undefined }),
    );
    expect(r.content).not.toMatch(/link in bio/i);
  });
});

describe("Pinterest", () => {
  it("adds the title the feed actually shows, from copy that already exists", () => {
    // The pin feed shows image + title, not the description, so a missing title
    // throws away the only text a browsing user reads.
    const { r } = run(
      render("pinterest", { content: "Voice agents answer after hours. More detail here." }),
      source({ title: "AI voice agents for small business" }),
    );
    expect(r.title).toBe("AI voice agents for small business");
  });

  it("falls back to the opening sentence rather than inventing one", () => {
    const { r } = run(
      render("pinterest", { content: "Never miss another call. Second sentence here." }),
      source({ title: undefined }),
    );
    expect(r.title).toBe("Never miss another call.");
  });

  it("clamps a derived title to the vendor's 100 characters", () => {
    const long = `${"word ".repeat(60)}end.`;
    const { r } = run(render("pinterest", { content: long }), source({ title: undefined }));
    expect([...(r.title ?? [])].length).toBeLessThanOrEqual(SPECS.pinterest.titleMaxChars!);
  });

  it("keeps a title the formatter already wrote", () => {
    const { r } = run(render("pinterest", { content: "copy", title: "Chosen title" }));
    expect(r.title).toBe("Chosen title");
  });

  it("drops the URL without offering a bio, since the destination is a setting", () => {
    const { r } = run(render("pinterest", { content: `Guide: ${LINK}`, title: "T" }));
    expect(r.content).not.toContain(LINK);
    expect(r.content).not.toMatch(/link in bio/i);
  });

  it("removes every hashtag, which Pinterest deprecated", () => {
    const { r } = run(render("pinterest", { content: "Copy here. #voice #ai", title: "T" }));
    expect(r.content).not.toContain("#");
  });

  it("writes no title at all when there is no existing copy to derive one from", () => {
    // ⛔ Rule 2 of this file: a playbook rearranges, trims and drops, it never
    // writes marketing copy. With no source title and no body, the only way to
    // produce a pin title is to invent one, so the honest outcome is no title
    // and a QA `title-missing` finding the operator has to resolve.
    const { r, result } = run(
      render("pinterest", { content: "" }),
      source({ title: undefined, text: "" }),
    );
    expect(r.title).toBeUndefined();
    expect(result.changed).toEqual([]);
  });
});

describe("Threads", () => {
  it("keeps a single topic tag", () => {
    const { r } = run(render("threads", { content: "Take. #one #two #three" }));
    expect((r.content.match(/#/g) ?? []).length).toBe(1);
  });

  it("says 'cut 1 hashtag', not 'cut 1 hashtags', when exactly one comes off", () => {
    // ⚠️ `applied` is not debug output. It is the change list an operator reads
    // in Social HQ before approving a post, next to the lines this file writes
    // about links and titles, and it is the only place the pass explains itself.
    // Every other hashtag test here asserts the resulting CONTENT and lets the
    // log line go unread, so both arms of the count ran without anything ever
    // checking what they said.
    const { result } = run(render("threads", { content: "Take. #one #two" }));
    expect(result.applied).toEqual(["Threads: cut 1 hashtag (Threads surfaces one tag)"]);

    const many = run(render("threads", { content: "Take. #one #two #three" }));
    expect(many.result.applied).toEqual(["Threads: cut 2 hashtags (Threads surfaces one tag)"]);
  });
});

describe("Reddit", () => {
  it("removes hashtags from body and title", () => {
    const { r } = run(
      render("reddit", { content: "Writeup. #saas #startup", title: "Title #saas" }),
    );
    expect(r.content).not.toContain("#");
    expect(r.title).not.toContain("#");
  });

  it("carries the source title over, since Reddit requires one", () => {
    const { r } = run(render("reddit", { content: "body" }), source({ title: "Real title" }));
    expect(r.title).toBe("Real title");
  });

  it("clamps a carried-over title to Reddit's 300 characters, which Reddit refuses past", () => {
    const { r } = run(render("reddit", { content: "body" }), source({ title: "t".repeat(400) }));
    expect([...r.title!]).toHaveLength(SPECS.reddit.titleMaxChars!);
  });
});

describe("Bluesky", () => {
  it("leaves a link in the body, which is correct there", () => {
    // Clickable, unfurls, no known penalty: moving it would be a downgrade.
    const { r, result } = run(render("bluesky", { content: `Shipped it: ${LINK}` }));
    expect(r.content).toContain(LINK);
    expect(result.changed).toEqual([]);
  });

  it("rescues the link when the post is over budget", () => {
    // Bluesky counts the full URL against 300 chars, so an over-budget post is
    // about to be hard-trimmed, and a trim landing mid-URL produces a link that
    // looks real and goes nowhere. Two published posts carry exactly that damage.
    const long = "x".repeat(290);
    const { r } = run(render("bluesky", { content: `${long}\n${LINK}` }));
    expect(r.content).not.toContain(LINK);
    expect(r.threadItems?.join(" ")).toContain(LINK);
  });
});

/**
 * A body that is NOTHING but a link.
 *
 * Every relocation here asks link-placement to split the body in two, and it
 * refuses when the half that would stay behind is empty (`!split.body.trim()`).
 * These tests pin that refusal at the playbook boundary, because the alternative
 * is what the refusal exists to prevent: an empty root post with the URL moved
 * into a reply or a comment. X rejects an empty post outright, Facebook and
 * Bluesky publish a blank one, and in every case the copy the operator wrote is
 * no longer where anyone reads it.
 *
 * ⚠️ Each of these looks like a no-op test and is not: the assertion that
 * matters is `changed` staying EMPTY, which is how applyPlaybooks reports "I
 * left this render alone" to the formatter.
 */
describe("a body that is nothing but a link", () => {
  it("leaves the X root post intact rather than emptying it into a reply", () => {
    const { r, result } = run(render("twitter", { content: LINK }));
    expect(r.content).toBe(LINK);
    expect(r.threadItems).toBeUndefined();
    expect(result.changed).toEqual([]);
  });

  it("leaves the Facebook body intact rather than moving all of it to the comment", () => {
    const { r, result } = run(render("facebook", { content: LINK }));
    expect(r.content).toBe(LINK);
    expect(r.firstComment).toBeUndefined();
    expect(result.changed).toEqual([]);
  });

  it("leaves an over-budget Bluesky post intact when there is no prose to keep", () => {
    // Over budget (the caller's cap is 5) AND link-only, so the rescue has
    // nothing to rescue. Publishing a too-long link beats publishing nothing.
    const r = render("bluesky", { content: LINK });
    const result = applyPlaybooks(source(), [r], () => 5);
    expect(r.content).toBe(LINK);
    expect(r.threadItems).toBeUndefined();
    expect(result.changed).toEqual([]);
  });

  /**
   * ⛔ THE TWO PLATFORMS THAT DID NOT REFUSE. X, Facebook and Bluesky reach this
   * case through moveLinkToThread / moveLinkToFirstComment, which have always
   * guarded on an empty remaining body. Instagram and Pinterest route through
   * dropBodyLink instead, and that guard was missing, so instead of being left
   * alone they were EMPTIED: Instagram published "Link in bio." with the link
   * itself deleted (or "" when the source had no link), and Pinterest published
   * a blank description. Same doctrine, same expectation.
   */
  it("leaves the Instagram caption intact rather than replacing the link with a pointer to nothing", () => {
    const { r, result } = run(render("instagram", { content: LINK }));
    expect(r.content).toBe(LINK);
    expect(result.changed).toEqual([]);
  });

  it("leaves the Instagram caption intact when the source has no link to point at", () => {
    // The `source.link ? "Link in bio." : undefined` arm. Without the guard this
    // one emptied the caption to "" outright, with nothing put back.
    const r = render("instagram", { content: LINK });
    const result = applyPlaybooks({ ...source(), link: undefined }, [r]);
    expect(r.content).toBe(LINK);
    expect(result.changed).toEqual([]);
  });

  it("leaves the Pinterest description intact rather than blanking it", () => {
    const { r, result } = run(render("pinterest", { content: LINK, title: "A real title" }));
    expect(r.content).toBe(LINK);
    // ⚠️ The title is supplied here so this test pins the DESCRIPTION rule only.
    // With no title, playbook derives one from the body, which for a link-only
    // body is the raw URL. That is a separate, still-open issue; do not "fix"
    // this test by dropping the title.
    expect(r.title).toBe("A real title");
    expect(result.changed).toEqual([]);
  });
});

describe("applyPlaybooks", () => {
  it("reports only the platforms it actually changed", () => {
    const renders = [
      render("twitter", { content: `Hook. ${LINK}` }),
      render("bluesky", { content: "Short and clean." }),
    ];
    const result = applyPlaybooks(source(), renders);
    expect(result.changed).toEqual(["twitter"]);
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]).toMatch(/^X \/ Twitter:/);
  });

  it("ignores a platform with no playbook instead of throwing", () => {
    const renders = [render("youtube", { content: "Description", title: "T" })];
    expect(() => applyPlaybooks(source(), renders)).not.toThrow();
    expect(applyPlaybooks(source(), renders).changed).toEqual([]);
  });

  it("uses the caller's effective cap, not the hardcoded spec limit", () => {
    // Bluesky is the only cap-sensitive playbook; a generous live cap means the
    // post is not over budget and the link should stay in the body.
    const r = render("bluesky", { content: `${"x".repeat(290)}\n${LINK}` });
    applyPlaybooks(source(), [r], () => 5000);
    expect(r.content).toContain(LINK);
  });

  it("survives every modelled platform without throwing", () => {
    for (const p of ALL_PLATFORMS) {
      const r = render(p, { content: `Copy with a link ${LINK} and #tag`, title: "Title" });
      expect(() => applyPlaybooks(source(), [r])).not.toThrow();
    }
  });
});

describe("PLAYBOOK_TUNING", () => {
  it("ships every follow-up delay at zero", () => {
    // Zero is the only vendor-verified behaviour, and it already satisfies "the
    // link goes out as a comment after the post". A nonzero delay is unobservable
    // on failure, so raising these requires the live proof first.
    for (const tuning of Object.values(PLAYBOOK_TUNING)) {
      expect(tuning?.followupDelayMinutes).toBe(0);
    }
  });

  it("leaves followupDelayMinutes unset while tuning is zero", () => {
    const { r } = run(render("twitter", { content: `Hook. ${LINK}` }));
    expect(r.followupDelayMinutes).toBeUndefined();
  });

  describe("once a delay is raised (the state this table exists to reach)", () => {
    // ⚠️ Mutates the exported table and restores it. Doing it any other way
    // means this transform stays untested until the day someone raises a delay
    // in production, which is the worst possible moment to discover that the
    // render never carried it. Restore is unconditional: a leaked nonzero delay
    // would flip the "ships every delay at zero" test above in another file.
    const original = PLAYBOOK_TUNING.twitter?.followupDelayMinutes;
    afterEach(() => {
      PLAYBOOK_TUNING.twitter!.followupDelayMinutes = original!;
    });

    it("stamps the delay on the render and counts that alone as a change", () => {
      PLAYBOOK_TUNING.twitter!.followupDelayMinutes = 3;
      const { r, result } = run(render("twitter", { content: "No link here." }));
      expect(r.followupDelayMinutes).toBe(3);
      // Nothing about the copy moved, so `applied` is empty, yet the render DID
      // change. If applyPlaybooks compared logs instead of the render itself,
      // the delay would be written and never reported.
      expect(result.applied).toEqual([]);
      expect(result.changed).toEqual(["twitter"]);
    });

    it("carries the delay into the value QA reads when deciding to warn", () => {
      // qa.ts fires `followup-delay-unused` (warn) when a delay is set on a
      // render that sends only ONE value, since nothing would be deferred.
      PLAYBOOK_TUNING.twitter!.followupDelayMinutes = 7;
      const { r } = run(render("twitter", { content: `Hook. ${LINK}` }));
      expect(r.followupDelayMinutes).toBe(7);
      // The link move made this a two-value render (root plus one reply), so
      // the delay is used.
      expect(sentContents(r)).toHaveLength(2);
    });
  });
});

/**
 * The LinkedIn policy that is not the default. It is a documented switch (see
 * LINKEDIN_LINK_POLICY), so it has to do what its docblock says the day
 * someone flips it, including refusing to empty a link-only post. There is no
 * first-comment policy: the LinkedIn transport never sends one.
 */
describe("LinkedIn alternative link policy", () => {
  afterEach(() => {
    LINK_POLICIES.linkedin = "body";
  });

  it("none strips the link and says the click path is gone", () => {
    LINK_POLICIES.linkedin = "none";
    const { r, result } = run(render("linkedin", { content: `Full breakdown.\n${LINK}` }));
    expect(r.content).toBe("Full breakdown.");
    expect(r.firstComment).toBeUndefined();
    expect(result.applied[0]).toMatch(/dropped the URL .*\(keeps full reach, gives up the click path\)$/);
  });

  it("none leaves a link-only post alone rather than emptying it", () => {
    LINK_POLICIES.linkedin = "none";
    const { r, result } = run(render("linkedin", { content: LINK }));
    expect(r.content).toBe(LINK);
    expect(result.applied).toEqual([]);
  });
});
