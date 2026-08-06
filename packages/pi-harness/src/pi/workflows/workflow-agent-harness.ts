import type {
  WorkflowStepEmission,
  WorkflowStepEventHandler,
  WorkflowStepTx,
} from "@fragno-dev/workflows/workflow";

import type {
  AgentHarness,
  AgentHarnessEvent,
  AgentHarnessOptions,
  AgentHarnessTool,
  AgentMessage,
  CompactionPreparation,
  PromptTemplate,
  SessionMetadata,
  SessionTreeEntry,
  Skill,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import { Session } from "@earendil-works/pi-agent-core";

import {
  piHarnessMessageUpdateFromPiEvent,
  type PiHarnessMessageUpdateEmission,
} from "../harness/message-update-protocol";
import {
  createWorkflowBackedSessionEntryIdAllocator,
  nextWorkflowBackedSessionEntryIndex,
  sessionEntriesLeafId,
  WorkflowBackedSessionStorage,
  type WorkflowBackedSessionStorageOptions,
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

export type PiHarnessEventEmission = {
  kind: "harness-event";
  event: AgentHarnessEvent;
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
  | PiHarnessEventEmission
  | PiHarnessMessageUpdateEmission
  | PiHarnessOperationStartEmission
  | PiHarnessOperationCompleteEmission<TResult>;

/**
 * Phase 1 — Configure the AgentHarness runtime before defining the workflow
 *
 * The workflow adapter requires no pre-workflow setup. Define reusable models, tools, resources,
 * and other normal AgentHarness dependencies here; do not create workflow-session state yet.
 * Runtime resources are reconstructed with the AgentHarness on every workflow replay rather than
 * serialized into PiHarnessSessionStepState.
 */

export type WorkflowAgentHarnessOptions<
  TContext extends object | undefined = undefined,
  TSkill extends Skill = Skill,
  TPromptTemplate extends PromptTemplate = PromptTemplate,
  TTool extends AgentHarnessTool<TContext> = AgentHarnessTool<TContext>,
> = Omit<AgentHarnessOptions<TContext, TSkill, TPromptTemplate, TTool>, "session">;

/**
 * Phase 2 — Initialize session state inside the workflow callback
 *
 * Before the first durable AgentHarness step, create the base state containing stable Pi session
 * metadata, initial entries, and which entries have already crossed a durable step boundary.
 * Workflow replay recreates this base state before cached step results are reduced into it again.
 */

export type PiHarnessSessionStepState = {
  metadata: SessionMetadata;
  entries: readonly SessionTreeEntry[];
  persistedEntryIds: readonly string[];
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
  persistedEntryIds: [],
});

/**
 * Phase 3 — Restore the Pi Session at the start of each durable step
 *
 * Inside step.do, fold session entries emitted by prior attempts over state committed by earlier
 * steps. Completed invocations replay their checkpoint, interrupted prompt-like invocations move
 * back to the parent of their first emitted user message, and entry allocation continues after the
 * highest deterministic id already observed. The result explicitly exposes the real Session, its
 * workflow-aware storage, and AgentHarness option overrides derived from durable selections.
 */

type AppendEntryListener = NonNullable<WorkflowBackedSessionStorageOptions["onAppendEntry"]>;

type WorkflowAgentHarnessEmission = PiHarnessEmission<WorkflowAgentHarnessStepResult>;

type TrustedWorkflowAgentHarnessEmission = WorkflowStepEmission<WorkflowAgentHarnessEmission>;

export type WorkflowAgentHarnessRecovery =
  | { readonly kind: "execute"; readonly leafIdBeforeInvocation?: string | null }
  | {
      readonly kind: "completed";
      readonly result: WorkflowAgentHarnessStepResult;
      readonly operationEntries: readonly SessionTreeEntry[];
    };

export type WorkflowAgentHarnessStorageMetadata = {
  readonly operationId: string;
  readonly persistedEntryIds: ReadonlySet<string>;
  readonly recovery: WorkflowAgentHarnessRecovery;
};

export type WorkflowAgentHarnessStorageOptions = Omit<
  WorkflowBackedSessionStorageOptions,
  "onAppendEntry"
> & {
  workflowMetadata: WorkflowAgentHarnessStorageMetadata;
};

export class WorkflowAgentHarnessStorage extends WorkflowBackedSessionStorage {
  readonly workflowMetadata: WorkflowAgentHarnessStorageMetadata;
  private readonly appendEntryListeners: Set<AppendEntryListener>;

  constructor(options: WorkflowAgentHarnessStorageOptions) {
    const appendEntryListeners = new Set<AppendEntryListener>();
    super({
      ...options,
      onAppendEntry: async (entry) => {
        await Promise.all(
          [...appendEntryListeners].map((listener) => Promise.resolve(listener(entry))),
        );
      },
    });
    this.appendEntryListeners = appendEntryListeners;
    this.workflowMetadata = {
      ...options.workflowMetadata,
      persistedEntryIds: new Set(options.workflowMetadata.persistedEntryIds),
    };
  }

  subscribeToAppendedEntries(listener: AppendEntryListener): () => void {
    this.appendEntryListeners.add(listener);
    return () => {
      this.appendEntryListeners.delete(listener);
    };
  }
}

export type RestoredWorkflowAgentHarnessOptions = Pick<AgentHarnessOptions, "session"> &
  Partial<Pick<AgentHarnessOptions, "model" | "thinkingLevel" | "activeToolNames">>;

export type RestoredWorkflowBackedSession = {
  session: Session;
  storage: WorkflowAgentHarnessStorage;
  options: RestoredWorkflowAgentHarnessOptions;
};

export type RestoreWorkflowBackedSessionOptions = {
  operationId: string;
  state: PiHarnessSessionStepState;
  previousEmissions: readonly WorkflowStepEmission[];
  models: AgentHarnessOptions["models"];
};

const trustedWorkflowAgentHarnessEmissions = (
  emissions: readonly WorkflowStepEmission[],
): readonly TrustedWorkflowAgentHarnessEmission[] =>
  emissions as readonly TrustedWorkflowAgentHarnessEmission[];

const mergeSessionEntries = (
  committedEntries: readonly SessionTreeEntry[],
  replayedEntries: readonly SessionTreeEntry[],
): SessionTreeEntry[] => {
  const entries = [...committedEntries];
  const entryIndexes = new Map(entries.map((entry, index) => [entry.id, index]));

  for (const entry of replayedEntries) {
    const existingIndex = entryIndexes.get(entry.id);
    if (existingIndex === undefined) {
      entryIndexes.set(entry.id, entries.length);
      entries.push(entry);
    } else {
      entries[existingIndex] = entry;
    }
  }

  return entries;
};

const emittedSessionEntries = (
  emissions: readonly TrustedWorkflowAgentHarnessEmission[],
): SessionTreeEntry[] => {
  const entries: SessionTreeEntry[] = [];
  const seenEntryIds = new Set<string>();

  for (const { payload } of emissions) {
    if (payload.kind !== "harness-session-entry" || seenEntryIds.has(payload.entry.id)) {
      continue;
    }
    seenEntryIds.add(payload.entry.id);
    entries.push(payload.entry);
  }

  return entries;
};

const completedInvocation = (
  emissions: readonly TrustedWorkflowAgentHarnessEmission[],
  operationId: string,
):
  | {
      result: WorkflowAgentHarnessStepResult;
      operationEntries: readonly SessionTreeEntry[];
    }
  | undefined => {
  for (let index = emissions.length - 1; index >= 0; index -= 1) {
    const completion = emissions[index];
    if (
      completion?.payload.kind === "harness-operation-complete" &&
      completion.payload.operationId === operationId
    ) {
      return {
        result: completion.payload.result,
        operationEntries: emittedSessionEntries(
          emissions.filter((emission) => emission.epoch === completion.epoch),
        ),
      };
    }
  }

  return undefined;
};

const rollbackInterruptedPromptToInitialUserMessage = (options: {
  entries: readonly SessionTreeEntry[];
  uncommittedEntries: readonly SessionTreeEntry[];
}): { entries: SessionTreeEntry[]; parentLeafId: string | null } => {
  const initialUserEntry = options.uncommittedEntries.find(
    (entry) => entry.type === "message" && entry.message.role === "user",
  );
  if (!initialUserEntry) {
    throw new Error("WORKFLOW_AGENT_HARNESS_INTERRUPTED_INVOCATION_NOT_REPLAYABLE");
  }

  const initialUserIndex = options.entries.findIndex((entry) => entry.id === initialUserEntry.id);
  if (initialUserIndex === -1) {
    throw new Error("WORKFLOW_AGENT_HARNESS_INTERRUPTED_INVOCATION_NOT_REPLAYABLE");
  }

  return {
    entries: options.entries.slice(0, initialUserIndex + 1),
    parentLeafId: initialUserEntry.parentId,
  };
};

const assertPersistedEntriesBelongToSession = (state: PiHarnessSessionStepState): void => {
  const sessionEntryIds = new Set(state.entries.map((entry) => entry.id));
  for (const persistedEntryId of state.persistedEntryIds) {
    if (!sessionEntryIds.has(persistedEntryId)) {
      throw new Error(`WORKFLOW_AGENT_HARNESS_UNKNOWN_PERSISTED_ENTRY:${persistedEntryId}`);
    }
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

/** @internal */
export const deriveAgentHarnessOptionsFromSessionEntries = (
  session: Session,
  models: AgentHarnessOptions["models"],
  entries: readonly SessionTreeEntry[],
): RestoredWorkflowAgentHarnessOptions => {
  const branchEntries = sessionEntriesToRoot(entries, sessionEntriesLeafId(entries));
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
  assertPersistedEntriesBelongToSession(options.state);

  const previousEmissions = trustedWorkflowAgentHarnessEmissions(options.previousEmissions);
  const replayedEntries = emittedSessionEntries(previousEmissions);
  const persistedEntryIds = new Set(options.state.persistedEntryIds);
  const uncommittedEntries = replayedEntries.filter((entry) => !persistedEntryIds.has(entry.id));
  const completed = completedInvocation(previousEmissions, options.operationId);
  let storageEntries = mergeSessionEntries(options.state.entries, replayedEntries);
  let recovery: WorkflowAgentHarnessRecovery = { kind: "execute" };

  if (completed) {
    recovery = { kind: "completed", ...completed };
  } else if (uncommittedEntries.length > 0) {
    const interruptedPrompt = rollbackInterruptedPromptToInitialUserMessage({
      entries: storageEntries,
      uncommittedEntries,
    });
    storageEntries = interruptedPrompt.entries;
    recovery = { kind: "execute", leafIdBeforeInvocation: interruptedPrompt.parentLeafId };
  }

  const entryIdPrefix = `${options.operationId}:entry`;
  const storage = new WorkflowAgentHarnessStorage({
    metadata: { ...options.state.metadata },
    entries: storageEntries,
    entryIds: createWorkflowBackedSessionEntryIdAllocator({
      prefix: entryIdPrefix,
      startIndex: nextWorkflowBackedSessionEntryIndex({
        prefix: entryIdPrefix,
        entries: replayedEntries,
      }),
    }),
    workflowMetadata: {
      operationId: options.operationId,
      persistedEntryIds,
      recovery,
    },
  });

  const session = new Session(storage);

  return {
    session,
    storage,
    options: deriveAgentHarnessOptionsFromSessionEntries(session, options.models, storageEntries),
  };
};

/**
 * Phase 4 — Execute or replay one AgentHarness invocation inside the durable step
 *
 * Completed checkpoints return without invoking the provider. Otherwise this phase temporarily
 * connects Session appends and AgentHarness events to tx.emit, moves interrupted prompts back to
 * their original parent leaf, and invokes the caller's direct harness method. Terminal outcomes are
 * exposed to an optional observer before failed assistants are rejected and successful callback
 * results are checkpointed. A terminal assistant without a checkpoint is retried because an
 * arbitrary callback may transform the Pi method's return value.
 */

export type WorkflowAgentHarnessStepResult<TResult = unknown> = Pick<
  PiHarnessStepResult,
  "type" | "appendedEntries" | "leafId"
> & {
  value: TResult;
};

export type WorkflowAgentHarnessTerminalOutcome<TResult = unknown> = {
  operationId: string;
  operationEntries: readonly SessionTreeEntry[];
  result: WorkflowAgentHarnessStepResult<TResult>;
};

export type WithWorkflowAgentHarnessOptions<TResult = unknown> = {
  session: Session;
  storage: WorkflowAgentHarnessStorage;
  harness: AgentHarness;
  tx: WorkflowAgentHarnessTx;
  /** Configure observation of workflow events delivered live while the durable step is running. */
  observeLiveEvents?: (onLiveEvent: WorkflowAgentHarnessOnLiveEvent) => void;
  runDurableStep: () => Promise<TResult>;
  /** May run more than once before the enclosing workflow step commits. */
  onTerminalOutcome?: (
    outcome: WorkflowAgentHarnessTerminalOutcome<TResult>,
  ) => Promise<void> | void;
};

export type WorkflowAgentHarnessOnLiveEvent = <TPayload = unknown>(
  type: string,
  handler: WorkflowStepEventHandler<TPayload>,
) => void;

export type WorkflowAgentHarnessTx = Pick<WorkflowStepTx, "emit" | "onEvent">;

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

export const hasSummarizableCompactionHistory = (preparation: CompactionPreparation): boolean =>
  preparation.messagesToSummarize.length > 0 || preparation.turnPrefixMessages.length > 0;

const emissionFromHarnessEvent = (
  event: AgentHarnessEvent,
): PiHarnessEventEmission | PiHarnessMessageUpdateEmission => {
  if (event.type === "message_update") {
    return {
      kind: "harness-message-update",
      update: piHarnessMessageUpdateFromPiEvent(event),
    };
  }

  return { kind: "harness-event", event };
};

export const withWorkflowAgentHarness = async <TResult>({
  session,
  storage,
  harness,
  tx,
  observeLiveEvents,
  runDurableStep,
  onTerminalOutcome,
}: WithWorkflowAgentHarnessOptions<TResult>): Promise<WorkflowAgentHarnessStepResult<TResult>> => {
  const { operationId, persistedEntryIds, recovery } = storage.workflowMetadata;

  if (recovery.kind === "completed") {
    const result = recovery.result as WorkflowAgentHarnessStepResult<TResult>;
    await onTerminalOutcome?.({
      operationId,
      operationEntries: recovery.operationEntries,
      result,
    });
    return result;
  }

  const unsubscribeEntries = storage.subscribeToAppendedEntries((entry) => {
    tx.emit({ kind: "harness-session-entry", entry } satisfies WorkflowAgentHarnessEmission);
  });
  const unsubscribeHarness = harness.subscribe((event) => {
    tx.emit(emissionFromHarnessEvent(event));
  });

  try {
    tx.emit({
      kind: "harness-operation-start",
      operationId,
      replay: { protocol: "pi-harness-operation", version: 1 },
    } satisfies WorkflowAgentHarnessEmission);

    if (recovery.leafIdBeforeInvocation !== undefined) {
      await session.moveTo(recovery.leafIdBeforeInvocation);
    }

    const entryIdsBeforeInvocation = new Set((await storage.getEntries()).map((entry) => entry.id));
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
    const operationEntries = entries.filter((entry) => !entryIdsBeforeInvocation.has(entry.id));
    const result = {
      type: "harness-run",
      value,
      appendedEntries: entries.filter((entry) => !persistedEntryIds.has(entry.id)),
      leafId: await storage.getLeafId(),
    } satisfies WorkflowAgentHarnessStepResult<TResult>;

    await onTerminalOutcome?.({
      operationId,
      operationEntries,
      result,
    });
    assertTerminalAssistantSucceeded(operationEntries);

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

/**
 * Phase 5 — Reduce the completed step result into workflow-local session state
 *
 * After step.do returns, merge its durable entry delta and persisted-entry bookkeeping into the
 * state carried by the workflow callback. The active leaf remains derived from the ordered entries,
 * so state cannot carry a conflicting duplicate leaf value. This phase performs no harness work
 * and emits no progress.
 */

export const applyWorkflowAgentHarnessStepResult = (
  state: PiHarnessSessionStepState,
  result: Pick<WorkflowAgentHarnessStepResult, "appendedEntries" | "leafId">,
): PiHarnessSessionStepState => {
  const entries = mergeSessionEntries(state.entries, result.appendedEntries);
  const persistedEntryIds = new Set(state.persistedEntryIds);
  for (const entry of result.appendedEntries) {
    persistedEntryIds.add(entry.id);
  }

  const leafId = sessionEntriesLeafId(entries);
  if (leafId !== result.leafId) {
    throw new Error("WORKFLOW_AGENT_HARNESS_LEAF_MISMATCH");
  }

  return {
    metadata: { ...state.metadata },
    entries,
    persistedEntryIds: [...persistedEntryIds],
  };
};
