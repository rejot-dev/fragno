import type { ReactNode } from "react";

import { cn } from "../cn";
import { IconButton } from "./button";
import { Icon } from "./icon";
import {
  MobileNavigationItem,
  SidebarNavigationItem,
  type NavigationItem,
} from "./navigation-item";

/**
 * A group of the sidebar's destinations. A labelled group, such as the record the reader is in,
 * follows the unlabelled ones; collapsed, its label gives way to a rule.
 */
export type NavigationSection = { label: string | null; items: NavigationItem[] };

// `secondaryItems` sit in the sidebar's footer, for places about the current context rather than
// work in it, such as its settings. The last one shares its row with the collapse toggle.
export function SidebarNavigation({
  sections,
  secondaryItems,
  ariaLabel,
  collapsed,
  onCollapsedChange,
}: {
  sections: readonly NavigationSection[];
  secondaryItems: NavigationItem[];
  ariaLabel: string;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
}) {
  const inset = collapsed ? "px-2" : "px-gutter";
  const footerItems = secondaryItems.slice(0, -1);
  const lastFooterItem = secondaryItems.at(-1) ?? null;
  return (
    // Offsets track the top bar (h-16 plus its 1px border) through the spacing scale; the theme
    // overrides --spacing, so h-16 is not 4rem here.
    <aside
      className={cn(
        "sticky top-[calc(--spacing(16)+1px)] z-20 hidden h-[calc(100svh-(--spacing(16)+1px))] shrink-0 self-start border-r border-[color:var(--bo-border)] bg-[color:var(--bo-sidebar-bg)] transition-[width] duration-150 ease-out min-[960px]:flex min-[960px]:flex-col",
        collapsed ? "w-16" : "w-72",
      )}
    >
      <nav aria-label={ariaLabel} className="flex min-h-0 flex-1 flex-col">
        <div className={cn("flex flex-col gap-2.5 py-4", inset)}>
          {sections.map((section, index) => (
            // Sections are positional: the unlabelled ones have nothing else to tell them apart.
            // oxlint-disable-next-line no-array-index-key
            <div key={index} className="flex flex-col gap-2.5">
              {section.label === null ? null : collapsed ? (
                <hr className="mx-2 mt-2 border-[color:var(--bo-border)]" />
              ) : (
                <p className="mt-4 truncate px-2 text-xs font-semibold text-[var(--bo-muted-2)]">
                  {section.label}
                </p>
              )}
              {section.items.map((item) => (
                <SidebarNavigationItem key={item.label} item={item} collapsed={collapsed} />
              ))}
            </div>
          ))}
        </div>
        {/* Ruled off across the sidebar's width, so the footer reads as one row of its own. */}
        <div
          className={cn(
            "mt-auto flex flex-col gap-2.5 border-t border-[color:var(--bo-border)] py-3",
            inset,
          )}
        >
          {footerItems.map((item) => (
            <SidebarNavigationItem key={item.label} item={item} collapsed={collapsed} />
          ))}
          <div className={cn("flex gap-2", collapsed ? "flex-col gap-2.5" : "items-center")}>
            {lastFooterItem ? (
              <div className={collapsed ? undefined : "min-w-0 flex-1"}>
                <SidebarNavigationItem item={lastFooterItem} collapsed={collapsed} />
              </div>
            ) : null}
            <IconButton
              label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              title={`${collapsed ? "Expand" : "Collapse"} sidebar (⌘B)`}
              onClick={() => {
                onCollapsedChange(!collapsed);
              }}
              className={collapsed ? "self-center" : "ml-auto shrink-0"}
            >
              {collapsed ? (
                <Icon name="chevrons-right" className="size-4" strokeWidth={1.75} />
              ) : (
                <Icon name="chevrons-left" className="size-4" strokeWidth={1.75} />
              )}
            </IconButton>
          </div>
        </div>
      </nav>
    </aside>
  );
}

// Below the sidebar breakpoint the same destinations become an evenly split tab bar.
export function MobileNavigation({
  items,
  ariaLabel,
}: {
  items: NavigationItem[];
  ariaLabel: string;
}) {
  return (
    <nav aria-label={ariaLabel} className="grid auto-cols-fr grid-flow-col">
      {items.map((item) => (
        <MobileNavigationItem key={item.label} item={item} />
      ))}
    </nav>
  );
}

/**
 * Phone navigation pinned to the bottom of the screen, within reach of a thumb: evenly split slots
 * of BottomNavigationItem and BottomNavigationButton. The consumer hides it where it does not apply
 * and keeps page content clear of it; it pads itself above the home indicator.
 */
export function BottomNavigation({
  ariaLabel,
  children,
}: {
  ariaLabel: string;
  children: ReactNode;
}) {
  return (
    <nav
      aria-label={ariaLabel}
      className="fixed inset-x-0 bottom-0 z-30 grid auto-cols-fr grid-flow-col border-t border-[color:var(--bo-border)] bg-[color:var(--bo-top-bar-bg)] px-1 pb-[env(safe-area-inset-bottom)]"
    >
      {children}
    </nav>
  );
}
