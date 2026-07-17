import type { WorkflowStep, WorkflowStepEmission } from "@fragno-dev/workflows/workflow";

import {
  AgentHarness,
  Session,
  type AgentHarnessEvent,
  type AgentHarnessOptions,
  type AgentMessage,
  type AgentTool,
  type PromptTemplate,
  type SessionMetadata,
  type SessionTreeEntry,
  type Skill,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";

import { piSchema } from "../../schema";
import type { PiHarnessHooksMap } from "../definition";
import type {
  PiPromptInput,
  PiSessionCommandPayload,
  PiOperationCompletedHookPayload,
} from "../types";
import { registerAgentStreamFn } from "./agent-stream-provider";
import {
  piHarnessMessageUpdateFromPiEvent,
  type PiHarnessMessageUpdateEmission,
} from "./message-update-protocol";
import {
  createWorkflowBackedSessionEntryIdAllocator,
  WorkflowBackedSessionStorage,
} from "./session-storage";

export type PiHarnessOperation =
  | { kind: "prompt"; args: Parameters<AgentHarness["prompt"]>; stopOnTools?: readonly string[] }
  | { kind: "skill"; args: Parameters<AgentHarness["skill"]> }
  | { kind: "promptFromTemplate"; args: Parameters<AgentHarness["promptFromTemplate"]> }
  | { kind: "compact"; args: Parameters<AgentHarness["compact"]> }
  | { kind: "navigateTree"; args: Parameters<AgentHarness["navigateTree"]> };

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
  operation: PiHarnessOperation;
  replay: {
    protocol: "pi-harness-operation";
    version: 1;
  };
};

export type PiHarnessOperationCompleteEmission = {
  kind: "harness-operation-complete";
  operationId: string;
  result: PiHarnessStepResult;
};

export type PiHarnessEmission =
  | PiHarnessSessionEntryEmission
  | PiHarnessEventEmission
  | PiHarnessMessageUpdateEmission
  | PiHarnessOperationStartEmission
  | PiHarnessOperationCompleteEmission;

export type PiHarnessStepResult = {
  type: "harness-run";
  operation: PiHarnessOperation["kind"];
  appendedEntries: SessionTreeEntry[];
  leafId: string | null;
  assistantMessage?: AssistantMessage;
  compactResult?: Awaited<ReturnType<AgentHarness["compact"]>>;
  navigateTreeResult?: Awaited<ReturnType<AgentHarness["navigateTree"]>>;
};

export type PiHarnessAgentOptions<TTool extends AgentTool = AgentTool> = Omit<
  AgentHarnessOptions<Skill, PromptTemplate, TTool>,
  "session"
> & {
  streamFn?: StreamFn;
};

export type PiHarnessInternalOptions = {
  compactMessageUpdateEmissions?: boolean;
};

export type RunPiHarnessStepOptions<TTool extends AgentTool = AgentTool> =
  PiHarnessAgentOptions<TTool> & {
    workflowName: string;
    sessionId: string;
    agentName: string;
    actor?: unknown;
    operation: PiHarnessOperation;
    committedEntries?: readonly SessionTreeEntry[];
    /** Entry IDs already represented by earlier durable step results. */
    persistedEntryIds?: readonly string[];
    internal?: PiHarnessInternalOptions;
  };

export type PiHarnessSessionStepState = {
  entries: SessionTreeEntry[];
  leafId: string | null;
  persistedEntryIds: string[];
};

const leafIdAfterEntry = (entry: SessionTreeEntry): string | null =>
  entry.type === "leaf" ? entry.targetId : entry.id;

const entriesLeafId = (entries: readonly SessionTreeEntry[]): string | null => {
  let leafId: string | null = null;
  for (const entry of entries) {
    leafId = leafIdAfterEntry(entry);
  }
  return leafId;
};

const initialEntriesFromMessages = (
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
      message,
    };
    parentId = id;
    return entry;
  });
};

