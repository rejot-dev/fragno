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

  test("accepts generated values nested inside arrays and objects", () => {
    const propsSchema = z.strictObject({
      items: z
        .array(
          z.strictObject({
            key: z.string(),
            value: z.string(),
            detail: z.string().optional(),
          }),
        )
        .max(2),
    });

    assert(
      validateGeneratedProps(propsSchema, {
        items: [
          {
            key: "missing",
            value: { $state: "/missing" },
            detail: { $template: "Status: ${/status}" },
          },
        ],
      }),
    );
  });

  test("accepts generated values nested inside record values", () => {
    const propsSchema = z.strictObject({
      rows: z.array(z.record(z.string(), z.string())),
    });

    assert(
      validateGeneratedProps(propsSchema, {
        rows: [{ status: { $state: "/status" } }],
      }),
    );
  });

  test("preserves literal collection and object constraints", () => {
    const propsSchema = z.strictObject({
      items: z.array(z.strictObject({ value: z.string() })).max(1),
    });

    assert(!validateGeneratedProps(propsSchema, { items: [{ value: "one" }, { value: "two" }] }));
    assert(!validateGeneratedProps(propsSchema, { items: [{ value: 24 }] }));
    assert(!validateGeneratedProps(propsSchema, { items: [{ value: "one", extra: true }] }));
  });
});
