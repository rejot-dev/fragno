import type { StandardSchemaV1 } from "@fragno-dev/core/api";

import type { FragnoRuntime } from "@fragno-dev/core";
import type { HandlerTxContext, HooksMap, TxResult } from "@fragno-dev/db";

import type { WorkflowsLoggerConfig } from "./debug-log";
import { getRemoteWorkflowStepHost, type RemoteWorkflowStepHost } from "./remote-workflow";
import type { WorkflowStepLivePumpRegistry } from "./runner/step-live-pump";
import type { WorkflowEventActor } from "./system-events";

/** Relative or absolute durations supported by workflow steps. */
export type WorkflowDuration = string | number;

/** Event delivered to a workflow instance run. */
export type WorkflowEvent<T> = {
  payload: Readonly<T>;
  /** Stable workflow instance creation time across retries and restarts. */
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

export type WorkflowStepEvent<TPayload = unknown> = {
  id: string;
  type: string;
  payload: Readonly<TPayload>;
  timestamp: Date;
  /**
   * Queue an acknowledgement of this event.
   *
   * The acknowledgement becomes durable when the step-emission pump next flushes. Until then,
   * and during concurrent delivery races, the event may be delivered again.
   */
  consume(): void;
};

export type WorkflowStepEventHandler<TPayload = unknown> = (
  event: WorkflowStepEvent<TPayload>,
) => void | Promise<void>;

export type WorkflowStepConsumedEvent<TPayload = unknown> = {
  id: string;
  type: string;
  payload: Readonly<TPayload>;
  timestamp: Date;
};

export type WorkflowStepEmission<TPayload = unknown> = {
  id: string;
  actor: WorkflowEventActor;
  stepKey: string;
  executionId: string;
  epoch: string;
  sequence: number;
  payload: TPayload;
  createdAt: Date;
};

export type WorkflowStepWorkflowOperation =
  | {
      type: "createInstance";
      workflowName: string;
      instanceId: string;
      params: unknown;
      remoteWorkflowName?: string | null;
    }
  | {
      /** Atomically send an event to a non-remote workflow instance. */
      type: "createEvent";
      workflowName: string;
      instanceId: string;
      eventId: string;
      eventType: string;
      payload?: unknown;
    };

export type WorkflowStepConsumeTx<THooks extends HooksMap = HooksMap> = {
  serviceCalls: (factory: () => readonly AnyTxResult[]) => void;
  mutate: (fn: (ctx: HandlerTxContext<THooks>) => void) => void;
  /** Queue an outbound workflow-authored emission for the step-emission pump to persist. */
  emit: (payload: unknown) => void;
  /** Emissions for this step that were already persisted before the current attempt started. */
  previousEmissions: () => Promise<WorkflowStepEmission[]>;
};

export type WorkflowStepTx<THooks extends HooksMap = HooksMap> = WorkflowStepConsumeTx<THooks> & {
  /** Events durably acknowledged by this step before the current attempt started. */
  previousConsumedEvents: <TPayload = unknown>() => Promise<WorkflowStepConsumedEvent<TPayload>[]>;
  workflowServiceCalls: (factory: () => readonly WorkflowStepWorkflowOperation[]) => void;
  onTerminalError: {
    /**
     * Queue DB mutations that should only commit if the enclosing step ends in a terminal error
     * (non-retryable failure or retries exhausted). These callbacks are skipped for successful
     * runs and for retryable failures that suspend the step for another attempt.
     */
    mutate: (fn: (ctx: HandlerTxContext<THooks>) => void) => void;
  };
  /**
   * Observe durable workflow events of an exact type while this step is active.
   * Handlers may receive an event more than once until event.consume() is durably flushed.
   */
  onEvent: (type: string, handler: WorkflowStepEventHandler) => () => void;
};

/** Execution helpers that provide replay-safe step semantics. */
export interface WorkflowStep<THooks extends HooksMap = HooksMap> {
  do<T>(name: string, callback: (tx: WorkflowStepTx<THooks>) => Promise<T> | T): Promise<T>;
  do<T>(
    name: string,
    config: WorkflowStepConfig,
    callback: (tx: WorkflowStepTx<THooks>) => Promise<T> | T,
  ): Promise<T>;
  sleep(name: string, duration: WorkflowDuration): Promise<void>;
  sleepUntil(name: string, timestamp: Date | number): Promise<void>;
  waitForEvent<T = unknown>(
    name: string,
    options: {
      type: string;
      timeout?: WorkflowDuration;
      onConsume?: (
        tx: WorkflowStepConsumeTx<THooks>,
        event: { type: string; payload: Readonly<T>; timestamp: Date },
      ) => Promise<void> | void;
    },
  ): Promise<{ type: string; payload: Readonly<T>; timestamp: Date }>;
}

/** Serialized instance status returned to API consumers. */
export type InstanceStatusWithOutput<TOutput = unknown> = {
  status: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
  runGeneration: number;
  error?: { name: string; message: string };
  output?: TOutput;
};

export type InstanceStatus = InstanceStatusWithOutput;

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
  remoteWorkflowName?: string;
  runGeneration: number;
  params: unknown;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  currentStep?: WorkflowInstanceCurrentStep;
};

