import { z } from "zod";

import { CODEMODE_LIMITS } from "../codemode-limits";

const name = z.string().min(1).max(1024);
const handle = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const duration = z.union([z.string().min(1).max(128), z.number()]);
const scope = z.strictObject({
  stepKey: name,
  parentStepKey: name.nullable(),
  depth: z.number().int().nonnegative().max(64),
});
const event = z.strictObject({ type: name, payload: z.unknown(), timestamp: z.date() });
const stepConfig = z.strictObject({
  retries: z
    .strictObject({
      limit: z.number().int().nonnegative(),
      delay: duration,
      backoff: z.enum(["constant", "linear", "exponential"]).optional(),
    })
    .optional(),
});
const workflowOperation = z.discriminatedUnion("type", [
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
]);
const hookIntent = z.strictObject({
  target: name,
  schemaName: name,
  hookName: name,
  payload: z.unknown(),
  when: z.enum(["success", "terminal-error", "both"]),
});
const promptInput = z.strictObject({
  text: z.string(),
  images: z
    .array(z.strictObject({ type: z.literal("image"), data: z.string(), mimeType: name }))
    .nullable(),
  tools: z
    .array(
      z.strictObject({
        id: name,
        name,
        description: z.string(),
        parameters: z.record(z.string(), z.unknown()),
      }),
    )
    .max(CODEMODE_LIMITS.maxHandles),
});

/** Explicit operations accepted by the authoritative Node host; no remote property lookup. */
export const codemodeHostOperationSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    operation: z.literal("provider.call"),
    provider: name,
    tool: name,
    argsJson: z.string(),
  }),
  z.strictObject({
    operation: z.literal("step.do"),
    parentScope: scope.nullable(),
    name,
    config: stepConfig.nullable(),
    callbackId: handle,
  }),
  z.strictObject({
    operation: z.literal("step.sleep"),
    parentScope: scope.nullable(),
    name,
    duration,
  }),
  z.strictObject({
    operation: z.literal("step.sleepUntil"),
    parentScope: scope.nullable(),
    name,
    timestamp: z.union([z.date(), z.number()]),
  }),
  z.strictObject({
    operation: z.literal("step.waitForEvent"),
    parentScope: scope.nullable(),
    name,
    eventType: name,
    timeout: duration.nullable(),
    callbackId: handle.nullable(),
  }),
  z.strictObject({ operation: z.literal("tx.emit"), txId: handle, payload: z.unknown() }),
  z.strictObject({ operation: z.literal("tx.previousEmissions"), txId: handle }),
  z.strictObject({ operation: z.literal("tx.previousConsumedEvents"), txId: handle }),
  z.strictObject({
    operation: z.literal("tx.workflowServiceCalls"),
    txId: handle,
    operations: z.array(workflowOperation).max(CODEMODE_LIMITS.maxEntries),
  }),
  z.strictObject({ operation: z.literal("tx.triggerHook"), txId: handle, intent: hookIntent }),
  z.strictObject({
    operation: z.literal("tx.onEvent"),
    txId: handle,
    eventType: name,
    callbackId: handle,
  }),
  z.strictObject({ operation: z.literal("tx.unsubscribe"), txId: handle, subscriptionId: handle }),
  z.strictObject({
    operation: z.literal("agent.prompt"),
    parentScope: scope.nullable(),
    name,
    input: promptInput,
    callbackId: handle.nullable(),
  }),
]);

/** Guest callbacks are capabilities scoped to the step, subscription, or prompt that created them. */
export const codemodeGuestOperationSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    operation: z.literal("callback.step"),
    callbackId: handle,
    txId: handle,
    scope,
  }),
  z.strictObject({
    operation: z.literal("callback.consume"),
    callbackId: handle,
    txId: handle,
    event,
  }),
  z.strictObject({
    operation: z.literal("callback.event"),
    callbackId: handle,
    deliveryId: handle,
    event: event.extend({ id: name }),
  }),
  z.strictObject({
    operation: z.literal("callback.agentTool"),
    callbackId: handle,
    toolId: name,
    toolCallId: name,
    input: z.unknown(),
  }),
]);

export type CodemodeHostOperation = z.infer<typeof codemodeHostOperationSchema>;
export type CodemodeGuestOperation = z.infer<typeof codemodeGuestOperationSchema>;

const activationBase = {
  code: z.string().min(1).max(CODEMODE_LIMITS.maxSourceBytes),
  dependencies: z
    .record(z.string().min(1).max(214), z.string().min(1).max(256))
    .refine((value) => Object.keys(value).length <= CODEMODE_LIMITS.maxDependencies),
  providers: z
    .array(z.strictObject({ name, tools: z.array(name).max(CODEMODE_LIMITS.maxEntries) }))
    .max(CODEMODE_LIMITS.maxProviders),
  timeoutMs: z.number().int().positive().max(CODEMODE_LIMITS.activationTimeoutMs),
};
/** One activation owns one socket and one guest, regardless of its number of workflow steps. */
export const codemodeActivationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("immediate"), ...activationBase }),
  z.strictObject({ kind: z.literal("module"), ...activationBase }),
  z.strictObject({
    kind: z.literal("workflow"),
    ...activationBase,
    event: z
      .object({ payload: z.unknown(), timestamp: z.date(), instanceId: name, id: name })
      .catchall(z.unknown()),
    agentAvailable: z.boolean(),
  }),
]);
export type CodemodeActivation = z.infer<typeof codemodeActivationSchema>;

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
});
export type CodemodeWireError = z.infer<typeof errorSchema>;
const callResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("ok"), value: z.unknown() }),
  z.strictObject({ status: z.literal("error"), error: errorSchema }),
  z.strictObject({ status: z.literal("suspended"), reason: codemodeSuspensionReasonSchema }),
]);
export type CodemodeCallResult = z.infer<typeof callResultSchema>;
const completionSchema = z.discriminatedUnion("status", [
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
export type CodemodeCompletion = z.infer<typeof completionSchema>;

/** Version and execution identity are negotiated once, in start, rather than per call. */
export const codemodeMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("start"),
    protocolVersion: z.literal(1),
    executionId: z.uuid(),
    activation: codemodeActivationSchema,
  }),
  z.strictObject({
    type: z.literal("call"),
    id: handle,
    call: z.union([codemodeHostOperationSchema, codemodeGuestOperationSchema]),
  }),
  z.strictObject({ type: z.literal("return"), id: handle, result: callResultSchema }),
  z.strictObject({ type: z.literal("complete"), completion: completionSchema }),
  z.strictObject({ type: z.literal("cancel") }),
]);
export type CodemodeMessage = z.infer<typeof codemodeMessageSchema>;

/** Node-owned execution boundary; implementations must never retry an activation implicitly. */
export type CodemodeRemoteExecutor = (
  activation: CodemodeActivation,
  host: {
    handle(
      call: CodemodeHostOperation,
      guest: (call: CodemodeGuestOperation) => Promise<unknown>,
    ): Promise<unknown>;
    close(): void;
    settle(): Promise<CodemodeSuspensionReason | null>;
  },
) => Promise<CodemodeCompletion>;
