import { z } from "zod";

export const gridDefinition = {
  props: z.strictObject({
    columns: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    gap: z.enum(["sm", "md", "lg"]),
  }),
  slots: ["default"],
  description: "Arranges related report items in a responsive one-to-four-column grid.",
  example: { columns: 3, gap: "md" },
};
