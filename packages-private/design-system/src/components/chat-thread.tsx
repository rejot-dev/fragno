import type { ComponentProps, ReactNode } from "react";

import { Button } from "./button";
import { InlineAlert } from "./inline-alert";

// The thread's layout elements spread their props so a chat runtime can render them as its own
// primitives (for example through `asChild`) and attach refs, scroll handling, and autoscroll.

type ElementProps = Omit<ComponentProps<"div">, "className">;

/** The conversation pane: a scrolling viewport with floating controls layered over it. */
export function ChatThread(props: ElementProps) {
  return (
    <div
      {...props}
      className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-[var(--bo-bg)]"
    />
  );
}

export function ChatViewport(props: ElementProps) {
  return (
    <div
      {...props}
      className="backoffice-scroll flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain scroll-smooth px-3 sm:px-6"
    />
  );
}

/** The readable column the messages sit in. */
export function ChatColumn(props: ElementProps) {
  return <div {...props} className="mx-auto flex w-full max-w-3xl flex-1 flex-col py-5 sm:py-8" />;
}

/** Keeps the composer pinned under the messages, fading them out as they scroll beneath it. */
export function ChatViewportFooter({
  alert,
  children,
  ...props
}: ElementProps & { alert: string | null }) {
  return (
    <div
      {...props}
      className="sticky bottom-0 z-20 mx-auto w-full max-w-3xl bg-[linear-gradient(to_bottom,transparent,var(--bo-bg)_1.5rem)] pt-8 pb-3 sm:pb-5"
    >
      {alert === null ? null : (
        <div className="mb-2">
          <InlineAlert>{alert}</InlineAlert>
        </div>
      )}
      {children}
    </div>
  );
}

/** Offers earlier messages above the thread, which are fetched a page at a time. */
export function ChatHistoryControls({
  explanation,
  hasMore,
  loading,
  error,
  onLoadMore,
}: {
  /** Why earlier history is set apart, shown until a divider in the thread explains it. */
  explanation: string | null;
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  onLoadMore: () => void;
}) {
  return (
    <section className="mb-7 flex flex-col items-center gap-2 text-center text-xs text-[var(--bo-muted)]">
      {explanation === null ? null : <p className="text-pretty">{explanation}</p>}
      {hasMore ? (
        <Button variant="ghost" disabled={loading} onClick={onLoadMore}>
          {loading ? "Loading…" : "Load older"}
        </Button>
      ) : null}
      {error === null ? null : (
        <p role="alert" className="text-pretty text-[var(--bo-failed)]">
          {error}
        </p>
      )}
    </section>
  );
}

/** Floats above the composer once the reader has scrolled away from the newest message. */
export function ChatScrollToLatestButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      variant="secondary"
      onClick={onClick}
      className="absolute bottom-[10.5rem] left-1/2 z-30 -translate-x-1/2 shadow-[var(--bo-popover-shadow)]"
    >
      Scroll to latest
    </Button>
  );
}

/** The state of an operation on the whole conversation, after its newest message. */
export function ChatThreadNotice({ children }: { children: ReactNode }) {
  return <div className="mb-3">{children}</div>;
}
