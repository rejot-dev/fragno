import { describe, expect, test } from "vitest";

import { buildScopedInstanceRowId } from "./instance-ref";

describe("workflow instance row ids", () => {
  test("derive distinct opaque row ids for max-length public ids that only differ at the end", () => {
    const sharedPrefix = "a".repeat(127);

    const first = buildScopedInstanceRowId("approval-workflow", `${sharedPrefix}x`);
    const second = buildScopedInstanceRowId("approval-workflow", `${sharedPrefix}y`);

    expect(first).not.toBe(second);
    expect(first.length).toBeLessThanOrEqual(128);
    expect(second.length).toBeLessThanOrEqual(128);
  });
});
