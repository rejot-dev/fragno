import type { IconName } from "@fragno-private/design-system/icon";
import {
  SelectorMenu,
  SelectorMenuGroup,
  SelectorMenuOption,
  SelectorMenuPopup,
  SelectorMenuTrigger,
} from "@fragno-private/design-system/selector-menu";
import { useLocation } from "react-router";

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
  scope: BackofficeResolvedScope<Organization>;
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

// While in project scope this menu shows the parent organization, so it shares its mark.
const scopeMark = (
  scope: BackofficeResolvedScope<Organization>,
): { kind: "letter"; letter: string } | { kind: "icon"; icon: IconName } => {
  switch (scope.kind) {
    case "system":
      return { kind: "icon", icon: "server" };
    case "org":
    case "project":
      return { kind: "letter", letter: scope.organization.name.trim().charAt(0).toUpperCase() };
    case "user":
      return { kind: "icon", icon: "user" };
  }

  throw new Error("Unsupported Backoffice scope kind.");
};

// The first organization carries the app's primary colour; every other scope gets its own hue.
const scopeColor = (
  scope: BackofficeResolvedScope<Organization>,
  me: BackofficeMeData,
  scopeId: string,
): { kind: "primary" } | { kind: "seeded"; seed: string } =>
  (scope.kind === "org" || scope.kind === "project") &&
  scope.organization.id === me.organizations[0]?.organization.id
    ? { kind: "primary" }
    : { kind: "seeded", seed: scopeId };

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
  sidebarCollapsed,
}: {
  me: BackofficeMeData | null;
  currentScope: BackofficeResolvedScope<Organization> | null;
  sidebarCollapsed: boolean;
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
            scope: { kind: "system" as const },
          },
        ]
      : []),
    ...me.organizations.map(({ organization }) => ({
      id: `org:${organization.id}`,
      label: organization.name,
      scope: { kind: "org" as const, organization },
    })),
    {
      id: `user:${me.user.id}`,
      label: me.user.email ?? me.user.id,
      scope: { kind: "user" as const, userId: me.user.id },
    },
  ];
  const selectedId = scopeOptionId(currentScope);
  const triggerLabel = currentScopeLabel(currentScope, me);

  return (
    <SelectorMenu>
      <SelectorMenuTrigger
        label={triggerKindLabel(currentScope.kind)}
        value={triggerLabel}
        ariaLabel={`Switch scope. Current context: ${triggerLabel}`}
        layout={{
          kind: "workspace",
          mark: scopeMark(currentScope),
          color: scopeColor(currentScope, me, selectedId),
          collapsed: sidebarCollapsed,
        }}
      />

      <SelectorMenuPopup align="start" height="capped">
        {SCOPE_GROUPS.map((group) => {
          const groupOptions = options.filter((option) => option.scope.kind === group.kind);
          if (groupOptions.length === 0) {
            return null;
          }

          return (
            <SelectorMenuGroup key={group.kind} label={group.label}>
              {groupOptions.map((option) => {
                const destinationOrganizationId =
                  option.scope.kind === "org" || option.scope.kind === "project"
                    ? option.scope.organization.id
                    : null;
                const destination = scopeSwitchPath(
                  location.pathname,
                  backofficeRouteScopeFromResolvedScope(option.scope),
                );
                const switchPath =
                  destinationOrganizationId && destinationOrganizationId !== me.activeOrganizationId
                    ? buildBackofficeOrganizationSwitchPath(destinationOrganizationId, destination)
                    : destination;

                return (
                  <SelectorMenuOption
                    key={option.id}
                    to={switchPath}
                    label={option.label}
                    description={null}
                    badge={null}
                    current={option.id === selectedId}
                  />
                );
              })}
            </SelectorMenuGroup>
          );
        })}
      </SelectorMenuPopup>
    </SelectorMenu>
  );
}
