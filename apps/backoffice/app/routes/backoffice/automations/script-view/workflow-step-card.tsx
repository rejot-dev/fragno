import type { SourceRange, StepNode } from "@fragno-dev/workflow-visualizer-tokens";

import type { ResolvedWorkflowRuntimeToolCall } from "@/fragno/runtime-tools/workflow-catalog";

import { GraphBadge } from "./graph-badge";
import { SourceLocationButton } from "./source-location-button";

export function WorkflowStepCard({
  step,
  runtimeToolCalls = [],
  onSourceSelect,
}: {
  step: StepNode;
  runtimeToolCalls?: readonly ResolvedWorkflowRuntimeToolCall[];
  onSourceSelect?: (source: SourceRange) => void;
}) {
  const details = workflowStepDetails(step);
  return (
    <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[9px] font-semibold tracking-[0.2em] text-[var(--bo-muted-2)] uppercase">
            {step.stepType}
          </p>
          <p className="mt-1 text-sm font-medium text-[var(--bo-fg)]">{step.label}</p>
        </div>
        <div className="flex items-center gap-2">
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
