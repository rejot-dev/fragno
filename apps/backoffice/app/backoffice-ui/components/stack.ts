import { z } from "zod";

export const stackDefinition = {
  props: z.strictObject({
    gap: z.enum(["sm", "md", "lg"]),
  }),
  slots: ["default"],
  description: "Arranges generated Backoffice content vertically with a controlled gap.",
  example: { gap: "md" },
};
