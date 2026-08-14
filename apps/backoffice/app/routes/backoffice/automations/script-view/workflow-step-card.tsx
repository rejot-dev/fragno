import { useEffect, useState } from "react";

import type { SourceRange, StepNode } from "@fragno-dev/workflow-visualizer-tokens";

import type { BackofficeRoutableScope } from "@/backoffice-runtime/scope-codec";
import type { ResolvedWorkflowRuntimeToolCall } from "@/fragno/runtime-tools/workflow-catalog";

import { GraphBadge } from "./graph-badge";
import type { WorkflowGraphDetailMode } from "./script-view-mode";
import { SourceLocationButton } from "./source-location-button";
import type { WorkflowEventSender } from "./workflow-generated-ui";
import { hasVisibleWorkflowOutput } from "./workflow-output";
import { WorkflowOutputDisclosure } from "./workflow-output-data";
import type { WorkflowRunEvent, WorkflowStepRunState } from "./workflow-run-presentation";
import { WorkflowStepGeneratedUi } from "./workflow-step-generated-ui";

const COMPLETION_HIGHLIGHT_DURATION_MS = 2_000;
const EMPTY_RUNTIME_TOOL_CALLS: readonly ResolvedWorkflowRuntimeToolCall[] = [];
const EMPTY_WORKFLOW_EVENTS: readonly WorkflowRunEvent[] = [];
const EMPTY_WAITING_EVENT_TYPES: readonly string[] = [];

