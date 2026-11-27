// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { ResponseShapeError, kindOf, shape } from "../shape.js";
import { isRejection, isUnknownOutcome } from "../retry.js";

const s = shape("example", "GET /things");
const SECRET = "tok_live_never_echo_this";
const HUGE = "x".repeat(1_000_000);

function refusal(read: () => unknown): ResponseShapeError {
  try {
    read();
  } catch (err) {
    expect(err).toBeInstanceOf(ResponseShapeError);
    return err as ResponseShapeError;
  }
  throw new Error("expected a ResponseShapeError");
}

describe("ResponseShapeError", () => {
  it("names the vendor, operation, path, expectation and the kind of value, never the value", () => {
    const err = refusal(() => s.id(SECRET.length, "data.id"));
    expect(err.name).toBe("ResponseShapeError");
    expect(err.vendor).toBe("example");
    expect(err.operation).toBe("GET /things");
    expect(err.path).toBe("data.id");
    expect(err.expected).toBe("a non-empty string");
    expect(err.got).toBe("a number");
    expect(err.message).toBe(
      "example GET /things: unexpected response shape at data.id: expected a non-empty string, got a number",
    );
  });

  it("never echoes a hostile string, however large", () => {
    for (const value of [SECRET, HUGE, { token: SECRET }, [[SECRET]]]) {
      const err = refusal(() => s.num(value, "count"));
      expect(err.message).not.toContain(SECRET);
      expect(err.message.length).toBeLessThan(200);
    }
  });

  it("is an unknown outcome to retry.ts, never a rejection: a create that answered may have landed", () => {
    const err = refusal(() => s.obj(null, "(body)"));
    expect(isUnknownOutcome(err)).toBe(true);
    expect(isRejection(err)).toBe(false);
  });
});

describe("kindOf", () => {
  it.each([
    [undefined, "missing"],
    [null, "null"],
    [[], "an array"],
    ["", "an empty string"],
    ["a", "a string"],
    [1, "a number"],
    [Number.POSITIVE_INFINITY, "a non-finite number"],
    [Number.NaN, "a non-finite number"],
    [{}, "an object"],
    [true, "a boolean"],
    [1n, "a bigint"],
  ])("%s is %s", (value, kind) => {
    expect(kindOf(value)).toBe(kind);
  });
});

describe("required readers", () => {
  it("obj accepts a plain object and refuses an array, null and primitives", () => {
    expect(s.obj({ a: 1 }, "x")).toEqual({ a: 1 });
    expect(refusal(() => s.obj([1], "x")).got).toBe("an array");
    expect(refusal(() => s.obj(null, "x")).got).toBe("null");
    expect(refusal(() => s.obj("{}", "x")).got).toBe("a string");
  });

  it("arr accepts an array and refuses an object", () => {
    expect(s.arr([1], "x")).toEqual([1]);
    expect(refusal(() => s.arr({ length: 1 }, "x")).expected).toBe("an array");
  });

  it("str accepts any string, the empty one included, and refuses a number", () => {
    expect(s.str("", "x")).toBe("");
    expect(s.str(HUGE, "x")).toBe(HUGE);
    expect(refusal(() => s.str(5, "x")).expected).toBe("a string");
  });

  it("id needs a non-empty string", () => {
    expect(s.id("abc", "x")).toBe("abc");
    expect(refusal(() => s.id("", "x")).got).toBe("an empty string");
    expect(refusal(() => s.id(["abc"], "x")).got).toBe("an array");
  });

  it("num needs a finite number, so JSON's 1e999 (Infinity) is refused", () => {
    expect(s.num(0, "x")).toBe(0);
    expect(refusal(() => s.num(JSON.parse("1e999"), "x")).got).toBe("a non-finite number");
    expect(refusal(() => s.num("4", "x")).got).toBe("a string");
  });

  it("bool needs a boolean", () => {
    expect(s.bool(false, "x")).toBe(false);
    expect(refusal(() => s.bool("true", "x")).expected).toBe("a boolean");
  });

  it("idOrNum reads a finite number as a string and a non-empty string as is", () => {
    expect(s.idOrNum(42, "x")).toBe("42");
    expect(s.idOrNum("42", "x")).toBe("42");
    expect(refusal(() => s.idOrNum("", "x")).expected).toBe("a non-empty string or a number");
    expect(refusal(() => s.idOrNum(Number.NaN, "x")).got).toBe("a non-finite number");
  });

  it("each reads every element at its own path", () => {
    expect(s.each(["a", "b"], "list", (v, at) => `${at}=${s.str(v, at)}`)).toEqual(["list[0]=a", "list[1]=b"]);
    expect(refusal(() => s.each(["a", 2], "list", (v, at) => s.str(v, at))).path).toBe("list[1]");
    expect(refusal(() => s.each(null, "list", (v) => v)).path).toBe("list");
  });

  it("fail throws for a caller's own check", () => {
    const err = refusal(() => s.fail("status", "one of a, b", "c"));
    expect(err.message).toBe("example GET /things: unexpected response shape at status: expected one of a, b, got a string");
  });
});

