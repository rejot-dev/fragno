import { useMemo } from "react";
import { z } from "zod";

import type { WorkflowVisualizationSnapshot } from "@fragno-dev/workflow-visualizer-tokens";

import { and, eq, or, toArray, useLiveQuery, type InitialQueryBuilder } from "@tanstack/react-db";

import { CODEMODE_WORKFLOW } from "@/fragno/automation/engine/codemode-invocation";
import type { AutomationCollections } from "@/fragno/automation/tanstack/collections";

import {
  projectScriptWorkflowRuns,
  selectScriptWorkflowRun,
  type AutomationWorkflowRun,
} from "./workflow-run-presentation";

// Instance params are opaque to the workflow runtime; only Codemode runs carry a program.
const codemodeWorkflowRunParamsSchema = z.object({
  program: z.object({ filename: z.string(), code: z.string() }),
  trigger: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("event"),
      event: z.object({ source: z.string(), eventType: z.string() }),
    }),
    z.object({ type: z.literal("manual") }),
  ]),
});

export type WorkflowRunCollections = Pick<
  AutomationCollections,
  "workflowInstances" | "workflowSteps" | "workflowEvents" | "workflowStepEmissions"
>;

export type WorkflowRunRecordSelector =
  | { type: "active-codemode" }
  | { type: "instance"; workflowName: string; instanceId: string };

/** The live query behind every run view; `queryOnce` accepts it as well. */
export function workflowRunRecordsQuery(
  query: InitialQueryBuilder,
  collections: WorkflowRunCollections,
  selector: WorkflowRunRecordSelector,
) {
  const instances = query.from({ instance: collections.workflowInstances });
  const selectedInstances =
    selector.type === "active-codemode"
      ? instances
          .where(({ instance }) => eq(instance.workflowName, CODEMODE_WORKFLOW))
          .where(({ instance }) =>
            or(
              eq(instance.status, "active"),
              eq(instance.status, "waiting"),
              eq(instance.status, "paused"),
            ),
          )
      : instances.where(({ instance }) =>
          and(
            eq(instance.workflowName, selector.workflowName),
            eq(instance.instanceId, selector.instanceId),
          ),
        );

  return selectedInstances
    .orderBy(({ instance }) => instance.updatedAt, "desc")
    .orderBy(({ instance }) => instance.id, "desc")
    .select(({ instance }) => ({
      id: instance.id,
      instanceId: instance.instanceId,
      workflowName: instance.workflowName,
      remoteWorkflowName: instance.remoteWorkflowName,
      status: instance.status,
      params: instance.params,
      output: instance.output,
      errorName: instance.errorName,
      errorMessage: instance.errorMessage,
      createdAt: instance.createdAt,
      updatedAt: instance.updatedAt,
      startedAt: instance.startedAt,
      completedAt: instance.completedAt,
      workflowSteps: toArray(
        query
          .from({ step: collections.workflowSteps })
          .where(({ step }) => eq(step.instanceRef, instance.id))
          .orderBy(({ step }) => step.createdAt, "asc")
          .orderBy(({ step }) => step.id, "asc")
          .select(({ step }) => ({
            id: step.id,
            stepKey: step.stepKey,
            parentStepKey: step.parentStepKey,
            name: step.name,
            type: step.type,
            status: step.status,
            committedByExecutionId: step.committedByExecutionId,
            attempts: step.attempts,
            maxAttempts: step.maxAttempts,
            waitEventType: step.waitEventType,
            result: step.result,
            errorName: step.errorName,
            errorMessage: step.errorMessage,
            createdAt: step.createdAt,
            updatedAt: step.updatedAt,
          })),
      ),
      workflowEvents: toArray(
        query
          .from({ event: collections.workflowEvents })
          .where(({ event }) => eq(event.instanceRef, instance.id))
          .orderBy(({ event }) => event.createdAt, "asc")
          .orderBy(({ event }) => event.id, "asc")
          .select(({ event }) => ({
            id: event.id,
            actor: event.actor,
            type: event.type,
            payload: event.payload,
            createdAt: event.createdAt,
            deliveredAt: event.deliveredAt,
            consumedByStepKey: event.consumedByStepKey,
          })),
      ),
      workflowStepEmissions: toArray(
        query
          .from({ emission: collections.workflowStepEmissions })
          .where(({ emission }) => eq(emission.instanceRef, instance.id))
          .orderBy(({ emission }) => emission.createdAt, "asc")
          .orderBy(({ emission }) => emission.sequence, "asc")
          .orderBy(({ emission }) => emission.id, "asc")
          .select(({ emission }) => ({
            id: emission.id,
            actor: emission.actor,
            stepKey: emission.stepKey,
            executionId: emission.executionId,
            epoch: emission.epoch,
            sequence: emission.sequence,
            payload: emission.payload,
            createdAt: emission.createdAt,
          })),
      ),
    }));
}

