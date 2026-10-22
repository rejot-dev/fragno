import type { BackofficeUiRun } from "@fragno-private/backoffice-ui/render-context";

import { eq, useLiveQuery } from "@tanstack/react-db";

import type { BackofficeResolvedScope } from "@/backoffice-runtime/resolved-scope";
import { WorkflowRunGeneratedInterface } from "@/components/backoffice/workflow-run-generated-interface";
import type { AutomationBrowserCollections } from "@/fragno/automation/tanstack/browser-database";

import { useWorkflowRunRecords } from "../automations/script-view/use-script-workflow-runs";
import { awaitingInputStep } from "./overview";

/**
 * The form a waiting run asks a person to answer, as a page's row opens to show it. It shows
 * nothing once the run stops asking, such as after the answer arrives.
 */
export function WorkflowRunResponse({
  collections,
  resolvedScope,
  run: { workflowName, instanceId },
}: {
  collections: AutomationBrowserCollections;
  resolvedScope: BackofficeResolvedScope;
  run: BackofficeUiRun;
}) {
  const { instances, error } = useWorkflowRunRecords({
    collections,
    selector: { type: "instance", workflowName, instanceId },
  });
  const run = instances[0] ?? null;
  const runId = run?.id ?? null;
  const waitsQuery = useLiveQuery({
    query: (query) =>
      runId === null
        ? undefined
        : query
            .from({ wait: collections.workflowWaits })
            .where(({ wait }) => eq(wait.runId, runId)),
  });
  if (error !== null || waitsQuery.isError) {
    return (
      <p className="text-xs text-[var(--bo-failed)]">
        This run could not be read, so its form cannot show.
      </p>
    );
  }
  const step = run === null ? null : awaitingInputStep(run, waitsQuery.data ?? []);
  if (run === null || step === null) {
    return null;
  }
  return (
    <WorkflowRunGeneratedInterface
      run={{ ...run, steps: run.workflowSteps }}
      generatedUi={{ type: "step", step }}
      resolvedScope={resolvedScope}
    />
  );
}
