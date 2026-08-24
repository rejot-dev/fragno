import type { BackofficeContextScope } from "./context";
import type { BackofficeRoutableRouteScope, BackofficeRouteScope } from "./route-scope";
import type { BackofficeRoutableScope } from "./scope-codec";

/** Canonical organization identity required to address both runtime services and public routes. */
export type BackofficeOrganizationIdentity = Readonly<{ id: string; slug: string }>;

/** Authenticated Backoffice scope with organization identity resolved from a public route slug. */
export type BackofficeResolvedScope<
  TOrganization extends BackofficeOrganizationIdentity = BackofficeOrganizationIdentity,
> =
  | { kind: "system" }
  | { kind: "org"; organization: TOrganization }
  | {
      kind: "project";
      organization: TOrganization;
      projectId: string;
    }
  | { kind: "user"; userId: string };

/** Authenticated non-system scope resolved from an ordinary Backoffice route. */
export type BackofficeRoutableResolvedScope<
  TOrganization extends BackofficeOrganizationIdentity = BackofficeOrganizationIdentity,
> = Exclude<BackofficeResolvedScope<TOrganization>, { kind: "system" }>;

/** Resolved Backoffice scope paired with the label presented by a scope selector. */
export type BackofficeScopeSelection =
  | (Extract<BackofficeResolvedScope, { kind: "system" }> & { label: string })
  | (Extract<BackofficeResolvedScope, { kind: "org" }> & { label: string })
  | (Extract<BackofficeResolvedScope, { kind: "project" }> & { label: string })
  | (Extract<BackofficeResolvedScope, { kind: "user" }> & { label: string });

/** Non-system scope selection available to ordinary routable Backoffice workspaces. */
export type BackofficeRoutableScopeSelection = Exclude<
  BackofficeScopeSelection,
  { kind: "system" }
>;

export type ResolveBackofficeOrganizationIdentity = (
  organizationId: string,
) => Promise<BackofficeOrganizationIdentity>;

/** Projects a canonical organization record to the identity required by Backoffice scopes. */
export function backofficeOrganizationIdentity(
  organization: BackofficeOrganizationIdentity,
): BackofficeOrganizationIdentity {
  return { id: organization.id, slug: organization.slug };
}

export function resolveBackofficeRouteScope<TOrganization extends BackofficeOrganizationIdentity>(
  routeScope: BackofficeRoutableRouteScope,
  organizations: readonly TOrganization[],
): BackofficeRoutableResolvedScope<TOrganization> | null;
export function resolveBackofficeRouteScope<TOrganization extends BackofficeOrganizationIdentity>(
  routeScope: BackofficeRouteScope,
  organizations: readonly TOrganization[],
): BackofficeResolvedScope<TOrganization> | null;
/** Resolves an untrusted organization slug into canonical authenticated organization identity. */
export function resolveBackofficeRouteScope<TOrganization extends BackofficeOrganizationIdentity>(
  routeScope: BackofficeRouteScope,
  organizations: readonly TOrganization[],
): BackofficeResolvedScope<TOrganization> | null {
  if (routeScope.kind === "system" || routeScope.kind === "user") {
    return routeScope;
  }
  const organization = organizations.find(({ slug }) => slug === routeScope.orgSlug);
  if (!organization) {
    return null;
  }
  return routeScope.kind === "org"
    ? { kind: "org", organization }
    : { kind: "project", organization, projectId: routeScope.projectId };
}

export function backofficeRuntimeScopeFromResolvedScope(
  scope: BackofficeRoutableResolvedScope,
): BackofficeRoutableScope;
export function backofficeRuntimeScopeFromResolvedScope(
  scope: BackofficeResolvedScope,
): BackofficeContextScope;
/** Converts authenticated resolved identity into the ID-backed scope accepted by runtime services. */
export function backofficeRuntimeScopeFromResolvedScope(
  scope: BackofficeResolvedScope,
): BackofficeContextScope {
  switch (scope.kind) {
    case "system":
      return { kind: "system" };
    case "org":
      return { kind: "org", orgId: scope.organization.id };
    case "project":
      return { kind: "project", orgId: scope.organization.id, projectId: scope.projectId };
    case "user":
      return { kind: "user", userId: scope.userId };
  }
  throw new Error("Unsupported Backoffice resolved scope kind.");
}

