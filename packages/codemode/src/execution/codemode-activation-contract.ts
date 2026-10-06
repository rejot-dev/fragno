import type {
  RemoteWorkflowHookIntent,
  RemoteWorkflowStepScope,
} from "@fragno-dev/workflows/remote-workflow";
import type {
  WorkflowDuration,
  WorkflowStepConfig,
  WorkflowStepEvent,
  WorkflowStepWorkflowOperation,
} from "@fragno-dev/workflows/workflow";
import { z } from "zod";

import { CODEMODE_LIMITS } from "../codemode-limits";
import { codemodeWorkerBundleSchema } from "./codemode-worker-bundle";

/** Execution API v2 uses Cap'n Web; compiler HTTP archives retain their independent v1 format. */
export const CODEMODE_EXECUTION_HTTP_PATH = "/v2/codemode/execute";
const name = z.string().min(1).max(1024);
export const codemodeStepNameSchema = name;
export const codemodeDurationSchema = z.union([z.string().min(1).max(128), z.number()]);
export const codemodeStepConfigSchema = z.strictObject({
  retries: z
    .strictObject({
      limit: z.number().int().nonnegative(),
      delay: codemodeDurationSchema,
      backoff: z.enum(["constant", "linear", "exponential"]).optional(),
    })
    .optional(),
});
export const codemodeWorkflowOperationsSchema = z
  .array(
    z.discriminatedUnion("type", [
      z.strictObject({
        type: z.literal("createInstance"),
        workflowName: name,
        instanceId: name,
        params: z.unknown(),
        remoteWorkflowName: name.nullable().optional(),
      }),
      z.strictObject({
        type: z.literal("createEvent"),
        workflowName: name,
        instanceId: name,
        eventId: name,
        eventType: name,
        payload: z.unknown(),
      }),
    ]),
  )
  .max(CODEMODE_LIMITS.maxEntries);
export const codemodeHookIntentSchema = z.strictObject({
  target: name,
  schemaName: name,
  hookName: name,
  payload: z.unknown(),
  when: z.enum(["success", "terminal-error", "both"]),
});

const executionBase = {
  providers: z
    .array(z.strictObject({ name, tools: z.array(name).max(CODEMODE_LIMITS.maxEntries) }))
    .max(CODEMODE_LIMITS.maxProviders),
  timeoutMs: z.number().int().positive().max(CODEMODE_LIMITS.activationTimeoutMs),
};
const activationBase = {
  ...executionBase,
  code: z.string().min(1).max(CODEMODE_LIMITS.maxSourceBytes),
  dependencies: z
    .record(z.string().min(1).max(214), z.string().min(1).max(256))
    .refine((value) => Object.keys(value).length <= CODEMODE_LIMITS.maxDependencies),
};
/** One activation owns one socket and one guest, regardless of its number of workflow steps. */
export const codemodeActivationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("immediate"), ...activationBase }),
  z.strictObject({ kind: z.literal("module"), ...activationBase }),
  z.strictObject({
    kind: z.literal("module-build"),
    code: activationBase.code,
    dependencies: activationBase.dependencies,
  }),
  z.strictObject({
    kind: z.literal("compiled"),
    ...executionBase,
    bundle: codemodeWorkerBundleSchema,
    invocation: z.string().min(1).max(CODEMODE_LIMITS.maxSourceBytes).nullable(),
    input: z.unknown(),
  }),
  z.strictObject({
    kind: z.literal("module-invoke"),
    ...activationBase,
    invocation: z.string().min(1).max(CODEMODE_LIMITS.maxSourceBytes),
  }),
  z.strictObject({
    kind: z.literal("workflow"),
    ...activationBase,
    event: z
      .object({ payload: z.unknown(), timestamp: z.date(), instanceId: name, id: name })
      .catchall(z.unknown()),
  }),
]);
export type CodemodeActivation = z.infer<typeof codemodeActivationSchema>;
/** Independently deployed peers must agree on the application API before compilation starts. */
export const codemodeExecutionRequestSchema = z.strictObject({
  protocolVersion: z.literal(2),
  executionId: z.uuid(),
  activation: codemodeActivationSchema,
});

const suspensionBase = { stepKey: name, delayMs: z.number().nullable().optional() };
export const codemodeSuspensionReasonSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("sleep"), ...suspensionBase, runAt: z.date().optional() }),
  z.strictObject({
    type: z.literal("waitForEvent"),
    ...suspensionBase,
    eventType: name,
    runAt: z.date().optional(),
  }),
  z.strictObject({ type: z.literal("retry"), ...suspensionBase }),
  z.strictObject({ type: z.literal("checkpoint"), stepKey: name, delayMs: z.literal(0) }),
]);
export type CodemodeSuspensionReason = z.infer<typeof codemodeSuspensionReasonSchema>;
const errorSchema = z.strictObject({
  kind: z.enum(["error", "non-retryable", "event-timeout", "interrupted"]),
  name: z.string().max(1024),
  message: z.string().max(32_768),
  details: z
    .strictObject({ status: z.number().int().min(100).max(599), code: z.string().min(1).max(1024) })
    .nullable(),
});
export type CodemodeWireError = z.infer<typeof errorSchema>;
/** Domain failures stay explicit across native RPC and Cap'n Web rather than relying on Error subclasses. */
export const codemodeCallbackResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("ok"), value: z.unknown() }),
  z.strictObject({ status: z.literal("error"), error: errorSchema }),
]);
export type CodemodeToolResult = z.infer<typeof codemodeCallbackResultSchema>;
/** Step failures and suspension survive both transports without depending on native Error properties. */
export type CodemodeStepResult =
  | CodemodeToolResult
  | { status: "suspended"; reason: CodemodeSuspensionReason };
