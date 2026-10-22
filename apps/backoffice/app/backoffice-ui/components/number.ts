import { z } from "zod";

import { backofficeUiToneSchema } from "./tone";

export const numberDefinition = {
  props: z.strictObject({
    value: z.number().nullable(),
    format: z.enum(["integer", "decimal", "percent"]),
    tone: backofficeUiToneSchema.optional(),
  }),
  slots: [],
  description:
    "Displays a number rounded for reading: integer, decimal with up to two fraction digits, or percent of a ratio, so 0.92 shows 92%; null shows a dash.",
  example: { value: 0.92, format: "percent", tone: "live" },
};
