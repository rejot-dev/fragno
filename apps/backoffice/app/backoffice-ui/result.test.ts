import { describe, expect, test } from "vitest";

import { parseBackofficeUiResult } from "./result";

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

describe("parseBackofficeUiResult", () => {
  test("parses a versioned top-level generated interface without hiding ordinary result data", () => {
    expect(parseBackofficeUiResult(validResult)).toEqual(validResult);
  });

  test("does not search nested ordinary values for generated interfaces", () => {
    expect(parseBackofficeUiResult({ result: validResult })).toBeNull();
  });

  test("rejects malformed visibility conditions before rendering", () => {
    expect(
      parseBackofficeUiResult({
        $ui: {
          version: 1,
          state: {},
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
        },
      }),
    ).toBeNull();
  });

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
    expect(
      parseBackofficeUiResult({
        $ui: { version: 1, state: {}, spec },
      }),
    ).toBeNull();
  });

  test("accepts structurally valid dynamic props derived from component prop schemas", () => {
    expect(
      parseBackofficeUiResult({
        $ui: {
          version: 1,
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
        },
      }),
    ).not.toBeNull();
  });

  test("still rejects invalid literal component props", () => {
    expect(
      parseBackofficeUiResult({
        $ui: {
          version: 1,
          state: {},
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
        },
      }),
    ).toBeNull();
  });
});
