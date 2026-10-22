import { z } from "zod";

export const dividerDefinition = {
  props: z.strictObject({
    label: z.string().min(1).max(80).optional(),
  }),
  slots: [],
  description: "Separates report sections with an optional compact label.",
  example: { label: "Details" },
};
