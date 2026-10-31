import { pendingWaitEventTypes, type WorkflowWaitEvent } from "@fragno-dev/workflows/pending-waits";

import {
  latestWorkflowRunGeneratedUi,
  type WorkflowRunStep,
} from "@/routes/backoffice/automations/script-view/workflow-run-presentation";

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

/** What waiting runs wait for, from their output, and steps and events in the order they were created. */
export function currentWorkflowWaits(
  runs: readonly {
    id: string;
    output: unknown;
    steps: readonly Pick<
      WorkflowRunStep,
      "stepKey" | "parentStepKey" | "type" | "status" | "waitEventType" | "result"
    >[];
    events: readonly WorkflowWaitEvent[];
  }[],
): WorkflowWaitRecord[] {
  return runs.flatMap((run) => {
    const generatedUi = latestWorkflowRunGeneratedUi({ output: run.output, steps: run.steps });
    const interfaceStepKey = generatedUi?.type === "step" ? generatedUi.step.stepKey : null;
    return pendingWaitEventTypes(run).map((eventType) => ({
      id: `${run.id}:${eventType}`,
      runId: run.id,
      eventType,
      interfaceStepKey,
    }));
  });
}
