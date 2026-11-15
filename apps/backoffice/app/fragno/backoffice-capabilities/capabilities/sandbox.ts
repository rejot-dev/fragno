import { backofficeContextScopeSchema } from "@fragno-dev/backoffice-api/v0/shared/scope";
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

/** Each sandbox's latest lifecycle event of each type is kept as its state. */
export const SANDBOX_KEY_PATH = "$.sandboxId";

export const SANDBOX_LIFECYCLE_EVENT_TYPES = [
  "instance.ready",
  "instance.stopped",
  "instance.failed",
] as const;

const sandboxSubjectSchema = z.object({
  scope: backofficeContextScopeSchema,
  sandboxId: z.string().trim().min(1),
});

export const sandboxCapability: BackofficeCapability = {
  id: "sandbox",
  label: "Sandbox",
  objectBinding: null,
  contributions: {
    connection: {
      getStatus: async ({ config }) => ({
        id: "sandbox",
        label: "Sandbox",
        kind: "connection",
        configured: config.bindings.sandbox && config.bindings.automations,
        config: { configurationScope: "environment" },
        nextSteps: ["Configure Cloudflare Sandbox and Automations bindings."],
      }),
    },
    eventSources: [
      {
        source: "sandbox",
        label: "Sandbox",
        description: "Sandbox instance lifecycle events.",
      },
    ],
    actionProviders: ["sandbox"],
    hookScopes: [],
    skillPaths: [],
    externalEntities: [],
    automationEvents: [
      {
        source: "sandbox",
        eventType: "instance.ready",
        keyPath: SANDBOX_KEY_PATH,
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
        keyPath: SANDBOX_KEY_PATH,
        label: "Sandbox stopped",
        description: "Fires after a sandbox is stopped and reconciled.",
        payloadSchema: sandboxPayloadSchema,
        subjectSchema: sandboxSubjectSchema,
      },
      {
        source: "sandbox",
        eventType: "instance.failed",
        keyPath: SANDBOX_KEY_PATH,
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
  },
};