describe("optional readers read undefined and null as absent, and check anything else", () => {
  it.each([
    ["optObj", (v: unknown) => s.optObj(v, "x"), { a: 1 }, { a: 1 }, "[]"],
    ["optArr", (v: unknown) => s.optArr(v, "x"), [1], [1], {}],
    ["optStr", (v: unknown) => s.optStr(v, "x"), "a", "a", 1],
    ["optId", (v: unknown) => s.optId(v, "x"), "a", "a", ""],
    ["optNum", (v: unknown) => s.optNum(v, "x"), 1, 1, "1"],
    ["optBool", (v: unknown) => s.optBool(v, "x"), true, true, 0],
    ["optIdOrNum", (v: unknown) => s.optIdOrNum(v, "x"), 7, "7", false],
  ] as const)("%s", (_name, read, good, readAs, bad) => {
    expect(read(undefined)).toBeUndefined();
    expect(read(null)).toBeUndefined();
    expect(read(good)).toEqual(readAs);
    refusal(() => read(bad));
  });

  it("optEach reads an absent list as empty and checks a present one", () => {
    expect(s.optEach(undefined, "list", (v) => v)).toEqual([]);
    expect(s.optEach(null, "list", (v) => v)).toEqual([]);
    expect(s.optEach([1], "list", (v, at) => s.num(v, at))).toEqual([1]);
    expect(refusal(() => s.optEach([[1]], "list", (v, at) => s.num(v, at))).got).toBe("an array");
  });
});

describe("ResponseShapeError, as the Bluesky XRPC client constructs it", () => {
  it("names the vendor, the operation, the path, what was needed and what kind of value was there", () => {
    const err = new ResponseShapeError("bluesky", "app.bsky.feed.getPosts", "body.posts[0].uri", "a string", "a number");

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ResponseShapeError");
    expect([err.vendor, err.operation, err.path, err.expected, err.got]).toEqual([
      "bluesky",
      "app.bsky.feed.getPosts",
      "body.posts[0].uri",
      "a string",
      "a number",
    ]);
    expect(err.message).toBe(
      "bluesky app.bsky.feed.getPosts: unexpected response shape at body.posts[0].uri: expected a string, got a number",
    );
  });
});

/** ⛔ The KIND of a value, never the value: a response can carry tokens. */
describe("kindOf (from main)", () => {
  it.each([
    [undefined, "missing"],
    [null, "null"],
    [[1], "an array"],
    ["", "an empty string"],
    ["secret-token", "a string"],
    [7, "a number"],
    [Number.NaN, "a non-finite number"],
    [{ a: 1 }, "an object"],
    [true, "a boolean"],
    [10n, "a bigint"],
  ])("describes %o as %s", (value, kind) => {
    expect(kindOf(value)).toBe(kind);
  });
});
