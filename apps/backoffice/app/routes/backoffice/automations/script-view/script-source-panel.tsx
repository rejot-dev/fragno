import type { LofiSqliteClient } from "@fragno-dev/lofi/sqlite";
import { ButtonLink } from "@fragno-private/design-system/button";
import { Icon } from "@fragno-private/design-system/icon";
import { Select } from "@fragno-private/design-system/select";
import { WorkflowRunTimeline } from "@fragno-private/design-system/workflow-run-timeline";
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";

import { visualizeWorkflowSource, type SourceRange } from "@fragno-dev/workflow-visualizer-tokens";

import {
  backofficeRuntimeScopeFromResolvedScope,
  type BackofficeResolvedScope,
} from "@/backoffice-runtime/resolved-scope";
import { sendBackofficeWorkflowEvent } from "@/backoffice-ui/workflow-events.client";
import {
  resolveWorkflowRuntimeToolCalls,
  type RuntimeToolWorkflowDescriptor,
} from "@/fragno/runtime-tools/workflow-catalog";
import { dashboardRunPath } from "@/routes/backoffice/dashboard/path";

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
import { useWorkflowRunTimeline } from "./workflow-run-timeline-presentation";

export function ScriptSourcePanel({
  absolutePath,
  source,
  runtimeToolCatalog,
  replica,
  resolvedScope,
}: {
  absolutePath: string;
  source: { script: string | null; scriptError: string | null };
  runtimeToolCatalog: readonly RuntimeToolWorkflowDescriptor[];
  replica: LofiSqliteClient;
  resolvedScope: BackofficeResolvedScope;
}) {
  const runtimeScope = backofficeRuntimeScopeFromResolvedScope(resolvedScope);
  const currentScope = resolvedScope.kind === "system" ? undefined : resolvedScope;
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
    replica,
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

      {showGraph && workflowRuns.selectedRun ? (
        <ScriptRunTimeline
          key={workflowRuns.selectedRun.id}
          replica={replica}
          run={workflowRuns.selectedRun}
          runPath={dashboardRunPath(resolvedScope, {
            workflowName: workflowRuns.selectedRun.instanceWorkflowName,
            instanceId: workflowRuns.selectedRun.instanceId,
          })}
          onSelectStep={(stepId) => {
            graphViewport.ref.current
              ?.querySelector(`[data-workflow-step-card="${CSS.escape(stepId)}"]`)
              ?.scrollIntoView({ block: "center", behavior: "smooth" });
          }}
        />
      ) : null}

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
            currentScope={currentScope}
            workflowEventSender={async ({
              eventId,
              workflowName,
              instanceId,
              eventType,
              payload,
            }) => {
              await sendBackofficeWorkflowEvent({
                eventId,
                reference: { scope: runtimeScope, workflowName, instanceId },
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

/**
 * The selected run, drawn from the program it executed. Timeline steps share node ids with the
 * graph while the file still holds that program, so selecting one reveals its card.
 */
function ScriptRunTimeline({
  replica,
  run,
  runPath,
  onSelectStep,
}: {
  replica: LofiSqliteClient;
  run: ScriptWorkflowRun;
  runPath: string;
  onSelectStep: (stepId: string) => void;
}) {
  const { timeline } = useWorkflowRunTimeline({
    replica,
    reference: { workflowName: run.instanceWorkflowName, instanceId: run.instanceId },
  });
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  if (!timeline) {
    return null;
  }

  return (
    <div className="border-b border-[color:var(--bo-border)] p-3">
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
          setSelectedStepId(stepId);
          onSelectStep(stepId);
        }}
        presentation={{
          kind: "standalone",
          meta: <span className="font-mono">{run.instanceId}</span>,
          actions: (
            <ButtonLink variant="secondary" to={runPath}>
              <Icon name="external-link" className="size-3.5" />
              Open run
            </ButtonLink>
          ),
          surface: "card",
        }}
      />
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
    <div className="flex items-center gap-2">
      <span
        aria-hidden
        className="text-[9px] font-semibold tracking-[0.16em] text-[var(--bo-muted-2)] uppercase"
      >
        Active run
      </span>
      <Select
        aria-label="Active workflow run"
        density="compact"
        value={selectedRun.instanceId}
        options={runs.map((run) => ({
          label: `${run.workflowName} · ${run.instanceId} · ${run.status}`,
          value: run.instanceId,
        }))}
        onValueChange={(instanceId) => {
          if (instanceId !== null) {
            onSelect(instanceId);
          }
        }}
        className="max-w-56 min-w-0 font-mono text-[10px]"
      />
    </div>
  );
}
