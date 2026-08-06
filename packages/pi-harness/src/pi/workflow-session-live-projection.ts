import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";

import {
  piToolCallArgumentsText,
  type PiHarnessAssistantMessageEvent,
} from "./harness/message-update-protocol";
import type { PiSessionActiveCommand } from "./session-command-protocol";
import type { PiWorkflowStatus } from "./types";
import type {
  DraftAgentActivity,
  DraftAgentMessage,
  DraftTool,
  PiWorkflowSessionProjectionEmission,
  PiWorkflowSessionProjectionStep,
} from "./workflow-session-projection";

export type PiWorkflowSessionLiveState = {
  inFlightMessagesByStepKey: Map<string, AgentMessage[]>;
  inFlightStepKeys: string[];
  draftAgentMessage: DraftAgentMessage | null;
  currentAssistantMessage?: AssistantMessage;
  draftStepKey?: string;
  activeCommand: PiSessionActiveCommand | null;
  activeCommandStepKey?: string;
  hasOpenMessageDraft: boolean;
  activeLiveWork: boolean;
};

export const isPiWorkflowStepActive = (step: PiWorkflowSessionProjectionStep): boolean =>
  step.status !== "completed" &&
  !(step.status === "waiting" && step.type === "waitForEvent" && step.waitEventType === "command");

export const createPiWorkflowSessionLiveState = (
  activeLiveWork = false,
): PiWorkflowSessionLiveState => ({
  inFlightMessagesByStepKey: new Map(),
  inFlightStepKeys: [],
  draftAgentMessage: null,
  activeCommand: null,
  hasOpenMessageDraft: false,
  activeLiveWork,
});

const draftActivityForAssistantEvent = (
  type: PiHarnessAssistantMessageEvent["type"],
): DraftAgentActivity | null => {
  if (type === "start") {
    return "starting";
  }
  if (type.startsWith("thinking_")) {
    return "thinking";
  }
  if (type.startsWith("toolcall_")) {
    return "tool_calling";
  }
  if (type.startsWith("text_")) {
    return "writing";
  }
  return null;
};

const updateDraftTool = (tools: Record<string, DraftTool>, toolCall: ToolCall): void => {
  const argsText = piToolCallArgumentsText(toolCall);
  tools[toolCall.id] = {
    ...tools[toolCall.id],
    id: toolCall.id,
    name: toolCall.name,
    args: toolCall.arguments,
    ...(argsText === undefined ? {} : { argsText }),
    status: tools[toolCall.id]?.status ?? "starting",
  };
};

const updateAssistantContent = (
  message: AssistantMessage | undefined,
  event: PiHarnessAssistantMessageEvent,
): void => {
  if (!message || !("contentIndex" in event)) {
    return;
  }

  switch (event.type) {
    case "text_start":
      message.content[event.contentIndex] = { type: "text", text: "" };
      return;
    case "text_delta": {
      const content = message.content[event.contentIndex];
      if (content?.type === "text") {
        message.content[event.contentIndex] = { ...content, text: content.text + event.delta };
      }
      return;
    }
    case "text_end": {
      const content = message.content[event.contentIndex];
      if (content?.type === "text") {
        message.content[event.contentIndex] = { ...content, text: event.content };
      }
      return;
    }
    case "thinking_start":
      message.content[event.contentIndex] = { type: "thinking", thinking: "" };
      return;
    case "thinking_delta": {
      const content = message.content[event.contentIndex];
      if (content?.type === "thinking") {
        message.content[event.contentIndex] = {
          ...content,
          thinking: content.thinking + event.delta,
        };
      }
      return;
    }
    case "thinking_end": {
      const content = message.content[event.contentIndex];
      if (content?.type === "thinking") {
        message.content[event.contentIndex] = { ...content, thinking: event.content };
      }
      return;
    }
    case "toolcall_start":
    case "toolcall_delta":
    case "toolcall_end":
      if (event.toolCall) {
        message.content[event.contentIndex] = event.toolCall;
      }
      return;
  }
};

