import { z } from "zod";

import {
  defineWorkflow,
  NonRetryableError,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowsRegistry,
} from "@fragno-dev/workflows";

import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";

import { PiLogger } from "../../debug-log";
import { piSchema } from "../../schema";
import { extractAssistantTextFromMessage } from "../mappers";
import type {
  PiActiveSessionState,
  PiAgentLoopPhase,
  PiAgentLoopState,
  PiAgentLoopWaitingFor,
  PiAgentRegistry,
  PiFragmentConfig,
  PiLiveInjectionRecord,
  PiPromptInput,
  PiSessionCommandPayload,
  PiSessionCommandType,
  PiToolReplayContext,
  PiToolRegistry,
  PiToolSideEffectReducerRegistry,
  PiTurnOperationRecord,
  PiTurnStatus,
  PiTurnSummary,
} from "../types";
import {
  createPiActiveSessionState,
  createInitialPiAgentLoopState,
  ensurePiActiveSessionState,
} from "./active-session";
import {
  runAgentTurn,
  type AgentLoopParams,
  type PiAgentRunResult,
  type PiAgentRunMode,
} from "./agent-runner";
import { createReplayContext, hydrateReplayCache, parsePersistedToolJournal } from "./tool-journal";

export { createInitialPiAgentLoopState, ensurePiActiveSessionState };

export const PI_WORKFLOW_NAME = "agent-loop-workflow";

export type PiAgentRunOptions = {
  mode: PiAgentRunMode;
  promptInput?: PiPromptInput;
  params: AgentLoopParams;
  agent: PiAgentRegistry[string];
  tools: PiToolRegistry;
  messages: AgentMessage[];
  steeringMode: "all" | "one-at-a-time";
  turnId: string;
  replay: PiToolReplayContext;
  onEvent?: (event: AgentEvent) => void;
  onController?: (controller: {
    abort(): void;
    steer(input: PiPromptInput): void;
    followUp(input: PiPromptInput): void;
  }) => void;
  onControllerClear?: () => void;
};

export type PiAgentRunner = (options: PiAgentRunOptions) => Promise<PiAgentRunResult>;

type WorkflowsOptions = {
  agents: PiAgentRegistry;
  tools: PiToolRegistry;
  toolSideEffectReducers?: PiToolSideEffectReducerRegistry;
  logging?: PiFragmentConfig["logging"];
  agentRunner?: PiAgentRunner;
};

const WAIT_FOR_COMMAND_TIMEOUT = "1 hour" as const;
const WAIT_FOR_COMMAND_TIMEOUT_MS = 60 * 60 * 1000;

const agentLoopParamsSchema: z.ZodType<AgentLoopParams> = z.object({
  sessionId: z.string(),
  agentName: z.string(),
  systemPrompt: z.string().optional(),
  initialMessages: z.array(z.custom<AgentMessage>()).optional(),
});

const promptInputSchema = z.object({
  text: z.string(),
  images: z
    .array(z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() }))
    .optional(),
});

const commandPayloadSchema: z.ZodType<PiSessionCommandPayload> = z.discriminatedUnion("kind", [
  z.object({ commandId: z.string(), kind: z.literal("prompt"), input: promptInputSchema }),
  z.object({ commandId: z.string(), kind: z.literal("continue") }),
  z.object({ commandId: z.string(), kind: z.literal("abort"), reason: z.string().optional() }),
  z.object({ commandId: z.string(), kind: z.literal("steer"), input: promptInputSchema }),
  z.object({ commandId: z.string(), kind: z.literal("followUp"), input: promptInputSchema }),
  z.object({ commandId: z.string(), kind: z.literal("complete"), reason: z.string().optional() }),
]);

// --- Loop state ---

type LoopCursor = {
  turn: number;
  phase: PiAgentLoopPhase;
  waitingFor: PiAgentLoopWaitingFor;
  commandIndex: number;
  replayCache: PiToolReplayContext["cache"];
  activeSession: PiActiveSessionState;
};

type TurnExecutionContext = {
  messages: AgentMessage[];
  turns: PiTurnSummary[];
};

const freshTurnCommands: PiSessionCommandType[] = ["prompt", "followUp", "complete"];
const continueCommands: PiSessionCommandType[] = ["continue", "abort"];

