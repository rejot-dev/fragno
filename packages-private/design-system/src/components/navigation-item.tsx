import { Link } from "react-router";

import { cn } from "../cn";
import { Icon, type IconName } from "./icon";

// Resolved by the consumer: which destinations exist, where they point, and which one is current
// are routing concerns, so navigation items only render them.
export type NavigationItem = {
  label: string;
  to: string;
  icon: IconName;
  active: boolean;
};

// Collapsed, the label stays in the accessible name and moves to the tooltip.
export function SidebarNavigationItem({
  item,
  collapsed,
}: {
  item: NavigationItem;
  collapsed: boolean;
}) {
  return (
    <Link
      to={item.to}
      aria-current={item.active ? "page" : undefined}
      title={collapsed ? item.label : undefined}
      className={cn(
        "flex min-h-11 items-center rounded-[4px] border text-sm font-semibold text-[var(--bo-fg)] transition-[background-color,border-color,box-shadow,color] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none",
        // With the nav's px-4 and this 1px border, pl puts the icon slot at the selector's pl-5, so
        // icons center under the workspace tile and labels line up with the selector's label.
        collapsed ? "justify-center px-0" : "pr-3 pl-[calc(--spacing(1)-1px)]",
        item.active
          ? "border-[color:var(--bo-selected-border)] bg-[var(--bo-selected-bg)] shadow-[var(--bo-selected-shadow)]"
          : "border-transparent hover:bg-[var(--bo-panel-2)]",
      )}
    >
      {/* Matches the selector's workspace tile so icons and labels share its columns. */}
      <span className="flex size-8 shrink-0 items-center justify-center">
        <Icon name={item.icon} className="size-4 text-[var(--bo-muted)]" strokeWidth={1.75} />
      </span>
      {collapsed ? null : (
        // The margins sum to 3.5 (the selector's mr-1 + gap-2.5 after its tile) so labels stay
        // aligned, and centre the line between the glyph and the label: the size-4 glyph leaves 2 of
        // slot padding on its right, giving 5.5 of visible space to split around the 1px line.
        <span
          aria-hidden="true"
          className="mr-[calc(--spacing(2.75)-0.5px)] ml-[calc(--spacing(0.75)-0.5px)] h-6 w-px shrink-0 bg-[var(--bo-border)]"
        />
      )}
      {/* The brand font's ascent is far taller than its caps, so an untrimmed line box centres the
          glyphs below the icon; trimming to cap height and baseline centres the letters themselves. */}
      <span className={collapsed ? "sr-only" : "[text-box:trim-both_cap_alphabetic]"}>
        {item.label}
      </span>
    </Link>
  );
}

export function MobileNavigationItem({ item }: { item: NavigationItem }) {
  return (
    <Link
      to={item.to}
      aria-current={item.active ? "page" : undefined}
      className={cn(
        "relative flex min-h-11 min-w-0 items-center justify-center border-b-2 px-1 text-[9px] font-semibold tracking-[0.1em] uppercase transition-[scale,background-color,border-color,color] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none focus-visible:ring-inset active:scale-[0.96]",
        item.active
          ? "border-[color:var(--bo-accent)] bg-[var(--bo-selected-bg)] text-[var(--bo-fg)]"
          : "border-transparent text-[var(--bo-muted)] hover:bg-[var(--bo-panel-2)] hover:text-[var(--bo-fg)]",
      )}
    >
      {item.label}
    </Link>
  );
}
