import { z } from "zod";

import type { HandlerTxContext, HooksMap } from "@fragno-dev/db";
import {
  defineWorkflow,
  NonRetryableError,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowStepTx,
  type WorkflowsRegistry,
} from "@fragno-dev/workflows";

import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";

import { PiLogger } from "../../debug-log";
import { piSchema } from "../../schema";
import type { PiSessionStatus } from "../constants";
import { extractAssistantTextFromMessage, normalizeSteeringMode } from "../mappers";
import type {
  PiActiveSessionState,
  PiAgentLoopPhase,
  PiAgentLoopState,
  PiAgentLoopWaitingFor,
  PiAgentRegistry,
  PiFragmentConfig,
  PiSessionDetailEvent,
  PiToolReplayContext,
  PiToolRegistry,
  PiToolSideEffectReducerRegistry,
  PiTurnSummary,
} from "../types";
import {
  createPiActiveSessionState,
  createInitialPiAgentLoopState,
  ensurePiActiveSessionState,
} from "./active-session";
import { runAgentTurn, type AgentLoopParams } from "./agent-runner";
import { createReplayContext, hydrateReplayCache, parsePersistedToolJournal } from "./tool-journal";

export { createInitialPiAgentLoopState, ensurePiActiveSessionState };

export const PI_WORKFLOW_NAME = "agent-loop-workflow";

type WorkflowsOptions = {
  agents: PiAgentRegistry;
  tools: PiToolRegistry;
  toolSideEffectReducers?: PiToolSideEffectReducerRegistry;
  logging?: PiFragmentConfig["logging"];
};

const WAIT_FOR_USER_TIMEOUT = "1 hour" as const;
const WAIT_FOR_USER_TIMEOUT_MS = 60 * 60 * 1000;

const agentLoopParamsSchema: z.ZodType<AgentLoopParams> = z.object({
  sessionId: z.string(),
  agentName: z.string(),
  systemPrompt: z.string().optional(),
  initialMessages: z.array(z.custom<AgentMessage>()).optional(),
});

const userMessageSchema = z.object({
  text: z.string().optional(),
  done: z.boolean().optional(),
  steeringMode: z.enum(["all", "one-at-a-time"]).optional(),
});

// --- Loop state ---

type LoopState = {
  messages: AgentMessage[];
  events: PiSessionDetailEvent[];
  trace: AgentEvent[];
  summaries: PiTurnSummary[];
  turn: number;
  phase: PiAgentLoopPhase;
  waitingFor: PiAgentLoopWaitingFor;
  replayCache: PiToolReplayContext["cache"];
  activeSession: PiActiveSessionState;
};

const buildWaitingForUser = (turn: number): NonNullable<PiAgentLoopWaitingFor> => ({
  type: "user_message",
  turn,
  stepKey: `waitForEvent:wait-user-${turn}`,
  timeoutMs: WAIT_FOR_USER_TIMEOUT_MS,
});

const initLoopState = (
  params: AgentLoopParams,
  existingState: PiAgentLoopState | undefined,
): LoopState => {
  const activeSession = existingState
    ? ensurePiActiveSessionState(existingState)
    : createPiActiveSessionState();

  return {
    messages: Array.isArray(params.initialMessages) ? params.initialMessages : [],
    events: [],
    trace: [],
    summaries: [],
    turn: 0,
    phase: "waiting-for-user",
    waitingFor: buildWaitingForUser(0),
    replayCache: new Map(),
    activeSession,
  };
};

const setPhase = (loop: LoopState, phase: PiAgentLoopPhase) => {
  loop.phase = phase;
  switch (phase) {
    case "waiting-for-user":
      loop.waitingFor = buildWaitingForUser(loop.turn);
      break;
    case "running-agent":
      loop.waitingFor = {
        type: "assistant",
        turn: loop.turn,
        stepKey: `do:assistant-${loop.turn}`,
      };
      break;
    case "complete":
      loop.waitingFor = null;
      break;
  }
};

type WorkflowContext =
  | { getState(): PiAgentLoopState; setState(state: Partial<PiAgentLoopState>): void }
  | undefined;

const emitState = (ctx: WorkflowContext, loop: LoopState) => {
  ctx?.setState({
    messages: loop.messages,
    events: loop.events,
    trace: loop.trace,
    summaries: loop.summaries,
    turn: loop.turn,
    phase: loop.phase,
    waitingFor: loop.waitingFor,
    activeSession: loop.activeSession,
    activeSessionUpdatesByTurn: loop.activeSession.exportReplayBuffer(),
  });
};

// --- DB status projection ---

const mutateSessionStatus = (
  forSchema: HandlerTxContext<HooksMap>["forSchema"],
  sessionId: string,
  status: PiSessionStatus,
): void => {
  try {
    const uow = forSchema(piSchema);
    uow.update("session", sessionId, (builder) => builder.set({ status }));
  } catch {
    // Some workflow-only tests run without the pi fragment schema mounted. Status projection is a
    // best-effort integration concern, so those environments can safely skip this mutation.
  }
};

const projectSessionStatus = (
  tx: WorkflowStepTx,
  sessionId: string,
  status: PiSessionStatus,
): void => {
  tx.mutate(({ forSchema }) => {
    mutateSessionStatus(forSchema, sessionId, status);
  });
};

// --- Turn helpers ---

const buildDetailEvent = (
  turn: number,
  event: { type: string; payload: unknown; timestamp: Date | string | number },
): PiSessionDetailEvent => {
  const timestamp = event.timestamp instanceof Date ? event.timestamp : new Date(event.timestamp);
  return {
    id: `${event.type}:${turn}:${timestamp.getTime()}`,
    type: event.type,
    payload: event.payload ?? null,
    createdAt: timestamp,
    deliveredAt: timestamp,
    consumedByStepKey: `waitForEvent:wait-user-${turn}`,
  };
};

