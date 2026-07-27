import { describe, expect, test } from "vitest";

import {
  buildNestedStepKey,
  buildStepKey,
  getOutermostStepKey,
  parseStepKey,
} from "./step-identity";

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

  test("parses nested step keys and their occurrence identities", () => {
    const outer = buildStepKey("do", "outer");
    const inner = buildStepKey("do", "inner:with-colon", 2);
    const nested = buildNestedStepKey(outer, inner);

    expect(nested).toBe("do:outer>do:inner:with-colon#2");
    expect(getOutermostStepKey(nested)).toBe(outer);
    expect(parseStepKey(nested)).toEqual({
      segments: [
        { type: "do", name: "outer", occurrence: 0 },
        { type: "do", name: "inner:with-colon", occurrence: 2 },
      ],
      parentStepKey: outer,
    });
  });

  test.each(["missing-type", ":missing-type", "do:name#invalid", "do:name#1#2"])(
    "rejects malformed step key %s",
    (stepKey) => {
      expect(() => parseStepKey(stepKey)).toThrow("INVALID_WORKFLOW_STEP_KEY");
    },
  );
});
