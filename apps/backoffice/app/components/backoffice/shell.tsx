import {
  backofficeContextScopesEqual,
  type BackofficeContextScope,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import { ClientOnly } from "@fragno-private/design-system/client-only";
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";

import {
  backofficeRuntimeScopeFromResolvedScope,
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
import { BackofficePhoneChrome } from "./phone-chrome";
import { BackofficeSidebarNav, useBackofficeSections } from "./sidebar-nav";
import { BackofficeTopBar } from "./top-bar";

// The terminal renders only in browsers, so the server imports none of it.
const QuakeTerminal = lazy(async () => ({
  default: (await import("./quake-terminal")).QuakeTerminal,
}));

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
  automationReplicaSource: CurrentBackofficeContext["automationReplicaSource"] | null;
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

/** The scopes this page can link to; see `CurrentBackofficeContext.resolveScope`. */
function resolveScopeFor(
  me: BackofficeMeData | null,
  current: BackofficeShellResolvedScope,
): CurrentBackofficeContext["resolveScope"] {
  return (scope: BackofficeContextScope) => {
    if (backofficeContextScopesEqual(scope, backofficeRuntimeScopeFromResolvedScope(current))) {
      return current;
    }
    switch (scope.kind) {
      case "org": {
        const membership = me?.organizations.find(
          ({ organization }) => organization.id === scope.orgId,
        );
        return membership ? { kind: "org", organization: membership.organization } : null;
      }
      case "user":
        // Personal scopes are named by user ID, which the scope carries.
        return scope;
      // Their pages name them by slugs, or another owner's, which this page does not know.
      case "project":
      case "app":
      case "system":
        return null;
    }
    scope satisfies never;
    throw new Error("Backoffice scope resolution received an unsupported scope kind.");
  };
}

export function BackofficeShell(props: BackofficeShellProps) {
  const shell = (
    <GlobalHotkeysProvider>
      <BackofficeShellFrame {...props} />
    </GlobalHotkeysProvider>
  );
  const currentContext =
    props.resolvedScope && props.automationReplicaSource
      ? {
          resolvedScope: props.resolvedScope,
          automationReplicaSource: props.automationReplicaSource,
          resolveScope: resolveScopeFor(props.me, props.resolvedScope),
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
  automationReplicaSource,
  projectList,
  isLoading,
}: BackofficeShellProps) {
  const [agentDrawerOpen, setAgentDrawerOpen] = useState(false);
  const sections = useBackofficeSections(resolvedScope, me);
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
      data-backoffice-shell
      data-sidebar-restoring={sidebarRestoring || undefined}
      className="relative isolate flex min-h-screen bg-[var(--bo-bg)] text-[var(--bo-fg)]"
    >
      <BackofficeClsDebugger />
      <div className="relative flex min-w-0 flex-1 flex-col pb-[var(--bo-shell-bottom)]">
        <div className="bo-grid-backdrop pointer-events-none absolute inset-0" />
        <BackofficePhoneChrome
          sections={sections}
          me={me}
          resolvedScope={resolvedScope}
          administeredMember={administeredMember}
          projectList={projectList}
          isLoading={isLoading ?? false}
        />
        <BackofficeTopBar
          sections={sections}
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
            sections={sections}
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
      {/* Phones reach agents through the Agents tab instead. */}
      <div className="hidden sm:contents">
        <AgentDrawer
          open={agentDrawerOpen}
          // Agents read their directory from the scope's Automations replica.
          resolvedScope={automationReplicaSource ? resolvedScope : null}
          onClose={() => {
            setAgentDrawerOpen(false);
          }}
        />
      </div>
      {terminalScope ? (
        <ClientOnly>
          <Suspense fallback={null}>
            <QuakeTerminal pageScope={terminalScope} me={me} />
          </Suspense>
        </ClientOnly>
      ) : null}
    </div>
  );
}
