import { backofficeScopeOrganization } from "@fragno-dev/backoffice-api/v0/shared/scope";
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
  backofficeResolvedScopeId,
  backofficeRouteScopeFromResolvedScope,
  type BackofficeResolvedScope,
} from "@/backoffice-runtime/resolved-scope";
import {
  type AdministeredMember,
  administersMembers,
  type BackofficeMeData,
  type Organization,
} from "@/fragno/auth/contracts";

import { backofficeScopeOptions } from "./scope-options";
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

// A project is chosen in the adjacent project menu, so this menu selects its owner.
const scopeOptionId = (scope: BackofficeResolvedScope): string => {
  switch (scope.kind) {
    case "system":
      return "system:system";
    case "project":
      return scopeOptionId(scope.owner);
    case "org":
      return `org:${scope.organization.id}`;
    case "user":
      return `user:${scope.userId}`;
    case "app":
      return backofficeResolvedScopeId(scope);
    default:
      throw new Error("Unsupported Backoffice scope kind.", { cause: scope satisfies never });
  }
};

// While in project scope this menu keeps showing the project's owner; the
// project itself is surfaced by the adjacent project menu.
const triggerKindLabel = (scope: BackofficeResolvedScope): string => {
  switch (scope.kind) {
    case "system":
      return "Scope";
    case "project":
      return triggerKindLabel(scope.owner);
    case "org":
      return "Organization";
    case "user":
      return "Personal";
    case "app":
      return "App";
    default:
      throw new Error("Unsupported Backoffice scope kind.", { cause: scope satisfies never });
  }
};

// While in project scope this menu shows the project's owner, so it shares its mark.
const scopeMark = (
  scope: BackofficeResolvedScope<Organization>,
): { kind: "letter"; letter: string } | { kind: "icon"; icon: IconName } => {
  switch (scope.kind) {
    case "system":
      return { kind: "icon", icon: "server" };
    case "project":
      return scopeMark(scope.owner);
    case "org":
      return { kind: "letter", letter: scope.organization.name.trim().charAt(0).toUpperCase() };
    case "user":
      return { kind: "icon", icon: "user" };
    case "app":
      return { kind: "icon", icon: "box" };
    default:
      throw new Error("Unsupported Backoffice scope kind.", { cause: scope satisfies never });
  }
};

// The first organization carries the app's primary colour; every other scope gets its own hue.
const scopeColor = (
  scope: BackofficeResolvedScope<Organization>,
  me: BackofficeMeData,
  scopeId: string,
): { kind: "primary" } | { kind: "seeded"; seed: string } =>
  me.organizations.length > 0 &&
  backofficeScopeOrganization(scope)?.organization.id === me.organizations[0]?.organization.id
    ? { kind: "primary" }
    : { kind: "seeded", seed: scopeId };

const currentScopeLabel = (
  scope: BackofficeResolvedScope<Organization>,
  me: BackofficeMeData,
  administeredMember: AdministeredMember | null,
): string => {
  switch (scope.kind) {
    case "system":
      return "System";
    case "project":
      return currentScopeLabel(scope.owner, me, administeredMember);
    case "org":
      return scope.organization.name;
    case "user":
      return administeredMember?.userId === scope.userId
        ? administeredMember.email
        : (me.user.email ?? scope.userId);
    case "app":
      return scope.appId;
    default:
      throw new Error("Unsupported Backoffice scope kind.", { cause: scope satisfies never });
  }
};

export function BackofficeScopeMenu({
  me,
  currentScope,
  administeredMember,
  sidebarCollapsed,
}: {
  me: BackofficeMeData | null;
  currentScope: BackofficeResolvedScope<Organization> | null;
  administeredMember: AdministeredMember | null;
  sidebarCollapsed: boolean;
}) {
  const location = useLocation();
  if (!me?.user || !currentScope) {
    return null;
  }

  const options: ScopeMenuOption[] = [
    ...backofficeScopeOptions(me),
    // The member's workspace stays listed while the user works in it.
    ...(administeredMember
      ? [
          {
            label: administeredMember.email,
            scope: { kind: "user" as const, userId: administeredMember.userId },
          },
        ]
      : []),
  ].map((option) => ({ ...option, id: scopeOptionId(option.scope) }));
  const selectedId = scopeOptionId(currentScope);
  const triggerLabel = currentScopeLabel(currentScope, me, administeredMember);
  // Members are listed, paginated, on each organization's members page rather than here.
  const administeredOrganizations = me.organizations
    .filter(({ member }) => administersMembers(member.roles))
    .map(({ organization }) => organization);

  return (
    <SelectorMenu>
      <SelectorMenuTrigger
        label={triggerKindLabel(currentScope)}
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
                const switchPath = scopeSwitchPath(
                  location.pathname,
                  backofficeRouteScopeFromResolvedScope(option.scope),
                );

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
        {administeredOrganizations.length > 0 ? (
          <SelectorMenuGroup label="Member workspaces">
            {administeredOrganizations.map((organization) => (
              <SelectorMenuOption
                key={organization.id}
                to={`/backoffice/organizations/${encodeURIComponent(organization.slug)}/members`}
                label={`${organization.name} members`}
                description="Open a member's personal workspace"
                badge={null}
                current={false}
              />
            ))}
          </SelectorMenuGroup>
        ) : null}
      </SelectorMenuPopup>
    </SelectorMenu>
  );
}
