import { Menu } from "@base-ui/react/menu";
import { ChevronsUpDown } from "lucide-react";
import { Fragment } from "react";
import { Link, useLocation } from "react-router";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import { backofficeContextScopeRoutePath } from "@/backoffice-runtime/scope-codec";
import type { AuthMeData } from "@/fragno/auth/auth-client";

const SCOPE_ROUTE_KINDS = new Set(["system", "org", "project", "user"]);

const AUTOMATION_TABS = new Set([
  "dashboard",
  "terminal",
  "scripts",
  "router",
  "store",
  "api",
  "events",
  "events-catalog",
  "integrations",
  "mcp",
  "sandboxes",
]);
const SYSTEM_UNAVAILABLE_AUTOMATION_TABS = new Set(["api", "mcp", "sandboxes"]);
const MARKETPLACE_TABS = new Set(["marketplace", "installed", "my-listings"]);

const SCOPE_GROUPS = [
  { kind: "system", label: "System" },
  { kind: "org", label: "Organisations" },
  { kind: "user", label: "Personal" },
] as const;

type ScopeMenuOption = {
  id: string;
  kind: BackofficeContextScope["kind"];
  label: string;
  description: string;
  scope: BackofficeContextScope;
};

const scopeKindLabel = (kind: BackofficeContextScope["kind"]) => {
  switch (kind) {
    case "system":
      return "System";
    case "org":
      return "Org";
    case "project":
      return "Project";
    case "user":
      return "User";
  }

  throw new Error("Unsupported Backoffice scope kind.");
};

const scopeOptionId = (scope: BackofficeContextScope) => {
  switch (scope.kind) {
    case "system":
      return "system:system";
    case "org":
      return `org:${scope.orgId}`;
    case "project":
      return `project:${scope.orgId}:${scope.projectId}`;
    case "user":
      return `user:${scope.userId}`;
  }

  throw new Error("Unsupported Backoffice scope kind.");
};

// Rebuilds the current URL for another scope: keeps the active section, keeps
// the section tab where scope-independent, and otherwise lands on the scoped
// index (which redirects to the section default).
export const scopeSwitchPath = (pathname: string, scope: BackofficeContextScope) => {
  const scopePath = backofficeContextScopeRoutePath(scope);
  const segments = pathname.split("/").filter(Boolean);
  const section = segments[1];
  const scoped = segments.length >= 4 && SCOPE_ROUTE_KINDS.has(segments[2] ?? "");
  const rest = scoped ? segments.slice(4) : segments.slice(2);

  switch (section) {
    case "automations": {
      const requestedTab = rest[0] && AUTOMATION_TABS.has(rest[0]) ? rest[0] : "dashboard";
      const tab =
        scope.kind === "system" && SYSTEM_UNAVAILABLE_AUTOMATION_TABS.has(requestedTab)
          ? "scripts"
          : requestedTab;
      return `/backoffice/automations/${scopePath}/${tab}`;
    }
    case "sessions":
      return `/backoffice/sessions/${scopePath}/sessions`;
    case "files":
      return `/backoffice/files/${scopePath}`;
    case "marketplace": {
      const tab = rest[0] && MARKETPLACE_TABS.has(rest[0]) ? rest[0] : "marketplace";
      return `/backoffice/marketplace/${scopePath}/${tab}`;
    }
    default:
      return `/backoffice/automations/${scopePath}/dashboard`;
  }
};

// While in project scope this menu keeps showing the parent organisation; the
// project itself is surfaced by the adjacent project menu.
const triggerKindLabel = (kind: BackofficeContextScope["kind"]) => {
  switch (kind) {
    case "system":
      return "Scope";
    case "org":
    case "project":
      return "Organisation";
    case "user":
      return "Personal";
  }

  throw new Error("Unsupported Backoffice scope kind.");
};

const currentScopeLabel = (scope: BackofficeContextScope, me: AuthMeData) => {
  switch (scope.kind) {
    case "system":
      return "System";
    case "org":
    case "project": {
      const organisation = me.organizations.find(
        (entry) => entry.organization.id === scope.orgId,
      )?.organization;
      return organisation?.name ?? scope.orgId;
    }
    case "user":
      return me.user.email ?? scope.userId;
  }

  throw new Error("Unsupported Backoffice scope kind.");
};

