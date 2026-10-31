import type { LofiSqliteClient } from "@fragno-dev/lofi/sqlite";
import type { BackofficeUiRun } from "@fragno-private/backoffice-ui/render-context";

import type { BackofficeResolvedScope } from "@/backoffice-runtime/resolved-scope";
import { WorkflowRunGeneratedInterface } from "@/components/backoffice/workflow-run-generated-interface";
import { currentWorkflowWaits } from "@/fragno/automation/workflow-waits";

import { useWorkflowRunRecords } from "../automations/script-view/use-script-workflow-runs";
import { awaitingInputStep } from "./overview";

/**
 * The form a waiting run asks a person to answer, as a page's row opens to show it. It shows
 * nothing once the run stops asking, such as after the answer arrives.
 */
export function WorkflowRunResponse({
  replica,
  resolvedScope,
  run: { workflowName, instanceId },
}: {
  replica: LofiSqliteClient;
  resolvedScope: BackofficeResolvedScope;
  run: BackofficeUiRun;
}) {
  const { instances, error } = useWorkflowRunRecords({
    replica,
    selector: { type: "instance", workflowName, instanceId },
  });
  const run = instances[0] ?? null;
  if (error !== null) {
    return (
      <p className="text-xs text-[var(--bo-failed)]">
        This run could not be read, so its form cannot show.
      </p>
    );
  }
  // Only waiting runs wait, as the scope's `workflowWaits` collection derives them.
  const waits =
    run?.status === "waiting"
      ? currentWorkflowWaits([
          {
            id: run.id,
            output: run.output,
            steps: run.workflowSteps,
            events: run.workflowEvents,
          },
        ])
      : [];
  const step = run === null ? null : awaitingInputStep(run, waits);
  if (run === null || step === null) {
    return null;
  }
  return (
    <WorkflowRunGeneratedInterface
      run={{ ...run, steps: run.workflowSteps }}
      generatedUi={{ type: "step", step }}
      resolvedScope={resolvedScope}
      standalone={false}
    />
  );
}
