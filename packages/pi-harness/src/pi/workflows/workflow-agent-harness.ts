import type {
  WorkflowStepEmission,
  WorkflowStepEventHandler,
  WorkflowStepTx,
} from "@fragno-dev/workflows/workflow";

import {
  type AgentHarness,
  type AgentHarnessOptions,
  type AgentHarnessTool,
  type AgentMessage,
  type CompactionPreparation,
  type PromptTemplate,
  type SessionMetadata,
  type SessionTreeEntry,
  type Skill,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import { Session } from "@earendil-works/pi-agent-core";
import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";

import {
  PiHarnessEventEncoder,
  type PiHarnessEncodedEventEmission,
  type PiHarnessSubscribedEvent,
} from "../harness/agent-harness-event-protocol";
import {
  createWorkflowBackedSessionEntryIdAllocator,
  nextWorkflowBackedSessionEntryIndex,
  sessionEntriesLeafId,
  WorkflowBackedSessionStorage,
} from "../harness/session-storage";

export type PiHarnessOperation =
  | { kind: "prompt"; args: Parameters<AgentHarness["prompt"]>; stopOnTools?: readonly string[] }
  | { kind: "skill"; args: Parameters<AgentHarness["skill"]> }
  | { kind: "promptFromTemplate"; args: Parameters<AgentHarness["promptFromTemplate"]> }
  | { kind: "compact"; args: Parameters<AgentHarness["compact"]> }
  | { kind: "navigateTree"; args: Parameters<AgentHarness["navigateTree"]> };

export type PiHarnessStepResult = {
  type: "harness-run";
  appendedEntries: SessionTreeEntry[];
  leafId: string | null;
};

export type PiHarnessSessionEntryEmission = {
  kind: "harness-session-entry";
  entry: SessionTreeEntry;
};

export type PiHarnessOperationStartEmission = {
  kind: "harness-operation-start";
  operationId: string;
  replay: {
    protocol: "pi-harness-operation";
    version: 1;
  };
};

export type PiHarnessOperationCompleteEmission<TResult = PiHarnessStepResult> = {
  kind: "harness-operation-complete";
  operationId: string;
  result: TResult;
};

export type PiHarnessEmission<TResult = PiHarnessStepResult> =
  | PiHarnessSessionEntryEmission
  | PiHarnessEncodedEventEmission
  | PiHarnessOperationStartEmission
  | PiHarnessOperationCompleteEmission<TResult>;

export type WorkflowAgentHarnessOptions<
  TContext extends object | undefined = undefined,
  TSkill extends Skill = Skill,
  TPromptTemplate extends PromptTemplate = PromptTemplate,
  TTool extends AgentHarnessTool<TContext> = AgentHarnessTool<TContext>,
> = Omit<AgentHarnessOptions<TContext, TSkill, TPromptTemplate, TTool>, "session">;

export type PiHarnessSessionStepState = {
  metadata: SessionMetadata;
  entries: readonly SessionTreeEntry[];
  checkpointedEntryCount: number;
};

export type CreatePiHarnessSessionStateOptions = {
  metadata: SessionMetadata;
  /** Messages must carry timestamps created outside workflow replay. */
  initialMessages?: readonly AgentMessage[];
};

const createInitialMessageEntries = (
  messages: readonly AgentMessage[] | undefined,
): SessionTreeEntry[] => {
  if (!messages) {
    return [];
  }

  let parentId: string | null = null;
  return messages.map((message, index) => {
    const id = `initial-${index}`;
    const entry: SessionTreeEntry = {
      type: "message",
      id,
      parentId,
      timestamp: new Date(message.timestamp).toISOString(),
      message: structuredClone(message),
    };
    parentId = id;
    return entry;
  });
};

export const createPiHarnessSessionState = (
  options: CreatePiHarnessSessionStateOptions,
): PiHarnessSessionStepState => ({
  metadata: { ...options.metadata },
  entries: createInitialMessageEntries(options.initialMessages),
  checkpointedEntryCount: 0,
});

/**
 * Restore one runner-selected attempt from emissions in persisted order. Session entries are an
 * immutable append log; repeated IDs or mixed attempt identities are corruption.
 */

type AppendEntryListener = (entry: SessionTreeEntry) => void | Promise<void>;

type WorkflowAgentHarnessEmission = PiHarnessEmission<WorkflowAgentHarnessStepResult>;

type TrustedWorkflowAgentHarnessEmission = WorkflowStepEmission<WorkflowAgentHarnessEmission>;

/** Starts an AgentHarness operation when the selected workflow attempt has no prior journal. */
type ExecuteWorkflowAgentHarnessRecovery = { readonly kind: "execute" };

/** Checkpoints durable transcript progress from an interrupted workflow attempt without rerunning it. */
type InterruptedWorkflowAgentHarnessRecovery = {
  readonly kind: "interrupted";
  readonly transcript: InterruptedTranscript;
  readonly replayedEntries: readonly SessionTreeEntry[];
};

/** Replays a finished AgentHarness operation whose entries and result were emitted before the process died, but whose workflow step had not committed. */
type CompletedWorkflowAgentHarnessRecovery = {
  readonly kind: "completed";
  readonly result: WorkflowAgentHarnessStepResult;
};

/** Tells withWorkflowAgentHarness whether to run, recover, or replay the operation. */
type WorkflowAgentHarnessRecovery =
  | ExecuteWorkflowAgentHarnessRecovery
  | InterruptedWorkflowAgentHarnessRecovery
  | CompletedWorkflowAgentHarnessRecovery;

type WorkflowAgentHarnessStorageMetadata = {
  readonly operationId: string;
  readonly operationEntryStart: number;
  readonly checkpointEntryStart: number;
  readonly recovery: WorkflowAgentHarnessRecovery;
};

export type RestoredWorkflowAgentHarnessOptions = Pick<AgentHarnessOptions, "session"> &
  Partial<Pick<AgentHarnessOptions, "model" | "thinkingLevel" | "activeToolNames">>;

export type RestoredWorkflowBackedSession = WorkflowAgentHarnessStorageMetadata & {
  session: Session;
  storage: WorkflowBackedSessionStorage;
  options: RestoredWorkflowAgentHarnessOptions;
  subscribeToAppendedEntries: (listener: AppendEntryListener) => () => void;
};

type RestoreWorkflowBackedSessionOptions = {
  operationId: string;
  state: PiHarnessSessionStepState;
  previousEmissions: readonly WorkflowStepEmission[];
  models: AgentHarnessOptions["models"];
};

type HarnessAttempt = {
  started: boolean;
  sessionEntries: SessionTreeEntry[];
  completion: WorkflowAgentHarnessStepResult | undefined;
};

const harnessEmissionKinds = new Set<WorkflowAgentHarnessEmission["kind"]>([
  "harness-operation-start",
  "harness-session-entry",
  "harness-event",
  "harness-operation-complete",
]);

const readHarnessAttempt = (
  emissions: readonly WorkflowStepEmission[],
  operationId: string,
): HarnessAttempt => {
  let attemptIdentity: string | undefined;
  let started = false;
  let completion: WorkflowAgentHarnessStepResult | undefined;
  const sessionEntries: SessionTreeEntry[] = [];

  for (const emission of emissions) {
    const kind = (emission.payload as { kind?: WorkflowAgentHarnessEmission["kind"] } | null)?.kind;
    if (emission.actor !== "user" || !kind || !harnessEmissionKinds.has(kind)) {
      continue;
    }

    const identity = `${emission.executionId}\0${emission.epoch}`;
    if (attemptIdentity !== undefined && attemptIdentity !== identity) {
      throw new Error("WORKFLOW_AGENT_HARNESS_ATTEMPT_IDENTITY_MISMATCH");
    }
    attemptIdentity = identity;
    if (completion) {
      throw new Error("WORKFLOW_AGENT_HARNESS_EMISSION_AFTER_OPERATION_COMPLETE");
    }

    const harnessEmission = emission as TrustedWorkflowAgentHarnessEmission;
    if (harnessEmission.payload.kind !== "harness-operation-start" && !started) {
      throw new Error("WORKFLOW_AGENT_HARNESS_EMISSION_BEFORE_OPERATION_START");
    }

    switch (harnessEmission.payload.kind) {
      case "harness-operation-start":
        if (started) {
          throw new Error("WORKFLOW_AGENT_HARNESS_DUPLICATE_OPERATION_START");
        }
        started = true;
        break;
      case "harness-session-entry":
        sessionEntries.push(harnessEmission.payload.entry);
        break;
      case "harness-event":
        break;
      case "harness-operation-complete":
        completion = harnessEmission.payload.result;
        break;
    }

    if (
      "operationId" in harnessEmission.payload &&
      harnessEmission.payload.operationId !== operationId
    ) {
      throw new Error("WORKFLOW_AGENT_HARNESS_OPERATION_ID_MISMATCH");
    }
  }

  return { started, sessionEntries, completion };
};

const appendUniqueSessionEntries = (
  entries: readonly SessionTreeEntry[],
  appendedEntries: readonly SessionTreeEntry[],
): SessionTreeEntry[] => {
  const entryIds = new Set(entries.map((entry) => entry.id));
  if (entryIds.size !== entries.length) {
    throw new Error("WORKFLOW_AGENT_HARNESS_DUPLICATE_SESSION_ENTRY");
  }
  for (const entry of appendedEntries) {
    if (entryIds.has(entry.id)) {
      throw new Error(`WORKFLOW_AGENT_HARNESS_DUPLICATE_SESSION_ENTRY:${entry.id}`);
    }
    if (entry.parentId !== null && !entryIds.has(entry.parentId)) {
      throw new Error(`WORKFLOW_AGENT_HARNESS_UNKNOWN_PARENT_ENTRY:${entry.parentId}`);
    }
    entryIds.add(entry.id);
  }
  return [...entries, ...appendedEntries];
};

type InterruptedTranscript = {
  recoverableLeafId: string | null;
  missingToolCalls: ToolCall[];
};

/** Finds the last replay-safe leaf and unfinished tool calls in an interrupted operation branch. */
function analyzeInterruptedTranscript(
  baseLeafId: string | null,
  activeOperationBranch: readonly SessionTreeEntry[],
): InterruptedTranscript {
  let recoverableLeafId = baseLeafId;
  let openToolCalls: ToolCall[] | undefined;
  let completedToolCallIds = new Set<string>();

  for (const entry of activeOperationBranch) {
    if (entry.type !== "message") {
      if (!openToolCalls) {
        recoverableLeafId = entry.type === "leaf" ? entry.targetId : entry.id;
      }
      continue;
    }

    const message = entry.message;
    if (message.role === "user") {
      if (openToolCalls) {
        return {
          recoverableLeafId,
          missingToolCalls: openToolCalls.filter(
            (toolCall) => !completedToolCallIds.has(toolCall.id),
          ),
        };
      }
      recoverableLeafId = entry.id;
      continue;
    }

    if (message.role === "assistant") {
      if (openToolCalls) {
        return {
          recoverableLeafId,
          missingToolCalls: openToolCalls.filter(
            (toolCall) => !completedToolCallIds.has(toolCall.id),
          ),
        };
      }
      const toolCalls = message.content.filter(
        (content): content is ToolCall => content.type === "toolCall",
      );
      if (message.stopReason !== "toolUse" || toolCalls.length === 0) {
        return { recoverableLeafId, missingToolCalls: [] };
      }
      openToolCalls = toolCalls;
      completedToolCallIds = new Set<string>();
      recoverableLeafId = entry.id;
      continue;
    }

    if (message.role !== "toolResult") {
      return {
        recoverableLeafId,
        missingToolCalls:
          openToolCalls?.filter((toolCall) => !completedToolCallIds.has(toolCall.id)) ?? [],
      };
    }
    const toolCallId = message.toolCallId;
    if (
      !openToolCalls?.some((toolCall) => toolCall.id === toolCallId) ||
      completedToolCallIds.has(toolCallId)
    ) {
      return {
        recoverableLeafId,
        missingToolCalls:
          openToolCalls?.filter((toolCall) => !completedToolCallIds.has(toolCall.id)) ?? [],
      };
    }

    completedToolCallIds.add(toolCallId);
    recoverableLeafId = entry.id;
    if (completedToolCallIds.size === openToolCalls.length) {
      openToolCalls = undefined;
      completedToolCallIds = new Set<string>();
    }
  }

  return {
    recoverableLeafId,
    missingToolCalls:
      openToolCalls?.filter((toolCall) => !completedToolCallIds.has(toolCall.id)) ?? [],
  };
}

const assertCheckpointBoundary = (state: PiHarnessSessionStepState): void => {
  if (
    !Number.isSafeInteger(state.checkpointedEntryCount) ||
    state.checkpointedEntryCount < 0 ||
    state.checkpointedEntryCount > state.entries.length
  ) {
    throw new Error(
      `WORKFLOW_AGENT_HARNESS_INVALID_CHECKPOINT_BOUNDARY:${state.checkpointedEntryCount}:${state.entries.length}`,
    );
  }
};

const thinkingLevels = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

const restoredThinkingLevel = (value: string): ThinkingLevel => {
  if (!thinkingLevels.has(value as ThinkingLevel)) {
    throw new Error(`WORKFLOW_AGENT_HARNESS_UNKNOWN_THINKING_LEVEL:${value}`);
  }
  return value as ThinkingLevel;
};

const sessionEntriesToRoot = (
  entries: readonly SessionTreeEntry[],
  leafId: string | null,
): SessionTreeEntry[] => {
  if (leafId === null) {
    return [];
  }

  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  const branch: SessionTreeEntry[] = [];
  let entry = entriesById.get(leafId);
  if (!entry) {
    throw new Error(`WORKFLOW_AGENT_HARNESS_UNKNOWN_LEAF:${leafId}`);
  }

  while (entry) {
    branch.unshift(entry);
    if (entry.parentId === null) {
      break;
    }

    const parentId: string = entry.parentId;
    entry = entriesById.get(parentId);
    if (!entry) {
      throw new Error(`WORKFLOW_AGENT_HARNESS_UNKNOWN_PARENT_ENTRY:${parentId}`);
    }
  }

  return branch;
};

const deriveAgentHarnessOptionsFromSessionEntries = (
  session: Session,
  models: AgentHarnessOptions["models"],
  entries: readonly SessionTreeEntry[],
  leafId = sessionEntriesLeafId(entries),
): RestoredWorkflowAgentHarnessOptions => {
  const branchEntries = sessionEntriesToRoot(entries, leafId);
  let modelSelection: { provider: string; modelId: string } | undefined;
  let thinkingLevel: string | undefined;
  let activeToolNames: string[] | undefined;

  for (const entry of branchEntries) {
    if (entry.type === "model_change") {
      modelSelection = { provider: entry.provider, modelId: entry.modelId };
    } else if (entry.type === "message" && entry.message.role === "assistant") {
      modelSelection = { provider: entry.message.provider, modelId: entry.message.model };
    } else if (entry.type === "thinking_level_change") {
      thinkingLevel = entry.thinkingLevel;
    } else if (entry.type === "active_tools_change") {
      activeToolNames = [...entry.activeToolNames];
    }
  }

  const model = modelSelection
    ? models.getModel(modelSelection.provider, modelSelection.modelId)
    : undefined;
  if (modelSelection && !model) {
    throw new Error(
      `WORKFLOW_AGENT_HARNESS_MODEL_NOT_AVAILABLE:${modelSelection.provider}:${modelSelection.modelId}`,
    );
  }

  return {
    session,
    ...(model ? { model } : {}),
    ...(thinkingLevel !== undefined ? { thinkingLevel: restoredThinkingLevel(thinkingLevel) } : {}),
    ...(activeToolNames !== undefined ? { activeToolNames } : {}),
  };
};

export const restoreWorkflowBackedSession = (
  options: RestoreWorkflowBackedSessionOptions,
): RestoredWorkflowBackedSession => {
  assertCheckpointBoundary(options.state);

  const attempt = readHarnessAttempt(options.previousEmissions, options.operationId);
  const operationEntryStart = options.state.entries.length;
  const checkpointEntryStart = options.state.checkpointedEntryCount;
  const storageEntries = appendUniqueSessionEntries(options.state.entries, attempt.sessionEntries);
  let recovery: WorkflowAgentHarnessRecovery = { kind: "execute" };

  if (attempt.completion !== undefined) {
    recovery = { kind: "completed", result: attempt.completion };
  } else if (attempt.started) {
    const operationEntryIds = new Set(attempt.sessionEntries.map((entry) => entry.id));
    const activeOperationBranch = sessionEntriesToRoot(
      storageEntries,
      sessionEntriesLeafId(storageEntries),
    ).filter((entry) => operationEntryIds.has(entry.id));
    recovery = {
      kind: "interrupted",
      transcript: analyzeInterruptedTranscript(
        sessionEntriesLeafId(options.state.entries),
        activeOperationBranch,
      ),
      replayedEntries: attempt.sessionEntries,
    };
  }

  const appendEntryListeners = new Set<AppendEntryListener>();
  const entryIdPrefix = `${options.operationId}:entry`;
  const storage = new WorkflowBackedSessionStorage({
    metadata: { ...options.state.metadata },
    entries: storageEntries,
    entryIds: createWorkflowBackedSessionEntryIdAllocator({
      prefix: entryIdPrefix,
      startIndex: nextWorkflowBackedSessionEntryIndex({
        prefix: entryIdPrefix,
        entries: storageEntries,
      }),
    }),
    onAppendEntry: async (entry) => {
      await Promise.all(
        [...appendEntryListeners].map((listener) => Promise.resolve(listener(entry))),
      );
    },
  });

  const session = new Session(storage);

  return {
    session,
    storage,
    operationId: options.operationId,
    operationEntryStart,
    checkpointEntryStart,
    recovery,
    subscribeToAppendedEntries: (listener) => {
      appendEntryListeners.add(listener);
      return () => {
        appendEntryListeners.delete(listener);
      };
    },
    options: deriveAgentHarnessOptionsFromSessionEntries(
      session,
      options.models,
      storageEntries,
      recovery.kind === "interrupted"
        ? recovery.transcript.recoverableLeafId
        : sessionEntriesLeafId(storageEntries),
    ),
  };
};

/**
 * Execute a fresh invocation, replay a completed result, or checkpoint interrupted progress as
 * aborted. Recovery never calls runDurableStep and never re-executes provider or tool work.
 */

type WorkflowAgentHarnessStepResultBase = Pick<
  PiHarnessStepResult,
  "type" | "appendedEntries" | "leafId"
>;

export type WorkflowAgentHarnessStepResult<TResult = unknown> = WorkflowAgentHarnessStepResultBase &
  ({ readonly outcome: "completed"; readonly value: TResult } | { readonly outcome: "aborted" });

export type WorkflowAgentHarnessTerminalOutcome<TResult = unknown> = {
  operationId: string;
  operationEntries: readonly SessionTreeEntry[];
  result: WorkflowAgentHarnessStepResult<TResult>;
};

export type WorkflowAgentHarnessOnLiveEvent = <TPayload = unknown>(
  type: string,
  handler: WorkflowStepEventHandler<TPayload>,
) => void;

type WorkflowAgentHarnessTerminalOptions<TResult> = {
  /** Persist terminal provider errors as completed operations instead of failing the workflow step. */
  checkpointTerminalAssistantError?: boolean;
  /** May run more than once before the enclosing workflow step commits. */
  onTerminalOutcome?: (
    outcome: WorkflowAgentHarnessTerminalOutcome<TResult>,
  ) => Promise<void> | void;
};

export type WithWorkflowAgentHarnessOptions<TResult = unknown> =
  WorkflowAgentHarnessTerminalOptions<TResult> & {
    restored: RestoredWorkflowBackedSession;
    harness: AgentHarness;
    tx: WorkflowAgentHarnessExecutionTx;
    observeLiveEvents?: (onLiveEvent: WorkflowAgentHarnessOnLiveEvent) => void;
    runDurableStep: () => Promise<TResult>;
  };

type WorkflowAgentHarnessExecutionTx = Pick<WorkflowStepTx, "emit" | "onEvent">;

const latestAssistantMessage = (
  entries: readonly SessionTreeEntry[],
): Extract<AgentMessage, { role: "assistant" }> | undefined => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type === "message" && entry.message.role === "assistant") {
      return entry.message;
    }
  }

  return undefined;
};

