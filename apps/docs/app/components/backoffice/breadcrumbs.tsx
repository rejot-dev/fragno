import { Separator } from "@base-ui/react/separator";
import { DrawerPreview as Drawer } from "@base-ui/react/drawer";
import { Link } from "react-router";

export type BreadcrumbItem = {
  label: string;
  to?: string;
};

export function BackofficeBreadcrumbs({
  items,
  showSidebarTrigger = true,
}: {
  items: BreadcrumbItem[];
  showSidebarTrigger?: boolean;
}) {
  return (
    <nav aria-label="Breadcrumb" className="text-[10px] uppercase tracking-[0.24em]">
      <ol className="flex flex-wrap items-center gap-2 text-[var(--bo-muted-2)]">
        {showSidebarTrigger ? (
          <li className="flex items-center gap-2 lg:hidden">
            <Drawer.Trigger
              type="button"
              aria-label="Open sidebar"
              className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
            >
              Menu
            </Drawer.Trigger>
            <Separator orientation="vertical" className="h-3 w-px bg-[var(--bo-border-strong)]" />
          </li>
        ) : null}
        {items.map((item, index) => {
          const isLast = index === items.length - 1;
          return (
            <li key={`${item.label}-${index}`} className="flex items-center gap-2">
              {item.to && !isLast ? (
                <Link to={item.to} className="transition-colors hover:text-[var(--bo-fg)]">
                  {item.label}
                </Link>
              ) : (
                <span className="text-[var(--bo-fg)]" aria-current={isLast ? "page" : undefined}>
                  {item.label}
                </span>
              )}
              {!isLast ? (
                <Separator
                  orientation="vertical"
                  className="h-3 w-px bg-[var(--bo-border-strong)]"
                />
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