export type WorkflowRetryFailedStepOptions = {
  delayMs?: number;
};

export type WorkflowInstanceStatus = InstanceStatus["status"];

export type WorkflowRestartPrecondition = {
  status: {
    in: readonly [WorkflowInstanceStatus, ...WorkflowInstanceStatus[]];
  };
  runGeneration?: {
    equals: number;
  };
};

export type WorkflowRestartOrCreateOptions<TParams = unknown> = {
  id: string;
  /** Values used only when no instance with this ID exists. */
  create: {
    params?: TParams;
    remoteWorkflowName?: string;
  };
  restart: {
    precondition: WorkflowRestartPrecondition;
  };
};

export type WorkflowRestartOrCreateInstanceResult<TOutput = unknown> =
  | {
      action: "created";
      id: string;
      details: InstanceStatusWithOutput<TOutput>;
    }
  | {
      action: "restarted";
      previousStatus: WorkflowInstanceStatus;
      id: string;
      details: InstanceStatusWithOutput<TOutput>;
    }
  | {
      action: "unchanged";
      observedStatus: InstanceStatus["status"];
      id: string;
      details: InstanceStatusWithOutput<TOutput>;
    };

export type WorkflowRestartOrCreateResult<TOutput = unknown> =
  | { action: "created"; instance: WorkflowInstance<TOutput> }
  | {
      action: "restarted";
      previousStatus: WorkflowInstanceStatus;
      instance: WorkflowInstance<TOutput>;
    }
  | {
      action: "unchanged";
      observedStatus: InstanceStatus["status"];
      instance: WorkflowInstance<TOutput>;
    };

