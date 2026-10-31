import {
  isAbandonedWorkflowStep,
  pendingWaitEventTypes,
} from "@fragno-dev/workflows/pending-waits";
import {
  isWorkflowStepStartedControlPayload,
  projectWorkflowStepExecutionActivity,
  selectCanonicalWorkflowStepEmissions,
} from "@fragno-dev/workflows/step-emission-control";
import { parseStepKey, ROOT_STEP_SCOPE } from "@fragno-dev/workflows/step-identity";
import type { WorkflowInstanceStatus } from "@fragno-dev/workflows/workflow";
import {
  parseBackofficeUiResult,
  type BackofficeUiParseResult,
} from "@fragno-private/backoffice-ui/result";

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
  maxAttempts: number;
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

/** What started a Codemode run: an automation event, or a manual start with a payload. */
export type CodemodeWorkflowRunTrigger =
  | { type: "event"; source: string; eventType: string }
  | { type: "manual" };

/** The exact program a Codemode run executes, which may differ from the file's current source. */
export type CodemodeWorkflowRunProgram = {
  filename: string;
  code: string;
  trigger: CodemodeWorkflowRunTrigger;
  /** The agent whose conversation started the run; null for runs no agent started. */
  agentName: string | null;
};

export type AutomationWorkflowRun = {
  id: string;
  instanceId: string;
  workflowName: string;
  remoteWorkflowName: string | null;
  status: WorkflowInstanceStatus;
  /** `null` for workflows that are not Codemode scripts, such as Backoffice's own workflows. */
  codemode: CodemodeWorkflowRunProgram | null;
  output: unknown;
  errorName: string | null;
  errorMessage: string | null;
  createdAt: WorkflowRunTimestamp;
  updatedAt: WorkflowRunTimestamp;
  /** Stamped when the first tick commits, not when execution begins. */
  startedAt: WorkflowRunTimestamp | null;
  /** Set by every terminal transition. */
  completedAt: WorkflowRunTimestamp | null;
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

/**
 * One execution of a step, under its own step key: steps in a loop execute once per iteration.
 * Times are epoch milliseconds; `endedAt` is `null` while the execution is open.
 */
export type WorkflowStepRunExecution = {
  stepKey: string;
  /** `null` while its first attempt runs, since a step is only written once it settles. */
  stepRecordId: string | null;
  /** The name it ran under, which a dynamic step name fills in. */
  name: string;
  status: WorkflowStepRunStatus;
  attempts: number;
  maxAttempts: number;
  startedAt: number;
  endedAt: number | null;
  error: string | null;
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
  /** Oldest first. */
  stepExecutionsByNodeId: ReadonlyMap<string, readonly WorkflowStepRunExecution[]>;
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
        instance.codemode?.filename !== absolutePath
      ) {
        return [];
      }

      const run = projectWorkflowRun({ visualization, instance });
      return run ? [run] : [];
    })
    .sort(
      (left, right) =>
        workflowRunTime(right.updatedAt) - workflowRunTime(left.updatedAt) ||
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
    createdAt: workflowRunTime(instance.createdAt),
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
    waitingEventTypes: pendingWaitEventTypes({
      steps: instance.workflowSteps,
      events: instance.workflowEvents,
    }),
    stepStatesByNodeId: stepProjection.stepStatesByNodeId,
    stepExecutionsByNodeId: stepProjection.stepExecutionsByNodeId,
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

/** The interface a run presents: its own output, or else the latest completed step that returned one. */
export type WorkflowRunGeneratedUi<TStep> =
  | { type: "output"; parsed: Exclude<BackofficeUiParseResult, { kind: "ordinary" }> }
  | { type: "step"; step: TStep };

export function latestWorkflowRunGeneratedUi<
  TStep extends Pick<WorkflowRunStep, "status" | "result">,
>({
  output,
  steps,
}: {
  output: unknown;
  steps: readonly TStep[];
}): WorkflowRunGeneratedUi<TStep> | null {
  const parsedOutput = parseBackofficeUiResult(output);
  if (parsedOutput.kind !== "ordinary") {
    return { type: "output", parsed: parsedOutput };
  }
  const step = [...steps]
    .reverse()
    .find(
      (candidate) =>
        candidate.status === "completed" &&
        parseBackofficeUiResult(candidate.result).kind !== "ordinary",
    );
  return step ? { type: "step", step } : null;
}

function projectWorkflowStepStates({
  visualization,
  workflowName,
  steps,
  emissions,
  createdAt,
}: {
  visualization: WorkflowVisualizationSnapshot;
  workflowName: string;
  steps: readonly WorkflowRunStep[];
  emissions: readonly WorkflowRunEmission[];
  createdAt: number;
}): {
  stepStatesByNodeId: Map<string, WorkflowStepRunState>;
  stepExecutionsByNodeId: Map<string, WorkflowStepRunExecution[]>;
  unmappedRuntimeSteps: UnmappedWorkflowRuntimeStep[];
} {
  const resolveStepNodeId = createWorkflowStepNodeResolver(
    indexWorkflowStepNodes(visualization, workflowName),
  );
  const nodeIdByStepKey = new Map<string, string>();
  const stepStatesByNodeId = new Map<string, WorkflowStepRunState>();
  const unmappedRuntimeStepsByKey = new Map<string, UnmappedWorkflowRuntimeStep>();

  const stepExecutionsByNodeId = new Map<string, WorkflowStepRunExecution[]>();

  const orderedSteps = [...steps].sort(compareWorkflowEvents);
  const stepsByKey = new Map(orderedSteps.map((step) => [step.stepKey, step]));
  const stepStarts = inferWorkflowStepStarts(orderedSteps, createdAt);
  for (const step of orderedSteps) {
    const nodeId = resolveStepNodeId(step.stepKey);
    if (!nodeId) {
      unmappedRuntimeStepsByKey.set(step.stepKey, {
        stepKey: step.stepKey,
        stepRecordId: step.id,
        name: step.name,
        type: step.type,
        status: step.status,
        current: step.status === "waiting" && !isAbandonedWorkflowStep(step.stepKey, stepsByKey),
      });
      continue;
    }

    nodeIdByStepKey.set(step.stepKey, nodeId);
    const error = workflowStepError(step);
    recordStepExecution(stepExecutionsByNodeId, nodeId, {
      stepKey: step.stepKey,
      stepRecordId: step.id,
      name: step.name,
      status: step.status,
      attempts: step.attempts,
      maxAttempts: step.maxAttempts,
      startedAt: stepStarts.get(step.id) ?? createdAt,
      endedAt: TERMINAL_WORKFLOW_STEP_STATUSES.has(step.status)
        ? workflowRunTime(step.updatedAt)
        : null,
      error: error ?? null,
    });
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
      current: step.status === "waiting" && !isAbandonedWorkflowStep(step.stepKey, stepsByKey),
    });
  }

  const canonicalEmissions = selectCanonicalWorkflowStepEmissions({ steps, emissions });
  const startedAtByStepKey = new Map<string, number>();
  for (const emission of canonicalEmissions) {
    if (emission.actor === "system" && isWorkflowStepStartedControlPayload(emission.payload)) {
      const startedAt = workflowRunTime(emission.createdAt);
      startedAtByStepKey.set(
        emission.stepKey,
        Math.min(startedAt, startedAtByStepKey.get(emission.stepKey) ?? startedAt),
      );
    }
  }
  const activityByNodeId = new Map<string, { active: boolean; userEmissionCount: number }>();
  for (const activity of projectWorkflowStepExecutionActivity(canonicalEmissions)) {
    const nodeId = nodeIdByStepKey.get(activity.stepKey) ?? resolveStepNodeId(activity.stepKey);
    if (!nodeId) {
      if (activity.active && !isAbandonedWorkflowStep(activity.stepKey, stepsByKey)) {
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
    const running = activity.active && !isAbandonedWorkflowStep(activity.stepKey, stepsByKey);
    nodeActivity.active ||= running;
    if (running) {
      const recorded = stepExecutionsByNodeId
        .get(nodeId)
        ?.find((execution) => execution.stepKey === activity.stepKey);
      recordStepExecution(
        stepExecutionsByNodeId,
        nodeId,
        recorded
          ? { ...recorded, status: "active", endedAt: null }
          : {
              stepKey: activity.stepKey,
              stepRecordId: null,
              name: parseStepKey(activity.stepKey).segments.at(-1)?.name ?? activity.stepKey,
              status: "active",
              attempts: 1,
              maxAttempts: stepsByKey.get(activity.stepKey)?.maxAttempts ?? 1,
              startedAt: startedAtByStepKey.get(activity.stepKey) ?? createdAt,
              endedAt: null,
              error: null,
            },
      );
    }
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

  for (const executions of stepExecutionsByNodeId.values()) {
    executions.sort((left, right) => left.startedAt - right.startedAt);
  }

  return {
    stepStatesByNodeId,
    stepExecutionsByNodeId,
    unmappedRuntimeSteps: [...unmappedRuntimeStepsByKey.values()],
  };
}

/** Replaces the node's earlier execution under the same step key, such as one that is retrying. */
function recordStepExecution(
  executionsByNodeId: Map<string, WorkflowStepRunExecution[]>,
  nodeId: string,
  execution: WorkflowStepRunExecution,
) {
  const executions = executionsByNodeId.get(nodeId) ?? [];
  executionsByNodeId.set(nodeId, [
    ...executions.filter((existing) => existing.stepKey !== execution.stepKey),
    execution,
  ]);
}

/**
 * Infers when each recorded step started, keyed by step record id. Waits are written when they
 * begin. A `do` step is only written when it commits, so it is assumed to have started at the
 * latest commit before it, or when the run was created. Steps that run concurrently therefore
 * appear shorter than they were.
 */
export function inferWorkflowStepStarts(
  steps: readonly Pick<
    WorkflowRunStep,
    "id" | "stepKey" | "parentStepKey" | "type" | "status" | "createdAt" | "updatedAt"
  >[],
  createdAt: number,
): Map<string, number> {
  const stepsByKey = new Map(steps.map((step) => [step.stepKey, step]));
  const commits = steps.flatMap((step) =>
    TERMINAL_WORKFLOW_STEP_STATUSES.has(step.status)
      ? [{ stepKey: step.stepKey, at: workflowRunTime(step.updatedAt) }]
      : [],
  );
  const starts = new Map<string, number>();
  for (const step of steps) {
    const writtenAt = workflowRunTime(step.createdAt);
    if (step.type !== "do") {
      starts.set(step.id, writtenAt);
      continue;
    }
    // Nested steps commit before their parent, so they cannot mark when the parent started.
    const previousCommit = commits.reduce(
      (latest, commit) =>
        commit.stepKey !== step.stepKey &&
        commit.at <= writtenAt &&
        commit.at > latest &&
        !isWorkflowStepDescendant(commit.stepKey, step.stepKey, stepsByKey)
          ? commit.at
          : latest,
      createdAt,
    );
    starts.set(step.id, Math.min(previousCommit, writtenAt));
  }
  return starts;
}

function isWorkflowStepDescendant(
  stepKey: string,
  ancestorKey: string,
  stepsByKey: ReadonlyMap<string, Pick<WorkflowRunStep, "parentStepKey">>,
): boolean {
  let parentStepKey = stepsByKey.get(stepKey)?.parentStepKey ?? null;
  const visitedStepKeys = new Set<string>();
  while (parentStepKey && !visitedStepKeys.has(parentStepKey)) {
    if (parentStepKey === ancestorKey) {
      return true;
    }
    visitedStepKeys.add(parentStepKey);
    parentStepKey = stepsByKey.get(parentStepKey)?.parentStepKey ?? null;
  }
  return false;
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
  repeatingStaticNodeIds: Set<string>;
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
  const repeatingStaticNodeIds = new Set<string>();
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
    if (hasLoopAncestor(step.parentId, nodesById)) {
      repeatingStaticNodeIds.add(step.id);
    }
  }

  return {
    nodeIdsByScopeAndIdentity,
    dynamicNodesByScopeAndType,
    repeatingStaticNodeIds,
    sourceOrderByNodeId,
  };
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
        const singleRepeatingStaticNodeId =
          exactCandidates.length === 1 &&
          !dynamicFamily &&
          index.repeatingStaticNodeIds.has(exactCandidates[0])
            ? exactCandidates[0]
            : undefined;
        const dynamicCandidateNodeIds = dynamicFamily ? new Set(dynamicFamily.nodeIds) : undefined;
        const candidates = dynamicFamily
          ? [...exactCandidates, ...dynamicFamily.nodeIds].sort(
              (left, right) =>
                (index.sourceOrderByNodeId.get(left) ?? 0) -
                (index.sourceOrderByNodeId.get(right) ?? 0),
            )
          : exactCandidates;
        nodeId = singleRepeatingStaticNodeId ?? candidates[identity.occurrence];

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
  return (
    workflowRunTime(left.createdAt) - workflowRunTime(right.createdAt) ||
    left.id.localeCompare(right.id)
  );
}

/** Epoch milliseconds of a synchronized workflow timestamp. */
export function workflowRunTime(value: WorkflowRunTimestamp): number {
  const date = value instanceof Date ? value : new Date(value);
  const valueOf = date.valueOf();
  if (!Number.isFinite(valueOf)) {
    throw new Error("INVALID_WORKFLOW_RUN_TIMESTAMP");
  }
  return valueOf;
}