const ensureDraftAgentMessage = (
  state: PiWorkflowSessionLiveState,
  emission: PiWorkflowSessionProjectionEmission,
): DraftAgentMessage => {
  const eventTime = new Date(emission.createdAt).getTime();
  if (!Number.isFinite(eventTime)) {
    throw new Error(`Pi workflow emission ${emission.stepKey} has an invalid timestamp.`);
  }

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
  return state.draftAgentMessage;
};

const reduceCompactMessageUpdate = (
  state: PiWorkflowSessionLiveState,
  draft: DraftAgentMessage,
  event: PiHarnessAssistantMessageEvent,
): void => {
  state.hasOpenMessageDraft = true;
  updateAssistantContent(state.currentAssistantMessage, event);

  if (
    (event.type === "toolcall_start" ||
      event.type === "toolcall_delta" ||
      event.type === "toolcall_end") &&
    event.toolCall
  ) {
    updateDraftTool(draft.tools, event.toolCall);
  }

  if (state.currentAssistantMessage) {
    draft.assistant = state.currentAssistantMessage;
  }
  const activity = draftActivityForAssistantEvent(event.type);
  if (activity) {
    draft.activity = activity;
  }
};

const recordInFlightMessage = (
  state: PiWorkflowSessionLiveState,
  stepKey: string,
  message: AgentMessage,
): void => {
  let messages = state.inFlightMessagesByStepKey.get(stepKey);
  if (!messages) {
    messages = [];
    state.inFlightMessagesByStepKey.set(stepKey, messages);
    state.inFlightStepKeys.push(stepKey);
  }
  messages.push(message);
};

