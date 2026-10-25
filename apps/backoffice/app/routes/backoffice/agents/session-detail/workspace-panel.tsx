import type { LofiSqliteClient } from "@fragno-dev/lofi/sqlite";
import { parseBackofficeUiResult } from "@fragno-private/backoffice-ui/result";
import {
  ChatWorkspacePanel,
  ChatWorkspaceScroll,
  ChatWorkspaceStatus,
} from "@fragno-private/design-system/chat-workspace-panel";
import { Icon } from "@fragno-private/design-system/icon";
import {
  ProgressiveOverflowControls,
  type ProgressiveOverflowControlGroup,
} from "@fragno-private/design-system/progressive-overflow-controls";
import { RadioMenu } from "@fragno-private/design-system/radio-menu";
import { UnderlineToggleButton } from "@fragno-private/design-system/underline-tabs";
import { useCallback, useEffect, useState } from "react";

import type { SourceRange } from "@fragno-dev/workflow-visualizer-tokens";

import {
  backofficeRuntimeScopeFromResolvedScope,
  type BackofficeResolvedScope,
} from "@/backoffice-runtime/resolved-scope";
import { sendBackofficeWorkflowEvent } from "@/backoffice-ui/workflow-events.client";
import type { ResolvedWorkflowRuntimeToolCall } from "@/fragno/runtime-tools/workflow-catalog";
import { useLinkedScrollViewports } from "@/routes/backoffice/automations/script-view/linked-scroll";
import { ScriptCodeView } from "@/routes/backoffice/automations/script-view/script-code-view";
import type {
  ScriptViewMode,
  WorkflowGraphDetailMode,
} from "@/routes/backoffice/automations/script-view/script-view-mode";
import { useWorkflowRun } from "@/routes/backoffice/automations/script-view/use-workflow-run";
import { ScriptWorkflowGraph } from "@/routes/backoffice/automations/script-view/workflow-graph";
import type { WorkflowRunReference } from "@/routes/backoffice/automations/script-view/workflow-run-presentation";

import { ResultContent } from "./result-content";
import type { WorkflowGraphProjection } from "./workflow-graph-projection";
import type { SessionWorkspaceItem } from "./workspace-model";

const EMPTY_RUNTIME_TOOL_CALLS: ReadonlyMap<string, readonly ResolvedWorkflowRuntimeToolCall[]> =
  new Map();

type WorkflowDisplay = "ui" | "simple" | "code";

const WORKFLOW_DISPLAY_OPTIONS = [
  { mode: "ui" as const, label: "UI", icon: "layout" as const },
  { mode: "simple" as const, label: "Flow", icon: "list" as const },
  { mode: "code" as const, label: "Code", icon: "code" as const },
];

export function SessionWorkspacePanel({
  item,
  runReplica,
  runReplicaError,
  resolvedScope,
  onClose,
}: {
  item: SessionWorkspaceItem;
  /** The scope's Automations replica, which the workspace reads a workflow's run from. */
  runReplica?: LofiSqliteClient;
  runReplicaError?: string | null;
  resolvedScope: BackofficeResolvedScope;
  onClose: () => void;
}) {
  const [display, setDisplay] = useState<WorkflowDisplay>("simple");
  const [toolbarElement, setToolbarElement] = useState<HTMLElement | null>(null);
  const showGeneratedUi = useCallback(() => {
    setDisplay("ui");
  }, []);

  return (
    <ChatWorkspacePanel
      label={item.label}
      toolbarRef={setToolbarElement}
      onClose={onClose}
      actions={
        item.view.type === "workflow-graph" ? (
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
                <RadioMenu
                  label="Workflow display options"
                  heading={null}
                  trigger={{ kind: "control", icon: "more-horizontal" }}
                  side="bottom"
                  value={display}
                  options={WORKFLOW_DISPLAY_OPTIONS.map(({ mode, label, icon }) => ({
                    value: mode,
                    label,
                    description: null,
                    icon,
                    disabled: false,
                  }))}
                  onValueChange={setDisplay}
                />
              ) : null
            }
          />
        ) : null
      }
    >
      {item.view.type === "generated-ui" ? (
        <ChatWorkspaceScroll>
          <ResultContent
            parsedValue={{ kind: "valid", value: item.view.result }}
            showRawValue={false}
            value={item.view.rawValue}
          >
            {null}
          </ResultContent>
        </ChatWorkspaceScroll>
      ) : (
        <SessionWorkflowWorkspace
          projection={item.view.projection}
          viewMode={display === "code" ? "code" : "graph"}
          detailMode={display === "simple" ? "simple" : "ui"}
          runReference={item.view.run}
          runReplica={runReplica}
          runReplicaError={runReplicaError}
          resolvedScope={resolvedScope}
          onGeneratedUiAvailable={showGeneratedUi}
        />
      )}
    </ChatWorkspacePanel>
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
    <div role="group" aria-label="Workflow display" className="flex items-center gap-1">
      {WORKFLOW_DISPLAY_OPTIONS.map(({ mode, label, icon }) => (
        <UnderlineToggleButton
          key={mode}
          pressed={display === mode}
          onClick={() => {
            onDisplayChange(mode);
          }}
        >
          <Icon name={icon} />
          {label}
        </UnderlineToggleButton>
      ))}
    </div>
  );
}

function SessionWorkflowWorkspace({
  projection,
  viewMode,
  detailMode,
  runReference,
  runReplica,
  runReplicaError,
  resolvedScope,
  onGeneratedUiAvailable,
}: {
  projection: WorkflowGraphProjection;
  viewMode: ScriptViewMode;
  detailMode: WorkflowGraphDetailMode;
  runReference: WorkflowRunReference | null;
  runReplica?: LofiSqliteClient;
  runReplicaError?: string | null;
  resolvedScope: BackofficeResolvedScope;
  onGeneratedUiAvailable: () => void;
}) {
  const scope = backofficeRuntimeScopeFromResolvedScope(resolvedScope);
  const [selectedSource, setSelectedSource] = useState<SourceRange>();
  const showCode = viewMode === "code" || viewMode === "split";
  const showGraph = viewMode === "graph" || viewMode === "split";
  const { codeViewport, graphViewport, suspendCodeScrollLink } = useLinkedScrollViewports(
    viewMode === "split",
  );
  const workflowRun = useWorkflowRun({
    replica: runReplica ?? null,
    reference: runReference,
    visualization: projection.visualization,
  });
  const synchronizationError =
    workflowRun.error ?? (runReference && !runReplica ? runReplicaError : null);
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
        <ChatWorkspaceStatus tone="failed">
          {`Workflow synchronization failed: ${synchronizationError}`}
        </ChatWorkspaceStatus>
      ) : workflowRun.isLoading ? (
        <ChatWorkspaceStatus tone="loading">Synchronizing workflow…</ChatWorkspaceStatus>
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
            currentScope={resolvedScope.kind === "system" ? undefined : resolvedScope}
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
