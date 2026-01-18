export type WorkflowDuration = string | number;

export type WorkflowEvent<T> = {
  payload: Readonly<T>;
  timestamp: Date;
  instanceId: string;
};

export type WorkflowStepConfig = {
  retries?: {
    limit: number;
    delay: WorkflowDuration;
    backoff?: "constant" | "linear" | "exponential";
  };
  timeout?: WorkflowDuration;
};

export interface WorkflowStep {
  do<T>(name: string, callback: () => Promise<T> | T): Promise<T>;
  do<T>(name: string, config: WorkflowStepConfig, callback: () => Promise<T> | T): Promise<T>;
  sleep(name: string, duration: WorkflowDuration): Promise<void>;
  sleepUntil(name: string, timestamp: Date | number): Promise<void>;
  waitForEvent<T = unknown>(
    name: string,
    options: { type: string; timeout?: WorkflowDuration },
  ): Promise<{ type: string; payload: Readonly<T>; timestamp: Date }>;
}

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

export interface WorkflowInstance {
  id: string;
  status(): Promise<InstanceStatus>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  terminate(): Promise<void>;
  restart(): Promise<void>;
  sendEvent(options: { type: string; payload?: unknown }): Promise<void>;
}

export interface WorkflowInstanceCreateOptions<TParams = unknown> {
  id?: string;
  params?: TParams;
}

export interface WorkflowInstanceCreateOptionsWithId<TParams = unknown>
  extends WorkflowInstanceCreateOptions<TParams> {
  id: string;
}

export interface Workflow<TParams = unknown> {
  create(options?: WorkflowInstanceCreateOptions<TParams>): Promise<WorkflowInstance>;
  createBatch(batch: WorkflowInstanceCreateOptionsWithId<TParams>[]): Promise<WorkflowInstance[]>;
  get(id: string): Promise<WorkflowInstance>;
}

export type WorkflowsRegistry = Record<
  string,
  { name: string; workflow: new (...args: unknown[]) => WorkflowEntrypoint<unknown, unknown> }
>;

export type WorkflowBindings = Record<string, Workflow>;

export abstract class WorkflowEntrypoint<_Env = unknown, Params = unknown> {
  public workflows!: WorkflowBindings;

  abstract run(event: WorkflowEvent<Params>, step: WorkflowStep): Promise<unknown> | unknown;
}

export class NonRetryableError extends Error {
  constructor(message: string, name?: string) {
    super(message);
    this.name = name ?? "NonRetryableError";
  }
}
