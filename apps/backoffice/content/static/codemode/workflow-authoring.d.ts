// ── Workflow helpers ──────────────────────────────────────────────────────
/** Relative duration. Numbers are milliseconds; strings use duration syntax such as "5 minutes", "30s", or "1 day". */
type WorkflowDuration = string | number;

type WorkflowContextScope =
  | { kind: "system" }
  | { kind: "org"; orgId: string }
  | { kind: "user"; userId: string }
  | { kind: "project"; orgId: string; projectId: string };

type WorkflowActorEntity =
  | { scope: "internal"; type: string; id: string }
  | { scope: "external"; source: string; type: string; id: string };

type WorkflowActor<TRole extends "initiator" | "principal" | "delegate" | "assistant"> =
  WorkflowActorEntity & { role: TRole };

type WorkflowActors = Readonly<{
  initiator: WorkflowActor<"initiator">;
  principal: WorkflowActor<"principal"> | null;
  delegation: readonly (WorkflowActor<"delegate"> | WorkflowActor<"assistant">)[];
}>;

type WorkflowEvent<TPayload = Record<string, unknown>> = {
  /** Domain event id. Automation workflows receive the triggering automation event id. */
  id: string;
  scope: WorkflowContextScope;
  source: string;
  eventType: string;
  occurredAt: string;
  payload: Readonly<TPayload>;
  actors: WorkflowActors;
  subject?: ({ orgId?: string; userId?: string } & Record<string, unknown>) | null;
  /** Stable workflow instance creation time across retries and restarts. */
  timestamp: Date;
  instanceId: string;
};

type WorkflowStepConfig = {
  retries?: {
    limit: number;
    delay: WorkflowDuration;
    backoff?: "constant" | "linear" | "exponential";
  };
};

type WorkflowStepEmission<TPayload = unknown> = {
  id: string;
  actor: string;
  stepKey: string;
  epoch: string;
  sequence: number;
  payload: TPayload;
  createdAt: Date;
};

type WorkflowStepEvent<TPayload = unknown> = {
  id: string;
  type: string;
  payload: Readonly<TPayload>;
  timestamp: Date;
  consume(): void;
};

type WorkflowStepConsumedEvent<TPayload = unknown> = {
  id: string;
  type: string;
  payload: Readonly<TPayload>;
  timestamp: Date;
};

type WorkflowStepConsumeTx = {
  /** Queue an outbound workflow-authored emission for the step-emission pump to persist. */
  emit(payload: unknown): void;
  /** Emissions for this step that were already persisted before the current attempt started. */
  previousEmissions(): Promise<WorkflowStepEmission[]>;
};

type WorkflowStepTx = WorkflowStepConsumeTx & {
  /** Events durably acknowledged by this step before the current attempt started. */
  previousConsumedEvents<TPayload = unknown>(): Promise<WorkflowStepConsumedEvent<TPayload>[]>;
  /** Observe durable workflow events while this step is active. */
  onEvent<TPayload = unknown>(
    type: string,
    handler: (event: WorkflowStepEvent<TPayload>) => void | Promise<void>,
  ): () => void;
};

type WorkflowAgentTool<TInput = unknown, TResult = unknown> = {
  name: string;
  description: string;
  /** JSON Schema describing the arguments the model must provide. */
  parameters: Record<string, unknown>;
  /** Prompt-local execution. Keep this replay-safe because the enclosing prompt step can retry. */
  execute(toolCallId: string, input: TInput): Promise<TResult> | TResult;
};

declare function defineTool<TInput = unknown, TResult = unknown>(
  definition: WorkflowAgentTool<TInput, TResult>,
): WorkflowAgentTool<TInput, TResult>;

type WorkflowAgentPromptInput<TTools extends readonly WorkflowAgentTool[] = readonly []> = {
  text: string;
  images?: Array<{ type: "image"; data: string; mimeType: string }>;
  /** The complete tool set available to this prompt. Workflow agents inherit no Pi tools. */
  tools?: TTools;
};

type WorkflowAgentToolResult<TResult = unknown> = {
  toolCallId: string;
  toolName: string;
  arguments: unknown;
  result: TResult;
};

type WorkflowAgentPromptResult<TResult = unknown> = {
  text: string;
  stopReason: string;
  leafId: string | null;
  toolResults: WorkflowAgentToolResult<TResult>[];
};

type WorkflowStep = {
  /** Run replay-safe work as a durable workflow step. */
  do<T>(name: string, callback: (tx: WorkflowStepTx) => Promise<T> | T): Promise<T>;
  do<T>(
    name: string,
    config: WorkflowStepConfig,
    callback: (tx: WorkflowStepTx) => Promise<T> | T,
  ): Promise<T>;
  sleep(name: string, duration: WorkflowDuration): Promise<void>;
  sleepUntil(name: string, timestamp: Date | number): Promise<void>;
  waitForEvent<TPayload = unknown>(
    name: string,
    options: {
      type: string;
      timeout?: WorkflowDuration;
      onConsume?: (
        tx: WorkflowStepConsumeTx,
        event: { type: string; payload: Readonly<TPayload>; timestamp: Date },
      ) => Promise<void> | void;
    },
  ): Promise<{ type: string; payload: Readonly<TPayload>; timestamp: Date }>;
  agent: {
    /**
     * Prompt the workflow's durable Pi session using only the tools supplied for this prompt.
     * Await each prompt before starting another prompt against the same session.
     */
    prompt<TTools extends readonly WorkflowAgentTool[]>(
      name: string,
      input: WorkflowAgentPromptInput<TTools>,
    ): Promise<WorkflowAgentPromptResult<Awaited<ReturnType<TTools[number]["execute"]>>>>;
  };
};

type CodemodeWorkflowDefinitionOptions = {
  /** Required remote workflow name used to identify this durable run. */
  name: string;
};

type CodemodeWorkflowRunHandle = {
  instanceId: string;
};

/**
 * Return defineWorkflow(...) from execCodeMode or a codemode automation script to schedule durable
 * workflow execution. The callback runs later with real workflow step controls. Pass the returned
 * instanceId to workflow.getInstance(...) to observe completion across isolated code-mode calls.
 */
declare function defineWorkflow<TPayload = unknown, TOutput = unknown>(
  options: CodemodeWorkflowDefinitionOptions,
  run: (event: WorkflowEvent<TPayload>, step: WorkflowStep) => Promise<TOutput> | TOutput,
): CodemodeWorkflowRunHandle;
