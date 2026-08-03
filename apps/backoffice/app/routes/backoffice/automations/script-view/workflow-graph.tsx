import {
  AlertTriangle,
  CheckCircle2,
  Code2,
  GitBranch,
  Layers3,
  LogOut,
  OctagonX,
  Repeat2,
  ShieldCheck,
  Workflow as WorkflowIcon,
} from "lucide-react";

import type {
  BranchNode,
  ConditionNode,
  LoopNode,
  ParallelNode,
  SourceRange,
  SpecificEventGuardAnnotation,
  StepNode,
  TerminalNode,
  WorkflowChildNode,
  WorkflowVisualizationSnapshot,
} from "@fragno-dev/workflow-visualizer-tokens";

import { parseBackofficeUiResult } from "@/backoffice-ui/result";
import type { ResolvedWorkflowRuntimeToolCall } from "@/fragno/runtime-tools/workflow-catalog";

import { GraphBadge } from "./graph-badge";
import type { LinkedScrollViewport } from "./linked-scroll";
import type { WorkflowGraphDetailMode } from "./script-view-mode";
import { SourceLocationButton } from "./source-location-button";
import { WorkflowGeneratedUi, type WorkflowEventSender } from "./workflow-generated-ui";
import {
  countRenderedWorkflowSteps,
  createWorkflowGraphPresentation,
  workflowTerminalDetails,
  type WorkflowEventGuardPresentation,
} from "./workflow-graph-presentation";
import { hasVisibleWorkflowOutput } from "./workflow-output";
import { WorkflowOutputDisclosure } from "./workflow-output-data";
import type {
  ScriptWorkflowRun,
  WorkflowRunEvent,
  WorkflowStepRunState,
} from "./workflow-run-presentation";
import { WorkflowStepCard } from "./workflow-step-card";
import {
  createWorkflowUiWaitPairings,
  workflowUiWaitRunState,
  type WorkflowUiWaitPairings,
} from "./workflow-ui-wait-pairing";

