import {
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowStepConfig,
} from "@fragno-dev/workflows/workflow";

import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";

import { PiLogger } from "../../debug-log";
import { piSchema } from "../../schema";
import type { PiAgentRegistry, PiSessionCommandPayload } from "../types";
import {
  runAgentTurn,
  type AgentTurnContext,
  type AgentTurnSessionContext,
  type PiAgentRunResult,
  type PiAgentTurnBehavior,
  type PiAgentTurnLifecycle,
  type PiAgentTurnOperation,
} from "./agent-runner";
import {
  collectPiToolCallResults,
  createPiToolCallAccessor,
  type PiToolCallAccessor,
  type PiToolCallResult,
} from "./tool-call-results";

export type PiAgentRunner = (
  operation: PiAgentTurnOperation,
  runtime: {
    agent: PiAgentRegistry[string];
    session: AgentTurnSessionContext;
    turn: AgentTurnContext;
  },
  lifecycle?: PiAgentTurnLifecycle,
  behavior?: PiAgentTurnBehavior,
) => Promise<PiAgentRunResult>;

export type PiAgentStepResult = {
  type: "agent-run";
  stopReason: PiAgentRunResult["stopReason"];
  messages: AgentMessage[];
  events: AgentEvent[];
  toolCallResults: PiToolCallResult[];
  errorMessage: string | null;
  toolCalls(name: string): PiToolCallAccessor<unknown>;
};

export type PiAgentStepRuntime = {
  event: WorkflowEvent<unknown>;
  step: WorkflowStep;
  stepName: string;
  agent: PiAgentRegistry[string];
  agentRunner?: PiAgentRunner;
  session: AgentTurnSessionContext;
  turn: AgentTurnContext;
};

export type PiAgentStepBehavior = PiAgentTurnBehavior & {
  step?: WorkflowStepConfig;
  controls?: Array<"abort" | "steer">;
};

export const isEphemeralAgentEvent = (event: AgentEvent) =>
  event.type === "message_update" || event.type === "tool_execution_update";

export const createPiAgentStepResult = (input: {
  stopReason: PiAgentRunResult["stopReason"];
  messages: AgentMessage[];
  events: AgentEvent[];
  errorMessage: string | null;
}): PiAgentStepResult => {
  const toolCallResults = collectPiToolCallResults(input.events);
  return {
    type: "agent-run",
    stopReason: input.stopReason,
    messages: input.messages,
    events: input.events,
    toolCallResults,
    errorMessage: input.errorMessage,
    toolCalls: (name) => createPiToolCallAccessor(toolCallResults, name),
  };
};

const defaultStepConfig = {
  retries: { limit: 1, delay: "0 ms" as const, backoff: "constant" as const },
};

export const runPiAgentStep = async (
  operation: PiAgentTurnOperation,
  runtime: PiAgentStepRuntime,
  behavior: PiAgentStepBehavior = {},
): Promise<PiAgentStepResult> =>
  runtime.step.do(runtime.stepName, behavior.step ?? defaultStepConfig, async (tx) => {
    const runAgent = runtime.agentRunner ?? runAgentTurn;
    const messagesBeforeStep = runtime.turn.messages.length;
    const controls = behavior.controls ?? ["abort", "steer"];
    const result = await runAgent(
      operation,
      runtime,
      {
        onController: (controller) => {
          if (controls.length === 0) {
            return;
          }
          tx.onEvent("command", (event) => {
            const message = event.payload as PiSessionCommandPayload;
            if (message.kind === "abort" && controls.includes("abort")) {
              controller.abort();
              event.consume();
            }
            if (message.kind === "steer" && controls.includes("steer")) {
              controller.steer(message.input);
              event.consume();
            }
          });
        },
        onEvent: async (agentEvent) => {
          PiLogger.debug("agent event observed before workflow tx.emit", {
            sessionId: runtime.session.sessionId,
            turn: runtime.turn.turnId,
            type: agentEvent.type,
          });
          tx.emit(agentEvent);
        },
      },
      behavior,
    );

    tx.mutate(({ forSchema }) => {
      const uow = forSchema(piSchema);
      uow.update("session", runtime.event.instanceId, (builder) =>
        builder.set({ status: "waiting", updatedAt: uow.now() }),
      );
    });

    return createPiAgentStepResult({
      stopReason: result.stopReason,
      messages: result.messages.slice(messagesBeforeStep),
      events: result.events.filter((agentEvent) => !isEphemeralAgentEvent(agentEvent)),
      errorMessage: result.errorMessage,
    });
  });
