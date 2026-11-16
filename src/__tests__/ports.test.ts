import { describe, it, expect, vi } from "vitest";

vi.mock("../claude.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../claude.js")>()),
  genJson: vi.fn(async () => ({ ok: true })),
}));

import { genJson } from "../claude.js";
import {
  ApprovalRefusedError,
  claudeLlm,
  inMemoryApprovalGate,
  inMemoryCredentialStore,
  inMemoryDraftStore,
  inMemoryLock,
  inMemoryMediaStore,
  manualClock,
  scriptedLlm,
  systemClock,
  type ApprovalGate,
} from "../ports.js";
import type { Draft } from "../types.js";

function draft(id: string, updatedAt: string): Draft {
  return {
    id,
    createdAt: updatedAt,
    updatedAt,
    status: "draft",
    source: { text: "t", hashtags: [], media: [] },
    targets: ["linkedin"],
    renders: [{ platform: "linkedin", content: "hello", mediaIndices: [] }],
  };
}

describe("clocks", () => {
  it("systemClock reads the wall clock", () => {
    const before = Date.now();
    const t = systemClock.now().getTime();
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(Date.now());
  });

  it("manualClock moves only when told to", () => {
    const clock = manualClock(new Date("2030-01-01T00:00:00Z"));
    expect(clock.now().toISOString()).toBe("2030-01-01T00:00:00.000Z");
    clock.advance(1500);
    expect(clock.now().toISOString()).toBe("2030-01-01T00:00:01.500Z");
    clock.set(new Date("2031-06-01T00:00:00Z"));
    expect(clock.now().toISOString()).toBe("2031-06-01T00:00:00.000Z");
    expect(manualClock().now().getTime()).toBe(0);
  });
});

describe("LlmClient", () => {
  it("claudeLlm hands the prompt and options to genJson at call time", async () => {
    const opts = { schema: { type: "object" } };
    await expect(claudeLlm.generateJson("p", opts)).resolves.toEqual({ ok: true });
    expect(vi.mocked(genJson)).toHaveBeenCalledWith("p", opts);
  });

  it("scriptedLlm answers from its script and records every prompt", async () => {
    const llm = scriptedLlm((prompt) => ({ echo: prompt.length }));
    await expect(llm.generateJson("abc", { schema: {} })).resolves.toEqual({ echo: 3 });
    await llm.generateJson("de", { schema: {} });
    expect(llm.prompts).toEqual(["abc", "de"]);
  });
});

describe("inMemoryLock", () => {
  it("admits one holder per key until release", async () => {
    const lock = inMemoryLock(manualClock());
    const a = await lock.acquire("k", 1000);
    expect(a?.key).toBe("k");
    expect(await lock.acquire("k", 1000)).toBeNull();
    expect(await lock.acquire("other", 1000)).not.toBeNull();
    await a!.release();
    await a!.release();
    expect(await lock.acquire("k", 1000)).not.toBeNull();
  });

  it("lets an expired lease be taken, and the old holder's release leaves the new lease alone", async () => {
    const clock = manualClock();
    const lock = inMemoryLock(clock);
    const old = await lock.acquire("k", 100);
    clock.advance(100);
    const next = await lock.acquire("k", 100);
    expect(next).not.toBeNull();
    await old!.release();
    expect(await lock.acquire("k", 100)).toBeNull();
  });

  it("refuses a lease with no positive ttl", async () => {
    const lock = inMemoryLock();
    await expect(lock.acquire("k", 0)).rejects.toThrow(RangeError);
    await expect(lock.acquire("k", Number.NaN)).rejects.toThrow(RangeError);
  });
});

describe("inMemoryDraftStore", () => {
  it("puts, gets, lists newest first and deletes, by copy", async () => {
    const store = inMemoryDraftStore();
    const d1 = draft("d1", "2030-01-01T00:00:00.000Z");
    await store.put(d1);
    await store.put(draft("d2", "2030-01-02T00:00:00.000Z"));
    d1.renders[0]!.content = "mutated after put";
    const got = await store.get("d1");
    expect(got?.renders[0]?.content).toBe("hello");
    got!.status = "published";
    expect((await store.get("d1"))?.status).toBe("draft");
    expect((await store.list()).map((d) => d.id)).toEqual(["d2", "d1"]);
    expect(await store.delete("d1")).toBe(true);
    expect(await store.delete("d1")).toBe(false);
    expect(await store.get("d1")).toBeNull();
  });
});

describe("inMemoryCredentialStore", () => {
  it("reads seeded values, sets, deletes, and refuses an empty value", async () => {
    const store = inMemoryCredentialStore({ A: "1" });
    expect(await store.get("A")).toBe("1");
    expect(await store.get("B")).toBeNull();
    await store.set("B", "2");
    expect(await store.get("B")).toBe("2");
    await expect(store.set("C", "")).rejects.toThrow(/empty credential for C/);
    await store.delete("A");
    expect(await store.get("A")).toBeNull();
    expect(await inMemoryCredentialStore().get("A")).toBeNull();
  });
});