export function backofficeRouteScopeFromResolvedScope(
  scope: BackofficeRoutableResolvedScope,
): BackofficeRoutableRouteScope;
export function backofficeRouteScopeFromResolvedScope(
  scope: BackofficeResolvedScope,
): BackofficeRouteScope;
/** Converts authenticated resolved identity into the slug-backed scope accepted by public routes. */
export function backofficeRouteScopeFromResolvedScope(
  scope: BackofficeResolvedScope,
): BackofficeRouteScope {
  switch (scope.kind) {
    case "system":
      return { kind: "system" };
    case "org":
      return { kind: "org", orgSlug: scope.organization.slug };
    case "project":
      return {
        kind: "project",
        orgSlug: scope.organization.slug,
        projectId: scope.projectId,
      };
    case "user":
      return { kind: "user", userId: scope.userId };
  }
  throw new Error("Unsupported Backoffice resolved scope kind.");
}

export function backofficeResolvedScopeFromRuntimeScope(
  scope: Extract<BackofficeContextScope, { kind: "org" }>,
  organization: BackofficeOrganizationIdentity,
): Extract<BackofficeResolvedScope, { kind: "org" }>;
export function backofficeResolvedScopeFromRuntimeScope(
  scope: Extract<BackofficeContextScope, { kind: "project" }>,
  organization: BackofficeOrganizationIdentity,
): Extract<BackofficeResolvedScope, { kind: "project" }>;
export function backofficeResolvedScopeFromRuntimeScope(
  scope: BackofficeRoutableScope,
  organization: BackofficeOrganizationIdentity | null,
): BackofficeRoutableResolvedScope;
export function backofficeResolvedScopeFromRuntimeScope(
  scope: BackofficeContextScope,
  organization: BackofficeOrganizationIdentity | null,
): BackofficeResolvedScope;
/** Reattaches canonical organization metadata to an ID-backed runtime scope. */
export function backofficeResolvedScopeFromRuntimeScope(
  scope: BackofficeContextScope,
  organization: BackofficeOrganizationIdentity | null,
): BackofficeResolvedScope {
  if (scope.kind === "org" || scope.kind === "project") {
    if (!organization || organization.id !== scope.orgId) {
      throw new Error("Backoffice resolved scope requires the scoped organization identity.");
    }
    return scope.kind === "org"
      ? { kind: "org", organization }
      : { kind: "project", organization, projectId: scope.projectId };
  }
  return scope;
}

export function resolveBackofficeRuntimeScope(
  scope: Extract<BackofficeContextScope, { kind: "org" }>,
  resolveOrganization: ResolveBackofficeOrganizationIdentity,
): Promise<Extract<BackofficeResolvedScope, { kind: "org" }>>;
export function resolveBackofficeRuntimeScope(
  scope: Extract<BackofficeContextScope, { kind: "project" }>,
  resolveOrganization: ResolveBackofficeOrganizationIdentity,
): Promise<Extract<BackofficeResolvedScope, { kind: "project" }>>;
export function resolveBackofficeRuntimeScope(
  scope: BackofficeRoutableScope,
  resolveOrganization: ResolveBackofficeOrganizationIdentity,
): Promise<BackofficeRoutableResolvedScope>;
export function resolveBackofficeRuntimeScope(
  scope: BackofficeContextScope,
  resolveOrganization: ResolveBackofficeOrganizationIdentity,
): Promise<BackofficeResolvedScope>;
/** Resolves ID-backed runtime identity into the canonical identity needed by public routes. */
export async function resolveBackofficeRuntimeScope(
  scope: BackofficeContextScope,
  resolveOrganization: ResolveBackofficeOrganizationIdentity,
): Promise<BackofficeResolvedScope> {
  const organization =
    scope.kind === "org" || scope.kind === "project"
      ? await resolveOrganization(scope.orgId)
      : null;
  return backofficeResolvedScopeFromRuntimeScope(scope, organization);
}

/** Returns the stable ID-backed identity used for persisted scope-selection history and option IDs. */
export function backofficeResolvedScopeId(scope: BackofficeResolvedScope): string {
  switch (scope.kind) {
    case "system":
      return "system:system";
    case "org":
      return `org:${scope.organization.id}`;
    case "project":
      return `project:${scope.organization.id}:${scope.projectId}`;
    case "user":
      return `user:${scope.userId}`;
  }
  throw new Error("Unsupported Backoffice resolved scope kind.");
}
