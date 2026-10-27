import {
  backofficeContextScopesEqual,
  backofficeScopeOrganization,
  mapBackofficeScopeNames,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import {
  createContext,
  redirect,
  type RouterContext,
  type RouterContextProvider,
} from "react-router";

import type { BackofficeIdentityDirectory } from "@/backoffice-runtime/authority-resolver";
import { backofficeScopeOtherUserId } from "@/backoffice-runtime/authority-roles";
import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import { isBackofficeForbiddenError } from "@/backoffice-runtime/kernel";
import {
  backofficeOrganizationIdentity,
  backofficePersonalScope,
  backofficeProjectIdentity,
  type BackofficeNamedProject,
  backofficeRuntimeScopeFromResolvedScope,
  type BackofficeResolvedScope,
  type BackofficeRoutableScopeSelection,
  type BackofficeScopeSelection,
} from "@/backoffice-runtime/resolved-scope";
import {
  createBackofficeExecutionForPrincipal,
  routerContextIdentities,
} from "@/fragno/auth/backoffice-principal.server";
import { reopenWithBackofficeCredential } from "@/fragno/auth/browser-credential.server";
import type {
  AdministeredMember,
  BackofficeAuthPrincipal,
  BackofficeMeData,
  Organization,
} from "@/fragno/auth/contracts";
import { requireBackofficePrincipal } from "@/fragno/auth/request-auth.server";
import { recordBackofficeRequestScope } from "@/posthog.server";
import { toExternalId } from "@/routes/backoffice/automations/data";
import { lookupAutomationProject } from "@/routes/backoffice/automations/project-lookup.server";
import {
  BACKOFFICE_ONBOARDING_PATH,
  opensBeforeOnboarding,
} from "@/routes/backoffice/onboarding-path";
import {
  isBackofficeSystemAdministrator,
  projectScopeLabel,
  SYSTEM_SCOPE_LABEL,
  userScopeLabel,
} from "@/routes/backoffice/scope-labels";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import { getBackofficeAuthenticatedRequest } from "./backoffice-authenticated-request.server";
import { resolveBackofficePageScope } from "./backoffice-layout-scope";

type BackofficePageResolvedScope = BackofficeResolvedScope<Organization, BackofficeNamedProject>;

/**
 * The route's own scope: its URL scope, or the default scope on routes without one. Sections
 * require it, so a URL scope that does not resolve is their 404 or 502 rather than the shell's.
 */
type BackofficeRouteScope =
  | {
      status: "resolved";
      resolvedScope: BackofficePageResolvedScope;
      execution: BackofficeExecutionContext;
      selection: BackofficeScopeSelection;
    }
  | { status: "not-found" }
  | { status: "unavailable"; message: string };

/** Contains authenticated scope and authority established before Backoffice route handlers. */
export type BackofficeShellRequest = {
  me: BackofficeMeData;
  principal: BackofficeAuthPrincipal;
  /** The scope the shell renders: the route's own, or the default when the route's does not resolve. */
  resolvedScope: BackofficePageResolvedScope;
  /** Whose personal workspace the shell renders, when it is a member's the user administers. */
  administeredMember: AdministeredMember | null;
  route: BackofficeRouteScope;
  accessTokenExpiresAt: Date;
};

const backofficeShellRequestContextKey = Symbol.for("fragno.backoffice.shell-request-context");

/** Provides the authenticated shell scope established by Backoffice layout middleware. */
export const BackofficeShellRequestContext = ((globalThis as Record<symbol, unknown>)[
  backofficeShellRequestContextKey
] ??= createContext<BackofficeShellRequest>()) as RouterContext<BackofficeShellRequest>;

type BackofficeShellMiddlewareArgs = {
  request: Request;
  context: Readonly<RouterContextProvider>;
  url: URL;
  params: {
    scopeKind?: string;
    scopeId?: string;
    orgSlug?: string;
  };
};

/** Establishes the canonical authenticated scope before protected descendant route handlers run. */
export async function establishBackofficeShellRequest(
  args: BackofficeShellMiddlewareArgs,
  next: () => Promise<Response>,
): Promise<Response> {
  const { request, context, params, url } = args;
  const authenticatedRequest = getBackofficeAuthenticatedRequest(context);
  const { me } = authenticatedRequest;
  const personalScope = backofficePersonalScope(me.user);
  // Backoffice opens nothing in the person's own scope before onboarding chooses its jurisdiction.
  if (personalScope === null && !opensBeforeOnboarding(url.pathname)) {
    throw redirect(BACKOFFICE_ONBOARDING_PATH);
  }
  const principal = await requireBackofficePrincipal(request, context);
  const issuedPersonalScope = principal.user.personalScope;
  // The token names the personal scope as it was when issued, before onboarding created it.
  if (
    issuedPersonalScope === null || personalScope === null
      ? issuedPersonalScope !== personalScope
      : !backofficeContextScopesEqual(issuedPersonalScope, personalScope)
  ) {
    throw await reopenWithBackofficeCredential(args, { selection: "preferred" });
  }
  const activeOrganization = me.activeOrganization?.organization ?? null;
  // The token names an organization the user has since left.
  if (
    me.activeOrganizationId &&
    (!activeOrganization || activeOrganization.id !== me.activeOrganizationId)
  ) {
    throw await reopenWithBackofficeCredential(args, { selection: "preferred" });
  }

  // Every user has a personal scope, so it is the default even while an organization is active.
  const defaultScope: BackofficePageResolvedScope = {
    kind: "user",
    userId: me.user.id,
    jurisdiction: me.user.jurisdiction,
  };
  const administeredMembers = administeredMemberLookup(context);
  // A user enters their own personal scope and those of the members they administer.
  const findAdministeredMember = async (userId: string) =>
    await administeredMembers.findAdministeredMember({
      administratorId: me.user.id,
      memberId: userId,
    });
  // Throwing here would replace the whole layout; sections report the 502 from their loaders.
  let projectLookupFailure = null as string | null;
  const pageScope = await resolveBackofficePageScope({
    params,
    organizations: me.organizations.map(({ organization }) => organization),
    findUser: async (userId) => {
      if (userId === me.user.id) {
        return { userId, jurisdiction: me.user.jurisdiction };
      }
      const member = await findAdministeredMember(userId);
      return member && { userId, jurisdiction: member.jurisdiction };
    },
    isAppInstalled: async (owner, appId) => {
      const installation = await context
        .get(BackofficeWorkerContext)
        .runtime.objects.appInstallations.for(backofficeRuntimeScopeFromResolvedScope(owner))
        .commands.getInstallation({ appId });
      return installation?.status === "active";
    },
    findProject: async (owner, slug): Promise<BackofficeNamedProject | null> => {
      const lookup = await lookupAutomationProject(
        context,
        backofficeRuntimeScopeFromResolvedScope(owner),
        { slug },
      );
      if (lookup.status === "error") {
        projectLookupFailure = lookup.message;
        return null;
      }
      // An archived project is no longer a workspace.
      if (lookup.status === "not-found" || lookup.project.archivedAt) {
        return null;
      }
      return { id: toExternalId(lookup.project.id), slug, name: projectScopeLabel(lookup.project) };
    },
  });
  let routeScope: BackofficePageResolvedScope | null;
  switch (pageScope.status) {
    case "resolved":
      routeScope = pageScope.scope;
      break;
    case "absent":
      routeScope = defaultScope;
      break;
    case "invalid":
    case "organization-not-found":
    case "user-not-found":
    case "app-not-found":
    case "project-not-found":
      routeScope = null;
      break;
    default:
      throw new Error("Unsupported Backoffice page scope status.", {
        cause: pageScope satisfies never,
      });
  }
  // Sections hide System scope from everyone but system administrators, rather than refusing it.
  if (routeScope?.kind === "system" && !isBackofficeSystemAdministrator(me.user)) {
    routeScope = null;
  }
  const resolvedScope = routeScope ?? defaultScope;
  const administeredMemberId = backofficeScopeOtherUserId(me.user.id, resolvedScope);
  const administeredMember = administeredMemberId
    ? await findAdministeredMember(administeredMemberId)
    : null;

  const destinationOrganizationId =
    backofficeScopeOrganization(resolvedScope)?.organization.id ?? null;
  if (
    destinationOrganizationId &&
    destinationOrganizationId !== me.activeOrganizationId &&
    me.organizations.some(({ organization }) => organization.id === destinationOrganizationId)
  ) {
    throw await reopenWithBackofficeCredential(args, {
      selection: "required",
      organizationId: destinationOrganizationId,
    });
  }

  let route: BackofficeRouteScope = projectLookupFailure
    ? { status: "unavailable", message: projectLookupFailure }
    : { status: "not-found" };
  if (routeScope) {
    let execution: BackofficeExecutionContext;
    try {
      execution = await createBackofficeExecutionForPrincipal(
        principal,
        backofficeRuntimeScopeFromResolvedScope(routeScope),
        administeredMembers,
      );
    } catch (error) {
      if (isBackofficeForbiddenError(error)) {
        throw new Response(error.message, { status: 403 });
      }
      throw error;
    }
    recordBackofficeRequestScope(context, backofficeRuntimeScopeFromResolvedScope(routeScope));
    route = {
      status: "resolved",
      resolvedScope: routeScope,
      execution,
      selection: scopeSelectionOf(routeScope, administeredMember?.email ?? userScopeLabel(me.user)),
    };
  }

  context.set(BackofficeShellRequestContext, {
    me,
    principal,
    resolvedScope,
    administeredMember,
    route,
    accessTokenExpiresAt: authenticatedRequest.accessTokenExpiresAt,
  });
  return await next();
}

/** Asks Auth about each member at most once per request, however many checks name them. */
function administeredMemberLookup(
  context: Readonly<RouterContextProvider>,
): Pick<BackofficeIdentityDirectory, "findAdministeredMember"> {
  const identities = routerContextIdentities(context);
  const lookups = new Map<string, Promise<AdministeredMember | null>>();
  return {
    findAdministeredMember: async (input) => {
      const key = `${input.administratorId}:${input.memberId}`;
      let lookup = lookups.get(key);
      if (!lookup) {
        lookup = identities.findAdministeredMember(input);
        lookups.set(key, lookup);
      }
      return await lookup;
    },
  };
}

/** `personalScopeLabel` names the user whose personal scope the scope is or belongs to. */
function scopeSelectionOf(
  scope: BackofficePageResolvedScope,
  personalScopeLabel: string,
): BackofficeScopeSelection {
  return {
    ...mapBackofficeScopeNames(scope, {
      organization: ({ organization }) => ({
        organization: backofficeOrganizationIdentity(organization),
      }),
      user: ({ userId, jurisdiction }) => ({ userId, jurisdiction }),
      project: ({ project }) => ({ project: backofficeProjectIdentity(project) }),
    }),
    label: scopeSelectionLabel(scope, personalScopeLabel),
  };
}

function scopeSelectionLabel(
  scope: BackofficePageResolvedScope,
  personalScopeLabel: string,
): string {
  switch (scope.kind) {
    // The route's execution established that System scope belongs to an administrator.
    case "system":
      return SYSTEM_SCOPE_LABEL;
    case "org":
      return scope.organization.name ?? scope.organization.id;
    case "user":
      return personalScopeLabel;
    case "app":
      return scope.appId;
    case "project":
      return scope.project.name;
    default:
      throw new Error("Backoffice scope kind is unsupported.", { cause: scope satisfies never });
  }
}

function requireResolvedRoute(context: Readonly<RouterContextProvider>) {
  const { route } = getBackofficeShellRequest(context);
  switch (route.status) {
    case "resolved":
      return route;
    case "not-found":
      throw new Response("Not Found", { status: 404 });
    case "unavailable":
      throw new Response(route.message, { status: 502 });
    default:
      throw new Error("Backoffice route scope is unsupported.", { cause: route satisfies never });
  }
}

/**
 * The route's own scope with its label, or the section's 404 or 502. Thrown from a section loader,
 * the response renders in that section's error boundary inside the shell.
 */
export function requireScopeSelection(
  context: Readonly<RouterContextProvider>,
): BackofficeScopeSelection {
  return requireResolvedRoute(context).selection;
}

/** The route's own scope for sections that have no System scope. */
export function requireRoutableScopeSelection(
  context: Readonly<RouterContextProvider>,
): BackofficeRoutableScopeSelection {
  const selection = requireScopeSelection(context);
  if (selection.kind === "system") {
    throw new Response("Not Found", { status: 404 });
  }
  return selection;
}

/** The route's own scope and the authority to act in it. */
export function requireRouteScope(context: Readonly<RouterContextProvider>): {
  resolvedScope: BackofficePageResolvedScope;
  execution: BackofficeExecutionContext;
} {
  const { resolvedScope, execution } = requireResolvedRoute(context);
  return { resolvedScope, execution };
}

/** Reads authenticated scope guaranteed by the Backoffice layout middleware chain. */
export function getBackofficeShellRequest(
  context: Readonly<RouterContextProvider>,
): BackofficeShellRequest {
  return context.get(BackofficeShellRequestContext);
}
