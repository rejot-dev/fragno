import { Menu } from "@base-ui/react/menu";
import { Check, Ellipsis, PanelsTopLeft, Workflow, X } from "lucide-react";
import { useState } from "react";

import type { SourceRange } from "@fragno-dev/workflow-visualizer-tokens";

import {
  ProgressiveOverflowControls,
  type ProgressiveOverflowControlGroup,
} from "@/components/backoffice/progressive-overflow-controls";
import type { ResolvedWorkflowRuntimeToolCall } from "@/fragno/runtime-tools/workflow-catalog";
import { useLinkedScrollViewports } from "@/routes/backoffice/automations/script-view/linked-scroll";
import { ScriptCodeView } from "@/routes/backoffice/automations/script-view/script-code-view";
import {
  SCRIPT_VIEW_OPTIONS,
  ScriptViewToggle,
  WORKFLOW_GRAPH_DETAIL_OPTIONS,
  WorkflowGraphDetailToggle,
} from "@/routes/backoffice/automations/script-view/script-presentation-controls";
import type {
  ScriptViewMode,
  WorkflowGraphDetailMode,
} from "@/routes/backoffice/automations/script-view/script-view-mode";
import { ScriptWorkflowGraph } from "@/routes/backoffice/automations/script-view/workflow-graph";

import { ResultContent } from "./result-content";
import { tapScale } from "./ui";
import type { WorkflowGraphProjection } from "./workflow-graph-projection";
import type { SessionWorkspaceItem } from "./workspace-model";

const EMPTY_RUNTIME_TOOL_CALLS: ReadonlyMap<string, readonly ResolvedWorkflowRuntimeToolCall[]> =
  new Map();

type WorkflowControlGroupId = "detail" | "view";

export function SessionWorkspacePanel({
  item,
  onClose,
}: {
  item: SessionWorkspaceItem;
  onClose: () => void;
}) {
  const isGeneratedUi = item.view.type === "generated-ui";
  const [viewMode, setViewMode] = useState<ScriptViewMode>("graph");
  const [detailMode, setDetailMode] = useState<WorkflowGraphDetailMode>("simple");
  const showGraph = viewMode === "graph" || viewMode === "split";
  const ItemIcon = isGeneratedUi ? PanelsTopLeft : Workflow;
  const itemTypeLabel =
    item.view.type === "generated-ui"
      ? "Generated interface"
      : item.view.projection.status === "constructing"
        ? "Building workflow"
        : "Workflow";

  return (
    <aside
      aria-label="Session workspace"
      className="flex h-full min-h-0 min-w-0 flex-col border-l border-[color:var(--bo-border)] bg-[var(--bo-panel)]"
    >
      <header
        data-session-workspace-toolbar
        className="flex min-h-14 items-center justify-between gap-3 border-b border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-1.5"
      >
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center bg-[var(--bo-panel-2)] text-[var(--bo-accent-fg)] shadow-[inset_0_0_0_1px_var(--bo-border)]">
            <ItemIcon className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0 leading-tight">
            <p className="text-[9px] font-semibold tracking-[0.14em] text-[var(--bo-muted-2)] uppercase">
              {itemTypeLabel}
            </p>
            <h2 className="truncate text-xs font-semibold text-[var(--bo-fg)]">{item.label}</h2>
          </div>
        </div>

        <div className="flex min-w-0 items-center gap-2">
          {item.view.type === "workflow-graph" ? (
            <ProgressiveOverflowControls
              groups={
                [
                  ...(showGraph
                    ? [
                        {
                          id: "detail" as const,
                          collapsePriority: 0,
                          content: (
                            <WorkflowGraphDetailToggle
                              detailMode={detailMode}
                              onDetailModeChange={setDetailMode}
                            />
                          ),
                        },
                      ]
                    : []),
                  {
                    id: "view" as const,
                    collapsePriority: 1,
                    content: (
                      <ScriptViewToggle viewMode={viewMode} onViewModeChange={setViewMode} />
                    ),
                  },
                ] satisfies ProgressiveOverflowControlGroup<WorkflowControlGroupId>[]
              }
              renderOverflow={(hiddenGroupIds) => (
                <WorkflowPresentationOverflow
                  detailMode={detailMode}
                  hiddenGroupIds={hiddenGroupIds}
                  viewMode={viewMode}
                  onDetailModeChange={setDetailMode}
                  onViewModeChange={setViewMode}
                />
              )}
            />
          ) : null}

          <button
            type="button"
            aria-label="Close session workspace"
            title="Close workspace"
            onClick={onClose}
            className={`inline-flex size-10 shrink-0 items-center justify-center text-[var(--bo-muted)] transition-[background-color,color,scale] duration-150 ease-out outline-none hover:bg-[var(--bo-panel-2)] hover:text-[var(--bo-fg)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 ${tapScale}`}
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
      </header>

      <section
        key={item.id}
        aria-label={`${item.label} workspace`}
        className="min-h-0 min-w-0 flex-1 overflow-hidden"
      >
        {item.view.type === "generated-ui" ? (
          <div className="backoffice-scroll h-full overflow-auto overscroll-contain p-4 sm:p-5">
            <ResultContent
              parsedValue={{ kind: "valid", value: item.view.result }}
              showRawValue={false}
              value={item.view.rawValue}
            >
              {null}
            </ResultContent>
          </div>
        ) : (
          <SessionWorkflowWorkspace
            projection={item.view.projection}
            viewMode={viewMode}
            detailMode={detailMode}
            onViewModeChange={setViewMode}
          />
        )}
      </section>
    </aside>
  );
}

