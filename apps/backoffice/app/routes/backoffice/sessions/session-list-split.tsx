import type { ReactNode } from "react";

type SessionListSplitProps = {
  children: ReactNode;
  mobileNavigation: ReactNode;
  sidebar: ReactNode;
};

// The session list is fixed at w-72 so it lines up with the project selector
// in the top bar and the files explorer tree.
export function SessionListSplit({ children, mobileNavigation, sidebar }: SessionListSplitProps) {
  return (
    <section
      data-session-list-split
      className="bo-fragment-surface flex h-full min-h-0 flex-1 flex-col overflow-hidden border border-[color:var(--bo-border)] bg-[var(--bo-panel)] lg:flex-row"
    >
      {mobileNavigation}

      <div
        data-session-list-pane
        className="hidden h-full min-h-0 w-72 flex-none border-r border-[color:var(--bo-border-strong)] lg:flex"
      >
        {sidebar}
      </div>

      <main
        data-session-content-pane
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--bo-panel)]"
      >
        {children}
      </main>
    </section>
  );
}
