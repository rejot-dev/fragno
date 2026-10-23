import { useEffect, useRef, type ComponentProps, type ReactNode } from "react";

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
      className="backoffice-scroll-invisible flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain scroll-smooth px-3 sm:px-6"
    />
  );
}

/** The readable column the messages sit in. Its last child is a ChatTurnSpacer. */
export function ChatColumn(props: ElementProps) {
  return <div {...props} className="mx-auto flex w-full max-w-3xl flex-1 flex-col py-5 sm:py-8" />;
}

// Room left above the newest turn when it sits at the top of the viewport.
const TURN_TOP_GAP_PX = 16;

/**
 * Space after the messages that lets the newest turn, starting at the reader's latest message,
 * scroll to the top of the viewport. The space shrinks as the reply fills it, so a viewport that
 * keeps to its bottom first holds the reader's message at the top and then follows the reply.
 *
 * Must be the last child of the ChatColumn, which sits directly inside the ChatViewport.
 */
export function ChatTurnSpacer() {
  const spacerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const spacer = spacerRef.current;
    const column = spacer?.parentElement;
    const viewport = column?.parentElement;
    if (!spacer || !column || !viewport) {
      return undefined;
    }
    return reserveTurnRoom(spacer, column, viewport);
  }, []);

  // Reduced motion gives every element a near-zero transition, which would make the height this
  // spacer just set unreadable until the next frame.
  return <div ref={spacerRef} aria-hidden="true" className="shrink-0 transition-none" />;
}

/** Keeps the spacer sized to the newest turn as the thread changes; returns the cleanup. */
function reserveTurnRoom(spacer: HTMLElement, column: HTMLElement, viewport: HTMLElement) {
  let turnStart: Element | null = null;

  function resize(start: Element) {
    let height = spacer.offsetHeight;
    // The column stretches to fill a short thread, so the content's own height only shows once
    // the spacer pushes past the viewport; a few passes reach that point.
    for (let pass = 0; pass < 4; pass++) {
      const startTop =
        start.getBoundingClientRect().top -
        viewport.getBoundingClientRect().top +
        viewport.scrollTop;
      const wantedScrollHeight = startTop - TURN_TOP_GAP_PX + viewport.clientHeight;
      const next = Math.max(0, wantedScrollHeight - (viewport.scrollHeight - height));
      if (Math.abs(next - height) < 1) {
        return;
      }
      height = next;
      spacer.style.height = `${next}px`;
    }
  }

  function update() {
    const starts = column.querySelectorAll("[data-chat-turn-start]");
    const latestStart = starts.item(starts.length - 1);
    const atBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 1;
    const previousScrollHeight = viewport.scrollHeight;
    if (latestStart) {
      resize(latestStart);
    } else {
      spacer.style.height = "0px";
    }
    const newTurn = latestStart !== turnStart;
    turnStart = latestStart;
    // Chat runtimes keep to the bottom when content changes, but not when only this spacer's
    // style does, so the spacer keeps a reader at the bottom itself. A new turn scrolls with the
    // viewport's own scroll behavior, which reduced motion makes instant.
    if (atBottom && viewport.scrollHeight !== previousScrollHeight) {
      viewport.scrollTo({ top: viewport.scrollHeight, behavior: newTurn ? "auto" : "instant" });
    }
  }

  const resizeObserver = new ResizeObserver(update);
  function observeSizes() {
    resizeObserver.disconnect();
    resizeObserver.observe(viewport);
    for (const child of column.children) {
      if (child !== spacer) {
        resizeObserver.observe(child);
      }
    }
  }
  const mutationObserver = new MutationObserver((mutations) => {
    if (mutations.some((mutation) => mutation.target === column && mutation.type === "childList")) {
      observeSizes();
    }
    if (mutations.some((mutation) => mutation.target !== spacer)) {
      update();
    }
  });
  observeSizes();
  mutationObserver.observe(column, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
  });
  update();
  return () => {
    resizeObserver.disconnect();
    mutationObserver.disconnect();
  };
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

/**
 * Floats above the composer once the reader has scrolled away from the newest message. Place it
 * inside the ChatViewportFooter; it spreads its props so a chat runtime can supply the scroll.
 */
export function ChatScrollToLatestButton(
  props: Omit<ComponentProps<"button">, "className" | "children">,
) {
  return (
    <Button
      variant="secondary"
      {...props}
      className="absolute bottom-full left-1/2 z-30 mb-3 -translate-x-1/2 shadow-[var(--bo-popover-shadow)]"
    >
      Scroll to latest
    </Button>
  );
}

/** The state of an operation on the whole conversation, after its newest message. */
export function ChatThreadNotice({ children }: { children: ReactNode }) {
  return <div className="mb-3">{children}</div>;
}
