import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";

import type { PiSessionCommandPayload } from "../types";

export type PiAgentLoopCursorState = {
  turn: number;
  phase: "waiting-for-command" | "running-agent" | "complete";
  waitingFor:
    | {
        type: "command";
        turn: number;
        stepKey: string;
        allowedCommands: PiSessionCommandPayload["kind"][];
        timeoutMs: number | null;
      }
    | {
        type: "agent" | "assistant";
        turn: number;
        operation?: "prompt" | "continue";
        stepKey: string;
      }
    | null;
};

export type PiAgentLoopSerializableState = PiAgentLoopCursorState & {
  messages: AgentMessage[];
  events: AgentEvent[];
};

type WorkflowHistoryStepRow = {
  stepKey: string;
  result: unknown;
};

const commandStepOrder = (stepKey: string) => Number(/^do:command-(\d+)-/.exec(stepKey)?.[1] ?? 0);

const isAgentRunStepResult = (
  result: unknown,
): result is { messages?: AgentMessage[]; events?: AgentEvent[] } =>
  typeof result === "object" &&
  result !== null &&
  (result as { type?: unknown }).type === "agent-run";

const messagesFromEvents = (events: AgentEvent[]): AgentMessage[] =>
  events.flatMap((event) => (event.type === "message_end" ? [event.message] : []));

export const projectSessionDetailFromWorkflowHistory = ({
  cursorState,
  initialMessages = [],
  steps,
}: {
  cursorState: PiAgentLoopCursorState;
  initialMessages?: AgentMessage[];
  events: unknown[];
  steps: WorkflowHistoryStepRow[];
}): PiAgentLoopSerializableState => {
  const messages = [...initialMessages];
  const events: AgentEvent[] = [];

  for (const step of [...steps].sort(
    (left, right) => commandStepOrder(left.stepKey) - commandStepOrder(right.stepKey),
  )) {
    if (!isAgentRunStepResult(step.result)) {
      continue;
    }
    events.push(...(step.result.events ?? []));
    messages.push(...(step.result.messages ?? []));
  }

  return {
    ...cursorState,
    messages: messages.length === 0 ? messagesFromEvents(events) : messages,
    events,
  };
};
