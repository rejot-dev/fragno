import { ButtonLink } from "@fragno-private/design-system/button";
import { cn } from "@fragno-private/design-system/cn";
import { underlineTabClassName } from "@fragno-private/design-system/underline-tab-class-name";
import type { ReactNode } from "react";

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
      <ButtonLink
        to={newSessionHref}
        onClick={onStartNewSession}
        variant="solid"
        className="my-auto shrink-0"
      >
        New session
      </ButtonLink>
      <span
        title={session.name || session.id}
        className={cn(underlineTabClassName("selected"), "-mb-px min-h-0 min-w-0 shrink")}
        aria-hidden="true"
      >
        <span className="truncate">Conversation</span>
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-3">{options}</div>
    </header>
  );
}