export function ScriptWorkflowGraph({
  visualization,
  detailMode,
  runtimeToolCallsByStepId,
  selectedRun,
  scrollViewport,
  fillHeight = false,
  workflowEventSender,
  onSourceSelect,
}: {
  visualization: WorkflowVisualizationSnapshot;
  detailMode: WorkflowGraphDetailMode;
  runtimeToolCallsByStepId: ReadonlyMap<string, readonly ResolvedWorkflowRuntimeToolCall[]>;
  selectedRun: ScriptWorkflowRun | null;
  scrollViewport?: LinkedScrollViewport;
  fillHeight?: boolean;
  workflowEventSender?: WorkflowEventSender;
  onSourceSelect?: (source: SourceRange) => void;
}) {
  const workflows = visualization.graph.nodes.filter((node) => node.kind === "workflow");
  const presentation = createWorkflowGraphPresentation(visualization);

  return (
    <div
      {...scrollViewport}
      tabIndex={0}
      aria-label="Workflow graph"
      className={`backoffice-scroll overflow-auto overscroll-contain bg-[var(--bo-panel-2)] p-4 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[color:var(--bo-accent)] ${fillHeight ? "h-full min-h-0" : "max-h-[calc(100vh-10rem)] min-h-[36rem]"}`}
    >
      {workflows.length === 0 ? (
        <NonWorkflowMessage />
      ) : (
        <div className="space-y-6">
          {workflows.map((workflow) => {
            const eventGuard = presentation.eventGuardByWorkflowId.get(workflow.id);
            const rawStepCount = countRenderedWorkflowSteps(
              workflow.id,
              presentation.childrenByParent,
            );
            const workflowRun =
              selectedRun?.workflowName === workflow.name ? selectedRun : undefined;
            const uiWaitPairings = createWorkflowUiWaitPairings({
              childrenByParent: presentation.childrenByParent,
              stepStatesByNodeId: workflowRun?.stepStatesByNodeId,
            });
            const stepCount = rawStepCount - uiWaitPairings.byUiStepId.size;
            const hasCurrentStep = workflowRun
              ? [...workflowRun.stepStatesByNodeId.values()].some((state) => state.current)
              : false;

            return (
              <section key={workflow.id} aria-labelledby={`${workflow.id}-title`}>
                <div className="flex items-start gap-3 border border-[color:var(--bo-border-strong)] bg-[var(--bo-panel)] p-3">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] text-[var(--bo-accent-fg)]">
                    <WorkflowIcon className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3
                        id={`${workflow.id}-title`}
                        className="truncate text-sm font-semibold text-[var(--bo-fg)]"
                      >
                        {workflow.name}
                      </h3>
                      {workflow.remote ? <GraphBadge label="Remote" /> : null}
                      {workflowRun ? (
                        <GraphBadge label={`${workflowRun.status} run`} tone="active" />
                      ) : null}
                      {workflowRun?.status === "active" && !hasCurrentStep ? (
                        <GraphBadge label="Between checkpoints" />
                      ) : null}
                      <SourceLocationButton source={workflow.source} onSelect={onSourceSelect} />
                      {workflow.construction.status === "partial" ? (
                        <GraphBadge label={workflow.construction.phase} tone="warning" />
                      ) : null}
                    </div>
                    <p className="mt-1 font-mono text-[10px] text-[var(--bo-muted-2)] tabular-nums">
                      {stepCount} durable {stepCount === 1 ? "step" : "steps"}
                    </p>
                    {eventGuard ? (
                      <WorkflowEventGuard eventGuard={eventGuard} onSourceSelect={onSourceSelect} />
                    ) : null}
                  </div>
                </div>

                {detailMode === "ui" ? (
                  <WorkflowUiResults
                    workflowId={workflow.id}
                    childrenByParent={presentation.childrenByParent}
                    run={workflowRun}
                    uiWaitPairings={uiWaitPairings}
                    workflowEventSender={workflowEventSender}
                    onSourceSelect={onSourceSelect}
                  />
                ) : (
                  <>
                    <WorkflowChildTree
                      parentId={workflow.id}
                      childrenByParent={presentation.childrenByParent}
                      detailMode={detailMode}
                      runtimeToolCallsByStepId={runtimeToolCallsByStepId}
                      stepStatesByNodeId={workflowRun?.stepStatesByNodeId}
                      uiWaitPairings={uiWaitPairings}
                      workflowEvents={workflowRun?.workflowEvents}
                      workflowRunRecordId={workflowRun?.id}
                      workflowEventSender={workflowEventSender}
                      workflowEventWorkflowName={workflowRun?.instanceWorkflowName}
                      workflowInstanceId={workflowRun?.instanceId}
                      waitingEventTypes={workflowRun?.waitingEventTypes}
                      workflowRun={workflowRun}
                      onSourceSelect={onSourceSelect}
                    />
                  </>
                )}
              </section>
            );
          })}
        </div>
      )}

      <WorkflowDiagnostics visualization={visualization} />
    </div>
  );
}

function WorkflowUiResults({
  workflowId,
  childrenByParent,
  run,
  uiWaitPairings,
  workflowEventSender,
  onSourceSelect,
}: {
  workflowId: string;
  childrenByParent: Map<string, WorkflowChildNode[]>;
  run?: ScriptWorkflowRun;
  uiWaitPairings: WorkflowUiWaitPairings;
  workflowEventSender?: WorkflowEventSender;
  onSourceSelect?: (source: SourceRange) => void;
}) {
  const uiSteps = collectWorkflowUiSteps(workflowId, childrenByParent, run?.stepStatesByNodeId);
  const hasFinalOutput = workflowRunHasGeneratedUiOutput(run);

  if (uiSteps.length === 0 && !hasFinalOutput) {
    return (
      <p className="mt-3 border border-dashed border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3 text-xs text-[var(--bo-muted)]">
        No generated UI results yet.
      </p>
    );
  }

  return (
    <div className="mt-3 space-y-3">
      {uiSteps.map((step) => {
        const pair = uiWaitPairings.byUiStepId.get(step.id);
        return (
          <WorkflowStepCard
            key={step.id}
            step={step}
            continuationStep={pair?.waitStep}
            detailMode="ui"
            generatedUiState={pair?.uiState}
            runState={pair ? workflowUiWaitRunState(pair) : run?.stepStatesByNodeId.get(step.id)}
            workflowEvents={run?.workflowEvents}
            workflowRunRecordId={run?.id}
            workflowEventSender={workflowEventSender}
            workflowEventWorkflowName={run?.instanceWorkflowName}
            workflowInstanceId={run?.instanceId}
            waitingEventTypes={run?.waitingEventTypes}
            onSourceSelect={onSourceSelect}
          />
        );
      })}
      <WorkflowFinalOutput run={run} />
    </div>
  );
}

