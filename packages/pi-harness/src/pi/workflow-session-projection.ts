import {
  buildSessionContext,
  type AgentMessage,
  type SessionTreeEntry,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";

import type { PiHarnessAssistantMessageEvent } from "./harness/message-update-protocol";
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

export type PiWorkflowSessionLiveState = {
  inFlightMessagesByStepKey: Map<string, AgentMessage[]>;
  inFlightStepKeys: string[];
  draftAgentMessage: DraftAgentMessage | null;
  currentAssistantMessage?: AssistantMessage;
  draftStepKey?: string;
  hasOpenMessageDraft: boolean;
  activeLiveWork: boolean;
};

const hasActiveLiveWorkflowStep = (
  workflowSteps: readonly PiWorkflowSessionProjectionStep[],
): boolean =>
  workflowSteps.some(
    (step) =>
      step.status !== "completed" &&
      !(
        step.status === "waiting" &&
        step.type === "waitForEvent" &&
        step.waitEventType === "command"
      ),
  );

export const createPiWorkflowSessionLiveState = (
  activeLiveWork = false,
): PiWorkflowSessionLiveState => ({
  inFlightMessagesByStepKey: new Map(),
  inFlightStepKeys: [],
  draftAgentMessage: null,
  hasOpenMessageDraft: false,
  activeLiveWork,
});

export const reducePiWorkflowSessionEmission = (
  state: PiWorkflowSessionLiveState,
  emission: PiWorkflowSessionProjectionEmission,
): void => {
  const payload = emission.payload;
  if (!payload || !payload.kind) {
    return;
  }

  state.activeLiveWork = true;
  if (payload.kind !== "harness-event" && payload.kind !== "harness-message-update") {
    return;
  }

  const eventTime = new Date(emission.createdAt).getTime();
  state.draftStepKey = emission.stepKey;
  if (!state.draftAgentMessage) {
    state.draftAgentMessage = {
      activity: "starting",
      tools: {},
      startedAt: eventTime,
      updatedAt: eventTime,
    };
  } else {
    state.draftAgentMessage.updatedAt = eventTime;
  }

  const draftAgentMessage = state.draftAgentMessage;
  if (payload.kind === "harness-message-update") {
    state.hasOpenMessageDraft = true;
    const assistantEvent: PiHarnessAssistantMessageEvent = payload.update.assistantMessageEvent;
    switch (assistantEvent.type) {
      case "start":
        break;
      case "text_start":
        if (state.currentAssistantMessage) {
          state.currentAssistantMessage.content[assistantEvent.contentIndex] = {
            type: "text",
            text: "",
          };
        }
        break;
      case "text_delta":
        if (state.currentAssistantMessage) {
          const content = state.currentAssistantMessage.content[assistantEvent.contentIndex];
          if (content?.type === "text") {
            state.currentAssistantMessage.content[assistantEvent.contentIndex] = {
              ...content,
              text: content.text + assistantEvent.delta,
            };
          }
        }
        break;
      case "text_end":
        if (state.currentAssistantMessage) {
          const content = state.currentAssistantMessage.content[assistantEvent.contentIndex];
          if (content?.type === "text") {
            state.currentAssistantMessage.content[assistantEvent.contentIndex] = {
              ...content,
              text: assistantEvent.content,
            };
          }
        }
        break;
      case "thinking_start":
        if (state.currentAssistantMessage) {
          state.currentAssistantMessage.content[assistantEvent.contentIndex] = {
            type: "thinking",
            thinking: "",
          };
        }
        break;
      case "thinking_delta":
        if (state.currentAssistantMessage) {
          const content = state.currentAssistantMessage.content[assistantEvent.contentIndex];
          if (content?.type === "thinking") {
            state.currentAssistantMessage.content[assistantEvent.contentIndex] = {
              ...content,
              thinking: content.thinking + assistantEvent.delta,
            };
          }
        }
        break;
      case "thinking_end":
        if (state.currentAssistantMessage) {
          const content = state.currentAssistantMessage.content[assistantEvent.contentIndex];
          if (content?.type === "thinking") {
            state.currentAssistantMessage.content[assistantEvent.contentIndex] = {
              ...content,
              thinking: assistantEvent.content,
            };
          }
        }
        break;
      case "toolcall_start":
      case "toolcall_delta":
      case "toolcall_end":
        if (assistantEvent.toolCall) {
          if (state.currentAssistantMessage) {
            state.currentAssistantMessage.content[assistantEvent.contentIndex] =
              assistantEvent.toolCall;
          }
          draftAgentMessage.tools[assistantEvent.toolCall.id] = {
            ...draftAgentMessage.tools[assistantEvent.toolCall.id],
            id: assistantEvent.toolCall.id,
            name: assistantEvent.toolCall.name,
            args: assistantEvent.toolCall.arguments,
            status: draftAgentMessage.tools[assistantEvent.toolCall.id]?.status ?? "starting",
          };
        }
        break;
      case "done":
      case "error":
        break;
    }
    if (state.currentAssistantMessage) {
      draftAgentMessage.assistant = state.currentAssistantMessage;
    }

    draftAgentMessage.activity = assistantEvent.type.startsWith("thinking_")
      ? "thinking"
      : assistantEvent.type.startsWith("toolcall_")
        ? "tool_calling"
        : "writing";
    return;
  }

  const event = payload.event;
  if (event.type === "message_start") {
    draftAgentMessage.activity = "starting";
    if (event.message.role === "assistant") {
      state.currentAssistantMessage = {
        ...event.message,
        content: [...event.message.content],
      };
    }
    state.hasOpenMessageDraft = true;
  }

  if (event.type === "message_update") {
    state.hasOpenMessageDraft = true;
    const assistantEvent = event.assistantMessageEvent;
    if (event.message.role === "assistant") {
      state.currentAssistantMessage = event.message;
      draftAgentMessage.assistant = state.currentAssistantMessage;
    }

    draftAgentMessage.activity = assistantEvent.type.startsWith("thinking_")
      ? "thinking"
      : assistantEvent.type.startsWith("toolcall_")
        ? "tool_calling"
        : "writing";

    if (
      assistantEvent.type === "toolcall_start" ||
      assistantEvent.type === "toolcall_delta" ||
      assistantEvent.type === "toolcall_end"
    ) {
      const toolCall = state.currentAssistantMessage?.content[assistantEvent.contentIndex];
      if (toolCall?.type === "toolCall") {
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
    let inFlightMessages = state.inFlightMessagesByStepKey.get(emission.stepKey);
    if (!inFlightMessages) {
      inFlightMessages = [];
      state.inFlightMessagesByStepKey.set(emission.stepKey, inFlightMessages);
      state.inFlightStepKeys.push(emission.stepKey);
    }
    inFlightMessages.push(event.message);
    if (event.message.role === "assistant") {
      state.currentAssistantMessage = event.message;
      draftAgentMessage.assistant = state.currentAssistantMessage;
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
    state.hasOpenMessageDraft = false;
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
};

export const settleCompletedPiWorkflowSessionLiveSteps = (
  state: PiWorkflowSessionLiveState,
  completedStepKeys: ReadonlySet<string>,
): void => {
  state.inFlightStepKeys = state.inFlightStepKeys.filter((stepKey) => {
    if (!completedStepKeys.has(stepKey)) {
      return true;
    }
    state.inFlightMessagesByStepKey.delete(stepKey);
    return false;
  });

  if (state.draftStepKey && completedStepKeys.has(state.draftStepKey)) {
    state.draftAgentMessage = null;
    state.currentAssistantMessage = undefined;
    state.draftStepKey = undefined;
    state.hasOpenMessageDraft = false;
  }
};

export const overlayPiWorkflowSessionLiveState = (
  projection: PiWorkflowSessionProjectionState,
  instance: PiWorkflowSessionProjectionInstance,
  workflowSteps: readonly PiWorkflowSessionProjectionStep[],
  live: PiWorkflowSessionLiveState,
): PiWorkflowSessionProjectionState => {
  const messages = [...projection.state.messages];
  for (const stepKey of live.inFlightStepKeys) {
    messages.push(...(live.inFlightMessagesByStepKey.get(stepKey) ?? []));
  }

  const liveTools = Object.values(live.draftAgentMessage?.tools ?? {});
  const hasLiveTools = liveTools.some((tool) => tool.status !== "done");
  const visibleDraftAgentMessage =
    live.draftAgentMessage && (live.hasOpenMessageDraft || liveTools.length > 0)
      ? live.draftAgentMessage
      : null;
  const statusText =
    visibleDraftAgentMessage && (live.hasOpenMessageDraft || hasLiveTools)
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
    !live.hasOpenMessageDraft &&
    !hasLiveTools &&
    (!live.activeLiveWork || waitingForCommand || instance.status !== "active");

  return {
    ...projection,
    state: { messages },
    draftAgentMessage: visibleDraftAgentMessage,
    readyForInput,
    statusText: statusText ?? (live.activeLiveWork && !readyForInput ? "Working…" : null),
  };
};

export const projectPiWorkflowSession = ({
  workflowName,
  sessionId,
  instance,
  workflowSteps,
  workflowStepEmissions = [],
  initialState,
  initialCompletedStepKeys: initialCompletedStepKeyValues,
}: {
  workflowName: string;
  sessionId: string;
  instance: PiWorkflowSessionProjectionInstance | null;
  workflowSteps: readonly PiWorkflowSessionProjectionStep[];
  workflowStepEmissions?: readonly PiWorkflowSessionProjectionEmission[];
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

  const live = createPiWorkflowSessionLiveState(hasActiveLiveWorkflowStep(workflowSteps));
  for (const emission of workflowStepEmissions) {
    if (!completedStepKeys.has(emission.stepKey)) {
      reducePiWorkflowSessionEmission(live, emission);
    }
  }

  return overlayPiWorkflowSessionLiveState(
    {
      sessionFound: true,
      state: { messages: durableMessages },
      status: "ready",
      error: null,
      completedStepKeys: [...completedStepKeys],
      draftAgentMessage: null,
      readyForInput: false,
      statusText: null,
    },
    instance,
    workflowSteps,
    live,
  );
};
