import { DataTable } from "@fragno-private/design-system/data-table";

import type { ComponentFn } from "@json-render/react";

import type { backofficeUiCatalog } from "../catalog";
import { BACKOFFICE_UI_DATA_LIMITS } from "./data-limits";

export const Table: ComponentFn<typeof backofficeUiCatalog, "Table"> = ({ props }) => (
  <DataTable
    caption={props.caption}
    columns={props.columns
      .slice(0, BACKOFFICE_UI_DATA_LIMITS.tableColumns)
      .map((column) => ({ ...column, align: column.align ?? "start" }))}
    rows={props.rows
      .slice(0, BACKOFFICE_UI_DATA_LIMITS.tableRows)
      .map((row) =>
        Object.fromEntries(Object.entries(row).map(([key, value]) => [key, cellText(value)])),
      )}
    totalRowCount={props.rows.length}
  />
);

function cellText(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}