function collectWorkflowUiSteps(
  parentId: string,
  childrenByParent: Map<string, WorkflowChildNode[]>,
  stepStatesByNodeId?: ReadonlyMap<string, WorkflowStepRunState>,
): StepNode[] {
  return (childrenByParent.get(parentId) ?? []).flatMap((child) => {
    const nestedUiSteps = collectWorkflowUiSteps(child.id, childrenByParent, stepStatesByNodeId);
    if (child.kind !== "step") {
      return nestedUiSteps;
    }

    const runState = stepStatesByNodeId?.get(child.id);
    return runState?.status === "completed" &&
      parseBackofficeUiResult(runState.result).kind !== "ordinary"
      ? [child, ...nestedUiSteps]
      : nestedUiSteps;
  });
}

function WorkflowFinalOutput({ run }: { run?: ScriptWorkflowRun }) {
  if (!workflowRunHasGeneratedUiOutput(run)) {
    return null;
  }

  return (
    <div
      data-workflow-final-output
      className="mt-3 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3"
    >
      <p className="text-[9px] font-semibold tracking-[0.2em] text-[var(--bo-muted-2)] uppercase">
        Final output
      </p>
      <div className="mt-3 border-t border-[color:var(--bo-border)] pt-3">
        <WorkflowGeneratedUi value={run.output} />
      </div>
    </div>
  );
}

function workflowRunHasGeneratedUiOutput(
  run: ScriptWorkflowRun | undefined,
): run is ScriptWorkflowRun {
  return run?.status === "complete" && parseBackofficeUiResult(run.output).kind !== "ordinary";
}

function WorkflowEventGuard({
  eventGuard,
  onSourceSelect,
}: {
  eventGuard: WorkflowEventGuardPresentation;
  onSourceSelect?: (source: SourceRange) => void;
}) {
  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[color:var(--bo-border)] pt-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="flex items-center gap-1.5 text-[9px] font-semibold tracking-[0.18em] text-[var(--bo-accent-fg)] uppercase">
          <ShieldCheck className="h-3.5 w-3.5" />
          Runs on
        </span>
        <code className="font-mono text-xs font-semibold text-[var(--bo-fg)]">
          {eventGuard.eventSource}
        </code>
        <span className="font-mono text-[10px] text-[var(--bo-muted-2)]">/</span>
        <code className="font-mono text-xs text-[var(--bo-fg)]">{eventGuard.eventType}</code>
      </div>
      <SourceLocationButton source={eventGuard.source} onSelect={onSourceSelect} />
    </div>
  );
}

function WorkflowChildTree({
  parentId,
  childrenByParent,
  detailMode,
  runtimeToolCallsByStepId,
  stepStatesByNodeId,
  uiWaitPairings,
  workflowEvents,
  workflowRunRecordId,
  workflowEventSender,
  workflowEventWorkflowName,
  workflowInstanceId,
  waitingEventTypes,
  workflowRun,
  onSourceSelect,
}: {
  parentId: string;
  childrenByParent: Map<string, WorkflowChildNode[]>;
  detailMode: WorkflowGraphDetailMode;
  runtimeToolCallsByStepId: ReadonlyMap<string, readonly ResolvedWorkflowRuntimeToolCall[]>;
  stepStatesByNodeId?: ReadonlyMap<string, WorkflowStepRunState>;
  uiWaitPairings: WorkflowUiWaitPairings;
  workflowEvents?: readonly WorkflowRunEvent[];
  workflowRunRecordId?: string;
  workflowEventSender?: WorkflowEventSender;
  workflowEventWorkflowName?: string;
  workflowInstanceId?: string;
  waitingEventTypes?: readonly string[];
  workflowRun?: ScriptWorkflowRun;
  onSourceSelect?: (source: SourceRange) => void;
}) {
  const children = (childrenByParent.get(parentId) ?? []).filter(
    (child) => !uiWaitPairings.uiStepIdByWaitStepId.has(child.id),
  );
  if (children.length === 0) {
    return null;
  }

  return (
    <ol className="ml-4 border-l border-[color:var(--bo-border-strong)] pl-5">
      {children.map((child) => {
        const pair = uiWaitPairings.byUiStepId.get(child.id);
        return (
          <li key={child.id} className="relative pt-3 first:pt-4">
            <span className="absolute top-7 -left-[1.65rem] flex h-5 w-5 items-center justify-center border border-[color:var(--bo-border-strong)] bg-[var(--bo-panel-2)] font-mono text-[9px] font-semibold text-[var(--bo-muted)] tabular-nums">
              {child.kind === "branch" ? child.index + 1 : child.order}
            </span>
            <WorkflowChildCard
              child={child}
              detailMode={detailMode}
              runtimeToolCalls={runtimeToolCallsByStepId.get(child.id)}
              continuationStep={pair?.waitStep}
              generatedUiState={pair?.uiState}
              runState={pair ? workflowUiWaitRunState(pair) : stepStatesByNodeId?.get(child.id)}
              workflowEvents={workflowEvents}
              workflowRunRecordId={workflowRunRecordId}
              workflowEventSender={workflowEventSender}
              workflowEventWorkflowName={workflowEventWorkflowName}
              workflowInstanceId={workflowInstanceId}
              waitingEventTypes={waitingEventTypes}
              workflowRun={workflowRun}
              onSourceSelect={onSourceSelect}
            />
            <WorkflowChildTree
              parentId={child.id}
              childrenByParent={childrenByParent}
              detailMode={detailMode}
              runtimeToolCallsByStepId={runtimeToolCallsByStepId}
              stepStatesByNodeId={stepStatesByNodeId}
              uiWaitPairings={uiWaitPairings}
              workflowEvents={workflowEvents}
              workflowRunRecordId={workflowRunRecordId}
              workflowEventSender={workflowEventSender}
              workflowEventWorkflowName={workflowEventWorkflowName}
              workflowInstanceId={workflowInstanceId}
              waitingEventTypes={waitingEventTypes}
              workflowRun={workflowRun}
              onSourceSelect={onSourceSelect}
            />
          </li>
        );
      })}
    </ol>
  );
}

