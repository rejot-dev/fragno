import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { onScreenKeyboardCoversPage } from "./on-screen-keyboard";

export const SIDE_DRAWER_MIN_WIDTH = 360;
const MAX_WIDTH = 900;
const RESIZE_STEP = 24;

type VisibleArea = { top: number; height: number };

/**
 * The part of the screen the page shows, while an on-screen keyboard covers the rest: Safari does not
 * shrink the page for it, and scrolls the page to keep the focused field in view instead. Null while
 * no keyboard covers the page.
 */
function useKeyboardFreeArea(): VisibleArea | null {
  const [area, setArea] = useState<VisibleArea | null>(null);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (viewport === null) {
      return undefined;
    }
    const update = () => {
      const covered = onScreenKeyboardCoversPage(viewport);
      setArea((current) => {
        if (!covered) {
          return null;
        }
        return current?.top === viewport.offsetTop && current.height === viewport.height
          ? current
          : { top: viewport.offsetTop, height: viewport.height };
      });
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, []);
  return area;
}

/**
 * A full-height panel on the right edge of the shell that pushes the page aside. The reader
 * resizes it from its left edge, with a grip on touch screens. The width starts at `defaultWidth`
 * and is remembered under `storageKey`, so a consumer can size it apart per kind of screen. Its
 * children mount when it first opens, stay mounted while it is closed so what they hold (a live
 * connection, for example) survives reopening, and start with a `SideDrawerHeader`. While an
 * on-screen keyboard is up, it fits the screen above it, so its header and what it holds stay in
 * view.
 */
export function SideDrawer({
  id,
  label,
  open,
  defaultWidth,
  storageKey,
  children,
}: {
  id: string;
  label: string;
  open: boolean;
  defaultWidth: number;
  storageKey: string;
  children: ReactNode;
}) {
  // The server renders the default; the stored width is restored once mounted, and again when the
  // key changes.
  const [width, setWidth] = useState(defaultWidth);
  const restoredKeyRef = useRef<string | null>(null);
  const [everOpened, setEverOpened] = useState(open);
  const keyboardFreeArea = useKeyboardFreeArea();
  if (open && !everOpened) {
    setEverOpened(true);
  }
  const draggingRef = useRef(false);
  const clampWidth = useCallback(
    (value: number) =>
      Math.min(Math.min(MAX_WIDTH, window.innerWidth - 32), Math.max(SIDE_DRAWER_MIN_WIDTH, value)),
    [],
  );

  useEffect(() => {
    if (restoredKeyRef.current !== storageKey) {
      restoredKeyRef.current = storageKey;
      const stored = readStoredWidth(storageKey);
      setWidth(stored === null ? defaultWidth : clampWidth(stored));
      return;
    }
    try {
      window.localStorage.setItem(storageKey, String(Math.round(width)));
    } catch {
      // Drawer sizing persistence is optional when storage is unavailable.
    }
  }, [clampWidth, defaultWidth, storageKey, width]);

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
      if (!draggingRef.current) {
        return;
      }
      setWidth(clampWidth(window.innerWidth - event.clientX));
    },
    [clampWidth],
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
    const direction = event.key === "ArrowLeft" ? 1 : event.key === "ArrowRight" ? -1 : 0;
    if (direction === 0 && event.key !== "Home" && event.key !== "End") {
      return;
    }
    event.preventDefault();
    if (event.key === "Home") {
      setWidth(SIDE_DRAWER_MIN_WIDTH);
    } else if (event.key === "End") {
      setWidth(clampWidth(MAX_WIDTH));
    } else {
      setWidth((current) => clampWidth(current + direction * RESIZE_STEP));
    }
  };

  return (
    // The panel is the page background for what the drawer holds, so content painting the page
    // background (a chat thread and its scroll fades, for example) matches the drawer.
    <aside
      id={id}
      aria-label={label}
      aria-hidden={!open}
      inert={!open}
      style={
        {
          "--side-drawer-width": `${width}px`,
          ...(keyboardFreeArea === null
            ? {}
            : { top: keyboardFreeArea.top, height: keyboardFreeArea.height }),
        } as CSSProperties
      }
      className={`sticky top-0 z-40 flex h-dvh shrink-0 flex-col overflow-hidden bg-[var(--bo-panel)] transition-[width] duration-200 ease-out [--bo-bg:var(--bo-panel)] ${open ? "w-[min(var(--side-drawer-width),calc(100vw-2rem))] border-l border-[color:var(--bo-border)]" : "pointer-events-none w-0"}`}
    >
      <div
        role="separator"
        aria-label={`Resize ${label.toLowerCase()}`}
        aria-orientation="vertical"
        aria-valuemin={SIDE_DRAWER_MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        aria-valuenow={Math.round(width)}
        tabIndex={open ? 0 : -1}
        onDoubleClick={() => {
          setWidth(defaultWidth);
        }}
        onKeyDown={resizeFromKeyboard}
        onPointerDown={(event) => {
          event.preventDefault();
          draggingRef.current = true;
          document.body.style.cursor = "col-resize";
          document.body.style.userSelect = "none";
        }}
        className="absolute inset-y-0 left-0 z-10 hidden w-px -translate-x-px cursor-col-resize touch-none bg-[var(--bo-border-strong)] transition-colors duration-150 outline-none hover:bg-[color-mix(in_srgb,var(--bo-border-strong),var(--bo-fg)_20%)] focus-visible:bg-[color-mix(in_srgb,var(--bo-border-strong),var(--bo-fg)_20%)] active:bg-[color-mix(in_srgb,var(--bo-border-strong),var(--bo-fg)_20%)] sm:block"
      >
        {/* A wider, invisible grab area; only the line itself darkens. */}
        <span className="absolute inset-y-0 -left-2 w-4" />
        {/* A finger needs more than the line, and to see where to hold: a grip inside the edge,
            since the drawer clips what lies outside it. */}
        <span className="absolute top-1/2 left-0 hidden h-16 w-6 -translate-y-1/2 pointer-coarse:block">
          <span className="absolute top-1/2 left-1 h-10 w-1.5 -translate-y-1/2 rounded-full bg-[var(--bo-border-strong)]" />
        </span>
      </div>

      {everOpened ? (
        // Hidden rather than unmounted. Laid out at the drawer's full width and pinned to its right
        // edge, so widening the drawer reveals the content instead of reflowing it every frame,
        // which would flood resize observers in it (a chat thread's).
        <div
          hidden={!open}
          className="flex min-h-0 w-[min(var(--side-drawer-width),calc(100vw-2rem))] flex-1 shrink-0 flex-col self-end"
        >
          {children}
        </div>
      ) : null}
    </aside>
  );
}

/** The drawer's toolbar, level with the Backoffice top bar, or its phone header on wide phones. */
export function SideDrawerHeader({ children }: { children: ReactNode }) {
  return (
    // Matches the Backoffice shell's header: its background, and its height, which the shell keeps
    // in --bo-shell-top; outside the shell, the top bar's 64px of content plus its 1px bottom border.
    <header className="flex h-[var(--bo-shell-top,calc(--spacing(16)+1px))] shrink-0 items-center gap-1 border-b border-[color:var(--bo-border)] bg-[color:var(--bo-top-bar-bg)] px-3 pt-[env(safe-area-inset-top)]">
      {children}
    </header>
  );
}

function readStoredWidth(storageKey: string): number | null {
  try {
    const stored = Number(window.localStorage.getItem(storageKey));
    return Number.isFinite(stored) && stored > 0 ? stored : null;
  } catch {
    return null;
  }
}
