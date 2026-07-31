import { z } from "zod";

import { backofficeUiVariantSchema } from "./variants";

export const badgeDefinition = {
  props: z.strictObject({
    label: z.string().min(1).max(80),
    variant: backofficeUiVariantSchema,
  }),
  slots: [],
  description: "Displays a compact semantic status label.",
  example: { label: "Live", variant: "live" },
};
