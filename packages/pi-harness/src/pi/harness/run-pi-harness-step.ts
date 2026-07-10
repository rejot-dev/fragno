import type { WorkflowStep } from "@fragno-dev/workflows/workflow";

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

import type { PiPromptInput, PiSessionCommandPayload } from "../types";
import { registerAgentStreamFn } from "./agent-stream-provider";
import {
  piHarnessMessageUpdateEmissionFromPiEvent,
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
  entries: SessionTreeEntry[];
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
    operation: PiHarnessOperation;
    committedEntries?: readonly SessionTreeEntry[];
    internal?: PiHarnessInternalOptions;
  };

export type PiHarnessSessionStepState = {
  entries: SessionTreeEntry[];
  leafId: string | null;
};

const cloneEntry = (entry: SessionTreeEntry): SessionTreeEntry =>
  structuredClone(entry) as SessionTreeEntry;

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
  return { entries, leafId: entriesLeafId(entries) };
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
    entries.push(cloneEntry(entry));
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
    entries.push(cloneEntry(emission.entry));
  }

  return entries;
};

const previousOperationComplete = (
  emissions: readonly PiHarnessEmission[],
  operationId: string,
): PiHarnessStepResult | undefined => {
  for (let i = emissions.length - 1; i >= 0; i -= 1) {
    const emission = emissions[i];
    if (emission?.kind === "harness-operation-complete" && emission.operationId === operationId) {
      return emission.result;
    }
  }

  return undefined;
};

const messageEntries = (entries: readonly SessionTreeEntry[]) =>
  entries.flatMap((entry) => (entry.type === "message" ? [entry] : []));

const hasToolCalls = (message: AgentMessage): boolean =>
  message.role === "assistant" && message.content.some((content) => content.type === "toolCall");

const isSuccessfulTerminalAssistantMessage = (
  message: AgentMessage | undefined,
): message is AssistantMessage =>
  message?.role === "assistant" && !hasToolCalls(message) && !isFailedAssistantMessage(message);

const rollbackPromptLikeOperationToInitialPrompt = (options: {
  entries: readonly SessionTreeEntry[];
  uncommittedEntries: readonly SessionTreeEntry[];
}): SessionTreeEntry[] => {
  const initialPromptEntry = options.uncommittedEntries.find(
    (entry) => entry.type === "message" && entry.message.role === "user",
  );
  if (!initialPromptEntry) {
    return options.entries.map(cloneEntry);
  }

  const cutoff = options.entries.findIndex((entry) => entry.id === initialPromptEntry.id);
  return cutoff === -1 ? options.entries.map(cloneEntry) : options.entries.slice(0, cutoff + 1);
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
};

const runOperation = async (
  harness: AgentHarness,
  operation: PiHarnessOperation,
): Promise<
  Omit<PiHarnessStepResult, "type" | "operation" | "appendedEntries" | "entries" | "leafId">
> => {
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
};

export const runPiHarnessStep = async <TTool extends AgentTool = AgentTool>(
  step: WorkflowStep,
  name: string,
  options: RunPiHarnessStepOptions<TTool>,
): Promise<PiHarnessStepResult> =>
  await step.do(name, async (tx) => {
    const operationId = `${options.workflowName}:${options.sessionId}:${name}`;
    const previousEmissions = (await tx.previousEmissions()).map(
      (emission) => emission.payload as PiHarnessEmission,
    );
    const replayedEntries = previousSessionEntries(previousEmissions);
    const completedResult = previousOperationComplete(previousEmissions, operationId);
    const committedEntryIds = new Set((options.committedEntries ?? []).map((entry) => entry.id));
    const uncommittedReplayedEntries = replayedEntries.filter(
      (entry) => !committedEntryIds.has(entry.id),
    );
    const appendedEntries: SessionTreeEntry[] = [];
    const metadata: SessionMetadata = {
      id: options.sessionId,
      createdAt: new Date().toISOString(),
    };

    if (completedResult) {
      return completedResult;
    }

    let storageEntries = mergeSessionEntries(options.committedEntries, replayedEntries);
    let leafIdBeforeOperation: string | null | undefined;

    if (uncommittedReplayedEntries.length > 0) {
      if (!canReplayPromptLikeOperation(options.operation)) {
        throw new Error(
          `Cannot safely retry ${operationId}: previous attempt emitted session entries without an operation completion journal.`,
        );
      }

      let recoveredEntries = storageEntries.map(cloneEntry);
      const lastMessage = latestMessage(recoveredEntries);

      if (isSuccessfulTerminalAssistantMessage(lastMessage)) {
        const recoveredEntryIds = new Set(recoveredEntries.map((entry) => entry.id));
        const recoveredAppendedEntries = uncommittedReplayedEntries
          .filter((entry) => recoveredEntryIds.has(entry.id))
          .map(cloneEntry);
        const result = {
          type: "harness-run",
          operation: options.operation.kind,
          appendedEntries: recoveredAppendedEntries,
          entries: recoveredEntries,
          leafId: entriesLeafId(recoveredEntries),
          assistantMessage: latestAssistantMessage(recoveredEntries),
        } satisfies PiHarnessStepResult;
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
      if (!userEntry || userEntry.message.role !== "user") {
        throw new Error(
          `Cannot safely retry ${operationId}: previous attempt emitted session entries without an operation completion journal.`,
        );
      }

      storageEntries = recoveredEntries;
      leafIdBeforeOperation = userEntry.parentId;
    }

    const storage = new WorkflowBackedSessionStorage({
      metadata,
      entries: storageEntries,
      entryIds: createWorkflowBackedSessionEntryIdAllocator({
        prefix: `${options.sessionId}:${name}:entry`,
        startIndex: replayedEntries.length,
      }),
      onAppendEntry: (entry) => {
        appendedEntries.push(entry);
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
        tx.emit(piHarnessMessageUpdateEmissionFromPiEvent(event));
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
      assertAssistantMessageSucceeded(operationResult.assistantMessage);
      const entries = await storage.getEntries();
      const result = {
        type: "harness-run",
        operation: options.operation.kind,
        appendedEntries,
        entries,
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
