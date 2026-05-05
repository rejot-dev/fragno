import type { StandardSchemaV1 } from "@fragno-dev/core/api";

import type { FragnoRuntime } from "@fragno-dev/core";
import type { HandlerTxContext, HooksMap, TxResult } from "@fragno-dev/db";

import type { WorkflowsLoggerConfig } from "./debug-log";
import type { WorkflowLiveStateStore, WorkflowStepLiveStateShape } from "./live-state";

/** Relative or absolute durations supported by workflow steps. */
export type WorkflowDuration = string | number;

/** Event delivered to a workflow instance run. */
export type WorkflowEvent<T> = {
  payload: Readonly<T>;
  timestamp: Date;
  instanceId: string;
  runNumber?: number;
};

/** Retry behavior for a step execution. */
export type WorkflowStepConfig<
  TLiveState extends WorkflowStepLiveStateShape | undefined = undefined,
> = {
  retries?: {
    limit: number;
    delay: WorkflowDuration;
    backoff?: "constant" | "linear" | "exponential";
  };
  liveState?: TLiveState | (() => TLiveState);
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

export type WorkflowStepLiveStateController<TState extends WorkflowStepLiveStateShape> = {
  getState: () => TState;
  setState: (patch: Partial<TState> | ((state: TState) => Partial<TState>)) => void;
};

export type WorkflowStepTx<TLiveState extends WorkflowStepLiveStateShape | undefined = undefined> =
  {
    liveState: TLiveState extends WorkflowStepLiveStateShape
      ? WorkflowStepLiveStateController<TLiveState>
      : undefined;
    serviceCalls: (factory: () => readonly AnyTxResult[]) => void;
    mutate: (fn: (ctx: HandlerTxContext<HooksMap>) => void) => void;
    onTerminalError: {
      /**
       * Queue DB mutations that should only commit if the enclosing step ends in a terminal error
       * (non-retryable failure or retries exhausted). These callbacks are skipped for successful
       * runs and for retryable failures that suspend the step for another attempt.
       */
      mutate: (fn: (ctx: HandlerTxContext<HooksMap>) => void) => void;
    };
  };

/** Execution helpers that provide replay-safe step semantics. */
export interface WorkflowStep {
  do<T>(name: string, callback: (tx: WorkflowStepTx) => Promise<T> | T): Promise<T>;
  do<T, TLiveState extends WorkflowStepLiveStateShape>(
    name: string,
    config: WorkflowStepConfig<TLiveState>,
    callback: (tx: WorkflowStepTx<TLiveState>) => Promise<T> | T,
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
  parentStepKey: string | null;
  depth: number;
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
export interface WorkflowInstanceCreateOptionsWithId<
  TParams = unknown,
> extends WorkflowInstanceCreateOptions<TParams> {
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

/** Function-based workflow run signature. */
export type WorkflowRunFn<TParams = unknown, TOutput = unknown> = (
  event: WorkflowEvent<TParams>,
  step: WorkflowStep,
) => Promise<TOutput> | TOutput;

/** Function-based workflow definition. */
export interface WorkflowDefinition<
  TParams = unknown,
  TOutput = unknown,
  TInputSchema extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
  TOutputSchema extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
  TName extends string = string,
> {
  name: TName;
  schema?: TInputSchema;
  outputSchema?: TOutputSchema;
  run: WorkflowRunFn<TParams, TOutput>;
}

export function defineWorkflow<TName extends string, TParams, TOutput = unknown>(
  options: { name: TName; schema?: undefined; outputSchema?: undefined },
  run: WorkflowRunFn<TParams, TOutput>,
): WorkflowDefinition<TParams, TOutput, undefined, undefined, TName>;
export function defineWorkflow<
  TName extends string,
  TSchema extends StandardSchemaV1,
  TOutput = unknown,
>(
  options: { name: TName; schema: TSchema; outputSchema?: undefined },
  run: WorkflowRunFn<StandardSchemaV1.InferOutput<TSchema>, TOutput>,
): WorkflowDefinition<StandardSchemaV1.InferOutput<TSchema>, TOutput, TSchema, undefined, TName>;
export function defineWorkflow<
  TName extends string,
  TOutputSchema extends StandardSchemaV1,
  TParams = unknown,
>(
  options: {
    name: TName;
    schema?: undefined;
    outputSchema: TOutputSchema;
  },
  run: WorkflowRunFn<TParams, StandardSchemaV1.InferOutput<TOutputSchema>>,
): WorkflowDefinition<
  TParams,
  StandardSchemaV1.InferOutput<TOutputSchema>,
  undefined,
  TOutputSchema,
  TName
>;
export function defineWorkflow<
  TName extends string,
  TInputSchema extends StandardSchemaV1,
  TOutputSchema extends StandardSchemaV1,
>(
  options: {
    name: TName;
    schema: TInputSchema;
    outputSchema: TOutputSchema;
  },
  run: WorkflowRunFn<
    StandardSchemaV1.InferOutput<TInputSchema>,
    StandardSchemaV1.InferOutput<TOutputSchema>
  >,
): WorkflowDefinition<
  StandardSchemaV1.InferOutput<TInputSchema>,
  StandardSchemaV1.InferOutput<TOutputSchema>,
  TInputSchema,
  TOutputSchema,
  TName
>;
export function defineWorkflow<TName extends string>(
  options: {
    name: TName;
    schema?: StandardSchemaV1;
    outputSchema?: StandardSchemaV1;
  },
  run: WorkflowRunFn<unknown, unknown>,
): WorkflowDefinition<
  unknown,
  unknown,
  StandardSchemaV1 | undefined,
  StandardSchemaV1 | undefined,
  TName
> {
  return { ...options, run };
}

/** Workflow registry entry (function-based). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WorkflowRegistryEntry = WorkflowDefinition<any, any, any, any, string>;

export type WorkflowParamsFromEntry<TEntry> =
  TEntry extends WorkflowDefinition<
    infer TParams,
    unknown,
    StandardSchemaV1 | undefined,
    StandardSchemaV1 | undefined,
    string
  >
    ? TParams
    : unknown;

export type WorkflowOutputFromEntry<TEntry> =
  TEntry extends WorkflowDefinition<
    unknown,
    infer TOutput,
    StandardSchemaV1 | undefined,
    StandardSchemaV1 | undefined,
    string
  >
    ? TOutput
    : unknown;

export type WorkflowNameFromEntry<TEntry> =
  TEntry extends WorkflowDefinition<
    unknown,
    unknown,
    StandardSchemaV1 | undefined,
    StandardSchemaV1 | undefined,
    infer TName
  >
    ? TName
    : never;

export type WorkflowNameFromRegistry<TRegistry extends WorkflowsRegistry> = Extract<
  WorkflowNameFromEntry<TRegistry[keyof TRegistry]>,
  string
>;

export type WorkflowEntryFromName<
  TRegistry extends WorkflowsRegistry,
  TWorkflowName extends string,
> = {
  [K in keyof TRegistry]: WorkflowNameFromEntry<TRegistry[K]> extends TWorkflowName
    ? TRegistry[K]
    : never;
}[keyof TRegistry];

/** Map of binding keys to workflow definitions. */
export type WorkflowsRegistry = Record<string, WorkflowRegistryEntry>;

/** Error type that bypasses automatic retries. */
export class NonRetryableError extends Error {
  constructor(message: string, name?: string) {
    super(message);
    this.name = name ?? "NonRetryableError";
  }
}

/** Thrown when a `waitForEvent` step exceeds its timeout deadline. */
export class WaitForEventTimeoutError extends NonRetryableError {
  constructor() {
    super("WAIT_FOR_EVENT_TIMEOUT", "WaitForEventTimeoutError");
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
  liveState?: WorkflowLiveStateStore;
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
