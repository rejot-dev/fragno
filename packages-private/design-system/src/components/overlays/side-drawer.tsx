import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { onScreenKeyboardCoversPage } from "./on-screen-keyboard";

export const SIDE_DRAWER_MIN_WIDTH = 360;
const MAX_WIDTH = 900;
const RESIZE_STEP = 24;

/** A width in pixels, or half the screen, which holds as the screen changes size. */
type DrawerWidth = number | "half";

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
 * and is remembered under `storageKey`, so a consumer can size it apart per kind of screen; each
 * new `halfScreenRequest` sets it to half the screen, until the reader resizes it. Its
 * children mount when it first opens, stay mounted while it is closed so what they hold (a live
 * connection, for example) survives reopening, and start with a `SideDrawerHeader`. While an
 * on-screen keyboard is up, it fits the screen above it, so the field being typed in stays in view;
 * while the reader types in it, it also covers the page, drops its header, and marks itself with
 * `data-typing` for what it holds to keep to what typing needs.
 */
export function SideDrawer({
  id,
  label,
  open,
  defaultWidth,
  storageKey,
  halfScreenRequest,
  children,
}: {
  id: string;
  label: string;
  open: boolean;
  defaultWidth: number;
  storageKey: string;
  /** Changes with each request for half the screen; null until the first. */
  halfScreenRequest: number | null;
  children: ReactNode;
}) {
  const [everOpened, setEverOpened] = useState(open);
  if (open && !everOpened) {
    setEverOpened(true);
  }
  const asideRef = useRef<HTMLElement>(null);
  const { width, resetWidth, startDragging, resizeFromKeyboard } = useDrawerWidth(
    defaultWidth,
    storageKey,
    halfScreenRequest,
  );
  const { keyboardFreeArea, typing, noteFocus, noteTouch } = useTypingInDrawer(open, asideRef);

  return (
    // The panel is the page background for what the drawer holds, so content painting the page
    // background (a chat thread and its scroll fades, for example) matches the drawer.
    // Closed, it hides once it has slid shut: iOS colors the strip beside a home-screen web app,
    // on an iPhone Duo on its side, after a panel at the screen's edge, and keeps a 0px-wide one's.
    <aside
      ref={asideRef}
      onFocus={(event) => {
        noteFocus(event.target);
      }}
      onTouchStart={noteTouch}
      id={id}
      aria-label={label}
      aria-hidden={!open}
      inert={!open}
      style={
        {
          // Half as a viewport unit, so it stays exact while the screen resizes, as Safari does in
          // steps when a phone unfolds.
          "--side-drawer-width": width === "half" ? "50vw" : `${width}px`,
          ...(keyboardFreeArea === null
            ? {}
            : { top: keyboardFreeArea.top, height: keyboardFreeArea.height }),
        } as CSSProperties
      }
      className={`group/drawer sticky top-0 z-40 flex h-dvh shrink-0 flex-col bg-[var(--bo-panel)] transition-[width,visibility] duration-200 ease-out [--bo-bg:var(--bo-panel)] ${typing ? "overflow-visible" : "overflow-hidden"} ${open ? "w-[min(var(--side-drawer-width),calc(100vw-2rem))] border-l border-[color:var(--bo-border)]" : "pointer-events-none invisible w-0"}`}
      data-typing={typing || undefined}
    >
      <div
        role="separator"
        aria-label={`Resize ${label.toLowerCase()}`}
        aria-orientation="vertical"
        aria-valuemin={SIDE_DRAWER_MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        aria-valuenow={width === "half" ? undefined : Math.round(width)}
        aria-valuetext={width === "half" ? "Half the screen" : undefined}
        tabIndex={open ? 0 : -1}
        onDoubleClick={resetWidth}
        onKeyDown={resizeFromKeyboard}
        onPointerDown={(event) => {
          event.preventDefault();
          startDragging();
        }}
        className="absolute inset-y-0 left-0 z-10 hidden w-px -translate-x-px cursor-col-resize touch-none bg-[var(--bo-border-strong)] transition-colors duration-150 outline-none group-data-typing/drawer:hidden! hover:bg-[color-mix(in_srgb,var(--bo-border-strong),var(--bo-fg)_20%)] focus-visible:bg-[color-mix(in_srgb,var(--bo-border-strong),var(--bo-fg)_20%)] active:bg-[color-mix(in_srgb,var(--bo-border-strong),var(--bo-fg)_20%)] sm:block"
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
        // which would flood resize observers in it (a chat thread's). While typing, it covers the
        // page too, revealed leftwards from the drawer's edge; it reflows once.
        <div
          hidden={!open}
          className={
            typing
              ? "bo-drawer-typing-reveal absolute inset-y-0 right-0 flex w-[calc(100vw-env(safe-area-inset-left)-env(safe-area-inset-right))] flex-col bg-[var(--bo-panel)]"
              : "flex min-h-0 w-[min(var(--side-drawer-width),calc(100vw-2rem))] flex-1 shrink-0 flex-col self-end"
          }
        >
          {children}
        </div>
      ) : null}
    </aside>
  );
}

