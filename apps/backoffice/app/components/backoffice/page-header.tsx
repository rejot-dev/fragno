import type { ReactNode } from "react";

import { BackofficeBreadcrumbs, type BreadcrumbItem } from "./breadcrumbs";

const SECTION_CODES: Record<string, string> = {
  automations: "AUT",
  sessions: "SES",
  files: "FIL",
  internals: "ADM",
  administration: "ADM",
  integrations: "CON",
  organizations: "ORG",
  settings: "CFG",
  users: "USR",
  error: "ERR",
};

function resolveSectionCode(breadcrumbs: BreadcrumbItem[], eyebrow?: string) {
  const sectionLabel = breadcrumbs.find((item) => item.label !== "Backoffice")?.label;
  const source = typeof sectionLabel === "string" ? sectionLabel : eyebrow;
  if (!source) {
    return "SYS";
  }

  const normalizedSource = source.toLowerCase();
  const fallbackCode = normalizedSource
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 3)
    .toUpperCase();
  return SECTION_CODES[normalizedSource] ?? (fallbackCode || "SYS");
}

export function BackofficePageHeader({
  title,
  description,
  breadcrumbs,
  actions,
  eyebrow,
  code,
}: {
  title: string;
  description?: string;
  breadcrumbs: BreadcrumbItem[];
  actions?: ReactNode;
  eyebrow?: string;
  code?: string;
}) {
  const sectionCode = code ?? resolveSectionCode(breadcrumbs, eyebrow);

  return (
    <section className="bo-fragment-surface bo-panel-surface bg-[var(--bo-header-bg)] p-4">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="space-y-3">
          <BackofficeBreadcrumbs items={breadcrumbs} />
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="bo-product-code">{sectionCode}</span>
              {eyebrow ? (
                <p className="font-mono text-[10px] tracking-[0.2em] text-[var(--bo-muted-2)] uppercase">
                  {eyebrow}
                </p>
              ) : null}
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-balance text-[var(--bo-fg)] md:text-3xl">
              {title}
            </h1>
            {description ? (
              <p className="max-w-2xl text-sm text-pretty text-[var(--bo-muted)]">{description}</p>
            ) : null}
          </div>
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </section>
  );
}
