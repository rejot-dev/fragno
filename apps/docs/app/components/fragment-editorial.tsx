import type { ReactNode } from "react";
import { Link } from "react-router";

import { cn } from "@/lib/cn";

export function FragmentPageShell({
  children,
  className,
  /** Override default `min-h-screen` when the shell sits below a fixed header (e.g. error page). */
  mainClassName,
}: {
  children: ReactNode;
  className?: string;
  mainClassName?: string;
}) {
  return (
    <main className={cn("relative overflow-hidden", mainClassName ?? "min-h-screen")}>
      <div
        className={cn("relative mx-auto max-w-7xl px-4 py-12 sm:px-6 md:py-16 lg:px-8", className)}
      >
        {children}
      </div>
    </main>
  );
}

export function FragmentEyebrow({
  children,
  colorClass,
}: {
  children: ReactNode;
  colorClass?: string;
}) {
  return (
    <p
      className={cn(
        "text-base font-bold tracking-[0.18em] uppercase",
        colorClass ?? "text-[var(--editorial-muted)]",
      )}
    >
      {children}
    </p>
  );
}

export function FragmentHero({
  eyebrow,
  title,
  description,
  aside,
  children,
}: {
  eyebrow: ReactNode;
  title: ReactNode;
  description: ReactNode;
  aside?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="mb-20 grid gap-10 lg:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)] lg:items-start">
      <div className="space-y-6">
        {eyebrow}
        <h1 className="max-w-4xl text-5xl leading-[0.96] font-bold tracking-[-0.05em] md:text-7xl">
          {title}
        </h1>
        <p className="max-w-2xl text-base leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_72%,white)] md:text-lg">
          {description}
        </p>
        {children}
      </div>
      {aside}
    </section>
  );
}

export function FragmentPanel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "bg-[color-mix(in_srgb,var(--editorial-surface)_82%,transparent)] p-5 shadow-[inset_0_0_0_1px_var(--editorial-ghost-border)] backdrop-blur-[12px] md:p-6",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function FragmentSection({
  eyebrow,
  title,
  description,
  children,
  className,
}: {
  eyebrow?: ReactNode;
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("mb-20 space-y-6 max-w-6xl", className)}>
      {(eyebrow || title || description) && (
        <div className="max-w-3xl space-y-3">
          {eyebrow}
          {title ? (
            <h2 className="text-3xl leading-[1.02] font-bold tracking-[-0.04em] md:text-5xl">
              {title}
            </h2>
          ) : null}
          {description ? (
            <p className="text-base leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_72%,white)]">
              {description}
            </p>
          ) : null}
        </div>
      )}
      {children}
    </section>
  );
}

export function FragmentMetric({
  label,
  value,
  accentClass,
}: {
  label: ReactNode;
  value: ReactNode;
  accentClass?: string;
}) {
  return (
    <FragmentPanel className="space-y-3">
      <p className="text-sm tracking-[0.16em] text-[var(--editorial-muted)] uppercase">{label}</p>
      <p
        className={cn(
          "text-2xl leading-none font-bold tracking-[-0.04em] text-[var(--editorial-ink)]",
          accentClass,
        )}
      >
        {value}
      </p>
    </FragmentPanel>
  );
}

export function FragmentActionLink({
  to,
  children,
  variant = "primary",
}: {
  to: string;
  children: ReactNode;
  variant?: "primary" | "secondary";
}) {
  return (
    <Link
      to={to}
      className={cn(
        "inline-flex items-center gap-2 px-4 py-2 text-sm font-bold tracking-[0.12em] uppercase transition-colors",
        variant === "primary"
          ? "bg-[var(--editorial-ink)] text-[var(--editorial-paper)] hover:bg-[color-mix(in_srgb,var(--editorial-ink)_88%,black)]"
          : "bg-transparent text-[var(--editorial-ink)] shadow-[inset_0_0_0_1px_var(--editorial-ghost-border)] hover:bg-[color-mix(in_srgb,var(--editorial-ink)_4%,transparent)]",
      )}
    >
      {children}
    </Link>
  );
}
