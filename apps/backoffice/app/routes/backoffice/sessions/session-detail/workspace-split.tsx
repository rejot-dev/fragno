import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";

const DEFAULT_THREAD_WIDTH = 54;
const MIN_THREAD_WIDTH = 32;
const MIN_WORKSPACE_WIDTH = 34;
const RESIZE_STEP = 2;

export function SessionWorkspaceSplit({
  left,
  right,
  storageKey,
}: {
  left: ReactNode;
  right?: ReactNode | null;
  storageKey: string;
}) {
  const clampThreadWidth = useCallback(
    (width: number) => Math.min(100 - MIN_WORKSPACE_WIDTH, Math.max(MIN_THREAD_WIDTH, width)),
    [],
  );
  const [threadWidth, setThreadWidth] = useState(() =>
    readStoredThreadWidth(storageKey, clampThreadWidth),
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const hasWorkspace = right !== null && right !== undefined;

  useEffect(() => {
    window.localStorage.setItem(storageKey, String(Math.round(threadWidth)));
  }, [storageKey, threadWidth]);

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
      if (bounds.width === 0) {
        return;
      }
      setThreadWidth(clampThreadWidth(((event.clientX - bounds.left) / bounds.width) * 100));
    },
    [clampThreadWidth],
  );

  useEffect(() => {
    window.addEventListener("pointermove", resizeFromPointer);
    window.addEventListener("pointerup", stopDragging);
    return () => {
      window.removeEventListener("pointermove", resizeFromPointer);
      window.removeEventListener("pointerup", stopDragging);
      stopDragging();
    };
  }, [resizeFromPointer, stopDragging]);

  const startDragging = () => {
    draggingRef.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  const resizeFromKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    const direction = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    if (direction === 0 && event.key !== "Home" && event.key !== "End") {
      return;
    }
    event.preventDefault();
    if (event.key === "Home") {
      setThreadWidth(MIN_THREAD_WIDTH);
    } else if (event.key === "End") {
      setThreadWidth(100 - MIN_WORKSPACE_WIDTH);
    } else {
      setThreadWidth((current) => clampThreadWidth(current + direction * RESIZE_STEP));
    }
  };

  const splitStyle = {
    "--session-thread-width": `${threadWidth}%`,
  } as CSSProperties;

  return (
    <div
      ref={containerRef}
      data-session-workspace-split
      style={splitStyle}
      className="relative flex h-full min-h-0 min-w-0 flex-1 overflow-hidden"
    >
      <div
        id="session-chat-panel"
        data-session-thread-pane
        className={
          hasWorkspace
            ? "bo-session-thread-pane flex h-full min-h-0 w-full min-w-0 flex-col md:w-[var(--session-thread-width)]"
            : "bo-session-thread-pane flex h-full min-h-0 w-full min-w-0 flex-col"
        }
      >
        {left}
      </div>

      {hasWorkspace ? (
        <>
          <div
            role="separator"
            aria-label="Resize session workspace"
            aria-orientation="vertical"
            aria-valuemin={MIN_THREAD_WIDTH}
            aria-valuemax={100 - MIN_WORKSPACE_WIDTH}
            aria-valuenow={Math.round(threadWidth)}
            aria-valuetext={`Conversation ${Math.round(threadWidth)} percent, workspace ${Math.round(100 - threadWidth)} percent`}
            tabIndex={0}
            onDoubleClick={() => {
              setThreadWidth(DEFAULT_THREAD_WIDTH);
            }}
            onKeyDown={resizeFromKeyboard}
            onPointerDown={(event) => {
              event.preventDefault();
              startDragging();
            }}
            className="group relative z-30 hidden h-full w-px shrink-0 cursor-col-resize bg-[var(--bo-border-strong)] outline-none focus-visible:bg-[var(--bo-accent)] md:block"
          >
            <span className="absolute inset-y-0 -left-5 w-10 bg-transparent transition-[background-color] duration-150 group-hover:bg-[color:var(--bo-accent-bg)]/45" />
          </div>
          <div className="bo-session-workspace-drawer absolute inset-0 z-40 h-full min-h-0 min-w-0 overflow-hidden bg-[var(--bo-panel)] shadow-[var(--bo-popover-shadow)] md:static md:z-auto md:flex-1 md:shadow-none">
            {right}
          </div>
        </>
      ) : null}
    </div>
  );
}

function readStoredThreadWidth(storageKey: string, clamp: (width: number) => number): number {
  if (typeof window === "undefined") {
    return DEFAULT_THREAD_WIDTH;
  }
  const storedWidth = Number(window.localStorage.getItem(storageKey));
  return Number.isFinite(storedWidth) && storedWidth > 0
    ? clamp(storedWidth)
    : DEFAULT_THREAD_WIDTH;
}
