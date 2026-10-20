import { DataTable, type DataTableColumn } from "./data-table";

export default { title: "Data/Data table" };

const columns: DataTableColumn[] = [
  { key: "id", label: "ID", align: "start" },
  { key: "status", label: "Status", align: "start" },
  { key: "duration", label: "Duration", align: "end" },
];

const rows: Record<string, string>[] = [
  { id: "evt_1042", status: "Delivered", duration: "128 ms" },
  { id: "evt_1041", status: "Delivered", duration: "142 ms" },
  { id: "evt_1040", status: "Retrying" },
];

export function Default() {
  return (
    <div className="max-w-2xl">
      <DataTable caption="Recent deliveries" columns={columns} rows={rows} />
    </div>
  );
}

export function Truncated() {
  return (
    <div className="max-w-2xl">
      <DataTable caption="Recent deliveries" columns={columns} rows={rows} totalRowCount={64} />
    </div>
  );
}

export function WideScrolls() {
  const wideColumns = Array.from({ length: 12 }, (_, index) => ({
    key: `column-${index}`,
    label: `Column ${index + 1}`,
    align: "start" as const,
  }));
  const wideRow = Object.fromEntries(wideColumns.map((column) => [column.key, "A long value"]));

  return (
    <div className="max-w-2xl">
      <DataTable caption="Wide export" columns={wideColumns} rows={[wideRow, wideRow]} />
    </div>
  );
}
