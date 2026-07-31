import type { ComponentFn } from "@json-render/react";

import type { backofficeUiCatalog } from "../catalog";
import { BACKOFFICE_UI_DATA_LIMITS } from "./data-limits";

export const Table: ComponentFn<typeof backofficeUiCatalog, "Table"> = ({ props }) => {
  const columns = props.columns.slice(0, BACKOFFICE_UI_DATA_LIMITS.tableColumns);
  const rows = props.rows.slice(0, BACKOFFICE_UI_DATA_LIMITS.tableRows);
  const omittedRowCount = Math.max(0, props.rows.length - rows.length);

  return (
    <div className="min-w-0 border border-[color:var(--bo-border)] bg-[var(--bo-panel)]">
      <div className="backoffice-scroll max-w-full overflow-x-auto">
        <table className="min-w-full border-collapse text-left text-xs">
          <caption className="border-b border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-left text-[9px] font-semibold tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
            {props.caption}
          </caption>
          <thead className="bg-[var(--bo-panel-2)]">
            <tr>
              {columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className={`border-b border-[color:var(--bo-border)] px-3 py-2 text-[9px] font-semibold tracking-[0.16em] whitespace-nowrap text-[var(--bo-muted-2)] uppercase ${column.align === "end" ? "text-right" : "text-left"}`}
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--bo-border)]">
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={`max-w-80 px-3 py-2 align-top break-words text-[var(--bo-fg)] ${column.align === "end" ? "text-right tabular-nums" : "text-left"}`}
                  >
                    {row[column.key] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {omittedRowCount > 0 ? (
        <p
          role="status"
          className="border-t border-[color:var(--bo-border)] px-3 py-2 text-[10px] text-[var(--bo-muted-2)]"
        >
          Showing the first {rows.length} of {props.rows.length} rows.
        </p>
      ) : null}
    </div>
  );
};
