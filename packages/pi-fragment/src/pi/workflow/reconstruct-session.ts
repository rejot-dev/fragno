import { z } from "zod";

import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";

import type {
  PiAgentLoopCursorState,
  PiAgentLoopSerializableState,
  PiAgentStateSnapshot,
  PiSessionDetailProjection,
} from "../types";

export type WorkflowHistoryEventRow = {
  payload?: unknown;
  createdAt: Date;
  consumedByStepKey: string | null;
};

export type WorkflowHistoryStepRow = {
  stepKey: string;
  result: unknown;
  createdAt?: Date;
};

const agentMessageSchema = z.custom<AgentMessage>();
const agentEventSchema = z.custom<AgentEvent>();
const agentRunStepResultSchema = z.object({
  type: z.literal("agent-run").optional(),
  messages: z.array(agentMessageSchema).optional(),
  events: z.array(agentEventSchema).optional(),
});

const parseAgentRunStepResult = (value: unknown) => {
  const result = agentRunStepResultSchema.safeParse(value);
  if (!result.success) {
    return null;
  }
  if (result.data.type !== "agent-run" && !result.data.messages && !result.data.events) {
    return null;
  }
  return result.data;
};

const getStepEvents = (result: z.infer<typeof agentRunStepResultSchema>): AgentEvent[] =>
  result.events ?? [];

const commandStepOrder = (stepKey: string): number => {
  const match = /^do:command-(\d+)-/.exec(stepKey);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
};

const compareNullableDates = (left?: Date, right?: Date) => {
  if (!left && !right) {
    return 0;
  }
  if (!left) {
    return 1;
  }
  if (!right) {
    return -1;
  }
  return left.getTime() - right.getTime();
};

const sortWorkflowStepsForProjection = (steps: WorkflowHistoryStepRow[]) =>
  [...steps].sort((left, right) => {
    const commandOrder = commandStepOrder(left.stepKey) - commandStepOrder(right.stepKey);
    if (commandOrder !== 0) {
      return commandOrder;
    }
    const createdOrder = compareNullableDates(left.createdAt, right.createdAt);
    if (createdOrder !== 0) {
      return createdOrder;
    }
    return left.stepKey.localeCompare(right.stepKey);
  });

const messagesFromEvents = (events: AgentEvent[]): AgentMessage[] =>
  events.flatMap((event) => (event.type === "message_end" ? [event.message] : []));

export const buildPiAgentStateSnapshot = (options: {
  messages: AgentMessage[];
  errorMessage?: string | null;
}): PiAgentStateSnapshot => ({
  messages: options.messages,
  ...(options.errorMessage ? { errorMessage: options.errorMessage } : {}),
});

export const reconstructSessionProjection = (
  initialMessages: AgentMessage[],
  _events: WorkflowHistoryEventRow[],
  steps: WorkflowHistoryStepRow[],
): PiSessionDetailProjection => {
  const messages = [...initialMessages];
  const events: AgentEvent[] = [];

  for (const step of sortWorkflowStepsForProjection(steps)) {
    const result = parseAgentRunStepResult(step.result);
    if (!result) {
      continue;
    }
    events.push(...getStepEvents(result));
    if (result.messages) {
      messages.push(...result.messages);
    }
  }

  return { messages: messages.length === 0 ? messagesFromEvents(events) : messages, events };
};

export const projectSessionDetailState = (
  cursorState: PiAgentLoopCursorState,
  projection: PiSessionDetailProjection,
): PiAgentLoopSerializableState => ({
  ...projection,
  turn: cursorState.turn,
  phase: cursorState.phase,
  waitingFor: cursorState.waitingFor,
});

export const projectSessionDetailFromWorkflowHistory = ({
  cursorState,
  initialMessages = [],
  events,
  steps,
}: {
  cursorState: PiAgentLoopCursorState;
  initialMessages?: AgentMessage[];
  events: WorkflowHistoryEventRow[];
  steps: WorkflowHistoryStepRow[];
}): PiAgentLoopSerializableState =>
  projectSessionDetailState(
    cursorState,
    reconstructSessionProjection(initialMessages, events, steps),
  );