/** Handle for a workflow instance returned by the management API. */
export interface WorkflowInstance<TOutput = unknown> {
  id: string;
  status(): Promise<InstanceStatusWithOutput<TOutput>>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  restart(): Promise<void>;
  retryFailedStep(options?: WorkflowRetryFailedStepOptions): Promise<void>;
  terminate(): Promise<void>;
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
  restartOrCreate(
    options: WorkflowRestartOrCreateOptions<TParams>,
  ): Promise<WorkflowRestartOrCreateResult<TOutput>>;
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
export type WorkflowRunFn<
  TParams = unknown,
  TOutput = unknown,
  THooks extends HooksMap = HooksMap,
> = (event: WorkflowEvent<TParams>, step: WorkflowStep<THooks>) => Promise<TOutput> | TOutput;

/** Function-based workflow definition. */
export interface WorkflowDefinition<
  TParams = unknown,
  TOutput = unknown,
  TInputSchema extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
  TOutputSchema extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
  TName extends string = string,
  THooks extends HooksMap = HooksMap,
> {
  name: TName;
  schema?: TInputSchema;
  outputSchema?: TOutputSchema;
  /** Commit each completed sequential top-level `step.do` before starting the next one. */
  checkpoint?: "step";
  remote?: boolean;
  remoteWorkflowName?: string;
  run: WorkflowRunFn<TParams, TOutput, THooks>;
}

export type RemoteWorkflowRunFn<TParams = unknown, TOutput = unknown> = (
  event: WorkflowEvent<TParams>,
  remote: RemoteWorkflowStepHost,
) => Promise<TOutput> | TOutput;

export function defineWorkflow<
  TName extends string,
  TParams,
  TOutput = unknown,
  THooks extends HooksMap = HooksMap,
>(
  options: {
    name: TName;
    schema?: undefined;
    outputSchema?: undefined;
    checkpoint?: "step";
  },
  run: WorkflowRunFn<TParams, TOutput, THooks>,
): WorkflowDefinition<TParams, TOutput, undefined, undefined, TName, THooks>;
export function defineWorkflow<
  TName extends string,
  TSchema extends StandardSchemaV1,
  TOutput = unknown,
  THooks extends HooksMap = HooksMap,
>(
  options: {
    name: TName;
    schema: TSchema;
    outputSchema?: undefined;
    checkpoint?: "step";
  },
  run: WorkflowRunFn<StandardSchemaV1.InferOutput<TSchema>, TOutput, THooks>,
): WorkflowDefinition<
  StandardSchemaV1.InferOutput<TSchema>,
  TOutput,
  TSchema,
  undefined,
  TName,
  THooks
>;
export function defineWorkflow<
  TName extends string,
  TOutputSchema extends StandardSchemaV1,
  TParams = unknown,
  THooks extends HooksMap = HooksMap,
>(
  options: {
    name: TName;
    schema?: undefined;
    outputSchema: TOutputSchema;
    checkpoint?: "step";
  },
  run: WorkflowRunFn<TParams, StandardSchemaV1.InferOutput<TOutputSchema>, THooks>,
): WorkflowDefinition<
  TParams,
  StandardSchemaV1.InferOutput<TOutputSchema>,
  undefined,
  TOutputSchema,
  TName,
  THooks
>;
export function defineWorkflow<
  TName extends string,
  TInputSchema extends StandardSchemaV1,
  TOutputSchema extends StandardSchemaV1,
  THooks extends HooksMap = HooksMap,
>(
  options: {
    name: TName;
    schema: TInputSchema;
    outputSchema: TOutputSchema;
    checkpoint?: "step";
  },
  run: WorkflowRunFn<
    StandardSchemaV1.InferOutput<TInputSchema>,
    StandardSchemaV1.InferOutput<TOutputSchema>,
    THooks
  >,
): WorkflowDefinition<
  StandardSchemaV1.InferOutput<TInputSchema>,
  StandardSchemaV1.InferOutput<TOutputSchema>,
  TInputSchema,
  TOutputSchema,
  TName,
  THooks
>;
export function defineWorkflow<TName extends string, THooks extends HooksMap = HooksMap>(
  options: {
    name: TName;
    schema?: StandardSchemaV1;
    outputSchema?: StandardSchemaV1;
    checkpoint?: "step";
  },
  run: WorkflowRunFn<unknown, unknown, THooks>,
): WorkflowDefinition<
  unknown,
  unknown,
  StandardSchemaV1 | undefined,
  StandardSchemaV1 | undefined,
  TName,
  THooks
> {
  return { ...options, run };
}

export function defineRemoteWorkflow<TName extends string, TParams = unknown, TOutput = unknown>(
  options: {
    name: TName;
    schema?: undefined;
    outputSchema?: undefined;
    checkpoint?: "step";
  },
  run: RemoteWorkflowRunFn<TParams, TOutput>,
): WorkflowDefinition<TParams, TOutput, undefined, undefined, TName> & { remote: true };
export function defineRemoteWorkflow<
  TName extends string,
  TInputSchema extends StandardSchemaV1,
  TOutput = unknown,
>(
  options: {
    name: TName;
    schema: TInputSchema;
    outputSchema?: undefined;
    checkpoint?: "step";
  },
  run: RemoteWorkflowRunFn<StandardSchemaV1.InferOutput<TInputSchema>, TOutput>,
): WorkflowDefinition<
  StandardSchemaV1.InferOutput<TInputSchema>,
  TOutput,
  TInputSchema,
  undefined,
  TName
> & { remote: true };
export function defineRemoteWorkflow<
  TName extends string,
  TOutputSchema extends StandardSchemaV1,
  TParams = unknown,
>(
  options: {
    name: TName;
    schema?: undefined;
    outputSchema: TOutputSchema;
    checkpoint?: "step";
  },
  run: RemoteWorkflowRunFn<TParams, StandardSchemaV1.InferOutput<TOutputSchema>>,
): WorkflowDefinition<
  TParams,
  StandardSchemaV1.InferOutput<TOutputSchema>,
  undefined,
  TOutputSchema,
  TName
> & { remote: true };
export function defineRemoteWorkflow<
  TName extends string,
  TInputSchema extends StandardSchemaV1,
  TOutputSchema extends StandardSchemaV1,
>(
  options: {
    name: TName;
    schema: TInputSchema;
    outputSchema: TOutputSchema;
    checkpoint?: "step";
  },
  run: RemoteWorkflowRunFn<
    StandardSchemaV1.InferOutput<TInputSchema>,
    StandardSchemaV1.InferOutput<TOutputSchema>
  >,
): WorkflowDefinition<
  StandardSchemaV1.InferOutput<TInputSchema>,
  StandardSchemaV1.InferOutput<TOutputSchema>,
  TInputSchema,
  TOutputSchema,
  TName
> & { remote: true };
export function defineRemoteWorkflow<TName extends string>(
  options: {
    name: TName;
    schema?: StandardSchemaV1;
    outputSchema?: StandardSchemaV1;
    checkpoint?: "step";
  },
  run: RemoteWorkflowRunFn,
): WorkflowDefinition<
  unknown,
  unknown,
  StandardSchemaV1 | undefined,
  StandardSchemaV1 | undefined,
  TName
> & { remote: true } {
  return {
    ...options,
    remote: true,
    run: async (event, step) => await run(event, getRemoteWorkflowStepHost(step)),
  };
}

/** Workflow registry entry (function-based). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WorkflowRegistryEntry = WorkflowDefinition<any, any, any, any, string, any>;

export type WorkflowParamsFromEntry<TEntry> =
  TEntry extends WorkflowDefinition<
    infer TParams,
    infer _TOutput,
    infer _TInputSchema,
    infer _TOutputSchema,
    infer _TName,
    infer _THooks
  >
    ? TParams
    : unknown;

export type WorkflowOutputFromEntry<TEntry> =
  TEntry extends WorkflowDefinition<
    infer _TParams,
    infer TOutput,
    infer _TInputSchema,
    infer _TOutputSchema,
    infer _TName,
    infer _THooks
  >
    ? TOutput
    : unknown;

export type WorkflowNameFromEntry<TEntry> =
  TEntry extends WorkflowDefinition<
    infer _TParams,
    infer _TOutput,
    infer _TInputSchema,
    infer _TOutputSchema,
    infer TName,
    infer _THooks
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

/** A configured workflow name could not be resolved. */
export class WorkflowNotFoundError extends Error {
  readonly code = "WORKFLOW_NOT_FOUND";

