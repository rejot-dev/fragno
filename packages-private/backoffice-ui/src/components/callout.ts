import { z } from "zod";

import { backofficeUiToneSchema } from "./tone";

export const calloutDefinition = {
  props: z.strictObject({
    title: z.string().min(1).max(120),
    text: z.string().min(1).max(2_000),
    tone: backofficeUiToneSchema,
  }),
  slots: [],
  description: "Highlights a concise operational note with a semantic status tone.",
  example: {
    title: "Sync delayed",
    text: "The latest provider update is still being processed.",
    tone: "waiting",
  },
};
