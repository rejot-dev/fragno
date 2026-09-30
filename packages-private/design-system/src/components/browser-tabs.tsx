import { cn } from "../cn";

// Browser tabs are the top-level sections of a workspace. The selected tab is the white panel
// surface with its bottom border cleared, so it reads as the page opening beneath it.
type BrowserTabState = "selected" | "idle" | "disabled";

const BASE =
  "inline-flex min-h-11 shrink-0 items-center gap-2 rounded-t-[6px] border px-4 text-sm font-semibold whitespace-nowrap outline-none transition-[background-color,border-color,box-shadow,color] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30";

const STATES: Record<BrowserTabState, string> = {
  selected:
    "border-[color:var(--bo-border)] border-b-transparent bg-[var(--bo-panel)] text-[var(--bo-fg)] shadow-[var(--bo-selected-shadow)]",
  idle: "cursor-pointer border-transparent text-[var(--bo-muted)] hover:bg-[color-mix(in_srgb,var(--bo-panel)_55%,transparent)] hover:text-[var(--bo-fg)]",
  disabled: "cursor-not-allowed border-transparent text-[var(--bo-muted-2)] opacity-50",
};

export function browserTabClassName(state: BrowserTabState) {
  return cn(BASE, STATES[state]);
}