export const codemodeCompletionSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("completed"),
    value: z.unknown(),
    logs: z.array(z.string()).max(CODEMODE_LIMITS.maxLogs),
    workflowDefinition: z.strictObject({ name, options: z.unknown() }).nullable(),
  }),
  z.strictObject({
    status: z.literal("failed"),
    error: errorSchema,
    logs: z.array(z.string()).max(CODEMODE_LIMITS.maxLogs),
  }),
  z.strictObject({
    status: z.literal("suspended"),
    reason: codemodeSuspensionReasonSchema,
    logs: z.array(z.string()).max(CODEMODE_LIMITS.maxLogs),
  }),
]);
export type CodemodeCompletion = z.infer<typeof codemodeCompletionSchema>;

/** A provider capability exposes only explicitly registered tool names. */
export interface CodemodeProviderCapability {
  call(tool: string, args: unknown[]): Promise<CodemodeToolResult>;
}
export type CodemodeEvent = Omit<WorkflowStepEvent, "consume">;
export type CodemodeEventCallback = (event: CodemodeEvent) => Promise<CodemodeToolResult>;
/** Transaction authority is revoked at callback completion, even if a guest retains a reference. */
export interface CodemodeTransactionCapability {
  emit(payload: unknown): Promise<void>;
  previousEmissions(): Promise<unknown>;
  previousConsumedEvents(): Promise<unknown>;
  workflowServiceCalls(operations: readonly WorkflowStepWorkflowOperation[]): Promise<void>;
  triggerHook(intent: RemoteWorkflowHookIntent): Promise<void>;
  onEvent(type: string, callback: CodemodeEventCallback): Promise<() => Promise<void>>;
}
/** Nested steps receive a scoped capability; guests never supply or forge parent step identities. */
export interface CodemodeStepCapability {
  do(
    name: string,
    config: WorkflowStepConfig | undefined,
    callback: (
      tx: CodemodeTransactionCapability,
      step: CodemodeStepCapability,
    ) => Promise<CodemodeToolResult>,
  ): Promise<CodemodeStepResult>;
  sleep(name: string, duration: WorkflowDuration): Promise<CodemodeStepResult>;
  sleepUntil(name: string, timestamp: Date | number): Promise<CodemodeStepResult>;
  waitForEvent(
    name: string,
    options: {
      type: string;
      timeout: WorkflowDuration | undefined;
      onConsume:
        | ((tx: CodemodeTransactionCapability, event: unknown) => Promise<CodemodeToolResult>)
        | undefined;
    },
  ): Promise<CodemodeStepResult>;
}
/** Only these capabilities, not host lifecycle methods or application bindings, reach the guest. */
export type CodemodeCapabilities = {
  dispatchers: Record<string, CodemodeProviderCapability>;
  stepTarget: CodemodeStepCapability | null;
};
export interface CodemodeExecutionCapability {
  execute(
    request: z.infer<typeof codemodeExecutionRequestSchema>,
    capabilities: CodemodeCapabilities,
  ): Promise<CodemodeCompletion>;
}
/** Trusted workflow collaborator; its parent scopes are supplied by the capability owner, never the guest. */
export interface CodemodeWorkflowHost {
  do(
    parentScope: RemoteWorkflowStepScope,
    name: string,
    config: WorkflowStepConfig | undefined,
    callback: (
      tx: CodemodeWorkflowTransactionHost,
      scope: NonNullable<RemoteWorkflowStepScope>,
    ) => Promise<unknown>,
  ): Promise<unknown>;
  sleep(
    parentScope: RemoteWorkflowStepScope,
    name: string,
    duration: WorkflowDuration,
  ): Promise<unknown>;
  sleepUntil(
    parentScope: RemoteWorkflowStepScope,
    name: string,
    timestamp: Date | number,
  ): Promise<unknown>;
  waitForEvent(
    parentScope: RemoteWorkflowStepScope,
    name: string,
    options: {
      type: string;
      timeout: WorkflowDuration | undefined;
      onConsume:
        | ((tx: CodemodeWorkflowTransactionHost, event: unknown) => Promise<void>)
        | undefined;
    },
  ): Promise<unknown>;
}
export interface CodemodeWorkflowTransactionHost {
  emit(payload: unknown): void;
  previousEmissions(): Promise<unknown>;
  previousConsumedEvents(): Promise<unknown>;
  workflowServiceCalls(operations: readonly WorkflowStepWorkflowOperation[]): void;
  triggerHook(intent: RemoteWorkflowHookIntent): void;
  onEvent(type: string, callback: (event: WorkflowStepEvent) => Promise<void>): () => void;
}
/** Host settlement preserves runner retry decisions after a disconnect; closing never implies rollback. */
export type CodemodeHost = {
  capabilities: CodemodeCapabilities;
  close(): void;
  settle(): Promise<CodemodeSuspensionReason | null>;
};
/** Node-owned execution boundary; implementations must never retry an activation implicitly. */
export type CodemodeRemoteExecutor = (
  activation: CodemodeActivation,
  host: CodemodeHost,
) => Promise<CodemodeCompletion>;
