import { useEffect, useState, type ReactNode } from "react";

import {
  backofficeContextScopeLabel,
  type BackofficeContextScope,
} from "@/backoffice-runtime/context";
import { scheduleBackofficeTokenRefresh } from "@/fragno/auth/browser-auth.client";
import type { BackofficeMeData } from "@/fragno/auth/contracts";

import { BackofficeClsDebugger } from "./cls-debugger";
import { CurrentBackofficeProvider, type CurrentBackofficeContext } from "./current-context";
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

function backofficeTerminalScopeLabel(scope: BackofficeContextScope, me: BackofficeMeData | null) {
  if (scope.kind === "org" || scope.kind === "project") {
    const organization = me?.organizations.find(
      (entry) => entry.organization.id === scope.orgId,
    )?.organization;
    const organizationLabel = organization?.name ?? scope.orgId;
    return scope.kind === "project"
      ? `${organizationLabel} / ${scope.projectId}`
      : organizationLabel;
  }

  if (scope.kind === "user" && me?.user.id === scope.userId) {
    return me.user.email ?? scope.userId;
  }

  return backofficeContextScopeLabel(scope);
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
          currentScope={currentContext?.scope ?? null}
          projectCollectionSource={currentContext?.projectCollectionSource ?? null}
          isLoading={isLoading}
          workflowDrawerOpen={workflowDrawerOpen}
          onWorkflowDrawerToggle={() => {
            setWorkflowDrawerOpen((open) => !open);
          }}
        />
        <div className="flex min-w-0 flex-1">
          <BackofficeSidebarNav
            currentScope={currentContext?.scope ?? null}
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
      {currentContext ? (
        <QuakeTerminal
          scope={currentContext.scope}
          scopeLabel={backofficeTerminalScopeLabel(currentContext.scope, me)}
        />
      ) : null}
    </div>
  );
}
