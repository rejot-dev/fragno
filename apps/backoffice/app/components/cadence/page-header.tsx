import type { ReactNode } from "react";

/**
 * Page masthead: an eyebrow label, the title in display serif, and an optional
 * description. Actions sit to the right, with a hairline rule beneath.
 */
export function CadencePageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: string;
  title: ReactNode;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="space-y-4">
      <div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
        <div className="space-y-2">
          <p className="cad-eyebrow text-[var(--cad-brass)]">{eyebrow}</p>
          <h1 className="cad-display text-3xl leading-tight text-[var(--cad-fg)] md:text-4xl">
            {title}
          </h1>
          {description ? (
            <p className="max-w-2xl text-sm leading-relaxed text-[var(--cad-muted)]">
              {description}
            </p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex flex-wrap items-center gap-2.5 md:justify-end">{actions}</div>
        ) : null}
      </div>
      <div className="h-px w-full bg-[var(--cad-line)]" />
    </header>
  );
}
