import { describe, expect, it } from "vitest";

import { assertFileKey, splitFileKey, validateFileKey } from "./file-key";

describe("file key validator", () => {
  it("accepts plain slash-delimited keys", () => {
    expect(validateFileKey("files/2026-03-09/report.pdf")).toEqual({ valid: true });
    expect(splitFileKey("users/42/avatar")).toEqual(["users", "42", "avatar"]);
  });

  it("rejects empty keys and empty segments", () => {
    expect(validateFileKey("")).toEqual({ valid: false, reason: "EMPTY" });
    expect(validateFileKey("/users/avatar")).toEqual({
      valid: false,
      reason: "EMPTY_SEGMENT",
    });
    expect(validateFileKey("users/avatar/")).toEqual({
      valid: false,
      reason: "EMPTY_SEGMENT",
    });
    expect(validateFileKey("users//avatar")).toEqual({
      valid: false,
      reason: "EMPTY_SEGMENT",
    });
  });

  it("rejects dot path segments", () => {
    expect(validateFileKey("./avatar")).toEqual({ valid: false, reason: "DOT_SEGMENT" });
    expect(validateFileKey("../avatar")).toEqual({ valid: false, reason: "DOT_SEGMENT" });
    expect(validateFileKey("users/../avatar")).toEqual({
      valid: false,
      reason: "DOT_SEGMENT",
    });
  });

  it("rejects control characters", () => {
    expect(validateFileKey("users/\u0000/avatar")).toEqual({
      valid: false,
      reason: "CONTROL_CHARACTERS",
    });
    expect(validateFileKey("users/\n/avatar")).toEqual({
      valid: false,
      reason: "CONTROL_CHARACTERS",
    });
  });

  it("enforces optional max byte length", () => {
    expect(validateFileKey("abc", { maxBytes: 3 })).toEqual({ valid: true });
    expect(validateFileKey("abcd", { maxBytes: 3 })).toEqual({
      valid: false,
      reason: "TOO_LONG",
    });
  });

  it("throws INVALID_FILE_KEY from assert helper", () => {
    expect(() => assertFileKey("users//avatar")).toThrowError("INVALID_FILE_KEY");
  });
});
