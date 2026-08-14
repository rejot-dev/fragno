import { describe, expect, it } from "vitest";

import { snapshotPiHarnessJsonValue } from "./json-value";

describe("snapshotPiHarnessJsonValue", () => {
  it("creates a detached JSON snapshot and omits undefined object properties", () => {
    const input = { nested: { value: "before" }, optional: undefined };
    const snapshot = snapshotPiHarnessJsonValue(input);

    input.nested.value = "after";

    expect(snapshot).toEqual({ nested: { value: "before" } });
  });

  it.each([
    ["function", { value: () => undefined }, "$.value:function"],
    ["non-finite number", { value: Number.NaN }, "$.value:non-finite-number"],
    ["non-plain object", { value: new Date(0) }, "$.value:non-plain-object"],
    ["undefined array entry", [undefined], "$[0]:undefined"],
  ])("rejects %s values", (_name, value, error) => {
    expect(() => snapshotPiHarnessJsonValue(value, "$")).toThrow(error);
  });

  it("rejects sparse arrays", () => {
    const value: unknown[] = [];
    value.length = 1;

    expect(() => snapshotPiHarnessJsonValue(value, "$")).toThrow("$[0]:sparse-array-entry");
  });

  it("rejects cycles while permitting repeated non-cyclic references", () => {
    const shared = { value: true };
    expect(snapshotPiHarnessJsonValue({ first: shared, second: shared })).toEqual({
      first: { value: true },
      second: { value: true },
    });

    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => snapshotPiHarnessJsonValue(cyclic, "$")).toThrow("$.self:cycle");
  });
});
