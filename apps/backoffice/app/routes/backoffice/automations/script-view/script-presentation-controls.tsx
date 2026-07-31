import { Code2, Columns2, Workflow as WorkflowIcon } from "lucide-react";
import type { ComponentType } from "react";

import type { ScriptViewMode, WorkflowGraphDetailMode } from "./script-view-mode";

export const SCRIPT_VIEW_OPTIONS: Array<{
  mode: ScriptViewMode;
  label: string;
  icon: ComponentType<{ className?: string }>;
}> = [
  { mode: "code", label: "Code", icon: Code2 },
  { mode: "graph", label: "Graph", icon: WorkflowIcon },
  { mode: "split", label: "Both", icon: Columns2 },
];

export const WORKFLOW_GRAPH_DETAIL_OPTIONS: Array<{
  mode: WorkflowGraphDetailMode;
  label: string;
}> = [
  { mode: "simple", label: "Simple" },
  { mode: "verbose", label: "Verbose" },
];

export function ScriptViewToggle({
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
          <Icon className="h-3.5 w-3.5" aria-hidden="true" />
          {label}
        </button>
      ))}
    </div>
  );
}

export function WorkflowGraphDetailToggle({
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
      {WORKFLOW_GRAPH_DETAIL_OPTIONS.map(({ mode, label }) => (
        <button
          key={mode}
          type="button"
          aria-pressed={detailMode === mode}
          onClick={() => {
            onDetailModeChange(mode);
          }}
          className={segmentedToggleButtonClass(detailMode === mode)}
        >
          {label}
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
