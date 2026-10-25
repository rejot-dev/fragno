import { z } from "zod";

import type { BackofficeApiOperation } from "../api";
import { BACKOFFICE_PERMISSION } from "./shared/permissions";

const durableHookFragmentSchema = z.lazy(() => z.string().trim().min(1));

const durableHookRecordSchema = z.lazy(() =>
  z.object({
    id: z.string(),
    hookName: z.string(),
    status: z.string(),
    attempts: z.number(),
    maxAttempts: z.number(),
    lastAttemptAt: z.string().nullable(),
    nextRetryAt: z.string().nullable(),
    createdAt: z.string().nullable(),
    error: z.string().nullable(),
    payload: z.unknown(),
  }),
);

const durableHookQueueResponseSchema = z.lazy(() =>
  z.object({
    configured: z.boolean(),
    hooksEnabled: z.boolean(),
    namespace: z.string().nullable(),
    items: z.array(durableHookRecordSchema),
    cursor: z.string().optional(),
    hasNextPage: z.boolean(),
  }),
);

const hookScopeOutputSchema = z.lazy(() =>
  z.object({
    id: z.string(),
    label: z.string(),
    capabilityId: z.string(),
    capabilityLabel: z.string(),
    kind: z.enum(["connection", "system"]),
    configured: z.boolean().optional(),
    healthy: z.boolean().optional(),
  }),
);

const hookScopesListOutputSchema = z.lazy(() => z.array(hookScopeOutputSchema));

export type HookScopesListOutput = z.infer<typeof hookScopesListOutputSchema>;

export const hooksOperations = {
  "hooks.scopes.list": {
    description: "List hook scopes usable with hooks.list --fragment.",
    permissions: [BACKOFFICE_PERMISSION.hooks.read],
    input: z.void(),
    output: hookScopesListOutputSchema,
  },
  "hooks.list": {
    description: "List durable hook queue entries for a runtime fragment.",
    permissions: [BACKOFFICE_PERMISSION.hooks.read],
    input: z.lazy(() =>
      z.object({
        fragment: durableHookFragmentSchema,
        cursor: z.string().trim().min(1).optional(),
        pageSize: z.number().int().positive().optional(),
      }),
    ),
    output: durableHookQueueResponseSchema,
  },
  "hooks.get": {
    description:
      "Get a durable hook queue entry by id. An automations ingest entry's payload is the event envelope, so the event's own payload is at payload.payload.",
    permissions: [BACKOFFICE_PERMISSION.hooks.read],
    input: z.lazy(() =>
      z.object({ fragment: durableHookFragmentSchema, hookId: z.string().trim().min(1) }),
    ),
    output: z.lazy(() => durableHookRecordSchema.nullable()),
  },
} satisfies Record<string, BackofficeApiOperation>;