  constructor(readonly workflowName: string) {
    super("WORKFLOW_NOT_FOUND");
    this.name = "WorkflowNotFoundError";
  }
}

/** Workflow parameters failed the workflow's runtime schema. */
export class WorkflowParamsInvalidError extends Error {
  readonly code = "WORKFLOW_PARAMS_INVALID";

  constructor(
    readonly workflowName: string,
    readonly issues: unknown,
  ) {
    super("WORKFLOW_PARAMS_INVALID");
    this.name = "WorkflowParamsInvalidError";
  }
}

/** A persisted workflow instance could not be found in its workflow scope. */
export class WorkflowInstanceNotFoundError extends Error {
  readonly code = "INSTANCE_NOT_FOUND";

  constructor(
    readonly workflowName: string,
    readonly instanceId: string,
  ) {
    super("INSTANCE_NOT_FOUND");
    this.name = "WorkflowInstanceNotFoundError";
  }
}

/** A management retry was requested for an instance that is not errored. */
export class WorkflowInstanceNotErroredError extends Error {
  readonly code = "INSTANCE_NOT_ERRORED";

  constructor(
    readonly workflowName: string,
    readonly instanceId: string,
  ) {
    super("INSTANCE_NOT_ERRORED");
    this.name = "WorkflowInstanceNotErroredError";
  }
}

/** The errored instance does not have one retryable failed top-level step. */
export class WorkflowFailedStepNotRetryableError extends Error {
  readonly code = "FAILED_STEP_NOT_RETRYABLE";

