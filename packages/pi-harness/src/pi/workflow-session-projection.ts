import type { SessionTreeEntry } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";

import { projectPiCompactCommandOutcomes } from "./compact-command-outcome-projection";
import type { PiHarnessEncodedEventEmission } from "./harness/agent-harness-event-protocol";
import type {
  PiHarnessFrontendAgentMessage,
  PiHarnessFrontendAssistantMessage,
} from "./harness/agent-harness-event-protocol";
import type {
  PiSessionActiveCommand,
  PiSessionCommandStartEmission,
} from "./session-command-protocol";
import {
  asPersistedPiHarnessStepResult,
  latestCompletedPiHarnessEntries,
  projectPiSessionEntries,
} from "./session-entry-projection";
import type { PiCompactCommandOutcome, PiWorkflowStatus } from "./types";
import {
  createPiWorkflowSessionEmissionReducer,
  isPiWorkflowStepActive,
  projectPiWorkflowSessionLiveOverlay,
  reducePiWorkflowSessionEmission,
} from "./workflow-session-live-projection";
import type {
  PiHarnessOperationCompleteEmission,
  PiHarnessOperationStartEmission,
  PiHarnessSessionEntryEmission,
} from "./workflows/workflow-agent-harness";

export type PiSessionProjectionStatus = "loading" | "ready" | "not-found";

export type DraftAgentActivity =
  | "starting"
  | "thinking"
  | "writing"
  | "tool_calling"
  | "running_tools";

export interface DraftTool {
  id: string;
  name: string;
  args: unknown;
  argsText?: string;
  status: "starting" | "running" | "done";
  partialResult?: unknown;
  result?: unknown;
  resultMessage?: ToolResultMessage;
  isError?: boolean;
}

export interface DraftAgentMessage {
  activity: DraftAgentActivity;
  assistant?: PiHarnessFrontendAssistantMessage;
  tools: Record<string, DraftTool>;
  startedAt: number;
  updatedAt: number;
}

export type PiSessionActivity = DraftAgentActivity | "working" | null;

type PiWorkflowSessionProjectionData = {
  contextMessages: PiHarnessFrontendAgentMessage[];
  timelineMessages: PiHarnessFrontendAgentMessage[];
  completedStepKeys: string[];
  draftAgentMessage: DraftAgentMessage | null;
  activeCommand: PiSessionActiveCommand | null;
  compactOutcomesByCommandId: Readonly<Record<string, PiCompactCommandOutcome>>;
  latestCommandCompactOutcome: PiCompactCommandOutcome | null;
};

export type PiWorkflowSessionProjectionState =
  | (PiWorkflowSessionProjectionData & {
      status: "loading";
      error: null;
      readyForInput: false;
      activity: null;
    })
  | (PiWorkflowSessionProjectionData & {
      status: "ready";
      error: null;
      readyForInput: boolean;
      activity: PiSessionActivity;
    })
  | (PiWorkflowSessionProjectionData & {
      status: "not-found";
      error: Error;
      readyForInput: false;
      activity: null;
    });

export type PiWorkflowSessionProjectionStep = {
  stepKey: string;
  type: string;
  status: string;
  waitEventType: string | null;
  result: unknown;
};

export type PiWorkflowSessionProjectionEmission = {
  stepKey: string;
  executionId: string;
  epoch: string;
  sequence: number;
  payload:
    | PiHarnessEncodedEventEmission
    | PiHarnessSessionEntryEmission
    | PiHarnessOperationStartEmission
    | PiHarnessOperationCompleteEmission
    | PiSessionCommandStartEmission
    | { kind: undefined; control: string }
    | null;
  createdAt: Date;
};

export type PiWorkflowSessionProjectionInstance = {
  status: PiWorkflowStatus;
};

const zeroUsage = (): PiHarnessFrontendAssistantMessage["usage"] => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
});

const interruptionTimestamp = (entry: SessionTreeEntry | undefined): number => {
  if (!entry) {
    return 0;
  }
  if (entry.type === "message") {
    return entry.message.timestamp;
  }

  const timestamp = new Date(entry.timestamp).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
};

