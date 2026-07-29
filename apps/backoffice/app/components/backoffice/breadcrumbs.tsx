import { Separator } from "@base-ui/react/separator";
import type { ReactNode } from "react";
import { Link } from "react-router";

export type BreadcrumbItem = {
  label: ReactNode;
  to?: string;
};

export function BackofficeBreadcrumbs({ items }: { items: BreadcrumbItem[] }) {
  const visibleItems =
    items.length > 1 && items[0]?.label === "Backoffice" ? items.slice(1) : items;

  return (
    <nav aria-label="Breadcrumb" className="text-[10px] tracking-[0.24em] uppercase">
      <ol className="flex flex-wrap items-center gap-2 text-[var(--bo-muted-2)]">
        {visibleItems.map((item, index) => {
          const isLast = index === visibleItems.length - 1;
          return (
            <li
              key={`${item.to ?? "current"}:${String(item.label)}`}
              className="flex items-center gap-2"
            >
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
