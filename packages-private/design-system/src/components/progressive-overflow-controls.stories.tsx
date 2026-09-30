import { useState } from "react";

import { ProgressiveOverflowControls } from "./progressive-overflow-controls";

export default { title: "Layout/Progressive overflow controls" };

// Resize with the viewport toolbar: groups collapse into the overflow slot in priority order.
export function Toolbar() {
  const [boundary, setBoundary] = useState<HTMLDivElement | null>(null);
  return (
    <div
      ref={setBoundary}
      className="flex items-center gap-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-2"
    >
      <ProgressiveOverflowControls
        measurementBoundary={boundary}
        groups={[
          {
            id: "detail",
            collapsePriority: 0,
            content: <span className="px-2 text-xs">Simple / Verbose</span>,
          },
          {
            id: "view",
            collapsePriority: 1,
            content: <span className="px-2 text-xs">Code / Graph / Both</span>,
          },
        ]}
        renderOverflow={(hidden) => (
          <span className="px-2 text-xs text-[var(--bo-muted)]">
            {hidden.size > 0 ? `More (${[...hidden].join(", ")})` : "All visible"}
          </span>
        )}
      />
    </div>
  );
}
