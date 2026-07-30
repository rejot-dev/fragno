import { ScrollArea } from "@base-ui/react/scroll-area";
import { Link } from "react-router";

import type { PiSessionListingState } from "@/fragno/pi/tanstack/session-listing";

import { formatTimestamp } from "./formatting";

type SessionSidebarProps = {
  basePath: string;
  listingError: string | null;
  selectedSessionId: string | null;
  selectedWorkflowName: string | null;
  sessions: PiSessionListingState["snapshot"]["sessions"];
  workflowStatuses: PiSessionListingState["snapshot"]["workflowStatuses"];
  onNewChat: () => void;
};

export function SessionSidebar({
  basePath,
  listingError,
  selectedSessionId,
  selectedWorkflowName,
  sessions,
  workflowStatuses,
  onNewChat,
}: SessionSidebarProps) {
  return (
    <aside className="hidden min-h-0 w-72 flex-none flex-col border-r border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] lg:flex">
      <div className="border-b border-[color:var(--bo-border)] p-3">
        <Link
          to={basePath}
          onClick={onNewChat}
          className="flex min-h-11 items-center justify-center bg-[var(--bo-accent)] px-4 text-xs font-semibold tracking-[0.08em] text-white uppercase transition-[background-color,scale] duration-150 ease-out hover:bg-[var(--bo-accent-strong)] active:scale-[0.96]"
        >
          New chat
        </Link>
      </div>

      {listingError ? (
        <p className="mx-3 mt-3 border border-[color:var(--bo-failed)] bg-[var(--bo-failed-bg)] px-3 py-2 text-xs text-pretty text-[var(--bo-failed)]">
          {listingError}
        </p>
      ) : null}

      <div className="flex min-h-10 items-center justify-between px-4 text-[10px] font-semibold tracking-[0.14em] text-[var(--bo-muted-2)] uppercase">
        <span>Chats</span>
        <span className="tabular-nums">{sessions.length}</span>
      </div>

      <ScrollArea.Root className="relative flex min-h-0 flex-1 overflow-hidden">
        <ScrollArea.Viewport className="min-h-0 flex-1 px-2 pb-3">
          <ScrollArea.Content className="space-y-1">
            {sessions.length === 0 ? (
              <p className="px-3 py-8 text-center text-xs text-[var(--bo-muted-2)]">No chats</p>
            ) : (
              sessions.map((session) => {
                const workflowStatus = workflowStatuses[session.id] ?? "unknown";
                const isSelected =
                  session.workflowName === selectedWorkflowName && session.id === selectedSessionId;

                return (
                  <Link
                    key={session.id}
                    to={`${basePath}/${encodeURIComponent(session.workflowName)}/${encodeURIComponent(session.id)}`}
                    preventScrollReset
                    aria-current={isSelected ? "page" : undefined}
                    className={`group block border px-3 py-3 transition-[background-color,border-color,scale] duration-150 ease-out active:scale-[0.96] ${
                      isSelected
                        ? "border-[color:var(--bo-accent)] bg-[var(--bo-panel)]"
                        : "border-transparent hover:border-[color:var(--bo-border)] hover:bg-[rgba(var(--bo-grid),0.16)]"
                    }`}
                  >
                    <p className="truncate text-xs font-medium text-[var(--bo-fg)]">
                      {session.name || session.id}
                    </p>
                    <div className="mt-1.5 flex items-center justify-between gap-3 text-[9px] text-[var(--bo-muted-2)]">
                      <time className="tabular-nums">{formatTimestamp(session.updatedAt)}</time>
                      <span
                        role="img"
                        aria-label={workflowStatus}
                        className={`size-1.5 flex-none rounded-full ${workflowStatus === "active" ? "animate-pulse bg-[var(--bo-accent)]" : workflowStatus === "errored" || workflowStatus === "terminated" ? "bg-[var(--bo-failed)]" : workflowStatus === "waiting" || workflowStatus === "paused" ? "bg-[var(--bo-waiting)]" : "bg-[var(--bo-live)]"}`}
                      />
                    </div>
                  </Link>
                );
              })
            )}
          </ScrollArea.Content>
        </ScrollArea.Viewport>
        <ScrollArea.Scrollbar
          orientation="vertical"
          keepMounted
          className="flex w-2.5 p-[2px] select-none"
        >
          <ScrollArea.Thumb className="w-full rounded-full bg-[rgba(var(--bo-grid),0.45)] transition-colors hover:bg-[rgba(var(--bo-grid),0.65)]" />
        </ScrollArea.Scrollbar>
      </ScrollArea.Root>
    </aside>
  );
}
