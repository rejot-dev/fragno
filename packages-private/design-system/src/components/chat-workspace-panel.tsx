import type { ReactNode } from "react";

import { IconButton } from "./button";
import { Icon } from "./icon";

/** The workspace beside a conversation, showing one item it produced, such as an interface. */
export function ChatWorkspacePanel({
  label,
  onClose,
  children,
}: {
  /** Names what the workspace shows, such as the item's title. */
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <aside
      aria-label="Session workspace"
      className="flex h-full min-h-0 min-w-0 flex-col border-l border-[color:var(--bo-border)] bg-[var(--bo-panel)]"
    >
      <header className="flex h-16 items-stretch justify-between gap-3 border-b border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3">
        <div className="ml-auto flex min-w-0 shrink-0 items-center gap-2">
          <IconButton label="Close session workspace" title="Close workspace" onClick={onClose}>
            <Icon name="x" className="size-4" />
          </IconButton>
        </div>
      </header>
      <section aria-label={`${label} workspace`} className="min-h-0 min-w-0 flex-1 overflow-hidden">
        {children}
      </section>
    </aside>
  );
}

/** Scrolls workspace content that has no scrolling of its own, such as a generated interface. */
export function ChatWorkspaceScroll({ children }: { children: ReactNode }) {
  return (
    <div className="backoffice-scroll h-full overflow-auto overscroll-contain p-4 sm:p-5">
      {children}
    </div>
  );
}
