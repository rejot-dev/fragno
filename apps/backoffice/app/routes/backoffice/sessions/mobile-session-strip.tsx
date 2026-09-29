import { ButtonLink } from "@fragno-private/design-system/button";
import { Link } from "react-router";

import type { PiSessionListingState } from "@/fragno/pi/tanstack/session-listing";

type MobileSessionStripProps = {
  basePath: string;
  selectedSessionId: string | null;
  selectedWorkflowName: string | null;
  sessions: PiSessionListingState["snapshot"]["sessions"];
  workflowStatuses: PiSessionListingState["snapshot"]["workflowStatuses"];
  onNewChat: () => void;
};

export function MobileSessionStrip({
  basePath,
  selectedSessionId,
  selectedWorkflowName,
  sessions,
  workflowStatuses,
  onNewChat,
}: MobileSessionStripProps) {
  return (
    <nav
      aria-label="Sessions"
      className="backoffice-scroll flex min-h-12 flex-none overflow-x-auto border-b border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] lg:hidden"
    >
      <ButtonLink
        to={basePath}
        onClick={onNewChat}
        variant="solid"
        className="sticky left-0 z-10 mr-2 flex-none"
      >
        New chat
      </ButtonLink>
      {sessions.map((session) => {
        const workflowStatus = workflowStatuses[session.id] ?? "unknown";
        const isSelected =
          session.workflowName === selectedWorkflowName && session.id === selectedSessionId;

        return (
          <Link
            key={session.id}
            to={`${basePath}/${encodeURIComponent(session.workflowName)}/${encodeURIComponent(session.id)}`}
            preventScrollReset
            aria-current={isSelected ? "page" : undefined}
            className={`inline-flex min-h-12 max-w-44 flex-none items-center gap-2 border-r border-[color:var(--bo-border)] px-3 text-xs transition-[background-color,color,scale] duration-150 ease-out active:scale-[0.96] ${
              isSelected
                ? "bg-[var(--bo-selected-bg)] text-[var(--bo-fg)]"
                : "text-[var(--bo-muted)] hover:bg-[var(--bo-panel)] hover:text-[var(--bo-fg)]"
            }`}
          >
            <span
              role="img"
              aria-label={workflowStatus}
              className={`size-1.5 flex-none rounded-full ${workflowStatus === "active" ? "animate-pulse bg-[var(--bo-accent)]" : workflowStatus === "errored" || workflowStatus === "terminated" ? "bg-[var(--bo-failed)]" : workflowStatus === "waiting" || workflowStatus === "paused" ? "bg-[var(--bo-waiting)]" : "bg-[var(--bo-live)]"}`}
            />
            <span className="truncate">{session.name || session.id}</span>
          </Link>
        );
      })}
    </nav>
  );
}
