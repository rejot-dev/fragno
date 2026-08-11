import {
  SCRIPT_VIEW_OPTIONS,
  WORKFLOW_GRAPH_DETAIL_OPTIONS,
} from "./script-presentation-options";
import type {
  ScriptViewMode,
  WorkflowGraphDetailMode,
} from "./script-view-mode";

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
    <div
      role="group"
      aria-label="Script view"
      className={toggleGroupClass(variant)}
    >
      {SCRIPT_VIEW_OPTIONS.map(({ mode, label, icon: Icon }) => (
        <button
          key={mode}
          type="button"
          aria-pressed={viewMode === mode}
          onClick={() => {
            onViewModeChange(mode);
          }}
          className={`${toggleButtonClass(variant, viewMode === mode)} gap-1.5`}
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
  variant = "segmented",
}: {
  detailMode: WorkflowGraphDetailMode;
  onDetailModeChange: (mode: WorkflowGraphDetailMode) => void;
  variant?: ScriptPresentationToggleVariant;
}) {
  return (
    <div
      role="group"
      aria-label="Workflow graph detail"
      className={toggleGroupClass(variant)}
    >
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
    ? "flex shrink-0 items-center gap-2"
    : "flex shrink-0 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-0.5";
}

function toggleButtonClass(
  variant: ScriptPresentationToggleVariant,
  isSelected: boolean,
): string {
  if (variant === "tabs") {
    const interaction =
      "flex min-h-10 items-center border-b-2 px-1 text-[10px] font-semibold tracking-[0.22em] uppercase outline-none transition-[scale,border-color,color] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 active:scale-[0.96]";
    return isSelected
      ? `${interaction} border-[color:var(--bo-accent)] text-[var(--bo-accent-fg)]`
      : `${interaction} border-transparent text-[var(--bo-muted)] hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]`;
  }

  const interaction =
    "flex min-h-10 items-center px-2.5 text-[10px] font-semibold tracking-[0.12em] uppercase transition-[color,background-color,box-shadow,transform] active:scale-[0.96]";
  return isSelected
    ? `${interaction} bg-[var(--bo-panel)] text-[var(--bo-fg)] shadow-sm`
    : `${interaction} text-[var(--bo-muted-2)] hover:text-[var(--bo-fg)]`;
}
