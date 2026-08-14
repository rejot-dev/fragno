import type { ToolCall } from "@earendil-works/pi-ai";

import { PiHarnessEventStreamDecoders } from "./harness/agent-harness-event-protocol";
import {
  piToolCallArgumentsText,
  type PiHarnessFrontendAgentMessage,
  type PiHarnessFrontendAssistantMessage,
  type PiHarnessFrontendEvent,
} from "./harness/agent-harness-event-protocol";
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
  inFlightMessagesByStepKey: Map<string, PiHarnessFrontendAgentMessage[]>;
  inFlightStepKeys: string[];
  draftAgentMessage: DraftAgentMessage | null;
  currentAssistantMessage?: PiHarnessFrontendAssistantMessage;
  draftStepKey?: string;
  activeCommand: PiSessionActiveCommand | null;
  activeCommandStepKey?: string;
  hasOpenMessageDraft: boolean;
  activeLiveWork: boolean;
};

export type PiWorkflowSessionEmissionReducer = {
  live: PiWorkflowSessionLiveState;
  eventDecoders: PiHarnessEventStreamDecoders;
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
  type: Extract<
    PiHarnessFrontendEvent,
    { type: "message_update" }
  >["assistantMessageEvent"]["type"],
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

const ensureDraftAgentMessage = (
  state: PiWorkflowSessionLiveState,
  emission: Pick<PiWorkflowSessionProjectionEmission, "createdAt" | "stepKey">,
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

const recordInFlightMessage = (
  state: PiWorkflowSessionLiveState,
  stepKey: string,
  message: PiHarnessFrontendAgentMessage,
): void => {
  let messages = state.inFlightMessagesByStepKey.get(stepKey);
  if (!messages) {
    messages = [];
    state.inFlightMessagesByStepKey.set(stepKey, messages);
    state.inFlightStepKeys.push(stepKey);
  }
  messages.push(message);
};

export const createPiWorkflowSessionEmissionReducer = (
  activeLiveWork = false,
): PiWorkflowSessionEmissionReducer => ({
  live: createPiWorkflowSessionLiveState(activeLiveWork),
  eventDecoders: new PiHarnessEventStreamDecoders(),
});

export const reducePiWorkflowSessionEmission = (
  reducer: PiWorkflowSessionEmissionReducer,
  emission: PiWorkflowSessionProjectionEmission,
): void => {
  const state = reducer.live;
  const payload = emission.payload;
  if (!payload?.kind) {
    return;
  }

  state.activeLiveWork = true;
  if (payload.kind === "harness-operation-start") {
    if (!emission.executionId || !emission.epoch) {
      throw new Error(`Pi workflow emission ${emission.stepKey} is missing its stream identity.`);
    }
    reducer.eventDecoders.start({
      stepKey: emission.stepKey,
      executionId: emission.executionId,
      epoch: emission.epoch,
    });
    return;
  }
  if (payload.kind === "pi-session-command-start") {
    state.activeCommand = payload.command;
    state.activeCommandStepKey = emission.stepKey;
    return;
  }
  if (payload.kind === "harness-operation-complete") {
    if (!emission.executionId || !emission.epoch) {
      throw new Error(`Pi workflow emission ${emission.stepKey} is missing its stream identity.`);
    }
    reducer.eventDecoders.finish({
      stepKey: emission.stepKey,
      executionId: emission.executionId,
      epoch: emission.epoch,
    });
    return;
  }
  if (payload.kind !== "harness-event") {
    return;
  }

  if (!emission.executionId || !emission.epoch) {
    throw new Error(`Pi workflow emission ${emission.stepKey} is missing its stream identity.`);
  }
  const event = reducer.eventDecoders.decode(
    {
      stepKey: emission.stepKey,
      executionId: emission.executionId,
      epoch: emission.epoch,
    },
    payload.event,
  );
  const draft = ensureDraftAgentMessage(state, emission);
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
      if (event.message.role !== "assistant") {
        throw new Error("Pi harness message_update did not contain an assistant message.");
      }
      const assistantMessage = structuredClone(event.message);
      state.currentAssistantMessage = assistantMessage;
      draft.assistant = assistantMessage;
      const activity = draftActivityForAssistantEvent(event.assistantMessageEvent.type);
      if (activity) {
        draft.activity = activity;
      }
      if ("contentIndex" in event.assistantMessageEvent) {
        const toolCall = assistantMessage.content[event.assistantMessageEvent.contentIndex];
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
  contextMessages: PiHarnessFrontendAgentMessage[];
  timelineMessages: PiHarnessFrontendAgentMessage[];
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
  contextMessages: readonly PiHarnessFrontendAgentMessage[];
  timelineMessages: readonly PiHarnessFrontendAgentMessage[];
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
