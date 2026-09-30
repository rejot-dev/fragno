import { useState } from "react";

import { VerticalResizeHandle } from "./vertical-resize-handle";

export default { title: "Layout/Vertical resize handle" };

// The handle only reports input; the story owns the width like a real split view does.
export function SplitView() {
  const [width, setWidth] = useState(320);
  const clamp = (next: number) => Math.min(560, Math.max(200, next));

  return (
    <div className="flex h-64 border border-[color:var(--bo-border)]">
      <div style={{ width }} className="bg-[var(--bo-panel)] p-3 text-xs">
        Left pane: {width}px
      </div>
      <VerticalResizeHandle
        label="Resize panes"
        min={200}
        max={560}
        value={width}
        valueText={`${width} pixels`}
        visibleFrom="md"
        onDoubleClick={() => {
          setWidth(320);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") {
            setWidth((current) => clamp(current - 16));
          }
          if (event.key === "ArrowRight") {
            setWidth((current) => clamp(current + 16));
          }
        }}
        onPointerDown={(event) => {
          const startX = event.clientX;
          const startWidth = width;
          const onMove = (move: PointerEvent) => {
            setWidth(clamp(startWidth + move.clientX - startX));
          };
          const onUp = () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
          };
          window.addEventListener("pointermove", onMove);
          window.addEventListener("pointerup", onUp);
        }}
      />
      <div className="flex-1 bg-[var(--bo-panel-2)] p-3 text-xs">Right pane</div>
    </div>
  );
}