export const createPiHarnessSessionState = (
  initialMessages?: readonly AgentMessage[],
): PiHarnessSessionStepState => {
  const entries = initialEntriesFromMessages(initialMessages);
  return { entries, leafId: entriesLeafId(entries), persistedEntryIds: [] };
};

const mergeSessionEntries = (
  committedEntries: readonly SessionTreeEntry[] | undefined,
  replayedEntries: readonly SessionTreeEntry[],
): SessionTreeEntry[] => {
  const entries: SessionTreeEntry[] = [];
  const seen = new Set<string>();

  for (const entry of [...(committedEntries ?? []), ...replayedEntries]) {
    if (seen.has(entry.id)) {
      continue;
    }
    seen.add(entry.id);
    entries.push(entry);
  }

  return entries;
};

const previousSessionEntries = (emissions: readonly PiHarnessEmission[]): SessionTreeEntry[] => {
  const entries: SessionTreeEntry[] = [];
  const seen = new Set<string>();

  for (const emission of emissions) {
    if (emission.kind !== "harness-session-entry" || seen.has(emission.entry.id)) {
      continue;
    }
    seen.add(emission.entry.id);
    entries.push(emission.entry);
  }

  return entries;
};

type PreviousOperationComplete = {
  epoch: string;
  result: PiHarnessStepResult;
};

const previousOperationComplete = (
  emissions: readonly WorkflowStepEmission<PiHarnessEmission>[],
  operationId: string,
): PreviousOperationComplete | undefined => {
  for (let i = emissions.length - 1; i >= 0; i -= 1) {
    const emission = emissions[i];
    if (
      emission?.payload.kind === "harness-operation-complete" &&
      emission.payload.operationId === operationId
    ) {
      return { epoch: emission.epoch, result: emission.payload.result };
    }
  }

  return undefined;
};

const previousOperationSessionEntries = (
  emissions: readonly WorkflowStepEmission<PiHarnessEmission>[],
  operationId: string,
  epoch: string,
): SessionTreeEntry[] => {
  let entries: SessionTreeEntry[] | undefined;

  for (const emission of emissions) {
    if (emission.epoch !== epoch) {
      continue;
    }

    const payload = emission.payload;
    if (payload.kind === "harness-operation-start" && payload.operationId === operationId) {
      entries = [];
      continue;
    }
    if (entries && payload.kind === "harness-session-entry") {
      entries.push(payload.entry);
      continue;
    }
    if (payload.kind === "harness-operation-complete" && payload.operationId === operationId) {
      return entries ?? [];
    }
  }

  return entries ?? [];
};

const sessionEntriesNotPersisted = (
  entries: readonly SessionTreeEntry[],
  persistedEntryIds: ReadonlySet<string>,
): SessionTreeEntry[] => entries.filter((entry) => !persistedEntryIds.has(entry.id));

const messageEntries = (entries: readonly SessionTreeEntry[]) =>
  entries.flatMap((entry) => (entry.type === "message" ? [entry] : []));

const completedOperationModelCalls = (
  entries: readonly SessionTreeEntry[],
): PiOperationCompletedHookPayload["modelCalls"] =>
  messageEntries(entries).flatMap(({ message }) => {
    if (message.role !== "assistant") {
      return [];
    }

    return [
      {
        api: message.api,
        provider: message.provider,
        model: message.model,
        ...(message.responseModel ? { responseModel: message.responseModel } : {}),
        ...(message.responseId ? { responseId: message.responseId } : {}),
        usage: {
          ...message.usage,
          cost: { ...message.usage.cost },
        },
        stopReason: message.stopReason,
        timestamp: message.timestamp,
      },
    ];
  });

type OperationCompletedOptions = Pick<
  RunPiHarnessStepOptions,
  "actor" | "workflowName" | "sessionId" | "agentName" | "operation"
>;

