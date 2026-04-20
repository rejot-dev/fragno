import type { Cursor } from "@fragno-dev/db/cursor";

import type { DatabaseServiceContext } from "@fragno-dev/db";

import type { AuthHooksMap } from "../hooks";
import { authSchema } from "../schema";
import type { Role } from "../types";
import { mapUserSummary } from "../user/summary";
import { canManageOrganization, isGlobalAdmin, OWNER_ROLE } from "./permissions";
import type {
  Organization,
  OrganizationConfig,
  OrganizationMember,
  OrganizationMemberSummary,
} from "./types";
import { DEFAULT_MEMBER_ROLES, normalizeRoleNames, toExternalId } from "./utils";

type AuthServiceContext = DatabaseServiceContext<AuthHooksMap>;

type CreateMemberInput = {
  organizationId: string;
  userId: string;
  roles?: readonly string[];
  actor: { userId: string; userRole: Role };
};

type ListOrganizationMembersWithSessionParams = {
  sessionId: string;
  organizationId: string;
  pageSize: number;
  cursor?: Cursor;
};

type CreateOrganizationMemberWithSessionParams = {
  sessionId: string;
  organizationId: string;
  userId: string;
  roles?: readonly string[];
};

type UpdateOrganizationMemberWithSessionParams = {
  sessionId: string;
  organizationId: string;
  memberId: string;
  roles: readonly string[];
};

type DeleteOrganizationMemberWithSessionParams = {
  sessionId: string;
  organizationId: string;
  memberId: string;
};

type OrganizationMemberServiceOptions = {
  organizationConfig?: OrganizationConfig<string>;
};

const mapOrganization = (organization: {
  id: unknown;
  name: string;
  slug: string;
  logoUrl: string | null;
  metadata: unknown;
  createdBy: unknown;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}): Organization => ({
  id: toExternalId(organization.id),
  name: organization.name,
  slug: organization.slug,
  logoUrl: organization.logoUrl ?? null,
  metadata: (organization.metadata ?? null) as Record<string, unknown> | null,
  createdBy: toExternalId(organization.createdBy),
  createdAt: organization.createdAt,
  updatedAt: organization.updatedAt,
  deletedAt: organization.deletedAt ?? null,
});

const mapMember = (
  member: {
    id: unknown;
    organizationId: unknown;
    userId: unknown;
    createdAt: Date;
    updatedAt: Date;
  },
  roles: string[],
  overrides?: { organizationId?: string; userId?: string },
): OrganizationMember<string> => ({
  id: toExternalId(member.id),
  organizationId: overrides?.organizationId ?? toExternalId(member.organizationId),
  userId: overrides?.userId ?? toExternalId(member.userId),
  roles,
  createdAt: member.createdAt,
  updatedAt: member.updatedAt,
});

const mapMemberSummary = (
  member: {
    id: unknown;
    organizationId: unknown;
    userId: unknown;
    createdAt: Date;
    updatedAt: Date;
  },
  overrides?: { organizationId?: string; userId?: string },
): OrganizationMemberSummary => ({
  id: toExternalId(member.id),
  organizationId: overrides?.organizationId ?? toExternalId(member.organizationId),
  userId: overrides?.userId ?? toExternalId(member.userId),
  createdAt: member.createdAt,
  updatedAt: member.updatedAt,
});

const filterRolesForMemberId = (
  roles: {
    role: string;
    memberId: unknown;
    organizationMemberRoleMember?: { id?: unknown } | null;
  }[],
  member: { id?: unknown; _internalId?: unknown } | null,
) => {
  if (!member) {
    return [];
  }
  const candidates = new Set([member.id, member._internalId].filter(Boolean).map(toExternalId));
  return roles
    .filter(
      (role) =>
        candidates.has(toExternalId(role.memberId)) ||
        (role.organizationMemberRoleMember &&
          candidates.has(toExternalId(role.organizationMemberRoleMember.id))),
    )
    .map((role) => role.role);
};

const filterOwnerMemberIds = (
  roles: {
    role: string;
    memberId: unknown;
    organizationMemberRoleMember?: { organizationId: unknown } | null;
  }[],
  organizationInternalId: unknown,
) => {
  const ids = new Set<string>();
  for (const role of roles) {
    const member = role.organizationMemberRoleMember;
    if (member && String(member.organizationId) === String(organizationInternalId)) {
      ids.add(toExternalId(role.memberId));
    }
  }
  return ids;
};

const resolveInternalId = (value: unknown): string | bigint | undefined => {
  if (value && typeof value === "object") {
    if ("internalId" in value) {
      return (value as { internalId?: bigint }).internalId;
    }
    if ("databaseId" in value) {
      return (value as { databaseId?: string | bigint }).databaseId;
    }
  }
  return undefined;
};

const normalizeMany = <T>(value: T | T[] | null | undefined): T[] => {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
};

const extractRoles = (value: unknown): string[] => {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map((role) => (role as { role: string }).role);
  }
  if (typeof value === "object" && "role" in value) {
    return [(value as { role: string }).role];
  }
  return [];
};

const collectRolesByMemberId = (
  roles: Array<{
    role: string;
    memberId: unknown;
    organizationMemberRoleMember?: { id?: unknown } | null;
  }>,
  allowedMemberIds?: Set<string>,
): Record<string, string[]> => {
  const rolesByMemberId = new Map<string, Set<string>>();

  for (const role of roles) {
    const memberId = role.organizationMemberRoleMember?.id
      ? toExternalId(role.organizationMemberRoleMember.id)
      : toExternalId(role.memberId);

    if (allowedMemberIds && !allowedMemberIds.has(memberId)) {
      continue;
    }

    const existing = rolesByMemberId.get(memberId) ?? new Set<string>();
    existing.add(role.role);
    rolesByMemberId.set(memberId, existing);
  }

  const result: Record<string, string[]> = {};
  for (const [memberId, roleSet] of rolesByMemberId) {
    result[memberId] = Array.from(roleSet);
  }

  return result;
};

const matchesOrganizationId = (left: unknown, right: unknown): boolean => {
  const leftInternal = resolveInternalId(left);
  const rightInternal = resolveInternalId(right);
  if (leftInternal !== undefined && rightInternal !== undefined) {
    return String(leftInternal) === String(rightInternal);
  }
  return toExternalId(left) === toExternalId(right);
};

