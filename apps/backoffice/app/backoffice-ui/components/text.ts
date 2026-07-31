import { z } from "zod";

export const textDefinition = {
  props: z.strictObject({
    text: z.string().max(4_000),
    tone: z.enum(["default", "muted"]).optional(),
  }),
  slots: [],
  description: "Displays concise body text with default or muted emphasis.",
  example: { text: "Orders processed during the current period.", tone: "muted" },
};
