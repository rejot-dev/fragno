import { X } from "lucide-react";
import { useRef, useState, type KeyboardEvent } from "react";

import type { SourceRange } from "@fragno-dev/workflow-visualizer-tokens";

import type { ResolvedWorkflowRuntimeToolCall } from "@/fragno/runtime-tools/workflow-catalog";
import { useLinkedScrollViewports } from "@/routes/backoffice/automations/script-view/linked-scroll";
import { ScriptCodeView } from "@/routes/backoffice/automations/script-view/script-code-view";
import {
  ScriptViewToggle,
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
import type { SessionWorkspaceTab } from "./workspace-model";

const CHAT_TAB_ID = "session-workspace-chat";
const EMPTY_RUNTIME_TOOL_CALLS: ReadonlyMap<string, readonly ResolvedWorkflowRuntimeToolCall[]> =
  new Map();

export function SessionMobileWorkspaceTabs({
  selectedTabId,
  tabs,
  onSelectChat,
  onSelectTab,
}: {
  selectedTabId: string | null;
  tabs: readonly SessionWorkspaceTab[];
  onSelectChat: () => void;
  onSelectTab: (tabId: string) => void;
}) {
  return (
    <div className="border-b border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 md:hidden">
      <WorkspaceTabList
        idSuffix="mobile"
        selectedTabId={selectedTabId}
        tabs={tabs}
        onSelectChat={onSelectChat}
        onSelectTab={onSelectTab}
      />
    </div>
  );
}

export function SessionWorkspacePanel({
  selectedTabId,
  tabs,
  onClose,
  onSelectTab,
}: {
  selectedTabId: string;
  tabs: readonly SessionWorkspaceTab[];
  onClose: () => void;
  onSelectTab: (tabId: string) => void;
}) {
  const selectedTab = tabs.find((tab) => tab.id === selectedTabId) ?? tabs.at(-1);
  if (!selectedTab) {
    return null;
  }

  return (
    <aside
      aria-label="Session workspace"
      className="flex h-full min-h-0 min-w-0 flex-col border-l border-[color:var(--bo-border)] bg-[var(--bo-panel)]"
    >
      <div className="hidden min-h-12 items-center gap-2 border-b border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 md:flex">
        <WorkspaceTabList
          idSuffix="desktop"
          selectedTabId={selectedTab.id}
          tabs={tabs}
          onSelectTab={onSelectTab}
        />

        <span className="h-6 w-px shrink-0 bg-[var(--bo-border)]" aria-hidden="true" />
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

      <section
        key={selectedTab.id}
        role="tabpanel"
        id={`${selectedTab.id}-panel`}
        aria-label={`${selectedTab.label} workspace`}
        className="min-h-0 min-w-0 flex-1 overflow-hidden"
      >
        {selectedTab.view.type === "generated-ui" ? (
          <div className="backoffice-scroll h-full overflow-auto overscroll-contain p-4 sm:p-5">
            <ResultContent
              parsedValue={{ kind: "valid", value: selectedTab.view.result }}
              showRawValue={false}
              value={selectedTab.view.rawValue}
            >
              {null}
            </ResultContent>
          </div>
        ) : (
          <SessionWorkflowWorkspace projection={selectedTab.view.projection} />
        )}
      </section>
    </aside>
  );
}

function SessionWorkflowWorkspace({ projection }: { projection: WorkflowGraphProjection }) {
  const [viewMode, setViewMode] = useState<ScriptViewMode>("graph");
  const [detailMode, setDetailMode] = useState<WorkflowGraphDetailMode>("simple");
  const [selectedSource, setSelectedSource] = useState<SourceRange>();
  const showCode = viewMode === "code" || viewMode === "split";
  const showGraph = viewMode === "graph" || viewMode === "split";
  const { codeViewport, graphViewport, suspendCodeScrollLink } = useLinkedScrollViewports(
    viewMode === "split",
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bo-panel)]">
      <div className="flex min-h-12 flex-wrap items-center justify-end gap-2 border-b border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-1.5">
        {showGraph ? (
          <WorkflowGraphDetailToggle detailMode={detailMode} onDetailModeChange={setDetailMode} />
        ) : null}
        <ScriptViewToggle viewMode={viewMode} onViewModeChange={setViewMode} />
      </div>

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
            selectedRun={null}
            scrollViewport={graphViewport}
            fillHeight
            onSourceSelect={(source) => {
              setSelectedSource(source);
              if (viewMode === "graph") {
                setViewMode("split");
              }
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

function WorkspaceTabList({
  idSuffix,
  selectedTabId,
  tabs,
  onSelectChat,
  onSelectTab,
}: {
  idSuffix: "desktop" | "mobile";
  selectedTabId: string | null;
  tabs: readonly SessionWorkspaceTab[];
  onSelectChat?: () => void;
  onSelectTab: (tabId: string) => void;
}) {
  const tabButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const items = onSelectChat
    ? [
        { id: CHAT_TAB_ID, label: "Chat", tab: null },
        ...tabs.map((tab) => ({ id: tab.id, label: tab.label, tab })),
      ]
    : tabs.map((tab) => ({ id: tab.id, label: tab.label, tab }));
  const activeId = selectedTabId ?? (onSelectChat ? CHAT_TAB_ID : (tabs.at(-1)?.id ?? null));

  const selectAndFocus = (itemId: string) => {
    if (itemId === CHAT_TAB_ID) {
      onSelectChat?.();
    } else {
      onSelectTab(itemId);
    }
    tabButtonRefs.current.get(itemId)?.focus();
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, itemId: string) => {
    const currentIndex = items.findIndex((item) => item.id === itemId);
    if (currentIndex === -1) {
      return;
    }

    const nextIndex =
      event.key === "ArrowRight"
        ? (currentIndex + 1) % items.length
        : event.key === "ArrowLeft"
          ? (currentIndex - 1 + items.length) % items.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : null;
    if (nextIndex === null) {
      return;
    }
    event.preventDefault();
    const nextItem = items[nextIndex];
    if (nextItem) {
      selectAndFocus(nextItem.id);
    }
  };

  return (
    <div
      role="tablist"
      aria-label="Session workspace tabs"
      className="backoffice-scroll flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
    >
      {items.map((item) => {
        const selected = item.id === activeId;
        const constructing =
          item.tab?.view.type === "workflow-graph" &&
          item.tab.view.projection.status === "constructing";
        const indicatorClass =
          item.id === CHAT_TAB_ID
            ? selected
              ? "bg-[var(--bo-accent)]"
              : "bg-[var(--bo-muted-2)]"
            : constructing
              ? "animate-pulse bg-[var(--bo-accent)]"
              : item.tab?.view.type === "workflow-graph"
                ? "bg-[var(--bo-live)]"
                : "bg-[var(--bo-blue-2)]";

        return (
          <button
            key={item.id}
            ref={(element) => {
              if (element) {
                tabButtonRefs.current.set(item.id, element);
              } else {
                tabButtonRefs.current.delete(item.id);
              }
            }}
            type="button"
            role="tab"
            id={`${item.id}-${idSuffix}-tab`}
            aria-controls={item.id === CHAT_TAB_ID ? "session-chat-panel" : `${item.id}-panel`}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => {
              if (item.id === CHAT_TAB_ID) {
                onSelectChat?.();
              } else {
                onSelectTab(item.id);
              }
            }}
            onKeyDown={(event) => {
              handleTabKeyDown(event, item.id);
            }}
            className={`group/tab inline-flex min-h-10 max-w-48 shrink-0 items-center gap-2 border-b-2 px-2 text-[10px] font-semibold tracking-[0.16em] uppercase transition-[border-color,color,scale] duration-150 ease-out outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 active:scale-[0.96] ${selected ? "border-[color:var(--bo-accent)] text-[var(--bo-accent-fg)]" : "border-transparent text-[var(--bo-muted)] hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"}`}
          >
            <span className={`size-1.5 shrink-0 rounded-full ${indicatorClass}`} />
            <span className="truncate">{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}