const assertTerminalAssistantSucceeded = (entries: readonly SessionTreeEntry[]): void => {
  const assistantMessage = latestAssistantMessage(entries);
  if (assistantMessage?.stopReason !== "error") {
    return;
  }

  throw new Error(
    assistantMessage.errorMessage
      ? `Pi harness agent stream failed: ${assistantMessage.errorMessage}`
      : "Pi harness agent stream failed.",
  );
};

const createInterruptedToolResult = (toolCall: ToolCall): ToolResultMessage => ({
  role: "toolResult",
  toolCallId: toolCall.id,
  toolName: toolCall.name,
  content: [{ type: "text", text: "Tool execution interrupted before completion." }],
  isError: true,
  timestamp: Date.now(),
});

const appendInterruptedToolResults = (
  session: Session,
  toolCalls: readonly ToolCall[],
): Promise<unknown> =>
  toolCalls.reduce<Promise<unknown>>(
    (previousAppend, toolCall) =>
      previousAppend.then(() => session.appendMessage(createInterruptedToolResult(toolCall))),
    Promise.resolve(),
  );

export const hasSummarizableCompactionHistory = (preparation: CompactionPreparation): boolean =>
  preparation.messagesToSummarize.length > 0 || preparation.turnPrefixMessages.length > 0;

