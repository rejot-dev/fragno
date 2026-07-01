import { z } from "zod";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";

import type { AutomationEventSubject } from "./contracts";
import { automationStoreActorSchema } from "./store";
import { automationTimestampToIsoString } from "./timestamps";

const idSchema = z.preprocess((value) => {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object" && "valueOf" in value) {
    const primitive = value.valueOf();
    if (typeof primitive === "string" || typeof primitive === "number") {
      return String(primitive);
    }
  }
  return value;
}, z.string());

const isoTimestampSchema = z.preprocess((value) => {
  if (
    value instanceof Date ||
    typeof value === "number" ||
    (value && typeof value === "object" && (value as { tag?: unknown }).tag === "db-now")
  ) {
    return automationTimestampToIsoString(value);
  }
  return value;
}, z.iso.datetime());

export const automationContextScopeSchema: z.ZodType<BackofficeContextScope> = z.discriminatedUnion(
  "kind",
  [
    z.object({ kind: z.literal("system") }),
    z.object({ kind: z.literal("org"), orgId: z.string().trim().min(1) }),
    z.object({ kind: z.literal("user"), userId: z.string().trim().min(1) }),
    z.object({
      kind: z.literal("project"),
      orgId: z.string().trim().min(1),
      projectId: z.string().trim().min(1),
    }),
  ],
);

const automationEventSubjectSchema: z.ZodType<AutomationEventSubject> = z
  .object({
    orgId: z.string().trim().min(1).optional(),
    userId: z.string().trim().min(1).optional(),
  })
  .catchall(z.unknown());

export const automationEventRecordSchema = z.object({
  id: idSchema,
  scope: automationContextScopeSchema,
  source: z.string().trim().min(1),
  eventType: z.string().trim().min(1),
  occurredAt: isoTimestampSchema,
  payload: z.record(z.string(), z.unknown()),
  actor: automationStoreActorSchema,
  actors: z.array(automationStoreActorSchema),
  subject: z.preprocess((value) => value ?? null, automationEventSubjectSchema.nullable()),
  createdAt: isoTimestampSchema.optional(),
});

export type AutomationEventRecord = z.infer<typeof automationEventRecordSchema>;

export const automationEventListInputSchema = z.object({
  limit: z.number().int().positive().max(500).optional(),
});

export const automationEventListResultSchema = z.object({
  events: z.array(automationEventRecordSchema),
  nextCursor: z.string().optional(),
  hasNextPage: z.boolean(),
});

export type AutomationEventListResult = z.infer<typeof automationEventListResultSchema>;

export const normalizeAutomationEventRecord = (entry: unknown): AutomationEventRecord =>
  automationEventRecordSchema.parse(entry);
