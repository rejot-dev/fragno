import {
  projectWorkflowStepExecutionActivity,
  selectCanonicalWorkflowStepEmissions,
} from "@fragno-dev/workflows/step-emission-control";
import { parseStepKey, ROOT_STEP_SCOPE } from "@fragno-dev/workflows/step-identity";

import type {
  StepNode,
  WorkflowVisualizationSnapshot,
} from "@fragno-dev/workflow-visualizer-tokens";

const ACTIVE_WORKFLOW_STATUSES = new Set(["active", "waiting", "paused"]);

type WorkflowRunTimestamp = Date | string;

type PersistedWorkflowStepStatus = "waiting" | "completed" | "errored";
export type WorkflowStepRunStatus = PersistedWorkflowStepStatus | "active";

export type WorkflowRunStep = {
  id: string;
  stepKey: string;
  parentStepKey: string | null;
  name: string;
  type: string;
  status: PersistedWorkflowStepStatus;
  committedByExecutionId: string;
  attempts: number;
  waitEventType: string | null;
  result: unknown;
  errorName: string | null;
  errorMessage: string | null;
  createdAt: WorkflowRunTimestamp;
  updatedAt: WorkflowRunTimestamp;
};

export type WorkflowRunEvent = {
  id: string;
  actor: string;
  type: string;
  payload: unknown;
  createdAt: WorkflowRunTimestamp;
  deliveredAt: WorkflowRunTimestamp | null;
  consumedByStepKey: string | null;
};

export type WorkflowRunEmission = {
  id: string;
  actor: string;
  stepKey: string;
  executionId: string;
  epoch: string;
  sequence: number;
  payload: unknown;
  createdAt: WorkflowRunTimestamp;
};

export type AutomationWorkflowRun = {
  id: string;
  instanceId: string;
  workflowName: string;
  remoteWorkflowName: string | null;
  status: string;
  params: unknown;
  output: unknown;
  createdAt: WorkflowRunTimestamp;
  updatedAt: WorkflowRunTimestamp;
  workflowSteps: readonly WorkflowRunStep[];
  workflowEvents: readonly WorkflowRunEvent[];
  workflowStepEmissions: readonly WorkflowRunEmission[];
};

export type WorkflowStepRunState = {
  stepRecordId?: string;
  status: WorkflowStepRunStatus;
  attempts: number;
  completedAt?: WorkflowRunTimestamp;
  result?: unknown;
  error?: string;
  waitEventType?: string;
  emissionCount: number;
  current: boolean;
};

export type WorkflowRunReference = {
  workflowName: string;
  instanceId: string;
};

export type ScriptWorkflowRun = {
  id: string;
  instanceId: string;
  workflowName: string;
  instanceWorkflowName: string;
  status: string;
  output: unknown;
  createdAt: WorkflowRunTimestamp;
  updatedAt: WorkflowRunTimestamp;
  waitingEventTypes: readonly string[];
  workflowEvents: readonly WorkflowRunEvent[];
  stepStatesByNodeId: Map<string, WorkflowStepRunState>;
};

export function projectScriptWorkflowRuns({
  absolutePath,
  visualization,
  instances,
}: {
  absolutePath: string;
  visualization: WorkflowVisualizationSnapshot;
  instances: readonly AutomationWorkflowRun[];
}): ScriptWorkflowRun[] {
  const workflowNames = new Set(
    visualization.graph.nodes.flatMap((node) => (node.kind === "workflow" ? [node.name] : [])),
  );

  return instances
    .flatMap((instance): ScriptWorkflowRun[] => {
      const workflowName = instance.remoteWorkflowName;
      if (
        !workflowName ||
        !ACTIVE_WORKFLOW_STATUSES.has(instance.status) ||
        !workflowNames.has(workflowName) ||
        workflowScriptPathFromParams(instance.params) !== absolutePath
      ) {
        return [];
      }

      const run = projectWorkflowRun({ visualization, instance });
      return run ? [run] : [];
    })
    .sort(
      (left, right) =>
        timestamp(right.updatedAt) - timestamp(left.updatedAt) ||
        right.instanceId.localeCompare(left.instanceId),
    );
}

export function projectWorkflowRun({
  visualization,
  instance,
}: {
  visualization: WorkflowVisualizationSnapshot;
  instance: AutomationWorkflowRun;
}): ScriptWorkflowRun | null {
  const workflowName = instance.remoteWorkflowName;
  const workflowExists = visualization.graph.nodes.some(
    (node) => node.kind === "workflow" && node.name === workflowName,
  );
  if (!workflowName || !workflowExists) {
    return null;
  }

  const stepStatesByNodeId = projectWorkflowStepStates({
    visualization,
    workflowName,
    steps: instance.workflowSteps,
    emissions: instance.workflowStepEmissions,
  });

  return {
    id: instance.id,
    instanceId: instance.instanceId,
    workflowName,
    instanceWorkflowName: instance.workflowName,
    status: instance.status,
    output: instance.output,
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt,
    workflowEvents: instance.workflowEvents,
    waitingEventTypes: [
      ...new Set(
        [...stepStatesByNodeId.values()].flatMap((state) =>
          state.current && state.status === "waiting" && state.waitEventType
            ? [state.waitEventType]
            : [],
        ),
      ),
    ],
    stepStatesByNodeId,
  };
}