  constructor(
    readonly workflowName: string,
    readonly instanceId: string,
  ) {
    super("FAILED_STEP_NOT_RETRYABLE");
    this.name = "WorkflowFailedStepNotRetryableError";
  }
}

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
  reason: "create" | "event" | "resume" | "retry" | "wake";
};

export type WorkflowStepEmissionsCleanupHookPayload = {
  workflowName: string;
  instanceId: string;
  instanceRef: string;
  stepKey: string;
  epoch: string;
};

export type WorkflowRestartedHookPayload = {
  workflowName: string;
  instanceId: string;
  instanceRef: string;
  previousRunGeneration: number;
  runGeneration: number;
};

export type WorkflowTerminalHookPayload = {
  workflowName: string;
  instanceId: string;
  instanceRef: string;
  runGeneration: number;
  status: "complete" | "errored" | "terminated";
  params: unknown;
  output?: unknown;
  error?: {
    name: string;
    message: string;
  };
};

export type WorkflowsHooks = {
  onWorkflowEnqueued: (payload: WorkflowEnqueuedHookPayload) => void | Promise<void>;
  onWorkflowRestarted: (payload: WorkflowRestartedHookPayload) => void | Promise<void>;
  onWorkflowTerminal: (payload: WorkflowTerminalHookPayload) => void | Promise<void>;
  onWorkflowStepEmissionsCleanup: (
    payload: WorkflowStepEmissionsCleanupHookPayload,
  ) => void | Promise<void>;
};

/** Dispatcher interface used by durable hooks to trigger runner work. */
export interface WorkflowsDispatcher {
  wake: (payload: WorkflowEnqueuedHookPayload) => Promise<void> | void;
}

/** Actions available on workflow instances. */
export type WorkflowManagementAction = "pause" | "resume" | "restart" | "terminate";

/** Configuration for the workflows fragment. */
export interface WorkflowsFragmentConfig<TRegistry extends WorkflowsRegistry = WorkflowsRegistry> {
  workflows?: TRegistry;
  dispatcher?: WorkflowsDispatcher;
  onWorkflowRestarted?: (payload: WorkflowRestartedHookPayload) => void | Promise<void>;
  onWorkflowTerminal?: (payload: WorkflowTerminalHookPayload) => void | Promise<void>;
  /**
   * Disable built-in durable hook ticking (useful for tests that drive ticks manually).
   * Defaults to true.
   */
  autoTickHooks?: boolean;
  /**
   * Optional logging config for internal workflows diagnostics.
   */
  logging?: WorkflowsLoggerConfig;
  stepEmissions?: WorkflowStepLivePumpRegistry;
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
