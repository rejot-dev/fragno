import { describe, expect, it } from "vitest";
import { IndexedDbAdapter, LofiClient } from "./mod";

describe("lofi public api", () => {
  it("exports the client and adapter constructors", () => {
    expect(LofiClient).toBeTypeOf("function");
    expect(IndexedDbAdapter).toBeTypeOf("function");
  });
});