export function selectScriptWorkflowRun(
  runs: readonly ScriptWorkflowRun[],
  selectedInstanceId: string | null | undefined,
): ScriptWorkflowRun | null {
  return runs.find((run) => run.instanceId === selectedInstanceId) ?? runs.at(0) ?? null;
}

function projectWorkflowStepStates({
  visualization,
  workflowName,
  steps,
  emissions,
}: {
  visualization: WorkflowVisualizationSnapshot;
  workflowName: string;
  steps: readonly WorkflowRunStep[];
  emissions: readonly WorkflowRunEmission[];
}): Map<string, WorkflowStepRunState> {
  const stepNodeIndex = indexWorkflowStepNodes(visualization, workflowName);
  const nodeIdByStepKey = new Map<string, string>();
  const stepStatesByNodeId = new Map<string, WorkflowStepRunState>();

  const orderedSteps = [...steps].sort(compareWorkflowEvents);
  const stepsByKey = new Map(orderedSteps.map((step) => [step.stepKey, step]));
  for (const step of orderedSteps) {
    const nodeId = workflowStepNodeIdFromKey(step.stepKey, stepNodeIndex);
    if (!nodeId) {
      continue;
    }

    nodeIdByStepKey.set(step.stepKey, nodeId);
    const error = workflowStepError(step);
    stepStatesByNodeId.set(nodeId, {
      stepRecordId: step.id,
      status: step.status,
      attempts: step.attempts,
      ...(step.status === "completed" ? { completedAt: step.updatedAt } : {}),
      ...(step.result !== null && step.result !== undefined ? { result: step.result } : {}),
      ...(error ? { error } : {}),
      ...(step.status === "waiting" && step.type === "waitForEvent" && step.waitEventType
        ? { waitEventType: step.waitEventType }
        : {}),
      emissionCount: 0,
      current:
        step.status === "waiting" && !hasTerminalWorkflowStepAncestor(step.stepKey, stepsByKey),
    });
  }

  const canonicalEmissions = selectCanonicalWorkflowStepEmissions({ steps, emissions });
  const activityByNodeId = new Map<string, { active: boolean; userEmissionCount: number }>();
  for (const activity of projectWorkflowStepExecutionActivity(canonicalEmissions)) {
    const nodeId =
      nodeIdByStepKey.get(activity.stepKey) ??
      workflowStepNodeIdFromKey(activity.stepKey, stepNodeIndex);
    if (!nodeId) {
      continue;
    }

    const nodeActivity = activityByNodeId.get(nodeId) ?? {
      active: false,
      userEmissionCount: 0,
    };
    nodeActivity.active ||=
      activity.active && !hasTerminalWorkflowStepAncestor(activity.stepKey, stepsByKey);
    nodeActivity.userEmissionCount += activity.userEmissionCount;
    activityByNodeId.set(nodeId, nodeActivity);
  }

  for (const [nodeId, activity] of activityByNodeId) {
    const existing = stepStatesByNodeId.get(nodeId);
    if (!existing && !activity.active) {
      continue;
    }

    const status = activity.active ? "active" : (existing?.status ?? "active");
    stepStatesByNodeId.set(nodeId, {
      ...(existing?.stepRecordId ? { stepRecordId: existing.stepRecordId } : {}),
      status,
      attempts: existing?.attempts ?? 1,
      ...(status === "completed" && existing?.completedAt
        ? { completedAt: existing.completedAt }
        : {}),
      ...(existing?.result !== undefined ? { result: existing.result } : {}),
      ...(existing?.error ? { error: existing.error } : {}),
      ...(existing?.waitEventType ? { waitEventType: existing.waitEventType } : {}),
      emissionCount: activity.userEmissionCount,
      current: activity.active || existing?.current === true,
    });
  }

  return stepStatesByNodeId;
}

const TERMINAL_WORKFLOW_STEP_STATUSES = new Set<PersistedWorkflowStepStatus>([
  "completed",
  "errored",
]);

type WorkflowStepNodeIndex = {
  nodeIdsByScopeAndIdentity: Map<string, string[]>;
};

