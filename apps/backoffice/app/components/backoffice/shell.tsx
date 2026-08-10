import { useState, type ReactNode } from "react";

import type { AuthMeData } from "@/fragno/auth/auth-client";

import { BackofficeClsDebugger } from "./cls-debugger";
import { CurrentBackofficeProvider, type CurrentBackofficeContext } from "./current-context";
import { GlobalHotkeysProvider, useGlobalHotkey } from "./global-hotkeys";
import { GlobalWorkflowDrawer } from "./global-workflow-drawer";
import { BackofficeTopBar } from "./top-bar";

type BackofficeShellProps = {
  children: ReactNode;
  me: AuthMeData | null;
  currentContext: CurrentBackofficeContext | null;
  isLoading?: boolean;
};

export function BackofficeShell(props: BackofficeShellProps) {
  const shell = (
    <GlobalHotkeysProvider>
      <BackofficeShellFrame {...props} />
    </GlobalHotkeysProvider>
  );
  return props.currentContext ? (
    <CurrentBackofficeProvider value={props.currentContext}>{shell}</CurrentBackofficeProvider>
  ) : (
    shell
  );
}

function BackofficeShellFrame({ children, me, currentContext, isLoading }: BackofficeShellProps) {
  const [workflowDrawerOpen, setWorkflowDrawerOpen] = useState(false);
  useGlobalHotkey({
    id: "toggle-recent-workflows",
    key: "i",
    modifiers: { primary: true },
    handler() {
      setWorkflowDrawerOpen((open) => !open);
    },
  });

  return (
    <div
      data-backoffice-root
      className="relative isolate flex min-h-screen bg-[var(--bo-bg)] text-[var(--bo-fg)]"
    >
      <BackofficeClsDebugger />
      <div className="relative min-w-0 flex-1">
        <div className="bo-grid-backdrop pointer-events-none absolute inset-0" />
        <BackofficeTopBar
          me={me}
          isLoading={isLoading}
          workflowDrawerOpen={workflowDrawerOpen}
          onWorkflowDrawerToggle={() => {
            setWorkflowDrawerOpen((open) => !open);
          }}
        />
        <main className="relative z-10 min-w-0 px-2 py-2 sm:px-3 sm:py-3 lg:px-4 lg:py-4">
          <div className="min-w-0">{children}</div>
        </main>
      </div>
      <GlobalWorkflowDrawer
        open={workflowDrawerOpen}
        sourceState={currentContext?.automationCollectionSource ?? null}
        onClose={() => {
          setWorkflowDrawerOpen(false);
        }}
      />
    </div>
  );
}
