import { z } from "zod";

export const textAreaDefinition = {
  props: z.strictObject({
    label: z.string().min(1).max(120),
    value: z.string().max(12_000),
    placeholder: z.string().max(240).optional(),
    description: z.string().max(500).optional(),
    required: z.boolean().optional(),
    disabled: z.boolean().optional(),
    rows: z.number().int().min(2).max(12).optional(),
  }),
  slots: [],
  description:
    "Collects a longer text value. Bind value with form.bind(field) so edits update the form response.",
  example: {
    label: "Reason",
    value: { $bindState: "/response/reason" },
    rows: 4,
  },
};