/**
 * The drawer's width: `defaultWidth` on the server, then what was remembered under `storageKey`,
 * kept again as the reader resizes it by dragging its edge or with the keyboard; half the screen
 * from each new `halfScreenRequest`.
 */
function useDrawerWidth(
  defaultWidth: number,
  storageKey: string,
  halfScreenRequest: number | null,
) {
  const [width, setWidth] = useState<DrawerWidth>(defaultWidth);
  const [seenHalfScreenRequest, setSeenHalfScreenRequest] = useState(halfScreenRequest);
  if (halfScreenRequest !== seenHalfScreenRequest) {
    setSeenHalfScreenRequest(halfScreenRequest);
    setWidth("half");
  }
  // Restored once mounted, so the server and the first client render agree, and again when the
  // key changes; saved on every change after that.
  const restoredKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (restoredKeyRef.current !== storageKey) {
      restoredKeyRef.current = storageKey;
      const stored = readStoredWidth(storageKey);
      setWidth(stored === null ? defaultWidth : stored === "half" ? stored : clampWidth(stored));
      return;
    }
    try {
      window.localStorage.setItem(storageKey, width === "half" ? width : String(Math.round(width)));
    } catch {
      // Drawer sizing persistence is optional when storage is unavailable.
    }
  }, [defaultWidth, storageKey, width]);

  const draggingRef = useRef(false);
  const stopDragging = useCallback(() => {
    if (!draggingRef.current) {
      return;
    }
    draggingRef.current = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }, []);
  useEffect(() => {
    const resizeFromPointer = (event: PointerEvent) => {
      if (draggingRef.current) {
        setWidth(clampWidth(window.innerWidth - event.clientX));
      }
    };
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
  }, [stopDragging]);
  const startDragging = () => {
    draggingRef.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

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
      setWidth((current) => clampWidth(widthInPixels(current) + direction * RESIZE_STEP));
    }
  };

  const resetWidth = () => {
    setWidth(defaultWidth);
  };

  return { width, resetWidth, startDragging, resizeFromKeyboard };
}

/**
 * While the reader types in the drawer above an on-screen keyboard: the area the keyboard leaves,
 * which the drawer fits, and whether the reader is typing in the drawer, which covers the page and
 * drops its header (`data-typing`). Typing lasts until the keyboard has gone, not until the field
 * loses the focus: a tap on Send takes the focus before its click lands, and a layout changing in
 * between would move the button. `noteFocus` and `noteTouch` take the drawer's focus and touch
 * events.
 */
