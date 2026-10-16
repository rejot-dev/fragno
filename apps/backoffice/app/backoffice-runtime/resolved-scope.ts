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

import type { BackofficeRoutableRouteScope, BackofficeRouteScope } from "./route-scope";

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

/** Resolves untrusted URL slugs into the organization and project they name. */
export async function resolveBackofficeRouteScope<
  TOrganization extends BackofficeOrganizationIdentity,
  TProject extends BackofficeProjectIdentity,
>(
  routeScope: BackofficeRouteScope,
  lookups: {
    organizations: readonly TOrganization[];
    findProject(organization: TOrganization, projectSlug: string): Promise<TProject | null>;
  },
): Promise<BackofficeRouteScopeResolution<TOrganization, TProject>> {
  const reference = backofficeScopeOrganization(routeScope);
  const organization = reference
    ? lookups.organizations.find(({ slug }) => slug === reference.orgSlug)
    : undefined;
  if (reference && !organization) {
    return { status: "organization-not-found", orgSlug: reference.orgSlug };
  }
  const project =
    routeScope.kind === "project" && organization
      ? await lookups.findProject(organization, routeScope.projectSlug)
      : null;
  if (routeScope.kind === "project" && !project) {
    return { status: "project-not-found", projectSlug: routeScope.projectSlug };
  }
  return {
    status: "resolved",
    // The map only visits names the lookups above found.
    scope: mapBackofficeScopeNames(routeScope, {
      organization: () => ({ organization: organization! }),
      project: () => ({ project: project! }),
    }),
  };
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
  return mapBackofficeScopeNames(scope, {
    organization: ({ organization }) => ({ orgId: organization.id }),
    project: ({ project }) => ({ projectId: project.id }),
  });
}

export function backofficeRouteScopeFromResolvedScope(
  scope: BackofficeRoutableResolvedScope,
): BackofficeRoutableRouteScope;
export function backofficeRouteScopeFromResolvedScope(
  scope: BackofficeResolvedScope,
): BackofficeRouteScope;
/** Converts authenticated resolved identity into the slug-backed scope of page URLs. */
export function backofficeRouteScopeFromResolvedScope(
  scope: BackofficeResolvedScope,
): BackofficeRouteScope {
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
