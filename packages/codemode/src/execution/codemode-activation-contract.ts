import type { RemoteWorkflowHookIntent } from "@fragno-dev/workflows/remote-workflow";
import type {
  WorkflowDuration,
  WorkflowStepConfig,
  WorkflowStepEvent,
  WorkflowStepWorkflowOperation,
} from "@fragno-dev/workflows/workflow";
import type { WorkflowStepCallOutcome } from "@fragno-dev/workflows/workflow-tick";
import { z } from "zod";

import { CODEMODE_LIMITS } from "../codemode-limits";
import { codemodeLogLineSchema } from "../runtime-api";
import { codemodeWireErrorSchema } from "./codemode-error-contract";
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
  providers: z.array(
    z.strictObject({ name, tools: z.array(name).max(CODEMODE_LIMITS.maxEntries) }),
  ),
  timeoutMs: z.number().int().positive().max(CODEMODE_LIMITS.activationTimeoutMs),
};
const activationBase = {
  ...executionBase,
  code: z.string().min(1).max(CODEMODE_LIMITS.maxSourceBytes),
  dependencies: z.record(z.string().min(1).max(214), z.string().min(1).max(256)),
};
const sourceModulePath = z
  .string()
  .max(512)
  .regex(/^\/[^\p{Cc}]*\.js$/u)
  .refine((path) => !path.split("/").some((segment) => segment === ".." || segment === "."));
/**
 * Source modules by absolute path, importable by that path or relative to an importing module.
 * The caller resolves the complete import graph; the compiler never reads files.
 */
const sourceModules = z.record(sourceModulePath, z.string().max(CODEMODE_LIMITS.maxSourceBytes));
/** Compilers resolve an absolute specifier against the project root, which has no leading slash. */
export function sourceModuleFiles(
  modules: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(modules).map(([path, source]) => [path.slice(1), source]),
  );
}
/** A saved program compiles at its own path, so its relative imports resolve like the files'. */
const moduleProgram = {
  dependencies: activationBase.dependencies,
  entry: sourceModulePath,
  modules: sourceModules,
};
const isModuleProgramEntry = (activation: { entry: string; modules: Record<string, string> }) =>
  Object.hasOwn(activation.modules, activation.entry);
/** One activation owns one socket and one guest, regardless of its number of workflow steps. */
export const codemodeActivationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("immediate"), ...activationBase, modules: sourceModules }),
  z
    .strictObject({ kind: z.literal("module"), ...executionBase, ...moduleProgram })
    .refine(isModuleProgramEntry),
  z
    .strictObject({ kind: z.literal("module-build"), ...moduleProgram })
    .refine(isModuleProgramEntry),
  z.strictObject({
    kind: z.literal("compiled"),
    ...executionBase,
    bundle: codemodeWorkerBundleSchema,
    invocation: z.string().min(1).max(CODEMODE_LIMITS.maxSourceBytes).nullable(),
    input: z.unknown(),
  }),
  z
    .strictObject({
      kind: z.literal("workflow"),
      ...executionBase,
      ...moduleProgram,
      event: z
        .object({ payload: z.unknown(), timestamp: z.date(), instanceId: name, id: name })
        .catchall(z.unknown()),
      /** Settle orders of the steps that settled in earlier ticks, which the guest replays. */
      settledOrders: z.array(z.number().int().nonnegative()),
    })
    .refine(isModuleProgramEntry),
]);
export type CodemodeActivation = z.infer<typeof codemodeActivationSchema>;
/** Independently deployed peers must agree on the application API before compilation starts. */
export const codemodeExecutionRequestSchema = z.strictObject({
  protocolVersion: z.literal(2),
  executionId: z.uuid(),
  activation: codemodeActivationSchema,
});

/** Domain failures stay explicit across native RPC and Cap'n Web rather than relying on Error subclasses. */
export const codemodeCallbackResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("ok"), value: z.unknown() }),
  z.strictObject({ status: z.literal("error"), error: codemodeWireErrorSchema }),
]);
export type CodemodeToolResult = z.infer<typeof codemodeCallbackResultSchema>;
/**
 * How a step call ended, which survives both transports without depending on native Error
 * properties: settled with its place in the settle order, or parked until a later tick.
 */
