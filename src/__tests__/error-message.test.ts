import { describe, it, expect } from "vitest";

/**
 * The engine's folder-local getErrorMessage: a thrown value of any shape
 * becomes one readable string, and nothing on the path can throw.
 */
import { getErrorMessage } from "../error-message.js";

const circular: Record<string, unknown> = { code: 7 };
circular.self = circular;

const circularWithMessage: Record<string, unknown> = { message: "loop" };
circularWithMessage.self = circularWithMessage;

describe("getErrorMessage (Social HQ engine)", () => {
  it("returns an Error's message, subclasses included", () => {
    expect(getErrorMessage(new Error("boom"))).toBe("boom");
    expect(getErrorMessage(new TypeError("bad type"))).toBe("bad type");
    expect(getErrorMessage(new Error(""))).toBe("");
  });

  it("returns a thrown string as is", () => {
    expect(getErrorMessage("rate limited")).toBe("rate limited");
    expect(getErrorMessage("")).toBe("");
  });

  it("reads `message` off a plain object instead of printing [object Object]", () => {
    expect(getErrorMessage({ message: "vendor said no" })).toBe("vendor said no");
    expect(getErrorMessage({ message: 429 })).toBe("429");
    expect(getErrorMessage({ message: undefined })).toBe("undefined");
    expect(getErrorMessage(circularWithMessage)).toBe("loop");
  });

  it("falls through to String() for an object without a message", () => {
    expect(getErrorMessage({ code: 500 })).toBe("[object Object]");
    // A cycle must not throw (no JSON.stringify on this path).
    expect(getErrorMessage(circular)).toBe("[object Object]");
  });

  it("stringifies null, undefined and other primitives", () => {
    expect(getErrorMessage(null)).toBe("null");
    expect(getErrorMessage(undefined)).toBe("undefined");
    expect(getErrorMessage(0)).toBe("0");
    expect(getErrorMessage(false)).toBe("false");
  });
});
