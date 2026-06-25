/*
 * The autocomplete popup for the dev terminal — command/argument/path
 * completions or history, floated above the input. Keyboard selection is driven
 * by `useDashboardTerminal`; this component renders and reports mouse-down
 * (which must fire before the input blurs, hence `onMouseDown` + `preventDefault`).
 */

import { useEffect, useRef } from "react";

import { cn } from "@/lib/utils";
import type {
  DashboardAutocompleteMode,
  DashboardAutocompleteSuggestion,
} from "@/routes/backoffice/dashboard-terminal";

const kindLabel = (suggestion: DashboardAutocompleteSuggestion) =>
  suggestion.kind === "argument" ? "arg" : suggestion.kind;

export function DevAutocompletePopup({
  suggestions,
  activeIndex,
  mode,
  onSelect,
}: {
  suggestions: readonly DashboardAutocompleteSuggestion[];
  activeIndex: number;
  mode: DashboardAutocompleteMode;
  onSelect: (suggestion: DashboardAutocompleteSuggestion) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Keep the active item scrolled into view as the selection moves.
  useEffect(() => {
    const list = listRef.current;
    const item = itemRefs.current[activeIndex];
    if (!list || !item) {
      return;
    }
    const top = item.offsetTop;
    const bottom = top + item.offsetHeight;
    if (top < list.scrollTop) {
      list.scrollTop = top;
    } else if (bottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = bottom - list.clientHeight;
    }
  }, [activeIndex]);

  if (suggestions.length === 0) {
    return null;
  }

  return (
    <div className="absolute right-0 bottom-full left-0 z-20 mb-2 overflow-hidden rounded-xl border border-[color:var(--cad-line-strong)] bg-[var(--cad-panel)] shadow-[var(--cad-shadow)]">
      <div className="flex items-center justify-between border-b border-[color:var(--cad-line)] px-4 py-2">
        <p className="cad-eyebrow text-[var(--cad-muted-2)]">
          {mode === "history" ? "Command history" : "Completions"}
        </p>
        <p className="cad-mono text-[10px] text-[var(--cad-muted-2)]">↑↓ select · ↵/Tab apply</p>
      </div>
      <div ref={listRef} className="cad-scroll max-h-64 overflow-auto py-1">
        {suggestions.map((suggestion, index) => {
          const isActive = index === activeIndex;
          return (
            <button
              key={suggestion.id}
              ref={(node) => {
                itemRefs.current[index] = node;
              }}
              type="button"
              onMouseDown={(event) => {
                event.preventDefault();
                onSelect(suggestion);
              }}
              className={cn(
                "flex w-full items-start gap-3 px-4 py-2 text-left font-mono text-xs transition-colors",
                isActive
                  ? "bg-[var(--cad-brass-bg)] text-[var(--cad-brass-strong)]"
                  : "text-[var(--cad-fg)] hover:bg-[var(--cad-panel-hover)]",
              )}
            >
              <span className="cad-eyebrow mt-0.5 min-w-14 text-[9px] text-[var(--cad-muted-2)]">
                {kindLabel(suggestion)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate">{suggestion.label}</span>
                <span className="mt-0.5 block truncate font-sans text-[11px] text-[var(--cad-muted)]">
                  {suggestion.detail ? `${suggestion.detail} · ` : ""}
                  {suggestion.description}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
