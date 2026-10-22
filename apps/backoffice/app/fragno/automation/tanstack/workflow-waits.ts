import { createLiveQueryCollection, eq, toArray, type Collection } from "@tanstack/react-db";

import { createDerivedCollection } from "@/fragno/tanstack/derived-collection";
import {
  currentWorkflowWaitingEventTypes,
  latestWorkflowRunGeneratedUi,
} from "@/routes/backoffice/automations/script-view/workflow-run-presentation";

import type { AutomationTableCollections } from "./collections";

/**
 * An event type a waiting run waits for. A run whose latest interface comes from a completed step
 * asks a person to answer it through that interface, so `interfaceStepKey` names the step.
 */
export type WorkflowWaitRecord = {
  /** The run's id and the event type; a run waiting for several types has a row for each. */
  id: string;
  runId: string;
  eventType: string;
  interfaceStepKey: string | null;
};

type WaitingRun = {
  id: string;
  output: unknown;
  steps: {
    stepKey: string;
    parentStepKey: string | null;
    type: string;
    // The workflow schema stores statuses as strings; the runner persists only its own states.
    status: "waiting" | "completed" | "errored";
    waitEventType: string | null;
    result: unknown;
  }[];
};

function currentWorkflowWaits(runs: readonly WaitingRun[]): WorkflowWaitRecord[] {
  return runs.flatMap((run) => {
    const generatedUi = latestWorkflowRunGeneratedUi({ output: run.output, steps: run.steps });
    const interfaceStepKey = generatedUi?.type === "step" ? generatedUi.step.stepKey : null;
    return currentWorkflowWaitingEventTypes(run.steps).map((eventType) => ({
      id: `${run.id}:${eventType}`,
      runId: run.id,
      eventType,
      interfaceStepKey,
    }));
  });
}

/** What the scope's waiting runs wait for, as their steps record it. */
export function createWorkflowWaitsCollection(
  collections: Pick<AutomationTableCollections, "workflowInstances" | "workflowSteps">,
): Collection<WorkflowWaitRecord, string> {
  const runs = createLiveQueryCollection({
    query: (query) =>
      query
        .from({ run: collections.workflowInstances })
        .where(({ run }) => eq(run.status, "waiting"))
        .select(({ run }) => ({
          id: run.id,
          output: run.output,
          // The latest completed step with an interface is the last one in this order.
          steps: toArray(
            query
              .from({ step: collections.workflowSteps })
              .where(({ step }) => eq(step.instanceRef, run.id))
              .orderBy(({ step }) => step.createdAt, "asc")
              .orderBy(({ step }) => step.id, "asc")
              .select(({ step }) => ({
                stepKey: step.stepKey,
                parentStepKey: step.parentStepKey,
                type: step.type,
                status: step.status,
                waitEventType: step.waitEventType,
                result: step.result,
              })),
          ),
        })),
  });
  return createDerivedCollection({
    source: runs,
    getKey: (wait) => wait.id,
    derive: (rows) => currentWorkflowWaits(rows as WaitingRun[]),
  });
}
