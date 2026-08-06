import type { AgentMessage, SessionTreeEntry } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";

import { projectPiCompactCommandOutcomes } from "./compact-command-outcome-projection";
import type {
  PiSessionActiveCommand,
  PiSessionCommandStartEmission,
} from "./session-command-protocol";
import {
  latestCompletedPiHarnessEntries,
  mergePiSessionEntries,
  projectPiSessionEntries,
} from "./session-entry-projection";
import type { PiCompactCommandOutcome, PiWorkflowStatus } from "./types";
import {
  createPiWorkflowSessionLiveState,
  isPiWorkflowStepActive,
  projectPiWorkflowSessionLiveOverlay,
  reducePiWorkflowSessionEmission,
} from "./workflow-session-live-projection";
import type { PiHarnessEmission } from "./workflows/workflow-agent-harness";

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
  assistant?: AssistantMessage;
  tools: Record<string, DraftTool>;
  startedAt: number;
  updatedAt: number;
}

export type PiSessionActivity = DraftAgentActivity | "working" | null;

type PiWorkflowSessionProjectionData = {
  contextMessages: AgentMessage[];
  timelineMessages: AgentMessage[];
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
  payload:
    | PiHarnessEmission
    | PiSessionCommandStartEmission
    | { kind: undefined; control: string }
    | null;
  createdAt: Date;
};

export type PiWorkflowSessionProjectionInstance = {
  status: PiWorkflowStatus;
};

export type PiWorkflowSessionProjectionBaseline = {
  sessionEntries: readonly SessionTreeEntry[];
  completedStepKeys: readonly string[];
  compactOutcomesByCommandId: Readonly<Record<string, PiCompactCommandOutcome>>;
  latestCommandCompactOutcome: PiCompactCommandOutcome | null;
};

export type PiWorkflowSessionProjectionOptions = {
  baseline?: PiWorkflowSessionProjectionBaseline;
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

export const createLoadingPiWorkflowSessionProjection = ({
  workflowName,
  sessionId,
  baseline,
}: {
  workflowName: string;
  sessionId: string;
  baseline?: PiWorkflowSessionProjectionBaseline;
}): PiWorkflowSessionProjectionState => {
  if (!baseline) {
    return {
      ...emptyProjectionData(),
      status: "loading",
      error: null,
      readyForInput: false,
      activity: null,
    };
  }

  const projectedEntries = projectPiSessionEntries(baseline.sessionEntries, {
    workflowName,
    sessionId,
  });
  return {
    ...emptyProjectionData(),
    ...projectedEntries,
    completedStepKeys: [...baseline.completedStepKeys],
    compactOutcomesByCommandId: { ...baseline.compactOutcomesByCommandId },
    latestCommandCompactOutcome: baseline.latestCommandCompactOutcome,
    status: "loading",
    error: null,
    readyForInput: false,
    activity: null,
  };
};

export const projectPiWorkflowSession = ({
  workflowName,
  sessionId,
  instance,
  workflowSteps,
  workflowStepEmissions = [],
  baseline,
}: {
  workflowName: string;
  sessionId: string;
  instance: PiWorkflowSessionProjectionInstance | null;
  workflowSteps: readonly PiWorkflowSessionProjectionStep[];
  workflowStepEmissions?: readonly PiWorkflowSessionProjectionEmission[];
} & PiWorkflowSessionProjectionOptions): PiWorkflowSessionProjectionState => {
  const identity = { workflowName, sessionId };
  const baselineCompletedStepKeys = new Set(baseline?.completedStepKeys ?? []);
  const localCompletedSteps = workflowSteps.filter((step) => step.status === "completed");
  const completedStepKeys = new Set([
    ...baselineCompletedStepKeys,
    ...localCompletedSteps.map((step) => step.stepKey),
  ]);

  const localEntries = latestCompletedPiHarnessEntries(
    baseline
      ? localCompletedSteps.filter((step) => !baselineCompletedStepKeys.has(step.stepKey))
      : localCompletedSteps,
  );
  const sessionEntries = baseline
    ? mergePiSessionEntries(baseline.sessionEntries, localEntries)
    : localEntries;
  const projectedEntries = projectPiSessionEntries(sessionEntries, identity);

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
  const live = createPiWorkflowSessionLiveState(workflowSteps.some(isPiWorkflowStepActive));
  for (const emission of workflowStepEmissions) {
    if (!completedStepKeys.has(emission.stepKey)) {
      reducePiWorkflowSessionEmission(live, emission);
    }
  }
  const liveOverlay = projectPiWorkflowSessionLiveOverlay({
    ...projectedEntries,
    instanceStatus: instance.status,
    workflowSteps,
    live,
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
