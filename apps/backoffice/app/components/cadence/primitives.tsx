import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** A bordered panel — the basic surface for grouping content. */
export function CadencePanel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "rounded-xl border border-[color:var(--cad-line)] bg-[var(--cad-panel)] shadow-[var(--cad-shadow)]",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** A labelled section heading with an eyebrow. */
export function SectionTitle({
  eyebrow,
  title,
  action,
}: {
  eyebrow: string;
  title: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-end justify-between gap-4">
      <div>
        <p className="cad-eyebrow text-[var(--cad-muted-2)]">{eyebrow}</p>
        <h2 className="cad-display mt-1 text-xl text-[var(--cad-fg)]">{title}</h2>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

/** A single metric tile in the summary row. */
export function StatTile({
  value,
  label,
  hint,
  accent,
}: {
  value: ReactNode;
  label: string;
  hint?: string;
  accent?: boolean;
}) {
  return (
    <CadencePanel className="p-5">
      <p
        className={cn(
          "cad-display text-3xl tabular-nums",
          accent ? "text-[var(--cad-brass-strong)]" : "text-[var(--cad-fg)]",
        )}
      >
        {value}
      </p>
      <p className="cad-eyebrow mt-2 text-[var(--cad-muted-2)]">{label}</p>
      {hint ? <p className="mt-1 text-xs text-[var(--cad-muted)]">{hint}</p> : null}
    </CadencePanel>
  );
}

/** Primary button — orange pill. */
export function CadenceButton({
  children,
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-lg bg-[var(--cad-brass)] px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[var(--cad-brass-strong)] disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

/** Secondary / ghost button — white pill. */
export function CadenceGhostButton({
  children,
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-lg border border-[color:var(--cad-line)] bg-[var(--cad-panel)] px-5 py-2.5 text-sm font-semibold text-[var(--cad-muted)] transition-colors hover:border-[color:var(--cad-line-strong)] hover:text-[var(--cad-fg)] disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
