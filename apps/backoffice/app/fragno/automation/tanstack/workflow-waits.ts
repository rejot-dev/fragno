import { createLiveQueryCollection, eq, toArray, type Collection } from "@tanstack/react-db";

import { createDerivedCollection } from "@/fragno/tanstack/derived-collection";

import { currentWorkflowWaits, type WaitingRun, type WorkflowWaitRecord } from "../workflow-waits";
import type { AutomationTableCollections } from "./collections";

export { currentWorkflowWaits, type WorkflowWaitRecord } from "../workflow-waits";

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
