import type { ComponentProps, ReactNode } from "react";
import { Link } from "react-router";

import { cn } from "../../cn";
import { Icon, type IconName } from "../icon";

// An action drawn like the sidebar's destinations: an icon slot, a ruled line, and the label, so a
// short list of next steps reads like the navigation beside it. primary is the selected
// destination's raised surface, for the step to take; quiet is a resting destination.
export type ActionItemEmphasis = "primary" | "quiet";

const BASE =
  "flex min-h-11 w-full items-center rounded-[4px] border pr-3 pl-[calc(--spacing(1)-1px)] text-left text-sm font-semibold text-[var(--bo-fg)] transition-[background-color,border-color,box-shadow,scale] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 disabled:active:scale-100";

const EMPHASES: Record<ActionItemEmphasis, string> = {
  primary:
    "border-[color:var(--bo-selected-border)] bg-[var(--bo-selected-bg)] shadow-[var(--bo-selected-shadow)] hover:bg-[var(--bo-panel-2)]",
  quiet: "border-transparent hover:bg-[var(--bo-panel-2)]",
};

function ActionItemContent({ icon, children }: { icon: IconName; children: ReactNode }) {
  // Spaced like SidebarNavigationItem, so icons and labels share its columns.
  return (
    <>
      <span className="flex size-8 shrink-0 items-center justify-center">
        <Icon name={icon} className="size-4 text-[var(--bo-muted)]" strokeWidth={1.75} />
      </span>
      <span
        aria-hidden="true"
        className="mr-[calc(--spacing(2.75)-0.5px)] ml-[calc(--spacing(0.75)-0.5px)] h-6 w-px shrink-0 bg-[var(--bo-border)]"
      />
      {/* Trimmed to cap height like the sidebar's labels, so it must not clip its overflow: that
          would cut off ascenders and descenders. A long label wraps instead. */}
      <span className="min-w-0 py-1 [text-box:trim-both_cap_alphabetic]">{children}</span>
    </>
  );
}

export function ActionItem({
  icon,
  emphasis,
  className,
  type = "button",
  children,
  ...props
}: Omit<ComponentProps<"button">, "children"> & {
  icon: IconName;
  emphasis: ActionItemEmphasis;
  children: ReactNode;
}) {
  // Defaults to type="button" so an action inside a form never submits by accident.
  return (
    <button type={type} className={cn(BASE, EMPHASES[emphasis], className)} {...props}>
      <ActionItemContent icon={icon}>{children}</ActionItemContent>
    </button>
  );
}

export function ActionItemLink({
  icon,
  emphasis,
  className,
  children,
  ...props
}: Omit<ComponentProps<typeof Link>, "children"> & {
  icon: IconName;
  emphasis: ActionItemEmphasis;
  children: ReactNode;
}) {
  return (
    <Link className={cn(BASE, EMPHASES[emphasis], className)} {...props}>
      <ActionItemContent icon={icon}>{children}</ActionItemContent>
    </Link>
  );
}
