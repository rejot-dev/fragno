import { WorkflowRunTimeline } from "@fragno-private/design-system/workflow-run-timeline";
import { useState, type ReactNode } from "react";

import { formatTimestamp } from "../automations/formatting";
import type { WorkflowRunCollections } from "../automations/script-view/use-script-workflow-runs";
import type {
  AutomationWorkflowRun,
  WorkflowRunReference,
  WorkflowRunStep,
} from "../automations/script-view/workflow-run-presentation";
import { useWorkflowRunTimeline } from "../automations/script-view/workflow-run-timeline-presentation";

/**
 * One workflow run as a step timeline, with the selected step's record or the run's outcome. It
 * draws no frame of its own because it fills a dashboard section.
 */
export function WorkflowRunDetail({
  collections,
  reference,
}: {
  collections: WorkflowRunCollections;
  reference: WorkflowRunReference;
}) {
  const run = useWorkflowRunTimeline({ collections, reference });
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);

  if (run.error) {
    return <p className="py-5 text-sm text-[var(--bo-failed)]">{run.error}</p>;
  }
  if (!run.instance || !run.timeline) {
    return (
      <p className="py-5 text-sm text-[var(--bo-muted)]">
        {run.isLoading
          ? "Synchronizing the workflow run…"
          : `There is no run ${reference.instanceId} of ${reference.workflowName} in this scope.`}
      </p>
    );
  }

  const { instance, timeline } = run;
  const selectedRecord =
    selectedStepId === null ? null : (timeline.stepRecordsByStepId.get(selectedStepId) ?? null);

  return (
    <div className="flex flex-col">
      <WorkflowRunTimeline
        title={timeline.title}
        status={timeline.status}
        trigger={timeline.trigger}
        createdAt={timeline.createdAt}
        startedAt={timeline.startedAt}
        endedAt={timeline.endedAt}
        nodes={timeline.nodes}
        events={timeline.events}
        selectedStepId={selectedStepId}
        onSelectStep={(stepId) => {
          setSelectedStepId((current) => (current === stepId ? null : stepId));
        }}
        meta={
          <>
            <span className="font-mono">{instance.instanceId}</span>
            {timeline.unmappedStepCount === 0 ? null : (
              <span
                className="text-[var(--bo-waiting)]"
                title="Recorded steps that the run's program does not account for."
              >
                {timeline.unmappedStepCount} unmatched{" "}
                {timeline.unmappedStepCount === 1 ? "step" : "steps"}
              </span>
            )}
          </>
        }
        actions={null}
        surface="flush"
      />
      {selectedRecord ? (
        <StepRecordPanel step={selectedRecord} />
      ) : (
        <RunOutcomePanel instance={instance} />
      )}
    </div>
  );
}

function StepRecordPanel({ step }: { step: WorkflowRunStep }) {
  const error = [step.errorName, step.errorMessage].filter(Boolean).join(": ");
  return (
    <DetailPanel title={step.name} eyebrow={`${step.type} step`}>
      <dl className="grid gap-x-6 gap-y-2 text-xs sm:grid-cols-4">
        <Fact label="Status" value={step.status} />
        <Fact label="Attempts" value={`${step.attempts} / ${step.maxAttempts}`} />
        <Fact label="First written" value={formatTimestamp(step.createdAt)} />
        <Fact label="Last updated" value={formatTimestamp(step.updatedAt)} />
        {step.waitEventType ? <Fact label="Waits for" value={step.waitEventType} /> : null}
      </dl>
      {error ? <ErrorText>{error}</ErrorText> : null}
      {step.result == null ? null : <JsonValue value={step.result} />}
    </DetailPanel>
  );
}

function RunOutcomePanel({ instance }: { instance: AutomationWorkflowRun }) {
  const error = [instance.errorName, instance.errorMessage].filter(Boolean).join(": ");
  if (!error && instance.output == null) {
    return null;
  }
  return (
    <DetailPanel title={error ? "Run error" : "Run output"} eyebrow="Outcome">
      {error ? <ErrorText>{error}</ErrorText> : <JsonValue value={instance.output} />}
    </DetailPanel>
  );
}

function DetailPanel({
  title,
  eyebrow,
  children,
}: {
  title: string;
  eyebrow: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3 border-t border-[color:var(--bo-border)] py-4">
      <div>
        <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
          {eyebrow}
        </p>
        <h2 className="mt-1 text-sm font-semibold break-all text-[var(--bo-fg)]">{title}</h2>
      </div>
      {children}
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[var(--bo-muted-2)]">{label}</dt>
      <dd className="truncate text-[var(--bo-fg)] tabular-nums">{value}</dd>
    </div>
  );
}

function ErrorText({ children }: { children: ReactNode }) {
  return (
    <p className="bg-[var(--bo-failed-bg)] p-3 font-mono text-xs whitespace-pre-wrap text-[var(--bo-failed)]">
      {children}
    </p>
  );
}

function JsonValue({ value }: { value: unknown }) {
  return (
    <pre className="backoffice-scroll max-h-96 overflow-auto bg-[var(--bo-panel-2)] p-3 font-mono text-[11px] whitespace-pre-wrap text-[var(--bo-fg)]">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}
