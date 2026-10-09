import { z } from "zod";

import type { BackofficeApiOperation } from "../api";
import { BACKOFFICE_PERMISSION } from "./shared/permissions";

export const hookScopeOutputSchema = z.object({
  id: z.string(),
  label: z.string(),
  capabilityId: z.string(),
  capabilityLabel: z.string(),
  kind: z.enum(["connection", "system"]),
  configured: z.boolean().optional(),
  healthy: z.boolean().optional(),
});

export const connectionVerificationResultSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
});

export const connectionSummarySchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(["connection", "system"]),
  configured: z.boolean(),
  hookScopes: z.array(z.string()),
  runtimeToolNamespaces: z.array(z.string()),
  automationEvents: z.array(z.string()),
  missing: z.array(z.string()).optional(),
});

export const capabilitySummarySchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(["connection", "system"]),
  available: z.boolean(),
  configured: z.boolean(),
  healthy: z.boolean().optional(),
  reason: z.string().optional(),
});

export const capabilitiesListOutputSchema = z.array(capabilitySummarySchema);

export type CapabilitiesListOutput = z.infer<typeof capabilitiesListOutputSchema>;

export const connectionSetupOutputSchema = z.object({
  id: z.string(),
  label: z.string(),
  overview: z.string(),
  manualSteps: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      instructions: z.string(),
      expectedUserInput: z.array(z.string()).optional(),
    }),
  ),
  fields: z.array(
    z.object({
      name: z.string(),
      required: z.boolean().optional(),
      secret: z.boolean().optional(),
      description: z.string().optional(),
    }),
  ),
  verify: z.object({ tool: z.string(), description: z.string() }).optional(),
  configureExample: z.string(),
});

export const connectionSchemaOutputSchema = z.object({
  id: z.string(),
  label: z.string(),
  fields: connectionSetupOutputSchema.shape.fields,
});

export type ConnectionSchemaOutput = z.infer<typeof connectionSchemaOutputSchema>;

export type ConnectionSetupOutput = z.infer<typeof connectionSetupOutputSchema>;

export const connectionStatusSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(["connection", "system"]),
  configured: z.boolean(),
  config: z.record(z.string(), z.unknown()).optional(),
  missing: z.array(z.string()).optional(),
  nextSteps: z.array(z.string()).optional(),
  verification: connectionVerificationResultSchema.optional(),
});

export const connectionVerificationSchema = connectionStatusSchema.extend({
  verification: connectionVerificationResultSchema,
});

export const connectionsListOutputSchema = z.array(connectionSummarySchema);

export type ConnectionsListOutput = z.infer<typeof connectionsListOutputSchema>;

export const hookScopesListOutputSchema = z.array(hookScopeOutputSchema);

export type HookScopesListOutput = z.infer<typeof hookScopesListOutputSchema>;

export const capabilitiesOperations = {
  "capabilities.list": {
    description: "List Backoffice capabilities and availability/configuration status.",
    permissions: [BACKOFFICE_PERMISSION.capabilities.read],
    input: z.void(),
    output: capabilitiesListOutputSchema,
  },
  "hooks.scopes.list": {
    description: "List hook scopes usable with hooks.list --fragment.",
    permissions: [BACKOFFICE_PERMISSION.hooks.read],
    input: z.void(),
    output: hookScopesListOutputSchema,
  },
  "connections.list": {
    description: "List configurable Backoffice connections and their configuration status.",
    permissions: [BACKOFFICE_PERMISSION.connections.read],
    input: z.void(),
    output: connectionsListOutputSchema,
  },
  "connections.get": {
    description: "Get one Backoffice connection status with masked configuration values.",
    permissions: [BACKOFFICE_PERMISSION.connections.read],
    input: z.object({ id: z.string().trim().min(1) }),
    output: connectionStatusSchema,
  },
  "connections.setup": {
    description: "Show human steps for configuring a Backoffice connection.",
    permissions: [BACKOFFICE_PERMISSION.connections.manage],
    input: z.object({ id: z.string().trim().min(1) }),
    output: connectionSetupOutputSchema,
  },
  "connections.schema": {
    description: "Show the accepted configuration fields for a Backoffice connection.",
    permissions: [BACKOFFICE_PERMISSION.connections.read],
    input: z.object({ id: z.string().trim().min(1) }),
    output: connectionSchemaOutputSchema,
  },
  "connections.verify": {
    description: "Verify a Backoffice connection without changing its configuration.",
    permissions: [BACKOFFICE_PERMISSION.connections.manage],
    input: z.object({ id: z.string().trim().min(1) }),
    output: connectionVerificationSchema,
  },
  "connections.reset": {
    description: "Reset a Backoffice connection configuration. Requires --confirm <id>.",
    permissions: [BACKOFFICE_PERMISSION.connections.manage],
    input: z.object({ id: z.string().trim().min(1), confirm: z.string().trim().min(1) }),
    output: connectionStatusSchema,
  },
  "connections.configure": {
    description:
      "Configure a Backoffice connection. Secrets are accepted in input but masked in output.",
    permissions: [BACKOFFICE_PERMISSION.connections.manage],
    input: z.object({
      id: z.string().trim().min(1),
      payload: z.unknown(),
      origin: z.string().trim().min(1).optional(),
    }),
    output: connectionStatusSchema,
  },
} satisfies Record<string, BackofficeApiOperation>;
