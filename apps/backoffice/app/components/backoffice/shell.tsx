import { useEffect, useRef, useState, type ReactNode } from "react";

import {
  type BackofficeNamedProject,
  type BackofficeResolvedScope,
  type BackofficeScopeSelection,
} from "@/backoffice-runtime/resolved-scope";
import { scheduleBackofficeTokenRefresh } from "@/fragno/auth/browser-auth.client";
import type { AdministeredMember, BackofficeMeData } from "@/fragno/auth/contracts";
import type { AutomationProjectList } from "@/fragno/automation/project-list";

import { AgentDrawer } from "./agent-drawer";
import { BackofficeClsDebugger } from "./cls-debugger";
import { CurrentBackofficeProvider } from "./current-context";
import type { CurrentBackofficeContext } from "./current-context-state";
import { GlobalHotkeysProvider, useGlobalHotkey } from "./global-hotkeys";
import { MemberWorkspaceBanner } from "./member-workspace-banner";
import { QuakeTerminal } from "./quake-terminal";
import { BackofficeSidebarNav } from "./sidebar-nav";
import { BackofficeTopBar } from "./top-bar";

type BackofficeShellResolvedScope = BackofficeResolvedScope<
  BackofficeMeData["organizations"][number]["organization"],
  BackofficeNamedProject
>;

type BackofficeShellProps = {
  children: ReactNode;
  me: BackofficeMeData | null;
  resolvedScope: BackofficeShellResolvedScope | null;
  administeredMember: AdministeredMember | null;
  accessTokenExpiresAt: string | null;
  automationCollectionSource: CurrentBackofficeContext["automationCollectionSource"] | null;
  /** The project owner's projects, streamed in after the page; null without a project owner. */
  projectList: Promise<AutomationProjectList> | null;
  isLoading?: boolean;
};

function backofficeTerminalScopeSelection(
  scope: BackofficeShellResolvedScope,
  me: BackofficeMeData | null,
  administeredMember: AdministeredMember | null,
): BackofficeScopeSelection {
  switch (scope.kind) {
    case "system":
      return { ...scope, label: "System" };
    case "org":
      return { ...scope, label: scope.organization.name };
    case "project":
      return {
        ...scope,
        label: `${backofficeTerminalScopeSelection(scope.owner, me, administeredMember).label} / ${scope.project.name}`,
      };
    case "user":
      return {
        ...scope,
        label:
          me?.user.id === scope.userId
            ? (me.user.email ?? scope.userId)
            : administeredMember?.userId === scope.userId
              ? administeredMember.email
              : scope.userId,
      };
    case "app":
      return {
        ...scope,
        label: `${backofficeTerminalScopeSelection(scope.owner, me, administeredMember).label} / ${scope.appId}`,
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
  const currentContext =
    props.resolvedScope && props.automationCollectionSource
      ? {
          resolvedScope: props.resolvedScope,
          automationCollectionSource: props.automationCollectionSource,
        }
      : null;
  return currentContext ? (
    <CurrentBackofficeProvider value={currentContext}>{shell}</CurrentBackofficeProvider>
  ) : (
    shell
  );
}

const SIDEBAR_COLLAPSED_STORAGE_KEY = "backoffice:sidebar-collapsed";

function readStoredSidebarCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function BackofficeShellFrame({
  children,
  me,
  resolvedScope,
  administeredMember,
  accessTokenExpiresAt,
  automationCollectionSource,
  projectList,
  isLoading,
}: BackofficeShellProps) {
  const [agentDrawerOpen, setAgentDrawerOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const sidebarRestoredRef = useRef(false);
  const [sidebarRestoring, setSidebarRestoring] = useState(true);
  const terminalScope = resolvedScope
    ? backofficeTerminalScopeSelection(resolvedScope, me, administeredMember)
    : null;
  useEffect(() => {
    if (!accessTokenExpiresAt) {
      return undefined;
    }
    return scheduleBackofficeTokenRefresh(accessTokenExpiresAt, () => {
      window.location.replace("/backoffice/login");
    });
  }, [accessTokenExpiresAt]);
  // Restored after mount so the server and the first client render agree; saved on every change
  // after that.
  useEffect(() => {
    if (!sidebarRestoredRef.current) {
      sidebarRestoredRef.current = true;
      if (readStoredSidebarCollapsed()) {
        setSidebarCollapsed(true);
      }
      return;
    }
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(sidebarCollapsed));
    } catch {
      // Remembering the sidebar is optional when storage is unavailable.
    }
  }, [sidebarCollapsed]);
  // Transitions stay off until a frame has painted the restored sidebar, so a saved collapse
  // snaps into place instead of replaying its animation on load.
  useEffect(() => {
    let paintedFrame = 0;
    const restoredFrame = requestAnimationFrame(() => {
      paintedFrame = requestAnimationFrame(() => {
        setSidebarRestoring(false);
      });
    });
    return () => {
      cancelAnimationFrame(restoredFrame);
      cancelAnimationFrame(paintedFrame);
    };
  }, []);
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
    id: "toggle-agent-drawer",
    key: "i",
    modifiers: { primary: true },
    handler() {
      setAgentDrawerOpen((open) => !open);
    },
  });

  return (
    <div
      data-backoffice-root
      data-sidebar-restoring={sidebarRestoring || undefined}
      className="relative isolate flex min-h-screen bg-[var(--bo-bg)] text-[var(--bo-fg)]"
    >
      <BackofficeClsDebugger />
      <div className="relative flex min-w-0 flex-1 flex-col">
        <div className="bo-grid-backdrop pointer-events-none absolute inset-0" />
        <BackofficeTopBar
          me={me}
          resolvedScope={resolvedScope}
          administeredMember={administeredMember}
          projectList={projectList}
          isLoading={isLoading}
          sidebarCollapsed={sidebarCollapsed}
          agentDrawerOpen={agentDrawerOpen}
          onAgentDrawerToggle={() => {
            setAgentDrawerOpen((open) => !open);
          }}
        />
        <div className="flex min-w-0 flex-1">
          <BackofficeSidebarNav
            currentScope={resolvedScope}
            me={me}
            collapsed={sidebarCollapsed}
            onCollapsedChange={setSidebarCollapsed}
          />
          <main className="relative z-10 flex min-w-0 flex-1 flex-col">
            <MemberWorkspaceBanner
              me={me}
              resolvedScope={resolvedScope}
              administeredMember={administeredMember}
            />
            <div className="flex min-w-0 flex-1 flex-col">{children}</div>
          </main>
        </div>
      </div>
      <AgentDrawer
        open={agentDrawerOpen}
        // Agents read their directory from the scope's Automations replica.
        resolvedScope={automationCollectionSource ? resolvedScope : null}
        onClose={() => {
          setAgentDrawerOpen(false);
        }}
      />
      {terminalScope ? <QuakeTerminal pageScope={terminalScope} me={me} /> : null}
    </div>
  );
}
