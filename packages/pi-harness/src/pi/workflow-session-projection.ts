import {
  buildSessionContext,
  type AgentMessage,
  type SessionTreeEntry,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";

import type { PiHarnessEmission, PiHarnessStepResult } from "./harness/run-pi-harness-step";
import type { PiAgentStateSnapshot } from "./types";

export type PiSessionProjectionStatus = "idle" | "loading" | "ready" | "error";

export type PiSessionProjectionError = Error;

export type DraftAgentActivity =
  | "starting"
  | "thinking"
  | "writing"
  | "tool_calling"
  | "running_tools";

export interface DraftTool {
  id: string;
  name: string;
  args: unknown;
  status: "starting" | "running" | "done";
  partialResult?: unknown;
  result?: unknown;
  resultMessage?: ToolResultMessage;
  isError?: boolean;
}

export interface DraftAgentMessage {
  activity: DraftAgentActivity;
  assistant?: AssistantMessage;
  tools: Record<string, DraftTool>;
  startedAt: number;
  updatedAt: number;
}

export type PiWorkflowSessionProjectionState = {
  state: PiAgentStateSnapshot;
  status: PiSessionProjectionStatus;
  error: PiSessionProjectionError | null;
  sessionFound: boolean;
  completedStepKeys: string[];
  draftAgentMessage: DraftAgentMessage | null;
  readyForInput: boolean;
  statusText: string | null;
};

export type PiWorkflowSessionProjectionStep = {
  stepKey: string;
  type: string;
  status: string;
  waitEventType: string | null;
  result: PiHarnessStepResult | null;
};

export type PiWorkflowSessionProjectionEmission = {
  stepKey: string;
  payload: PiHarnessEmission | { kind: undefined; control: string } | null;
  createdAt: Date | string;
};

export type PiWorkflowSessionProjectionInstance = {
  status: string;
};

export type PiWorkflowSessionProjectionOptions = {
  initialState?: PiAgentStateSnapshot;
  initialCompletedStepKeys?: readonly string[];
};

export const emptyPiWorkflowSessionProjectionState = (
  state: PiAgentStateSnapshot = { messages: [] },
): PiWorkflowSessionProjectionState => ({
  sessionFound: true,
  state,
  status: "loading",
  error: null,
  completedStepKeys: [],
  draftAgentMessage: null,
  readyForInput: false,
  statusText: "Loading…",
});

export const piAgentMessagesFromSessionEntries = (
  entries: readonly SessionTreeEntry[],
): AgentMessage[] => {
  let leafId: string | null = null;
  for (const entry of entries) {
    leafId = entry.type === "leaf" ? entry.targetId : entry.id;
  }

  const fallbackMessages = () =>
    entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));

  if (leafId === null) {
    return fallbackMessages();
  }

  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const path: SessionTreeEntry[] = [];
  let current = byId.get(leafId);
  while (current) {
    path.unshift(current);
    if (!current.parentId) {
      return buildSessionContext(path).messages;
    }
    current = byId.get(current.parentId);
  }

  return fallbackMessages();
};

export const latestCompletedPiHarnessEntries = (
  steps: readonly PiWorkflowSessionProjectionStep[],
): SessionTreeEntry[] => {
  const entries: SessionTreeEntry[] = [];
  const indexes = new Map<string, number>();

  for (const step of steps) {
    if (step.status !== "completed" || step.result?.type !== "harness-run") {
      continue;
    }
    for (const entry of step.result.entries) {
      const index = indexes.get(entry.id);
      if (index === undefined) {
        indexes.set(entry.id, entries.length);
        entries.push(entry);
        continue;
      }
      entries[index] = entry;
    }
  }

  return entries;
};