function WorkflowPresentationOverflow({
  detailMode,
  hiddenGroupIds,
  viewMode,
  onDetailModeChange,
  onViewModeChange,
}: {
  detailMode: WorkflowGraphDetailMode;
  hiddenGroupIds: ReadonlySet<WorkflowControlGroupId>;
  viewMode: ScriptViewMode;
  onDetailModeChange: (mode: WorkflowGraphDetailMode) => void;
  onViewModeChange: (mode: ScriptViewMode) => void;
}) {
  const showGraphDetail = hiddenGroupIds.has("detail");
  const showView = hiddenGroupIds.has("view");
  const itemClassName =
    "flex min-h-10 cursor-default items-center gap-3 px-2.5 text-xs text-[var(--bo-muted)] transition-[background-color,color,scale] duration-150 ease-out outline-none active:scale-[0.96] data-[highlighted]:bg-[var(--bo-panel-2)] data-[highlighted]:text-[var(--bo-fg)]";

  return (
    <Menu.Root modal={false}>
      <Menu.Trigger
        data-session-workspace-overflow
        type="button"
        aria-label="Workflow display options"
        title="Workflow display options"
        className={`bo-control-surface size-10 shrink-0 items-center justify-center bg-[var(--bo-panel)] text-[var(--bo-muted)] transition-[background-color,color,scale,box-shadow] duration-150 ease-out outline-none hover:bg-[var(--bo-panel-2)] hover:text-[var(--bo-fg)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 data-[popup-open]:bg-[var(--bo-accent-bg)] data-[popup-open]:text-[var(--bo-accent-fg)] ${tapScale}`}
      >
        <Ellipsis className="size-4" aria-hidden="true" />
      </Menu.Trigger>

      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={8} className="z-50">
          <Menu.Popup
            data-backoffice-root
            className="bo-popover-surface w-60 origin-top-right bg-[var(--bo-panel)] p-2 text-[var(--bo-fg)] transition-[opacity,transform] duration-150 ease-out outline-none data-[ending-style]:-translate-y-1 data-[ending-style]:opacity-0 data-[starting-style]:-translate-y-1 data-[starting-style]:opacity-0"
          >
            {showGraphDetail ? (
              <>
                <p className="px-2.5 py-1 text-[9px] font-semibold tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
                  Graph detail
                </p>
                <Menu.RadioGroup
                  value={detailMode}
                  onValueChange={(value) => {
                    const option = WORKFLOW_GRAPH_DETAIL_OPTIONS.find(({ mode }) => mode === value);
                    if (option) {
                      onDetailModeChange(option.mode);
                    }
                  }}
                  className="space-y-1"
                >
                  {WORKFLOW_GRAPH_DETAIL_OPTIONS.map(({ mode, label }) => (
                    <Menu.RadioItem key={mode} value={mode} className={itemClassName}>
                      <span className="flex-1">{label}</span>
                      <Menu.RadioItemIndicator className="text-[var(--bo-accent-fg)]">
                        <Check className="size-4" aria-hidden="true" />
                      </Menu.RadioItemIndicator>
                    </Menu.RadioItem>
                  ))}
                </Menu.RadioGroup>
                {showView ? <Menu.Separator className="my-2 h-px bg-[var(--bo-border)]" /> : null}
              </>
            ) : null}

            {showView ? (
              <>
                <p className="px-2.5 py-1 text-[9px] font-semibold tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
                  View
                </p>
                <Menu.RadioGroup
                  value={viewMode}
                  onValueChange={(value) => {
                    const option = SCRIPT_VIEW_OPTIONS.find(({ mode }) => mode === value);
                    if (option) {
                      onViewModeChange(option.mode);
                    }
                  }}
                  className="space-y-1"
                >
                  {SCRIPT_VIEW_OPTIONS.map(({ mode, label, icon: Icon }) => (
                    <Menu.RadioItem key={mode} value={mode} className={itemClassName}>
                      <Icon className="size-4 shrink-0" aria-hidden="true" />
                      <span className="flex-1">{label}</span>
                      <Menu.RadioItemIndicator className="text-[var(--bo-accent-fg)]">
                        <Check className="size-4" aria-hidden="true" />
                      </Menu.RadioItemIndicator>
                    </Menu.RadioItem>
                  ))}
                </Menu.RadioGroup>
              </>
            ) : null}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function SessionWorkflowWorkspace({
  projection,
  viewMode,
  detailMode,
  onViewModeChange,
}: {
  projection: WorkflowGraphProjection;
  viewMode: ScriptViewMode;
  detailMode: WorkflowGraphDetailMode;
  onViewModeChange: (viewMode: ScriptViewMode) => void;
}) {
  const [selectedSource, setSelectedSource] = useState<SourceRange>();
  const showCode = viewMode === "code" || viewMode === "split";
  const showGraph = viewMode === "graph" || viewMode === "split";
  const { codeViewport, graphViewport, suspendCodeScrollLink } = useLinkedScrollViewports(
    viewMode === "split",
  );

  return (
    <div className="h-full min-h-0 bg-[var(--bo-panel)]">
      <div
        className={
          viewMode === "split"
            ? "grid h-full min-h-0 grid-rows-2 lg:grid-cols-2 lg:grid-rows-1"
            : "h-full min-h-0"
        }
      >
        {showCode ? (
          <ScriptCodeView
            script={projection.source}
            split={viewMode === "split"}
            selectedSource={selectedSource}
            scrollViewport={codeViewport}
            fillHeight
            onSourceReveal={suspendCodeScrollLink}
          />
        ) : null}
        {showGraph ? (
          <ScriptWorkflowGraph
            visualization={projection.visualization}
            detailMode={detailMode}
            runtimeToolCallsByStepId={EMPTY_RUNTIME_TOOL_CALLS}
            selectedRun={null}
            scrollViewport={graphViewport}
            fillHeight
            onSourceSelect={(source) => {
              setSelectedSource(source);
              if (viewMode === "graph") {
                onViewModeChange("split");
              }
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
