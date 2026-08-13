import type { ReactNode } from "react";

export function SessionHeader({
  options,
  session,
}: {
  options?: ReactNode;
  session: {
    id: string;
    name?: string | null;
  };
}) {
  return (
    <header className="flex h-16 flex-none items-stretch gap-3 border-b border-[color:var(--bo-border)] px-3 sm:px-5">
      <h2 className="sr-only">{session.name || session.id}</h2>
      <span
        title={session.name || session.id}
        className="-mb-px flex min-w-0 items-center border-b-2 border-[color:var(--bo-accent)] px-1 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase"
        aria-hidden="true"
      >
        <span className="truncate">Conversation</span>
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-3">{options}</div>
    </header>
  );
}
