import type { Role, UserAuthorityFacts } from "@fragno-dev/auth";

import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import type { AutomationActors } from "@/fragno/automation/actors";

import {
  getBackofficeAuthorityRoleGrants,
  resolveBackofficeInternalServiceAuthorityRole,
  resolveBackofficeUserAuthorityRole,
} from "./authority-roles";
import {
  allBackofficePermissionRequirements,
  type BackofficePermissionRequirement,
} from "./permissions";

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
   * An empty result means the principal has no authority for the requested action.
   */
  resolvePrincipalPermissions(input: {
    principal: NonNullable<AutomationActors["principal"]>;
    execution: BackofficeExecutionContext;
  }): Promise<readonly BackofficePermissionRequirement[]>;

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
export type BackofficeIdentityDirectory = {
  getUserAuthorityFacts(input: {
    userId: string;
    organizationId?: string;
  }): Promise<UserAuthorityFacts>;
};

const noPermissions = [] as const satisfies readonly BackofficePermissionRequirement[];

type CreateBackofficeAuthorityResolverOptions = {
  now?: () => number;
};

const resolveUserAuthorityPermissions = (
  authority: Readonly<{
    userId: string;
    role: Role;
    organizationIds: readonly string[];
  }>,
  execution: BackofficeExecutionContext,
): readonly BackofficePermissionRequirement[] => {
  const role = resolveBackofficeUserAuthorityRole(authority, execution.scope);
  return role ? getBackofficeAuthorityRoleGrants(role) : noPermissions;
};

const resolveVerifiedAccessTokenPermissions = ({
  principal,
  execution,
  now,
}: {
  principal: NonNullable<AutomationActors["principal"]>;
  execution: BackofficeExecutionContext;
  now: number;
}): readonly BackofficePermissionRequirement[] => {
  const authority = execution.userAuthority;
  if (!authority || authority.userId !== principal.id || authority.expiresAtEpochMs <= now) {
    return noPermissions;
  }

  return resolveUserAuthorityPermissions(authority, execution);
};

/**
 * Resolves authority from verified access-token claims or current production identity state.
 *
 * Immediate user-request actions trust the role and organization snapshot in the verified JWT until
 * its expiry, avoiding an Auth round-trip for each sensitive action. Deferred executions carry no
 * token authority and instead reevaluate current user state through the identity directory. Trusted
 * runtime actor types resolve to explicit roles with only the finite grants in `authority-roles.ts`.
 */
export const createBackofficeAuthorityResolver = (
  identities: BackofficeIdentityDirectory,
  options: CreateBackofficeAuthorityResolverOptions = {},
): BackofficeAuthorityResolver => {
  const now = options.now ?? Date.now;

  return {
    async resolvePrincipalPermissions({ principal, execution }) {
      const serviceRole = resolveBackofficeInternalServiceAuthorityRole(principal);
      if (serviceRole) {
        return getBackofficeAuthorityRoleGrants(serviceRole);
      }

      if (principal.scope !== "internal" || principal.type !== "user") {
        return noPermissions;
      }

      if (execution.userAuthority) {
        return resolveVerifiedAccessTokenPermissions({
          principal,
          execution,
          now: now(),
        });
      }

      const organizationId =
        execution.scope.kind === "org" || execution.scope.kind === "project"
          ? execution.scope.orgId
          : undefined;
      const currentUser = await identities.getUserAuthorityFacts({
        userId: principal.id,
        ...(organizationId ? { organizationId } : {}),
      });
      if (!currentUser.active || !currentUser.role) {
        return noPermissions;
      }

      return resolveUserAuthorityPermissions(
        {
          userId: principal.id,
          role: currentUser.role,
          organizationIds: organizationId && currentUser.organizationMember ? [organizationId] : [],
        },
        execution,
      );
    },

    async resolveActorCapabilityGrants({ actor }) {
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
