import { describe, expect, test, assert } from "vitest";

import {
  BACKOFFICE_UI_LIMITS,
  parseBackofficeUiResult,
  type BackofficeUiValidationErrorCode,
} from "./result";

const validResult = {
  total: 24,
  $ui: {
    version: 1,
    state: { total: 24 },
    spec: {
      root: "report",
      elements: {
        report: {
          type: "Stack",
          props: { gap: "md" },
          children: ["heading", "metric"],
        },
        heading: {
          type: "Heading",
          props: { text: "Order summary" },
          children: [],
        },
        metric: {
          type: "Metric",
          props: { label: "Orders", value: "24" },
          children: [],
        },
      },
    },
  },
};

const generatedResult = ({
  spec,
  state = {},
}: {
  spec: unknown;
  state?: Record<string, unknown>;
}) => ({
  $ui: { version: 1, state, spec },
});

function expectInvalidResult(value: unknown, code: BackofficeUiValidationErrorCode) {
  const result = parseBackofficeUiResult(value);
  expect(result).toMatchObject({ kind: "invalid", code });
  if (result.kind !== "invalid") {
    throw new Error(`Expected invalid generated UI, received ${result.kind}.`);
  }
  return result;
}

describe("parseBackofficeUiResult", () => {
  test("parses a versioned top-level generated interface without hiding ordinary result data", () => {
    expect(parseBackofficeUiResult(validResult)).toEqual({ kind: "valid", value: validResult });
  });

  test.each(["plain text", 24, null, { total: 24 }, [1, 2, 3]])(
    "classifies ordinary result %# without treating it as generated UI",
    (value) => {
      expect(parseBackofficeUiResult(value)).toEqual({ kind: "ordinary" });
    },
  );

  test("does not search nested ordinary values for generated interfaces", () => {
    expect(parseBackofficeUiResult({ result: validResult })).toEqual({ kind: "ordinary" });
  });

  test("classifies unsupported versions as tagged but invalid", () => {
    const invalid = expectInvalidResult(
      { $ui: { ...validResult.$ui, version: 2 } },
      "unsupported-version",
    );
    expect(invalid.message).toContain("Expected version 1");
  });

  test.each(["missing", "toString"])("rejects missing root %s", (root) => {
    expectInvalidResult(
      generatedResult({
        spec: {
          root,
          elements: {
            text: { type: "Text", props: { text: "Hello" }, children: [] },
          },
        },
      }),
      "missing-root",
    );
  });

  test("rejects dangling child references", () => {
    expectInvalidResult(
      generatedResult({
        spec: {
          root: "report",
          elements: {
            report: { type: "Stack", props: { gap: "sm" }, children: ["missing"] },
          },
        },
      }),
      "missing-child",
    );
  });

  test.each(["Iframe", "toString"])("rejects unknown catalog component %s", (type) => {
    expectInvalidResult(
      generatedResult({
        spec: {
          root: "unknown",
          elements: {
            unknown: { type, props: {}, children: [] },
          },
        },
      }),
      "unknown-component",
    );
  });

  test("rejects malformed visibility conditions before rendering", () => {
    expectInvalidResult(
      generatedResult({
        spec: {
          root: "text",
          elements: {
            text: {
              type: "Text",
              props: { text: "Unsafe visibility" },
              children: [],
              visible: { $and: 1 },
            },
          },
        },
      }),
      "invalid-visibility",
    );
  });

  test.each(["on", "watch", "repeat"])(
    "rejects unsupported element field %s instead of silently stripping it",
    (field) => {
      expectInvalidResult(
        generatedResult({
          spec: {
            root: "text",
            elements: {
              text: {
                type: "Text",
                props: { text: "Read only" },
                children: [],
                [field]: { press: { action: "setState" } },
              },
            },
          },
        }),
        "unsupported-field",
      );
    },
  );

  test.each([
    {
      name: "self-reference",
      spec: {
        root: "first",
        elements: {
          first: {
            type: "Stack",
            props: { gap: "sm" },
            children: ["first"],
          },
        },
      },
    },
    {
      name: "multi-element cycle",
      spec: {
        root: "first",
        elements: {
          first: {
            type: "Stack",
            props: { gap: "sm" },
            children: ["second"],
          },
          second: {
            type: "Stack",
            props: { gap: "sm" },
            children: ["first"],
          },
        },
      },
    },
  ])("rejects a $name in child references", ({ spec }) => {
    expectInvalidResult(generatedResult({ spec }), "cyclic-children");
  });

  test("accepts structurally valid dynamic props derived from component prop schemas", () => {
    const result = parseBackofficeUiResult(
      generatedResult({
        state: { heading: "Order summary", showTotal: true, total: 24 },
        spec: {
          root: "report",
          elements: {
            report: {
              type: "Stack",
              props: { gap: "md" },
              children: ["heading", "metric"],
            },
            heading: {
              type: "Heading",
              props: { text: { $state: "/heading" } },
              children: [],
            },
            metric: {
              type: "Metric",
              props: {
                label: { $template: "Total for ${/heading}" },
                value: {
                  $cond: { $state: "/showTotal" },
                  $then: { $template: "${/total}" },
                  $else: "Hidden",
                },
              },
              children: [],
            },
          },
        },
      }),
    );

    assert(result.kind === "valid");
  });

  test("accepts dynamic values nested inside component collection props", () => {
    const result = parseBackofficeUiResult(
      generatedResult({
        state: { missing: "None" },
        spec: {
          root: "details",
          elements: {
            details: {
              type: "KeyValue",
              props: {
                columns: 1,
                items: [
                  {
                    key: "missing",
                    label: "Missing fields",
                    value: { $state: "/missing" },
                  },
                ],
              },
              children: [],
            },
          },
        },
      }),
    );

    assert(result.kind === "valid");
  });

  test("still rejects invalid literal component props", () => {
    expectInvalidResult(
      generatedResult({
        spec: {
          root: "metric",
          elements: {
            metric: {
              type: "Metric",
              props: { label: "Orders", value: 24 },
              children: [],
            },
          },
        },
      }),
      "invalid-props",
    );
  });

  test("does not impose a serialized byte limit on generated UI state", () => {
    const result = parseBackofficeUiResult(
      generatedResult({
        state: { payload: "x".repeat(300 * 1024) },
        spec: {
          root: "text",
          elements: {
            text: { type: "Text", props: { text: "Large" }, children: [] },
          },
        },
      }),
    );

    assert(result.kind === "valid");
  });

  test("rejects generated UI above the element count limit", () => {
    const elements = Object.fromEntries(
      Array.from({ length: BACKOFFICE_UI_LIMITS.elements + 1 }, (_, index) => [
        `text-${index}`,
        { type: "Text", props: { text: String(index) }, children: [] },
      ]),
    );

    expectInvalidResult(generatedResult({ spec: { root: "text-0", elements } }), "element-count");
  });

  test("rejects elements above the per-element child limit", () => {
    const childKeys = Array.from(
      { length: BACKOFFICE_UI_LIMITS.childrenPerElement + 1 },
      (_, index) => `text-${index}`,
    );
    const elements = Object.fromEntries([
      ["report", { type: "Stack", props: { gap: "sm" }, children: childKeys }],
      ...childKeys.map((key) => [key, { type: "Text", props: { text: key }, children: [] }]),
    ]);

    expectInvalidResult(generatedResult({ spec: { root: "report", elements } }), "child-count");
  });

  test("rejects generated UI above the total child-reference limit", () => {
    const elementKeys = Array.from(
      { length: BACKOFFICE_UI_LIMITS.elements },
      (_, index) => `stack-${index}`,
    );
    const sharedChildren = elementKeys.slice(0, 5);
    const elements = Object.fromEntries(
      elementKeys.map((key) => [
        key,
        { type: "Stack", props: { gap: "sm" }, children: sharedChildren },
      ]),
    );

    expectInvalidResult(
      generatedResult({ spec: { root: elementKeys[0], elements } }),
      "child-count",
    );
  });

  test("rejects generated UI above the depth limit", () => {
    const elementKeys = Array.from(
      { length: BACKOFFICE_UI_LIMITS.depth + 1 },
      (_, index) => `stack-${index}`,
    );
    const elements = Object.fromEntries(
      elementKeys.map((key, index) => [
        key,
        {
          type: "Stack",
          props: { gap: "sm" },
          children: elementKeys[index + 1] ? [elementKeys[index + 1]] : [],
        },
      ]),
    );

    expectInvalidResult(generatedResult({ spec: { root: elementKeys[0], elements } }), "depth");
  });
});
