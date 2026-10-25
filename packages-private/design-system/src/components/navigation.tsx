import { cn } from "../cn";
import { IconButton } from "./button";
import { Icon } from "./icon";
import {
  MobileNavigationItem,
  SidebarNavigationItem,
  type NavigationItem,
} from "./navigation-item";

// `secondaryItems` sit in the sidebar's footer, for places about the current context rather than
// work in it, such as its settings. The last one shares its row with the collapse toggle.
export function SidebarNavigation({
  items,
  secondaryItems,
  ariaLabel,
  collapsed,
  onCollapsedChange,
}: {
  items: NavigationItem[];
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
          {items.map((item) => (
            <SidebarNavigationItem key={item.to} item={item} collapsed={collapsed} />
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
            <SidebarNavigationItem key={item.to} item={item} collapsed={collapsed} />
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
        <MobileNavigationItem key={item.to} item={item} />
      ))}
    </nav>
  );
}
