import { z } from "zod";

import { backofficeUiToneSchema } from "./tone";

export const progressDefinition = {
  props: z.strictObject({
    label: z.string().min(1).max(120),
    value: z.number().min(0).max(100),
    detail: z.string().max(240).optional(),
    tone: backofficeUiToneSchema,
  }),
  slots: [],
  description: "Displays completion from zero to one hundred percent with a semantic status tone.",
  example: {
    label: "Import progress",
    value: 72,
    detail: "72 of 100 records",
    tone: "info",
  },
};
