// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

/**
 * What the playbooks do when specs.ts stops telling them a limit.
 *
 * `maxHashtags` and `titleMaxChars` are OPTIONAL on PlatformSpec, and specs.ts
 * is explicitly "the fallback, not the authority": its numbers have already
 * drifted once (the Reddit and Pinterest entries), and a platform that is
 * switched off or re-sourced can lose a field without anything failing to
 * compile. Every playbook that reads one of those fields therefore reads it as
 * `SPECS.x.field ?? <the researched number>`.
 *
 * ⛔ THOSE `??` ARMS ARE NOT DECORATION, AND THE FAILURE THEY PREVENT IS SILENT.
 * `keep` flows straight into `countHashtags(text) > keep`, and every comparison
 * against `undefined` is false, so a missing cap does not trim to zero or
 * throw: it stops trimming ENTIRELY, and the post publishes with all fifteen
 * hashtags to a platform that caps at five. The same shape on Pinterest is
 * `[...candidate].slice(0, undefined)`, which returns the WHOLE string, so a
 * derived pin title would be sent at full body length instead of the vendor's
 * 100 characters.
 *
 * The only way to observe that is with a spec that has lost the field, which is
 * why this file mocks specs.ts rather than extending playbook.test.ts. Each
 * test asserts the mock really did remove the field first, so the file cannot
 * quietly stop testing anything if the mock ever drifts.
 */
import { describe, it, expect, vi } from "vitest";

// ⚠️ Only the three optional caps are removed. Everything else on SPECS stays
// real: applyPlaybooks resolves its default per-platform cap from
// `SPECS[p].maxChars` and prefixes every log line with `displayName`, so a
// wholesale stub would change behaviour far outside what is under test here.
vi.mock("../specs.js", async (importActual) => {
  const actual = await importActual<typeof import("../specs.js")>();
  return {
    ...actual,
    SPECS: {
      ...actual.SPECS,
      instagram: { ...actual.SPECS.instagram, maxHashtags: undefined },
      threads: { ...actual.SPECS.threads, maxHashtags: undefined },
      pinterest: { ...actual.SPECS.pinterest, titleMaxChars: undefined },
    },
  };
});

import { applyPlaybooks } from "../playbook.js";
import { SPECS } from "../specs.js";
import type { Platform, PlatformRender, SourcePost } from "../types.js";

function source(overrides: Partial<SourcePost> = {}): SourcePost {
  return { text: "body", hashtags: [], media: [], ...overrides };
}

function render(platform: Platform, overrides: Partial<PlatformRender> = {}): PlatformRender {
  return { platform, content: "copy", mediaIndices: [], ...overrides };
}

describe("a spec that has lost its optional cap", () => {
  it("still trims an Instagram caption to five hashtags", () => {
    expect(SPECS.instagram.maxHashtags).toBeUndefined();

    const r = render("instagram", { content: "Caption. #one #two #three #four #five #six #seven" });
    const result = applyPlaybooks(source(), [r]);

    // ⛔ Five, not seven. Without the fallback `countHashtags(...) > undefined`
    // is false and the caption ships untouched, over a cap Instagram enforces.
    expect((r.content.match(/#/g) ?? []).length).toBe(5);
    expect(result.changed).toEqual(["instagram"]);
  });

  it("still trims a Threads post to the single tag it surfaces", () => {
    expect(SPECS.threads.maxHashtags).toBeUndefined();

    const r = render("threads", { content: "Take. #one #two #three" });
    applyPlaybooks(source(), [r]);

    expect((r.content.match(/#/g) ?? []).length).toBe(1);
  });

  it("still clamps a derived Pinterest title to a hundred characters", () => {
    expect(SPECS.pinterest.titleMaxChars).toBeUndefined();

    // One long unpunctuated opening "sentence", so the derived candidate is the
    // whole body and the clamp is the only thing that can shorten it. Unbroken
    // rather than words, so the count lands exactly on the cap instead of on
    // whatever the trailing trim() leaves behind.
    const r = render("pinterest", { content: `${"a".repeat(300)}.` });
    applyPlaybooks(source({ title: undefined }), [r]);

    // ⚠️ Counted in code points, the way the playbook slices it. Without the
    // fallback `slice(0, undefined)` returns the entire body and the pin title
    // is sent at 300+ characters.
    expect([...(r.title ?? "")].length).toBe(100);
  });
});
