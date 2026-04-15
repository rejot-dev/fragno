export type TableColumn<Row> = {
  label: string;
  value: (row: Row) => string | number | undefined;
  align?: "left" | "right";
  maxWidth?: number;
};

const truncateValue = (value: string, maxWidth: number | undefined): string => {
  if (!maxWidth || value.length <= maxWidth) {
    return value;
  }

  if (maxWidth <= 1) {
    return value.slice(0, maxWidth);
  }

  return `${value.slice(0, Math.max(0, maxWidth - 1))}…`;
};

const padValue = (value: string, width: number, align: "left" | "right"): string =>
  align === "right" ? value.padStart(width) : value.padEnd(width);

export const formatTable = <Row>(columns: TableColumn<Row>[], rows: Row[]): string => {
  if (rows.length === 0) {
    return "(none)";
  }

  const renderedRows = rows.map((row) =>
    columns.map((column) => truncateValue(String(column.value(row) ?? ""), column.maxWidth)),
  );
  const widths = columns.map((column, columnIndex) =>
    Math.max(column.label.length, ...renderedRows.map((row) => row[columnIndex]?.length ?? 0)),
  );
  const header = columns
    .map((column, columnIndex) =>
      padValue(column.label, widths[columnIndex] ?? column.label.length, column.align ?? "left"),
    )
    .join("  ");
  const divider = widths.map((width) => "-".repeat(width)).join("  ");
  const body = renderedRows.map((row) =>
    row
      .map((cell, columnIndex) =>
        padValue(cell, widths[columnIndex] ?? cell.length, columns[columnIndex]?.align ?? "left"),
      )
      .join("  "),
  );

  return [header, divider, ...body].join("\n");
};

export const formatSection = (title: string, content: string): string =>
  `${title}\n${"=".repeat(title.length)}\n${content}`;

export const formatKeyValueBlock = (rows: Array<[label: string, value: string | number]>): string =>
  rows.map(([label, value]) => `${label}: ${value}`).join("\n");

export const formatBulletList = (title: string, items: string[]): string => {
  if (items.length === 0) {
    return formatSection(title, "(none)");
  }

  return formatSection(title, items.map((item) => `- ${item}`).join("\n"));
};
