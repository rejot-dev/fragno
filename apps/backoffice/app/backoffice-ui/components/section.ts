import { z } from "zod";

import { backofficeUiToneSchema } from "./tone";

export const sectionDefinition = {
  props: z.strictObject({
    label: z.string().min(1).max(80).optional(),
    tone: backofficeUiToneSchema.optional(),
  }),
  slots: ["default"],
  description: "Groups related report content in a square-edged Backoffice panel.",
  example: { label: "Operations", tone: "muted" },
};