export const reducePiWorkflowSessionEmission = (
  state: PiWorkflowSessionLiveState,
  emission: PiWorkflowSessionProjectionEmission,
): void => {
  const payload = emission.payload;
  if (!payload?.kind) {
    return;
  }

  state.activeLiveWork = true;
  if (payload.kind === "pi-session-command-start") {
    state.activeCommand = payload.command;
    state.activeCommandStepKey = emission.stepKey;
    return;
  }
  if (payload.kind !== "harness-event" && payload.kind !== "harness-message-update") {
    return;
  }

  const draft = ensureDraftAgentMessage(state, emission);
  if (payload.kind === "harness-message-update") {
    reduceCompactMessageUpdate(state, draft, payload.update.assistantMessageEvent);
    return;
  }

  const event = payload.event;
  switch (event.type) {
    case "message_start":
      draft.activity = "starting";
      if (event.message.role === "assistant") {
        draft.assistant = undefined;
        draft.tools = {};
        state.currentAssistantMessage = {
          ...event.message,
          content: [...event.message.content],
        };
      }
      state.hasOpenMessageDraft = true;
      return;
    case "message_update": {
      state.hasOpenMessageDraft = true;
      if (event.message.role === "assistant") {
        const assistantMessage = {
          ...event.message,
          content: [...event.message.content],
        };
        state.currentAssistantMessage = assistantMessage;
        draft.assistant = assistantMessage;
      }
      const activity = draftActivityForAssistantEvent(event.assistantMessageEvent.type);
      if (activity) {
        draft.activity = activity;
      }
      if (
        event.assistantMessageEvent.type === "toolcall_start" ||
        event.assistantMessageEvent.type === "toolcall_delta" ||
        event.assistantMessageEvent.type === "toolcall_end"
      ) {
        const toolCall =
          state.currentAssistantMessage?.content[event.assistantMessageEvent.contentIndex];
        if (toolCall?.type === "toolCall") {
          updateDraftTool(draft.tools, toolCall);
        }
      }
      return;
    }
    case "message_end":
      recordInFlightMessage(state, emission.stepKey, event.message);
      if (event.message.role === "assistant") {
        state.currentAssistantMessage = event.message;
        draft.assistant = event.message;
      } else if (event.message.role === "toolResult") {
        draft.tools[event.message.toolCallId] = {
          ...draft.tools[event.message.toolCallId],
          id: event.message.toolCallId,
          name: event.message.toolName,
          args: draft.tools[event.message.toolCallId]?.args,
          resultMessage: event.message,
          status: "done",
        };
      }
      state.hasOpenMessageDraft = false;
      return;
    case "tool_execution_start":
      draft.activity = "running_tools";
      draft.tools[event.toolCallId] = {
        ...draft.tools[event.toolCallId],
        id: event.toolCallId,
        name: event.toolName,
        args: event.args,
        status: "running",
      };
      return;
    case "tool_execution_update":
      draft.activity = "running_tools";
      draft.tools[event.toolCallId] = {
        ...draft.tools[event.toolCallId],
        id: event.toolCallId,
        name: event.toolName,
        args: event.args,
        partialResult: event.partialResult,
        status: "running",
      };
      return;
    case "tool_execution_end":
      draft.tools[event.toolCallId] = {
        ...draft.tools[event.toolCallId],
        id: event.toolCallId,
        name: event.toolName,
        args: draft.tools[event.toolCallId]?.args,
        result: event.result,
        isError: event.isError,
        status: "done",
      };
      return;
    case "abort":
    case "after_provider_response":
    case "agent_end":
    case "agent_start":
    case "before_agent_start":
    case "before_provider_payload":
    case "before_provider_request":
    case "context":
    case "model_update":
    case "queue_update":
    case "resources_update":
    case "retry_attempt_start":
    case "retry_finished":
    case "retry_scheduled":
    case "save_point":
    case "session_before_compact":
    case "session_before_tree":
    case "session_compact":
    case "session_tree":
    case "settled":
    case "thinking_level_update":
    case "tool_call":
    case "tool_result":
    case "tools_update":
    case "turn_end":
    case "turn_start":
      return;
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

  if (state.activeCommandStepKey && completedStepKeys.has(state.activeCommandStepKey)) {
    state.activeCommand = null;
    state.activeCommandStepKey = undefined;
  }
};

export type PiWorkflowSessionLiveOverlay = {
  contextMessages: AgentMessage[];
  timelineMessages: AgentMessage[];
  draftAgentMessage: DraftAgentMessage | null;
  activeCommand: PiSessionActiveCommand | null;
  readyForInput: boolean;
  activity: DraftAgentActivity | "working" | null;
};

export const projectPiWorkflowSessionLiveOverlay = ({
  contextMessages: durableContextMessages,
  timelineMessages: durableTimelineMessages,
  instanceStatus,
  workflowSteps,
  live,
}: {
  contextMessages: readonly AgentMessage[];
  timelineMessages: readonly AgentMessage[];
  instanceStatus: PiWorkflowStatus;
  workflowSteps: readonly PiWorkflowSessionProjectionStep[];
  live: PiWorkflowSessionLiveState;
}): PiWorkflowSessionLiveOverlay => {
  const contextMessages = [...durableContextMessages];
  const timelineMessages = [...durableTimelineMessages];
  for (const stepKey of live.inFlightStepKeys) {
    const messages = live.inFlightMessagesByStepKey.get(stepKey) ?? [];
    contextMessages.push(...messages);
    timelineMessages.push(...messages);
  }

  const liveTools = Object.values(live.draftAgentMessage?.tools ?? {});
  const hasLiveTools = liveTools.some((tool) => tool.status !== "done");
  const draftAgentMessage =
    live.draftAgentMessage && (live.hasOpenMessageDraft || liveTools.length > 0)
      ? live.draftAgentMessage
      : null;
  const waitingForCommand = workflowSteps.some(
    (step) =>
      step.status === "waiting" && step.type === "waitForEvent" && step.waitEventType === "command",
  );
  const workflowAcceptsCommands = instanceStatus === "active" || instanceStatus === "waiting";
  const readyForInput =
    workflowAcceptsCommands &&
    !live.hasOpenMessageDraft &&
    !hasLiveTools &&
    (!live.activeLiveWork || waitingForCommand);
  const activity =
    draftAgentMessage && (live.hasOpenMessageDraft || hasLiveTools)
      ? draftAgentMessage.activity
      : live.activeLiveWork && !readyForInput
        ? "working"
        : null;

  return {
    contextMessages,
    timelineMessages,
    draftAgentMessage,
    activeCommand: live.activeCommand,
    readyForInput,
    activity,
  };
};
