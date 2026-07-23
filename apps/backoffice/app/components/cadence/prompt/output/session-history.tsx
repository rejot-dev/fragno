/*
 * The session-history menu — a dropdown in the output header that lists the org's
 * past compose sessions (newest first). Picking one reopens it on the surface via
 * `resumeSession`, so its transcript loads and the next prompt continues it. The
 * list is loaded by the exec route and revalidates after each conducted prompt, so
 * a freshly started session appears here without a manual refresh.
 */

import { Menu } from "@base-ui/react/menu";
import { Check, History, Plus } from "lucide-react";

import { formatTimestamp } from "@/routes/backoffice/sessions/formatting";

import type { ComposeHistorySession } from "../prompt-context";

export function SessionHistory({
  history,
  activeSessionId,
  onResume,
  onNew,
}: {
  history: ComposeHistorySession[];
  activeSessionId: string | null;
  onResume: (session: ComposeHistorySession) => void;
  onNew: () => void;
}) {
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger className="group flex items-center gap-1.5 rounded-md border border-[color:var(--cad-line)] bg-[var(--cad-panel)] px-2.5 py-1.5 text-[11px] font-medium text-[var(--cad-muted)] transition-colors hover:border-[color:var(--cad-line-strong)] hover:text-[var(--cad-fg)]">
        <History className="h-3.5 w-3.5 text-[var(--cad-brass)]" />
        <span>History</span>
        {history.length > 0 ? (
          <span className="rounded-sm bg-[var(--cad-panel-2)] px-1.5 py-0.5 text-[9px] text-[var(--cad-muted-2)] tabular-nums">
            {history.length}
          </span>
        ) : null}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={8} className="z-50">
          <Menu.Popup
            data-cadence-root
            className="w-80 rounded-md border border-[color:var(--cad-line)] bg-[var(--cad-panel)] p-2 text-[var(--cad-fg)] shadow-[var(--cad-shadow)]"
          >
            <Menu.Item
              onClick={onNew}
              className="flex cursor-pointer items-center gap-2 rounded-sm px-3 py-2 text-xs font-medium text-[var(--cad-muted)] transition-colors data-[highlighted]:bg-[var(--cad-panel-2)] data-[highlighted]:text-[var(--cad-fg)]"
            >
              <Plus className="h-3.5 w-3.5 text-[var(--cad-brass)]" />
              New session
            </Menu.Item>

            {history.length > 0 ? (
              <Menu.Separator className="my-1.5 h-px bg-[var(--cad-line)]" />
            ) : null}

            <div className="cad-scroll max-h-80 overflow-y-auto">
              {history.length === 0 ? (
                <p className="px-3 py-2 text-xs text-[var(--cad-muted-2)]">No past sessions yet.</p>
              ) : (
                history.map((session) => {
                  const isActive = session.id === activeSessionId;
                  return (
                    <Menu.Item
                      key={session.id}
                      onClick={() => {
                        onResume(session);
                      }}
                      className="flex cursor-pointer items-start gap-2 rounded-sm px-3 py-2 transition-colors data-[highlighted]:bg-[var(--cad-panel-2)]"
                    >
                      <Check
                        className={`mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--cad-brass)] ${
                          isActive ? "opacity-100" : "opacity-0"
                        }`}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium text-[var(--cad-fg)]">
                          {session.name || session.id}
                        </span>
                        <span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-[var(--cad-muted-2)]">
                          <span className="tracking-wide uppercase">{session.status}</span>
                          <span aria-hidden>·</span>
                          <span>{formatTimestamp(session.updatedAt)}</span>
                        </span>
                      </span>
                    </Menu.Item>
                  );
                })
              )}
            </div>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
