import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { SessionResizeHandle } from "./session-resize-handle";

const DEFAULT_SIDEBAR_WIDTH = 288;
const MIN_SIDEBAR_WIDTH = 224;
const MAX_SIDEBAR_WIDTH = 480;
const MIN_CONTENT_WIDTH = 420;
const RESIZE_STEP = 16;

type SessionListSplitProps = {
  children: ReactNode;
  mobileNavigation: ReactNode;
  sidebar: ReactNode;
  storageKey: string;
};

export function SessionListSplit(props: SessionListSplitProps) {
  return <StoredSessionListSplit key={props.storageKey} {...props} />;
}

function StoredSessionListSplit({
  children,
  mobileNavigation,
  sidebar,
  storageKey,
}: SessionListSplitProps) {
  const containerRef = useRef<HTMLElement>(null);
  const draggingRef = useRef(false);
  const clampSidebarWidth = useCallback((width: number) => {
    const containerWidth = containerRef.current?.getBoundingClientRect().width ?? 0;
    const availableMaximum =
      containerWidth > 0
        ? Math.min(MAX_SIDEBAR_WIDTH, containerWidth - MIN_CONTENT_WIDTH)
        : MAX_SIDEBAR_WIDTH;
    return Math.max(MIN_SIDEBAR_WIDTH, Math.min(availableMaximum, width));
  }, []);
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    readStoredSidebarWidth(storageKey, clampSidebarWidth),
  );

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, String(Math.round(sidebarWidth)));
    } catch {
      // Sidebar sizing persistence is optional when storage is unavailable.
    }
  }, [sidebarWidth, storageKey]);

  const stopDragging = useCallback(() => {
    if (!draggingRef.current) {
      return;
    }
    draggingRef.current = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }, []);

  const resizeFromPointer = useCallback(
    (event: PointerEvent) => {
      if (!draggingRef.current || !containerRef.current) {
        return;
      }
      const bounds = containerRef.current.getBoundingClientRect();
      setSidebarWidth(clampSidebarWidth(event.clientX - bounds.left));
    },
    [clampSidebarWidth],
  );

  useEffect(() => {
    window.addEventListener("pointermove", resizeFromPointer);
    window.addEventListener("pointerup", stopDragging);
    window.addEventListener("pointercancel", stopDragging);
    window.addEventListener("blur", stopDragging);
    return () => {
      window.removeEventListener("pointermove", resizeFromPointer);
      window.removeEventListener("pointerup", stopDragging);
      window.removeEventListener("pointercancel", stopDragging);
      window.removeEventListener("blur", stopDragging);
      stopDragging();
    };
  }, [resizeFromPointer, stopDragging]);

  const resizeFromKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    const direction = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    if (direction === 0 && event.key !== "Home" && event.key !== "End") {
      return;
    }
    event.preventDefault();
    if (event.key === "Home") {
      setSidebarWidth(MIN_SIDEBAR_WIDTH);
    } else if (event.key === "End") {
      setSidebarWidth(clampSidebarWidth(MAX_SIDEBAR_WIDTH));
    } else {
      setSidebarWidth((current) => clampSidebarWidth(current + direction * RESIZE_STEP));
    }
  };

  const splitStyle = {
    "--session-list-width": `${sidebarWidth}px`,
  } as CSSProperties;

  return (
    <section
      ref={containerRef}
      data-session-list-split
      style={splitStyle}
      className="bo-fragment-surface flex h-full min-h-0 flex-1 flex-col overflow-hidden border border-[color:var(--bo-border)] bg-[var(--bo-panel)] lg:flex-row"
    >
      {mobileNavigation}

      <div
        data-session-list-pane
        className="hidden h-full min-h-0 w-[var(--session-list-width)] flex-none lg:flex"
      >
        {sidebar}
      </div>

      <SessionResizeHandle
        label="Resize session list"
        min={MIN_SIDEBAR_WIDTH}
        max={MAX_SIDEBAR_WIDTH}
        value={sidebarWidth}
        valueText={`Session list ${Math.round(sidebarWidth)} pixels`}
        visibleFrom="lg"
        onDoubleClick={() => {
          setSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
        }}
        onKeyDown={resizeFromKeyboard}
        onPointerDown={(event) => {
          event.preventDefault();
          draggingRef.current = true;
          document.body.style.cursor = "col-resize";
          document.body.style.userSelect = "none";
        }}
      />

      <main
        data-session-content-pane
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--bo-panel)]"
      >
        {children}
      </main>
    </section>
  );
}

function readStoredSidebarWidth(storageKey: string, clamp: (width: number) => number): number {
  if (typeof window === "undefined") {
    return DEFAULT_SIDEBAR_WIDTH;
  }

  try {
    const storedWidth = Number(window.localStorage.getItem(storageKey));
    return Number.isFinite(storedWidth) && storedWidth > 0
      ? clamp(storedWidth)
      : DEFAULT_SIDEBAR_WIDTH;
  } catch {
    return DEFAULT_SIDEBAR_WIDTH;
  }
}
