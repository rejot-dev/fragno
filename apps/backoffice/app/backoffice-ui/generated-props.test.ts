import { assert, describe, test } from "vitest";

import { z } from "zod";

import { validateGeneratedProps } from "./generated-props";

const maximumConditionalDepth = 8;

type NestedBranch = "$then" | "$else";

function nestedConditionalValue(depth: number, nestedBranch: NestedBranch): unknown {
  let value: unknown = "Orders";

  for (let index = 0; index < depth; index += 1) {
    value = {
      $cond: { $state: "/showOrders" },
      $then: nestedBranch === "$then" ? value : "Orders",
      $else: nestedBranch === "$else" ? value : "Orders",
    };
  }

  return value;
}

function validatesGeneratedLabel(value: unknown) {
  return validateGeneratedProps(z.strictObject({ label: z.string() }), { label: value });
}

describe("validateGeneratedProps", () => {
  test.each<NestedBranch>(["$then", "$else"])(
    "accepts generated conditionals at the maximum depth through %s",
    (nestedBranch) => {
      assert(
        validatesGeneratedLabel(nestedConditionalValue(maximumConditionalDepth, nestedBranch)),
      );
    },
  );

  test.each<NestedBranch>(["$then", "$else"])(
    "rejects generated conditionals beyond the maximum depth through %s",
    (nestedBranch) => {
      assert(
        !validatesGeneratedLabel(nestedConditionalValue(maximumConditionalDepth + 1, nestedBranch)),
      );
    },
  );
});
