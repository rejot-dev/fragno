import { Code2, Columns2, Workflow as WorkflowIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { useSearchParams } from "react-router";

import { visualizeWorkflowSource, type SourceRange } from "@fragno-dev/workflow-visualizer-tokens";

import type { AutomationCollections } from "@/fragno/automation/tanstack/collections";
import {
  resolveWorkflowRuntimeToolCalls,
  type RuntimeToolWorkflowDescriptor,
} from "@/fragno/runtime-tools/workflow-catalog";

import { useLinkedScrollViewports, type LinkedScrollViewport } from "./linked-scroll";
import {
  SCRIPT_VIEW_MODE_SEARCH_PARAM,
  WORKFLOW_GRAPH_DETAIL_MODE_SEARCH_PARAM,
  WORKFLOW_RUN_SEARCH_PARAM,
  scriptViewModeFromSearchParam,
  searchParamsWithScriptViewMode,
  searchParamsWithWorkflowGraphDetailMode,
  workflowGraphDetailModeFromSearchParam,
  type ScriptViewMode,
  type WorkflowGraphDetailMode,
} from "./script-view-mode";
import { useScriptWorkflowRuns } from "./use-script-workflow-runs";
import { ScriptWorkflowGraph } from "./workflow-graph";
import type { ScriptWorkflowRun } from "./workflow-run-presentation";

const SCRIPT_VIEW_OPTIONS: Array<{
  mode: ScriptViewMode;
  label: string;
  icon: ComponentType<{ className?: string }>;
}> = [
  { mode: "code", label: "Code", icon: Code2 },
  { mode: "graph", label: "Graph", icon: WorkflowIcon },
  { mode: "split", label: "Both", icon: Columns2 },
];

export function ScriptSourcePanel({
  absolutePath,
  source,
  runtimeToolCatalog,
  collections,
}: {
  absolutePath: string;
  source: { script: string | null; scriptError: string | null };
  runtimeToolCatalog: readonly RuntimeToolWorkflowDescriptor[];
  collections: Pick<
    AutomationCollections,
    "workflowInstances" | "workflowSteps" | "workflowStepEmissions"
  >;
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const viewMode = scriptViewModeFromSearchParam(searchParams.get(SCRIPT_VIEW_MODE_SEARCH_PARAM));
  const graphDetailMode = workflowGraphDetailModeFromSearchParam(
    searchParams.get(WORKFLOW_GRAPH_DETAIL_MODE_SEARCH_PARAM),
  );
  const script = source.script ?? "";
  const [selectedSource, setSelectedSource] = useState<SourceRange>();
  const currentSourceSelection = selectedSource?.path === absolutePath ? selectedSource : undefined;
  const visualization = useMemo(
    () => visualizeWorkflowSource(absolutePath, script),
    [absolutePath, script],
  );
  const runtimeToolCallsByStepId = useMemo(
    () => resolveWorkflowRuntimeToolCalls({ visualization, catalog: runtimeToolCatalog }),
    [runtimeToolCatalog, visualization],
  );
  const workflowRuns = useScriptWorkflowRuns({
    absolutePath,
    collections,
    selectedInstanceId: searchParams.get(WORKFLOW_RUN_SEARCH_PARAM),
    visualization,
  });
  const { codeViewport, graphViewport, suspendCodeScrollLink } = useLinkedScrollViewports(
    viewMode === "split",
  );

  if (source.scriptError) {
    return null;
  }

  const showCode = viewMode === "code" || viewMode === "split";
  const showGraph = viewMode === "graph" || viewMode === "split";

  return (
    <div className="overflow-hidden border border-[color:var(--bo-border)] bg-[var(--bo-panel)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[color:var(--bo-border)] px-4 py-3">
        <p className="min-w-0 flex-1 font-mono text-[11px] break-all text-[var(--bo-muted-2)]">
          {absolutePath}
        </p>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          {showGraph ? (
            <WorkflowRunSelector
              runs={workflowRuns.runs}
              selectedRun={workflowRuns.selectedRun}
              isLoading={workflowRuns.isLoading}
              error={workflowRuns.error}
              onSelect={(instanceId) => {
                setSearchParams(
                  (currentSearchParams) => {
                    const nextSearchParams = new URLSearchParams(currentSearchParams);
                    nextSearchParams.set(WORKFLOW_RUN_SEARCH_PARAM, instanceId);
                    return nextSearchParams;
                  },
                  { preventScrollReset: true, replace: true },
                );
              }}
            />
          ) : null}
          {showGraph ? (
            <WorkflowGraphDetailToggle
              detailMode={graphDetailMode}
              onDetailModeChange={(mode) => {
                setSearchParams(
                  (currentSearchParams) =>
                    searchParamsWithWorkflowGraphDetailMode(currentSearchParams, mode),
                  { preventScrollReset: true, replace: true },
                );
              }}
            />
          ) : null}
          <ScriptViewToggle
            viewMode={viewMode}
            onViewModeChange={(mode) => {
              setSearchParams(
                (currentSearchParams) => searchParamsWithScriptViewMode(currentSearchParams, mode),
                { preventScrollReset: true, replace: true },
              );
            }}
          />
        </div>
      </div>

      <div className={viewMode === "split" ? "grid min-h-0 lg:grid-cols-2" : "min-h-0"}>
        {showCode ? (
          <ScriptCodeView
            script={script}
            split={viewMode === "split"}
            selectedSource={currentSourceSelection}
            scrollViewport={codeViewport}
            onSourceReveal={suspendCodeScrollLink}
          />
        ) : null}
        {showGraph ? (
          <ScriptWorkflowGraph
            visualization={visualization}
            detailMode={graphDetailMode}
            runtimeToolCallsByStepId={runtimeToolCallsByStepId}
            selectedRun={workflowRuns.selectedRun}
            scrollViewport={graphViewport}
            onSourceSelect={(selectedRange) => {
              setSelectedSource(selectedRange);
              if (viewMode === "graph") {
                setSearchParams(
                  (currentSearchParams) =>
                    searchParamsWithScriptViewMode(currentSearchParams, "split"),
                  { preventScrollReset: true, replace: true },
                );
              }
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

function WorkflowRunSelector({
  runs,
  selectedRun,
  isLoading,
  error,
  onSelect,
}: {
  runs: readonly ScriptWorkflowRun[];
  selectedRun: ScriptWorkflowRun | null;
  isLoading: boolean;
  error: string | null;
  onSelect: (instanceId: string) => void;
}) {
  if (error) {
    return (
      <span
        title={error}
        className="border border-red-500/35 bg-red-500/8 px-2.5 py-2 text-[9px] font-semibold tracking-[0.16em] text-red-800 uppercase dark:text-red-200"
      >
        Run sync failed
      </span>
    );
  }

  if (isLoading && !selectedRun) {
    return (
      <span className="px-2 py-2 text-[9px] font-semibold tracking-[0.16em] text-[var(--bo-muted-2)] uppercase">
        Syncing runs…
      </span>
    );
  }

  if (!selectedRun) {
    return null;
  }

  return (
    <label className="flex min-h-10 items-center gap-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2.5">
      <span className="text-[9px] font-semibold tracking-[0.16em] text-[var(--bo-muted-2)] uppercase">
        Active run
      </span>
      <select
        aria-label="Active workflow run"
        value={selectedRun.instanceId}
        onChange={(event) => {
          onSelect(event.target.value);
        }}
        className="max-w-56 min-w-0 bg-transparent font-mono text-[10px] text-[var(--bo-fg)] outline-none"
      >
        {runs.map((run) => (
          <option key={run.id} value={run.instanceId}>
            {run.workflowName} · {run.instanceId} · {run.status}
          </option>
        ))}
      </select>
    </label>
  );
}

function ScriptViewToggle({
  viewMode,
  onViewModeChange,
}: {
  viewMode: ScriptViewMode;
  onViewModeChange: (mode: ScriptViewMode) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Script view"
      className="flex shrink-0 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-0.5"
    >
      {SCRIPT_VIEW_OPTIONS.map(({ mode, label, icon: Icon }) => (
        <button
          key={mode}
          type="button"
          aria-pressed={viewMode === mode}
          onClick={() => {
            onViewModeChange(mode);
          }}
          className={`${segmentedToggleButtonClass(viewMode === mode)} gap-1.5`}
        >
          <Icon className="h-3.5 w-3.5" />
          {label}
        </button>
      ))}
    </div>
  );
}

function WorkflowGraphDetailToggle({
  detailMode,
  onDetailModeChange,
}: {
  detailMode: WorkflowGraphDetailMode;
  onDetailModeChange: (mode: WorkflowGraphDetailMode) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Workflow graph detail"
      className="flex shrink-0 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-0.5"
    >
      {(["simple", "verbose"] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          aria-pressed={detailMode === mode}
          onClick={() => {
            onDetailModeChange(mode);
          }}
          className={segmentedToggleButtonClass(detailMode === mode)}
        >
          {mode}
        </button>
      ))}
    </div>
  );
}

function segmentedToggleButtonClass(isSelected: boolean): string {
  const interaction =
    "flex min-h-10 items-center px-2.5 text-[10px] font-semibold tracking-[0.12em] uppercase transition-[color,background-color,box-shadow,transform] active:scale-[0.96]";
  return isSelected
    ? `${interaction} bg-[var(--bo-panel)] text-[var(--bo-fg)] shadow-sm`
    : `${interaction} text-[var(--bo-muted-2)] hover:text-[var(--bo-fg)]`;
}

function ScriptCodeView({
  script,
  split,
  selectedSource,
  scrollViewport,
  onSourceReveal,
}: {
  script: string;
  split: boolean;
  selectedSource?: SourceRange;
  scrollViewport: LinkedScrollViewport;
  onSourceReveal: () => void;
}) {
  const selectionRef = useRef<HTMLElement>(null);
  const selectionStart = Math.max(0, Math.min(script.length, selectedSource?.start.offset ?? 0));
  const selectionEnd = Math.max(
    selectionStart,
    Math.min(script.length, selectedSource?.end.offset ?? selectionStart),
  );
  const hasSelection = selectionEnd > selectionStart;

  useEffect(() => {
    if (hasSelection) {
      onSourceReveal();
      selectionRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [hasSelection, onSourceReveal, selectionStart, selectionEnd]);

  return (
    <div
      {...scrollViewport}
      tabIndex={0}
      aria-label="Script source"
      className={`backoffice-scroll max-h-[calc(100vh-10rem)] min-h-[36rem] overflow-auto focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[color:var(--bo-accent)] ${split ? "border-b border-[color:var(--bo-border)] lg:border-r lg:border-b-0" : ""}`}
    >
      <pre className="min-h-full px-4 py-4 font-mono text-xs break-words whitespace-pre-wrap text-[var(--bo-fg)]">
        <code>
          {script ? (
            hasSelection ? (
              <>
                {script.slice(0, selectionStart)}
                <mark
                  ref={selectionRef}
                  className="bg-amber-300/35 text-inherit outline outline-1 outline-amber-500/50 dark:bg-amber-300/20"
                >
                  {script.slice(selectionStart, selectionEnd)}
                </mark>
                {script.slice(selectionEnd)}
              </>
            ) : (
              script
            )
          ) : (
            "# Empty script"
          )}
        </code>
      </pre>
    </div>
  );
}
