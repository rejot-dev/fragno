import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";

import { visualizeWorkflowSource, type SourceRange } from "@fragno-dev/workflow-visualizer-tokens";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import { isBackofficeRoutableScope } from "@/backoffice-runtime/scope-codec";
import { sendBackofficeWorkflowEvent } from "@/backoffice-ui/workflow-events.client";
import type { AutomationBrowserCollections as AutomationCollections } from "@/fragno/automation/tanstack/browser-database";
import {
  resolveWorkflowRuntimeToolCalls,
  type RuntimeToolWorkflowDescriptor,
} from "@/fragno/runtime-tools/workflow-catalog";

import { useLinkedScrollViewports } from "./linked-scroll";
import { ScriptCodeView } from "./script-code-view";
import { ScriptViewToggle, WorkflowGraphDetailToggle } from "./script-presentation-controls";
import {
  SCRIPT_VIEW_MODE_SEARCH_PARAM,
  WORKFLOW_GRAPH_DETAIL_MODE_SEARCH_PARAM,
  WORKFLOW_RUN_SEARCH_PARAM,
  scriptViewModeFromSearchParam,
  searchParamsWithScriptViewMode,
  searchParamsWithWorkflowGraphDetailMode,
  workflowGraphDetailModeFromSearchParam,
} from "./script-view-mode";
import { useScriptWorkflowRuns } from "./use-script-workflow-runs";
import { ScriptWorkflowGraph } from "./workflow-graph";
import type { ScriptWorkflowRun } from "./workflow-run-presentation";

export function ScriptSourcePanel({
  absolutePath,
  source,
  runtimeToolCatalog,
  collections,
  scope,
}: {
  absolutePath: string;
  source: { script: string | null; scriptError: string | null };
  runtimeToolCatalog: readonly RuntimeToolWorkflowDescriptor[];
  collections: Pick<
    AutomationCollections,
    "workflowInstances" | "workflowSteps" | "workflowEvents" | "workflowStepEmissions"
  >;
  scope: BackofficeContextScope;
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
            currentScope={isBackofficeRoutableScope(scope) ? scope : undefined}
            workflowEventSender={async ({
              eventId,
              workflowName,
              instanceId,
              eventType,
              payload,
            }) => {
              await sendBackofficeWorkflowEvent({
                eventId,
                reference: { scope, workflowName, instanceId },
                eventType,
                payload,
              });
            }}
            onSourceSelect={
              viewMode === "split"
                ? (selectedRange) => {
                    setSelectedSource(selectedRange);
                  }
                : undefined
            }
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
