import { z } from "zod";

export const checkboxDefinition = {
  props: z.strictObject({
    label: z.string().min(1).max(240),
    checked: z.boolean(),
    description: z.string().max(500).optional(),
    required: z.boolean().optional(),
    disabled: z.boolean().optional(),
  }),
  slots: [],
  description:
    "Collects a boolean choice. Bind checked with form.bind(field) so edits update the form response.",
  example: {
    label: "I confirm this operation",
    checked: { $bindState: "/response/confirmed" },
  },
};
