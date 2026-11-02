export type DataTableColumn = {
  key: string;
  label: string;
  /** End-aligned columns hold figures, so they also get tabular numerals. */
  align: "start" | "end";
};

/** Text-only rows that scroll horizontally instead of widening the page. */
export function DataTable({
  caption,
  columns,
  rows,
  totalRowCount = rows.length,
}: {
  caption: string;
  columns: readonly DataTableColumn[];
  /** Cells by column key; a missing key renders an empty cell. */
  rows: readonly Readonly<Record<string, string>>[];
  /** When the rows are the first of a larger set, the size of that set. */
  totalRowCount?: number;
}) {
  return (
    <div className="min-w-0 border border-[color:var(--bo-border)] bg-[var(--bo-panel)]">
      <div className="backoffice-scroll max-w-full overflow-x-auto">
        <table className="min-w-full border-collapse text-left text-xs">
          <caption className="border-b border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-left text-[9px] font-semibold tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
            {caption}
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
      {totalRowCount > rows.length ? (
        <p
          role="status"
          className="border-t border-[color:var(--bo-border)] px-3 py-2 text-[10px] text-[var(--bo-muted-2)]"
        >
          Showing the first {rows.length} of {totalRowCount} rows.
        </p>
      ) : null}
    </div>
  );
}