function useTypingInDrawer(open: boolean, asideRef: RefObject<HTMLElement | null>) {
  const keyboardFreeArea = useKeyboardFreeArea();
  // Whether the reader last focused something in the drawer, so a keyboard up now is theirs.
  const [focusedHere, setFocusedHere] = useState(false);
  useEffect(() => {
    const noteFocusAnywhere = (event: FocusEvent) => {
      const aside = asideRef.current;
      setFocusedHere(
        aside !== null && event.target instanceof Node && aside.contains(event.target),
      );
    };
    document.addEventListener("focusin", noteFocusAnywhere);
    return () => {
      document.removeEventListener("focusin", noteFocusAnywhere);
    };
  }, [asideRef]);
  // Where the page was scrolled when a field in the drawer was focused, before the keyboard rose.
  const pageScrollBeforeKeyboardRef = useRef<number | null>(null);
  // The drawer's scroll areas around that field that were at their end then, such as a
  // conversation at its latest message, which keep to it through the typing layout until the
  // reader touches the drawer.
  const scrollAreasAtEndRef = useRef<readonly HTMLElement[]>([]);
  // Safari brings a field into view when it is focused, before the keyboard rises and the drawer
  // shrinks above it, which can leave the field below what the drawer still shows. Safari also
  // scrolls the page for it, in steps as the keyboard rises, which the drawer does not need, so
  // the page returns to where it was each time until the keyboard has gone.
  useLayoutEffect(() => {
    const aside = asideRef.current;
    if (keyboardFreeArea === null) {
      pageScrollBeforeKeyboardRef.current = null;
      scrollAreasAtEndRef.current = [];
      return;
    }
    const focused = document.activeElement;
    if (aside === null || !(focused instanceof HTMLElement) || !aside.contains(focused)) {
      return;
    }
    revealWithin(focused, aside);
    for (const scroller of scrollAreasAtEndRef.current) {
      if (!isScrolledToEnd(scroller)) {
        // Instant, as a scroll area may scroll smoothly by default (a chat thread does).
        scroller.scrollTo({ top: scroller.scrollHeight, behavior: "instant" });
      }
    }
    const pageScroll = pageScrollBeforeKeyboardRef.current;
    if (pageScroll !== null && window.scrollY !== pageScroll) {
      window.scrollTo({ top: pageScroll });
    }
  }, [asideRef, keyboardFreeArea]);

  const noteFocus = (target: Element) => {
    const aside = asideRef.current;
    if (keyboardFreeArea === null && aside !== null) {
      pageScrollBeforeKeyboardRef.current = window.scrollY;
      scrollAreasAtEndRef.current = scrollAreasBetween(target, aside).filter(isScrolledToEnd);
    }
  };
  const noteTouch = () => {
    scrollAreasAtEndRef.current = [];
  };

  return {
    keyboardFreeArea,
    typing: open && keyboardFreeArea !== null && focusedHere,
    noteFocus,
    noteTouch,
  };
}

/**
 * The drawer's toolbar, level with the Backoffice top bar, or its phone header on wide phones.
 * Hidden while the reader types in the drawer, for the conversation's room above the keyboard.
 */
export function SideDrawerHeader({ children }: { children: ReactNode }) {
  return (
    // Matches the Backoffice shell's header: its background, and its height, which the shell keeps
    // in --bo-shell-top; outside the shell, the top bar's 64px of content plus its 1px bottom border.
    <header className="flex h-[var(--bo-shell-top,calc(--spacing(16)+1px))] shrink-0 items-center gap-1 border-b border-[color:var(--bo-border)] bg-[color:var(--bo-top-bar-bg)] px-3 pt-[env(safe-area-inset-top)] group-data-typing/drawer:hidden">
      {children}
    </header>
  );
}

/**
 * Scrolls the scroll areas between `element` and `boundary` until `element` shows in them, without
 * scrolling the page, which Safari already scrolled for the keyboard. Prefers the top of an element
 * taller than the area.
 */
function revealWithin(element: HTMLElement, boundary: HTMLElement) {
  for (const scroller of scrollAreasBetween(element, boundary)) {
    const area = scroller.getBoundingClientRect();
    const target = element.getBoundingClientRect();
    if (target.bottom > area.bottom) {
      scroller.scrollTop += target.bottom - area.bottom;
    }
    const shifted = element.getBoundingClientRect();
    if (shifted.top < area.top) {
      scroller.scrollTop -= area.top - shifted.top;
    }
  }
}

/** The scroll areas holding `element` inside `boundary`, innermost first. */
function scrollAreasBetween(element: Element, boundary: HTMLElement): HTMLElement[] {
  const scrollers: HTMLElement[] = [];
  if (!boundary.contains(element)) {
    return scrollers;
  }
  for (
    let scroller = element.parentElement;
    scroller !== null && scroller !== boundary;
    scroller = scroller.parentElement
  ) {
    const { overflowY } = getComputedStyle(scroller);
    if (overflowY === "auto" || overflowY === "scroll") {
      scrollers.push(scroller);
    }
  }
  return scrollers;
}

function isScrolledToEnd(scroller: HTMLElement): boolean {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 1;
}

function clampWidth(value: number): number {
  return Math.min(
    Math.min(MAX_WIDTH, window.innerWidth - 32),
    Math.max(SIDE_DRAWER_MIN_WIDTH, value),
  );
}

function widthInPixels(width: DrawerWidth): number {
  return width === "half" ? window.innerWidth / 2 : width;
}

function readStoredWidth(storageKey: string): DrawerWidth | null {
  try {
    const item = window.localStorage.getItem(storageKey);
    if (item === "half") {
      return item;
    }
    const stored = Number(item);
    return Number.isFinite(stored) && stored > 0 ? stored : null;
  } catch {
    return null;
  }
}
