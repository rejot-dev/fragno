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
  workflowScriptPath: string | null;
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

export type UnmappedWorkflowRuntimeStep = {
  stepKey: string;
  stepRecordId?: string;
  name?: string;
  type?: string;
  status: WorkflowStepRunStatus;
  current: boolean;
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
  unmappedRuntimeSteps: readonly UnmappedWorkflowRuntimeStep[];
  hasUnmappedCurrentStep: boolean;
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
        instance.workflowScriptPath !== absolutePath
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

  const stepProjection = projectWorkflowStepStates({
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
    waitingEventTypes: currentWorkflowWaitingEventTypes(instance.workflowSteps),
    stepStatesByNodeId: stepProjection.stepStatesByNodeId,
    unmappedRuntimeSteps: stepProjection.unmappedRuntimeSteps,
    hasUnmappedCurrentStep: stepProjection.unmappedRuntimeSteps.some((step) => step.current),
  };
}

export function selectScriptWorkflowRun(
  runs: readonly ScriptWorkflowRun[],
  selectedInstanceId: string | null | undefined,
): ScriptWorkflowRun | null {
  return runs.find((run) => run.instanceId === selectedInstanceId) ?? runs.at(0) ?? null;
}

export function currentWorkflowWaitingEventTypes(
  steps: readonly Pick<
    WorkflowRunStep,
    "parentStepKey" | "status" | "stepKey" | "type" | "waitEventType"
  >[],
): string[] {
  const stepsByKey = new Map(steps.map((step) => [step.stepKey, step]));
  return [
    ...new Set(
      steps.flatMap((step) =>
        step.status === "waiting" &&
        step.type === "waitForEvent" &&
        step.waitEventType &&
        !hasTerminalWorkflowStepAncestor(step.stepKey, stepsByKey)
          ? [step.waitEventType]
          : [],
      ),
    ),
  ];
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
}): {
  stepStatesByNodeId: Map<string, WorkflowStepRunState>;
  unmappedRuntimeSteps: UnmappedWorkflowRuntimeStep[];
} {
  const resolveStepNodeId = createWorkflowStepNodeResolver(
    indexWorkflowStepNodes(visualization, workflowName),
  );
  const nodeIdByStepKey = new Map<string, string>();
  const stepStatesByNodeId = new Map<string, WorkflowStepRunState>();
  const unmappedRuntimeStepsByKey = new Map<string, UnmappedWorkflowRuntimeStep>();

  const orderedSteps = [...steps].sort(compareWorkflowEvents);
  const stepsByKey = new Map(orderedSteps.map((step) => [step.stepKey, step]));
  for (const step of orderedSteps) {
    const nodeId = resolveStepNodeId(step.stepKey);
    if (!nodeId) {
      unmappedRuntimeStepsByKey.set(step.stepKey, {
        stepKey: step.stepKey,
        stepRecordId: step.id,
        name: step.name,
        type: step.type,
        status: step.status,
        current:
          step.status === "waiting" && !hasTerminalWorkflowStepAncestor(step.stepKey, stepsByKey),
      });
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
    const nodeId = nodeIdByStepKey.get(activity.stepKey) ?? resolveStepNodeId(activity.stepKey);
    if (!nodeId) {
      if (activity.active && !hasTerminalWorkflowStepAncestor(activity.stepKey, stepsByKey)) {
        const existing = unmappedRuntimeStepsByKey.get(activity.stepKey);
        unmappedRuntimeStepsByKey.set(activity.stepKey, {
          stepKey: activity.stepKey,
          ...(existing?.stepRecordId ? { stepRecordId: existing.stepRecordId } : {}),
          ...(existing?.name ? { name: existing.name } : {}),
          ...(existing?.type ? { type: existing.type } : {}),
          status: "active",
          current: true,
        });
      }
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

  return {
    stepStatesByNodeId,
    unmappedRuntimeSteps: [...unmappedRuntimeStepsByKey.values()],
  };
}

const TERMINAL_WORKFLOW_STEP_STATUSES = new Set<PersistedWorkflowStepStatus>([
  "completed",
  "errored",
]);

type DynamicWorkflowStepNode = {
  nodeId: string;
  parentId: string;
  repeating: boolean;
  templateKey: string;
  staticNameParts: readonly string[];
};

type DynamicWorkflowStepFamilyMatch = {
  key: string;
  nodeIds: string[];
};

type WorkflowStepNodeIndex = {
  nodeIdsByScopeAndIdentity: Map<string, string[]>;
  dynamicNodesByScopeAndType: Map<string, DynamicWorkflowStepNode[]>;
  sourceOrderByNodeId: Map<string, number>;
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
  const dynamicNodesByScopeAndType = new Map<string, DynamicWorkflowStepNode[]>();
  const sourceOrderByNodeId = new Map(stepNodes.map((step) => [step.id, step.sourceOrder]));

  for (const step of stepNodes) {
    const parentStepNodeId = nearestAncestorStepNodeId(step.parentId, nodesById);
    const scope = parentStepNodeId ?? ROOT_STEP_SCOPE;
    const type = runtimeStepType(step);
    if (step.nameTemplate) {
      const scopedType = workflowStepScopedType(scope, type);
      const dynamicNodes = dynamicNodesByScopeAndType.get(scopedType) ?? [];
      dynamicNodes.push({
        nodeId: step.id,
        parentId: step.parentId,
        repeating: hasLoopAncestor(step.parentId, nodesById),
        templateKey: workflowStepNameTemplateKey(step.nameTemplate.staticParts),
        staticNameParts: step.nameTemplate.staticParts,
      });
      dynamicNodesByScopeAndType.set(scopedType, dynamicNodes);
      continue;
    }

    const identity = workflowStepIdentity(type, step.label);
    const scopedIdentity = workflowStepScopedIdentity(scope, identity);
    const nodeIds = nodeIdsByScopeAndIdentity.get(scopedIdentity) ?? [];
    nodeIds.push(step.id);
    nodeIdsByScopeAndIdentity.set(scopedIdentity, nodeIds);
  }

  return { nodeIdsByScopeAndIdentity, dynamicNodesByScopeAndType, sourceOrderByNodeId };
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

function hasLoopAncestor(
  parentId: string,
  nodesById: ReadonlyMap<string, WorkflowVisualizationSnapshot["graph"]["nodes"][number]>,
): boolean {
  let ancestor = nodesById.get(parentId);
  while (ancestor && ancestor.kind !== "workflow") {
    if (ancestor.kind === "loop") {
      return true;
    }
    ancestor = nodesById.get(ancestor.parentId);
  }
  return false;
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

function workflowStepScopedType(scope: string, type: string): string {
  return `${scope}\u0000${type}`;
}

function createWorkflowStepNodeResolver(
  index: WorkflowStepNodeIndex,
): (stepKey: string) => string | undefined {
  const nodeIdByRuntimePath = new Map<string, string>();
  const nextOrdinalByDynamicFamily = new Map<string, number>();

  return function resolveWorkflowStepNodeId(stepKey: string): string | undefined {
    let parsedStepKey: ReturnType<typeof parseStepKey>;
    try {
      parsedStepKey = parseStepKey(stepKey);
    } catch {
      return undefined;
    }

    let scope = ROOT_STEP_SCOPE;
    let runtimePath = ROOT_STEP_SCOPE;
    let nodeId: string | undefined;

    for (const identity of parsedStepKey.segments) {
      runtimePath = workflowStepRuntimePath(runtimePath, identity);
      const previouslyResolvedNodeId = nodeIdByRuntimePath.get(runtimePath);
      if (previouslyResolvedNodeId) {
        nodeId = previouslyResolvedNodeId;
        scope = nodeId;
        continue;
      }

      const exactCandidates = index.nodeIdsByScopeAndIdentity.get(
        workflowStepScopedIdentity(scope, workflowStepIdentity(identity.type, identity.name)),
      );
      const dynamicFamily = matchingDynamicWorkflowStepFamily({
        nodes: index.dynamicNodesByScopeAndType.get(workflowStepScopedType(scope, identity.type)),
        runtimeName: identity.name,
      });

      if (exactCandidates?.length) {
        const dynamicCandidateNodeIds = dynamicFamily ? new Set(dynamicFamily.nodeIds) : undefined;
        const candidates = dynamicFamily
          ? [...exactCandidates, ...dynamicFamily.nodeIds].sort(
              (left, right) =>
                (index.sourceOrderByNodeId.get(left) ?? 0) -
                (index.sourceOrderByNodeId.get(right) ?? 0),
            )
          : exactCandidates;
        nodeId = candidates[identity.occurrence];

        if (nodeId && dynamicFamily && dynamicCandidateNodeIds?.has(nodeId)) {
          const family = workflowStepDynamicFamily(scope, identity.type, dynamicFamily.key);
          const ordinal = nextOrdinalByDynamicFamily.get(family) ?? 0;
          nextOrdinalByDynamicFamily.set(family, ordinal + 1);
        }
      } else {
        if (!dynamicFamily) {
          return undefined;
        }

        const family = workflowStepDynamicFamily(scope, identity.type, dynamicFamily.key);
        const ordinal = nextOrdinalByDynamicFamily.get(family) ?? 0;
        nodeId = dynamicFamily.nodeIds[ordinal % dynamicFamily.nodeIds.length];
        nextOrdinalByDynamicFamily.set(family, ordinal + 1);
      }

      if (!nodeId) {
        return undefined;
      }
      nodeIdByRuntimePath.set(runtimePath, nodeId);
      scope = nodeId;
    }

    return nodeId;
  };
}

function workflowStepRuntimePath(
  parentPath: string,
  identity: ReturnType<typeof parseStepKey>["segments"][number],
): string {
  return `${parentPath}\u0000${identity.type}\u0000${identity.name}\u0000${identity.occurrence}`;
}

function workflowStepDynamicFamily(scope: string, type: string, templateFamily: string): string {
  return `${scope}\u0000${type}\u0000${templateFamily}`;
}

function workflowStepNameTemplateKey(staticParts: readonly string[]): string {
  return JSON.stringify(staticParts);
}

function matchingDynamicWorkflowStepFamily({
  nodes,
  runtimeName,
}: {
  nodes: readonly DynamicWorkflowStepNode[] | undefined;
  runtimeName: string;
}): DynamicWorkflowStepFamilyMatch | undefined {
  const matchingNodes = nodes?.filter((node) =>
    workflowStepNameMatchesTemplate(runtimeName, node.staticNameParts),
  );
  if (!matchingNodes?.length) {
    return undefined;
  }

  const greatestStaticLength = Math.max(
    ...matchingNodes.map((node) =>
      node.staticNameParts.reduce((length, part) => length + part.length, 0),
    ),
  );
  const mostSpecificNodes = matchingNodes.filter(
    (node) =>
      node.staticNameParts.reduce((length, part) => length + part.length, 0) ===
      greatestStaticLength,
  );
  const templateKeys = new Set(mostSpecificNodes.map((node) => node.templateKey));
  const parentIds = new Set(mostSpecificNodes.map((node) => node.parentId));
  if (
    templateKeys.size !== 1 ||
    parentIds.size !== 1 ||
    (mostSpecificNodes.length > 1 && mostSpecificNodes.some((node) => node.repeating))
  ) {
    return undefined;
  }

  const templateKey = mostSpecificNodes[0]?.templateKey;
  const parentId = mostSpecificNodes[0]?.parentId;
  if (!templateKey || !parentId) {
    return undefined;
  }
  return {
    key: `${parentId}\u0000${templateKey}`,
    nodeIds: mostSpecificNodes.map((node) => node.nodeId),
  };
}

function workflowStepNameMatchesTemplate(
  runtimeName: string,
  staticParts: readonly string[],
): boolean {
  const firstPart = staticParts[0];
  const lastPart = staticParts.at(-1);
  if (firstPart === undefined || lastPart === undefined || !runtimeName.startsWith(firstPart)) {
    return false;
  }

  let searchStart = firstPart.length;
  for (const part of staticParts.slice(1, -1)) {
    const partIndex = runtimeName.indexOf(part, searchStart);
    if (partIndex < 0) {
      return false;
    }
    searchStart = partIndex + part.length;
  }

  return runtimeName.slice(searchStart).endsWith(lastPart);
}

function hasTerminalWorkflowStepAncestor(
  stepKey: string,
  stepsByKey: ReadonlyMap<string, Pick<WorkflowRunStep, "parentStepKey" | "status" | "stepKey">>,
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
