import { useCallback, useRef, useState } from "react";

import type { FragnoBrowserPersistenceDiagnostics } from "@fragno-dev/tanstack-db-adapter";

import {
  getAutomationBrowserPersistenceDiagnostics,
  subscribeAutomationBrowserPersistenceDiagnostics,
} from "@/fragno/automation/tanstack/browser-database";

/** Shows live browser persistence startup diagnostics inside the development loading state. */
export function AutomationBrowserPersistenceDiagnosticPanel({
  resourceKey,
}: {
  resourceKey: string;
}) {
  const [diagnostics, setDiagnostics] = useState<FragnoBrowserPersistenceDiagnostics | null>(() =>
    getAutomationBrowserPersistenceDiagnostics(resourceKey),
  );
  const unsubscribeRef = useRef<() => void>(() => {});
  const subscribeRef = useCallback(
    (element: HTMLDivElement | null) => {
      unsubscribeRef.current();
      unsubscribeRef.current = () => {};
      if (!element) {
        return;
      }

      function readLatestDiagnostics() {
        setDiagnostics(getAutomationBrowserPersistenceDiagnostics(resourceKey));
      }

      // Worker scheduling stalls can coincide with delayed React subscription effects. A callback
      // ref registers during commit so startup diagnostics cannot be missed before effects run.
      unsubscribeRef.current = subscribeAutomationBrowserPersistenceDiagnostics(
        resourceKey,
        readLatestDiagnostics,
      );
      readLatestDiagnostics();
    },
    [resourceKey],
  );

  return (
    <div ref={subscribeRef}>
      {diagnostics ? (
        <details
          open
          className="mt-3 max-w-4xl border border-amber-500/30 bg-amber-500/6 text-left"
        >
          <summary className="cursor-pointer px-3 py-2 font-mono text-[10px] font-semibold tracking-[0.16em] text-amber-700 uppercase dark:text-amber-200">
            Browser persistence diagnostics · {Math.round(diagnostics.elapsedMs / 1_000)}s
          </summary>
          <div className="border-t border-amber-500/20 p-3">
            <p className="max-w-3xl text-xs text-amber-800 dark:text-amber-100">
              {diagnostics.likelyCause}
            </p>
            <pre className="mt-3 max-h-80 overflow-auto bg-[var(--bo-panel-2)] p-3 font-mono text-[10px] leading-relaxed text-[var(--bo-muted)] shadow-[inset_0_0_0_1px_var(--bo-border)]">
              {JSON.stringify(diagnostics, null, 2)}
            </pre>
          </div>
        </details>
      ) : null}
    </div>
  );
}
