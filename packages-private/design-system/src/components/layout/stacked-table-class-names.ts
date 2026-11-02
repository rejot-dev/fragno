// On phones a table's columns do not fit, so each row stacks into a card: its first cell titles
// it, and every other cell becomes a line of the card, its column's label (from `data-label`)
// beside its value. The value is wrapped in stackedTableValueClassName, so content of several
// parts stays in the value column.

export const stackedTableClassName = "max-sm:block";

export const stackedTableBodyClassName = "max-sm:block";

export const stackedTableRowClassName = "max-sm:flex max-sm:flex-col max-sm:gap-1.5";

export const stackedTableTitleCellClassName = "max-sm:block max-sm:p-0 max-sm:text-left";

export const stackedTableCellClassName =
  "max-sm:grid max-sm:grid-cols-[7.5rem_minmax(0,1fr)] max-sm:items-baseline max-sm:gap-x-3 max-sm:p-0 max-sm:text-left max-sm:before:text-[10px] max-sm:before:font-normal max-sm:before:tracking-[0.2em] max-sm:before:text-[var(--bo-muted-2)] max-sm:before:uppercase max-sm:before:content-[attr(data-label)]";

// `contents` leaves the table's own layout alone above phones.
export const stackedTableValueClassName = "contents max-sm:block max-sm:min-w-0";
