import type { SourceRange, StepNode } from "@fragno-dev/workflow-visualizer-tokens";

import type { ResolvedWorkflowRuntimeToolCall } from "@/fragno/runtime-tools/workflow-catalog";

import { GraphBadge } from "./graph-badge";
import { SourceLocationButton } from "./source-location-button";
import type { WorkflowStepRunState } from "./workflow-run-presentation";

export function WorkflowStepCard({
  step,
  runtimeToolCalls = [],
  runState,
  onSourceSelect,
}: {
  step: StepNode;
  runtimeToolCalls?: readonly ResolvedWorkflowRuntimeToolCall[];
  runState?: WorkflowStepRunState;
  onSourceSelect?: (source: SourceRange) => void;
}) {
  const details = workflowStepDetails(step);
  const runPresentation = workflowStepRunPresentation(runState);
  return (
    <div
      aria-current={runState?.current ? "step" : undefined}
      className={`border p-3 ${runPresentation.surfaceClass}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[9px] font-semibold tracking-[0.2em] text-[var(--bo-muted-2)] uppercase">
            {step.stepType}
          </p>
          <p className="mt-1 text-sm font-medium text-[var(--bo-fg)]">{step.label}</p>
        </div>
        <div className="flex items-center gap-2">
          {runState ? <WorkflowStepRunBadge state={runState} /> : null}
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
    </div>
  );
}

function WorkflowStepRunBadge({ state }: { state: WorkflowStepRunState }) {
  const presentation = workflowStepRunPresentation(state);
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

function workflowStepRunPresentation(state?: WorkflowStepRunState) {
  if (!state) {
    return {
      label: "",
      surfaceClass: "border-[color:var(--bo-border)] bg-[var(--bo-panel)]",
      badgeClass: "",
      dotClass: "",
    };
  }

  if (state.status === "active" || state.status === "running") {
    return {
      label: "Running",
      surfaceClass:
        "border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] shadow-[0_0_0_1px_var(--bo-accent)]",
      badgeClass: "border-[color:var(--bo-accent)] bg-[var(--bo-panel)] text-[var(--bo-accent-fg)]",
      dotClass: "bg-[var(--bo-accent)]",
    };
  }

  if (state.status === "waiting") {
    return {
      label: "Waiting",
      surfaceClass: "border-amber-500/55 bg-amber-500/8 shadow-[0_0_0_1px_rgb(245_158_11_/_0.2)]",
      badgeClass: "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200",
      dotClass: "bg-amber-500",
    };
  }

  if (state.status === "errored" || state.status === "failed") {
    return {
      label: "Errored",
      surfaceClass: "border-red-500/45 bg-red-500/8",
      badgeClass: "border-red-500/35 bg-red-500/10 text-red-800 dark:text-red-200",
      dotClass: "bg-red-500",
    };
  }

  if (state.status === "completed" || state.status === "complete") {
    return {
      label: "Complete",
      surfaceClass: "border-emerald-500/35 bg-emerald-500/5",
      badgeClass: "border-emerald-500/30 bg-emerald-500/8 text-emerald-800 dark:text-emerald-200",
      dotClass: "bg-emerald-500",
    };
  }

  return {
    label: state.status,
    surfaceClass: "border-[color:var(--bo-border-strong)] bg-[var(--bo-panel)]",
    badgeClass: "border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] text-[var(--bo-muted)]",
    dotClass: "bg-[var(--bo-muted)]",
  };
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
