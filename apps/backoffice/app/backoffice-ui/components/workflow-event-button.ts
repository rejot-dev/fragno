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
    "Sends payload to the current workflow waitForEvent step. Use only in durable workflow step UI. For forms, use form.submit(props), which sets eventType and the complete form payload; build this button directly only to send a fixed payload with eventType set to the exact awaited type.",
  example: {
    label: "Approve",
    eventType: "approval",
    payload: { decision: "approve" },
    variant: "primary",
  },
};
