import { Menu } from "@base-ui/react/menu";
import { ChevronsUpDown } from "lucide-react";
import { Fragment } from "react";
import { Link, useLocation } from "react-router";

import {
  backofficeRouteScopeFromResolvedScope,
  type BackofficeResolvedScope,
} from "@/backoffice-runtime/resolved-scope";
import type { BackofficeMeData, Organization } from "@/fragno/auth/contracts";
import { buildBackofficeOrganizationSwitchPath } from "@/routes/backoffice/auth-navigation";

import { scopeSwitchPath } from "./scope-switch-path";

const SCOPE_GROUPS = [
  { kind: "system", label: "System" },
  { kind: "org", label: "Organizations" },
  { kind: "user", label: "Personal" },
] as const;

type ScopeMenuOption = {
  id: string;
  label: string;
  description: string;
  scope: BackofficeResolvedScope<Organization>;
};

const scopeKindLabel = (kind: BackofficeResolvedScope["kind"]) => {
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

const scopeOptionId = (scope: BackofficeResolvedScope) => {
  switch (scope.kind) {
    case "system":
      return "system:system";
    case "org":
    case "project":
      return `org:${scope.organization.id}`;
    case "user":
      return `user:${scope.userId}`;
  }

  throw new Error("Unsupported Backoffice scope kind.");
};

// While in project scope this menu keeps showing the parent organization; the
// project itself is surfaced by the adjacent project menu.
const triggerKindLabel = (kind: BackofficeResolvedScope["kind"]) => {
  switch (kind) {
    case "system":
      return "Scope";
    case "org":
    case "project":
      return "Organization";
    case "user":
      return "Personal";
  }

  throw new Error("Unsupported Backoffice scope kind.");
};

const currentScopeLabel = (scope: BackofficeResolvedScope<Organization>, me: BackofficeMeData) => {
  switch (scope.kind) {
    case "system":
      return "System";
    case "org":
    case "project":
      return scope.organization.name;
    case "user":
      return me.user.email ?? scope.userId;
  }

  throw new Error("Unsupported Backoffice scope kind.");
};

export function BackofficeScopeMenu({
  me,
  currentScope,
}: {
  me: BackofficeMeData | null;
  currentScope: BackofficeResolvedScope<Organization> | null;
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
            label: "System",
            description: "Global system scope",
            scope: { kind: "system" as const },
          },
        ]
      : []),
    ...me.organizations.map(({ organization }) => ({
      id: `org:${organization.id}`,
      label: organization.name,
      description: "Organization scope",
      scope: { kind: "org" as const, organization },
    })),
    {
      id: `user:${me.user.id}`,
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
              const groupOptions = options.filter((option) => option.scope.kind === group.kind);
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
                      const destinationOrganizationId =
                        option.scope.kind === "org" || option.scope.kind === "project"
                          ? option.scope.organization.id
                          : null;
                      const destination = scopeSwitchPath(
                        location.pathname,
                        backofficeRouteScopeFromResolvedScope(option.scope),
                      );
                      const switchPath =
                        destinationOrganizationId &&
                        destinationOrganizationId !== me.activeOrganizationId
                          ? buildBackofficeOrganizationSwitchPath(
                              destinationOrganizationId,
                              destination,
                            )
                          : destination;
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
                              {scopeKindLabel(option.scope.kind)}
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
                          render={<Link to={switchPath} preventScrollReset />}
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