const allowedCommandsFor = (
  loop: Pick<LoopCursor, "turn">,
  turnContext: Pick<TurnExecutionContext, "turns">,
): PiSessionCommandType[] => {
  const currentTurn = turnContext.turns.find((entry) => entry.turn === loop.turn);
  return currentTurn?.status === "waiting-to-continue" ? continueCommands : freshTurnCommands;
};

const buildWaitCommandStepName = (turn: number, commandIndex: number) =>
  `wait-command-turn-${turn}-command-${commandIndex}`;

const buildWaitingForCommand = (
  turn: number,
  commandIndex: number,
  allowedCommands: PiSessionCommandType[],
): NonNullable<PiAgentLoopWaitingFor> => ({
  type: "command",
  turn,
  stepKey: `waitForEvent:${buildWaitCommandStepName(turn, commandIndex)}`,
  allowedCommands,
  timeoutMs: WAIT_FOR_COMMAND_TIMEOUT_MS,
});

const initLoopCursor = (existingState: PiAgentLoopState | undefined): LoopCursor => {
  const activeSession = existingState
    ? ensurePiActiveSessionState(existingState)
    : createPiActiveSessionState();

  return {
    turn: 0,
    phase: "waiting-for-command",
    waitingFor: buildWaitingForCommand(0, 0, freshTurnCommands),
    commandIndex: 0,
    replayCache: new Map(),
    activeSession,
  };
};

const initTurnExecutionContext = (params: AgentLoopParams): TurnExecutionContext => {
  const messages = Array.isArray(params.initialMessages) ? params.initialMessages : [];
  const turns: PiTurnSummary[] = [];
  return { messages, turns };
};

const setWorkflowState = (
  ctx: { setState(state: Partial<PiAgentLoopState>): void } | undefined,
  loop: LoopCursor,
) => {
  ctx?.setState({
    turn: loop.turn,
    phase: loop.phase,
    waitingFor: loop.waitingFor,
    activeSession: loop.activeSession,
    activeSessionUpdatesByTurn: loop.activeSession.exportReplayBuffer(),
  });
};

const setPhase = (
  loop: LoopCursor,
  turnContext: TurnExecutionContext,
  phase: PiAgentLoopPhase,
  options?: { operation?: "prompt" | "continue"; stepKey?: string },
) => {
  loop.phase = phase;
  switch (phase) {
    case "waiting-for-command":
      loop.waitingFor = buildWaitingForCommand(
        loop.turn,
        loop.commandIndex,
        allowedCommandsFor(loop, turnContext),
      );
      break;
    case "running-agent":
      loop.waitingFor = {
        type: "agent",
        turn: loop.turn,
        operation: options?.operation ?? "prompt",
        stepKey: options?.stepKey ?? `do:${options?.operation ?? "prompt"}-turn-${loop.turn}-op-0`,
      };
      break;
    case "complete":
      loop.waitingFor = null;
      break;
  }
};

// --- Turn helpers ---

const getTurn = (turnContext: TurnExecutionContext, turn: number): PiTurnSummary | undefined =>
  turnContext.turns.find((entry) => entry.turn === turn);

const upsertTurn = (turnContext: TurnExecutionContext, next: PiTurnSummary) => {
  const index = turnContext.turns.findIndex((entry) => entry.turn === next.turn);
  turnContext.turns =
    index >= 0
      ? [...turnContext.turns.slice(0, index), next, ...turnContext.turns.slice(index + 1)]
      : [...turnContext.turns, next];
};

const getOrCreateTurn = (turnContext: TurnExecutionContext, turn: number): PiTurnSummary => {
  const existing = getTurn(turnContext, turn);
  if (existing) {
    return existing;
  }
  const created: PiTurnSummary = {
    turn,
    status: "idle",
    assistant: null,
    summary: null,
    operations: [],
  };
  upsertTurn(turnContext, created);
  return created;
};

const nextOperationIndex = (turnContext: TurnExecutionContext, turn: number) =>
  getOrCreateTurn(turnContext, turn).operations.length;

