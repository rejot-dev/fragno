import { describe, expect, test } from "vitest";

import { buildNestedStepKey, buildStepKey, getOutermostStepKey } from "./step-identity";

describe("workflow step identity", () => {
  test("rejects step names that would collide with key delimiters", () => {
    expect(() => buildStepKey("do", "outer>inner")).toThrow(
      "WORKFLOW_STEP_NAME_CONTAINS_RESERVED_CHARACTER:>",
    );
    expect(() => buildStepKey("do", "step#1")).toThrow(
      "WORKFLOW_STEP_NAME_CONTAINS_RESERVED_CHARACTER:#",
    );
  });

  test("rejects nested child keys that already contain the nested separator", () => {
    expect(() => buildNestedStepKey("do:outer", "do:inner>do:other")).toThrow(
      "WORKFLOW_STEP_KEY_CONTAINS_NESTED_SEPARATOR",
    );
  });

  test("splits only on the reserved nested separator", () => {
    const outer = buildStepKey("do", "outer");
    const inner = buildStepKey("do", "inner");
    const nested = buildNestedStepKey(outer, inner);

    expect(nested).toBe("do:outer>do:inner");
    expect(getOutermostStepKey(nested)).toBe(outer);
  });
});
