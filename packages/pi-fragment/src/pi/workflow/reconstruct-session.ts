import type { AgentMessage } from "@mariozechner/pi-agent-core";

import { extractAssistantTextFromMessage } from "../mappers";
import type {
  PiAgentLoopLiveState,
  PiAgentLoopSerializableState,
  PiSessionCommandPayload,
  PiSessionCommandRecord,
  PiSessionDetailProjection,
  PiTurnSummary,
} from "../types";

export type WorkflowHistoryEventRow = {
  payload?: unknown;
  createdAt: Date;
  consumedByStepKey: string | null;
};

export type WorkflowHistoryStepRow = {
  stepKey: string;
  result: unknown;
};

type CommandStepResultProjection = {
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
  outcome?: "completed" | "errored" | "aborted";
  errorMessage?: string | null;
  messages?: unknown[];
  trace?: unknown[];
  assistant?: AgentMessage | null;
};

export const isCommandPayload = (value: unknown): value is PiSessionCommandPayload => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const payload = value as { commandId?: unknown; kind?: unknown };
  if (typeof payload.commandId !== "string" || typeof payload.kind !== "string") {
    return false;
  }
  return ["prompt", "continue", "abort", "steer", "followUp", "complete"].includes(payload.kind);
};

const asDate = (value: unknown): Date | null => {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
};

const parseCommandStepResult = (value: unknown): CommandStepResultProjection | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const result = value as Record<string, unknown>;
  const commandId = result["commandId"];
  const commandStatus = result["commandStatus"];
  const stepKey = result["stepKey"];
  const commandCreatedAt = asDate(result["commandCreatedAt"]);
  const consumedAt = asDate(result["consumedAt"]);
  if (
    typeof commandId !== "string" ||
    (commandStatus !== "applied" && commandStatus !== "rejected") ||
    typeof stepKey !== "string" ||
    !commandCreatedAt ||
    !consumedAt
  ) {
    return null;
  }

  const rawOutcome = result["outcome"];
  const outcome =
    rawOutcome === "completed" || rawOutcome === "errored" || rawOutcome === "aborted"
      ? rawOutcome
      : undefined;
  const rejectionReason = result["rejectionReason"];
  const turn = result["turn"];
  const operationIndex = result["operationIndex"];
  const errorMessage = result["errorMessage"];
  const messages = result["messages"];
  const trace = result["trace"];

  return {
    commandId,
    commandStatus,
    rejectionReason: typeof rejectionReason === "string" ? rejectionReason : null,
    turn: typeof turn === "number" ? turn : null,
    operationIndex: typeof operationIndex === "number" ? operationIndex : null,
    stepKey,
    commandCreatedAt,
    consumedAt,
    operationCreatedAt: asDate(result["operationCreatedAt"]) ?? undefined,
    operationCompletedAt: asDate(result["operationCompletedAt"]) ?? undefined,
    outcome,
    errorMessage: typeof errorMessage === "string" ? errorMessage : null,
    messages: Array.isArray(messages) ? messages : undefined,
    trace: Array.isArray(trace) ? trace : undefined,
    assistant: result["assistant"] as AgentMessage | null | undefined,
  };
};

const upsertTurn = (turns: PiTurnSummary[], next: PiTurnSummary): PiTurnSummary[] => {
  const index = turns.findIndex((turn) => turn.turn === next.turn);
  return index >= 0
    ? [...turns.slice(0, index), next, ...turns.slice(index + 1)]
    : [...turns, next];
};

const getTurn = (turns: PiTurnSummary[], turn: number): PiTurnSummary =>
  turns.find((entry) => entry.turn === turn) ?? {
    turn,
    status: "idle",
    assistant: null,
    summary: null,
    operations: [],
  };

