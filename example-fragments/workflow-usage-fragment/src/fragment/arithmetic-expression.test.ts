import { describe, expect, test } from "vitest";

import { evaluateArithmeticExpression } from "./arithmetic-expression";

describe("evaluateArithmeticExpression", () => {
  test.each([
    ["5 + 3 * 2", 11],
    ["(5 + 3) * 2", 16],
    ["42 / 7", 6],
    ["10 % 3", 1],
    ["-2 * -(3 + 1)", 8],
    [".5 + 1.25", 1.75],
  ])("evaluates %s", (expression, expected) => {
    expect(evaluateArithmeticExpression(expression)).toBe(expected);
  });

  test.each(["", "1 +", "(1 + 2", "1..2", "1 2", "Math.max(1, 2)"])(
    "rejects invalid expression %j",
    (expression) => {
      expect(() => evaluateArithmeticExpression(expression)).toThrow(
        /Invalid DSL calc expression/u,
      );
    },
  );
});