export function WorkflowStepCard({
  step,
  runtimeToolCalls = EMPTY_RUNTIME_TOOL_CALLS,
  continuationStep,
  detailMode = "simple",
  generatedUiState,
  runState,
  workflowEvents = EMPTY_WORKFLOW_EVENTS,
  workflowRunRecordId,
  currentScope,
  workflowEventSender,
  workflowEventWorkflowName,
  workflowInstanceId,
  waitingEventTypes = EMPTY_WAITING_EVENT_TYPES,
  onSourceSelect,
}: {
  step: StepNode;
  runtimeToolCalls?: readonly ResolvedWorkflowRuntimeToolCall[];
  continuationStep?: StepNode;
  detailMode?: WorkflowGraphDetailMode;
  generatedUiState?: WorkflowStepRunState;
  runState?: WorkflowStepRunState;
  workflowEvents?: readonly WorkflowRunEvent[];
  workflowRunRecordId?: string;
  currentScope?: BackofficeRoutableScope;
  workflowEventSender?: WorkflowEventSender;
  workflowEventWorkflowName?: string;
  workflowInstanceId?: string;
  waitingEventTypes?: readonly string[];
  onSourceSelect?: (source: SourceRange) => void;
}) {
  const details = [
    ...workflowStepDetails(step),
    ...(continuationStep && detailMode === "verbose" ? workflowStepDetails(continuationStep) : []),
  ];
  const hasCollapsibleOutput =
    runState?.status === "completed" && hasVisibleWorkflowOutput(runState.result);
  const recentlyCompleted = useRecentWorkflowStepCompletion(runState);
  const runPresentation = workflowStepRunPresentation(
    runState,
    recentlyCompleted,
    Boolean(continuationStep),
  );
  return (
    <div
      data-workflow-step-card
      aria-current={runState?.current ? "step" : undefined}
      className={`border p-3 ${runPresentation.surfaceClass}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-[var(--bo-fg)]">{step.label}</p>
        </div>
        <div className="flex items-center gap-2">
          {runState && runPresentation.showBadge ? (
            <WorkflowStepRunBadge state={runState} presentation={runPresentation} />
          ) : null}
          <SourceLocationButton source={step.source} onSelect={onSourceSelect} />
          {step.construction.status === "partial" ? (
            <GraphBadge label={step.construction.phase} tone="warning" />
          ) : null}
        </div>
      </div>

      <WorkflowCardDetails details={details} />

      {runtimeToolCalls.length > 0 ? (
        <div className="mt-3 space-y-3 border-t border-[color:var(--bo-border)] pt-3">
          {runtimeToolCalls.map((runtimeToolCall) => (
            <WorkflowCardDetails
              key={`${runtimeToolCall.invocation.source.start.offset}:${runtimeToolCall.tool.id}`}
              details={runtimeToolDetails(runtimeToolCall)}
              separated={false}
            />
          ))}
        </div>
      ) : null}

      <WorkflowStepGeneratedUi
        state={generatedUiState ?? runState}
        workflowEvents={workflowEvents}
        workflowRunRecordId={workflowRunRecordId}
        currentScope={currentScope}
        workflowName={workflowEventWorkflowName}
        workflowInstanceId={workflowInstanceId}
        workflowEventSender={workflowEventSender}
        waitingEventTypes={waitingEventTypes}
      />

      {hasCollapsibleOutput ? <WorkflowOutputDisclosure value={runState.result} /> : null}
    </div>
  );
}

function WorkflowStepRunBadge({
  state,
  presentation,
}: {
  state: WorkflowStepRunState;
  presentation: WorkflowStepRunPresentation;
}) {
  const attempts = state.attempts > 1 ? ` · attempt ${state.attempts}` : "";
  const emissions =
    state.emissionCount > 0
      ? ` · ${state.emissionCount} ${state.emissionCount === 1 ? "emission" : "emissions"}`
      : "";

  return (
    <span
      title={state.error ?? `${presentation.label}${attempts}${emissions}`}
      className={`flex items-center gap-1.5 border px-1.5 py-0.5 text-[8px] font-semibold tracking-[0.14em] uppercase ${presentation.badgeClass}`}
    >
      {state.current ? (
        <span
          aria-hidden="true"
          className={`h-1.5 w-1.5 animate-pulse rounded-full ${presentation.dotClass}`}
        />
      ) : null}
      {presentation.label}
      {state.attempts > 1 ? ` · ${state.attempts}` : ""}
      {state.emissionCount > 0 ? ` · ${state.emissionCount}` : ""}
    </span>
  );
}

type WorkflowStepRunPresentation = {
  label: string;
  showBadge: boolean;
  surfaceClass: string;
  badgeClass: string;
  dotClass: string;
};

function workflowStepRunPresentation(
  state: WorkflowStepRunState | undefined,
  recentlyCompleted: boolean,
  mergedWithContinuation = false,
): WorkflowStepRunPresentation {
  if (!state) {
    return neutralWorkflowStepRunPresentation();
  }

  if (state.status === "active") {
    return {
      label: "Running",
      showBadge: true,
      surfaceClass:
        "border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] shadow-[0_0_0_1px_var(--bo-accent)]",
      badgeClass: "border-[color:var(--bo-accent)] bg-[var(--bo-panel)] text-[var(--bo-accent-fg)]",
      dotClass: "bg-[var(--bo-accent)]",
    };
  }

  if (state.status === "waiting") {
    return {
      label: state.attempts > 1 ? "Retrying" : "Waiting",
      showBadge: true,
      surfaceClass: mergedWithContinuation
        ? "border-amber-500/55 bg-[var(--bo-panel)] shadow-[0_0_0_1px_rgb(245_158_11_/_0.2)]"
        : "border-amber-500/55 bg-amber-500/8 shadow-[0_0_0_1px_rgb(245_158_11_/_0.2)]",
      badgeClass: "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200",
      dotClass: "bg-amber-500",
    };
  }

  if (state.status === "errored") {
    return {
      label: "Errored",
      showBadge: true,
      surfaceClass: "border-red-500/45 bg-red-500/8",
      badgeClass: "border-red-500/35 bg-red-500/10 text-red-800 dark:text-red-200",
      dotClass: "bg-red-500",
    };
  }

  if (state.status === "completed") {
    if (!recentlyCompleted) {
      return neutralWorkflowStepRunPresentation();
    }

    return {
      label: "Complete",
      showBadge: true,
      surfaceClass: "border-emerald-500/35 bg-emerald-500/5",
      badgeClass: "border-emerald-500/30 bg-emerald-500/8 text-emerald-800 dark:text-emerald-200",
      dotClass: "bg-emerald-500",
    };
  }

  return neutralWorkflowStepRunPresentation();
}

function neutralWorkflowStepRunPresentation(): WorkflowStepRunPresentation {
  return {
    label: "",
    showBadge: false,
    surfaceClass: "border-[color:var(--bo-border)] bg-[var(--bo-panel)]",
    badgeClass: "",
    dotClass: "",
  };
}

function useRecentWorkflowStepCompletion(state?: WorkflowStepRunState): boolean {
  const [, refreshCompletionState] = useState(0);
  const completionExpiresAt = workflowStepCompletionExpiresAt(state);
  const recentlyCompleted = completionExpiresAt > Date.now();

  useEffect(() => {
    if (!recentlyCompleted) {
      return undefined;
    }

    const timeout = window.setTimeout(
      () => {
        refreshCompletionState((version) => version + 1);
      },
      Math.max(0, completionExpiresAt - Date.now()),
    );
    return () => {
      window.clearTimeout(timeout);
    };
  }, [completionExpiresAt, recentlyCompleted]);

  return recentlyCompleted;
}

function workflowStepCompletionExpiresAt(state?: WorkflowStepRunState): number {
  if (!state?.completedAt || state.status !== "completed") {
    return 0;
  }

  const completedAt =
    state.completedAt instanceof Date
      ? state.completedAt.valueOf()
      : new Date(state.completedAt).valueOf();
  return Number.isFinite(completedAt) ? completedAt + COMPLETION_HIGHLIGHT_DURATION_MS : 0;
}

function WorkflowCardDetails({
  details,
  separated = true,
}: {
  details: ReadonlyArray<readonly [string, string]>;
  separated?: boolean;
}) {
  if (details.length === 0) {
    return null;
  }

  return (
    <dl
      className={`grid gap-x-3 gap-y-2 sm:grid-cols-[5rem_minmax(0,1fr)] ${separated ? "mt-3 border-t border-[color:var(--bo-border)] pt-3" : ""}`}
    >
      {details.map(([label, value]) => (
        <div key={label} className="grid grid-cols-[5rem_minmax(0,1fr)] gap-3 sm:contents">
          <dt className="text-[9px] font-semibold tracking-[0.16em] text-[var(--bo-muted-2)] uppercase">
            {label}
          </dt>
          <dd className="font-mono text-[11px] leading-4 break-all text-[var(--bo-muted)]">
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function runtimeToolDetails({
  tool,
  scope,
}: ResolvedWorkflowRuntimeToolCall): Array<[string, string]> {
  return [
    ["tool", tool.qualifiedName],
    ["scope", scope],
    ["description", tool.description ?? tool.summary],
  ];
}

function workflowStepDetails(step: StepNode): Array<[string, string]> {
  return [
    step.meta.duration ? ["duration", step.meta.duration] : undefined,
    step.meta.until ? ["until", step.meta.until] : undefined,
    step.meta.eventType ? ["event", step.meta.eventType] : undefined,
    step.meta.timeout ? ["timeout", step.meta.timeout] : undefined,
  ].filter((detail): detail is [string, string] => detail !== undefined);
}
