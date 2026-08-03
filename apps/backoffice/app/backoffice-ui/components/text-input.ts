import { z } from "zod";

export const textInputDefinition = {
  props: z.strictObject({
    label: z.string().min(1).max(120),
    value: z.string().max(4_000),
    placeholder: z.string().max(240).optional(),
    description: z.string().max(500).optional(),
    required: z.boolean().optional(),
    disabled: z.boolean().optional(),
    secret: z.boolean().optional(),
  }),
  slots: [],
  description:
    "Collects a short text value. Bind value with {$bindState: '/path'} so edits update UI state. Set secret to true for sensitive values such as API keys.",
  example: {
    label: "Reference",
    value: { $bindState: "/response/reference" },
    placeholder: "Enter a reference",
  },
};
