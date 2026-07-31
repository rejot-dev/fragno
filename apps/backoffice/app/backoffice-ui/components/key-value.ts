import { z } from "zod";

import { BACKOFFICE_UI_DATA_LIMITS } from "./data-limits";

const keyValueItemSchema = z.strictObject({
  key: z.string().min(1).max(200),
  label: z.string().min(1).max(120),
  value: z.string().max(1_000),
});

export const keyValueDefinition = {
  props: z.strictObject({
    columns: z.union([z.literal(1), z.literal(2)]),
    items: z.array(keyValueItemSchema).max(BACKOFFICE_UI_DATA_LIMITS.keyValueItems),
  }),
  slots: [],
  description: "Displays compact label-value facts in a one- or two-column definition list.",
  example: {
    columns: 2,
    items: [
      { key: "environment", label: "Environment", value: "Production" },
      { key: "region", label: "Region", value: "us-east-1" },
    ],
  },
};
