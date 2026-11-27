// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { readCappedBody } from "../read-capped.js";

/**
 * Unit cover for the shared capped reader. Its callers each exercise it
 * through their own refusal tests; these pin the reader's own contract directly, including
 * the boundary (exactly the cap passes, one byte more refuses) and the two
 * ways a body can exceed it: declared up front, or discovered while streaming.
 */

describe("readCappedBody", () => {
  it("returns the streamed bytes when the body is under the cap", async () => {
    const read = await readCappedBody(new Response(new Uint8Array([1, 2, 3])), 10);
    expect(read).toEqual({ ok: true, bytes: new Uint8Array([1, 2, 3]) });
  });

  it("refuses before reading a byte when Content-Length already declares more than the cap", async () => {
    const read = await readCappedBody(new Response(new Uint8Array([1]), { headers: { "content-length": "999999" } }), 10);
    expect(read).toEqual({ ok: false, reason: "too_large" });
  });

  it("refuses while streaming when an undeclared body crosses the cap", async () => {
    const read = await readCappedBody(new Response(new Uint8Array(16)), 10);
    expect(read).toEqual({ ok: false, reason: "too_large" });
  });

  it("reads a body of exactly the cap, and refuses one byte more", async () => {
    expect(await readCappedBody(new Response(new Uint8Array(10)), 10)).toEqual({
      ok: true,
      bytes: new Uint8Array(10),
    });
    expect(await readCappedBody(new Response(new Uint8Array(11)), 10)).toEqual({ ok: false, reason: "too_large" });
  });

  it("reads an absent body (a 204) as empty bytes rather than refusing", async () => {
    const read = await readCappedBody(new Response(null), 10);
    expect(read).toEqual({ ok: true, bytes: new Uint8Array(0) });
  });

  it("ignores a Content-Length that does not parse as a finite number", async () => {
    // A hostile or broken host can send any header value; a non-numeric one
    // must fall through to the streaming cap, not refuse or throw.
    const read = await readCappedBody(new Response(new Uint8Array([4]), { headers: { "content-length": "go away" } }), 10);
    expect(read).toEqual({ ok: true, bytes: new Uint8Array([4]) });
  });

  it("still refuses when releasing the refused body fails, before and while streaming", async () => {
    // A cancel that rejects has nothing left to tell the caller: the read is
    // already refused, so the rejection is swallowed rather than thrown.
    const refusingCancel = () => Promise.reject(new Error("socket already gone"));

    const declared = {
      headers: new Headers({ "content-length": "999999" }),
      body: { cancel: refusingCancel },
    } as unknown as Response;
    expect(await readCappedBody(declared, 10)).toEqual({ ok: false, reason: "too_large" });

    let sent = false;
    const streamed = {
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: new Uint8Array(16) })),
          cancel: refusingCancel,
        }),
      },
    } as unknown as Response;
    expect(await readCappedBody(streamed, 10)).toEqual({ ok: false, reason: "too_large" });
  });
});
