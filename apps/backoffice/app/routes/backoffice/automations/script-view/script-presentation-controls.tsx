import { Icon } from "@fragno-private/design-system/icon";
import { underlineTabClassName } from "@fragno-private/design-system/underline-tab-class-name";

import { SCRIPT_VIEW_OPTIONS, WORKFLOW_GRAPH_DETAIL_OPTIONS } from "./script-presentation-options";
import type { ScriptViewMode, WorkflowGraphDetailMode } from "./script-view-mode";

export type ScriptPresentationToggleVariant = "segmented" | "tabs";

export function ScriptViewToggle({
  viewMode,
  onViewModeChange,
  variant = "segmented",
}: {
  viewMode: ScriptViewMode;
  onViewModeChange: (mode: ScriptViewMode) => void;
  variant?: ScriptPresentationToggleVariant;
}) {
  return (
    <div role="group" aria-label="Script view" className={toggleGroupClass(variant)}>
      {SCRIPT_VIEW_OPTIONS.map(({ mode, label, icon }) => (
        <button
          key={mode}
          type="button"
          aria-pressed={viewMode === mode}
          onClick={() => {
            onViewModeChange(mode);
          }}
          className={toggleButtonClass(variant, viewMode === mode)}
        >
          <Icon name={icon} className="h-3.5 w-3.5" />
          {label}
        </button>
      ))}
    </div>
  );
}

export function WorkflowGraphDetailToggle({
  detailMode,
  onDetailModeChange,
  variant = "segmented",
}: {
  detailMode: WorkflowGraphDetailMode;
  onDetailModeChange: (mode: WorkflowGraphDetailMode) => void;
  variant?: ScriptPresentationToggleVariant;
}) {
  return (
    <div role="group" aria-label="Workflow graph detail" className={toggleGroupClass(variant)}>
      {WORKFLOW_GRAPH_DETAIL_OPTIONS.map(({ mode, label }) => (
        <button
          key={mode}
          type="button"
          aria-pressed={detailMode === mode}
          onClick={() => {
            onDetailModeChange(mode);
          }}
          className={toggleButtonClass(variant, detailMode === mode)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function toggleGroupClass(variant: ScriptPresentationToggleVariant): string {
  return variant === "tabs"
    ? "flex shrink-0 items-center gap-4"
    : "flex shrink-0 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-0.5";
}

function toggleButtonClass(variant: ScriptPresentationToggleVariant, isSelected: boolean): string {
  if (variant === "tabs") {
    return underlineTabClassName(isSelected ? "selected" : "idle");
  }

  const interaction =
    "flex min-h-10 items-center gap-1.5 px-2.5 text-[10px] font-semibold tracking-[0.12em] uppercase transition-[color,background-color,box-shadow,transform] active:scale-[0.96]";
  return isSelected
    ? `${interaction} bg-[var(--bo-selected-bg)] text-[var(--bo-fg)] shadow-[var(--bo-selected-shadow)]`
    : `${interaction} text-[var(--bo-muted-2)] hover:text-[var(--bo-fg)]`;
}
