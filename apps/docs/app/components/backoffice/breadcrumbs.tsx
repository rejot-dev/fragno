import { Separator } from "@base-ui/react/separator";
import { Link } from "react-router";

export type BreadcrumbItem = {
  label: string;
  to?: string;
};

export function BackofficeBreadcrumbs({ items }: { items: BreadcrumbItem[] }) {
  return (
    <nav aria-label="Breadcrumb" className="text-[10px] uppercase tracking-[0.24em]">
      <ol className="flex flex-wrap items-center gap-2 text-[var(--bo-muted-2)]">
        {items.map((item, index) => {
          const isLast = index === items.length - 1;
          return (
            <li key={`${item.label}-${index}`} className="flex items-center gap-2">
              {item.to && !isLast ? (
                <Link to={item.to} className="transition-colors hover:text-[var(--bo-fg)]">
                  {item.label}
                </Link>
              ) : (
                <span className="text-[var(--bo-fg)]">{item.label}</span>
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
