import type { ReactNode } from "react";

/**
 * An interface the agent generated, in the conversation after the work that produced it, as wide
 * as the conversation, like a workflow's.
 */
export function ChatInterface({ children }: { children: ReactNode }) {
  return (
    <section
      aria-label="Generated interface"
      className="bo-chat-enter min-w-0 rounded-[4px] border border-[color:var(--bo-border-strong)] bg-[var(--bo-panel)] p-3"
    >
      {children}
    </section>
  );
}
