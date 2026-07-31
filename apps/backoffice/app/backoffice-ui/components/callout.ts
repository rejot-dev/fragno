import { z } from "zod";

import { backofficeUiVariantSchema } from "./variants";

export const calloutDefinition = {
  props: z.strictObject({
    title: z.string().min(1).max(120),
    text: z.string().min(1).max(2_000),
    variant: backofficeUiVariantSchema,
  }),
  slots: [],
  description: "Highlights a concise operational note with a semantic status variant.",
  example: {
    title: "Sync delayed",
    text: "The latest provider update is still being processed.",
    variant: "warning",
  },
};