type PersistedAutomationWorkflowRun = Omit<AutomationWorkflowRun, "codemode"> & {
  params: unknown;
};

/**
 * Casts synchronized rows to runs. The workflow schema stores statuses as strings, but the runner
 * only persists its own states.
 */
export function automationWorkflowRunsFromRecords(
  records: readonly unknown[],
): AutomationWorkflowRun[] {
  return (records as PersistedAutomationWorkflowRun[]).map(({ params, ...instance }) => {
    const codemodeParams = codemodeWorkflowRunParamsSchema.safeParse(params);
    return {
      ...instance,
      codemode: codemodeParams.success
        ? {
            filename: codemodeParams.data.program.filename,
            code: codemodeParams.data.program.code,
            trigger:
              codemodeParams.data.trigger.type === "event"
                ? {
                    type: "event",
                    source: codemodeParams.data.trigger.event.source,
                    eventType: codemodeParams.data.trigger.event.eventType,
                  }
                : { type: "manual" },
          }
        : null,
    };
  });
}

export function useWorkflowRunRecords({
  collections,
  selector,
}: {
  collections?: WorkflowRunCollections;
  selector: WorkflowRunRecordSelector | null;
}) {
  const runsQuery = useLiveQuery(
    (query) =>
      selector && collections ? workflowRunRecordsQuery(query, collections, selector) : undefined,
    [
      collections?.workflowEvents,
      collections?.workflowInstances,
      collections?.workflowStepEmissions,
      collections?.workflowSteps,
      selector?.type,
      selector?.type === "instance" ? selector.instanceId : null,
      selector?.type === "instance" ? selector.workflowName : null,
    ],
  );
  const error = selector && runsQuery.isError ? "Workflow synchronization failed." : null;
  const instances = useMemo(
    () => automationWorkflowRunsFromRecords(runsQuery.data ?? []),
    [runsQuery.data],
  );

  return {
    instances,
    error,
    isLoading: Boolean(selector && collections && !runsQuery.isReady),
  };
}

export function useScriptWorkflowRuns({
  absolutePath,
  collections,
  selectedInstanceId,
  visualization,
}: {
  absolutePath: string;
  collections: WorkflowRunCollections;
  selectedInstanceId?: string | null;
  visualization: WorkflowVisualizationSnapshot;
}) {
  const hasWorkflowDefinitions = visualization.graph.nodes.some((node) => node.kind === "workflow");
  const records = useWorkflowRunRecords({
    collections,
    selector: hasWorkflowDefinitions ? { type: "active-codemode" } : null,
  });
  const runs = useMemo(
    () =>
      projectScriptWorkflowRuns({
        absolutePath,
        visualization,
        instances: records.instances,
      }),
    [absolutePath, records.instances, visualization],
  );

  return {
    runs,
    selectedRun: selectScriptWorkflowRun(runs, selectedInstanceId),
    error: records.error,
    isLoading: records.isLoading,
  };
}
