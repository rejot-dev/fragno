import { useEffect } from "react";

type LayoutShiftEntry = PerformanceEntry & {
  value: number;
  hadRecentInput: boolean;
  sources?: Array<{
    node?: Node;
    currentRect: DOMRectReadOnly;
    previousRect: DOMRectReadOnly;
  }>;
};

export function BackofficeClsDebugger() {
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    if (import.meta.env.MODE !== "development") {
      return;
    }
    if (!("PerformanceObserver" in window)) {
      return;
    }

    let total = 0;
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const shift = entry as LayoutShiftEntry;
        if (shift.hadRecentInput) {
          continue;
        }

        total += shift.value;
        console.groupCollapsed(
          `[backoffice] layout shift +${shift.value.toFixed(4)} (total ${total.toFixed(4)})`,
        );
        if (shift.sources?.length) {
          const rows = shift.sources.map((source) => {
            const node = source.node;
            let label = "";
            if (node && "tagName" in node) {
              const el = node as HTMLElement;
              label = el.tagName.toLowerCase();
              if (el.id) {
                label += `#${el.id}`;
              }
              if (typeof el.className === "string" && el.className.trim()) {
                const cls = el.className.trim().split(/\s+/).slice(0, 3).join(".");
                label += `.${cls}`;
              }
            } else if (node) {
              label = String(node);
            }

            return {
              node: label || "unknown",
              currentRect: source.currentRect,
              previousRect: source.previousRect,
            };
          });

          console.table(rows);
        }
        console.groupEnd();
      }
    });

    observer.observe({ type: "layout-shift", buffered: true });

    return () => observer.disconnect();
  }, []);

  return null;
}
