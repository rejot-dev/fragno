import type {
  AutomationDelegatedActor,
  AutomationExecutionContext,
  AutomationPrincipalActor,
} from "@/fragno/automation/actors";

import { getBackofficeAuthorityRoleGrants, type BackofficeAuthorityRole } from "./authority-roles";
import {
  allBackofficePermissionRequirements,
  type BackofficePermissionRequirement,
} from "./permissions";

/**
 * Resolves the current authority of the identities named by trusted automation provenance.
 *
 * The kernel calls this resolver for every sensitive invocation. Implementations must consult
 * current authoritative state rather than treating the event's actor provenance as proof of
 * permission. Throwing means authority could not be established and causes the kernel to deny the
 * action as `authority-unavailable`.
 */
export type BackofficeAuthorityResolver = {
  /**
   * Returns the permissions currently held by the human or service principal on this execution
   * scope. An empty result means the principal has no authority for the requested action.
   */
  resolvePrincipalPermissions(input: {
    principal: AutomationPrincipalActor;
    execution: AutomationExecutionContext;
  }): Promise<readonly BackofficePermissionRequirement[]>;

  /**
   * Returns the capabilities currently granted to one delegate or assistant in the provenance
   * chain. The kernel requires every delegated actor to independently cover the requested action,
   * so delegation can restrict authority but cannot increase the principal's authority.
   */
  resolveActorCapabilityGrants(input: {
    actor: AutomationDelegatedActor;
    execution: AutomationExecutionContext;
  }): Promise<readonly BackofficePermissionRequirement[]>;
};

/** The production identity lookup used to reevaluate organization membership on each action. */
export type BackofficeMembershipDirectory = {
  hasOrganizationMembership(input: { organizationId: string; userId: string }): Promise<boolean>;
};

const noPermissions = [] as const satisfies readonly BackofficePermissionRequirement[];

const resolveDelegatedActorAuthorityRole = (
  actor: AutomationDelegatedActor,
): BackofficeAuthorityRole | null => {
  if (actor.scope !== "internal") {
    return null;
  }

  switch (actor.type) {
    case "automation":
    case "agent":
    case "capability":
    case "object":
    case "system":
      return actor.type;
    default:
      return null;
  }
};

/**
 * Resolves current authority from production-owned identity sources.
 *
 * Organization and project authority is intentionally derived from the current Auth membership on
 * every call. Membership and trusted runtime actor types resolve to explicit Backoffice roles; each
 * role grants only the finite permissions listed in `authority-roles.ts`.
 */
export const createBackofficeAuthorityResolver = (
  memberships: BackofficeMembershipDirectory,
): BackofficeAuthorityResolver => ({
  async resolvePrincipalPermissions({ principal, execution }) {
    if (principal.scope !== "internal" || principal.type !== "user") {
      return noPermissions;
    }

    if (execution.scope.kind === "user") {
      return execution.scope.userId === principal.id
        ? getBackofficeAuthorityRoleGrants("user-owner")
        : noPermissions;
    }

    if (execution.scope.kind !== "org" && execution.scope.kind !== "project") {
      return noPermissions;
    }

    const isMember = await memberships.hasOrganizationMembership({
      organizationId: execution.scope.orgId,
      userId: principal.id,
    });
    return isMember ? getBackofficeAuthorityRoleGrants("organization-member") : noPermissions;
  },

  async resolveActorCapabilityGrants({ actor }) {
    const role = resolveDelegatedActorAuthorityRole(actor);
    return role ? getBackofficeAuthorityRoleGrants(role) : noPermissions;
  },
});

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
