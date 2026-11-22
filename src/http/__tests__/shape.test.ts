import { describe, it, expect } from "vitest";
import { ResponseShapeError, kindOf } from "../shape.js";

describe("ResponseShapeError", () => {
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
describe("kindOf", () => {
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
