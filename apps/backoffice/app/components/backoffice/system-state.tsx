import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import { BackofficeFragmentMark } from "./fragment-mark";

type BackofficeSystemStateTone = "loading" | "empty" | "error";

const DEFAULT_LABELS: Record<BackofficeSystemStateTone, string> = {
  loading: "Synchronizing",
  empty: "No data",
  error: "Connection failed",
};

export function BackofficeSystemState({
  tone,
  title,
  description,
  label = DEFAULT_LABELS[tone],
  actions,
  children,
  flush = false,
}: {
  tone: BackofficeSystemStateTone;
  title: string;
  description?: string;
  label?: string;
  actions?: ReactNode;
  children?: ReactNode;
  // Set when the panel sits flush against the surrounding chrome (tab rail, top bar,
  // view edges): clips the top and side edges of the panel shadow ring so only the
  // bottom edge remains, and hides the corner mark that hangs over the clipped edge.
  flush?: boolean;
}) {
  return (
    <section
      role={tone === "error" ? "alert" : "status"}
      aria-live={tone === "loading" ? "polite" : undefined}
      data-tone={tone}
      className={cn(
        "bo-fragment-surface bo-panel-surface bo-system-state bg-[var(--bo-panel)] p-4",
        flush && "[clip-path:inset(0_0_-1rem)] after:hidden!",
      )}
    >
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center bg-[var(--bo-panel-2)] shadow-[inset_0_0_0_1px_var(--bo-border)]">
          <BackofficeFragmentMark animated={tone === "loading"} size="md" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="bo-system-state-label font-mono text-[9px] font-semibold tracking-[0.2em] text-[var(--bo-muted-2)] uppercase">
            {label}
          </p>
          <h2 className="mt-1 text-base font-semibold text-balance text-[var(--bo-fg)]">{title}</h2>
          {description ? (
            <p className="mt-1 max-w-2xl text-sm text-pretty text-[var(--bo-muted)]">
              {description}
            </p>
          ) : null}
          {children ? <div className="mt-2 text-sm text-[var(--bo-muted)]">{children}</div> : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
      </div>
    </section>
  );
}
