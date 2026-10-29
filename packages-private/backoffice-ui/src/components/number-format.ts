import { z } from "zod";

/** How a figure reads: rounded, as a percent of a ratio, or as an amount of an ISO 4217 currency. */
export const numberFormatSchema = z.union([
  z.enum(["integer", "decimal", "percent"]),
  z.strictObject({ currency: z.string().regex(/^[A-Z]{3}$/u, "an ISO 4217 code, such as USD") }),
]);

type NumberFormat = z.infer<typeof numberFormatSchema>;

const roundedOptions = {
  integer: { maximumFractionDigits: 0 },
  decimal: { maximumFractionDigits: 2 },
  percent: { style: "percent", maximumFractionDigits: 0 },
} as const satisfies Record<string, Intl.NumberFormatOptions>;

/** A figure as people read it. Signed figures, such as changes, show + before gains. */
export function formatNumber(value: number, format: NumberFormat, signed: boolean): string {
  return new Intl.NumberFormat("en-US", {
    ...(typeof format === "string"
      ? roundedOptions[format]
      : { style: "currency", currency: format.currency }),
    signDisplay: signed ? "exceptZero" : "auto",
  }).format(value);
}
