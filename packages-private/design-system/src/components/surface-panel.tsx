import type { ReactNode } from "react";

/**
 * A raised panel of records, such as a scope's connections or an organization's members. Its
 * caption counts or names what the panel holds, with the panel's actions beside it. Content rules
 * itself off from the caption: a SurfaceTable, SurfaceFacts, a SurfacePanelBody, or a flush
 * BackofficeSystemState when there is nothing to list.
 */
export function SurfacePanel({
  caption,
  actions,
  children,
}: {
  caption: string;
  actions: ReactNode | null;
  children: ReactNode;
}) {
  return (
    <section aria-label={caption} className="bo-panel-surface min-w-0 bg-[var(--bo-panel)]">
      <div className="flex min-h-12 flex-wrap items-center justify-between gap-3 px-4 py-2">
        <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
          {caption}
        </p>
        {actions === null ? null : (
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        )}
      </div>
      {children}
    </section>
  );
}

/** Free-form panel content, such as a form. */
export function SurfacePanelBody({ children }: { children: ReactNode }) {
  return <div className="border-t border-[color:var(--bo-border)] p-4">{children}</div>;
}

/** The panel's records as a RowList, inset to line up with the caption. */
export function SurfacePanelRows({ children }: { children: ReactNode }) {
  return <div className="border-t border-[color:var(--bo-border)] px-4">{children}</div>;
}

/** The panel's last row, such as its pagination. */
export function SurfacePanelFooter({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[color:var(--bo-border)] px-4 py-2">
      {children}
    </div>
  );
}

export type SurfaceFact = { key: string; label: string; value: ReactNode };

/** A row of labelled facts about what the panel shows, wrapping onto more rows when narrow. */
export function SurfaceFacts({ items }: { items: readonly SurfaceFact[] }) {
  return (
    // The gap shows the border colour between cells; cells grow to fill their row, so a wrapped
    // row never leaves a gap showing it.
    <dl className="flex min-w-0 flex-wrap gap-px border-t border-[color:var(--bo-border)] bg-[var(--bo-border)]">
      {items.map((item) => (
        <div key={item.key} className="min-w-44 flex-1 bg-[var(--bo-panel)] px-4 py-3">
          <dt className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
            {item.label}
          </dt>
          <dd className="mt-1 text-sm font-semibold break-words text-[var(--bo-fg)]">
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export type SurfaceTableColumn = { label: string; align: "start" | "end" };

/** The panel's records as rows of SurfaceTableRow, scrolling sideways instead of widening the page. */
export function SurfaceTable({
  columns,
  children,
}: {
  columns: readonly SurfaceTableColumn[];
  children: ReactNode;
}) {
  return (
    <div className="backoffice-scroll overflow-x-auto border-t border-[color:var(--bo-border)]">
      <table className="min-w-full divide-y divide-[color:var(--bo-border)] text-sm">
        <thead className="bg-[var(--bo-panel-2)]">
          <tr className="text-[11px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
            {columns.map((column) => (
              <th
                key={column.label}
                scope="col"
                className={`px-4 py-2 font-normal whitespace-nowrap ${column.align === "end" ? "text-right" : "text-left"}`}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-[color:var(--bo-border)]">{children}</tbody>
      </table>
    </div>
  );
}

/**
 * One record of a SurfaceTable. Each cell fills the column at its position, aligned as the column
 * is; end-aligned columns hold figures, so they also get tabular numerals.
 */
export function SurfaceTableRow({
  columns,
  cells,
}: {
  columns: readonly SurfaceTableColumn[];
  cells: readonly ReactNode[];
}) {
  return (
    <tr className="text-[var(--bo-muted)] hover:bg-[var(--bo-panel-2)]">
      {cells.map((cell, index) => (
        // Cells are positional, so their index is their identity.
        // oxlint-disable-next-line no-array-index-key
        <td
          key={index}
          className={`px-4 py-2.5 ${columns[index]?.align === "end" ? "text-right tabular-nums" : ""}`}
        >
          {cell}
        </td>
      ))}
    </tr>
  );
}
