import type { FragnoRuntime } from "@fragno-dev/core";

/** Relative or absolute durations supported by workflow steps. */
export type WorkflowDuration = string | number;

/** Event delivered to a workflow instance run. */
export type WorkflowEvent<T> = {
  payload: Readonly<T>;
  timestamp: Date;
  instanceId: string;
};

/** Retry/timeout behavior for a step execution. */
export type WorkflowStepConfig = {
  retries?: {
    limit: number;
    delay: WorkflowDuration;
    backoff?: "constant" | "linear" | "exponential";
  };
  timeout?: WorkflowDuration;
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

/** Execution helpers that provide replay-safe step semantics. */
export interface WorkflowStep {
  log: WorkflowLogger;
  do<T>(name: string, callback: () => Promise<T> | T): Promise<T>;
  do<T>(name: string, config: WorkflowStepConfig, callback: () => Promise<T> | T): Promise<T>;
  sleep(name: string, duration: WorkflowDuration): Promise<void>;
  sleepUntil(name: string, timestamp: Date | number): Promise<void>;
  waitForEvent<T = unknown>(
    name: string,
    options: { type: string; timeout?: WorkflowDuration },
  ): Promise<{ type: string; payload: Readonly<T>; timestamp: Date }>;
}

/** Serialized instance status returned to API consumers. */
export type InstanceStatus = {
  status:
    | "queued"
    | "running"
    | "paused"
    | "errored"
    | "terminated"
    | "complete"
    | "waiting"
    | "waitingForPause"
    | "unknown";
  error?: { name: string; message: string };
  output?: unknown;
};

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
  pauseRequested: boolean;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  currentStep?: WorkflowInstanceCurrentStep;
};

/** Handle for a workflow instance returned by the management API. */
export interface WorkflowInstance {
  id: string;
  status(): Promise<InstanceStatus>;
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
export interface Workflow<TParams = unknown> {
  create(options?: WorkflowInstanceCreateOptions<TParams>): Promise<WorkflowInstance>;
  createBatch(batch: WorkflowInstanceCreateOptionsWithId<TParams>[]): Promise<WorkflowInstance[]>;
  get(id: string): Promise<WorkflowInstance>;
}

/** Map of binding keys to workflow class definitions. */
export type WorkflowsRegistry = Record<
  string,
  { name: string; workflow: new (...args: unknown[]) => WorkflowEntrypoint<unknown, unknown> }
>;

/** Bound workflow handles exposed on fragments. */
export type WorkflowBindings = Record<string, Workflow>;

/** Base class for user-defined workflows. */
export abstract class WorkflowEntrypoint<_Env = unknown, Params = unknown> {
  public workflows!: WorkflowBindings;

  abstract run(event: WorkflowEvent<Params>, step: WorkflowStep): Promise<unknown> | unknown;
}

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
  reason: "create" | "event" | "resume" | "retry" | "wake";
};

export type WorkflowsHooks = {
  onWorkflowEnqueued: (payload: WorkflowEnqueuedHookPayload) => void | Promise<void>;
};

/** Dispatcher interface used by durable hooks to trigger runner work. */
export interface WorkflowsDispatcher {
  wake: (payload: WorkflowEnqueuedHookPayload) => Promise<void> | void;
}

/** Controls how much work a runner processes per tick. */
export type RunnerTickOptions = {
  maxInstances?: number;
  maxSteps?: number;
};

/** Runner interface used by routes and dispatchers. */
export interface WorkflowsRunner {
  tick: (options?: RunnerTickOptions) => Promise<number> | number;
}

/** Request metadata passed into authorization hooks. */
export type WorkflowsAuthorizeContext = {
  method: string;
  path: string;
  pathParams: Record<string, string>;
  query: URLSearchParams;
  headers: Headers;
  input?: unknown;
};

/** Actions available on workflow instances. */
export type WorkflowManagementAction = "pause" | "resume" | "terminate" | "restart";

/** Authorization hook signature for workflow routes. */
export type WorkflowsAuthorizeHook<TContext extends WorkflowsAuthorizeContext> = (
  context: TContext,
) => Promise<Response | void> | Response | void;

/** Authorization context for instance creation requests. */
export type WorkflowsAuthorizeInstanceCreationContext = WorkflowsAuthorizeContext & {
  workflowName: string;
  instances: { id?: string; params?: unknown }[];
};

/** Authorization context for management actions. */
export type WorkflowsAuthorizeManagementContext = WorkflowsAuthorizeContext & {
  workflowName: string;
  instanceId: string;
  action: WorkflowManagementAction;
};

/** Authorization context for sendEvent requests. */
export type WorkflowsAuthorizeSendEventContext = WorkflowsAuthorizeContext & {
  workflowName: string;
  instanceId: string;
  eventType: string;
  payload?: unknown;
};

/** Authorization context for runner tick requests. */
export type WorkflowsAuthorizeRunnerTickContext = WorkflowsAuthorizeContext & {
  options: RunnerTickOptions;
};

/** Configuration for the workflows fragment. */
export interface WorkflowsFragmentConfig {
  workflows?: WorkflowsRegistry;
  dispatcher?: WorkflowsDispatcher;
  runner?: WorkflowsRunner;
  runtime: FragnoRuntime;
  enableRunnerTick?: boolean;
  authorizeRequest?: WorkflowsAuthorizeHook<WorkflowsAuthorizeContext>;
  authorizeInstanceCreation?: WorkflowsAuthorizeHook<WorkflowsAuthorizeInstanceCreationContext>;
  authorizeManagement?: WorkflowsAuthorizeHook<WorkflowsAuthorizeManagementContext>;
  authorizeSendEvent?: WorkflowsAuthorizeHook<WorkflowsAuthorizeSendEventContext>;
  authorizeRunnerTick?: WorkflowsAuthorizeHook<WorkflowsAuthorizeRunnerTickContext>;
}

const TERMINAL_STATUSES: InstanceStatus["status"][] = ["complete", "terminated", "errored"];
const WAITING_STATUSES: InstanceStatus["status"][] = ["waiting", "waitingForPause"];

export const isTerminalStatus = (status: InstanceStatus["status"]) =>
  TERMINAL_STATUSES.includes(status);

export const isWaitingStatus = (status: InstanceStatus["status"]) =>
  WAITING_STATUSES.includes(status);

export const statusLabel = (status: InstanceStatus["status"]) => {
  const labels: Record<InstanceStatus["status"], string> = {
    queued: "Queued",
    running: "Running",
    paused: "Paused",
    errored: "Errored",
    terminated: "Terminated",
    complete: "Complete",
    waiting: "Waiting",
    waitingForPause: "Waiting For Pause",
    unknown: "Unknown",
  };

  return labels[status] ?? "Unknown";
};

export const currentStepLabel = (step?: WorkflowInstanceCurrentStep | null) => {
  if (!step) {
    return undefined;
  }

  return step.name ? `${step.name} (${step.type})` : step.type;
};