export function BackofficeScopeMenu({
  me,
  currentScope,
}: {
  me: AuthMeData | null;
  currentScope: BackofficeContextScope | null;
}) {
  const location = useLocation();
  if (!me?.user || !currentScope) {
    return null;
  }

  const options: ScopeMenuOption[] = [
    ...(me.user.role === "admin"
      ? [
          {
            id: "system:system",
            kind: "system" as const,
            label: "System",
            description: "Global system scope",
            scope: { kind: "system" as const },
          },
        ]
      : []),
    ...me.organizations.map(({ organization }) => ({
      id: `org:${organization.id}`,
      kind: "org" as const,
      label: organization.name ?? organization.id,
      description: "Organisation scope",
      scope: { kind: "org" as const, orgId: organization.id },
    })),
    {
      id: `user:${me.user.id}`,
      kind: "user" as const,
      label: me.user.email ?? me.user.id,
      description: "Personal user scope",
      scope: { kind: "user" as const, userId: me.user.id },
    },
  ];
  const selectedId = scopeOptionId(currentScope);
  const triggerLabel = currentScopeLabel(currentScope, me);

  return (
    <Menu.Root modal={false}>
      <Menu.Trigger
        type="button"
        aria-label={`Switch scope. Current context: ${triggerLabel}`}
        className="group flex min-h-12 w-full min-w-0 cursor-pointer items-center gap-2.5 py-3.5 pr-5.5 pl-6 text-left transition-[scale,color] duration-150 ease-out outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 active:scale-[0.96]"
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[11px] font-semibold text-[var(--bo-muted-2)]">
            {triggerKindLabel(currentScope.kind)}
          </span>
          <span className="min-w-0 truncate text-sm font-extrabold tracking-normal text-[var(--bo-fg)] normal-case">
            {triggerLabel}
          </span>
        </span>
        <ChevronsUpDown
          aria-hidden="true"
          className="size-3.5 shrink-0 text-[var(--bo-muted-2)] transition-colors duration-150 ease-out group-data-[popup-open]:text-[var(--bo-accent-fg)]"
        />
      </Menu.Trigger>

      <Menu.Portal style={{ position: "relative", zIndex: 2147483647 }}>
        <Menu.Positioner side="bottom" align="start" sideOffset={0} style={{ zIndex: 2147483647 }}>
          <Menu.Popup
            data-backoffice-root
            className="relative max-h-[min(32rem,calc(100vh-6rem))] w-[min(24rem,calc(100vw-2rem))] origin-top-left overflow-y-auto border border-[color:var(--bo-border-strong)] bg-[var(--bo-panel)] p-2 text-left tracking-normal text-[var(--bo-fg)] shadow-[0_18px_50px_rgba(15,23,42,0.2)] transition-[opacity,transform] duration-150 ease-out outline-none data-[ending-style]:-translate-y-1 data-[ending-style]:opacity-0 data-[starting-style]:-translate-y-1 data-[starting-style]:opacity-0 dark:shadow-[0_22px_60px_rgba(0,0,0,0.55)]"
          >
            <p className="px-2 py-1 text-[10px] font-semibold tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
              Switch scope
            </p>
            {SCOPE_GROUPS.map((group) => {
              const groupOptions = options.filter((option) => option.kind === group.kind);
              if (groupOptions.length === 0) {
                return null;
              }

              return (
                <Fragment key={group.kind}>
                  <Menu.Separator className="my-2 h-px bg-[var(--bo-border)]" />
                  <Menu.Group className="space-y-1">
                    <Menu.GroupLabel className="px-2 py-1 text-[9px] font-semibold tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
                      {group.label}
                    </Menu.GroupLabel>
                    {groupOptions.map((option) => {
                      const isCurrent = option.id === selectedId;
                      const className = isCurrent
                        ? "grid min-h-11 cursor-default gap-1 border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-2.5 py-2 text-left text-[var(--bo-accent-fg)] outline-none"
                        : "grid min-h-11 gap-1 border border-transparent px-2.5 py-2 text-left text-[var(--bo-muted)] outline-none transition-[background-color,border-color,color] duration-150 ease-out data-[highlighted]:border-[color:var(--bo-border-strong)] data-[highlighted]:bg-[var(--bo-panel-2)] data-[highlighted]:text-[var(--bo-fg)]";
                      const content = (
                        <>
                          <span className="flex min-w-0 items-center justify-between gap-4">
                            <span
                              className={`truncate text-sm tracking-normal text-[var(--bo-fg)] normal-case ${isCurrent ? "font-extrabold" : "font-medium"}`}
                            >
                              {option.label}
                            </span>
                            <span className="shrink-0 text-[9px] font-semibold tracking-[0.2em] text-[var(--bo-muted-2)] uppercase">
                              {scopeKindLabel(option.kind)}
                            </span>
                          </span>
                          <span className="truncate text-xs tracking-normal text-[var(--bo-muted-2)] normal-case">
                            {option.description}
                          </span>
                        </>
                      );

                      return isCurrent ? (
                        <Menu.Item key={option.id} disabled className={className}>
                          {content}
                        </Menu.Item>
                      ) : (
                        <Menu.Item
                          key={option.id}
                          render={
                            <Link
                              to={scopeSwitchPath(location.pathname, option.scope)}
                              preventScrollReset
                            />
                          }
                          className={className}
                        >
                          {content}
                        </Menu.Item>
                      );
                    })}
                  </Menu.Group>
                </Fragment>
              );
            })}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
