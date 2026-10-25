import type { LofiSqliteClient } from "@fragno-dev/lofi/sqlite";
import {
  projectWorkflowStepExecutionActivity,
  selectCanonicalWorkflowStepEmissions,
} from "@fragno-dev/workflows/step-emission-control";
import { parseStepKey } from "@fragno-dev/workflows/step-identity";
import type { WorkflowInstanceStatus } from "@fragno-dev/workflows/workflow";
import {
  workflowRunNodesFromGraph,
  type WorkflowRunStepRuntime,
} from "@fragno-private/design-system/workflow-run-timeline-graph";
import type {
  WorkflowRunEvent as WorkflowRunTimelineEvent,
  WorkflowRunNode,
  WorkflowRunStep as WorkflowRunTimelineStep,
  WorkflowRunStepStatus as WorkflowRunTimelineStepStatus,
} from "@fragno-private/design-system/workflow-run-timeline-model";
import { useMemo } from "react";

import {
  visualizeWorkflowSource,
  type StepNode,
  type WorkflowVisualizationSnapshot,
} from "@fragno-dev/workflow-visualizer-tokens";

import { useWorkflowRunRecords } from "./use-script-workflow-runs";
import {
  inferWorkflowStepStarts,
  projectWorkflowRun,
  workflowRunTime,
  type AutomationWorkflowRun,
  type CodemodeWorkflowRunTrigger,
  type WorkflowRunReference,
  type WorkflowRunStep,
  type WorkflowStepRunStatus,
} from "./workflow-run-presentation";

/** Everything `WorkflowRunTimeline` needs to draw one run. Times are epoch milliseconds. */
export type WorkflowRunTimelineProjection = {
  title: string;
  status: WorkflowInstanceStatus;
  trigger: string;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  nodes: readonly WorkflowRunNode[];
  events: readonly WorkflowRunTimelineEvent[];
  /** The latest step record behind each timeline step, for step details. */
  stepRecordsByStepId: ReadonlyMap<string, WorkflowRunStep>;
  /** Recorded steps the run's program does not account for. */
  unmappedStepCount: number;
};

export function useWorkflowRunTimeline({
  replica,
  reference,
}: {
  replica: LofiSqliteClient;
  reference: WorkflowRunReference;
}) {
  const records = useWorkflowRunRecords({
    replica,
    selector: {
      type: "instance",
      workflowName: reference.workflowName,
      instanceId: reference.instanceId,
    },
  });
  const instance = records.instances.at(0) ?? null;
  const filename = instance?.codemode?.filename ?? null;
  const code = instance?.codemode?.code ?? null;
  const visualization = useMemo(
    () => (filename === null || code === null ? null : visualizeWorkflowSource(filename, code)),
    [filename, code],
  );
  const timeline = useMemo(
    () => (instance ? projectWorkflowRunTimeline({ instance, visualization }) : null),
    [instance, visualization],
  );

  return { instance, timeline, error: records.error, isLoading: records.isLoading };
}

/**
 * Projects a run onto the timeline. Codemode runs are drawn from the program they executed, so
 * branches that did not run are visible; other workflows only show the steps they recorded.
 */
export function projectWorkflowRunTimeline({
  instance,
  visualization,
}: {
  instance: AutomationWorkflowRun;
  visualization: WorkflowVisualizationSnapshot | null;
}): WorkflowRunTimelineProjection {
  const createdAt = workflowRunTime(instance.createdAt);
  const endedAt = instance.completedAt === null ? null : workflowRunTime(instance.completedAt);
  const recordsById = new Map(instance.workflowSteps.map((step) => [step.id, step]));
  const graphNodes = visualization ? projectGraphNodes(instance, visualization, endedAt) : null;
  const nodes = graphNodes?.nodes ?? recordedStepNodes(instance, createdAt);

  return {
    title: instance.remoteWorkflowName ?? instance.workflowName,
    status: instance.status,
    trigger: instance.codemode ? triggerLabel(instance.codemode.trigger) : "internal",
    createdAt,
    // The runner stamps `startedAt` when the first tick commits, so it marks the first commit and
    // not when execution began. Queueing time is not recorded.
    startedAt: instance.startedAt === null ? null : createdAt,
    endedAt,
    nodes,
    events: instance.workflowEvents.map((event) => ({
      id: event.id,
      at: workflowRunTime(event.createdAt),
      source: event.type,
      message: event.payload == null ? "" : JSON.stringify(event.payload),
    })),
    stepRecordsByStepId: graphNodes
      ? new Map(
          [...graphNodes.stepRecordIdsByNodeId].flatMap(([nodeId, recordId]) => {
            const record = recordsById.get(recordId);
            return record ? [[nodeId, record] as const] : [];
          }),
        )
      : recordsById,
    unmappedStepCount: graphNodes?.unmappedStepCount ?? 0,
  };
}

