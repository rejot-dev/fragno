import { assert, describe, expect, test } from "vitest";

import { formatUsageQuantity, parseUsageLimitSetting } from "./usage-limits";

describe("parseUsageLimitSetting", () => {
  test("reads dollars to the nano-dollar", () => {
    expect(parseUsageLimitSetting("ai.cost.total", "2.5")).toEqual({
      kind: "limited",
      quantity: "2500000000",
    });
  });

  test("reads whole emails, and refuses a fraction of one", () => {
    expect(parseUsageLimitSetting("email.sent", "500")).toEqual({
      kind: "limited",
      quantity: "500",
    });
    expect(() => parseUsageLimitSetting("email.sent", "2.5")).toThrow("whole number of emails");
    expect(parseUsageLimitSetting("email.sent", "unlimited")).toEqual({ kind: "unlimited" });
  });
});

describe("formatUsageQuantity", () => {
  test("counts emails", () => {
    assert(formatUsageQuantity("email.sent", "1") === "1 email");
    assert(formatUsageQuantity("email.sent", "100") === "100 emails");
  });
});
