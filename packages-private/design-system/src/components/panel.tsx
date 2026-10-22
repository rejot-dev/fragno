import type { ReactNode } from "react";

// Panels are a titled rule over their content rather than cards, so a page of them stays flat.
const panelHeaderClassName = "flex h-9 items-center gap-2 border-b border-[color:var(--bo-border)]";
const panelTitleClassName = "text-sm font-semibold text-[var(--bo-fg)]";

/**
 * A titled region of a page. `leading` sits before the title, such as a back link while the panel
 * shows a detail; `footer` closes it, such as a PanelFooter.
 */
export function Panel({
  title,
  leading,
  footer,
  children,
}: {
  title: string;
  leading: ReactNode;
  footer: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="min-w-0">
      <header className={panelHeaderClassName}>
        {leading}
        <h2 className={panelTitleClassName}>{title}</h2>
      </header>
      {children}
      {footer}
    </section>
  );
}

/** A panel's last row, such as a link to the page that shows everything the panel summarizes. */
export function PanelFooter({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center justify-end gap-4 border-t border-[color:var(--bo-border)] py-2 text-xs">
      {children}
    </div>
  );
}

/** What a panel says in place of content it does not have yet. */
export function PanelEmpty({ children }: { children: ReactNode }) {
  return <p className="py-5 text-sm text-pretty text-[var(--bo-muted)]">{children}</p>;
}

const columnLabelClassName =
  "h-9 text-[10px] font-normal tracking-[0.2em] text-[var(--bo-muted-2)] uppercase";

export type PanelTableColumn = { label: string; align: "start" | "end" };

/**
 * A panel whose rows share columns: its title heads the first column, and each other column has a
 * label. Rows are PanelTableRow elements; without any, as before a live query's rows arrive, CSS
 * shows `empty` under the header.
 */
export function PanelTable({
  title,
  columns,
  empty,
  footer,
  children,
}: {
  title: string;
  columns: readonly PanelTableColumn[];
  empty: ReactNode;
  footer: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="min-w-0">
      <div className="backoffice-scroll overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="text-left">
            <tr className="border-b border-[color:var(--bo-border)]">
              <th scope="col" className={`h-9 pr-4 ${panelTitleClassName}`}>
                {title}
              </th>
              {columns.map((column, index) => (
                <th
                  key={column.label}
                  scope="col"
                  className={`${columnLabelClassName} ${index === columns.length - 1 ? "pl-3" : "px-3"} ${column.align === "end" ? "text-right" : ""}`}
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--bo-border)]">{children}</tbody>
        </table>
      </div>
      {empty === null ? null : (
        <p className="hidden py-5 text-sm text-pretty text-[var(--bo-muted)] [div:has(tbody:empty)+&]:block">
          {empty}
        </p>
      )}
      {footer}
    </section>
  );
}

/**
 * One row of a PanelTable: `title` fills the first column, and each cell fills the column at its
 * position, aligned as the column is.
 */
export function PanelTableRow({
  title,
  columns,
  cells,
}: {
  title: ReactNode;
  columns: readonly PanelTableColumn[];
  cells: readonly ReactNode[];
}) {
  return (
    <tr>
      <td className="max-w-[18rem] py-2 pr-4">{title}</td>
      {cells.map((cell, index) => {
        const align = columns[index]?.align === "end" ? "justify-end text-right" : "";
        return (
          // Cells are positional, so their index is their identity.
          // oxlint-disable-next-line no-array-index-key
          <td key={index} className={`py-2 ${index === cells.length - 1 ? "pl-3" : "px-3"}`}>
            <span className={`flex items-center gap-3 whitespace-nowrap ${align}`}>{cell}</span>
          </td>
        );
      })}
    </tr>
  );
}

/** The emphasized first cell of a panel table's row, or of a list row. */
export const panelRowTitleClassName =
  "block truncate text-sm font-semibold text-[var(--bo-fg)] hover:underline";
