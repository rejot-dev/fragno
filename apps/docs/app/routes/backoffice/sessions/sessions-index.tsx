import { useOutletContext, useSearchParams } from "react-router";
import type { PiSessionsOutletContext } from "./sessions";

export default function BackofficePiSessionsIndex() {
  const { createSessionPanel } = useOutletContext<PiSessionsOutletContext>();
  const [searchParams] = useSearchParams();
  const isNewSession = searchParams.get("new") === "1";

  if (isNewSession) {
    return (
      <div className="space-y-4">
        <p className="text-[10px] uppercase tracking-[0.24em] text-[var(--bo-muted-2)]">
          Session detail
        </p>
        <h3 className="text-xl font-semibold text-[var(--bo-fg)]">New session</h3>
        <p className="text-sm text-[var(--bo-muted)]">
          Configure a harness and model to start a fresh Pi agent session.
        </p>
        {createSessionPanel ?? null}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-[10px] uppercase tracking-[0.24em] text-[var(--bo-muted-2)]">
        Session detail
      </p>
      <h3 className="text-xl font-semibold text-[var(--bo-fg)]">Select a session</h3>
      <p className="text-sm text-[var(--bo-muted)]">
        Choose a session from the list or press the new session button to create one.
      </p>
    </div>
  );
}
