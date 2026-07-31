import { describe, expect, test, assert } from "vitest";

import { parseBackofficeUiResult } from "./result";

const componentFixtures = [
  {
    component: "Stack",
    validProps: { gap: "md" },
    invalidProps: { gap: "xl" },
  },
  {
    component: "Grid",
    validProps: { columns: 3, gap: "sm" },
    invalidProps: { columns: 5, gap: "sm" },
  },
  {
    component: "Section",
    validProps: { label: "Operations", variant: "neutral" },
    invalidProps: { label: "Operations", className: "rounded-xl" },
  },
  {
    component: "Divider",
    validProps: { label: "Details" },
    invalidProps: { label: "" },
  },
  {
    component: "Heading",
    validProps: { text: "Order summary", level: 2 },
    invalidProps: { text: "Order summary", level: 1 },
  },
  {
    component: "Text",
    validProps: { text: "Current provider state.", tone: "muted" },
    invalidProps: { text: "Current provider state.", tone: "loud" },
  },
  {
    component: "Code",
    validProps: { code: 'const status = "ready";', language: "typescript" },
    invalidProps: { code: 'const status = "ready";', href: "https://example.com" },
  },
  {
    component: "Callout",
    validProps: { title: "Sync delayed", text: "Still processing.", variant: "warning" },
    invalidProps: { title: "Sync delayed", text: "Still processing.", variant: "info" },
  },
  {
    component: "Metric",
    validProps: { label: "Orders", value: "24", variant: "live" },
    invalidProps: { label: "", value: "24" },
  },
  {
    component: "Badge",
    validProps: { label: "Live", variant: "live" },
    invalidProps: { label: "Live", variant: "success" },
  },
  {
    component: "KeyValue",
    validProps: {
      columns: 2,
      items: [{ key: "region", label: "Region", value: "us-east-1" }],
    },
    invalidProps: {
      columns: 3,
      items: [{ key: "region", label: "Region", value: "us-east-1" }],
    },
  },
  {
    component: "List",
    validProps: {
      items: [
        {
          key: "daily-synchronization",
          title: "Daily synchronization",
          status: "Live",
          variant: "live",
        },
      ],
    },
    invalidProps: {
      items: [
        {
          key: "daily-synchronization",
          title: "Daily synchronization",
          href: "https://example.com",
        },
      ],
    },
  },
  {
    component: "Table",
    validProps: {
      caption: "Recent orders",
      columns: [{ key: "id", label: "ID" }],
      rows: [{ id: "ord_42" }],
    },
    invalidProps: {
      columns: [{ key: "id", label: "ID" }],
      rows: [{ id: "ord_42" }],
    },
  },
  {
    component: "Progress",
    validProps: { label: "Import progress", value: 72, variant: "accent" },
    invalidProps: { label: "Import progress", value: 101, variant: "accent" },
  },
] as const;

function parseComponent(component: string, props: unknown) {
  return parseBackofficeUiResult({
    $ui: {
      version: 1,
      state: {},
      spec: {
        root: "fixture",
        elements: {
          fixture: { type: component, props, children: [] },
        },
      },
    },
  });
}

describe("Backoffice generated UI catalog", () => {
  test.each(componentFixtures)("accepts valid $component props", ({ component, validProps }) => {
    assert(parseComponent(component, validProps).kind === "valid");
  });

  test.each(componentFixtures)(
    "rejects invalid $component props",
    ({ component, invalidProps }) => {
      expect(parseComponent(component, invalidProps)).toMatchObject({
        kind: "invalid",
        code: "invalid-props",
      });
    },
  );
});
