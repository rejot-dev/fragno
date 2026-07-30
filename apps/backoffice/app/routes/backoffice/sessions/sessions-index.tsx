import { useOutletContext } from "react-router";

import type { PiSessionsOutletContext } from "./session-types";

export default function BackofficePiSessionsIndex() {
  const { createSessionPanel } = useOutletContext<PiSessionsOutletContext>();
  if (createSessionPanel !== undefined && createSessionPanel !== null) {
    return createSessionPanel;
  }

  return (
    <div className="backoffice-scroll min-h-0 flex-1 overflow-y-auto pr-1">
      <div className="space-y-3 pb-1">
        <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
          Session detail
        </p>
        <h3 className="text-xl font-semibold text-[var(--bo-fg)]">Select a session</h3>
        <p className="text-sm text-[var(--bo-muted)]">
          Choose a session from the list or press the new session button to create one.
        </p>
      </div>
    </div>
  );
}
