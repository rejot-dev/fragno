import { Tabs } from "@base-ui/react/tabs";
import type { ComponentProps } from "react";

import { cn } from "../cn";
import { underlineTabClassName } from "./underline-tab-class-name";

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