const operationStepName = (
  command: PiSessionCommandPayload,
  turn: number,
  operationIndex: number,
  commandIndex: number,
) => {
  switch (command.kind) {
    case "prompt":
      return `prompt-turn-${turn}-op-${operationIndex}`;
    case "continue":
      return `continue-turn-${turn}-op-${operationIndex}`;
    case "abort":
      return `abort-turn-${turn}-op-${operationIndex}`;
    case "steer":
      return `steer-turn-${turn}-op-${operationIndex}`;
    case "followUp":
      return `follow-up-turn-${turn}-op-${operationIndex}`;
    case "complete":
      return `complete-session-command-${commandIndex}`;
  }
};

const appendOperation = (
  turnContext: TurnExecutionContext,
  command: PiSessionCommandPayload,
  options: {
    turn: number;
    operationIndex: number;
    stepKey: string;
    outcome: PiTurnOperationRecord["outcome"];
    errorMessage?: string | null;
    status: PiTurnStatus;
    assistant?: AgentMessage | null;
    createdAt: Date;
    completedAt: Date;
  },
) => {
  const existing = getOrCreateTurn(turnContext, options.turn);
  const assistant = options.assistant === undefined ? existing.assistant : options.assistant;
  const operation: PiTurnOperationRecord = {
    commandId: command.commandId,
    turn: options.turn,
    operationIndex: options.operationIndex,
    kind: command.kind as PiTurnOperationRecord["kind"],
    stepKey: options.stepKey,
    outcome: options.outcome,
    errorMessage: options.errorMessage ?? null,
    createdAt: options.createdAt,
    completedAt: options.completedAt,
  };
  upsertTurn(turnContext, {
    ...existing,
    status: options.status,
    assistant: assistant ?? null,
    summary: assistant ? extractAssistantTextFromMessage(assistant) || null : existing.summary,
    operations: [...existing.operations, operation],
  });
};

const currentTurnStatus = (loop: LoopCursor, turnContext: TurnExecutionContext): PiTurnStatus =>
  getTurn(turnContext, loop.turn)?.status ?? "idle";

const canStartFreshTurn = (loop: LoopCursor, turnContext: TurnExecutionContext) =>
  loop.phase === "waiting-for-command" &&
  (currentTurnStatus(loop, turnContext) === "idle" ||
    currentTurnStatus(loop, turnContext) === "completed" ||
    currentTurnStatus(loop, turnContext) === "aborted");

const rejectionReasonFor = (
  loop: LoopCursor,
  turnContext: TurnExecutionContext,
  command: PiSessionCommandPayload,
): string | null => {
  if (loop.phase === "complete") {
    return "Session is complete.";
  }
  const status = currentTurnStatus(loop, turnContext);
  switch (command.kind) {
    case "prompt":
      return canStartFreshTurn(loop, turnContext)
        ? null
        : "Prompt only applies while waiting for a fresh turn.";
    case "followUp":
      return canStartFreshTurn(loop, turnContext)
        ? null
        : "Follow-up requires a live injection or a fresh waiting turn.";
    case "continue":
      return status === "waiting-to-continue"
        ? null
        : "Continue only applies after a recoverable agent error.";
    case "abort":
      return loop.phase === "running-agent" || status === "waiting-to-continue"
        ? null
        : "Abort only applies to a running or retryable turn.";
    case "steer":
      return "Steer requires a live running operation.";
    case "complete":
      return canStartFreshTurn(loop, turnContext)
        ? null
        : "Complete only applies while waiting for a fresh command.";
  }
};

const parseOperationResult = (value: unknown, stepName: string): PiAgentRunResult => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new NonRetryableError(`Agent step ${stepName} returned an invalid result.`);
  }
  const result = value as PiAgentRunResult;
  if (!Array.isArray(result.messages)) {
    throw new NonRetryableError(`Agent step ${stepName} is missing messages.`);
  }
  return {
    ...result,
    trace: Array.isArray(result.trace) ? result.trace : [],
    toolJournal: parsePersistedToolJournal(value, stepName),
  };
};

type CommandStepResult = {
  commandId: string;
  commandStatus: "applied" | "rejected";
  rejectionReason: string | null;
  turn: number | null;
  operationIndex: number | null;
  stepKey: string;
  commandCreatedAt: Date;
  consumedAt: Date;
  operationCreatedAt?: Date;
  operationCompletedAt?: Date;
  outcome?: PiAgentRunResult["outcome"];
  errorMessage?: string | null;
  messages?: AgentMessage[];
  trace?: AgentEvent[];
  assistant?: AgentMessage | null;
  toolJournal?: unknown;
  liveInjection?: PiLiveInjectionRecord | null;
};

