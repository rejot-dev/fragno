import { pendingWaitEventTypes } from "@fragno-dev/workflows/pending-waits";
import {
  BackofficeUiErrorBoundary,
  BackofficeUiRenderer,
} from "@fragno-private/backoffice-ui/renderer";

import { backofficeRuntimeScopeFromResolvedScope } from "@/backoffice-runtime/resolved-scope";
import type { BackofficeResolvedScope } from "@/backoffice-runtime/resolved-scope";
import { sendBackofficeWorkflowEvent } from "@/backoffice-ui/workflow-events.client";
import { FileScopeProvider } from "@/components/backoffice/file-scope";
import {
  type WorkflowRunEvent,
  type WorkflowRunGeneratedUi,
  type WorkflowRunStep,
  type WorkflowStepRunState,
} from "@/routes/backoffice/automations/script-view/workflow-run-presentation";
import { WorkflowStepGeneratedUi } from "@/routes/backoffice/automations/script-view/workflow-step-generated-ui";

export type GeneratedInterfaceStep = Pick<
  WorkflowRunStep,
  | "id"
  | "stepKey"
  | "parentStepKey"
  | "type"
  | "status"
  | "attempts"
  | "result"
  | "errorMessage"
  | "waitEventType"
  | "updatedAt"
>;

export type GeneratedInterfaceRun = {
  id: string;
  instanceId: string;
  workflowName: string;
  remoteWorkflowName: string | null;
  steps: readonly GeneratedInterfaceStep[];
  workflowEvents: readonly WorkflowRunEvent[];
};

type WorkflowRunGeneratedInterfaceProps = {
  run: GeneratedInterfaceRun;
  generatedUi: WorkflowRunGeneratedUi<GeneratedInterfaceStep>;
  resolvedScope: BackofficeResolvedScope;
  /** Fills its container without a separator above it, for a container that frames it. */
  standalone: boolean;
};

/** Renders the interface a run presents; step interfaces answer the run's waits with events. */
export function WorkflowRunGeneratedInterface(props: WorkflowRunGeneratedInterfaceProps) {
  // Images resolve against the run's scope, which differs from the page's in the global drawer.
  return (
    <FileScopeProvider scope={props.resolvedScope}>
      <GeneratedInterfaceContent {...props} />
    </FileScopeProvider>
  );
}

function GeneratedInterfaceContent({
  run,
  generatedUi,
  resolvedScope,
  standalone,
}: WorkflowRunGeneratedInterfaceProps) {
  if (generatedUi.type === "output") {
    return generatedUi.parsed.kind === "valid" ? (
      <BackofficeUiErrorBoundary
        fallback={
          <GeneratedInterfaceError message="A generated component failed while rendering." />
        }
      >
        <BackofficeUiRenderer ui={generatedUi.parsed.value.$ui} />
      </BackofficeUiErrorBoundary>
    ) : (
      <GeneratedInterfaceError message={generatedUi.parsed.message} />
    );
  }

  const runtimeScope = backofficeRuntimeScopeFromResolvedScope(resolvedScope);
  return (
    <WorkflowStepGeneratedUi
      state={workflowStepGeneratedUiState(generatedUi.step)}
      standalone={standalone}
      workflowEvents={run.workflowEvents}
      workflowRunRecordId={run.id}
      currentScope={resolvedScope.kind !== "system" ? resolvedScope : undefined}
      // Events address the run by its runner's name; the authored name only labels it.
      workflowName={run.workflowName}
      workflowInstanceId={run.instanceId}
      waitingEventTypes={pendingWaitEventTypes({ steps: run.steps, events: run.workflowEvents })}
      workflowEventSender={async ({ eventId, workflowName, instanceId, eventType, payload }) => {
        await sendBackofficeWorkflowEvent({
          eventId,
          reference: { scope: runtimeScope, workflowName, instanceId },
          eventType,
          payload,
        });
      }}
    />
  );
}

function workflowStepGeneratedUiState(step: GeneratedInterfaceStep): WorkflowStepRunState {
  return {
    stepRecordId: step.id,
    status: step.status,
    attempts: step.attempts,
    completedAt: step.status === "completed" ? step.updatedAt : undefined,
    result: step.result,
    error: step.errorMessage ?? undefined,
    waitEventType: step.waitEventType ?? undefined,
    emissionCount: 0,
    current: false,
  };
}

function GeneratedInterfaceError({ message }: { message: string }) {
  return <p className="text-xs leading-relaxed text-[var(--bo-failed)]">{message}</p>;
}