const interruptedTimelineMessages = (
  steps: readonly PiWorkflowSessionProjectionStep[],
  sessionEntries: readonly SessionTreeEntry[],
): ReadonlyMap<string | null, readonly PiHarnessFrontendAgentMessage[]> => {
  const entriesById = new Map(sessionEntries.map((entry) => [entry.id, entry]));
  const messagesByLeafId = new Map<string | null, PiHarnessFrontendAgentMessage[]>();

  for (const step of steps) {
    if (step.status !== "completed") {
      continue;
    }
    const result = asPersistedPiHarnessStepResult(step.result);
    if (result?.outcome !== "aborted") {
      continue;
    }

    const leafEntry = result.leafId === null ? undefined : entriesById.get(result.leafId);
    if (
      leafEntry?.type === "message" &&
      leafEntry.message.role === "assistant" &&
      leafEntry.message.stopReason === "aborted"
    ) {
      continue;
    }

    const messages = messagesByLeafId.get(result.leafId) ?? [];
    messages.push({
      role: "assistant",
      content: [],
      usage: zeroUsage(),
      stopReason: "aborted",
      timestamp: interruptionTimestamp(leafEntry),
    });
    messagesByLeafId.set(result.leafId, messages);
  }

  return messagesByLeafId;
};

const emptyProjectionData = (): PiWorkflowSessionProjectionData => ({
  contextMessages: [],
  timelineMessages: [],
  completedStepKeys: [],
  draftAgentMessage: null,
  activeCommand: null,
  compactOutcomesByCommandId: {},
  latestCommandCompactOutcome: null,
});

export const createLoadingPiWorkflowSessionProjection = (): PiWorkflowSessionProjectionState => ({
  ...emptyProjectionData(),
  status: "loading",
  error: null,
  readyForInput: false,
  activity: null,
});

export const projectPiWorkflowSession = ({
  workflowName,
  sessionId,
  instance,
  workflowSteps,
  workflowStepEmissions = [],
}: {
  workflowName: string;
  sessionId: string;
  instance: PiWorkflowSessionProjectionInstance | null;
  workflowSteps: readonly PiWorkflowSessionProjectionStep[];
  workflowStepEmissions?: readonly PiWorkflowSessionProjectionEmission[];
}): PiWorkflowSessionProjectionState => {
  const identity = { workflowName, sessionId };
  const completedSteps = workflowSteps.filter((step) => step.status === "completed");
  const completedStepKeys = new Set(completedSteps.map((step) => step.stepKey));
  const sessionEntries = latestCompletedPiHarnessEntries(completedSteps);
  const projectedEntries = projectPiSessionEntries(sessionEntries, identity, {
    timelineMessagesAfterEntryId: interruptedTimelineMessages(completedSteps, sessionEntries),
  });

  if (instance === null) {
    return {
      ...emptyProjectionData(),
      ...projectedEntries,
      completedStepKeys: [...completedStepKeys],
      status: "not-found",
      error: new Error(`Pi session ${workflowName}/${sessionId} was not found.`),
      readyForInput: false,
      activity: null,
    };
  }

  const compactCommandOutcomes = projectPiCompactCommandOutcomes(workflowSteps, identity);
  const emissionReducer = createPiWorkflowSessionEmissionReducer(
    workflowSteps.some(isPiWorkflowStepActive),
  );
  for (const emission of workflowStepEmissions) {
    if (!completedStepKeys.has(emission.stepKey)) {
      reducePiWorkflowSessionEmission(emissionReducer, emission);
    }
  }
  const liveOverlay = projectPiWorkflowSessionLiveOverlay({
    ...projectedEntries,
    instanceStatus: instance.status,
    workflowSteps,
    live: emissionReducer.live,
  });

  return {
    ...liveOverlay,
    status: "ready",
    error: null,
    completedStepKeys: [...completedStepKeys],
    compactOutcomesByCommandId: compactCommandOutcomes.byCommandId,
    latestCommandCompactOutcome: compactCommandOutcomes.latestCommandCompactOutcome,
  };
};
