import { z } from "zod";

export const headingDefinition = {
  props: z.strictObject({
    text: z.string().min(1).max(200),
    level: z.union([z.literal(2), z.literal(3), z.literal(4)]).optional(),
  }),
  slots: [],
  description: "Displays a compact level-two, level-three, or level-four report heading.",
  example: { text: "Order summary", level: 2 },
};
