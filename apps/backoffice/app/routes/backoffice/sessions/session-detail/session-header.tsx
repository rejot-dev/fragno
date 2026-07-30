import type { ReactNode } from "react";

export function SessionHeader({
  harnessLabel,
  modelLabel,
  options,
  session,
}: {
  harnessLabel: string;
  modelLabel: string;
  options?: ReactNode;
  session: {
    id: string;
    name?: string | null;
  };
}) {
  return (
    <header className="flex min-h-14 flex-none items-center justify-between gap-3 border-b border-[color:var(--bo-border)] px-3 sm:px-5">
      <div className="min-w-0">
        <h2 className="truncate text-sm font-semibold text-[var(--bo-fg)]">
          {session.name || session.id}
        </h2>
        <p className="truncate text-[10px] text-[var(--bo-muted-2)]">
          {harnessLabel} · {modelLabel}
        </p>
      </div>
      {options}
    </header>
  );
}
