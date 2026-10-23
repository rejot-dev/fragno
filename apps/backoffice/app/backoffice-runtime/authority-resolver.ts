import {
  automationEntityRefsEqual,
  type AutomationActors,
} from "@fragno-dev/backoffice-api/v0/automation";
import {
  allBackofficePermissionRequirements,
  type BackofficePermissionRequirement,
} from "@fragno-dev/backoffice-api/v0/shared/permissions";
import {
  type BackofficeContextScope,
  backofficeScopeContains,
  backofficeScopeOrganization,
} from "@fragno-dev/backoffice-api/v0/shared/scope";

import {
  type BackofficeExecutionContext,
  type BackofficeRequestExecution,
} from "@/backoffice-runtime/context";
import type { AdministeredMember, UserAuthorityFacts } from "@/fragno/auth/contracts";
import { automationRouteIdFromActor } from "@/fragno/automation/authority";

import {
  backofficeScopeOtherUserId,
  type BackofficeUserAuthority,
  getBackofficeAuthorityRoleGrants,
  resolveBackofficeInternalServiceAuthorityRole,
  resolveBackofficeUserAuthorityRole,
} from "./authority-roles";

/**
 * Resolves the current authority of the identities named by trusted Backoffice provenance.
 *
 * The kernel calls this resolver for every sensitive invocation. Implementations may trust
 * unexpired authority from a verified access token or consult current authoritative state when no
 * token authority exists. Event actor provenance is never proof of permission. Throwing means
 * authority could not be established and causes the kernel to deny as `authority-unavailable`.
 */
export type BackofficeAuthorityResolver = {
  /**
   * Returns the permissions recognized for the human or service principal on this execution scope.
   * Operations limit which authority sources need resolving; omit them to inspect the full catalog.
   * An empty result means the principal has no authority for the requested action.
   */
  resolvePrincipalPermissions(
    input: {
      principal: NonNullable<AutomationActors["principal"]>;
      execution: BackofficeExecutionContext;
    },
    operations?: readonly BackofficePermissionRequirement[],
  ): Promise<readonly BackofficePermissionRequirement[]>;

  /**
   * Returns the capabilities currently granted to one delegate or assistant in the provenance
   * chain. The kernel requires every delegated actor to independently cover the requested action,
   * so delegation can restrict authority but cannot increase the principal's authority.
   */
  resolveActorCapabilityGrants(input: {
    actor: AutomationActors["delegation"][number];
    execution: BackofficeExecutionContext;
  }): Promise<readonly BackofficePermissionRequirement[]>;
};

/** The production identity lookup used when execution has no verified access-token authority. */
/**
 * Overrides one trusted delegate's grants for a specific runtime boundary.
 *
 * The grants remain runtime configuration: they are neither accepted from workflow input nor
 * persisted in actor provenance.
 */
export const withBackofficeActorCapabilityGrants = ({
  resolver,
  actor,
  grants,
}: {
  resolver: BackofficeAuthorityResolver;
  actor: AutomationActors["delegation"][number];
  grants: readonly BackofficePermissionRequirement[];
}): BackofficeAuthorityResolver => ({
  resolvePrincipalPermissions: async (input, operations) =>
    await resolver.resolvePrincipalPermissions(input, operations),
  resolveActorCapabilityGrants: async (input) =>
    automationEntityRefsEqual(input.actor, actor)
      ? grants
      : await resolver.resolveActorCapabilityGrants(input),
});

export type BackofficeIdentityDirectory = {
  getUserAuthorityFacts(input: {
    userId: string;
    organizationId?: string;
  }): Promise<UserAuthorityFacts>;
  findAdministeredMember(input: {
    administratorId: string;
    memberId: string;
  }): Promise<AdministeredMember | null>;
};

/**
 * Live: the other user owning the scope, when this user owns or administers an organization that
 * user belongs to. No Auth read happens in scopes this user owns or that no user owns.
 */
export async function resolveAdministeredMemberId(
  identities: Pick<BackofficeIdentityDirectory, "findAdministeredMember">,
  userId: string,
  scope: BackofficeContextScope,
): Promise<string | null> {
  const otherUserId = backofficeScopeOtherUserId(userId, scope);
  if (otherUserId === null) {
    return null;
  }
  const member = await identities.findAdministeredMember({
    administratorId: userId,
    memberId: otherUserId,
  });
  return member?.userId ?? null;
}

const noPermissions = [] as const satisfies readonly BackofficePermissionRequirement[];