const buildTurnSummary = (turn: number, assistant: AgentMessage | null): PiTurnSummary | null => {
  if (!assistant) {
    return null;
  }
  return {
    turn,
    assistant,
    summary: extractAssistantTextFromMessage(assistant) || null,
  };
};

const parseAssistantStepResult = (value: unknown, stepName: string) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new NonRetryableError(`Assistant step ${stepName} returned an invalid result.`);
  }
  const result = value as { messages?: unknown; trace?: unknown; assistant?: unknown };
  if (!Array.isArray(result.messages)) {
    throw new NonRetryableError(`Assistant step ${stepName} is missing messages.`);
  }
  const messages = result.messages as AgentMessage[];
  const trace = Array.isArray(result.trace) ? (result.trace as AgentEvent[]) : [];
  const assistant =
    (result.assistant && typeof result.assistant === "object"
      ? (result.assistant as AgentMessage)
      : null) ??
    messages.findLast((m) => m.role === "assistant") ??
    null;

  return {
    messages,
    trace,
    assistant,
    toolJournal: parsePersistedToolJournal(value, stepName),
  };
};

// --- Workflow definition ---

const createPiAgentLoopWorkflow = (options: WorkflowsOptions) =>
  defineWorkflow(
    {
      name: PI_WORKFLOW_NAME,
      schema: agentLoopParamsSchema,
      initialState: createInitialPiAgentLoopState(),
    },
    async function (event: WorkflowEvent<AgentLoopParams>, step: WorkflowStep) {
      const params = agentLoopParamsSchema.parse(event.payload ?? {});
      const agentDefinition = options.agents[params.agentName];
      if (!agentDefinition) {
        throw new NonRetryableError(`Agent ${params.agentName} not found.`);
      }

      const loop = initLoopState(params, this?.getState());
      emitState(this, loop);

      while (true) {
        setPhase(loop, "waiting-for-user");
        emitState(this, loop);

        // Wait for the user to send a message (or signal done).
        const userEvent = await step.waitForEvent(`wait-user-${loop.turn}`, {
          type: "user_message",
          timeout: WAIT_FOR_USER_TIMEOUT,
        });
        const userPayload = userMessageSchema.parse(userEvent.payload ?? {});
        const userText = userPayload.text ?? "";
        const isDone = userPayload.done ?? false;
        const steeringMode = normalizeSteeringMode(userPayload.steeringMode);

        // Persist the user message as a durable step.
        loop.events = [...loop.events, buildDetailEvent(loop.turn, userEvent)];
        const userResult = await step.do(`user-${loop.turn}`, async (tx) => {
          projectSessionStatus(tx, event.instanceId, "active");
          const userMessage: AgentMessage = {
            role: "user",
            content: [{ type: "text", text: userText }],
            timestamp: Date.now(),
          };
          return { messages: [...loop.messages, userMessage] };
        });
        loop.messages = userResult.messages;

        setPhase(loop, "running-agent");
        emitState(this, loop);

        // Run the AI agent turn as a retryable durable step.
        const replay = createReplayContext({
          cache: loop.replayCache,
          reducers: options.toolSideEffectReducers,
        });
        const assistantStepName = `assistant-${loop.turn}`;
        const traceLengthBeforeTurn = loop.trace.length;
        const turnId = `${event.instanceId}:${loop.turn}`;

        let assistantResult: Awaited<ReturnType<typeof runAgentTurn>>;
        try {
          assistantResult = await step.do(
            assistantStepName,
            { retries: { limit: 1, delay: "0 ms", backoff: "constant" } },
            async (tx) => {
              tx.onTerminalError.mutate(({ forSchema }) => {
                mutateSessionStatus(forSchema, event.instanceId, "errored");
              });

              const result = await runAgentTurn({
                params,
                agent: agentDefinition,
                tools: options.tools,
                messages: loop.messages,
                steeringMode,
                turnId,
                replay,
                onEvent: (agentEvent) => {
                  loop.trace = [...loop.trace, agentEvent];
                  loop.activeSession.publishEvent(loop.turn, agentEvent);
                  emitState(this, loop);
                },
              });

              projectSessionStatus(tx, event.instanceId, isDone ? "complete" : "waiting");
              return result;
            },
          );
        } catch (error) {
          if (!(error instanceof Error && error.name === "RunnerStepSuspended")) {
            loop.activeSession.settleTurn(loop.turn, "errored");
            emitState(this, loop);
          }
          throw error;
        }

        const parsed = parseAssistantStepResult(assistantResult, assistantStepName);
        loop.messages = parsed.messages;
        loop.trace = [...loop.trace.slice(0, traceLengthBeforeTurn), ...parsed.trace];
        const summary = buildTurnSummary(loop.turn, parsed.assistant);
        if (summary) {
          loop.summaries = [...loop.summaries, summary];
        }
        hydrateReplayCache(loop.replayCache, parsed.toolJournal);

        if (isDone) {
          setPhase(loop, "complete");
          loop.activeSession.settleTurn(loop.turn, "complete");
          emitState(this, loop);
          return { messages: loop.messages };
        }

        loop.activeSession.settleTurn(loop.turn, "waiting-for-user");
        loop.turn += 1;
        emitState(this, loop);
      }
    },
  );

export type PiWorkflowsRegistry = {
  agentLoop: ReturnType<typeof createPiAgentLoopWorkflow>;
};

export const createPiWorkflows = (options: WorkflowsOptions) => {
  PiLogger.reset();
  if (options.logging) {
    PiLogger.configure(options.logging);
  }

  return {
    agentLoop: createPiAgentLoopWorkflow(options),
  } satisfies WorkflowsRegistry;
};