function projectGraphNodes(
  instance: AutomationWorkflowRun,
  visualization: WorkflowVisualizationSnapshot,
  endedAt: number | null,
) {
  const workflow = visualization.graph.nodes.find(
    (node) => node.kind === "workflow" && node.name === instance.remoteWorkflowName,
  );
  const run = projectWorkflowRun({ visualization, instance });
  if (!workflow || !run) {
    return null;
  }

  const stepRecordIdsByNodeId = new Map<string, string>();
  const nodes = workflowRunNodesFromGraph(
    visualization.graph,
    workflow.id,
    (node: StepNode): WorkflowRunStepRuntime => {
      const state = run.stepStatesByNodeId.get(node.id);
      if (!state) {
        return {
          status: endedAt === null ? "pending" : "skipped",
          attempts: { count: 0, max: 1 },
          timing: { kind: "unstarted" },
          detail: null,
        };
      }
      const execution = run.stepExecutionsByNodeId.get(node.id);
      if (!execution) {
        throw new Error("A workflow step with run state has no recorded execution.");
      }
      if (state.stepRecordId) {
        stepRecordIdsByNodeId.set(node.id, state.stepRecordId);
      }
      return {
        status: TIMELINE_STEP_STATUS[state.status],
        attempts: { count: state.attempts, max: execution.maxAttempts },
        timing: { kind: "span", startedAt: execution.startedAt, endedAt: execution.endedAt },
        detail: state.error ?? null,
      };
    },
  );

  return { nodes, stepRecordIdsByNodeId, unmappedStepCount: run.unmappedRuntimeSteps.length };
}

const TIMELINE_STEP_STATUS: Record<WorkflowStepRunStatus, WorkflowRunTimelineStepStatus> = {
  active: "running",
  waiting: "waiting",
  completed: "completed",
  errored: "failed",
};

/** Recorded steps in the order they were written, nested under the steps that ran them. */
function recordedStepNodes(instance: AutomationWorkflowRun, createdAt: number): WorkflowRunNode[] {
  const steps = instance.workflowSteps;
  const starts = inferWorkflowStepStarts(steps, createdAt);
  const recordedKeys = new Set(steps.map((step) => step.stepKey));
  const childrenByParentKey = new Map<string | null, WorkflowRunStep[]>();
  for (const step of steps) {
    const parentKey =
      step.parentStepKey !== null && recordedKeys.has(step.parentStepKey)
        ? step.parentStepKey
        : null;
    childrenByParentKey.set(parentKey, [...(childrenByParentKey.get(parentKey) ?? []), step]);
  }

  function toStep(step: WorkflowRunStep): WorkflowRunTimelineStep {
    const ended = step.status === "completed" || step.status === "errored";
    return {
      id: step.id,
      label: step.name,
      detail:
        step.status === "errored"
          ? [step.errorName, step.errorMessage].filter(Boolean).join(": ") || null
          : step.waitEventType,
      status: TIMELINE_STEP_STATUS[step.status],
      activity: step.type === "do" ? "work" : "wait",
      attempts: { count: step.attempts, max: step.maxAttempts },
      timing: {
        kind: "span",
        startedAt: starts.get(step.id) ?? createdAt,
        endedAt: ended ? workflowRunTime(step.updatedAt) : null,
      },
      children: (childrenByParentKey.get(step.stepKey) ?? []).map(toStep),
    };
  }

  // A `do` step is only written when it commits, so a running one is only known from its start.
  const emissions = selectCanonicalWorkflowStepEmissions({
    steps,
    emissions: instance.workflowStepEmissions,
  });
  const runningSteps = projectWorkflowStepExecutionActivity(emissions).flatMap(
    (activity): WorkflowRunNode[] => {
      if (!activity.active || recordedKeys.has(activity.stepKey)) {
        return [];
      }
      const name = parseStepKey(activity.stepKey).segments.at(-1)?.name ?? activity.stepKey;
      return [
        {
          kind: "step",
          step: {
            id: activity.stepKey,
            label: name,
            detail: null,
            status: "running",
            activity: "work",
            attempts: { count: 1, max: 1 },
            timing: {
              kind: "span",
              startedAt: Math.min(
                ...emissions.flatMap((emission) =>
                  emission.stepKey === activity.stepKey && emission.epoch === activity.epoch
                    ? [workflowRunTime(emission.createdAt)]
                    : [],
                ),
              ),
              endedAt: null,
            },
            children: [],
          },
        },
      ];
    },
  );

  return [
    ...(childrenByParentKey.get(null) ?? []).map(
      (step): WorkflowRunNode => ({ kind: "step", step: toStep(step) }),
    ),
    ...runningSteps,
  ];
}

function triggerLabel(trigger: CodemodeWorkflowRunTrigger): string {
  return trigger.type === "event" ? `${trigger.source} · ${trigger.eventType}` : "manual";
}
