import { z } from "zod";

const selectOptionSchema = z.strictObject({
  label: z.string().min(1).max(120),
  value: z.string().max(500),
});

export const selectDefinition = {
  props: z.strictObject({
    label: z.string().min(1).max(120),
    value: z.string().max(500),
    options: z.array(selectOptionSchema).min(1).max(50),
    description: z.string().max(500).optional(),
    required: z.boolean().optional(),
    disabled: z.boolean().optional(),
  }),
  slots: [],
  description:
    "Collects one value from a bounded list. Bind value with {$bindState: '/path'} so edits update UI state.",
  example: {
    label: "Decision",
    value: { $bindState: "/response/decision" },
    options: [
      { label: "Approve", value: "approve" },
      { label: "Reject", value: "reject" },
    ],
  },
};
