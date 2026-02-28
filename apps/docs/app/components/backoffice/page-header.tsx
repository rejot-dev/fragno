import type { ReactNode } from "react";
import { BackofficeBreadcrumbs, type BreadcrumbItem } from "./breadcrumbs";

export function BackofficePageHeader({
  title,
  description,
  breadcrumbs,
  actions,
  eyebrow,
  showSidebarTrigger = true,
}: {
  title: string;
  description?: string;
  breadcrumbs: BreadcrumbItem[];
  actions?: ReactNode;
  eyebrow?: string;
  showSidebarTrigger?: boolean;
}) {
  return (
    <section className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="space-y-3">
          <BackofficeBreadcrumbs items={breadcrumbs} showSidebarTrigger={showSidebarTrigger} />
          <div className="space-y-2">
            {eyebrow ? (
              <p className="text-[11px] uppercase tracking-[0.24em] text-[var(--bo-muted-2)]">
                {eyebrow}
              </p>
            ) : null}
            <h1 className="text-2xl font-semibold tracking-tight text-[var(--bo-fg)] md:text-3xl">
              {title}
            </h1>
            {description ? (
              <p className="max-w-2xl text-sm text-[var(--bo-muted)]">{description}</p>
            ) : null}
          </div>
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </section>
  );
}