function WorkflowChildCard({
  child,
  detailMode,
  runtimeToolCalls,
  continuationStep,
  generatedUiState,
  runState,
  workflowEvents,
  workflowRunRecordId,
  workflowEventSender,
  workflowEventWorkflowName,
  workflowInstanceId,
  waitingEventTypes,
  workflowRun,
  onSourceSelect,
}: {
  child: WorkflowChildNode;
  detailMode: WorkflowGraphDetailMode;
  runtimeToolCalls?: readonly ResolvedWorkflowRuntimeToolCall[];
  continuationStep?: StepNode;
  generatedUiState?: WorkflowStepRunState;
  runState?: WorkflowStepRunState;
  workflowEvents?: readonly WorkflowRunEvent[];
  workflowRunRecordId?: string;
  workflowEventSender?: WorkflowEventSender;
  workflowEventWorkflowName?: string;
  workflowInstanceId?: string;
  waitingEventTypes?: readonly string[];
  workflowRun?: ScriptWorkflowRun;
  onSourceSelect?: (source: SourceRange) => void;
}) {
  switch (child.kind) {
    case "step":
      return (
        <WorkflowStepCard
          step={child}
          runtimeToolCalls={detailMode === "verbose" ? runtimeToolCalls : undefined}
          continuationStep={continuationStep}
          detailMode={detailMode}
          generatedUiState={generatedUiState}
          runState={runState}
          workflowEvents={workflowEvents}
          workflowRunRecordId={workflowRunRecordId}
          workflowEventSender={workflowEventSender}
          workflowEventWorkflowName={workflowEventWorkflowName}
          workflowInstanceId={workflowInstanceId}
          waitingEventTypes={waitingEventTypes}
          onSourceSelect={onSourceSelect}
        />
      );
    case "condition":
      return <ConditionCard condition={child} onSourceSelect={onSourceSelect} />;
    case "loop":
      return <LoopCard loop={child} onSourceSelect={onSourceSelect} />;
    case "parallel":
      return <ParallelCard parallel={child} onSourceSelect={onSourceSelect} />;
    case "branch":
      return <BranchCard branch={child} onSourceSelect={onSourceSelect} />;
    case "terminal":
      return (
        <TerminalCard
          terminal={child}
          detailMode={detailMode}
          workflowRun={workflowRun}
          onSourceSelect={onSourceSelect}
        />
      );
  }
  return null;
}