export const withWorkflowAgentHarness = async <TResult>({
  restored,
  harness,
  tx,
  observeLiveEvents,
  runDurableStep,
  checkpointTerminalAssistantError = false,
  onTerminalOutcome,
}: WithWorkflowAgentHarnessOptions<TResult>): Promise<WorkflowAgentHarnessStepResult<TResult>> => {
  const {
    session,
    storage,
    operationId,
    operationEntryStart,
    checkpointEntryStart,
    recovery,
    subscribeToAppendedEntries,
  } = restored;

  if (recovery.kind === "completed") {
    const result = recovery.result as WorkflowAgentHarnessStepResult<TResult>;
    const operationEntries = (await storage.getEntries()).slice(operationEntryStart);
    await onTerminalOutcome?.({ operationId, operationEntries, result });
    if (!checkpointTerminalAssistantError) {
      assertTerminalAssistantSucceeded(operationEntries);
    }
    return result;
  }

  const unsubscribeEntries = subscribeToAppendedEntries((entry) => {
    tx.emit({ kind: "harness-session-entry", entry } satisfies WorkflowAgentHarnessEmission);
  });
  let unsubscribeHarness = () => {};
  const emitOperationStart = () => {
    tx.emit({
      kind: "harness-operation-start",
      operationId,
      replay: { protocol: "pi-harness-operation", version: 1 },
    } satisfies WorkflowAgentHarnessEmission);
  };

  try {
    if (recovery.kind === "interrupted") {
      emitOperationStart();
      // Workflows replays only the selected attempt epoch. Carry these entries forward before the
      // first await so another interruption can restore the transcript from this epoch alone.
      for (const entry of recovery.replayedEntries) {
        tx.emit({ kind: "harness-session-entry", entry } satisfies WorkflowAgentHarnessEmission);
      }
      if ((await storage.getLeafId()) !== recovery.transcript.recoverableLeafId) {
        await session.moveTo(recovery.transcript.recoverableLeafId);
      }

      await appendInterruptedToolResults(session, recovery.transcript.missingToolCalls);

      const entries = await storage.getEntries();
      const result = {
        type: "harness-run",
        outcome: "aborted",
        appendedEntries: entries.slice(checkpointEntryStart),
        leafId: await storage.getLeafId(),
      } satisfies WorkflowAgentHarnessStepResult<TResult>;
      const operationEntries = entries.slice(operationEntryStart);

      await onTerminalOutcome?.({ operationId, operationEntries, result });

      tx.emit({
        kind: "harness-operation-complete",
        operationId,
        result,
      } satisfies WorkflowAgentHarnessEmission);

      return result;
    }

    const eventEncoder = new PiHarnessEventEncoder();
    unsubscribeHarness = harness.subscribe((event) => {
      tx.emit({
        kind: "harness-event",
        event: eventEncoder.encode(event as PiHarnessSubscribedEvent),
      } satisfies PiHarnessEncodedEventEmission);
    });
    emitOperationStart();

    const activeEventHandlers = new Set<Promise<void>>();
    const eventHandlerErrors: Error[] = [];
    const unsubscribeLiveEvents: Array<() => void> = [];
    let liveEventObservationOpen = true;
    let liveEventDeliveriesOpen = false;

    const trackEventHandler = (handling: Promise<void>): Promise<void> => {
      activeEventHandlers.add(handling);
      void handling
        .catch((error: unknown) => {
          eventHandlerErrors.push(
            error instanceof Error
              ? error
              : new Error("Workflow AgentHarness event handler failed.", { cause: error }),
          );
        })
        .finally(() => {
          activeEventHandlers.delete(handling);
        });
      return handling;
    };

    const onLiveEvent: WorkflowAgentHarnessOnLiveEvent = (type, handler) => {
      if (!liveEventObservationOpen) {
        throw new Error("WORKFLOW_AGENT_HARNESS_LIVE_EVENT_OBSERVATION_CLOSED");
      }

      unsubscribeLiveEvents.push(
        tx.onEvent(type, (event) => {
          if (!liveEventDeliveriesOpen) {
            return Promise.resolve();
          }

          const executeHandler = async () => {
            try {
              await (handler as WorkflowStepEventHandler)(event);
            } catch (error) {
              throw error instanceof Error
                ? error
                : new Error("Workflow AgentHarness event handler failed.", { cause: error });
            }
          };

          return trackEventHandler(executeHandler());
        }),
      );
    };

    let value!: TResult;
    try {
      try {
        observeLiveEvents?.(onLiveEvent);
      } finally {
        liveEventObservationOpen = false;
      }

      // Live-event observation and step execution start in the same synchronous turn, so workflow
      // events cannot reach the shared harness before its direct operation starts.
      liveEventDeliveriesOpen = true;
      value = await runDurableStep();
    } finally {
      liveEventObservationOpen = false;
      liveEventDeliveriesOpen = false;
      for (const unsubscribeLiveEvent of unsubscribeLiveEvents) {
        unsubscribeLiveEvent();
      }
      await Promise.allSettled(activeEventHandlers);
    }
    if (eventHandlerErrors.length > 0) {
      throw eventHandlerErrors[0];
    }

    const entries = await storage.getEntries();
    const operationEntries = entries.slice(operationEntryStart);
    const checkpointEntries = entries.slice(checkpointEntryStart);
    const terminalAssistant = latestAssistantMessage(operationEntries);
    const result: WorkflowAgentHarnessStepResult<TResult> =
      terminalAssistant?.stopReason === "aborted"
        ? {
            type: "harness-run",
            outcome: "aborted",
            appendedEntries: checkpointEntries,
            leafId: await storage.getLeafId(),
          }
        : {
            type: "harness-run",
            outcome: "completed",
            value,
            appendedEntries: checkpointEntries,
            leafId: await storage.getLeafId(),
          };

    await onTerminalOutcome?.({
      operationId,
      operationEntries,
      result,
    });

    if (!checkpointTerminalAssistantError) {
      assertTerminalAssistantSucceeded(operationEntries);
    }

    tx.emit({
      kind: "harness-operation-complete",
      operationId,
      result,
    } satisfies WorkflowAgentHarnessEmission);

    return result;
  } finally {
    unsubscribeHarness();
    unsubscribeEntries();
  }
};