const buildRejectedResult = (
  command: PiSessionCommandPayload,
  stepKey: string,
  turn: number,
  reason: string,
  now: Date,
): CommandStepResult => ({
  commandId: command.commandId,
  commandStatus: "rejected",
  rejectionReason: reason,
  turn,
  operationIndex: null,
  stepKey: `do:${stepKey}`,
  commandCreatedAt: now,
  consumedAt: now,
});

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

      const loop = initLoopCursor(this?.getState());
      const turnContext = initTurnExecutionContext(params);
      setWorkflowState(this, loop);

      while (loop.phase !== "complete") {
        setPhase(loop, turnContext, "waiting-for-command");
        setWorkflowState(this, loop);

        const waitStepName = buildWaitCommandStepName(loop.turn, loop.commandIndex);
        const commandEvent = await step.waitForEvent(waitStepName, {
          type: "command",
          timeout: WAIT_FOR_COMMAND_TIMEOUT,
        });
        const command = commandPayloadSchema.parse(commandEvent.payload ?? {});
        const operationIndex =
          command.kind === "complete" ? 0 : nextOperationIndex(turnContext, loop.turn);
        const opStepName = operationStepName(command, loop.turn, operationIndex, loop.commandIndex);
        const opStepKey = `do:${opStepName}`;
        const rejectionReason = rejectionReasonFor(loop, turnContext, command);

        const commandResult = await step.do(
          opStepName,
          { retries: { limit: 1, delay: "0 ms", backoff: "constant" } },
          async (tx): Promise<CommandStepResult> => {
            const now = new Date();
            tx.mutate(({ forSchema }) => {
              const uow = forSchema(piSchema);
              uow.update("session", event.instanceId, (builder) =>
                builder.set({
                  status: command.kind === "complete" ? "complete" : "active",
                  updatedAt: now,
                }),
              );
            });
            if (rejectionReason) {
              return buildRejectedResult(command, opStepName, loop.turn, rejectionReason, now);
            }

            if (command.kind === "complete") {
              return {
                commandId: command.commandId,
                commandStatus: "applied",
                rejectionReason: null,
                turn: null,
                operationIndex: null,
                stepKey: opStepKey,
                commandCreatedAt: now,
                consumedAt: now,
              };
            }

            if (command.kind === "abort") {
              return {
                commandId: command.commandId,
                commandStatus: "applied",
                rejectionReason: null,
                turn: loop.turn,
                operationIndex,
                stepKey: opStepKey,
                commandCreatedAt: now,
                consumedAt: now,
                operationCreatedAt: now,
                operationCompletedAt: now,
                outcome: "aborted",
                errorMessage: command.reason ?? null,
                liveInjection: loop.activeSession.getLiveInjection(command.commandId),
              };
            }

            if (command.kind === "steer") {
              const liveInjection = loop.activeSession.getLiveInjection(command.commandId);
              if (!liveInjection?.injected) {
                return buildRejectedResult(
                  command,
                  opStepName,
                  loop.turn,
                  "Steer command was not live-injected into a running operation.",
                  now,
                );
              }
              return {
                commandId: command.commandId,
                commandStatus: "applied",
                rejectionReason: null,
                turn: liveInjection.turn ?? loop.turn,
                operationIndex,
                stepKey: opStepKey,
                commandCreatedAt: now,
                consumedAt: now,
                operationCreatedAt: now,
                operationCompletedAt: now,
                outcome: "completed",
                errorMessage: null,
                liveInjection,
              };
            }

            const mode = command.kind === "continue" ? "continue" : "prompt";
            const input: PiPromptInput | undefined =
              command.kind === "prompt" || command.kind === "followUp" ? command.input : undefined;
            setPhase(loop, turnContext, "running-agent", { operation: mode, stepKey: opStepKey });
            setWorkflowState(this, loop);
            const replay = createReplayContext({
              cache: loop.replayCache,
              reducers: options.toolSideEffectReducers,
            });
            const turnId = `${event.instanceId}:${loop.turn}`;

            const runAgent = options.agentRunner ?? runAgentTurn;
            const result = await runAgent({
              mode,
              promptInput: input,
              params,
              agent: agentDefinition,
              tools: options.tools,
              messages: turnContext.messages,
              steeringMode: "all",
              turnId,
              replay,
              onController: (controller) => {
                loop.activeSession.registerLiveController({
                  turn: loop.turn,
                  operation: mode,
                  stepKey: opStepKey,
                  abort: controller.abort,
                  steer: controller.steer,
                  followUp: controller.followUp,
                });
              },
              onControllerClear: () => loop.activeSession.clearLiveController(opStepKey),
              onEvent: (agentEvent) => {
                loop.activeSession.publishEvent(loop.turn, agentEvent);
                setWorkflowState(this, loop);
              },
            });

            const completedAt = new Date();
            tx.mutate(({ forSchema }) => {
              const uow = forSchema(piSchema);
              uow.update("session", event.instanceId, (builder) =>
                builder.set({ status: "waiting", updatedAt: completedAt }),
              );
            });
            return {
              ...result,
              trace: result.trace,
              commandId: command.commandId,
              commandStatus: "applied",
              rejectionReason: null,
              turn: loop.turn,
              operationIndex,
              stepKey: opStepKey,
              commandCreatedAt: now,
              consumedAt: now,
              operationCreatedAt: now,
              operationCompletedAt: completedAt,
              liveInjection:
                command.kind === "followUp"
                  ? loop.activeSession.getLiveInjection(command.commandId)
                  : null,
            };
          },
        );

        const consumedAt = new Date(commandResult.consumedAt);
        const operationCreatedAt = commandResult.operationCreatedAt
          ? new Date(commandResult.operationCreatedAt)
          : consumedAt;
        const operationCompletedAt = commandResult.operationCompletedAt
          ? new Date(commandResult.operationCompletedAt)
          : consumedAt;

        loop.commandIndex += 1;

        if (commandResult.commandStatus === "rejected") {
          setWorkflowState(this, loop);
          continue;
        }

        if (command.kind === "complete") {
          setPhase(loop, turnContext, "complete");
          loop.activeSession.settleTurn(loop.turn, "complete");
          setWorkflowState(this, loop);
          return { messages: turnContext.messages };
        }

        if (command.kind === "abort") {
          appendOperation(turnContext, command, {
            turn: loop.turn,
            operationIndex,
            stepKey: opStepKey,
            outcome: "aborted",
            errorMessage: commandResult.errorMessage ?? null,
            status: "aborted",
            assistant: null,
            createdAt: operationCreatedAt,
            completedAt: operationCompletedAt,
          });
          loop.activeSession.settleTurn(loop.turn, "waiting-for-command");
          loop.turn += 1;
          setWorkflowState(this, loop);
          continue;
        }

        if (command.kind === "steer") {
          appendOperation(turnContext, command, {
            turn: commandResult.turn ?? loop.turn,
            operationIndex,
            stepKey: opStepKey,
            outcome: "completed",
            status: currentTurnStatus(loop, turnContext),
            createdAt: operationCreatedAt,
            completedAt: operationCompletedAt,
          });
          setWorkflowState(this, loop);
          continue;
        }

        const parsed = parseOperationResult(commandResult, opStepName);
        turnContext.messages = parsed.messages;
        hydrateReplayCache(loop.replayCache, parsed.toolJournal);

        const status: PiTurnStatus =
          parsed.outcome === "completed"
            ? "completed"
            : parsed.outcome === "aborted"
              ? "aborted"
              : "waiting-to-continue";
        appendOperation(turnContext, command, {
          turn: loop.turn,
          operationIndex,
          stepKey: opStepKey,
          outcome: parsed.outcome,
          errorMessage: parsed.errorMessage,
          status,
          assistant: parsed.assistant,
          createdAt: operationCreatedAt,
          completedAt: operationCompletedAt,
        });

        if (parsed.outcome === "completed" || parsed.outcome === "aborted") {
          loop.activeSession.settleTurn(loop.turn, "waiting-for-command");
          loop.turn += 1;
        }
        setWorkflowState(this, loop);
      }

      return { messages: turnContext.messages };
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
