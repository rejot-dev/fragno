import type { ReactNode } from "react";

export function FormContainer({
  title,
  description,
  children,
  actions,
  eyebrow,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  actions?: ReactNode;
  eyebrow?: string;
}) {
  return (
    <section className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4">
      <div className="flex flex-col gap-3 border-b border-[color:var(--bo-border)] pb-3 md:flex-row md:items-start md:justify-between">
        <div className="space-y-2">
          {eyebrow ? (
            <p className="text-[10px] uppercase tracking-[0.24em] text-[var(--bo-muted-2)]">
              {eyebrow}
            </p>
          ) : null}
          <h2 className="text-xl font-semibold text-[var(--bo-fg)]">{title}</h2>
          {description ? <p className="text-sm text-[var(--bo-muted)]">{description}</p> : null}
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  );
}

export function FormField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-2 text-sm">
      <span className="flex flex-col gap-1">
        <span className="text-[11px] uppercase tracking-[0.22em] text-[var(--bo-muted-2)]">
          {label}
        </span>
        {hint ? <span className="text-xs text-[var(--bo-muted)]">{hint}</span> : null}
      </span>
      {children}
    </label>
  );
}
