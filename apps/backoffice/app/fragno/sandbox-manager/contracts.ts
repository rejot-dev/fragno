import {
  SANDBOX_IMAGES,
  SANDBOX_INSTANCE_TYPES,
  type SandboxInstanceType,
  type SandboxStartSource,
} from "@fragno-apps/cf-sandbox-bridge/sandbox/sandbox-container-contract";
import { z } from "zod";

import { CLOUDFLARE_SANDBOX_PROVIDER, type SandboxProviderId } from "@/sandbox/contracts";

export { CLOUDFLARE_SANDBOX_PROVIDER } from "@/sandbox/contracts";

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
}, z.string().trim().min(1));

const dateSchema = z.preprocess((value) => {
  if (value && typeof value === "object" && (value as { tag?: string }).tag === "db-now") {
    const offsetMs = (value as { offsetMs?: number }).offsetMs ?? 0;
    return new Date(Date.now() + offsetMs);
  }
  return value;
}, z.coerce.date());

const nullableDateSchema = z.preprocess((value) => value ?? null, dateSchema.nullable());

export const sandboxProviderSchema = z.literal(CLOUDFLARE_SANDBOX_PROVIDER);
export const sandboxInstanceIdSchema = z.string().trim().min(1).max(50);
export const sandboxInstanceStatusSchema = z.enum([
  "requested",
  "starting",
  "running",
  "stopping",
  "stopped",
  "error",
]);
export const sandboxSleepAfterSchema = z.union([z.string().trim().min(1), z.number().int().min(0)]);
export const sandboxImageSchema = z.enum(SANDBOX_IMAGES);
export const sandboxInstanceTypeSchema = z.enum(SANDBOX_INSTANCE_TYPES);
const sandboxWorkspaceSnapshotSchema = z.object({
  id: z.string().min(1),
  size: z.number().int().min(0),
  expiresAt: z.iso.datetime(),
});

export const sandboxInstanceSchema = z.object({
  id: idSchema,
  provider: sandboxProviderSchema,
  status: sandboxInstanceStatusSchema,
  workflowInstanceId: z.string().trim().min(1).nullable(),
  keepAlive: z.boolean(),
  sleepAfter: sandboxSleepAfterSchema.nullable(),
  startupCommand: z.string(),
  startupTimeoutMs: z.number().int().positive().nullable(),
  startedAt: nullableDateSchema,
  expectedStopAt: nullableDateSchema,
  stoppedAt: nullableDateSchema,
  lastError: z.string().nullable(),
  image: sandboxImageSchema,
  instanceType: sandboxInstanceTypeSchema,
  workspaceSnapshot: sandboxWorkspaceSnapshotSchema.nullable(),
  createdAt: dateSchema,
  updatedAt: dateSchema,
});