function ConditionCard({
  condition,
  onSourceSelect,
}: {
  condition: ConditionNode;
  onSourceSelect?: (source: SourceRange) => void;
}) {
  const eventGuard =
    condition.analysis.status === "complete"
      ? condition.analysis.annotations.find(
          (candidate): candidate is SpecificEventGuardAnnotation =>
            candidate.kind === "specific-event-guard",
        )
      : undefined;

  return (
    <div className="border border-[color:var(--bo-accent)]/40 bg-[var(--bo-accent-bg)] p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[9px] font-semibold tracking-[0.2em] text-[var(--bo-accent-fg)] uppercase">
            {eventGuard ? (
              <ShieldCheck className="h-3.5 w-3.5" />
            ) : (
              <GitBranch className="h-3.5 w-3.5" />
            )}
            {eventGuard ? "Specific event guard" : "If"}
          </div>
          {eventGuard ? (
            <div className="mt-2">
              <p className="font-mono text-sm font-semibold text-[var(--bo-fg)]">
                {eventGuard.eventSource}
                <span className="text-[var(--bo-muted-2)]"> · </span>
                {eventGuard.eventType}
              </p>
              <p className="mt-1 font-mono text-[10px] text-[var(--bo-muted-2)]">
                {semanticReferenceLabel(eventGuard.subject)}
              </p>
              {eventGuard.rejectionReason ? (
                <p className="mt-1 text-[10px] text-[var(--bo-muted)]">
                  Other events exit as{" "}
                  <span className="font-mono text-[var(--bo-fg)]">
                    {eventGuard.rejectionReason}
                  </span>
                </p>
              ) : null}
              <code className="mt-2 block border-t border-[color:var(--bo-border)] pt-2 font-mono text-[10px] leading-4 break-all text-[var(--bo-muted)]">
                {condition.condition}
              </code>
            </div>
          ) : (
            <code className="mt-2 block font-mono text-xs leading-5 break-all text-[var(--bo-fg)]">
              {condition.condition || "Condition still being written"}
            </code>
          )}
        </div>
        <div className="flex items-center gap-2">
          <SourceLocationButton source={condition.source} onSelect={onSourceSelect} />
          {condition.construction.status === "partial" ? (
            <GraphBadge label={condition.construction.phase} tone="warning" />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function semanticReferenceLabel(reference: { root: string; path: string[] }): string {
  return [reference.root, ...reference.path].join(".");
}

function LoopCard({
  loop,
  onSourceSelect,
}: {
  loop: LoopNode;
  onSourceSelect?: (source: SourceRange) => void;
}) {
  return (
    <div className="border border-violet-500/35 bg-violet-500/8 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[9px] font-semibold tracking-[0.2em] text-violet-800 uppercase dark:text-violet-200">
            <Repeat2 className="h-3.5 w-3.5" />
            {loop.loopType} loop
          </div>
          <code className="mt-2 block font-mono text-xs leading-5 break-all text-[var(--bo-fg)]">
            {loop.expression || "Loop header still being written"}
          </code>
        </div>
        <div className="flex items-center gap-2">
          <SourceLocationButton source={loop.source} onSelect={onSourceSelect} />
          {loop.construction.status === "partial" ? (
            <GraphBadge label={loop.construction.phase} tone="warning" />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ParallelCard({
  parallel,
  onSourceSelect,
}: {
  parallel: ParallelNode;
  onSourceSelect?: (source: SourceRange) => void;
}) {
  return (
    <div className="border border-sky-500/35 bg-sky-500/8 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[9px] font-semibold tracking-[0.2em] text-sky-800 uppercase dark:text-sky-200">
            <Layers3 className="h-3.5 w-3.5" />
            Parallel · {parallel.strategy}
          </div>
          <p className="mt-1.5 font-mono text-xs text-[var(--bo-fg)]">{parallel.label}</p>
        </div>
        <div className="flex items-center gap-2">
          <SourceLocationButton source={parallel.source} onSelect={onSourceSelect} />
          {parallel.construction.status === "partial" ? (
            <GraphBadge label={parallel.construction.phase} tone="warning" />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function TerminalCard({
  terminal,
  detailMode,
  workflowRun,
  onSourceSelect,
}: {
  terminal: TerminalNode;
  detailMode: WorkflowGraphDetailMode;
  workflowRun?: ScriptWorkflowRun;
  onSourceSelect?: (source: SourceRange) => void;
}) {
  const presentation = terminalPresentation(terminal);
  const runtimeOutput =
    terminal.terminalType === "final-return" && workflowRun?.status === "complete"
      ? workflowRun.output
      : undefined;
  const showsRuntimeOutput =
    terminal.terminalType === "final-return" &&
    workflowRun?.status === "complete" &&
    hasVisibleWorkflowOutput(runtimeOutput);
  const terminalDetails = workflowTerminalDetails(terminal, detailMode);
  const details = showsRuntimeOutput ? { ...terminalDetails, value: undefined } : terminalDetails;
  const Icon = presentation.icon;

  return (
    <div className={`border p-3 ${presentation.surfaceClass}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div
            className={`flex items-center gap-2 text-[9px] font-semibold tracking-[0.2em] uppercase ${presentation.labelClass}`}
          >
            <Icon className="h-3.5 w-3.5" />
            {presentation.label}
          </div>
          {details.label ? (
            <p className="mt-1.5 text-sm font-medium text-[var(--bo-fg)]">{details.label}</p>
          ) : null}
          {details.value ? (
            <code className="mt-2 block font-mono text-[11px] leading-5 break-all text-[var(--bo-muted)]">
              {details.value}
            </code>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <SourceLocationButton source={terminal.source} onSelect={onSourceSelect} />
          {terminal.construction.status === "partial" ? (
            <GraphBadge label={terminal.construction.phase} tone="warning" />
          ) : null}
        </div>
      </div>
      {showsRuntimeOutput ? (
        <div data-workflow-final-return-output>
          <WorkflowOutputDisclosure value={runtimeOutput} />
        </div>
      ) : null}
    </div>
  );
}

function terminalPresentation(terminal: TerminalNode) {
  switch (terminal.terminalType) {
    case "early-return":
      return {
        label: "Early exit",
        icon: LogOut,
        surfaceClass: "border-amber-500/35 bg-amber-500/8",
        labelClass: "text-amber-800 dark:text-amber-200",
      };
    case "final-return":
      return {
        label: "Final return",
        icon: CheckCircle2,
        surfaceClass: "border-emerald-500/35 bg-emerald-500/8",
        labelClass: "text-emerald-800 dark:text-emerald-200",
      };
    case "error":
      return {
        label: "Error",
        icon: OctagonX,
        surfaceClass: "border-red-500/35 bg-red-500/8",
        labelClass: "text-red-800 dark:text-red-200",
      };
  }
  throw new Error("Unsupported terminal type.");
}

function BranchCard({
  branch,
  onSourceSelect,
}: {
  branch: BranchNode;
  onSourceSelect?: (source: SourceRange) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border border-dashed border-[color:var(--bo-border-strong)] bg-[var(--bo-panel)] px-3 py-2">
      <p className="text-[9px] font-semibold tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
        {branch.branchType === "parallel" ? `Parallel branch ${branch.index + 1}` : branch.label}
      </p>
      <SourceLocationButton source={branch.source} onSelect={onSourceSelect} />
    </div>
  );
}

function NonWorkflowMessage() {
  return (
    <div className="flex min-h-[32rem] items-center justify-center">
      <div className="max-w-sm border border-dashed border-[color:var(--bo-border-strong)] bg-[var(--bo-panel)] p-5 text-center">
        <Code2 className="mx-auto h-5 w-5 text-[var(--bo-muted-2)]" />
        <p className="mt-3 text-sm font-semibold text-[var(--bo-fg)]">This is a Codemode script</p>
        <p className="mt-2 text-xs leading-5 text-[var(--bo-muted)]">
          No direct <code className="font-mono">defineWorkflow()</code> call was found, so there is
          no durable workflow graph to display.
        </p>
      </div>
    </div>
  );
}

function WorkflowDiagnostics({ visualization }: { visualization: WorkflowVisualizationSnapshot }) {
  if (visualization.graph.diagnostics.length === 0) {
    return null;
  }

  return (
    <div className="mt-5 border border-amber-500/30 bg-amber-500/8 p-3">
      <div className="flex items-center gap-2 text-[10px] font-semibold tracking-[0.18em] text-amber-800 uppercase dark:text-amber-200">
        <AlertTriangle className="h-3.5 w-3.5" />
        Parser notes
      </div>
      <ul className="mt-2 space-y-1.5 text-xs text-[var(--bo-muted)]">
        {visualization.graph.diagnostics.map((diagnostic) => (
          <li
            key={`${diagnostic.code}:${diagnostic.source.start.line}:${diagnostic.source.start.column}:${diagnostic.message}`}
          >
            <span className="font-mono text-[10px] text-[var(--bo-muted-2)] tabular-nums">
              {diagnostic.source.start.line}:{diagnostic.source.start.column + 1}
            </span>{" "}
            {diagnostic.message}
          </li>
        ))}
      </ul>
    </div>
  );
}
