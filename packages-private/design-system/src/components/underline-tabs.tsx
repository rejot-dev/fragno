import { Tabs } from "@base-ui/react/tabs";
import type { ComponentProps } from "react";

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

// The divider is an inset shadow rather than a border so it sits inside the row, under the tabs'
// underline.
export function UnderlineTabList({
  className,
  ...props
}: Omit<ComponentProps<typeof Tabs.List>, "className"> & { className?: string }) {
  return (
    <Tabs.List
      className={cn(
        "flex min-w-0 items-stretch gap-4 shadow-[inset_0_-1px_0_var(--bo-border)]",
        className,
      )}
      {...props}
    />
  );
}

export function UnderlineTab({
  className,
  ...props
}: Omit<ComponentProps<typeof Tabs.Tab>, "className"> & { className?: string }) {
  return (
    <Tabs.Tab
      className={(state) =>
        cn(
          underlineTabClassName(state.active ? "selected" : state.disabled ? "disabled" : "idle"),
          className,
        )
      }
      {...props}
    />
  );
}

// A tab-looking toggle for controls that change how a surface is displayed without owning its
// panel, so they announce as pressed buttons instead of tabs.
export function UnderlineToggleButton({
  pressed,
  className,
  type = "button",
  ...props
}: Omit<ComponentProps<"button">, "aria-pressed"> & { pressed: boolean }) {
  return (
    <button
      type={type}
      aria-pressed={pressed}
      className={cn(underlineTabClassName(pressed ? "selected" : "idle"), className)}
      {...props}
    />
  );
}