export const reconstructSessionProjection = (
  initialMessages: AgentMessage[],
  events: WorkflowHistoryEventRow[],
  steps: WorkflowHistoryStepRow[],
): PiSessionDetailProjection => {
  let messages = initialMessages;
  let trace: PiSessionDetailProjection["trace"] = [];
  let turns: PiTurnSummary[] = [];
  const commandHistory: PiSessionCommandRecord[] = [];
  const commandsById = new Map<string, PiSessionCommandPayload>();

  for (const event of events) {
    if (isCommandPayload(event.payload)) {
      commandsById.set(event.payload.commandId, event.payload);
    }
  }

  const commandResults = steps
    .map((step) => parseCommandStepResult(step.result))
    .filter((result): result is CommandStepResultProjection => result !== null)
    .sort((left, right) => left.consumedAt.getTime() - right.consumedAt.getTime());

  for (const result of commandResults) {
    const command = commandsById.get(result.commandId);
    if (!command) {
      continue;
    }

    commandHistory.push({
      commandId: result.commandId,
      kind: command.kind,
      turn: result.turn,
      stepKey: result.stepKey,
      commandStatus: result.commandStatus,
      rejectionReason: result.rejectionReason,
      createdAt: result.commandCreatedAt,
      consumedAt: result.consumedAt,
    });

    if (result.commandStatus === "rejected") {
      if (result.turn !== null) {
        turns = upsertTurn(turns, getTurn(turns, result.turn));
      }
      continue;
    }
    if (command.kind === "complete") {
      continue;
    }

    const turn = result.turn ?? 0;
    const existingTurn = getTurn(turns, turn);
    const operationIndex = result.operationIndex ?? existingTurn.operations.length;
    const assistant = result.assistant === undefined ? existingTurn.assistant : result.assistant;
    const outcome = result.outcome ?? "completed";
    const status =
      command.kind === "abort"
        ? "aborted"
        : outcome === "completed"
          ? "completed"
          : outcome === "aborted"
            ? "aborted"
            : "waiting-to-continue";

    if (result.messages) {
      messages = result.messages as PiSessionDetailProjection["messages"];
    }
    if (result.trace) {
      trace = [...trace, ...(result.trace as PiSessionDetailProjection["trace"])];
    }

    turns = upsertTurn(turns, {
      ...existingTurn,
      status,
      assistant: assistant ?? null,
      summary: assistant
        ? extractAssistantTextFromMessage(assistant) || null
        : existingTurn.summary,
      operations: [
        ...existingTurn.operations,
        {
          commandId: result.commandId,
          turn,
          operationIndex,
          kind: command.kind as "prompt" | "continue" | "abort" | "steer" | "followUp",
          stepKey: result.stepKey,
          outcome,
          errorMessage: result.errorMessage ?? null,
          createdAt: result.operationCreatedAt ?? result.consumedAt,
          completedAt: result.operationCompletedAt ?? result.consumedAt,
        },
      ],
    });
  }

  return { messages, events: [], trace, turns, commandHistory };
};

export const projectPendingCommandRecords = (
  events: WorkflowHistoryEventRow[],
  consumedRecords: PiSessionCommandRecord[],
): PiSessionCommandRecord[] => {
  const consumedIds = new Set(consumedRecords.map((record) => record.commandId));
  const pendingRecords = events.flatMap((event) => {
    if (event.consumedByStepKey !== null || !isCommandPayload(event.payload)) {
      return [];
    }
    if (consumedIds.has(event.payload.commandId)) {
      return [];
    }
    return [
      {
        commandId: event.payload.commandId,
        kind: event.payload.kind,
        turn: null,
        stepKey: null,
        commandStatus: "accepted" as const,
        rejectionReason: null,
        createdAt: event.createdAt,
        consumedAt: null,
      },
    ];
  });

  return [...consumedRecords, ...pendingRecords].sort(
    (left, right) => left.createdAt.getTime() - right.createdAt.getTime(),
  );
};

export const projectSessionDetailState = (
  liveState: PiAgentLoopLiveState,
  projection: PiSessionDetailProjection,
): PiAgentLoopSerializableState => ({
  ...projection,
  turn: liveState.turn,
  phase: liveState.phase,
  waitingFor: liveState.waitingFor,
});

export const projectSessionDetailFromWorkflowHistory = ({
  liveState,
  initialMessages = [],
  events,
  steps,
}: {
  liveState: PiAgentLoopLiveState;
  initialMessages?: AgentMessage[];
  events: WorkflowHistoryEventRow[];
  steps: WorkflowHistoryStepRow[];
}): PiAgentLoopSerializableState => {
  const projection = reconstructSessionProjection(initialMessages, events, steps);
  const detailState = projectSessionDetailState(liveState, projection);
  detailState.commandHistory = projectPendingCommandRecords(events, detailState.commandHistory);
  return detailState;
};
