import { buildScopedInstanceRowId } from "@fragno-dev/workflows/instance-ref";
import {
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowStepConfig,
  type WorkflowStepEmission,
} from "@fragno-dev/workflows/workflow";

import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";

import { PiLogger } from "../../debug-log";
import { piSchema } from "../../schema";
import type { PiAgentRegistry, PiSessionCommandPayload } from "../types";
import {
  restoreAgentTurnFromEvents,
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

const committedEmissionEpochs = (emissions: WorkflowStepEmission[]) =>
  new Set(
    emissions.flatMap((emission) =>
      typeof emission.payload === "object" &&
      emission.payload !== null &&
      "control" in emission.payload &&
      emission.payload.control === "step-committed"
        ? [emission.epoch]
        : [],
    ),
  );

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
    const previousEmissions = await tx.previousEmissions();
    const committedEpochs = committedEmissionEpochs(previousEmissions);
    const previousEvents = previousEmissions.flatMap((emission): AgentEvent[] => {
      if (committedEpochs.has(emission.epoch)) {
        return [];
      }
      const payload = emission.payload;
      if (typeof payload !== "object" || payload === null || !("type" in payload)) {
        return [];
      }
      switch (payload.type) {
        case "agent_start":
        case "agent_end":
        case "turn_start":
        case "turn_end":
        case "message_start":
        case "message_update":
        case "message_end":
        case "tool_execution_start":
        case "tool_execution_update":
        case "tool_execution_end":
          return [payload as AgentEvent];
        default:
          return [];
      }
    });
    const restore = restoreAgentTurnFromEvents({
      baseMessages: runtime.turn.messages,
      operation,
      events: previousEvents,
    });
    const controls = behavior.controls ?? ["abort", "steer"];

    const finish = (result: PiAgentRunResult) => {
      tx.mutate(({ forSchema }) => {
        const uow = forSchema(piSchema);
        uow.update(
          "session",
          buildScopedInstanceRowId(runtime.session.workflowName, runtime.event.instanceId),
          (builder) => builder.set({ status: "waiting", updatedAt: uow.now() }),
        );
      });

      return createPiAgentStepResult({
        stopReason: result.stopReason,
        messages: result.messages.slice(messagesBeforeStep),
        events: result.events.filter(
          (agentEvent) =>
            agentEvent.type !== "message_update" && agentEvent.type !== "tool_execution_update",
        ),
        errorMessage: result.errorMessage,
      });
    };

    if (restore.type === "finish") {
      return finish({
        stopReason: restore.stopReason,
        messages: restore.messages,
        events: restore.events,
        errorMessage: restore.errorMessage,
      });
    }

    const result = await runAgent(
      restore.operation,
      { ...runtime, turn: { ...runtime.turn, messages: restore.messages } },
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

    return finish({ ...result, events: [...restore.events, ...result.events] });
  });
