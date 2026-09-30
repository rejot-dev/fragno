import { cn } from "../cn";
import { IconButton } from "./button";
import { Icon } from "./icon";
import {
  MobileNavigationItem,
  SidebarNavigationItem,
  type NavigationItem,
} from "./navigation-item";

export function SidebarNavigation({
  items,
  ariaLabel,
  collapsed,
  onCollapsedChange,
}: {
  items: NavigationItem[];
  ariaLabel: string;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
}) {
  return (
    // Offsets track the top bar (h-16 plus its 1px border) through the spacing scale; the theme
    // overrides --spacing, so h-16 is not 4rem here.
    <aside
      className={cn(
        "sticky top-[calc(--spacing(16)+1px)] z-20 hidden h-[calc(100svh-(--spacing(16)+1px))] shrink-0 self-start border-r border-[color:var(--bo-border)] bg-[color:var(--bo-sidebar-bg)] transition-[width] duration-150 ease-out min-[960px]:flex min-[960px]:flex-col",
        collapsed ? "w-16" : "w-72",
      )}
    >
      <nav
        aria-label={ariaLabel}
        className={cn("flex flex-col gap-2.5 py-4", collapsed ? "px-2" : "px-gutter")}
      >
        {items.map((item) => (
          <SidebarNavigationItem key={item.to} item={item} collapsed={collapsed} />
        ))}
      </nav>
      <IconButton
        label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        title={`${collapsed ? "Expand" : "Collapse"} sidebar (⌘B)`}
        onClick={() => {
          onCollapsedChange(!collapsed);
        }}
        className={cn("mt-auto mb-3", collapsed ? "self-center" : "mr-gutter self-end")}
      >
        {collapsed ? (
          <Icon name="chevrons-right" className="size-4" strokeWidth={1.75} />
        ) : (
          <Icon name="chevrons-left" className="size-4" strokeWidth={1.75} />
        )}
      </IconButton>
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
