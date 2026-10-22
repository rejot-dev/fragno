import { expect, test } from "vitest";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { BACKOFFICE_UI_DATA_LIMITS } from "./components/data-limits";
import { BackofficeUiRenderer } from "./renderer";
import { parseBackofficeUiResult } from "./result";

function parseSingleComponent(type: "List" | "Table", props: unknown, state = {}) {
  return parseBackofficeUiResult({
    $ui: {
      version: 1,
      state,
      spec: {
        root: "fixture",
        elements: {
          fixture: { type, props, children: [] },
        },
      },
    },
  });
}

test("rejects literal lists beyond the catalog item limit", () => {
  const items = Array.from({ length: BACKOFFICE_UI_DATA_LIMITS.listItems + 1 }, (_, index) => ({
    key: `record-${index}`,
    title: `Record ${index}`,
  }));

  expect(parseSingleComponent("List", { items })).toMatchObject({
    kind: "invalid",
    code: "invalid-props",
  });
});

test("rejects literal tables beyond the catalog row limit", () => {
  const rows = Array.from({ length: BACKOFFICE_UI_DATA_LIMITS.tableRows + 1 }, (_, index) => ({
    id: `record-${index}`,
  }));

  expect(
    parseSingleComponent("Table", {
      caption: "Records",
      columns: [{ key: "id", label: "ID" }],
      rows,
    }),
  ).toMatchObject({ kind: "invalid", code: "invalid-props" });
});

test("bounds list and table data resolved from generated UI state", () => {
  const listItems = Array.from({ length: BACKOFFICE_UI_DATA_LIMITS.listItems + 1 }, (_, index) => ({
    key: `list-record-${index}`,
    title: `List record ${index}`,
  }));
  const tableRows = Array.from({ length: BACKOFFICE_UI_DATA_LIMITS.tableRows + 1 }, (_, index) => ({
    id: `table-record-${index}`,
  }));
  const result = parseBackofficeUiResult({
    $ui: {
      version: 1,
      state: { listItems, tableRows },
      spec: {
        root: "report",
        elements: {
          report: {
            type: "Stack",
            props: { gap: "md" },
            children: ["list", "table"],
          },
          list: {
            type: "List",
            props: { items: { $state: "/listItems" } },
            children: [],
          },
          table: {
            type: "Table",
            props: {
              caption: "Records",
              columns: [{ key: "id", label: "ID" }],
              rows: { $state: "/tableRows" },
            },
            children: [],
          },
        },
      },
    },
  });
  if (result.kind !== "valid") {
    throw new Error(`Expected dynamic data fixture to parse, received ${result.kind}.`);
  }

  const markup = renderToStaticMarkup(
    createElement(BackofficeUiRenderer, { ui: result.value.$ui }),
  );

  expect(markup).toContain(`List record ${BACKOFFICE_UI_DATA_LIMITS.listItems - 1}`);
  expect(markup).not.toContain(`List record ${BACKOFFICE_UI_DATA_LIMITS.listItems}`);
  expect(markup).toContain(`table-record-${BACKOFFICE_UI_DATA_LIMITS.tableRows - 1}`);
  expect(markup).not.toContain(`table-record-${BACKOFFICE_UI_DATA_LIMITS.tableRows}`);
  expect(markup).toContain(
    `Showing the first ${BACKOFFICE_UI_DATA_LIMITS.listItems} of ${listItems.length} items.`,
  );
  expect(markup).toContain(
    `Showing the first ${BACKOFFICE_UI_DATA_LIMITS.tableRows} of ${tableRows.length} rows.`,
  );
});
