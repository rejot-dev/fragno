import {
  useCallback,
  useEffect,
  useRef,
  type KeyboardEventHandler,
  type PointerEventHandler,
  type RefObject,
  type TouchEventHandler,
  type UIEventHandler,
  type WheelEventHandler,
} from "react";

type LinkedScrollPane = "code" | "graph";

type ScrollViewport = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

export type LinkedScrollViewport = {
  ref: RefObject<HTMLDivElement | null>;
  onScroll: UIEventHandler<HTMLDivElement>;
  onWheelCapture: WheelEventHandler<HTMLDivElement>;
  onPointerDownCapture: PointerEventHandler<HTMLDivElement>;
  onTouchStartCapture: TouchEventHandler<HTMLDivElement>;
  onKeyDownCapture: KeyboardEventHandler<HTMLDivElement>;
};

export function proportionalScrollTop(
  source: ScrollViewport,
  target: Pick<ScrollViewport, "scrollHeight" | "clientHeight">,
): number {
  const sourceScrollableHeight = source.scrollHeight - source.clientHeight;
  const targetScrollableHeight = target.scrollHeight - target.clientHeight;
  if (sourceScrollableHeight <= 0 || targetScrollableHeight <= 0) {
    return 0;
  }

  const progress = Math.min(1, Math.max(0, source.scrollTop / sourceScrollableHeight));
  return progress * targetScrollableHeight;
}

export function useLinkedScrollViewports(enabled: boolean): {
  codeViewport: LinkedScrollViewport;
  graphViewport: LinkedScrollViewport;
  suspendCodeScrollLink: () => void;
} {
  const codeRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<HTMLDivElement>(null);
  const programmaticPaneRef = useRef<LinkedScrollPane | undefined>(undefined);
  const suspendedPaneRef = useRef<LinkedScrollPane | undefined>(undefined);
  const releaseProgrammaticScrollRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const releaseSuspendedScrollRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const clearProgrammaticScroll = useCallback(() => {
    clearTimeout(releaseProgrammaticScrollRef.current);
    programmaticPaneRef.current = undefined;
  }, []);

  const claimUserScroll = useCallback(
    (pane: LinkedScrollPane) => {
      clearProgrammaticScroll();
      if (suspendedPaneRef.current === pane) {
        clearTimeout(releaseSuspendedScrollRef.current);
        suspendedPaneRef.current = undefined;
      }
    },
    [clearProgrammaticScroll],
  );

  const synchronizeFrom = useCallback(
    (pane: LinkedScrollPane) => {
      if (!enabled || programmaticPaneRef.current === pane || suspendedPaneRef.current === pane) {
        return;
      }

      const source = pane === "code" ? codeRef.current : graphRef.current;
      const target = pane === "code" ? graphRef.current : codeRef.current;
      if (!source || !target) {
        return;
      }

      const targetPane = pane === "code" ? "graph" : "code";
      const nextScrollTop = proportionalScrollTop(source, target);
      if (Math.abs(target.scrollTop - nextScrollTop) < 1) {
        return;
      }

      clearProgrammaticScroll();
      programmaticPaneRef.current = targetPane;
      target.scrollTop = nextScrollTop;
      releaseProgrammaticScrollRef.current = setTimeout(() => {
        if (programmaticPaneRef.current === targetPane) {
          programmaticPaneRef.current = undefined;
        }
      }, 50);
    },
    [clearProgrammaticScroll, enabled],
  );

  const suspendCodeScrollLink = useCallback(() => {
    clearTimeout(releaseSuspendedScrollRef.current);
    suspendedPaneRef.current = "code";
    releaseSuspendedScrollRef.current = setTimeout(() => {
      if (suspendedPaneRef.current === "code") {
        suspendedPaneRef.current = undefined;
      }
    }, 750);
  }, []);

  useEffect(
    () => () => {
      clearTimeout(releaseProgrammaticScrollRef.current);
      clearTimeout(releaseSuspendedScrollRef.current);
    },
    [],
  );

  const codeViewport: LinkedScrollViewport = {
    ref: codeRef,
    onScroll: () => {
      synchronizeFrom("code");
    },
    onWheelCapture: () => {
      claimUserScroll("code");
    },
    onPointerDownCapture: () => {
      claimUserScroll("code");
    },
    onTouchStartCapture: () => {
      claimUserScroll("code");
    },
    onKeyDownCapture: () => {
      claimUserScroll("code");
    },
  };
  const graphViewport: LinkedScrollViewport = {
    ref: graphRef,
    onScroll: () => {
      synchronizeFrom("graph");
    },
    onWheelCapture: () => {
      claimUserScroll("graph");
    },
    onPointerDownCapture: () => {
      claimUserScroll("graph");
    },
    onTouchStartCapture: () => {
      claimUserScroll("graph");
    },
    onKeyDownCapture: () => {
      claimUserScroll("graph");
    },
  };

  return { codeViewport, graphViewport, suspendCodeScrollLink };
}
