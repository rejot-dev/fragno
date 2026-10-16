import {
  type BackofficeContextScope,
  type BackofficePublicScope,
  type BackofficeRoutable,
  type BackofficeRoutableScope,
  type BackofficeScope,
  backofficeScopeOrganization,
  backofficeScopePathSegment,
  mapBackofficeScopeNames,
} from "@fragno-dev/backoffice-api/v0/shared/scope";

import type { BackofficeRouteScope } from "./route-scope";

/** Canonical organization identity required to address both runtime services and public routes. */
export type BackofficeOrganizationIdentity = Readonly<{ id: string; slug: string }>;

/** Canonical project identity required to address both runtime services and page URLs. */
export type BackofficeProjectIdentity = Readonly<{ id: string; slug: string }>;

/** A project as Backoffice pages present it. */
export type BackofficeNamedProject = BackofficeProjectIdentity & Readonly<{ name: string }>;

/** Authenticated Backoffice scope with the organization and project its URL slugs name. */
export type BackofficeResolvedScope<
  TOrganization extends BackofficeOrganizationIdentity = BackofficeOrganizationIdentity,
  TProject extends BackofficeProjectIdentity = BackofficeProjectIdentity,
> = BackofficeScope<{
  organization: { organization: TOrganization };
  project: { project: TProject };
}>;

/** Authenticated non-system scope resolved from an ordinary Backoffice route. */
export type BackofficeRoutableResolvedScope<
  TOrganization extends BackofficeOrganizationIdentity = BackofficeOrganizationIdentity,
  TProject extends BackofficeProjectIdentity = BackofficeProjectIdentity,
> = BackofficeRoutable<BackofficeResolvedScope<TOrganization, TProject>>;

/** Resolved Backoffice scope paired with the label presented by a scope selector. */
export type BackofficeScopeSelection = BackofficeResolvedScope & { label: string };

/** Non-system scope selection available to ordinary routable Backoffice workspaces. */
export type BackofficeRoutableScopeSelection = BackofficeRoutable<BackofficeScopeSelection>;

/** Projects a canonical organization record to the identity required by Backoffice scopes. */
export function backofficeOrganizationIdentity(
  organization: BackofficeOrganizationIdentity,
): BackofficeOrganizationIdentity {
  return { id: organization.id, slug: organization.slug };
}

/** Projects a canonical project record to the identity required by Backoffice scopes. */
export function backofficeProjectIdentity(
  project: BackofficeProjectIdentity,
): BackofficeProjectIdentity {
  return { id: project.id, slug: project.slug };
}

/** What a page URL's slugs name among the user's organizations and their projects. */
export type BackofficeRouteScopeResolution<
  TOrganization extends BackofficeOrganizationIdentity,
  TProject extends BackofficeProjectIdentity,
> =
  | { status: "resolved"; scope: BackofficeResolvedScope<TOrganization, TProject> }
  | { status: "organization-not-found"; orgSlug: string }
  | { status: "project-not-found"; projectSlug: string };

/** A resolved scope that can own projects. */
export type BackofficeResolvedProjectOwner<
  TOrganization extends BackofficeOrganizationIdentity = BackofficeOrganizationIdentity,
  TProject extends BackofficeProjectIdentity = BackofficeProjectIdentity,
> = Extract<BackofficeResolvedScope<TOrganization, TProject>, { kind: "project" }>["owner"];

/**
 * Resolves untrusted URL slugs into the organization and project they name. A project slug is
 * looked up with its owner, which stores it.
 */
export async function resolveBackofficeRouteScope<
  TOrganization extends BackofficeOrganizationIdentity,
  TProject extends BackofficeProjectIdentity,
>(
  routeScope: BackofficeRouteScope,
  lookups: {
    organizations: readonly TOrganization[];
    findProject(
      owner: BackofficeResolvedProjectOwner<TOrganization, TProject>,
      projectSlug: string,
    ): Promise<TProject | null>;
  },
): Promise<BackofficeRouteScopeResolution<TOrganization, TProject>> {
  const reference = backofficeScopeOrganization(routeScope);
  const organization = reference
    ? lookups.organizations.find(({ slug }) => slug === reference.orgSlug)
    : undefined;
  if (reference && !organization) {
    return { status: "organization-not-found", orgSlug: reference.orgSlug };
  }
  // The map only visits names the lookups found: the organization above, the project below.
  const resolvedNames = (project: TProject | null) => ({
    organization: () => ({ organization: organization! }),
    project: () => ({ project: project! }),
  });
  if (routeScope.kind !== "project") {
    return { status: "resolved", scope: mapBackofficeScopeNames(routeScope, resolvedNames(null)) };
  }
  const owner = mapBackofficeScopeNames(routeScope.owner, resolvedNames(null));
  const project = await lookups.findProject(owner, routeScope.projectSlug);
  if (!project) {
    return { status: "project-not-found", projectSlug: routeScope.projectSlug };
  }
  return { status: "resolved", scope: { kind: "project", owner, project } };
}

/** Converts authenticated resolved identity into the ID-backed scope accepted by runtime services. */
export function backofficeRuntimeScopeFromResolvedScope<TScope extends BackofficeResolvedScope>(
  scope: TScope,
): Extract<BackofficeContextScope, { kind: TScope["kind"] }> {
  return mapBackofficeScopeNames(scope, {
    organization: ({ organization }) => ({ orgId: organization.id }),
    project: ({ project }) => ({ projectId: project.id }),
  });
}

/** Converts authenticated resolved identity into the slug-backed scope of page URLs. */
export function backofficeRouteScopeFromResolvedScope<TScope extends BackofficeResolvedScope>(
  scope: TScope,
): Extract<BackofficeRouteScope, { kind: TScope["kind"] }> {
  return mapBackofficeScopeNames(scope, {
    organization: ({ organization }) => ({ orgSlug: organization.slug }),
    project: ({ project }) => ({ projectSlug: project.slug }),
  });
}

/** Names a runtime scope as public fragment URLs do, by organization slug and project ID. */
export function backofficePublicScopeFromRuntimeScope(
  scope: BackofficeRoutableScope,
  organization: BackofficeOrganizationIdentity | null,
): BackofficeRoutable<BackofficePublicScope> {
  return mapBackofficeScopeNames(scope, {
    organization: ({ orgId }) => {
      if (!organization || organization.id !== orgId) {
        throw new Error("Backoffice public scope requires the scoped organization identity.");
      }
      return { orgSlug: organization.slug };
    },
    project: ({ projectId }) => ({ projectId }),
  });
}

/** Returns the stable ID-backed identity that tells two scope selections apart. */
export function backofficeResolvedScopeId(scope: BackofficeResolvedScope): string {
  return backofficeScopePathSegment(backofficeRuntimeScopeFromResolvedScope(scope));
}