export function createOrganizationMemberServices(options: OrganizationMemberServiceOptions = {}) {
  const limits = options.organizationConfig?.limits;
  const defaultMemberRoles = options.organizationConfig?.defaultMemberRoles;
  return {
    /**
     * Fetch a member record for a user within an organization.
     */
    getOrganizationMemberByUser: function (
      this: AuthServiceContext,
      params: { organizationId: string; userId: string },
    ) {
      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow.findFirst("organizationMember", (b) =>
            b.whereIndex("idx_org_member_org_user", (eb) =>
              eb.and(
                eb("organizationId", "=", params.organizationId),
                eb("userId", "=", params.userId),
              ),
            ),
          ),
        )
        .transformRetrieve(([member]) =>
          member
            ? mapMemberSummary({
                id: member.id,
                organizationId: member.organizationId,
                userId: member.userId,
                createdAt: member.createdAt,
                updatedAt: member.updatedAt,
              })
            : null,
        )
        .build();
    },

    /**
     * Create an organization member with permission checks.
     */
    createOrganizationMember: function (this: AuthServiceContext, input: CreateMemberInput) {
      const roles = normalizeRoleNames(input.roles, defaultMemberRoles ?? DEFAULT_MEMBER_ROLES);
      const now = new Date();

      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow
            .findFirst("organizationMember", (b) =>
              b.whereIndex("idx_org_member_org_user", (eb) =>
                eb.and(
                  eb("organizationId", "=", input.organizationId),
                  eb("userId", "=", input.userId),
                ),
              ),
            )
            .findFirst("organizationMember", (b) =>
              b
                .whereIndex("idx_org_member_org_user", (eb) =>
                  eb.and(
                    eb("organizationId", "=", input.organizationId),
                    eb("userId", "=", input.actor.userId),
                  ),
                )
                .joinOne("organizationMemberOrganization", "organization", (organization) =>
                  organization.onIndex("primary", (eb) =>
                    eb("id", "=", eb.parent("organizationId")),
                  ),
                ),
            )
            // NOTE: actorMember is resolved in the same retrieve phase, so we filter in memory.
            .find("organizationMemberRole", (b) =>
              b
                .whereIndex("primary")
                .joinOne("organizationMemberRoleMember", "organizationMember", (member) =>
                  member.onIndex("primary", (eb) => eb("id", "=", eb.parent("memberId"))),
                ),
            )
            .find("organizationMember", (b) =>
              b.whereIndex("idx_org_member_org", (eb) =>
                eb("organizationId", "=", input.organizationId),
              ),
            )
            .findFirst("user", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", input.actor.userId)),
            ),
        )
        .mutate(
          ({ uow, retrieveResult: [existing, actorMember, actorRoles, members, actorUser] }) => {
            if (existing) {
              return { ok: false as const, code: "member_already_exists" as const };
            }

            if (!actorMember) {
              return { ok: false as const, code: "permission_denied" as const };
            }

            const actorRoleNames = filterRolesForMemberId(actorRoles, actorMember);
            if (!isGlobalAdmin(input.actor.userRole) && !canManageOrganization(actorRoleNames)) {
              return { ok: false as const, code: "permission_denied" as const };
            }

            if (
              limits?.membersPerOrganization !== undefined &&
              members.length >= limits.membersPerOrganization
            ) {
              return { ok: false as const, code: "limit_reached" as const };
            }

            const memberId = uow.create("organizationMember", {
              organizationId: input.organizationId,
              userId: input.userId,
              createdAt: now,
              updatedAt: now,
            });

            for (const role of roles) {
              uow.create("organizationMemberRole", {
                memberId,
                role,
                createdAt: now,
              });
            }

            const organization = actorMember?.organizationMemberOrganization
              ? mapOrganization(actorMember.organizationMemberOrganization)
              : null;
            const member = mapMember(
              {
                id: memberId,
                organizationId: input.organizationId,
                userId: input.userId,
                createdAt: now,
                updatedAt: now,
              },
              roles,
            );
            const actorSummary = actorUser ? mapUserSummary(actorUser) : null;

            if (organization) {
              uow.triggerHook("onMemberAdded", {
                organization,
                member,
                actor: actorSummary,
              });
            }

            return {
              ok: true as const,
              member,
            };
          },
        )
        .build();
    },

    /**
     * Add a role to a member with permission checks.
     */
    createOrganizationMemberRole: function (
      this: AuthServiceContext,
      params: {
        organizationId: string;
        memberId: string;
        role: string;
        actor: { userId: string; userRole: Role };
      },
    ) {
      const roleNames = normalizeRoleNames([params.role], [params.role]);
      if (roleNames.length === 0) {
        return this.serviceTx(authSchema)
          .mutate(() => ({ ok: false as const, code: "invalid_role" as const }))
          .build();
      }

      const roleName = roleNames[0]!;
      const now = new Date();

      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow
            .findFirst("organizationMember", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", params.memberId)),
            )
            .find("organizationMemberRole", (b) =>
              b.whereIndex("idx_org_member_role_member", (eb) =>
                eb("memberId", "=", params.memberId),
              ),
            )
            .findFirst("organizationMember", (b) =>
              b
                .whereIndex("idx_org_member_org_user", (eb) =>
                  eb.and(
                    eb("organizationId", "=", params.organizationId),
                    eb("userId", "=", params.actor.userId),
                  ),
                )
                .joinOne("organizationMemberOrganization", "organization", (organization) =>
                  organization.onIndex("primary", (eb) =>
                    eb("id", "=", eb.parent("organizationId")),
                  ),
                ),
            )
            // NOTE: actorMember is resolved in the same retrieve phase, so we filter in memory.
            .find("organizationMemberRole", (b) =>
              b
                .whereIndex("primary")
                .joinOne("organizationMemberRoleMember", "organizationMember", (member) =>
                  member.onIndex("primary", (eb) => eb("id", "=", eb.parent("memberId"))),
                ),
            )
            .findFirst("user", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", params.actor.userId)),
            ),
        )
        .mutate(
          ({
            uow,
            retrieveResult: [member, existingRoles, actorMember, actorRoles, actorUser],
          }) => {
            if (!member) {
              return { ok: false as const, code: "member_not_found" as const };
            }

            if (
              actorMember &&
              String(member.organizationId) !== String(actorMember.organizationId)
            ) {
              return { ok: false as const, code: "member_not_found" as const };
            }

            if (!actorMember) {
              return { ok: false as const, code: "permission_denied" as const };
            }

            const actorRoleNames = filterRolesForMemberId(actorRoles, actorMember);
            if (!isGlobalAdmin(params.actor.userRole) && !canManageOrganization(actorRoleNames)) {
              return { ok: false as const, code: "permission_denied" as const };
            }

            const roleExists = existingRoles.some((entry) => entry.role === roleName);
            const nextRoles = roleExists
              ? existingRoles.map((entry) => entry.role)
              : [...existingRoles.map((entry) => entry.role), roleName];

            if (roleExists) {
              return {
                ok: true as const,
                member: mapMember(
                  {
                    id: member.id,
                    organizationId: member.organizationId,
                    userId: member.userId,
                    createdAt: member.createdAt,
                    updatedAt: member.updatedAt,
                  },
                  nextRoles,
                ),
              };
            }

            uow.create("organizationMemberRole", {
              memberId: params.memberId,
              role: roleName,
              createdAt: now,
            });

            uow.update("organizationMember", member.id, (b) => b.set({ updatedAt: now }).check());

            const organization = actorMember?.organizationMemberOrganization
              ? mapOrganization(actorMember.organizationMemberOrganization)
              : null;
            const actorSummary = actorUser ? mapUserSummary(actorUser) : null;
            const updatedMember = mapMember(
              {
                id: member.id,
                organizationId: member.organizationId,
                userId: member.userId,
                createdAt: member.createdAt,
                updatedAt: now,
              },
              nextRoles,
            );

            if (organization) {
              uow.triggerHook("onMemberRolesUpdated", {
                organization,
                member: updatedMember,
                actor: actorSummary,
              });
            }

            return {
              ok: true as const,
              member: updatedMember,
            };
          },
        )
        .build();
    },

    /**
     * Remove a role from a member with permission checks.
     */
    removeOrganizationMemberRole: function (
      this: AuthServiceContext,
      params: {
        organizationId: string;
        memberId: string;
        role: string;
        actor: { userId: string; userRole: Role };
      },
    ) {
      const roleNames = normalizeRoleNames([params.role], [params.role]);
      if (roleNames.length === 0) {
        return this.serviceTx(authSchema)
          .mutate(() => ({ ok: false as const, code: "invalid_role" as const }))
          .build();
      }

      const roleName = roleNames[0]!;

      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow
            .findFirst("organizationMember", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", params.memberId)),
            )
            .find("organizationMemberRole", (b) =>
              b.whereIndex("idx_org_member_role_member", (eb) =>
                eb("memberId", "=", params.memberId),
              ),
            )
            .findFirst("organizationMember", (b) =>
              b
                .whereIndex("idx_org_member_org_user", (eb) =>
                  eb.and(
                    eb("organizationId", "=", params.organizationId),
                    eb("userId", "=", params.actor.userId),
                  ),
                )
                .joinOne("organizationMemberOrganization", "organization", (organization) =>
                  organization.onIndex("primary", (eb) =>
                    eb("id", "=", eb.parent("organizationId")),
                  ),
                ),
            )
            // NOTE: actorMember is resolved in the same retrieve phase, so we filter in memory.
            .find("organizationMemberRole", (b) =>
              b
                .whereIndex("primary")
                .joinOne("organizationMemberRoleMember", "organizationMember", (member) =>
                  member.onIndex("primary", (eb) => eb("id", "=", eb.parent("memberId"))),
                ),
            )
            .find("organizationMemberRole", (b) =>
              b
                .whereIndex("idx_org_member_role_role", (eb) => eb("role", "=", OWNER_ROLE))
                .joinOne("organizationMemberRoleMember", "organizationMember", (member) =>
                  member.onIndex("primary", (eb) => eb("id", "=", eb.parent("memberId"))),
                ),
            )
            .findFirst("user", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", params.actor.userId)),
            ),
        )
        .mutate(
          ({
            uow,
            retrieveResult: [member, existingRoles, actorMember, actorRoles, ownerRoles, actorUser],
          }) => {
            if (!member) {
              return { ok: false as const, code: "member_not_found" as const };
            }

            if (
              actorMember &&
              String(member.organizationId) !== String(actorMember.organizationId)
            ) {
              return { ok: false as const, code: "member_not_found" as const };
            }

            if (!actorMember) {
              return { ok: false as const, code: "permission_denied" as const };
            }

            const actorRoleNames = filterRolesForMemberId(actorRoles, actorMember);
            if (!isGlobalAdmin(params.actor.userRole) && !canManageOrganization(actorRoleNames)) {
              return { ok: false as const, code: "permission_denied" as const };
            }

            const existingRole = existingRoles.find((entry) => entry.role === roleName);
            if (!existingRole) {
              return { ok: false as const, code: "role_not_found" as const };
            }

            if (roleName === OWNER_ROLE) {
              const ownerMemberIds = filterOwnerMemberIds(ownerRoles, member.organizationId);
              if (ownerMemberIds.size <= 1) {
                return { ok: false as const, code: "last_owner" as const };
              }
            }

            const now = new Date();
            uow.delete("organizationMemberRole", existingRole.id, (b) => b.check());
            uow.update("organizationMember", member.id, (b) => b.set({ updatedAt: now }).check());

            const nextRoles = existingRoles
              .filter((entry) => entry.id !== existingRole.id)
              .map((entry) => entry.role);

            const organization = actorMember?.organizationMemberOrganization
              ? mapOrganization(actorMember.organizationMemberOrganization)
              : null;
            const actorSummary = actorUser ? mapUserSummary(actorUser) : null;
            const updatedMember = mapMember(
              {
                id: member.id,
                organizationId: member.organizationId,
                userId: member.userId,
                createdAt: member.createdAt,
                updatedAt: now,
              },
              nextRoles,
            );

            if (organization) {
              uow.triggerHook("onMemberRolesUpdated", {
                organization,
                member: updatedMember,
                actor: actorSummary,
              });
            }

            return {
              ok: true as const,
              member: updatedMember,
            };
          },
        )
        .build();
    },

    /**
     * Replace a member's roles with a normalized set.
     */
    updateOrganizationMemberRoles: function (
      this: AuthServiceContext,
      params: {
        organizationId: string;
        memberId: string;
        roles: readonly string[];
        actor: { userId: string; userRole: Role };
      },
    ) {
      const nextRoles = normalizeRoleNames(params.roles, DEFAULT_MEMBER_ROLES);
      const now = new Date();

      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow
            .findFirst("organizationMember", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", params.memberId)),
            )
            .find("organizationMemberRole", (b) =>
              b.whereIndex("idx_org_member_role_member", (eb) =>
                eb("memberId", "=", params.memberId),
              ),
            )
            .findFirst("organizationMember", (b) =>
              b
                .whereIndex("idx_org_member_org_user", (eb) =>
                  eb.and(
                    eb("organizationId", "=", params.organizationId),
                    eb("userId", "=", params.actor.userId),
                  ),
                )
                .joinOne("organizationMemberOrganization", "organization", (organization) =>
                  organization.onIndex("primary", (eb) =>
                    eb("id", "=", eb.parent("organizationId")),
                  ),
                ),
            )
            // NOTE: actorMember is resolved in the same retrieve phase, so we filter in memory.
            .find("organizationMemberRole", (b) =>
              b
                .whereIndex("primary")
                .joinOne("organizationMemberRoleMember", "organizationMember", (member) =>
                  member.onIndex("primary", (eb) => eb("id", "=", eb.parent("memberId"))),
                ),
            )
            .find("organizationMemberRole", (b) =>
              b
                .whereIndex("idx_org_member_role_role", (eb) => eb("role", "=", OWNER_ROLE))
                .joinOne("organizationMemberRoleMember", "organizationMember", (member) =>
                  member.onIndex("primary", (eb) => eb("id", "=", eb.parent("memberId"))),
                ),
            )
            .findFirst("user", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", params.actor.userId)),
            ),
        )
        .mutate(
          ({
            uow,
            retrieveResult: [member, existingRoles, actorMember, actorRoles, ownerRoles, actorUser],
          }) => {
            if (!member) {
              return { ok: false as const, code: "member_not_found" as const };
            }

            if (
              actorMember &&
              String(member.organizationId) !== String(actorMember.organizationId)
            ) {
              return { ok: false as const, code: "member_not_found" as const };
            }

            if (!actorMember) {
              return { ok: false as const, code: "permission_denied" as const };
            }

            const actorRoleNames = filterRolesForMemberId(actorRoles, actorMember);
            if (!isGlobalAdmin(params.actor.userRole) && !canManageOrganization(actorRoleNames)) {
              return { ok: false as const, code: "permission_denied" as const };
            }

            const hadOwnerRole = existingRoles.some((role) => role.role === OWNER_ROLE);
            if (hadOwnerRole && !nextRoles.includes(OWNER_ROLE)) {
              const ownerMemberIds = filterOwnerMemberIds(ownerRoles, member.organizationId);
              if (ownerMemberIds.size <= 1) {
                return { ok: false as const, code: "last_owner" as const };
              }
            }

            for (const existing of existingRoles) {
              uow.delete("organizationMemberRole", existing.id, (b) => b.check());
            }

            for (const role of nextRoles) {
              uow.create("organizationMemberRole", {
                memberId: params.memberId,
                role,
                createdAt: now,
              });
            }

            uow.update("organizationMember", member.id, (b) => b.set({ updatedAt: now }).check());

            const organization = actorMember?.organizationMemberOrganization
              ? mapOrganization(actorMember.organizationMemberOrganization)
              : null;
            const actorSummary = actorUser ? mapUserSummary(actorUser) : null;
            const updatedMember = mapMember(
              {
                id: member.id,
                organizationId: member.organizationId,
                userId: member.userId,
                createdAt: member.createdAt,
                updatedAt: now,
              },
              nextRoles,
            );

            if (organization) {
              uow.triggerHook("onMemberRolesUpdated", {
                organization,
                member: updatedMember,
                actor: actorSummary,
              });
            }

            return {
              ok: true as const,
              member: updatedMember,
            };
          },
        )
        .build();
    },

    /**
     * Remove a member from an organization with permission checks.
     */
    removeOrganizationMember: function (
      this: AuthServiceContext,
      params: {
        organizationId: string;
        memberId: string;
        actor: { userId: string; userRole: Role };
      },
    ) {
      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow
            .findFirst("organizationMember", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", params.memberId)),
            )
            .find("organizationMemberRole", (b) =>
              b.whereIndex("idx_org_member_role_member", (eb) =>
                eb("memberId", "=", params.memberId),
              ),
            )
            .findFirst("organizationMember", (b) =>
              b
                .whereIndex("idx_org_member_org_user", (eb) =>
                  eb.and(
                    eb("organizationId", "=", params.organizationId),
                    eb("userId", "=", params.actor.userId),
                  ),
                )
                .joinOne("organizationMemberOrganization", "organization", (organization) =>
                  organization.onIndex("primary", (eb) =>
                    eb("id", "=", eb.parent("organizationId")),
                  ),
                ),
            )
            // NOTE: actorMember is resolved in the same retrieve phase, so we filter in memory.
            .find("organizationMemberRole", (b) =>
              b
                .whereIndex("primary")
                .joinOne("organizationMemberRoleMember", "organizationMember", (member) =>
                  member.onIndex("primary", (eb) => eb("id", "=", eb.parent("memberId"))),
                ),
            )
            .find("organizationMemberRole", (b) =>
              b
                .whereIndex("idx_org_member_role_role", (eb) => eb("role", "=", OWNER_ROLE))
                .joinOne("organizationMemberRoleMember", "organizationMember", (member) =>
                  member.onIndex("primary", (eb) => eb("id", "=", eb.parent("memberId"))),
                ),
            )
            .findFirst("user", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", params.actor.userId)),
            ),
        )
        .mutate(
          ({
            uow,
            retrieveResult: [member, roles, actorMember, actorRoles, ownerRoles, actorUser],
          }) => {
            if (!member) {
              return { ok: false as const, code: "member_not_found" as const };
            }

            if (
              actorMember &&
              String(member.organizationId) !== String(actorMember.organizationId)
            ) {
              return { ok: false as const, code: "member_not_found" as const };
            }

            if (!actorMember) {
              return { ok: false as const, code: "permission_denied" as const };
            }

            const isSelf = toExternalId(member.userId) === params.actor.userId;
            const actorRoleNames = filterRolesForMemberId(actorRoles, actorMember);
            if (
              !isSelf &&
              !isGlobalAdmin(params.actor.userRole) &&
              !canManageOrganization(actorRoleNames)
            ) {
              return { ok: false as const, code: "permission_denied" as const };
            }

            const hadOwnerRole = roles.some((role) => role.role === OWNER_ROLE);
            if (hadOwnerRole) {
              const ownerMemberIds = filterOwnerMemberIds(ownerRoles, member.organizationId);
              if (ownerMemberIds.size <= 1) {
                return { ok: false as const, code: "last_owner" as const };
              }
            }

            for (const role of roles) {
              uow.delete("organizationMemberRole", role.id, (b) => b.check());
            }

            uow.delete("organizationMember", member.id, (b) => b.check());
            const organization = actorMember?.organizationMemberOrganization
              ? mapOrganization(actorMember.organizationMemberOrganization)
              : null;
            const actorSummary = actorUser ? mapUserSummary(actorUser) : null;
            const removedMember = mapMember(
              {
                id: member.id,
                organizationId: member.organizationId,
                userId: member.userId,
                createdAt: member.createdAt,
                updatedAt: member.updatedAt,
              },
              roles.map((role) => role.role),
            );

            if (organization) {
              uow.triggerHook("onMemberRemoved", {
                organization,
                member: removedMember,
                actor: actorSummary,
              });
            }
            return { ok: true as const };
          },
        )
        .build();
    },

    /**
     * List organization members with cursor-based pagination.
     */
    listOrganizationMembers: function (
      this: AuthServiceContext,
      params: { organizationId: string; pageSize: number; cursor?: Cursor },
    ) {
      const { organizationId, cursor, pageSize } = params;
      const effectivePageSize = cursor ? cursor.pageSize : pageSize;
      const effectiveSortOrder = cursor ? cursor.orderDirection : "asc";

      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow.findWithCursor("organizationMember", (b) => {
            const query = b
              .whereIndex("idx_org_member_org", (eb) => eb("organizationId", "=", organizationId))
              .orderByIndex("idx_org_member_org", effectiveSortOrder)
              .pageSize(effectivePageSize)
              .joinOne("organizationMemberOrganization", "organization", (organization) =>
                organization.onIndex("primary", (eb) => eb("id", "=", eb.parent("organizationId"))),
              )
              .joinOne("organizationMemberUser", "user", (user) =>
                user.onIndex("primary", (eb) => eb("id", "=", eb.parent("userId"))),
              );

            return cursor ? query.after(cursor) : query;
          }),
        )
        .transformRetrieve(([result]) => {
          const members = result.items.map((member) =>
            mapMember(
              {
                id: member.id,
                organizationId: member.organizationId,
                userId: member.userId,
                createdAt: member.createdAt,
                updatedAt: member.updatedAt,
              },
              [],
              {
                organizationId: member.organizationMemberOrganization
                  ? toExternalId(member.organizationMemberOrganization.id)
                  : toExternalId(member.organizationId),
                userId: member.organizationMemberUser
                  ? toExternalId(member.organizationMemberUser.id)
                  : toExternalId(member.userId),
              },
            ),
          );

          return {
            members,
            cursor: result.cursor,
            hasNextPage: result.hasNextPage,
          };
        })
        .build();
    },

    /**
     * List roles for a single organization member.
     */
    listOrganizationMemberRoles: function (this: AuthServiceContext, memberId: string) {
      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow.find("organizationMemberRole", (b) =>
            b.whereIndex("idx_org_member_role_member", (eb) => eb("memberId", "=", memberId)),
          ),
        )
        .transformRetrieve(([roles]) => ({
          roles: roles.map((role) => role.role),
        }))
        .build();
    },

    /**
     * List roles for multiple organization members.
     */
    listOrganizationMemberRolesForMembers: function (
      this: AuthServiceContext,
      memberIds: readonly string[],
    ) {
      if (memberIds.length === 0) {
        return this.serviceTx(authSchema)
          .mutate(() => ({ rolesByMemberId: {} as Record<string, string[]> }))
          .build();
      }

      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow.find("organizationMemberRole", (b) =>
            b
              .whereIndex("idx_org_member_role_member", (eb) =>
                memberIds.length === 1
                  ? eb("memberId", "=", memberIds[0])
                  : eb.or(...memberIds.map((memberId) => eb("memberId", "=", memberId))),
              )
              .joinOne("organizationMemberRoleMember", "organizationMember", (member) =>
                member.onIndex("primary", (eb) => eb("id", "=", eb.parent("memberId"))),
              ),
          ),
        )
        .transformRetrieve(([roles]) => {
          const rolesByMemberId: Record<string, string[]> = {};

          for (const role of roles) {
            const memberId = role.organizationMemberRoleMember
              ? toExternalId(role.organizationMemberRoleMember.id)
              : toExternalId(role.memberId);
            const list = rolesByMemberId[memberId] ?? [];
            list.push(role.role);
            rolesByMemberId[memberId] = list;
          }

          return { rolesByMemberId };
        })
        .build();
    },

    /**
     * List organization members for a session.
     */
    listOrganizationMembersWithSession: function (
      this: AuthServiceContext,
      params: ListOrganizationMembersWithSessionParams,
    ) {
      const { sessionId, organizationId, cursor } = params;
      const effectivePageSize = cursor ? cursor.pageSize : params.pageSize;
      const effectiveSortOrder = cursor ? cursor.orderDirection : "asc";

      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow
            .find("session", (b) =>
              b
                .whereIndex("idx_session_id_expiresAt", (eb) =>
                  eb.and(eb("id", "=", sessionId), eb("expiresAt", ">", eb.now())),
                )
                .joinMany("sessionMembers", "organizationMember", (member) =>
                  member.onIndex("idx_org_member_user", (eb) =>
                    eb("userId", "=", eb.parent("userId")),
                  ),
                ),
            )
            .findFirst("session", (b) =>
              b.whereIndex("idx_session_id_expiresAt", (eb) =>
                eb.and(eb("id", "=", sessionId), eb("expiresAt", "<=", eb.now())),
              ),
            )
            .findFirst("organization", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", organizationId)),
            )
            .findWithCursor("organizationMember", (b) => {
              let query = b
                .whereIndex("idx_org_member_org", (eb) => eb("organizationId", "=", organizationId))
                .orderByIndex("idx_org_member_org", effectiveSortOrder)
                .pageSize(effectivePageSize)
                .joinOne("organizationMemberOrganization", "organization", (organization) =>
                  organization.onIndex("primary", (eb) =>
                    eb("id", "=", eb.parent("organizationId")),
                  ),
                )
                .joinOne("organizationMemberUser", "user", (user) =>
                  user.onIndex("primary", (eb) => eb("id", "=", eb.parent("userId"))),
                );

              return cursor ? query.after(cursor) : query;
            })
            .find("organizationMemberRole", (b) =>
              b
                .whereIndex("idx_org_member_role_member")
                .joinOne("organizationMemberRoleMember", "organizationMember", (member) =>
                  member
                    .onIndex("primary", (eb) => eb("id", "=", eb.parent("memberId")))
                    .whereIndex("idx_org_member_org", (eb) =>
                      eb("organizationId", "=", organizationId),
                    ),
                ),
            ),
        )
        .mutate(
          ({ uow, retrieveResult: [sessions, expiredSession, organization, members, roles] }) => {
            if (expiredSession) {
              uow.delete("session", expiredSession.id, (b) => b.check());
            }

            const session = sessions[0] ?? null;
            if (!session) {
              return { ok: false as const, code: "session_invalid" as const };
            }

            if (!organization || organization.deletedAt != null) {
              return { ok: false as const, code: "organization_not_found" as const };
            }

            const sessionMembers = normalizeMany(session.sessionMembers);
            const hasMembership = sessionMembers.some((member) =>
              matchesOrganizationId(member.organizationId, organization.id),
            );

            if (!hasMembership) {
              return { ok: false as const, code: "permission_denied" as const };
            }

            const memberIds = new Set(members.items.map((member) => toExternalId(member.id)));
            const rolesByMemberId = collectRolesByMemberId(roles, memberIds);

            const mappedMembers = members.items.map((member) => {
              const resolvedMemberId = toExternalId(member.id);
              const roles = rolesByMemberId[resolvedMemberId] ?? [];
              const joinedOrganization = (
                member as { organizationMemberOrganization?: { id: unknown } }
              ).organizationMemberOrganization;
              const joinedUser = (member as { organizationMemberUser?: { id: unknown } })
                .organizationMemberUser;
              const resolvedOrganizationId = joinedOrganization
                ? toExternalId(joinedOrganization.id)
                : toExternalId(member.organizationId);
              const resolvedUserId = joinedUser
                ? toExternalId(joinedUser.id)
                : toExternalId(member.userId);

              return mapMember(
                {
                  id: member.id,
                  organizationId: member.organizationId,
                  userId: member.userId,
                  createdAt: member.createdAt,
                  updatedAt: member.updatedAt,
                },
                roles,
                {
                  organizationId: resolvedOrganizationId,
                  userId: resolvedUserId,
                },
              );
            });

            return {
              ok: true as const,
              members: mappedMembers,
              cursor: members.cursor?.encode(),
              hasNextPage: members.hasNextPage,
            };
          },
        )
        .build();
    },

    /**
     * Create a member using session permissions.
     */
    createOrganizationMemberWithSession: function (
      this: AuthServiceContext,
      params: CreateOrganizationMemberWithSessionParams,
    ) {
      const roles = normalizeRoleNames(params.roles, defaultMemberRoles ?? DEFAULT_MEMBER_ROLES);

      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow
            .findFirst("session", (b) =>
              b
                .whereIndex("idx_session_id_expiresAt", (eb) =>
                  eb.and(eb("id", "=", params.sessionId), eb("expiresAt", ">", eb.now())),
                )
                .joinOne("sessionOwner", "user", (owner) =>
                  owner
                    .onIndex("primary", (eb) => eb("id", "=", eb.parent("userId")))
                    .select(["id", "email", "role", "bannedAt"]),
                )
                .joinMany("sessionMembers", "organizationMember", (member) =>
                  member
                    .onIndex("idx_org_member_user", (eb) => eb("userId", "=", eb.parent("userId")))
                    .joinMany("organizationMemberRoles", "organizationMemberRole", (role) =>
                      role.onIndex("idx_org_member_role_member", (eb) =>
                        eb("memberId", "=", eb.parent("id")),
                      ),
                    ),
                ),
            )
            .findFirst("session", (b) =>
              b.whereIndex("idx_session_id_expiresAt", (eb) =>
                eb.and(eb("id", "=", params.sessionId), eb("expiresAt", "<=", eb.now())),
              ),
            )
            .findFirst("organization", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", params.organizationId)),
            )
            .findFirst("organizationMember", (b) =>
              b.whereIndex("idx_org_member_org_user", (eb) =>
                eb.and(
                  eb("organizationId", "=", params.organizationId),
                  eb("userId", "=", params.userId),
                ),
              ),
            )
            .find("organizationMember", (b) =>
              b.whereIndex("idx_org_member_org", (eb) =>
                eb("organizationId", "=", params.organizationId),
              ),
            ),
        )
        .mutate(
          ({
            uow,
            retrieveResult: [session, expiredSession, organization, existingMember, members],
          }) => {
            if (expiredSession) {
              uow.delete("session", expiredSession.id, (b) => b.check());
            }

            if (!session || !session.sessionOwner) {
              return { ok: false as const, code: "session_invalid" as const };
            }

            if (!organization || organization.deletedAt != null) {
              return { ok: false as const, code: "organization_not_found" as const };
            }

            if (existingMember) {
              return { ok: false as const, code: "member_already_exists" as const };
            }

            const actorMember = normalizeMany(session.sessionMembers).find((member) =>
              matchesOrganizationId(member.organizationId, organization.id),
            );

            if (!actorMember) {
              return { ok: false as const, code: "permission_denied" as const };
            }

            const actorRoles = extractRoles(
              (actorMember as { organizationMemberRoles?: unknown }).organizationMemberRoles,
            );
            if (
              !isGlobalAdmin(session.sessionOwner.role as Role) &&
              !canManageOrganization(actorRoles)
            ) {
              return { ok: false as const, code: "permission_denied" as const };
            }

            if (
              limits?.membersPerOrganization !== undefined &&
              members.length >= limits.membersPerOrganization
            ) {
              return { ok: false as const, code: "limit_reached" as const };
            }

            const now = new Date();
            const memberId = uow.create("organizationMember", {
              organizationId: params.organizationId,
              userId: params.userId,
              createdAt: now,
              updatedAt: now,
            });

            for (const role of roles) {
              uow.create("organizationMemberRole", {
                memberId,
                role,
                createdAt: now,
              });
            }

            const organizationSummary = mapOrganization({
              id: organization.id,
              name: organization.name,
              slug: organization.slug,
              logoUrl: organization.logoUrl ?? null,
              metadata: organization.metadata ?? null,
              createdBy: organization.createdBy,
              createdAt: organization.createdAt,
              updatedAt: organization.updatedAt,
              deletedAt: organization.deletedAt ?? null,
            });
            const memberSummary = mapMember(
              {
                id: memberId,
                organizationId: organization.id,
                userId: params.userId,
                createdAt: now,
                updatedAt: now,
              },
              roles,
              {
                organizationId: toExternalId(organization.id),
                userId: params.userId,
              },
            );
            const actorSummary = mapUserSummary({
              id: session.sessionOwner.id,
              email: session.sessionOwner.email,
              role: session.sessionOwner.role,
              bannedAt: session.sessionOwner.bannedAt ?? null,
            });

            uow.triggerHook("onMemberAdded", {
              organization: organizationSummary,
              member: memberSummary,
              actor: actorSummary,
            });

            return {
              ok: true as const,
              member: memberSummary,
            };
          },
        )
        .build();
    },

    /**
     * Update member roles using session permissions.
     */
    updateOrganizationMemberRolesWithSession: function (
      this: AuthServiceContext,
      params: UpdateOrganizationMemberWithSessionParams,
    ) {
      const nextRoles = normalizeRoleNames(params.roles, DEFAULT_MEMBER_ROLES);

      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow
            .findFirst("session", (b) =>
              b
                .whereIndex("idx_session_id_expiresAt", (eb) =>
                  eb.and(eb("id", "=", params.sessionId), eb("expiresAt", ">", eb.now())),
                )
                .joinOne("sessionOwner", "user", (owner) =>
                  owner
                    .onIndex("primary", (eb) => eb("id", "=", eb.parent("userId")))
                    .select(["id", "email", "role", "bannedAt"]),
                )
                .joinMany("sessionMembers", "organizationMember", (member) =>
                  member
                    .onIndex("idx_org_member_user", (eb) => eb("userId", "=", eb.parent("userId")))
                    .joinOne("organizationMemberOrganization", "organization", (organization) =>
                      organization.onIndex("primary", (eb) =>
                        eb("id", "=", eb.parent("organizationId")),
                      ),
                    )
                    .joinMany("organizationMemberRoles", "organizationMemberRole", (role) =>
                      role.onIndex("idx_org_member_role_member", (eb) =>
                        eb("memberId", "=", eb.parent("id")),
                      ),
                    ),
                ),
            )
            .findFirst("session", (b) =>
              b.whereIndex("idx_session_id_expiresAt", (eb) =>
                eb.and(eb("id", "=", params.sessionId), eb("expiresAt", "<=", eb.now())),
              ),
            )
            .findFirst("organizationMember", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", params.memberId)),
            )
            .find("organizationMemberRole", (b) =>
              b.whereIndex("idx_org_member_role_member", (eb) =>
                eb("memberId", "=", params.memberId),
              ),
            )
            .find("organizationMemberRole", (b) =>
              b
                .whereIndex("idx_org_member_role_role", (eb) => eb("role", "=", OWNER_ROLE))
                .joinOne("organizationMemberRoleMember", "organizationMember", (member) =>
                  member.onIndex("primary", (eb) => eb("id", "=", eb.parent("memberId"))),
                ),
            ),
        )
        .mutate(
          ({
            uow,
            retrieveResult: [session, expiredSession, member, existingRoles, ownerRoles],
          }) => {
            if (expiredSession) {
              uow.delete("session", expiredSession.id, (b) => b.check());
            }

            if (!session || !session.sessionOwner) {
              return { ok: false as const, code: "session_invalid" as const };
            }

            if (!member) {
              return { ok: false as const, code: "member_not_found" as const };
            }

            const actorMember = normalizeMany(session.sessionMembers).find((entry) => {
              const entryOrganizationId = (
                entry as { organizationMemberOrganization?: { id: unknown } }
              ).organizationMemberOrganization?.id;
              return matchesOrganizationId(
                entryOrganizationId ?? entry.organizationId,
                params.organizationId,
              );
            });

            if (
              actorMember &&
              !matchesOrganizationId(
                member.organizationId,
                (actorMember as { organizationMemberOrganization?: { id: unknown } })
                  .organizationMemberOrganization?.id ?? actorMember.organizationId,
              )
            ) {
              return { ok: false as const, code: "member_not_found" as const };
            }

            if (!actorMember) {
              return { ok: false as const, code: "permission_denied" as const };
            }

            const actorRoles = extractRoles(
              (actorMember as { organizationMemberRoles?: unknown }).organizationMemberRoles,
            );
            if (
              !isGlobalAdmin(session.sessionOwner.role as Role) &&
              !canManageOrganization(actorRoles)
            ) {
              return { ok: false as const, code: "permission_denied" as const };
            }

            const hadOwnerRole = existingRoles.some((role) => role.role === OWNER_ROLE);
            if (hadOwnerRole && !nextRoles.includes(OWNER_ROLE)) {
              const ownerMemberIds = new Set<string>();
              for (const role of ownerRoles) {
                const ownerMember = (
                  role as { organizationMemberRoleMember?: { organizationId: unknown } }
                ).organizationMemberRoleMember;
                if (
                  ownerMember &&
                  matchesOrganizationId(ownerMember.organizationId, member.organizationId)
                ) {
                  ownerMemberIds.add(toExternalId(role.memberId));
                }
              }

              if (ownerMemberIds.size <= 1) {
                return { ok: false as const, code: "last_owner" as const };
              }
            }

            for (const existing of existingRoles) {
              uow.delete("organizationMemberRole", existing.id, (b) => b.check());
            }

            const now = new Date();
            for (const role of nextRoles) {
              uow.create("organizationMemberRole", {
                memberId: member.id,
                role,
                createdAt: now,
              });
            }

            uow.update("organizationMember", member.id, (b) => b.set({ updatedAt: now }).check());

            const organization = (
              actorMember as {
                organizationMemberOrganization?: {
                  id: unknown;
                  name: string;
                  slug: string;
                  logoUrl: string | null;
                  metadata: unknown;
                  createdBy: unknown;
                  createdAt: Date;
                  updatedAt: Date;
                  deletedAt: Date | null;
                };
              }
            ).organizationMemberOrganization;
            const organizationSummary = organization
              ? mapOrganization({
                  id: organization.id,
                  name: organization.name,
                  slug: organization.slug,
                  logoUrl: organization.logoUrl ?? null,
                  metadata: organization.metadata ?? null,
                  createdBy: organization.createdBy,
                  createdAt: organization.createdAt,
                  updatedAt: organization.updatedAt,
                  deletedAt: organization.deletedAt ?? null,
                })
              : null;

            const actorSummary = mapUserSummary({
              id: session.sessionOwner.id,
              email: session.sessionOwner.email,
              role: session.sessionOwner.role,
              bannedAt: session.sessionOwner.bannedAt ?? null,
            });

            const updatedMember = mapMember(
              {
                id: member.id,
                organizationId: member.organizationId,
                userId: member.userId,
                createdAt: member.createdAt,
                updatedAt: now,
              },
              nextRoles,
            );

            if (organizationSummary) {
              uow.triggerHook("onMemberRolesUpdated", {
                organization: organizationSummary,
                member: updatedMember,
                actor: actorSummary,
              });
            }

            return {
              ok: true as const,
              member: updatedMember,
            };
          },
        )
        .build();
    },

    /**
     * Remove a member using session permissions.
     */
    deleteOrganizationMemberWithSession: function (
      this: AuthServiceContext,
      params: DeleteOrganizationMemberWithSessionParams,
    ) {
      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow
            .findFirst("session", (b) =>
              b
                .whereIndex("idx_session_id_expiresAt", (eb) =>
                  eb.and(eb("id", "=", params.sessionId), eb("expiresAt", ">", eb.now())),
                )
                .joinOne("sessionOwner", "user", (owner) =>
                  owner
                    .onIndex("primary", (eb) => eb("id", "=", eb.parent("userId")))
                    .select(["id", "email", "role", "bannedAt"]),
                )
                .joinMany("sessionMembers", "organizationMember", (member) =>
                  member
                    .onIndex("idx_org_member_user", (eb) => eb("userId", "=", eb.parent("userId")))
                    .joinOne("organizationMemberOrganization", "organization", (organization) =>
                      organization.onIndex("primary", (eb) =>
                        eb("id", "=", eb.parent("organizationId")),
                      ),
                    )
                    .joinMany("organizationMemberRoles", "organizationMemberRole", (role) =>
                      role.onIndex("idx_org_member_role_member", (eb) =>
                        eb("memberId", "=", eb.parent("id")),
                      ),
                    ),
                ),
            )
            .findFirst("session", (b) =>
              b.whereIndex("idx_session_id_expiresAt", (eb) =>
                eb.and(eb("id", "=", params.sessionId), eb("expiresAt", "<=", eb.now())),
              ),
            )
            .findFirst("organizationMember", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", params.memberId)),
            )
            .find("organizationMemberRole", (b) =>
              b.whereIndex("idx_org_member_role_member", (eb) =>
                eb("memberId", "=", params.memberId),
              ),
            )
            .find("organizationMemberRole", (b) =>
              b
                .whereIndex("idx_org_member_role_role", (eb) => eb("role", "=", OWNER_ROLE))
                .joinOne("organizationMemberRoleMember", "organizationMember", (member) =>
                  member.onIndex("primary", (eb) => eb("id", "=", eb.parent("memberId"))),
                ),
            ),
        )
        .mutate(({ uow, retrieveResult: [session, expiredSession, member, roles, ownerRoles] }) => {
          if (expiredSession) {
            uow.delete("session", expiredSession.id, (b) => b.check());
          }

          if (!session || !session.sessionOwner) {
            return { ok: false as const, code: "session_invalid" as const };
          }

          if (!member) {
            return { ok: false as const, code: "member_not_found" as const };
          }

          const actorMember = normalizeMany(session.sessionMembers).find((entry) => {
            const entryOrganizationId = (
              entry as { organizationMemberOrganization?: { id: unknown } }
            ).organizationMemberOrganization?.id;
            return matchesOrganizationId(
              entryOrganizationId ?? entry.organizationId,
              params.organizationId,
            );
          });

          if (
            actorMember &&
            !matchesOrganizationId(
              member.organizationId,
              (actorMember as { organizationMemberOrganization?: { id: unknown } })
                .organizationMemberOrganization?.id ?? actorMember.organizationId,
            )
          ) {
            return { ok: false as const, code: "member_not_found" as const };
          }

          if (!actorMember) {
            return { ok: false as const, code: "permission_denied" as const };
          }

          const isSelf = toExternalId(member.userId) === toExternalId(session.sessionOwner.id);
          const actorRoles = extractRoles(
            (actorMember as { organizationMemberRoles?: unknown }).organizationMemberRoles,
          );
          if (
            !isSelf &&
            !isGlobalAdmin(session.sessionOwner.role as Role) &&
            !canManageOrganization(actorRoles)
          ) {
            return { ok: false as const, code: "permission_denied" as const };
          }

          const hadOwnerRole = roles.some((role) => role.role === OWNER_ROLE);
          if (hadOwnerRole) {
            const ownerMemberIds = new Set<string>();
            for (const role of ownerRoles) {
              const ownerMember = (
                role as { organizationMemberRoleMember?: { organizationId: unknown } }
              ).organizationMemberRoleMember;
              if (
                ownerMember &&
                matchesOrganizationId(ownerMember.organizationId, member.organizationId)
              ) {
                ownerMemberIds.add(toExternalId(role.memberId));
              }
            }

            if (ownerMemberIds.size <= 1) {
              return { ok: false as const, code: "last_owner" as const };
            }
          }

          for (const role of roles) {
            uow.delete("organizationMemberRole", role.id, (b) => b.check());
          }

          uow.delete("organizationMember", member.id, (b) => b.check());

          const organization = (
            actorMember as {
              organizationMemberOrganization?: {
                id: unknown;
                name: string;
                slug: string;
                logoUrl: string | null;
                metadata: unknown;
                createdBy: unknown;
                createdAt: Date;
                updatedAt: Date;
                deletedAt: Date | null;
              };
            }
          ).organizationMemberOrganization;
          const organizationSummary = organization
            ? mapOrganization({
                id: organization.id,
                name: organization.name,
                slug: organization.slug,
                logoUrl: organization.logoUrl ?? null,
                metadata: organization.metadata ?? null,
                createdBy: organization.createdBy,
                createdAt: organization.createdAt,
                updatedAt: organization.updatedAt,
                deletedAt: organization.deletedAt ?? null,
              })
            : null;

          const actorSummary = mapUserSummary({
            id: session.sessionOwner.id,
            email: session.sessionOwner.email,
            role: session.sessionOwner.role,
            bannedAt: session.sessionOwner.bannedAt ?? null,
          });

          const removedMember = mapMember(
            {
              id: member.id,
              organizationId: member.organizationId,
              userId: member.userId,
              createdAt: member.createdAt,
              updatedAt: member.updatedAt,
            },
            roles.map((role) => role.role),
          );

          if (organizationSummary) {
            uow.triggerHook("onMemberRemoved", {
              organization: organizationSummary,
              member: removedMember,
              actor: actorSummary,
            });
          }

          return { ok: true as const };
        })
        .build();
    },
  };
}
