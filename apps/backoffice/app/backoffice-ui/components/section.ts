import { z } from "zod";

import { backofficeUiVariantSchema } from "./variants";

export const sectionDefinition = {
  props: z.strictObject({
    label: z.string().min(1).max(80).optional(),
    variant: backofficeUiVariantSchema.optional(),
  }),
  slots: ["default"],
  description: "Groups related report content in a square-edged Backoffice panel.",
  example: { label: "Operations", variant: "neutral" },
};