function indexWorkflowStepNodes(
  visualization: WorkflowVisualizationSnapshot,
  workflowName: string,
): WorkflowStepNodeIndex {
  const nodesById = new Map(visualization.graph.nodes.map((node) => [node.id, node]));
  const stepNodes = visualization.graph.nodes
    .filter((node): node is StepNode => node.kind === "step" && node.workflowName === workflowName)
    .sort((left, right) => left.sourceOrder - right.sourceOrder);
  const nodeIdsByScopeAndIdentity = new Map<string, string[]>();

  for (const step of stepNodes) {
    const parentStepNodeId = nearestAncestorStepNodeId(step.parentId, nodesById);
    const scope = parentStepNodeId ?? ROOT_STEP_SCOPE;
    const identity = workflowStepIdentity(runtimeStepType(step), step.label);
    const scopedIdentity = workflowStepScopedIdentity(scope, identity);
    const nodeIds = nodeIdsByScopeAndIdentity.get(scopedIdentity) ?? [];
    nodeIds.push(step.id);
    nodeIdsByScopeAndIdentity.set(scopedIdentity, nodeIds);
  }

  return { nodeIdsByScopeAndIdentity };
}

function nearestAncestorStepNodeId(
  parentId: string,
  nodesById: ReadonlyMap<string, WorkflowVisualizationSnapshot["graph"]["nodes"][number]>,
): string | undefined {
  let ancestor = nodesById.get(parentId);
  while (ancestor && ancestor.kind !== "workflow") {
    if (ancestor.kind === "step") {
      return ancestor.id;
    }
    ancestor = nodesById.get(ancestor.parentId);
  }
  return undefined;
}

function runtimeStepType(step: StepNode): string {
  return step.stepType === "sleepUntil" ? "sleep" : step.stepType;
}

function workflowStepIdentity(type: string, name: string): string {
  return `${type}\u0000${name}`;
}

function workflowStepScopedIdentity(scope: string, identity: string): string {
  return `${scope}\u0000${identity}`;
}

function workflowStepNodeIdFromKey(
  stepKey: string,
  index: WorkflowStepNodeIndex,
): string | undefined {
  let parsedStepKey: ReturnType<typeof parseStepKey>;
  try {
    parsedStepKey = parseStepKey(stepKey);
  } catch {
    return undefined;
  }

  let scope = ROOT_STEP_SCOPE;
  let nodeId: string | undefined;

  for (const identity of parsedStepKey.segments) {
    const candidates = index.nodeIdsByScopeAndIdentity.get(
      workflowStepScopedIdentity(scope, workflowStepIdentity(identity.type, identity.name)),
    );
    if (!candidates?.length) {
      return undefined;
    }

    nodeId = candidates[Math.min(identity.occurrence, candidates.length - 1)];
    scope = nodeId;
  }

  return nodeId;
}

function hasTerminalWorkflowStepAncestor(
  stepKey: string,
  stepsByKey: ReadonlyMap<string, WorkflowRunStep>,
): boolean {
  let parentStepKey =
    stepsByKey.get(stepKey)?.parentStepKey ?? workflowStepParentKeyFromIdentity(stepKey);
  const visitedStepKeys = new Set<string>();

  while (parentStepKey && !visitedStepKeys.has(parentStepKey)) {
    visitedStepKeys.add(parentStepKey);
    const parentStep = stepsByKey.get(parentStepKey);
    if (parentStep && TERMINAL_WORKFLOW_STEP_STATUSES.has(parentStep.status)) {
      return true;
    }
    parentStepKey = parentStep?.parentStepKey ?? workflowStepParentKeyFromIdentity(parentStepKey);
  }

  return false;
}

function workflowStepParentKeyFromIdentity(stepKey: string): string | null | undefined {
  try {
    return parseStepKey(stepKey).parentStepKey;
  } catch {
    return undefined;
  }
}

function workflowScriptPathFromParams(params: unknown): string | null {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return null;
  }

  const workflowScriptPath = (params as Record<string, unknown>).workflowScriptPath;
  return typeof workflowScriptPath === "string" ? workflowScriptPath : null;
}

function workflowStepError(step: WorkflowRunStep): string | undefined {
  if (!step.errorName && !step.errorMessage) {
    return undefined;
  }
  if (!step.errorName) {
    return step.errorMessage ?? undefined;
  }
  if (!step.errorMessage) {
    return step.errorName;
  }
  return `${step.errorName}: ${step.errorMessage}`;
}

function compareWorkflowEvents(
  left: { id: string; createdAt: WorkflowRunTimestamp },
  right: { id: string; createdAt: WorkflowRunTimestamp },
): number {
  return timestamp(left.createdAt) - timestamp(right.createdAt) || left.id.localeCompare(right.id);
}

function timestamp(value: WorkflowRunTimestamp): number {
  const date = value instanceof Date ? value : new Date(value);
  const valueOf = date.valueOf();
  if (!Number.isFinite(valueOf)) {
    throw new Error("INVALID_WORKFLOW_RUN_TIMESTAMP");
  }
  return valueOf;
}