export const sandboxInstanceListInputSchema = z
  .object({
    provider: sandboxProviderSchema.optional(),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .optional();

export const sandboxInstanceLookupInputSchema = z.object({
  id: sandboxInstanceIdSchema,
});

export const sandboxInstanceWorkflowLookupInputSchema = z.object({
  workflowInstanceId: z.string().trim().min(1),
});

export const sandboxInstanceRequestInputSchema = z.object({
  id: sandboxInstanceIdSchema,
  provider: sandboxProviderSchema,
  keepAlive: z.boolean().optional(),
  sleepAfter: sandboxSleepAfterSchema.optional(),
  startupCommand: z.string().optional(),
  startupTimeoutMs: z.number().int().positive().optional(),
  image: sandboxImageSchema.optional(),
  instanceType: sandboxInstanceTypeSchema.optional(),
});

export const sandboxInstanceMarkStartingInputSchema = z.object({
  id: sandboxInstanceIdSchema,
  workflowInstanceId: z.string().trim().min(1),
  instanceType: sandboxInstanceTypeSchema,
  /** How long the container may outlive this start without its manager; null runs until stopped. */
  leaseMs: z.number().int().positive().nullable(),
});

const sandboxInstanceLifecycleEventContextSchema = z.object({
  provider: sandboxProviderSchema.optional(),
  workflowInstanceId: z.string().trim().min(1).nullable().optional(),
  keepAlive: z.boolean().optional(),
  sleepAfter: sandboxSleepAfterSchema.nullable().optional(),
});

export const sandboxInstanceMarkRunningInputSchema =
  sandboxInstanceLifecycleEventContextSchema.extend({
    id: sandboxInstanceIdSchema,
  });

export const sandboxInstanceMarkStoppingInputSchema =
  sandboxInstanceLifecycleEventContextSchema.extend({
    id: sandboxInstanceIdSchema,
  });

export const sandboxInstanceMarkStoppedInputSchema =
  sandboxInstanceLifecycleEventContextSchema.extend({
    id: sandboxInstanceIdSchema,
    workflowInstanceId: z.string().trim().min(1),
  });

export const sandboxInstanceMarkErrorInputSchema =
  sandboxInstanceLifecycleEventContextSchema.extend({
    id: sandboxInstanceIdSchema,
    lastError: z.string().trim().min(1),
  });

export const sandboxInstanceRecordWorkspaceSnapshotInputSchema = z.object({
  id: sandboxInstanceIdSchema,
  workspaceSnapshot: sandboxWorkspaceSnapshotSchema,
});

export const sandboxInstanceRenewWorkspaceSnapshotInputSchema = z.object({
  id: sandboxInstanceIdSchema,
  workflowInstanceId: z.string().trim().min(1),
  snapshotId: z.string().min(1),
  restoredAt: z.iso.datetime(),
});

export const sandboxInstanceStopRequestInputSchema = z.object({
  id: sandboxInstanceIdSchema,
  workflowInstanceId: z.string().trim().min(1),
});

export type SandboxProvider = SandboxProviderId;

/** Immutable input of one sandbox lifecycle, resolved when the sandbox is requested. */
export type SandboxLifecycleWorkflowParams = {
  id: string;
  provider: SandboxProvider;
  keepAlive: boolean;
  /** Null only with keepAlive: every other sandbox stops itself. */
  sleepAfter: string | number | null;
  startupCommand: string;
  startupTimeoutMs: number;
  instanceType: SandboxInstanceType;
  source: SandboxStartSource;
};

/** Time one lifecycle run's container ran on its instance type, within one calendar month (UTC). */
export type SandboxUsage = {
  id: string;
  sandboxId: string;
  workflowInstanceId: string;
  instanceType: SandboxInstanceType;
  from: string;
  through: string;
  /** Partial seconds round up. */
  seconds: number;
};

export type SandboxLifecycleEvent =
  | {
      id: string;
      type: "ready";
      sandboxId: string;
      provider: SandboxProvider;
      status: "running";
    }
  | {
      id: string;
      type: "stopped";
      sandboxId: string;
      provider: SandboxProvider;
      status: "stopped";
      reason?: "workflow_terminal" | "stop_requested";
    }
  | {
      id: string;
      type: "failed";
      sandboxId: string;
      provider: SandboxProvider;
      status: "error";
      reason: "terminal_error";
      error: { message: string };
    };
export type SandboxInstanceStatus = z.infer<typeof sandboxInstanceStatusSchema>;
export type SandboxInstanceRecord = z.infer<typeof sandboxInstanceSchema>;
export type SandboxInstanceListInput = z.infer<typeof sandboxInstanceListInputSchema>;
export type SandboxInstanceLookupInput = z.infer<typeof sandboxInstanceLookupInputSchema>;
export type SandboxInstanceWorkflowLookupInput = z.infer<
  typeof sandboxInstanceWorkflowLookupInputSchema
>;
export type SandboxInstanceRequestInput = z.infer<typeof sandboxInstanceRequestInputSchema>;
export type SandboxInstanceMarkStartingInput = z.infer<
  typeof sandboxInstanceMarkStartingInputSchema
>;
export type SandboxInstanceMarkRunningInput = z.infer<typeof sandboxInstanceMarkRunningInputSchema>;
export type SandboxInstanceMarkStoppingInput = z.infer<
  typeof sandboxInstanceMarkStoppingInputSchema
>;
export type SandboxInstanceMarkStoppedInput = z.infer<typeof sandboxInstanceMarkStoppedInputSchema>;
export type SandboxInstanceMarkErrorInput = z.infer<typeof sandboxInstanceMarkErrorInputSchema>;
export type SandboxInstanceRecordWorkspaceSnapshotInput = z.infer<
  typeof sandboxInstanceRecordWorkspaceSnapshotInputSchema
>;
export type SandboxInstanceRenewWorkspaceSnapshotInput = z.infer<
  typeof sandboxInstanceRenewWorkspaceSnapshotInputSchema
>;
export type SandboxInstanceStopRequestInput = z.infer<typeof sandboxInstanceStopRequestInputSchema>;
