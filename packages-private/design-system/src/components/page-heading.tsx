import type { ReactNode } from "react";

/**
 * A page's title row, for apps whose navigation already says where the reader is: a short line of
 * context above the title, a note under it, and the page's actions at the end. Lighter than
 * BackofficePageHeader, so the page's content starts near the top.
 */
export function PageHeading({
  eyebrow,
  title,
  meta,
  actions,
}: {
  eyebrow: ReactNode | null;
  title: string;
  meta: ReactNode | null;
  actions: ReactNode | null;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0 space-y-1">
        {eyebrow === null ? null : (
          <p className="text-sm font-medium text-[var(--bo-muted-2)]">{eyebrow}</p>
        )}
        <h1 className="text-2xl font-semibold tracking-tight text-balance text-[var(--bo-fg)]">
          {title}
        </h1>
        {meta === null ? null : (
          <p className="text-sm text-pretty text-[var(--bo-muted)] tabular-nums">{meta}</p>
        )}
      </div>
      {actions === null ? null : <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
