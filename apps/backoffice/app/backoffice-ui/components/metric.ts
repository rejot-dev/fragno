import { z } from "zod";

import { backofficeUiToneSchema } from "./tone";

export const metricDefinition = {
  props: z.strictObject({
    label: z.string().min(1).max(120),
    value: z.union([z.string().max(240), z.number()]),
    detail: z.string().max(240).optional(),
    tone: backofficeUiToneSchema.optional(),
  }),
  slots: [],
  description: "Displays one labeled operational metric with optional context and status tone.",
  example: { label: "Orders", value: "24", detail: "+8 this week", tone: "live" },
};
