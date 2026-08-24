import { useEffect, useState, type ReactNode } from "react";

import {
  backofficeRouteScopeFromResolvedScope,
  type BackofficeResolvedScope,
  type BackofficeScopeSelection,
} from "@/backoffice-runtime/resolved-scope";
import { scheduleBackofficeTokenRefresh } from "@/fragno/auth/browser-auth.client";
import type { BackofficeMeData } from "@/fragno/auth/contracts";

import { BackofficeClsDebugger } from "./cls-debugger";
import { CurrentBackofficeProvider } from "./current-context";
import {
  automationCollectionResolvedScope,
  type CurrentBackofficeContext,
} from "./current-context-state";
import { GlobalHotkeysProvider, useGlobalHotkey } from "./global-hotkeys";
import { GlobalWorkflowDrawer } from "./global-workflow-drawer";
import { QuakeTerminal } from "./quake-terminal";
import { BackofficeSidebarNav } from "./sidebar-nav";
import { BackofficeTopBar } from "./top-bar";

type BackofficeShellProps = {
  children: ReactNode;
  me: BackofficeMeData | null;
  accessTokenExpiresAt: string | null;
  currentContext: CurrentBackofficeContext | null;
  isLoading?: boolean;
};

type BackofficeShellResolvedScope = BackofficeResolvedScope<
  BackofficeMeData["organizations"][number]["organization"]
>;

function backofficeTerminalScopeSelection(
  scope: BackofficeShellResolvedScope,
  me: BackofficeMeData | null,
): BackofficeScopeSelection {
  switch (scope.kind) {
    case "system":
      return { ...scope, label: "System" };
    case "org":
      return { ...scope, label: scope.organization.name };
    case "project":
      return { ...scope, label: `${scope.organization.name} / ${scope.projectId}` };
    case "user":
      return {
        ...scope,
        label: me?.user.id === scope.userId ? (me.user.email ?? scope.userId) : scope.userId,
      };
  }

  scope satisfies never;
  throw new Error("Backoffice terminal scope selection received an unsupported scope kind.");
}

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

function BackofficeShellFrame({
  children,
  me,
  accessTokenExpiresAt,
  currentContext,
  isLoading,
}: BackofficeShellProps) {
  const [workflowDrawerOpen, setWorkflowDrawerOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const resolvedScope = currentContext
    ? automationCollectionResolvedScope(currentContext.automationCollectionSource)
    : null;
  const routeScope = resolvedScope ? backofficeRouteScopeFromResolvedScope(resolvedScope) : null;
  const terminalScope = resolvedScope ? backofficeTerminalScopeSelection(resolvedScope, me) : null;
  useEffect(() => {
    if (!accessTokenExpiresAt) {
      return undefined;
    }
    return scheduleBackofficeTokenRefresh(accessTokenExpiresAt, () => {
      window.location.replace("/backoffice/login");
    });
  }, [accessTokenExpiresAt]);
  useGlobalHotkey({
    id: "toggle-sidebar",
    key: "b",
    code: "KeyB",
    modifiers: { primary: true },
    handler() {
      setSidebarCollapsed((collapsed) => !collapsed);
    },
  });
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
      <div className="relative flex min-w-0 flex-1 flex-col">
        <div className="bo-grid-backdrop pointer-events-none absolute inset-0" />
        <BackofficeTopBar
          me={me}
          resolvedScope={resolvedScope}
          projectCollectionSource={currentContext?.projectCollectionSource ?? null}
          isLoading={isLoading}
          workflowDrawerOpen={workflowDrawerOpen}
          onWorkflowDrawerToggle={() => {
            setWorkflowDrawerOpen((open) => !open);
          }}
        />
        <div className="flex min-w-0 flex-1">
          <BackofficeSidebarNav
            currentScope={routeScope}
            collapsed={sidebarCollapsed}
            onCollapsedChange={setSidebarCollapsed}
          />
          <main className="relative z-10 flex min-w-0 flex-1 flex-col">
            <div className="flex min-w-0 flex-1 flex-col">{children}</div>
          </main>
        </div>
      </div>
      <GlobalWorkflowDrawer
        open={workflowDrawerOpen}
        sourceState={currentContext?.automationCollectionSource ?? null}
        onClose={() => {
          setWorkflowDrawerOpen(false);
        }}
      />
      {terminalScope ? <QuakeTerminal selectedScope={terminalScope} /> : null}
    </div>
  );
}
