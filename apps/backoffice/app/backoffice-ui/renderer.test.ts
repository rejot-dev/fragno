import { expect, test } from "vitest";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { BackofficeUiRenderer } from "./renderer";
import { parseBackofficeUiResult } from "./result";

const generatedResult = parseBackofficeUiResult({
  $ui: {
    version: 1,
    state: {},
    spec: {
      root: "report",
      elements: {
        report: {
          type: "Stack",
          props: { gap: "md" },
          children: ["heading", "text", "metric"],
        },
        heading: {
          type: "Heading",
          props: { text: "Order summary" },
          children: [],
        },
        text: {
          type: "Text",
          props: { text: "Current fulfilled order count." },
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
});

test("server-renders the minimal Backoffice generated interface", () => {
  if (generatedResult.kind !== "valid") {
    throw new Error("Expected generated UI fixture to parse.");
  }

  const markup = renderToStaticMarkup(
    createElement(BackofficeUiRenderer, { ui: generatedResult.value.$ui }),
  );

  expect(markup).toContain("Order summary");
  expect(markup).toContain("Current fulfilled order count.");
  expect(markup).toContain('aria-label="Orders"');
  expect(markup).toContain(">24</p>");
  expect(markup).toContain("--bo-panel");
});

test("resolves state, template, and conditional props while rendering", () => {
  const dynamicResult = parseBackofficeUiResult({
    $ui: {
      version: 1,
      state: { heading: "Live orders", showTotal: true, total: 24 },
      spec: {
        root: "report",
        elements: {
          report: {
            type: "Stack",
            props: { gap: "sm" },
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
  });
  if (dynamicResult.kind !== "valid") {
    throw new Error("Expected dynamic generated UI fixture to parse.");
  }

  const markup = renderToStaticMarkup(
    createElement(BackofficeUiRenderer, { ui: dynamicResult.value.$ui }),
  );

  expect(markup).toContain("Live orders");
  expect(markup).toContain('aria-label="Total for Live orders"');
  expect(markup).toContain(">24</p>");
});
