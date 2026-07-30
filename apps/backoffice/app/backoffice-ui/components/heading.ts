import { z } from "zod";

export const headingDefinition = {
  props: z.strictObject({
    text: z.string(),
  }),
  slots: [],
  description: "Displays a compact section heading.",
  example: { text: "Order summary" },
};
