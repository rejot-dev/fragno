export type TableRow = Record<string, string | number | null | undefined>;

export type TableColumn = {
  key: string;
  label: string;
};

export type RenderOutput =
  | { format: "json"; data: unknown }
  | { format: "pretty-json"; data: unknown }
  | { format: "table"; columns: TableColumn[]; rows: TableRow[] }
  | { format: "text"; text: string };

const stringify = (data: unknown, pretty: boolean): string =>
  pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);

const pad = (value: string, width: number): string => value.padEnd(width, " ");

const buildTable = (columns: TableColumn[], rows: TableRow[]): string => {
  const widths = columns.map((column) => {
    const headerWidth = column.label.length;
    const contentWidth = rows.reduce((max, row) => {
      const raw = row[column.key];
      const value = raw === null || raw === undefined ? "" : String(raw);
      return Math.max(max, value.length);
    }, 0);
    return Math.max(headerWidth, contentWidth);
  });

  const header = columns
    .map((column, index) => pad(column.label, widths[index] ?? column.label.length))
    .join("  ");
  const divider = columns
    .map((column, index) =>
      pad("-".repeat(widths[index] ?? column.label.length), widths[index] ?? column.label.length),
    )
    .join("  ");
  const body = rows.map((row) =>
    columns
      .map((column, index) => {
        const raw = row[column.key];
        const value = raw === null || raw === undefined ? "" : String(raw);
        return pad(value, widths[index] ?? value.length);
      })
      .join("  "),
  );

  return [header, divider, ...body].join("\n");
};

export const renderOutput = (output: RenderOutput, json: boolean): string => {
  if (json) {
    const data = "data" in output ? output.data : null;
    return stringify(data, false);
  }

  switch (output.format) {
    case "json":
      return stringify(output.data, false);
    case "pretty-json":
      return stringify(output.data, true);
    case "table":
      return buildTable(output.columns, output.rows);
    case "text":
      return output.text;
    default:
      return "";
  }
};