const sessionEntryPrefixMatches = (
  prefix: readonly SessionTreeEntry[],
  entries: readonly SessionTreeEntry[],
): boolean => {
  if (prefix.length > entries.length) {
    return false;
  }
  for (const [index, entry] of prefix.entries()) {
    if (JSON.stringify(entry) !== JSON.stringify(entries[index])) {
      return false;
    }
  }
  return true;
};

/** Append one completed checkpoint suffix and verify its derived active leaf. */

export const applyWorkflowAgentHarnessStepResult = (
  state: PiHarnessSessionStepState,
  result: Pick<WorkflowAgentHarnessStepResult, "appendedEntries" | "leafId">,
): PiHarnessSessionStepState => {
  assertCheckpointBoundary(state);

  const uncheckpointedEntries = state.entries.slice(state.checkpointedEntryCount);
  const checkpointPrefixMatches = sessionEntryPrefixMatches(
    uncheckpointedEntries,
    result.appendedEntries,
  );
  if (!checkpointPrefixMatches) {
    throw new Error("WORKFLOW_AGENT_HARNESS_CHECKPOINT_PREFIX_MISMATCH");
  }

  const entries = appendUniqueSessionEntries(
    state.entries,
    result.appendedEntries.slice(uncheckpointedEntries.length),
  );
  const leafId = sessionEntriesLeafId(entries);
  if (leafId !== result.leafId) {
    throw new Error("WORKFLOW_AGENT_HARNESS_LEAF_MISMATCH");
  }

  return {
    metadata: { ...state.metadata },
    entries,
    checkpointedEntryCount: entries.length,
  };
};
