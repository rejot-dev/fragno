import { Link, useOutletContext, useSearchParams } from "react-router";

import type { PiSessionsOutletContext } from "./sessions";

export default function BackofficePiSessionsIndex() {
  const { basePath, createSessionPanel } = useOutletContext<PiSessionsOutletContext>();
  const [searchParams] = useSearchParams();
  const isNewSession = searchParams.get("new") === "1";

  if (isNewSession) {
    return (
      <div className="backoffice-scroll min-h-0 flex-1 overflow-y-auto pr-1">
        <div className="space-y-4 pb-1">
          <div className="flex items-center gap-2 text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
            <Link
              to={basePath}
              className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
            >
              Back
            </Link>
            <span className="h-3 w-px bg-[var(--bo-border-strong)]" />
            <span>New session</span>
          </div>
          <h3 className="text-xl font-semibold text-[var(--bo-fg)]">New session</h3>
          <p className="text-sm text-[var(--bo-muted)]">
            Configure a harness and model to start a fresh Pi agent session.
          </p>
          {createSessionPanel ?? null}
        </div>
      </div>
    );
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
