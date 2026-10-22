import { z } from "zod";

import { BACKOFFICE_UI_DATA_LIMITS } from "./data-limits";
import { panelLinkSchema } from "./panel";

export const panelTableDefinition = {
  props: z.strictObject({
    title: z.string().min(1).max(80),
    columns: z
      .array(
        z.strictObject({
          label: z.string().min(1).max(80),
          align: z.enum(["start", "end"]).optional(),
        }),
      )
      .max(BACKOFFICE_UI_DATA_LIMITS.tableColumns - 1),
    empty: z.string().min(1).max(200),
    link: panelLinkSchema.optional(),
  }),
  slots: ["default"],
  description:
    "A panel of rows that share columns, such as ui.each(rows, (row) => ui.panelTableRow(...)). Its title heads the first column, which holds each row's title; columns label the cells after it. Shows empty under its header while there are no rows.",
  example: {
    title: "Automations",
    columns: [{ label: "Runs · 24 hours" }, { label: "Last run", align: "end" }],
    empty: "No workflow has run yet.",
  },
};
