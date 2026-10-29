import { z } from "zod";

import { numberFormatSchema } from "./number-format";
import { backofficeUiToneSchema } from "./tone";

export const metricDefinition = {
  props: z.strictObject({
    label: z.string().min(1).max(120),
    value: z.union([z.string().max(240), z.number()]),
    format: numberFormatSchema.optional(),
    signed: z.boolean().optional(),
    detail: z.string().max(240).optional(),
    tone: backofficeUiToneSchema.optional(),
  }),
  slots: [],
  description:
    'Displays one labeled figure large, with optional context below it. A number value shows in format, as ui.number does, such as { currency: "EUR" }; decimal when omitted. A tone colors the figure, such as a loss in failed; info leaves it plain.',
  example: { label: "Available", value: 229471.63, format: { currency: "USD" } },
};