type CreateBackofficeAuthorityResolverOptions = {
  now?: () => number;
};

const resolveUserAuthorityPermissions = (
  authority: BackofficeUserAuthority,
  execution: BackofficeExecutionContext,
): readonly BackofficePermissionRequirement[] => {
  const role = resolveBackofficeUserAuthorityRole(authority, execution.scope);
  return role ? getBackofficeAuthorityRoleGrants(role) : noPermissions;
};

const resolveVerifiedRequestAuthorityPermissions = ({
  principal,
  execution,
  now,
}: {
  principal: NonNullable<AutomationActors["principal"]>;
  execution: BackofficeRequestExecution;
  now: number;
}): readonly BackofficePermissionRequirement[] => {
  const authority = execution.userAuthority;
  if (
    authority.userId !== principal.id ||
    authority.expiresAtEpochMs <= now ||
    (authority.scopeRestriction &&
      !backofficeScopeContains(authority.scopeRestriction, execution.scope))
  ) {
    return noPermissions;
  }

  return resolveUserAuthorityPermissions(authority, execution);
};

/**
 * Resolves authority from verified access-token claims or current production identity state.
 *
 * Immediate user-request actions trust the role and organization snapshot in the verified JWT
 * until its expiry, and the administered member their execution boundary verified, avoiding an Auth
 * round-trip for each sensitive action.
 * Deferred executions carry no token authority and instead reevaluate current user state through
 * the identity directory. Trusted runtime actor types resolve to explicit roles with only the finite
 * grants in `authority-roles.ts`.
 */
export const createBackofficeAuthorityResolver = (
  identities: BackofficeIdentityDirectory,
  options: CreateBackofficeAuthorityResolverOptions = {},
): BackofficeAuthorityResolver => {
  const now = options.now ?? Date.now;

  return {
    async resolvePrincipalPermissions({ principal, execution }) {
      if (automationRouteIdFromActor(principal)) {
        return noPermissions;
      }

      const serviceRole = resolveBackofficeInternalServiceAuthorityRole(principal);
      if (serviceRole) {
        return getBackofficeAuthorityRoleGrants(serviceRole);
      }

      if (principal.scope !== "internal" || principal.type !== "user") {
        return noPermissions;
      }

      if (execution.kind === "request") {
        return resolveVerifiedRequestAuthorityPermissions({
          principal,
          execution,
          now: now(),
        });
      }

      const organizationId = backofficeScopeOrganization(execution.scope)?.orgId;
      const [currentUser, administeredMemberId] = await Promise.all([
        identities.getUserAuthorityFacts({
          userId: principal.id,
          ...(organizationId ? { organizationId } : {}),
        }),
        resolveAdministeredMemberId(identities, principal.id, execution.scope),
      ]);
      if (!currentUser.active || !currentUser.role) {
        return noPermissions;
      }

      return resolveUserAuthorityPermissions(
        {
          userId: principal.id,
          role: currentUser.role,
          organizationId: organizationId && currentUser.organizationMember ? organizationId : null,
          administeredMemberId,
        },
        execution,
      );
    },

    async resolveActorCapabilityGrants({ actor }) {
      if (actor.role === "delegate" && automationRouteIdFromActor(actor)) {
        return noPermissions;
      }

      const role = resolveBackofficeInternalServiceAuthorityRole(actor);
      return role ? getBackofficeAuthorityRoleGrants(role) : noPermissions;
    },
  };
};

/**
 * Explicitly denies all sensitive actions because no authority source is available.
 *
 * Use this for constrained runtimes that can perform structural kernel operations but must fail
 * closed if they reach `kernel.invoke()`.
 */
export const unavailableBackofficeAuthorityResolver: BackofficeAuthorityResolver = {
  async resolvePrincipalPermissions() {
    throw new Error("Backoffice authority source is unavailable.");
  },
  async resolveActorCapabilityGrants() {
    throw new Error("Backoffice authority source is unavailable.");
  },
};

/**
 * Grants every principal and delegated actor unrestricted authority.
 *
 * Use only in tests and trusted system shells whose authorization is established outside the
 * membership model. Production request and durable-action runtimes must use a resolver backed by
 * current identity state.
 */
export const unrestrictedBackofficeAuthorityResolver: BackofficeAuthorityResolver = {
  async resolvePrincipalPermissions() {
    return allBackofficePermissionRequirements;
  },
  async resolveActorCapabilityGrants() {
    return allBackofficePermissionRequirements;
  },
};
