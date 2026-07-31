import { z } from "zod";

import { BACKOFFICE_UI_DATA_LIMITS } from "./data-limits";

const tableColumnSchema = z.strictObject({
  key: z.string().min(1).max(80),
  label: z.string().min(1).max(120),
  align: z.enum(["start", "end"]).optional(),
});

export const tableDefinition = {
  props: z.strictObject({
    caption: z.string().min(1).max(160),
    columns: z.array(tableColumnSchema).min(1).max(BACKOFFICE_UI_DATA_LIMITS.tableColumns),
    rows: z
      .array(z.record(z.string(), z.string().max(2_000)))
      .max(BACKOFFICE_UI_DATA_LIMITS.tableRows),
  }),
  slots: [],
  description: `Displays up to ${BACKOFFICE_UI_DATA_LIMITS.tableRows} text-only rows in a horizontally scrollable table.`,
  example: {
    caption: "Recent orders",
    columns: [
      { key: "id", label: "ID" },
      { key: "status", label: "Status" },
      { key: "total", label: "Total", align: "end" },
    ],
    rows: [{ id: "ord_42", status: "Fulfilled", total: "$120.00" }],
  },
};
