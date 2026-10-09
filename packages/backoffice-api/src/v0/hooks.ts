import { z } from "zod";

import type { BackofficeApiOperation } from "../api";

const durableHookFragmentSchema = z.string().trim().min(1);

const durableHookRecordSchema = z.object({
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
});

const durableHookQueueResponseSchema = z.object({
  configured: z.boolean(),
  hooksEnabled: z.boolean(),
  namespace: z.string().nullable(),
  items: z.array(durableHookRecordSchema),
  cursor: z.string().optional(),
  hasNextPage: z.boolean(),
});

export const hooksOperations = {
  "hooks.list": {
    description: "List durable hook queue entries for a runtime fragment.",
    input: z.object({
      fragment: durableHookFragmentSchema,
      cursor: z.string().trim().min(1).optional(),
      pageSize: z.number().int().positive().optional(),
    }),
    output: durableHookQueueResponseSchema,
  },
  "hooks.get": {
    description: "Get a durable hook queue entry by id.",
    input: z.object({ fragment: durableHookFragmentSchema, hookId: z.string().trim().min(1) }),
    output: durableHookRecordSchema.nullable(),
  },
} satisfies Record<string, BackofficeApiOperation>;
