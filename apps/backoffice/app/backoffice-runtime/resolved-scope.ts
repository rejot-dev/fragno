import {
  type BackofficeContextScope,
  type BackofficePublicScope,
  type BackofficeRoutable,
  type BackofficeRootOwner,
  type BackofficeRoutableScope,
  type BackofficeJurisdiction,
  type BackofficeOrganizationContextScope,
  type BackofficeScope,
  type BackofficeScopeIdNames,
  type BackofficeScopeReferenceNames,
  type BackofficeUserContextScope,
  backofficeScopePathSegment,
  backofficeScopeRootOwner,
  mapBackofficeScopeNames,
} from "@fragno-dev/backoffice-api/v0/shared/scope";

import type { AuthCommands } from "./object-registry";
import type { BackofficeRouteScope } from "./route-scope";

/** Canonical organization identity required to address both runtime services and public routes. */
export type BackofficeOrganizationIdentity = Readonly<{
  id: string;
  slug: string;
  jurisdiction: BackofficeJurisdiction | null;
}>;

/** A user as their personal scope names them at runtime. */
export type BackofficeUserIdentity = Readonly<BackofficeScopeIdNames["user"]>;

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
  user: BackofficeUserIdentity;
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

/** The runtime scope of an organization record. */
export function backofficeOrganizationContextScope(
  organization: Pick<BackofficeOrganizationIdentity, "id" | "jurisdiction">,
): BackofficeOrganizationContextScope {
  return { kind: "org", orgId: organization.id, jurisdiction: organization.jurisdiction };
}

/**
 * A user's personal scope, which exists once onboarding has fixed where it is kept. Nothing may
 * open it before then: an object made in it would stay in the jurisdiction it was made in.
 */
export function backofficePersonalScope(user: {
  id: string;
  jurisdiction: BackofficeJurisdiction | null;
  // Auth's stored rows hold the raw column; only whether it is set matters here.
  onboardedAt: Date | string | number | null;
}): BackofficeUserContextScope | null {
  return user.onboardedAt === null
    ? null
    : { kind: "user", userId: user.id, jurisdiction: user.jurisdiction };
}

/** A root owner named by ID alone, as work that stored only the ID remembers it. */
export type BackofficeRootOwnerReference = BackofficeRootOwner<BackofficeScopeReferenceNames>;

/** Finds a root owner's scope, jurisdiction included; null when it does not exist. */
export type BackofficeRootOwnerResolver = (
  owner: BackofficeRootOwnerReference,
) => Promise<BackofficeRootOwner<BackofficeScopeIdNames> | null>;

/**
 * Looks up the scope of an organization that work remembered only by ID. Auth keeps the
 * organization's jurisdiction, so nothing else stores a copy of it.
 */
export async function lookupOrganizationContextScope(
  auth: Pick<AuthCommands, "findRootOwnerScope">,
  organizationId: string,
): Promise<BackofficeOrganizationContextScope | null> {
  const owner = await auth.findRootOwnerScope({ kind: "org", orgId: organizationId });
  return owner?.kind === "org" ? owner : null;
}

/** Projects a canonical organization record to the identity required by Backoffice scopes. */
export function backofficeOrganizationIdentity(
  organization: BackofficeOrganizationIdentity,
): BackofficeOrganizationIdentity {
  return { id: organization.id, slug: organization.slug, jurisdiction: organization.jurisdiction };
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
  | { status: "user-not-found"; userId: string }
  | { status: "app-not-found"; appId: string }
  | { status: "project-not-found"; projectSlug: string };

/** What resolving a page URL looks up beyond the user's organizations. */
export type BackofficeRouteScopeLookups<
  TOrganization extends BackofficeOrganizationIdentity,
  TProject extends BackofficeProjectIdentity,
> = {
  organizations: readonly TOrganization[];
  /** A user whose personal scope may be entered; others are not found, so they cannot be probed. */
  findUser(userId: string): Promise<BackofficeUserIdentity | null>;
  // An app's owner names no project, so this lookup does not infer the project type.
  isAppInstalled(
    owner: Extract<BackofficeResolvedScope<TOrganization>, { kind: "app" }>["owner"],
    appId: string,
  ): Promise<boolean>;
  findProject(
    owner: BackofficeResolvedProjectOwner<TOrganization, TProject>,
    projectSlug: string,
  ): Promise<TProject | null>;
};

/** A resolved scope that can own projects. */
export type BackofficeResolvedProjectOwner<
  TOrganization extends BackofficeOrganizationIdentity = BackofficeOrganizationIdentity,
  TProject extends BackofficeProjectIdentity = BackofficeProjectIdentity,
> = Extract<BackofficeResolvedScope<TOrganization, TProject>, { kind: "project" }>["owner"];

/**
 * Resolves untrusted URL slugs into the organization and project they name. An app's workspace
 * exists while the app is installed, and a project slug is looked up with its owner, which stores it.
 */
export async function resolveBackofficeRouteScope<
  TOrganization extends BackofficeOrganizationIdentity,
  TProject extends BackofficeProjectIdentity,
>(
  routeScope: BackofficeRouteScope,
  lookups: BackofficeRouteScopeLookups<TOrganization, TProject>,
): Promise<BackofficeRouteScopeResolution<TOrganization, TProject>> {
  const rootOwner = backofficeScopeRootOwner(routeScope);
  let organization: TOrganization | null = null;
  let user: BackofficeUserIdentity | null = null;
  if (rootOwner?.kind === "org") {
    organization = lookups.organizations.find(({ slug }) => slug === rootOwner.orgSlug) ?? null;
    if (!organization) {
      return { status: "organization-not-found", orgSlug: rootOwner.orgSlug };
    }
  } else if (rootOwner?.kind === "user") {
    user = await lookups.findUser(rootOwner.userId);
    if (!user) {
      return { status: "user-not-found", userId: rootOwner.userId };
    }
  }
  // The map only visits names the lookups found: the root owner above, the project below.
  const resolvedNames = (project: TProject | null) => ({
    organization: () => ({ organization: organization! }),
    user: () => user!,
    project: () => ({ project: project! }),
  });
  const workspace = routeScope.kind === "project" ? routeScope.owner : routeScope;
  if (
    workspace.kind === "app" &&
    !(await lookups.isAppInstalled(
      mapBackofficeScopeNames(workspace.owner, resolvedNames(null)),
      workspace.appId,
    ))
  ) {
    return { status: "app-not-found", appId: workspace.appId };
  }
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
    organization: ({ organization }) => ({
      orgId: organization.id,
      jurisdiction: organization.jurisdiction,
    }),
    user: ({ userId, jurisdiction }) => ({ userId, jurisdiction }),
    project: ({ project }) => ({ projectId: project.id }),
  });
}

/** Converts authenticated resolved identity into the slug-backed scope of page URLs. */
export function backofficeRouteScopeFromResolvedScope<TScope extends BackofficeResolvedScope>(
  scope: TScope,
): Extract<BackofficeRouteScope, { kind: TScope["kind"] }> {
  return mapBackofficeScopeNames(scope, {
    organization: ({ organization }) => ({ orgSlug: organization.slug }),
    user: ({ userId }) => ({ userId }),
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
    user: ({ userId }) => ({ userId }),
    project: ({ projectId }) => ({ projectId }),
  });
}

/** Returns the stable ID-backed identity that tells two scope selections apart. */
export function backofficeResolvedScopeId(scope: BackofficeResolvedScope): string {
  return backofficeScopePathSegment(backofficeRuntimeScopeFromResolvedScope(scope));
}
