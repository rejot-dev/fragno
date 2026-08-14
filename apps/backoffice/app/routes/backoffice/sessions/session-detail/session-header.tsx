import type { ReactNode } from "react";
import { Link } from "react-router";

export function SessionHeader({
  newSessionHref,
  onStartNewSession,
  options,
  session,
}: {
  newSessionHref: string;
  onStartNewSession: () => void;
  options?: ReactNode;
  session: {
    id: string;
    name?: string | null;
  };
}) {
  return (
    <header className="flex h-16 flex-none items-stretch gap-3 border-b border-[color:var(--bo-border)] px-3 sm:px-5">
      <h2 className="sr-only">{session.name || session.id}</h2>
      <Link
        to={newSessionHref}
        onClick={onStartNewSession}
        className="my-auto inline-flex min-h-9 shrink-0 items-center bg-[var(--bo-btn-bg)] px-3 text-[10px] font-semibold tracking-[0.08em] text-[var(--bo-btn-fg)] uppercase transition-[background-color,scale] duration-150 ease-out hover:bg-[var(--bo-btn-bg-hover)] active:scale-[0.96] sm:px-4"
      >
        New session
      </Link>
      <span
        title={session.name || session.id}
        className="-mb-px flex min-w-0 items-center border-b-2 border-[color:var(--bo-accent)] px-1 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase"
        aria-hidden="true"
      >
        <span className="truncate">Conversation</span>
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-3">{options}</div>
    </header>
  );
}
