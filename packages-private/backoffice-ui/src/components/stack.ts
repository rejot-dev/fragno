import { z } from "zod";

export const stackDefinition = {
  props: z.strictObject({
    gap: z.enum(["sm", "md", "lg"]),
    direction: z.enum(["column", "row"]).optional(),
    justify: z.enum(["start", "between"]).optional(),
  }),
  slots: ["default"],
  description:
    "Arranges generated Backoffice content in a column, or in a row such as an icon beside text; justify between pushes a row's last child to its end, such as a time.",
  example: { gap: "sm", direction: "row", justify: "between" },
};
