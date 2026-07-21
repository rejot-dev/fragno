import { describe, expect, it, assert } from "vitest";

import { compareStreamOffsets, parseStreamOffset } from "./stream-offset";

describe("stream offsets", () => {
  it("parses the initial and canonical Fragno offsets", () => {
    assert(parseStreamOffset("-1", "offset") === "-1");
    assert(
      parseStreamOffset("0000000000000000000000001", "offset") === "0000000000000000000000001",
    );
  });

  it("rejects malformed and out-of-range offsets", () => {
    expect(() => parseStreamOffset("1", "offset")).toThrow("25-character");
    expect(() => parseStreamOffset("2000000000000000000000000", "offset")).toThrow(
      "outside the Fragno Durable Streams offset range",
    );
  });

  it("compares initial and durable offsets monotonically", () => {
    assert(compareStreamOffsets("-1", "0000000000000000000000000") === -1);
    assert(compareStreamOffsets("0000000000000000000000002", "0000000000000000000000001") === 1);
    assert(compareStreamOffsets("0000000000000000000000002", "0000000000000000000000002") === 0);
  });
});
