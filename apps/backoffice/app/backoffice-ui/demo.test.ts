import { expect, test } from "vitest";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { backofficeUiComponentDefinitions } from "./catalog";
import { BACKOFFICE_UI_COMPONENT_DEMOS } from "./demo";
import { BackofficeUiRenderer } from "./renderer";

test("the catalog demo has one card fixture per production component", () => {
  const demonstratedComponents = BACKOFFICE_UI_COMPONENT_DEMOS.map((demo) => demo.component);

  expect(demonstratedComponents).toHaveLength(new Set(demonstratedComponents).size);
  expect([...demonstratedComponents].sort()).toEqual(
    Object.keys(backofficeUiComponentDefinitions).sort(),
  );

  for (const demo of BACKOFFICE_UI_COMPONENT_DEMOS) {
    expect(demo.result.$ui.spec.elements[demo.result.$ui.spec.root]?.type).toBe(demo.component);
  }
});

test("every component card fixture renders through the production renderer", () => {
  const markup = BACKOFFICE_UI_COMPONENT_DEMOS.map((demo) =>
    renderToStaticMarkup(createElement(BackofficeUiRenderer, { ui: demo.result.$ui })),
  ).join("\n");

  expect(markup).toContain("First stacked item");
  expect(markup).toContain("Operational summary");
  expect(markup).toContain("99.8%");
  expect(markup).toContain("Provider catalog synchronized");
  expect(markup).toContain("evt_1042");
  expect(markup).toContain('role="progressbar"');
});
