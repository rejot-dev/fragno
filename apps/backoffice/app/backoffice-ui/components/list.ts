import { z } from "zod";

import { BACKOFFICE_UI_DATA_LIMITS } from "./data-limits";
import { backofficeUiVariantSchema } from "./variants";

const listItemSchema = z.strictObject({
  key: z.string().min(1).max(200),
  title: z.string().min(1).max(200),
  detail: z.string().max(1_000).optional(),
  status: z.string().min(1).max(80).optional(),
  variant: backofficeUiVariantSchema.optional(),
});

export const listDefinition = {
  props: z.strictObject({
    items: z.array(listItemSchema).max(BACKOFFICE_UI_DATA_LIMITS.listItems),
  }),
  slots: [],
  description: `Displays up to ${BACKOFFICE_UI_DATA_LIMITS.listItems} operational records with optional semantic statuses.`,
  example: {
    items: [
      {
        key: "daily-synchronization",
        title: "Daily synchronization",
        detail: "Completed 24 records.",
        status: "Live",
        variant: "live",
      },
    ],
  },
};
