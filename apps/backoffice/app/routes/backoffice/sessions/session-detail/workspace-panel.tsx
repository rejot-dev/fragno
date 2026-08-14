import { Menu } from "@base-ui/react/menu";
import { Check, Code2, Ellipsis, ListTree, PanelsTopLeft, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type { SourceRange } from "@fragno-dev/workflow-visualizer-tokens";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import { parseBackofficeUiResult } from "@/backoffice-ui/result";
import { sendBackofficeWorkflowEvent } from "@/backoffice-ui/workflow-events.client";
import {
  ProgressiveOverflowControls,
  type ProgressiveOverflowControlGroup,
} from "@/components/backoffice/progressive-overflow-controls";
import type { ResolvedWorkflowRuntimeToolCall } from "@/fragno/runtime-tools/workflow-catalog";
import { useLinkedScrollViewports } from "@/routes/backoffice/automations/script-view/linked-scroll";
import { ScriptCodeView } from "@/routes/backoffice/automations/script-view/script-code-view";
import type {
  ScriptViewMode,
  WorkflowGraphDetailMode,
} from "@/routes/backoffice/automations/script-view/script-view-mode";
import {
  useWorkflowRun,
  type WorkflowRunCollections,
} from "@/routes/backoffice/automations/script-view/use-workflow-run";
import { ScriptWorkflowGraph } from "@/routes/backoffice/automations/script-view/workflow-graph";
import type { WorkflowRunReference } from "@/routes/backoffice/automations/script-view/workflow-run-presentation";

import { ResultContent } from "./result-content";
import { tapScale } from "./ui";
import type { WorkflowGraphProjection } from "./workflow-graph-projection";
import type { SessionWorkspaceItem } from "./workspace-model";

const EMPTY_RUNTIME_TOOL_CALLS: ReadonlyMap<string, readonly ResolvedWorkflowRuntimeToolCall[]> =
  new Map();

type WorkflowDisplay = "ui" | "simple" | "code";

const WORKFLOW_DISPLAY_OPTIONS = [
  { mode: "ui" as const, label: "UI", icon: PanelsTopLeft },
  { mode: "simple" as const, label: "Flow", icon: ListTree },
  { mode: "code" as const, label: "Code", icon: Code2 },
];

export function SessionWorkspacePanel({
  item,
  workflowCollections,
  workflowCollectionsError,
  scope,
  onClose,
}: {
  item: SessionWorkspaceItem;
  workflowCollections?: WorkflowRunCollections;
  workflowCollectionsError?: string | null;
  scope: BackofficeContextScope;
  onClose: () => void;
}) {
  const [display, setDisplay] = useState<WorkflowDisplay>("simple");
  const [toolbarElement, setToolbarElement] = useState<HTMLElement | null>(null);
  const showGeneratedUi = useCallback(() => {
    setDisplay("ui");
  }, []);

  return (
    <aside
      aria-label="Session workspace"
      className="flex h-full min-h-0 min-w-0 flex-col border-l border-[color:var(--bo-border)] bg-[var(--bo-panel)]"
    >
      <header
        ref={setToolbarElement}
        data-session-workspace-toolbar
        className="flex h-16 items-stretch justify-between gap-3 border-b border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3"
      >
        <div
          data-session-workspace-actions
          className="ml-auto flex min-w-0 shrink-0 items-center gap-2"
        >
          {item.view.type === "workflow-graph" ? (
            <ProgressiveOverflowControls
              measurementBoundary={toolbarElement}
              reservedWidth={56}
              groups={
                [
                  {
                    id: "display" as const,
                    collapsePriority: 0,
                    content: (
                      <WorkflowDisplayButtons display={display} onDisplayChange={setDisplay} />
                    ),
                  },
                ] satisfies ProgressiveOverflowControlGroup<"display">[]
              }
              renderOverflow={(hiddenGroupIds) =>
                hiddenGroupIds.has("display") ? (
                  <WorkflowDisplayMenu display={display} onDisplayChange={setDisplay} />
                ) : null
              }
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
            viewMode={display === "code" ? "code" : "graph"}
            detailMode={display === "simple" ? "simple" : "ui"}
            runReference={item.view.run}
            workflowCollections={workflowCollections}
            workflowCollectionsError={workflowCollectionsError}
            scope={scope}
            onGeneratedUiAvailable={showGeneratedUi}
          />
        )}
      </section>
    </aside>
  );
}

function WorkflowDisplayButtons({
  display,
  onDisplayChange,
}: {
  display: WorkflowDisplay;
  onDisplayChange: (display: WorkflowDisplay) => void;
}) {
  return (
    <div role="group" aria-label="Workflow display" className="flex items-center gap-2">
      {WORKFLOW_DISPLAY_OPTIONS.map(({ mode, label, icon: Icon }) => (
        <button
          key={mode}
          type="button"
          aria-pressed={display === mode}
          onClick={() => {
            onDisplayChange(mode);
          }}
          className={`flex min-h-10 items-center gap-1.5 border-b-2 px-1 text-[10px] font-semibold tracking-[0.22em] uppercase transition-[scale,border-color,color] duration-150 ease-out outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 active:scale-[0.96] ${
            display === mode
              ? "border-[color:var(--bo-accent)] text-[var(--bo-accent-fg)]"
              : "border-transparent text-[var(--bo-muted)] hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
          }`}
        >
          <Icon className="size-3.5" aria-hidden="true" />
          {label}
        </button>
      ))}
    </div>
  );
}

function WorkflowDisplayMenu({
  display,
  onDisplayChange,
}: {
  display: WorkflowDisplay;
  onDisplayChange: (display: WorkflowDisplay) => void;
}) {
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger
        type="button"
        aria-label="Workflow display options"
        title="Workflow display options"
        className={`bo-control-surface inline-flex size-10 shrink-0 items-center justify-center bg-[var(--bo-panel)] text-[var(--bo-muted)] transition-[background-color,color,scale,box-shadow] duration-150 ease-out outline-none hover:bg-[var(--bo-panel-2)] hover:text-[var(--bo-fg)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 data-[popup-open]:bg-[var(--bo-accent-bg)] data-[popup-open]:text-[var(--bo-accent-fg)] ${tapScale}`}
      >
        <Ellipsis className="size-4" aria-hidden="true" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={8} className="z-50">
          <Menu.Popup
            data-backoffice-root
            className="bo-popover-surface w-44 origin-top-right bg-[var(--bo-panel)] p-2 text-[var(--bo-fg)] outline-none"
          >
            <Menu.RadioGroup
              value={display}
              onValueChange={(value) => {
                const option = WORKFLOW_DISPLAY_OPTIONS.find(({ mode }) => mode === value);
                if (option) {
                  onDisplayChange(option.mode);
                }
              }}
              className="space-y-1"
            >
              {WORKFLOW_DISPLAY_OPTIONS.map(({ mode, label, icon: Icon }) => (
                <Menu.RadioItem
                  key={mode}
                  value={mode}
                  className="flex min-h-10 items-center gap-2 px-2.5 text-xs text-[var(--bo-muted)] outline-none data-[highlighted]:bg-[var(--bo-panel-2)] data-[highlighted]:text-[var(--bo-fg)]"
                >
                  <Icon className="size-4" aria-hidden="true" />
                  <span className="flex-1">{label}</span>
                  <Menu.RadioItemIndicator className="text-[var(--bo-accent-fg)]">
                    <Check className="size-4" aria-hidden="true" />
                  </Menu.RadioItemIndicator>
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
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
  runReference,
  workflowCollections,
  workflowCollectionsError,
  scope,
  onGeneratedUiAvailable,
}: {
  projection: WorkflowGraphProjection;
  viewMode: ScriptViewMode;
  detailMode: WorkflowGraphDetailMode;
  runReference: WorkflowRunReference | null;
  workflowCollections?: WorkflowRunCollections;
  workflowCollectionsError?: string | null;
  scope: BackofficeContextScope;
  onGeneratedUiAvailable: () => void;
}) {
  const [selectedSource, setSelectedSource] = useState<SourceRange>();
  const showCode = viewMode === "code" || viewMode === "split";
  const showGraph = viewMode === "graph" || viewMode === "split";
  const { codeViewport, graphViewport, suspendCodeScrollLink } = useLinkedScrollViewports(
    viewMode === "split",
  );
  const workflowRun = useWorkflowRun({
    collections: workflowCollections,
    reference: runReference,
    visualization: projection.visualization,
  });
  const synchronizationError =
    workflowRun.error ?? (runReference && !workflowCollections ? workflowCollectionsError : null);
  const hasGeneratedUi = workflowRun.selectedRun
    ? [
        workflowRun.selectedRun.output,
        ...[...workflowRun.selectedRun.stepStatesByNodeId.values()].map((step) => step.result),
      ].some((result) => parseBackofficeUiResult(result).kind === "valid")
    : false;

  useEffect(() => {
    if (hasGeneratedUi) {
      onGeneratedUiAvailable();
    }
  }, [hasGeneratedUi, onGeneratedUiAvailable]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bo-panel)]">
      {synchronizationError ? (
        <div
          data-session-workflow-sync-state="error"
          role="alert"
          className="flex min-h-8 shrink-0 items-center gap-2 border-b border-[color:var(--bo-failed)] bg-[var(--bo-failed-bg)] px-3 text-xs text-[var(--bo-failed)]"
        >
          <span className="size-1.5 shrink-0 rounded-full bg-[var(--bo-failed)]" />
          <span className="truncate" title={synchronizationError}>
            Workflow synchronization failed: {synchronizationError}
          </span>
        </div>
      ) : workflowRun.isLoading ? (
        <div
          data-session-workflow-sync-state="loading"
          role="status"
          className="flex min-h-8 shrink-0 items-center gap-2 border-b border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 text-xs text-[var(--bo-muted)]"
        >
          <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-[var(--bo-accent)]" />
          Synchronizing workflow…
        </div>
      ) : null}
      <div
        className={
          viewMode === "split"
            ? "grid min-h-0 flex-1 grid-rows-2 lg:grid-cols-2 lg:grid-rows-1"
            : "min-h-0 flex-1"
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
            selectedRun={workflowRun.selectedRun}
            sourceCode={projection.source}
            scrollViewport={graphViewport}
            currentScope={scope.kind === "system" ? undefined : scope}
            workflowEventSender={async ({
              eventId,
              workflowName,
              instanceId,
              eventType,
              payload,
            }) => {
              await sendBackofficeWorkflowEvent({
                eventId,
                reference: {
                  scope,
                  workflowName,
                  instanceId,
                },
                eventType,
                payload,
              });
            }}
            fillHeight
            onSourceSelect={
              viewMode === "split"
                ? (source) => {
                    setSelectedSource(source);
                  }
                : undefined
            }
          />
        ) : null}
      </div>
    </div>
  );
}