export const projectPiWorkflowSession = ({
  workflowName,
  sessionId,
  instance,
  workflowSteps,
  workflowStepEmissions,
  initialState,
  initialCompletedStepKeys: initialCompletedStepKeyValues,
}: {
  workflowName: string;
  sessionId: string;
  instance: PiWorkflowSessionProjectionInstance | null;
  workflowSteps: readonly PiWorkflowSessionProjectionStep[];
  workflowStepEmissions: readonly PiWorkflowSessionProjectionEmission[];
} & PiWorkflowSessionProjectionOptions): PiWorkflowSessionProjectionState => {
  if (instance === null) {
    return {
      ...emptyPiWorkflowSessionProjectionState(initialState),
      sessionFound: false,
      status: "error",
      error: new Error(`Pi session ${workflowName}/${sessionId} was not found.`),
      statusText: null,
    };
  }

  const initialCompletedStepKeys = new Set(initialCompletedStepKeyValues ?? []);
  const localCompletedSteps = workflowSteps.filter(
    (step) => step.status === "completed" && step.result?.type === "harness-run",
  );
  const completedStepKeys = new Set(initialCompletedStepKeys);
  const durableMessages: AgentMessage[] = [];

  if (
    initialCompletedStepKeyValues !== undefined ||
    (localCompletedSteps.length === 0 && workflowStepEmissions.length === 0)
  ) {
    durableMessages.push(...(initialState?.messages ?? []));
  }

  const localDurableMessages = piAgentMessagesFromSessionEntries(
    latestCompletedPiHarnessEntries(
      localCompletedSteps.filter((step) => {
        completedStepKeys.add(step.stepKey);
        return !initialCompletedStepKeys.has(step.stepKey);
      }),
    ),
  );
  durableMessages.push(
    ...(durableMessages.length > 0 && localDurableMessages.length > durableMessages.length
      ? localDurableMessages.slice(durableMessages.length)
      : localDurableMessages),
  );

  const inFlightMessagesByStepKey = new Map<string, AgentMessage[]>();
  const inFlightStepKeys: string[] = [];
  let draftAgentMessage: DraftAgentMessage | null = null;
  let hasOpenMessageDraft = false;
  let activeLiveWork = workflowSteps.some(
    (step) =>
      step.status !== "completed" &&
      !(
        step.status === "waiting" &&
        step.type === "waitForEvent" &&
        step.waitEventType === "command"
      ),
  );

  for (const emission of workflowStepEmissions) {
    if (completedStepKeys.has(emission.stepKey)) {
      continue;
    }

    const payload = emission.payload;
    if (!payload || !payload.kind) {
      continue;
    }

    activeLiveWork = true;

    if (payload.kind !== "harness-event") {
      continue;
    }

    const event = payload.event;
    const eventTime = new Date(emission.createdAt).getTime();

    if (!draftAgentMessage) {
      draftAgentMessage = {
        activity: "starting",
        tools: {},
        startedAt: eventTime,
        updatedAt: eventTime,
      };
    } else {
      draftAgentMessage.updatedAt = eventTime;
    }

    if (event.type === "message_start") {
      draftAgentMessage.activity = "starting";
      hasOpenMessageDraft = true;
    }

    if (event.type === "message_update") {
      hasOpenMessageDraft = true;
      if (event.message.role === "assistant") {
        draftAgentMessage.assistant = event.message;
      }

      const assistantEvent = event.assistantMessageEvent;
      draftAgentMessage.activity = assistantEvent?.type.startsWith("thinking_")
        ? "thinking"
        : assistantEvent?.type.startsWith("toolcall_")
          ? "tool_calling"
          : "writing";

      if (
        assistantEvent?.type === "toolcall_start" ||
        assistantEvent?.type === "toolcall_delta" ||
        assistantEvent?.type === "toolcall_end"
      ) {
        const toolCall =
          assistantEvent.type === "toolcall_end"
            ? assistantEvent.toolCall
            : assistantEvent.partial.content[assistantEvent.contentIndex];
        if (toolCall.type === "toolCall") {
          draftAgentMessage.tools[toolCall.id] = {
            ...draftAgentMessage.tools[toolCall.id],
            id: toolCall.id,
            name: toolCall.name,
            args: toolCall.arguments,
            status: draftAgentMessage.tools[toolCall.id]?.status ?? "starting",
          };
        }
      }
    }

    if (event.type === "message_end") {
      let inFlightMessages = inFlightMessagesByStepKey.get(emission.stepKey);
      if (!inFlightMessages) {
        inFlightMessages = [];
        inFlightMessagesByStepKey.set(emission.stepKey, inFlightMessages);
        inFlightStepKeys.push(emission.stepKey);
      }
      inFlightMessages.push(event.message);
      if (event.message.role === "assistant") {
        draftAgentMessage.assistant = event.message;
      }
      if (event.message.role === "toolResult") {
        draftAgentMessage.tools[event.message.toolCallId] = {
          ...draftAgentMessage.tools[event.message.toolCallId],
          id: event.message.toolCallId,
          name: event.message.toolName,
          args: draftAgentMessage.tools[event.message.toolCallId]?.args,
          resultMessage: event.message,
          status: "done",
        };
      }
      hasOpenMessageDraft = false;
    }

    if (event.type === "tool_execution_start") {
      draftAgentMessage.activity = "running_tools";
      draftAgentMessage.tools[event.toolCallId] = {
        ...draftAgentMessage.tools[event.toolCallId],
        id: event.toolCallId,
        name: event.toolName,
        args: event.args,
        status: "running",
      };
    }

    if (event.type === "tool_execution_update") {
      draftAgentMessage.activity = "running_tools";
      draftAgentMessage.tools[event.toolCallId] = {
        ...draftAgentMessage.tools[event.toolCallId],
        id: event.toolCallId,
        name: event.toolName,
        args: event.args,
        partialResult: event.partialResult,
        status: "running",
      };
    }

    if (event.type === "tool_execution_end") {
      draftAgentMessage.tools[event.toolCallId] = {
        ...draftAgentMessage.tools[event.toolCallId],
        id: event.toolCallId,
        name: event.toolName,
        args: draftAgentMessage.tools[event.toolCallId]?.args,
        result: event.result,
        isError: event.isError,
        status: "done",
      };
    }
  }

  const messages = [...durableMessages];
  for (const stepKey of inFlightStepKeys) {
    messages.push(...(inFlightMessagesByStepKey.get(stepKey) ?? []));
  }

  const liveTools = Object.values(draftAgentMessage?.tools ?? {});
  const hasLiveTools = liveTools.some((tool) => tool.status !== "done");
  const visibleDraftAgentMessage =
    draftAgentMessage && (hasOpenMessageDraft || liveTools.length > 0) ? draftAgentMessage : null;
  const statusText =
    visibleDraftAgentMessage && (hasOpenMessageDraft || hasLiveTools)
      ? visibleDraftAgentMessage.activity === "tool_calling"
        ? "Writing tool call…"
        : visibleDraftAgentMessage.activity === "running_tools"
          ? "Running tool calls…"
          : visibleDraftAgentMessage.activity === "thinking"
            ? "Thinking…"
            : visibleDraftAgentMessage.activity === "writing"
              ? "Writing…"
              : "Working…"
      : null;
  const waitingForCommand = workflowSteps.some(
    (step) =>
      step.status === "waiting" && step.type === "waitForEvent" && step.waitEventType === "command",
  );
  const readyForInput =
    instance.status !== "errored" &&
    instance.status !== "failed" &&
    !hasOpenMessageDraft &&
    !hasLiveTools &&
    (!activeLiveWork || waitingForCommand || instance.status !== "active");

  return {
    sessionFound: true,
    state: { messages },
    status: "ready",
    error: null,
    completedStepKeys: [...completedStepKeys],
    draftAgentMessage: visibleDraftAgentMessage,
    readyForInput,
    statusText: statusText ?? (activeLiveWork && !readyForInput ? "Working…" : null),
  };
};
