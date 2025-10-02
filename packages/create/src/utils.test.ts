import { describe, it, expect } from "vitest";
import { merge } from "./utils";

describe("merge", () => {
  it("merges nested objects", () => {
    const result = merge({ a: { c: 1 } }, { a: { b: 2 } });
    expect(result).toEqual({ a: { c: 1, b: 2 } });
  });
});
