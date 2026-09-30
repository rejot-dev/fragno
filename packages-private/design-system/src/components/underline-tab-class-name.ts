import { cn } from "../cn";

// Underline tabs switch between views of one surface. They share the shell's typography
// (sentence-case semibold brand sans) so a tab row reads like the navigation around it. The line is
// an ::after at the tab's bottom edge, so it lands on the row divider instead of stacking under it.
type UnderlineTabState = "selected" | "idle" | "disabled";

const BASE =
  "relative inline-flex min-h-10 shrink-0 items-center gap-2 rounded-[4px] px-2 text-sm font-semibold whitespace-nowrap outline-none transition-[color] duration-150 ease-out after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:transition-[background-color] after:duration-150 after:ease-out focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:ring-inset [&_svg]:size-4 [&_svg]:shrink-0";

const STATES: Record<UnderlineTabState, string> = {
  selected: "text-[var(--bo-fg)] after:bg-[var(--bo-accent)]",
  idle: "cursor-pointer text-[var(--bo-muted)] hover:text-[var(--bo-fg)] hover:after:bg-[var(--bo-border-strong)]",
  disabled: "cursor-not-allowed text-[var(--bo-muted-2)] opacity-50",
};

// For tab-shaped elements whose semantics live elsewhere: route links, menu triggers, and static
// labels.
export function underlineTabClassName(state: UnderlineTabState) {
  return cn(BASE, STATES[state]);
}
