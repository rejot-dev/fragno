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
} satisfies Record<string, BackofficeApiOperation>;
