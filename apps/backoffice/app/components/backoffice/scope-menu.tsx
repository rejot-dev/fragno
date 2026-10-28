import { backofficeScopeOrganization } from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { IconName } from "@fragno-private/design-system/icon";
import {
  SelectorMenu,
  SelectorMenuButton,
  SelectorMenuGroup,
  SelectorMenuLink,
  SelectorMenuNote,
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
import { useBackofficeSignOut } from "@/fragno/auth/use-backoffice-sign-out";

import { administeredMemberName } from "./administered-member-name";
import { scopeSwitchPath } from "./scope-switch-path";

type ScopeMenuOption = {
  id: string;
  label: string;
  description: string | null;
  scope: BackofficeResolvedScope<Organization>;
};

type ScopeMenuGroup = {
  key: string;
  label: string;
  options: ScopeMenuOption[];
  /** Pages to go to rather than scopes to switch to, such as where members' workspaces are listed. */
  shortcuts: { key: string; to: string; label: string; description: string }[];
  /** Where every option is listed, when the group shows only some of them. */
  more: { to: string; label: string } | null;
};

/** A managing organization's clients beyond this many are listed on its Clients page instead. */
const CLIENTS_SHOWN_PER_GROUP = 6;

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

// Another person's workspace is labelled as theirs, so it is never mistaken for the user's own.
const triggerKindLabelFor = (
  scope: BackofficeResolvedScope,
  me: BackofficeMeData,
  administeredMember: AdministeredMember | null,
): string => {
  const ownerUserId =
    scope.kind === "user"
      ? scope.userId
      : scope.kind === "project" && scope.owner.kind === "user"
        ? scope.owner.userId
        : null;
  return ownerUserId !== null &&
    ownerUserId !== me.user.id &&
    administeredMember?.userId === ownerUserId
    ? "Member workspace"
    : triggerKindLabel(scope);
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

export const currentScopeLabel = (
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
        ? administeredMemberName(administeredMember)
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
  const { signOut, signingOut, error: signOutError } = useBackofficeSignOut();
  if (!me?.user || !currentScope) {
    return null;
  }

  const selectedId = scopeOptionId(currentScope);
  const triggerLabel = currentScopeLabel(currentScope, me, administeredMember);
  const groups = scopeMenuGroups(me, administeredMember, selectedId);

  return (
    <SelectorMenu>
      <SelectorMenuTrigger
        label={triggerKindLabelFor(currentScope, me, administeredMember)}
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
        {groups.map((group) => (
          <SelectorMenuGroup key={group.key} label={group.label}>
            {group.options.map((option) => (
              <SelectorMenuOption
                key={option.id}
                to={scopeSwitchPath(
                  location.pathname,
                  backofficeRouteScopeFromResolvedScope(option.scope),
                  me.user.id,
                )}
                label={option.label}
                description={option.description}
                badge={null}
                current={option.id === selectedId}
              />
            ))}
            {group.shortcuts.map((shortcut) => (
              <SelectorMenuOption
                key={shortcut.key}
                to={shortcut.to}
                label={shortcut.label}
                description={shortcut.description}
                badge={null}
                current={false}
              />
            ))}
            {group.more ? (
              <SelectorMenuLink to={group.more.to} icon="layers">
                {group.more.label}
              </SelectorMenuLink>
            ) : null}
          </SelectorMenuGroup>
        ))}
        {/* Signing out leaves every scope, so it closes the list of them. */}
        <SelectorMenuGroup label={null}>
          <SelectorMenuButton icon="log-out" disabled={signingOut} onClick={signOut}>
            {signingOut ? "Signing out…" : "Sign out"}
          </SelectorMenuButton>
          {signOutError ? (
            <SelectorMenuNote tone="error">
              {signOutError instanceof Error ? signOutError.message : "Unable to sign out."}
            </SelectorMenuNote>
          ) : null}
        </SelectorMenuGroup>
      </SelectorMenuPopup>
    </SelectorMenu>
  );
}

/**
 * The scopes to switch to, grouped by why the user may act in them: System for administrators, the
 * organizations they belong to, the clients of each of those, and their own workspace. Last come
 * members' workspaces: the one the user is in, and each organization whose members they administer,
 * whose members page lists them, paginated.
 */
function scopeMenuGroups(
  me: BackofficeMeData,
  administeredMember: AdministeredMember | null,
  selectedId: string,
): ScopeMenuGroup[] {
  const organizationOption = (organization: Organization): ScopeMenuOption => {
    const scope = { kind: "org" as const, organization };
    return { id: scopeOptionId(scope), label: organization.name, description: null, scope };
  };
  const organizationsById = new Map(
    me.organizations.map(({ organization }) => [organization.id, organization]),
  );
  const clientsByManager = new Map<string, { manager: Organization; clients: Organization[] }>();
  for (const { organization, through } of me.organizations) {
    if (through.kind !== "managing-organization") {
      continue;
    }
    const manager = organizationsById.get(through.organization.id);
    if (!manager) {
      continue;
    }
    const group = clientsByManager.get(manager.id) ?? { manager, clients: [] };
    group.clients.push(organization);
    clientsByManager.set(manager.id, group);
  }

  const groups: ScopeMenuGroup[] = [];
  if (me.user.role === "admin") {
    const scope = { kind: "system" as const };
    groups.push({
      key: "system",
      label: "System",
      options: [{ id: scopeOptionId(scope), label: "System", description: null, scope }],
      shortcuts: [],
      more: null,
    });
  }
  const memberships = me.organizations
    .filter(({ through }) => through.kind === "membership")
    .map(({ organization }) => organizationOption(organization));
  if (memberships.length > 0) {
    groups.push({
      key: "organizations",
      label: "Organizations",
      options: memberships,
      shortcuts: [],
      more: null,
    });
  }
  for (const { manager, clients } of clientsByManager.values()) {
    const options = clients.map(organizationOption);
    // The current client stays listed even when it falls beyond the ones shown.
    const shown = options.filter(
      (option, index) => index < CLIENTS_SHOWN_PER_GROUP || option.id === selectedId,
    );
    groups.push({
      key: `clients:${manager.id}`,
      label: `Managed by ${manager.name}`,
      options: shown,
      shortcuts: [],
      more:
        shown.length < options.length
          ? {
              to: `/backoffice/organizations/${encodeURIComponent(manager.slug)}/clients`,
              label: `All ${options.length} organizations ${manager.name} manages`,
            }
          : null,
    });
  }
  const personalScope = {
    kind: "user" as const,
    userId: me.user.id,
    jurisdiction: me.user.jurisdiction,
  };
  groups.push({
    key: "personal",
    label: "Personal",
    options: [
      {
        id: scopeOptionId(personalScope),
        label: me.user.email ?? me.user.id,
        description: null,
        scope: personalScope,
      },
    ],
    shortcuts: [],
    more: null,
  });
  const memberScope = administeredMember
    ? {
        kind: "user" as const,
        userId: administeredMember.userId,
        jurisdiction: administeredMember.jurisdiction,
      }
    : null;
  const administeredOrganizations = me.organizations
    .filter(({ roles }) => administersMembers(roles))
    .map(({ organization }) => organization);
  if (administeredMember || administeredOrganizations.length > 0) {
    groups.push({
      key: "member-workspaces",
      label: "Member workspaces",
      options:
        administeredMember && memberScope
          ? [
              {
                id: scopeOptionId(memberScope),
                label: administeredMemberName(administeredMember),
                description: `${administeredMember.organization.name} member`,
                scope: memberScope,
              },
            ]
          : [],
      shortcuts: administeredOrganizations.map((organization) => ({
        key: organization.id,
        to: `/backoffice/organizations/${encodeURIComponent(organization.slug)}/members`,
        label: `${organization.name} members`,
        description: "Open a member's personal workspace",
      })),
      more: null,
    });
  }
  return groups;
}
