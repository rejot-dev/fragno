import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

const SCROLL_BOTTOM_THRESHOLD = 96;

const isNearBottom = (element: HTMLDivElement) =>
  element.scrollHeight - element.scrollTop - element.clientHeight <= SCROLL_BOTTOM_THRESHOLD;

export function useChatScroll({
  sessionId,
  contentVersion,
}: {
  sessionId: string;
  contentVersion: string | number;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const shouldForceScrollRef = useRef(true);
  const [pinnedToBottom, setPinnedToBottom] = useState(true);

  const updatePinnedToBottom = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    setPinnedToBottom(isNearBottom(viewport));
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return false;
    }

    viewport.scrollTop = viewport.scrollHeight;
    viewport.scrollTo({ top: viewport.scrollHeight, behavior });
    setPinnedToBottom(true);
    return true;
  }, []);

  const scheduleScrollToBottom = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      let trailingFrameId: number | null = null;
      const timeoutId = window.setTimeout(() => {
        scrollToBottom(behavior);
      }, 0);
      const frameId = requestAnimationFrame(() => {
        scrollToBottom(behavior);
      });
      const delayedFrameId = requestAnimationFrame(() => {
        trailingFrameId = requestAnimationFrame(() => {
          scrollToBottom(behavior);
        });
      });

      return () => {
        window.clearTimeout(timeoutId);
        cancelAnimationFrame(frameId);
        cancelAnimationFrame(delayedFrameId);
        if (trailingFrameId !== null) {
          cancelAnimationFrame(trailingFrameId);
        }
      };
    },
    [scrollToBottom],
  );

  const jumpToLatest = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      shouldForceScrollRef.current = true;
      setPinnedToBottom(true);
      scrollToBottom(behavior);
    },
    [scrollToBottom],
  );

  useEffect(() => {
    shouldForceScrollRef.current = true;
    const cleanup = scheduleScrollToBottom("auto");
    return cleanup;
  }, [scheduleScrollToBottom, sessionId]);

  useLayoutEffect(() => {
    if (!pinnedToBottom && !shouldForceScrollRef.current) {
      return;
    }

    const behavior = shouldForceScrollRef.current ? "auto" : "smooth";
    const cleanup = scheduleScrollToBottom(behavior);
    shouldForceScrollRef.current = false;
    return cleanup;
  }, [contentVersion, pinnedToBottom, scheduleScrollToBottom]);

  useEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content || typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(() => {
      if (!isNearBottom(viewport) && !shouldForceScrollRef.current) {
        return;
      }
      scrollToBottom(shouldForceScrollRef.current ? "auto" : "smooth");
      shouldForceScrollRef.current = false;
    });

    observer.observe(content);
    return () => observer.disconnect();
  }, [contentVersion, scrollToBottom]);

  return {
    contentRef,
    jumpToLatest,
    onScroll: updatePinnedToBottom,
    pinnedToBottom,
    showJumpToLatest: !pinnedToBottom,
    viewportRef,
  };
}
