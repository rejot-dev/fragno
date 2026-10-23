import type { ReactNode } from "react";

type SessionListSplitProps = {
  children: ReactNode;
};

export function SessionListSplit({ children }: SessionListSplitProps) {
  return (
    <section
      data-session-list-split
      className="bo-fragment-surface flex h-full min-h-0 flex-1 overflow-hidden border-b border-[color:var(--bo-border)] bg-[var(--bo-bg)]"
    >
      <main
        data-session-content-pane
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      >
        {children}
      </main>
    </section>
  );
}