describe("inMemoryMediaStore", () => {
  it("stores bytes by copy and serves them under the base URL", async () => {
    const store = inMemoryMediaStore("https://media.example.com/");
    const body = new Uint8Array([1, 2, 3]);
    const stored = await store.put("cards/a.png", body, "image/png");
    expect(stored).toEqual({ key: "cards/a.png", contentType: "image/png", bytes: 3, url: "https://media.example.com/cards/a.png" });
    body[0] = 9;
    const got = await store.get("cards/a.png");
    expect([...got!.body]).toEqual([1, 2, 3]);
    got!.body[1] = 9;
    expect([...(await store.get("cards/a.png"))!.body]).toEqual([1, 2, 3]);
    await store.delete("cards/a.png");
    expect(await store.get("cards/a.png")).toBeNull();
  });

  it("defaults to a memory:// base and refuses keys that escape it", async () => {
    const store = inMemoryMediaStore();
    expect((await store.put("x.png", new Uint8Array(), "image/png")).url).toBe("memory://media/x.png");
    for (const bad of ["", "/abs.png", "a/../b.png", ".."]) {
      await expect(store.put(bad, new Uint8Array(), "image/png")).rejects.toThrow(/invalid media key/);
    }
  });
});

describe("inMemoryApprovalGate", () => {
  const subject = { draftId: "d1", rendersHash: "h1" };
  const grant = (gate: ReturnType<typeof inMemoryApprovalGate>, id = "ap1") =>
    gate.grant({ id, draftId: "d1", rendersHash: "h1", approvedBy: "approver@example.com", mode: "now" });

  it("stamps the grant with the clock and consumes it exactly once", async () => {
    const gate = inMemoryApprovalGate(manualClock(new Date("2030-01-01T00:00:00Z")));
    const granted = grant(gate);
    expect(granted.approvedAt).toBe("2030-01-01T00:00:00.000Z");
    await expect(gate.consume("ap1", subject)).resolves.toMatchObject({ id: "ap1", approvedBy: "approver@example.com" });
    await expect(gate.consume("ap1", subject)).rejects.toMatchObject({ name: "ApprovalRefusedError", reason: "used" });
  });

  it("keeps an explicit approvedAt", () => {
    const gate = inMemoryApprovalGate();
    const a = gate.grant({
      id: "ap1",
      draftId: "d1",
      rendersHash: "h1",
      approvedBy: "a",
      approvedAt: "2030-02-02T00:00:00.000Z",
      mode: "at",
      scheduledFor: "2030-02-03T00:00:00.000Z",
    });
    expect(a.approvedAt).toBe("2030-02-02T00:00:00.000Z");
  });

  it("refuses an unknown id, another draft and changed renders, without using the approval up", async () => {
    const gate = inMemoryApprovalGate();
    grant(gate);
    const refused = async (id: string, s: typeof subject) => {
      const err = await gate.consume(id, s).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApprovalRefusedError);
      return (err as ApprovalRefusedError).reason;
    };
    expect(await refused("nope", subject)).toBe("unknown");
    expect(await refused("ap1", { ...subject, draftId: "d2" })).toBe("wrong-draft");
    expect(await refused("ap1", { ...subject, rendersHash: "h2" })).toBe("renders-changed");
    await expect(gate.consume("ap1", subject)).resolves.toMatchObject({ id: "ap1" });
  });

  it("refuses a grant with no approver or a duplicate id", () => {
    const gate = inMemoryApprovalGate();
    expect(() => gate.grant({ id: "x", draftId: "d", rendersHash: "h", approvedBy: "", mode: "now" })).toThrow(/names the human/);
    grant(gate);
    expect(() => grant(gate)).toThrow(/already exists/);
  });

  it("records evidence only against a consumed approval, by copy", async () => {
    const gate = inMemoryApprovalGate();
    grant(gate);
    const evidence = { approvalId: "ap1", draftId: "d1", rendersHash: "h1", at: "t", legs: [{ platform: "linkedin", ref: "r" }] };
    await expect(gate.recordEvidence(evidence)).rejects.toMatchObject({ reason: "unknown" });
    await gate.consume("ap1", subject);
    await gate.recordEvidence(evidence);
    await gate.recordEvidence({ ...evidence, legs: [{ platform: "x", error: "refused" }] });
    evidence.legs[0]!.ref = "mutated";
    const rows = await gate.evidence("ap1");
    expect(rows.map((r) => r.legs[0])).toEqual([{ platform: "linkedin", ref: "r" }, { platform: "x", error: "refused" }]);
    expect(await gate.evidence("none")).toEqual([]);
  });

  it("gives the engine no way to grant: the ApprovalGate type only consumes", () => {
    const enginesView: ApprovalGate = inMemoryApprovalGate();
    // @ts-expect-error grant is the human surface's call, not on the engine's interface
    expect(enginesView.grant).toBeTypeOf("function");
  });
});
