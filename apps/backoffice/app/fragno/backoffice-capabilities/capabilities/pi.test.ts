import { describe, expect, test } from "vitest";

import { piCapability } from "./pi";

describe("Pi capability", () => {
  test("exposes durable manager actions without a connection or hook queue", () => {
    expect(piCapability).toMatchObject({
      id: "pi",
      objectBinding: "PI_MANAGER",
      contributions: {
        connection: null,
        actionProviders: ["pi"],
        hookScopes: [],
      },
    });
  });
});