const completedOperationPayload = (
  options: OperationCompletedOptions,
  name: string,
  operationId: string,
  operationEntries: readonly SessionTreeEntry[],
): PiOperationCompletedHookPayload => {
  const modelCalls = completedOperationModelCalls(operationEntries);
  if (modelCalls.length === 0) {
    throw new Error(`Completed Pi operation ${operationId} did not contain a model call.`);
  }

  const usage = modelCalls.reduce<AssistantMessage["usage"]>(
    (total, modelCall) => ({
      input: total.input + modelCall.usage.input,
      output: total.output + modelCall.usage.output,
      cacheRead: total.cacheRead + modelCall.usage.cacheRead,
      cacheWrite: total.cacheWrite + modelCall.usage.cacheWrite,
      totalTokens: total.totalTokens + modelCall.usage.totalTokens,
      cost: {
        input: total.cost.input + modelCall.usage.cost.input,
        output: total.cost.output + modelCall.usage.cost.output,
        cacheRead: total.cost.cacheRead + modelCall.usage.cost.cacheRead,
        cacheWrite: total.cost.cacheWrite + modelCall.usage.cost.cacheWrite,
        total: total.cost.total + modelCall.usage.cost.total,
      },
    }),
    {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  );

  return {
    actor: options.actor ?? null,
    workflowName: options.workflowName,
    sessionId: options.sessionId,
    agentName: options.agentName,
    stepName: name,
    operationId,
    operation: options.operation.kind,
    modelCalls,
    usage,
  };
};

const hasToolCalls = (message: AgentMessage): boolean =>
  message.role === "assistant" && message.content.some((content) => content.type === "toolCall");

const isSuccessfulTerminalAssistantMessage = (
  message: AgentMessage | undefined,
): message is AssistantMessage =>
  message?.role === "assistant" &&
  message.stopReason !== "error" &&
  message.stopReason !== "aborted" &&
  !hasToolCalls(message);

const rollbackPromptLikeOperationToInitialPrompt = (options: {
  entries: readonly SessionTreeEntry[];
  uncommittedEntries: readonly SessionTreeEntry[];
}): SessionTreeEntry[] => {
  const initialPromptEntry = options.uncommittedEntries.find(
    (entry) => entry.type === "message" && entry.message.role === "user",
  );
  if (!initialPromptEntry) {
    return [...options.entries];
  }

  const cutoff = options.entries.findIndex((entry) => entry.id === initialPromptEntry.id);
  return cutoff === -1 ? [...options.entries] : options.entries.slice(0, cutoff + 1);
};

const latestMessage = (entries: readonly SessionTreeEntry[]): AgentMessage | undefined =>
  messageEntries(entries).at(-1)?.message;

const latestAssistantMessage = (
  entries: readonly SessionTreeEntry[],
): AssistantMessage | undefined => {
  const message = [...messageEntries(entries)]
    .reverse()
    .find((entry) => entry.message.role === "assistant")?.message;
  return message?.role === "assistant" ? (message as AssistantMessage) : undefined;
};

const isFailedAssistantMessage = (
  message: AgentMessage | AssistantMessage | undefined,
): message is AssistantMessage => message?.role === "assistant" && message.stopReason === "error";

const assertAssistantMessageSucceeded = (message: AssistantMessage | undefined): void => {
  if (!isFailedAssistantMessage(message)) {
    return;
  }

  throw new Error(
    message.errorMessage
      ? `Pi harness agent stream failed: ${message.errorMessage}`
      : "Pi harness agent stream failed.",
  );
};

const canReplayPromptLikeOperation = (operation: PiHarnessOperation): boolean =>
  operation.kind === "prompt" ||
  operation.kind === "skill" ||
  operation.kind === "promptFromTemplate";

const toPromptOptions = (input: PiPromptInput): { images?: PiPromptInput["images"] } =>
  input.images ? { images: input.images } : {};

const handleControlCommand = async (
  harness: AgentHarness,
  command: PiSessionCommandPayload,
): Promise<boolean> => {
  switch (command.kind) {
    case "abort":
      await harness.abort();
      return true;
    case "steer":
      await harness.steer(command.input.text, toPromptOptions(command.input));
      return true;
    case "followUp":
      await harness.followUp(command.input.text, toPromptOptions(command.input));
      return true;
    case "nextTurn":
      await harness.nextTurn(command.input.text, toPromptOptions(command.input));
      return true;
    case "prompt":
      return false;
  }

  throw new Error("Unsupported Pi session command kind.");
};

const runOperation = async (
  harness: AgentHarness,
  operation: PiHarnessOperation,
): Promise<Omit<PiHarnessStepResult, "type" | "operation" | "appendedEntries" | "leafId">> => {
  switch (operation.kind) {
    case "prompt":
      return { assistantMessage: await harness.prompt(...operation.args) };
    case "skill":
      return { assistantMessage: await harness.skill(...operation.args) };
    case "promptFromTemplate":
      return { assistantMessage: await harness.promptFromTemplate(...operation.args) };
    case "compact":
      return { compactResult: await harness.compact(...operation.args) };
    case "navigateTree":
      return { navigateTreeResult: await harness.navigateTree(...operation.args) };
  }

  throw new Error("Unsupported Pi harness operation kind.");
};

export const runPiHarnessStep = async <TTool extends AgentTool = AgentTool>(
  step: WorkflowStep<PiHarnessHooksMap>,
  name: string,
  options: RunPiHarnessStepOptions<TTool>,
): Promise<PiHarnessStepResult> =>
  await step.do(name, async (tx) => {
    const operationId = `${options.workflowName}:${options.sessionId}:${name}`;
    const previousWorkflowEmissions = (await tx.previousEmissions()).map((emission) => ({
      ...emission,
      payload: emission.payload as PiHarnessEmission,
    }));
    const previousEmissions = previousWorkflowEmissions.map((emission) => emission.payload);
    const replayedEntries = previousSessionEntries(previousEmissions);
    const completedOperation = previousOperationComplete(previousWorkflowEmissions, operationId);
    const persistedEntryIds = new Set(options.persistedEntryIds ?? []);
    const uncommittedReplayedEntries = replayedEntries.filter(
      (entry) => !persistedEntryIds.has(entry.id),
    );
    const metadata: SessionMetadata = {
      id: options.sessionId,
      createdAt: new Date().toISOString(),
    };

    if (completedOperation) {
      if (completedOperation.result.assistantMessage) {
        const operationCompletedPayload = completedOperationPayload(
          options,
          name,
          operationId,
          previousOperationSessionEntries(
            previousWorkflowEmissions,
            operationId,
            completedOperation.epoch,
          ),
        );
        tx.mutate(({ forSchema }) => {
          const uow = forSchema(piSchema);
          uow.triggerHook("onOperationCompleted", operationCompletedPayload);
        });
      }
      return completedOperation.result;
    }

    let storageEntries = mergeSessionEntries(options.committedEntries, replayedEntries);
    let leafIdBeforeOperation: string | null | undefined;

    if (uncommittedReplayedEntries.length > 0) {
      if (!canReplayPromptLikeOperation(options.operation)) {
        throw new Error(
          `Cannot safely retry ${operationId}: previous attempt emitted session entries without an operation completion journal.`,
        );
      }

      let recoveredEntries = [...storageEntries];
      const lastMessage = latestMessage(recoveredEntries);

      if (isSuccessfulTerminalAssistantMessage(lastMessage)) {
        const result = {
          type: "harness-run",
          operation: options.operation.kind,
          appendedEntries: sessionEntriesNotPersisted(recoveredEntries, persistedEntryIds),
          leafId: entriesLeafId(recoveredEntries),
          assistantMessage: latestAssistantMessage(recoveredEntries),
        } satisfies PiHarnessStepResult;
        const operationCompletedPayload = completedOperationPayload(
          options,
          name,
          operationId,
          uncommittedReplayedEntries,
        );
        tx.mutate(({ forSchema }) => {
          const uow = forSchema(piSchema);
          uow.triggerHook("onOperationCompleted", operationCompletedPayload);
        });
        tx.emit({
          kind: "harness-operation-complete",
          operationId,
          result,
        } satisfies PiHarnessEmission);
        return result;
      }

      recoveredEntries = rollbackPromptLikeOperationToInitialPrompt({
        entries: recoveredEntries,
        uncommittedEntries: uncommittedReplayedEntries,
      });

      const userEntry = messageEntries(recoveredEntries).at(-1);
      if (userEntry?.message.role !== "user") {
        throw new Error(
          `Cannot safely retry ${operationId}: previous attempt emitted session entries without an operation completion journal.`,
        );
      }

      storageEntries = recoveredEntries;
      leafIdBeforeOperation = userEntry.parentId;
    }

    const entryIdsBeforeOperation = new Set(storageEntries.map((entry) => entry.id));
    const storage = new WorkflowBackedSessionStorage({
      metadata,
      entries: storageEntries,
      entryIds: createWorkflowBackedSessionEntryIdAllocator({
        prefix: `${options.sessionId}:${name}:entry`,
        startIndex: replayedEntries.length,
      }),
      onAppendEntry: (entry) => {
        tx.emit({ kind: "harness-session-entry", entry } satisfies PiHarnessEmission);
      },
    });
    const session = new Session(storage);
    const harness = new AgentHarness({
      ...options,
      session,
    });

    harness.subscribe((event) => {
      if (
        event.type === "message_update" &&
        options.internal?.compactMessageUpdateEmissions !== false
      ) {
        tx.emit({
          kind: "harness-message-update",
          update: piHarnessMessageUpdateFromPiEvent(event),
        });
        return;
      }

      tx.emit({ kind: "harness-event", event } satisfies PiHarnessEmission);
    });

    if (options.operation.kind === "prompt" && options.operation.stopOnTools?.length) {
      const stopOnTools = new Set(options.operation.stopOnTools);
      harness.on("tool_result", (event) =>
        stopOnTools.has(event.toolName) ? { terminate: true } : undefined,
      );
    }

    tx.onEvent("command", async (event) => {
      const handled = await handleControlCommand(harness, event.payload as PiSessionCommandPayload);
      if (handled) {
        event.consume();
      }
    });

    const unregister = registerAgentStreamFn(
      options,
      `${options.workflowName}:${options.sessionId}:${name}`,
    );
    try {
      tx.emit({
        kind: "harness-operation-start",
        operationId,
        operation: options.operation,
        replay: {
          protocol: "pi-harness-operation",
          version: 1,
        },
      } satisfies PiHarnessEmission);
      if (leafIdBeforeOperation !== undefined) {
        await session.moveTo(leafIdBeforeOperation);
      }
      const operationResult = await runOperation(harness, options.operation);
      const entries = await storage.getEntries();
      // Pi currently exposes model calls as assistant messages only for agent-loop operations.
      // Compact operations and summarized tree navigation are intentionally not reported until Pi
      // exposes their internal model calls as first-class harness events.
      if (operationResult.assistantMessage) {
        const operationCompletedPayload = completedOperationPayload(
          options,
          name,
          operationId,
          entries.filter((entry) => !entryIdsBeforeOperation.has(entry.id)),
        );
        tx.mutate(({ forSchema }) => {
          const uow = forSchema(piSchema);
          uow.triggerHook("onOperationCompleted", operationCompletedPayload);
        });
        tx.onTerminalError.mutate(({ forSchema }) => {
          const uow = forSchema(piSchema);
          uow.triggerHook("onOperationCompleted", operationCompletedPayload);
        });
      }
      assertAssistantMessageSucceeded(operationResult.assistantMessage);
      const result = {
        type: "harness-run",
        operation: options.operation.kind,
        appendedEntries: sessionEntriesNotPersisted(entries, persistedEntryIds),
        leafId: await storage.getLeafId(),
        ...operationResult,
      } satisfies PiHarnessStepResult;
      tx.emit({
        kind: "harness-operation-complete",
        operationId,
        result,
      } satisfies PiHarnessEmission);
      return result;
    } finally {
      unregister();
    }
  });
