import { useCallback, useEffect, useRef, useState } from "react";

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
      return;
    }
    viewport.scrollTo({ top: viewport.scrollHeight, behavior });
  }, []);

  const jumpToLatest = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      shouldForceScrollRef.current = true;
      setPinnedToBottom(true);
      scrollToBottom(behavior);
    },
    [scrollToBottom],
  );

  useEffect(() => {
    jumpToLatest("auto");
  }, [jumpToLatest, sessionId]);

  useEffect(() => {
    if (!pinnedToBottom && !shouldForceScrollRef.current) {
      return;
    }

    const frame = requestAnimationFrame(() => {
      scrollToBottom(shouldForceScrollRef.current ? "auto" : "smooth");
      shouldForceScrollRef.current = false;
    });

    return () => cancelAnimationFrame(frame);
  }, [contentVersion, pinnedToBottom, scrollToBottom]);

  return {
    jumpToLatest,
    onScroll: updatePinnedToBottom,
    pinnedToBottom,
    showJumpToLatest: !pinnedToBottom,
    viewportRef,
  };
}
