/*
 * The table block — tabular structured data. Header row plus body; cells are
 * primitives (string / number / boolean / null) rendered as text.
 */

import { Table } from "lucide-react";

import { cn } from "@/lib/utils";

import type { TableBlock } from "../output-model";
import { BlockFrame } from "./block-frame";

const formatCell = (value: string | number | boolean | null): string => {
  if (value === null) {
    return "—";
  }
  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }
  return String(value);
};

export function TableBlockView({ block }: { block: TableBlock }) {
  return (
    <BlockFrame title={block.title} icon={<Table className="h-3 w-3" />}>
      <div className="cad-scroll overflow-x-auto rounded-lg border border-[color:var(--cad-line)]">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-[color:var(--cad-line)] bg-[var(--cad-panel-2)]">
              {block.columns.map((column, index) => (
                <th
                  key={index}
                  className="cad-eyebrow px-3 py-2 text-left font-semibold text-[var(--cad-muted)]"
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr
                key={rowIndex}
                className="border-b border-[color:var(--cad-line)] last:border-b-0"
              >
                {block.columns.map((_, columnIndex) => {
                  const value = row[columnIndex] ?? null;
                  return (
                    <td
                      key={columnIndex}
                      className={cn(
                        "px-3 py-2 text-[var(--cad-fg)]",
                        typeof value === "number" && "text-right tabular-nums",
                      )}
                    >
                      {formatCell(value)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </BlockFrame>
  );
}
