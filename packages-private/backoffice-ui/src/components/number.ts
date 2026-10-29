import { z } from "zod";

import { numberFormatSchema } from "./number-format";
import { backofficeUiToneSchema } from "./tone";

export const numberDefinition = {
  props: z.strictObject({
    value: z.number().nullable(),
    format: numberFormatSchema,
    signed: z.boolean().optional(),
    tone: backofficeUiToneSchema.optional(),
  }),
  slots: [],
  description:
    'Displays a number rounded for reading: integer, decimal with up to two fraction digits, percent of a ratio, so 0.92 shows 92%, or an amount in a currency, such as { currency: "USD" } for $1,250.00; null shows a dash. signed shows + before gains, for changes.',
  example: { value: -1250, format: { currency: "USD" }, signed: true, tone: "failed" },
};
