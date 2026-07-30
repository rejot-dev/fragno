import { z } from "zod";

export const textDefinition = {
  props: z.strictObject({
    text: z.string(),
  }),
  slots: [],
  description: "Displays supporting body text.",
  example: { text: "Orders processed during the current period." },
};
