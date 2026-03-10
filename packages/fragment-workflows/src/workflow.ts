import type { FragnoRuntime } from "@fragno-dev/core";
import type { StandardSchemaV1 } from "@fragno-dev/core/api";
import type { HandlerTxContext, HooksMap, TxResult } from "@fragno-dev/db";
import type { WorkflowsLoggerConfig } from "./debug-log";

/** Relative or absolute durations supported by workflow steps. */
export type WorkflowDuration = string | number;

/** Event delivered to a workflow instance run. */
export type WorkflowEvent<T> = {
  payload: Readonly<T>;
  timestamp: Date;
  instanceId: string;
};

/** Retry behavior for a step execution. */
export type WorkflowStepConfig = {
  retries?: {
    limit: number;
    delay: WorkflowDuration;
    backoff?: "constant" | "linear" | "exponential";
  };
};

export type WorkflowLogLevel = "debug" | "info" | "warn" | "error";

export type WorkflowLogOptions = {
  category?: string;
};

export type WorkflowLogger = {
  debug: (message: string, data?: unknown, options?: WorkflowLogOptions) => Promise<void>;
  info: (message: string, data?: unknown, options?: WorkflowLogOptions) => Promise<void>;
  warn: (message: string, data?: unknown, options?: WorkflowLogOptions) => Promise<void>;
  error: (message: string, data?: unknown, options?: WorkflowLogOptions) => Promise<void>;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTxResult = TxResult<any, any>;

export type WorkflowStepTx = {
  serviceCalls: (factory: () => readonly AnyTxResult[]) => void;
  mutate: (fn: (ctx: HandlerTxContext<HooksMap>) => void) => void;
};

/** Execution helpers that provide replay-safe step semantics. */
export interface WorkflowStep {
  do<T>(name: string, callback: (tx: WorkflowStepTx) => Promise<T> | T): Promise<T>;
  do<T>(
    name: string,
    config: WorkflowStepConfig,
    callback: (tx: WorkflowStepTx) => Promise<T> | T,
  ): Promise<T>;
  sleep(name: string, duration: WorkflowDuration): Promise<void>;
  sleepUntil(name: string, timestamp: Date | number): Promise<void>;
  waitForEvent<T = unknown>(
    name: string,
    options: { type: string; timeout?: WorkflowDuration },
  ): Promise<{ type: string; payload: Readonly<T>; timestamp: Date }>;
}

/** Serialized instance status returned to API consumers. */
export type InstanceStatusWithOutput<TOutput = unknown> = {
  status: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
  error?: { name: string; message: string };
  output?: TOutput;
};

export type InstanceStatus = InstanceStatusWithOutput<unknown>;

/** Summary of the latest step execution for an instance run. */
export type WorkflowInstanceCurrentStep = {
  stepKey: string;
  name: string;
  type: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  timeoutMs: number | null;
  nextRetryAt: Date | null;
  wakeAt: Date | null;
  waitEventType: string | null;
  error?: { name: string; message: string };
};

/** Metadata describing a workflow instance for operators. */
export type WorkflowInstanceMetadata = {
  workflowName: string;
  runNumber: number;
  params: unknown;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  currentStep?: WorkflowInstanceCurrentStep;
};

/** Handle for a workflow instance returned by the management API. */
export interface WorkflowInstance<TOutput = unknown> {
  id: string;
  status(): Promise<InstanceStatusWithOutput<TOutput>>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  terminate(): Promise<void>;
  restart(): Promise<void>;
  sendEvent(options: { type: string; payload?: unknown }): Promise<void>;
}

/** Options for creating a workflow instance. */
export interface WorkflowInstanceCreateOptions<TParams = unknown> {
  id?: string;
  params?: TParams;
}

/** Create options that require a user-specified instance id. */
export interface WorkflowInstanceCreateOptionsWithId<TParams = unknown>
  extends WorkflowInstanceCreateOptions<TParams> {
  id: string;
}

/** Management API for a named workflow. */
export interface Workflow<TParams = unknown, TOutput = unknown> {
  create(options?: WorkflowInstanceCreateOptions<TParams>): Promise<WorkflowInstance<TOutput>>;
  createBatch(
    batch: WorkflowInstanceCreateOptionsWithId<TParams>[],
  ): Promise<WorkflowInstance<TOutput>[]>;
  get(id: string): Promise<WorkflowInstance<TOutput>>;
}

/** Bound workflow handles exposed on fragments. */
export type WorkflowBindings<TRegistry extends WorkflowsRegistry = WorkflowsRegistry> = {
  [K in keyof TRegistry]: Workflow<
    WorkflowParamsFromEntry<TRegistry[K]>,
    WorkflowOutputFromEntry<TRegistry[K]>
  >;
};

/** JSON-like workflow state shape restored by replaying workflow execution. */
export type WorkflowStateShape = Record<string, unknown>;

/**
 * Optional `this` binding exposed to stateful workflows.
 * Replay shallow-merges each emitted patch onto the latest restored state snapshot.
 */
export type WorkflowStateContext<TState extends WorkflowStateShape | undefined = undefined> = {
  setState: (nextState: TState extends WorkflowStateShape ? Partial<TState> : never) => void;
};

/**
 * Function-based workflow run signature.
 * Note: replay reruns workflow code around cached completed step results, so `setState` calls
 * inside completed `step.do(...)` callbacks are not restorable unless user code re-emits them
 * after the step returns.
 */
export type WorkflowRunFn<
  TParams = unknown,
  TOutput = unknown,
  TState extends WorkflowStateShape | undefined = undefined,
> = (
  this: WorkflowStateContext<TState> | undefined,
  event: WorkflowEvent<TParams>,
  step: WorkflowStep,
) => Promise<TOutput> | TOutput;

/** Function-based workflow definition. */
export interface WorkflowDefinition<
  TParams = unknown,
  TOutput = unknown,
  TInputSchema extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
  TOutputSchema extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
  TState extends WorkflowStateShape | undefined = undefined,
> {
  name: string;
  schema?: TInputSchema;
  outputSchema?: TOutputSchema;
  initialState?: TState;
  run(
    this: WorkflowStateContext<TState> | undefined,
    event: WorkflowEvent<TParams>,
    step: WorkflowStep,
  ): Promise<TOutput> | TOutput;
}

export function defineWorkflow<
  TParams,
  TOutput = unknown,
  TState extends WorkflowStateShape | undefined = undefined,
>(
  options: { name: string; schema?: undefined; outputSchema?: undefined; initialState?: TState },
  run: WorkflowRunFn<TParams, TOutput, TState>,
): WorkflowDefinition<TParams, TOutput, undefined, undefined, TState>;
export function defineWorkflow<
  TSchema extends StandardSchemaV1,
  TOutput = unknown,
  TState extends WorkflowStateShape | undefined = undefined,
>(
  options: { name: string; schema: TSchema; outputSchema?: undefined; initialState?: TState },
  run: WorkflowRunFn<StandardSchemaV1.InferOutput<TSchema>, TOutput, TState>,
): WorkflowDefinition<StandardSchemaV1.InferOutput<TSchema>, TOutput, TSchema, undefined, TState>;
export function defineWorkflow<
  TOutputSchema extends StandardSchemaV1,
  TParams = unknown,
  TState extends WorkflowStateShape | undefined = undefined,
>(
  options: {
    name: string;
    schema?: undefined;
    outputSchema: TOutputSchema;
    initialState?: TState;
  },
  run: WorkflowRunFn<TParams, StandardSchemaV1.InferOutput<TOutputSchema>, TState>,
): WorkflowDefinition<
  TParams,
  StandardSchemaV1.InferOutput<TOutputSchema>,
  undefined,
  TOutputSchema,
  TState
>;
export function defineWorkflow<
  TInputSchema extends StandardSchemaV1,
  TOutputSchema extends StandardSchemaV1,
  TState extends WorkflowStateShape | undefined = undefined,
>(
  options: {
    name: string;
    schema: TInputSchema;
    outputSchema: TOutputSchema;
    initialState?: TState;
  },
  run: WorkflowRunFn<
    StandardSchemaV1.InferOutput<TInputSchema>,
    StandardSchemaV1.InferOutput<TOutputSchema>,
    TState
  >,
): WorkflowDefinition<
  StandardSchemaV1.InferOutput<TInputSchema>,
  StandardSchemaV1.InferOutput<TOutputSchema>,
  TInputSchema,
  TOutputSchema,
  TState
>;
export function defineWorkflow(
  options: {
    name: string;
    schema?: StandardSchemaV1;
    outputSchema?: StandardSchemaV1;
    initialState?: WorkflowStateShape;
  },
  run: WorkflowRunFn<unknown, unknown, WorkflowStateShape | undefined>,
): WorkflowDefinition<
  unknown,
  unknown,
  StandardSchemaV1 | undefined,
  StandardSchemaV1 | undefined,
  WorkflowStateShape | undefined
> {
  return { ...options, run };
}

/** Workflow registry entry (function-based). */
export type WorkflowRegistryEntry = WorkflowDefinition<
  unknown,
  unknown,
  StandardSchemaV1 | undefined,
  StandardSchemaV1 | undefined,
  WorkflowStateShape | undefined
>;

export type WorkflowParamsFromEntry<TEntry> =
  TEntry extends WorkflowDefinition<
    infer TParams,
    unknown,
    StandardSchemaV1 | undefined,
    StandardSchemaV1 | undefined,
    WorkflowStateShape | undefined
  >
    ? TParams
    : unknown;

export type WorkflowOutputFromEntry<TEntry> =
  TEntry extends WorkflowDefinition<
    unknown,
    infer TOutput,
    StandardSchemaV1 | undefined,
    StandardSchemaV1 | undefined,
    WorkflowStateShape | undefined
  >
    ? TOutput
    : unknown;

export type WorkflowStateFromEntry<TEntry> =
  TEntry extends WorkflowDefinition<
    unknown,
    unknown,
    StandardSchemaV1 | undefined,
    StandardSchemaV1 | undefined,
    infer TState
  >
    ? TState
    : undefined;

export type WorkflowRestoredState<TEntry> =
  WorkflowStateFromEntry<TEntry> extends undefined ? undefined : WorkflowStateFromEntry<TEntry>;

/** Map of binding keys to workflow definitions. */
export type WorkflowsRegistry = Record<string, WorkflowRegistryEntry>;

/** Error type that bypasses automatic retries. */
export class NonRetryableError extends Error {
  constructor(message: string, name?: string) {
    super(message);
    this.name = name ?? "NonRetryableError";
  }
}

/** Durable hook payload emitted when a workflow is ready to run. */
export type WorkflowEnqueuedHookPayload = {
  workflowName: string;
  instanceId: string;
  instanceRef: string;
  runNumber: number;
  reason: "create" | "event" | "resume" | "retry" | "wake";
};

export type WorkflowsHooks = {
  onWorkflowEnqueued: (payload: WorkflowEnqueuedHookPayload) => void | Promise<void>;
};

/** Dispatcher interface used by durable hooks to trigger runner work. */
export interface WorkflowsDispatcher {
  wake: (payload: WorkflowEnqueuedHookPayload) => Promise<void> | void;
}

/** Actions available on workflow instances. */
export type WorkflowManagementAction = "pause" | "resume" | "terminate" | "restart";

/** Configuration for the workflows fragment. */
export interface WorkflowsFragmentConfig<TRegistry extends WorkflowsRegistry = WorkflowsRegistry> {
  workflows?: TRegistry;
  dispatcher?: WorkflowsDispatcher;
  /**
   * Disable built-in durable hook ticking (useful for tests that drive ticks manually).
   * Defaults to true.
   */
  autoTickHooks?: boolean;
  /**
   * Optional logging config for internal workflows diagnostics.
   */
  logging?: WorkflowsLoggerConfig;
  runtime: FragnoRuntime;
}

const TERMINAL_STATUSES: InstanceStatus["status"][] = ["complete", "terminated", "errored"];
const WAITING_STATUSES: InstanceStatus["status"][] = ["waiting"];

export const isTerminalStatus = (status: InstanceStatus["status"]) =>
  TERMINAL_STATUSES.includes(status);

export const isWaitingStatus = (status: InstanceStatus["status"]) =>
  WAITING_STATUSES.includes(status);

export const statusLabel = (status: InstanceStatus["status"]) => {
  const labels: Record<InstanceStatus["status"], string> = {
    active: "Active",
    paused: "Paused",
    errored: "Errored",
    terminated: "Terminated",
    complete: "Complete",
    waiting: "Waiting",
  };

  return labels[status];
};

export const currentStepLabel = (step?: WorkflowInstanceCurrentStep | null) => {
  if (!step) {
    return undefined;
  }

  return step.name ? `${step.name} (${step.type})` : step.type;
};
