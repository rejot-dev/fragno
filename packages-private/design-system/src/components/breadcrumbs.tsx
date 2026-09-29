import type { ReactNode } from "react";
import { Link } from "react-router";

import { Icon } from "./icon";

export type BreadcrumbItem = {
  label: ReactNode;
  to?: string;
};

export function BackofficeBreadcrumbs({ items }: { items: BreadcrumbItem[] }) {
  const visibleItems =
    items.length > 1 && items[0]?.label === "Backoffice" ? items.slice(1) : items;

  return (
    <nav aria-label="Breadcrumb" className="text-xs font-medium">
      <ol className="flex flex-wrap items-center gap-1.5 text-[var(--bo-muted-2)]">
        {visibleItems.map((item, index) => {
          const isLast = index === visibleItems.length - 1;
          return (
            <li
              key={`${item.to ?? "current"}:${String(item.label)}`}
              className="flex items-center gap-1.5"
            >
              {item.to && !isLast ? (
                <Link
                  to={item.to}
                  className="rounded-[4px] transition-colors duration-150 ease-out hover:text-[var(--bo-fg)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none"
                >
                  {item.label}
                </Link>
              ) : (
                <span
                  className="font-semibold text-[var(--bo-fg)]"
                  aria-current={isLast ? "page" : undefined}
                >
                  {item.label}
                </span>
              )}
              {!isLast ? (
                <Icon
                  name="chevron-right"
                  className="size-3 shrink-0 text-[var(--bo-muted-2)]"
                  strokeWidth={1.75}
                />
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
