import { z } from "zod";

export const gridDefinition = {
  props: z.strictObject({
    columns: z.union([
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(4),
      z.literal("main-side"),
    ]),
    gap: z.enum(["sm", "md", "lg", "xl"]),
  }),
  slots: ["default"],
  description:
    "Arranges related report items in a responsive one-to-four-column grid, or main-side: a wide column beside a narrow one on large screens, such as details beside connections. Gap xl spaces a page's panels.",
  example: { columns: 3, gap: "md" },
};
