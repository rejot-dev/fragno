import { z } from "zod";

import { backofficeUiVariantSchema } from "./variants";

export const metricDefinition = {
  props: z.strictObject({
    label: z.string().min(1).max(120),
    value: z.string().max(240),
    detail: z.string().max(240).optional(),
    variant: backofficeUiVariantSchema.optional(),
  }),
  slots: [],
  description: "Displays one labeled operational metric with optional context and status emphasis.",
  example: { label: "Orders", value: "24", detail: "+8 this week", variant: "live" },
};
