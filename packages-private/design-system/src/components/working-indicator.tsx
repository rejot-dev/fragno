import type { ReactNode } from "react";

/** A pulsing dot beside what is in progress, for work that has no measurable progress. */
export function WorkingIndicator({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 text-xs text-[var(--bo-muted-2)]">
      <span
        aria-hidden="true"
        className="size-1.5 shrink-0 animate-pulse rounded-full bg-[var(--bo-accent)]"
      />
      {children}
    </span>
  );
}
