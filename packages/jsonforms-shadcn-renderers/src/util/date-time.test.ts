import { describe, expect, it, assert } from "vitest";

import { parseOptionalString } from "./date-time";

describe("parseOptionalString", () => {
  it("accepts strings and undefined", () => {
    assert(parseOptionalString("2026-07-21", "Date data") === "2026-07-21");
    expect(parseOptionalString(undefined, "Date data")).toBeUndefined();
  });

  it.each([null, 0, {}, []])("rejects non-string data %#", (value) => {
    expect(() => parseOptionalString(value, "Date data")).toThrow(TypeError);
  });
});