export type CodemodeStepResult =
  | { status: "settled"; result: CodemodeToolResult; order: number | null }
  | { status: "parked" };
/**
 * The bridge's answer for one activation: the guest's completion; `unavailable` when the bridge
 * declined to run it, such as with a full compile queue; or `interrupted` when the bridge ended a
 * workflow tick, such as at its deadline, before the tick had an outcome of its own. Only the
 * bridge's own signals produce the last two, never a guest.
 */
export const codemodeBridgeAnswerSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("completed"),
    value: z.unknown(),
    logs: z.array(codemodeLogLineSchema).max(CODEMODE_LIMITS.maxLogs),
    workflowDefinition: z.strictObject({ name, options: z.unknown() }).nullable(),
  }),
  z.strictObject({
    status: z.literal("failed"),
    error: codemodeWireErrorSchema,
    logs: z.array(codemodeLogLineSchema).max(CODEMODE_LIMITS.maxLogs),
  }),
  // A workflow guest's code stopped without settling: its tick ended idle.
  z.strictObject({
    status: z.literal("suspended"),
    logs: z.array(codemodeLogLineSchema).max(CODEMODE_LIMITS.maxLogs),
  }),
  z.strictObject({ status: z.literal("unavailable"), cause: z.string().max(1024) }),
  z.strictObject({ status: z.literal("interrupted"), cause: z.string().max(1024) }),
]);
export type CodemodeBridgeAnswer = z.infer<typeof codemodeBridgeAnswerSchema>;
/** How the guest's execution ended. */
export type CodemodeCompletion = Exclude<
  CodemodeBridgeAnswer,
  { status: "unavailable" | "interrupted" }
>;

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
/** A guest's steps; a step's callback receives only its transaction, since it cannot call steps. */
export interface CodemodeStepCapability {
  do(
    name: string,
    config: WorkflowStepConfig | undefined,
    callback: (tx: CodemodeTransactionCapability) => Promise<CodemodeToolResult>,
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
  ): Promise<CodemodeBridgeAnswer>;
}
/** Trusted workflow collaborator; revocable capabilities wrap it before anything reaches the guest. */
export interface CodemodeWorkflowHost {
  do(
    name: string,
    config: WorkflowStepConfig | undefined,
    callback: (tx: CodemodeWorkflowTransactionHost) => Promise<unknown>,
  ): Promise<WorkflowStepCallOutcome>;
  sleep(name: string, duration: WorkflowDuration): Promise<WorkflowStepCallOutcome>;
  sleepUntil(name: string, timestamp: Date | number): Promise<WorkflowStepCallOutcome>;
  waitForEvent(
    name: string,
    options: {
      type: string;
      timeout: WorkflowDuration | undefined;
      onConsume:
        | ((tx: CodemodeWorkflowTransactionHost, event: unknown) => Promise<void>)
        | undefined;
    },
  ): Promise<WorkflowStepCallOutcome>;
}
export interface CodemodeWorkflowTransactionHost {
  emit(payload: unknown): void;
  previousEmissions(): Promise<unknown>;
  previousConsumedEvents(): Promise<unknown>;
  workflowServiceCalls(operations: readonly WorkflowStepWorkflowOperation[]): void;
  triggerHook(intent: RemoteWorkflowHookIntent): void;
  onEvent(type: string, callback: (event: WorkflowStepEvent) => Promise<void>): () => void;
}
/**
 * Settling waits for the calls the host forwarded, so none outlives the activation; closing never
 * implies rollback. Closing resolves once revocation holds, which over Workers RPC is a later round
 * trip.
 */
export type CodemodeHost = {
  capabilities: CodemodeCapabilities;
  close(): Promise<void>;
  settle(): Promise<void>;
};
/**
 * The activation has no outcome of its own, such as when the executor lost the bridge or the bridge
 * ended a workflow tick at its deadline. Only executors and the bridge report it, from their own
 * deadlines and connections, so guests cannot forge it.
 */
export type CodemodeInterruption = { status: "interrupted"; cause: string };
/** Runs one activation against its caller's host; implementations never retry it implicitly. */
export type CodemodeExecutor = (
  activation: CodemodeActivation,
  host: CodemodeHost,
) => Promise<CodemodeCompletion | CodemodeInterruption>;
