import { z } from "zod";

export const workflowEventButtonDefinition = {
  props: z.strictObject({
    label: z.string().min(1).max(120),
    eventType: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9_][a-zA-Z0-9-_.:]*$/),
    payload: z.unknown(),
    variant: z.enum(["primary", "danger"]).optional(),
    confirmation: z.string().min(1).max(500).optional(),
  }),
  slots: [],
  description:
    "Sends payload to the current workflow waitForEvent step. Use only in durable workflow step UI, set eventType to the exact awaited type, and read the complete payload from UI state with {$state: '/path'}.",
  example: {
    label: "Submit decision",
    eventType: "approval",
    payload: { $state: "/response" },
    variant: "primary",
  },
};
