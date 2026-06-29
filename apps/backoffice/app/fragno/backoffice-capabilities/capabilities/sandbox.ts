import { z } from "zod";

import type { BackofficeCapability } from "@/fragno/backoffice-capabilities/backoffice-capabilities";

const sandboxStatusSchema = z.enum([
  "requested",
  "starting",
  "running",
  "stopping",
  "stopped",
  "error",
]);

const sandboxPayloadSchema = z.object({
  sandboxId: z.string().trim().min(1),
  provider: z.literal("cloudflare"),
  status: sandboxStatusSchema,
  reason: z.string().trim().min(1).optional(),
  error: z.object({ message: z.string().trim().min(1) }).optional(),
});

const sandboxSubjectSchema = z.object({
  orgId: z.string().trim().min(1).optional(),
  projectId: z.string().trim().min(1).optional(),
  sandboxId: z.string().trim().min(1),
});

export const sandboxCapability: BackofficeCapability = {
  id: "sandbox",
  label: "Sandbox",
  kind: "connection",
  runtimeToolNamespaces: ["sandbox"],
  connection: {
    configurable: false,
    getStatus: async ({ config }) => ({
      id: "sandbox",
      label: "Sandbox",
      kind: "connection",
      configured: config.bindings.sandbox && config.bindings.automations,
      config: { configurationScope: "environment" },
      nextSteps: ["Configure Cloudflare Sandbox and Automations bindings."],
    }),
  },
  automationEvents: [
    {
      source: "sandbox",
      eventType: "instance.ready",
      label: "Sandbox ready",
      description: "Fires after a sandbox reaches running status and can execute commands.",
      payloadSchema: sandboxPayloadSchema,
      subjectSchema: sandboxSubjectSchema,
      example: {
        sandboxId: "dev",
        provider: "cloudflare",
        status: "running",
      },
    },
    {
      source: "sandbox",
      eventType: "instance.stopped",
      label: "Sandbox stopped",
      description: "Fires after a sandbox is stopped and reconciled.",
      payloadSchema: sandboxPayloadSchema,
      subjectSchema: sandboxSubjectSchema,
    },
    {
      source: "sandbox",
      eventType: "instance.failed",
      label: "Sandbox failed",
      description: "Fires after a sandbox lifecycle operation records an error.",
      payloadSchema: sandboxPayloadSchema,
      subjectSchema: sandboxSubjectSchema,
      example: {
        sandboxId: "dev",
        provider: "cloudflare",
        status: "error",
        reason: "terminal_error",
        error: { message: "Sandbox startup failed after retries." },
      },
    },
  ],
};
