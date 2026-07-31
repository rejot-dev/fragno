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

const representativeReport = parseBackofficeUiResult({
  $ui: {
    version: 1,
    state: {},
    spec: {
      root: "report",
      elements: {
        report: {
          type: "Stack",
          props: { gap: "lg" },
          children: ["heading", "intro", "summary", "details-divider", "details", "activity"],
        },
        heading: {
          type: "Heading",
          props: { text: "Provider operations", level: 2 },
          children: [],
        },
        intro: {
          type: "Text",
          props: { text: "Current provider health and recent delivery activity.", tone: "muted" },
          children: [],
        },
        summary: {
          type: "Grid",
          props: { columns: 3, gap: "sm" },
          children: ["deliveries", "success-rate", "health"],
        },
        deliveries: {
          type: "Metric",
          props: { label: "Deliveries", value: "1,284", detail: "+12%", variant: "accent" },
          children: [],
        },
        "success-rate": {
          type: "Metric",
          props: { label: "Success rate", value: "99.8%", variant: "live" },
          children: [],
        },
        health: {
          type: "Badge",
          props: { label: "All systems live", variant: "live" },
          children: [],
        },
        "details-divider": {
          type: "Divider",
          props: { label: "Details" },
          children: [],
        },
        details: {
          type: "Section",
          props: { label: "Connection", variant: "neutral" },
          children: ["facts", "orders"],
        },
        facts: {
          type: "KeyValue",
          props: {
            columns: 2,
            items: [
              { key: "environment", label: "Environment", value: "Production" },
              { key: "region", label: "Region", value: "us-east-1" },
            ],
          },
          children: [],
        },
        orders: {
          type: "Table",
          props: {
            caption: "Recent deliveries",
            columns: [
              { key: "id", label: "ID" },
              { key: "status", label: "Status" },
              { key: "duration", label: "Duration", align: "end" },
            ],
            rows: [
              { id: "evt_1042", status: "Delivered", duration: "128 ms" },
              { id: "evt_1041", status: "Delivered", duration: "142 ms" },
            ],
          },
          children: [],
        },
        activity: {
          type: "Section",
          props: { label: "Activity", variant: "accent" },
          children: ["progress", "activity-list", "notice", "sample"],
        },
        progress: {
          type: "Progress",
          props: {
            label: "Replay completion",
            value: 72,
            detail: "72 of 100 events",
            variant: "accent",
          },
          children: [],
        },
        "activity-list": {
          type: "List",
          props: {
            items: [
              {
                key: "webhook-delivery",
                title: "Webhook delivery",
                detail: "Completed without retries.",
                status: "Live",
                variant: "live",
              },
            ],
          },
          children: [],
        },
        notice: {
          type: "Callout",
          props: {
            title: "One replay remains",
            text: "The final event is waiting for its scheduled retry.",
            variant: "warning",
          },
          children: [],
        },
        sample: {
          type: "Code",
          props: {
            code: 'return { status: "delivered" };',
            label: "Latest handler result",
            language: "javascript",
          },
          children: [],
        },
      },
    },
  },
});

test("server-renders a representative Backoffice operations report", () => {
  if (representativeReport.kind !== "valid") {
    throw new Error(`Expected report fixture to parse, received ${representativeReport.kind}.`);
  }

  const markup = renderToStaticMarkup(
    createElement(BackofficeUiRenderer, { ui: representativeReport.value.$ui }),
  );

  expect(markup).toContain("Provider operations");
  expect(markup).toContain("All systems live");
  expect(markup).toContain("Recent deliveries");
  expect(markup).toContain("evt_1042");
  expect(markup).toContain("Replay completion");
  expect(markup).toContain("Latest handler result");
  expect(markup).toContain("backoffice-scroll");
  expect(markup).toContain("--bo-panel-2");
  expect(markup).toContain("--bo-live");
});

test("renders semantic headings, lists, tables, progress, and status text", () => {
  if (representativeReport.kind !== "valid") {
    throw new Error(`Expected report fixture to parse, received ${representativeReport.kind}.`);
  }

  const markup = renderToStaticMarkup(
    createElement(BackofficeUiRenderer, { ui: representativeReport.value.$ui }),
  );

  expect(markup).toContain("<h2");
  expect(markup).toContain("<dl");
  expect(markup).toContain("<ul");
  expect(markup).toContain("<table");
  expect(markup).toContain("<caption");
  expect(markup).toContain('scope="col"');
  expect(markup).toContain('role="progressbar"');
  expect(markup).toContain('aria-valuenow="72"');
  expect(markup).toContain('role="status"');
});
