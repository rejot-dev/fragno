import type { ReactNode, Ref } from "react";

import { IconButton } from "./button";
import { Icon } from "./icon";

/** The workspace beside a conversation, showing one item it produced, such as a workflow. */
export function ChatWorkspacePanel({
  label,
  toolbarRef,
  actions,
  onClose,
  children,
}: {
  /** Names what the workspace shows, such as the item's title. */
  label: string;
  /** For controls that measure the toolbar to decide what fits. */
  toolbarRef: Ref<HTMLElement>;
  actions: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <aside
      aria-label="Session workspace"
      className="flex h-full min-h-0 min-w-0 flex-col border-l border-[color:var(--bo-border)] bg-[var(--bo-panel)]"
    >
      <header
        ref={toolbarRef}
        data-session-workspace-toolbar
        className="flex h-16 items-stretch justify-between gap-3 border-b border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3"
      >
        <div
          data-session-workspace-actions
          className="ml-auto flex min-w-0 shrink-0 items-center gap-2"
        >
          {actions}
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

/** A thin bar over the workspace content while its data is synchronizing or after that failed. */
export function ChatWorkspaceStatus({
  tone,
  children,
}: {
  tone: "loading" | "failed";
  children: string;
}) {
  if (tone === "failed") {
    return (
      <div
        data-workspace-status="failed"
        role="alert"
        className="flex min-h-8 shrink-0 items-center gap-2 border-b border-[color:var(--bo-failed)] bg-[var(--bo-failed-bg)] px-3 text-xs text-[var(--bo-failed)]"
      >
        <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-[var(--bo-failed)]" />
        <span className="truncate" title={children}>
          {children}
        </span>
      </div>
    );
  }
  return (
    <div
      data-workspace-status="loading"
      role="status"
      className="flex min-h-8 shrink-0 items-center gap-2 border-b border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 text-xs text-[var(--bo-muted)]"
    >
      <span
        aria-hidden="true"
        className="size-1.5 shrink-0 animate-pulse rounded-full bg-[var(--bo-accent)]"
      />
      {children}
    </div>
  );
}
