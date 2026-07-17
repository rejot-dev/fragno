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
  status?: string;
  result: unknown;
};

type AgentRunStepResult = { type: "agent-run"; messages?: AgentMessage[]; events?: AgentEvent[] };

type WorkflowHistoryAgentRunStepRow = WorkflowHistoryStepRow & {
  agentRunResult: AgentRunStepResult;
};

const isAgentRunStepResult = (result: unknown): result is AgentRunStepResult =>
  typeof result === "object" && (result as { type?: unknown })?.type === "agent-run";

const messagesFromEvents = (events: AgentEvent[]): AgentMessage[] =>
  events.flatMap((event) => (event.type === "message_end" ? [event.message] : []));

const isCompletedAgentRunStep = (
  step: WorkflowHistoryStepRow & { agentRunResult: AgentRunStepResult | null },
): step is WorkflowHistoryAgentRunStepRow =>
  (step.status === undefined || step.status === "completed") && step.agentRunResult !== null;

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

  const agentRunSteps = steps
    .map((step) => ({
      ...step,
      agentRunResult: isAgentRunStepResult(step.result) ? step.result : null,
    }))
    .filter(isCompletedAgentRunStep);

  for (const step of agentRunSteps) {
    events.push(...(step.agentRunResult.events ?? []));
    messages.push(...(step.agentRunResult.messages ?? []));
  }

  return {
    ...cursorState,
    messages: messages.length === 0 ? messagesFromEvents(events) : messages,
    events,
  };
};
