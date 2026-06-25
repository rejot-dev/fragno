/*
 * A two-column horizontal split with a draggable divider. The left column's
 * width is a percentage the user can drag, clamped so neither side collapses,
 * and persisted under `storageKey` so the ratio survives reloads.
 *
 * Deliberately minimal — pointer-driven, no dependency — so it can sit anywhere
 * a conversation needs a resizable companion panel beside it.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

export function ResizableSplit({
  left,
  right,
  storageKey,
  defaultLeftPct = 42,
  minLeftPct = 24,
  minRightPct = 32,
  className,
}: {
  left: ReactNode;
  /** The companion pane. When null/absent, `left` fills the width (no divider) —
   * and crucially stays mounted, so toggling the panel never remounts it. */
  right?: ReactNode | null;
  /** Persist the divider position across reloads under this localStorage key. */
  storageKey?: string;
  defaultLeftPct?: number;
  minLeftPct?: number;
  minRightPct?: number;
  className?: string;
}) {
  const clamp = useCallback(
    (n: number) => Math.min(100 - minRightPct, Math.max(minLeftPct, n)),
    [minLeftPct, minRightPct],
  );

  const [leftPct, setLeftPct] = useState<number>(() => {
    if (typeof window !== "undefined" && storageKey) {
      const saved = Number(window.localStorage.getItem(storageKey));
      if (!Number.isNaN(saved) && saved > 0) {
        return clamp(saved);
      }
    }
    return defaultLeftPct;
  });

  const containerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  const onPointerMove = useCallback(
    (event: PointerEvent) => {
      if (!draggingRef.current || !containerRef.current) {
        return;
      }
      const rect = containerRef.current.getBoundingClientRect();
      if (rect.width === 0) {
        return;
      }
      setLeftPct(clamp(((event.clientX - rect.left) / rect.width) * 100));
    },
    [clamp],
  );

  const stop = useCallback(() => {
    if (!draggingRef.current) {
      return;
    }
    draggingRef.current = false;
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
  }, []);

  useEffect(() => {
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stop);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", stop);
    };
  }, [onPointerMove, stop]);

  useEffect(() => {
    if (storageKey) {
      window.localStorage.setItem(storageKey, String(Math.round(leftPct)));
    }
  }, [leftPct, storageKey]);

  const start = () => {
    draggingRef.current = true;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
  };

  const hasRight = right !== null && right !== undefined;

  return (
    <div ref={containerRef} className={cn("flex h-full min-h-0 w-full", className)}>
      {/* `left` is always the first child in the same position, so toggling the
          right pane never remounts it (preserving its state, scroll, effects). */}
      <div className="h-full min-h-0 min-w-0" style={{ width: hasRight ? `${leftPct}%` : "100%" }}>
        {left}
      </div>
      {hasRight ? (
        <>
          <div
            role="separator"
            aria-orientation="vertical"
            onPointerDown={start}
            className="group relative w-px shrink-0 cursor-col-resize bg-[color:var(--cad-line)]"
          >
            {/* A wider invisible hit area around the 1px line. */}
            <div className="absolute inset-y-0 -right-1.5 -left-1.5 transition-colors group-hover:bg-[var(--cad-brass-bg)]" />
          </div>
          <div className="h-full min-h-0 min-w-0 flex-1">{right}</div>
        </>
      ) : null}
    </div>
  );
}
