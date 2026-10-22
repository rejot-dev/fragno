import { z } from "zod";

export const rowListDefinition = {
  props: z.strictObject({
    empty: z.string().min(1).max(200).optional(),
  }),
  slots: ["default"],
  description:
    "Lists rows divided by rules, such as ui.each(rows, (row) => ui.listRow(...)). Shows empty in their place when there are no rows, or nothing without it; row lists that follow one another read as one list.",
  example: { empty: "No connections yet." },
};
