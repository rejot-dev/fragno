import type { DatabaseServiceContext } from "@fragno-dev/db";
import type { Cursor } from "@fragno-dev/db/cursor";
import type { AuthHooksMap } from "../hooks";
import { authSchema } from "../schema";
import type { Organization, OrganizationConfig, OrganizationMember } from "./types";
import {
  DEFAULT_CREATOR_ROLES,
  normalizeOrganizationSlug,
  normalizeRoleNames,
  toExternalId,
} from "./utils";
import { canDeleteOrganization, canManageOrganization, isGlobalAdmin } from "./permissions";
import type { Role } from "../types";
import { mapUserSummary } from "../user/summary";

type AuthServiceContext = DatabaseServiceContext<AuthHooksMap>;

type CreateOrganizationInput = {
  name: string;
  slug: string;
  creatorUserId: string;
  creatorUserRole: Role;
  logoUrl?: string | null;
  metadata?: Record<string, unknown> | null;
  creatorRoles?: readonly string[];
  sessionId?: string;
};

type OrganizationServiceOptions = {
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

export function createOrganizationServices(options: OrganizationServiceOptions = {}) {
  const organizationConfig = options.organizationConfig;
  const allowUserToCreateOrganization = organizationConfig?.allowUserToCreateOrganization;
  const limits = organizationConfig?.limits;
  const defaultCreatorRoles = organizationConfig?.creatorRoles;

  const resolveAllowUserToCreateOrganization = async (ctx: { userId: string; userRole: Role }) => {
    if (allowUserToCreateOrganization === undefined) {
      return true;
    }
    if (typeof allowUserToCreateOrganization === "boolean") {
      return allowUserToCreateOrganization;
    }
    return allowUserToCreateOrganization(ctx);
  };

  return {
    /**
     * Create a new organization and creator membership.
     */
    createOrganization: function (this: AuthServiceContext, input: CreateOrganizationInput) {
      const normalizedSlug = normalizeOrganizationSlug(input.slug);
      if (!normalizedSlug) {
        return this.serviceTx(authSchema)
          .mutate(() => ({
            ok: false as const,
            code: "invalid_slug" as const,
          }))
          .build();
      }

      const creatorRoles = normalizeRoleNames(
        input.creatorRoles ?? defaultCreatorRoles,
        DEFAULT_CREATOR_ROLES,
      );
      const now = new Date();

      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow
            .findFirst("organization", (b) =>
              b.whereIndex("idx_organization_slug", (eb) => eb("slug", "=", normalizedSlug)),
            )
            .find("organizationMember", (b) =>
              b.whereIndex("idx_org_member_user", (eb) => eb("userId", "=", input.creatorUserId)),
            )
            .findFirst("session", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", input.sessionId ?? "")),
            )
            .findFirst("user", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", input.creatorUserId)),
            ),
        )
        .mutate(async ({ uow, retrieveResult: [existing, members, session, creatorUser] }) => {
          if (existing) {
            return { ok: false as const, code: "organization_slug_taken" as const };
          }

          const allowed = await resolveAllowUserToCreateOrganization({
            userId: input.creatorUserId,
            userRole: input.creatorUserRole,
          });
          if (!allowed) {
            return { ok: false as const, code: "permission_denied" as const };
          }

          if (
            limits?.organizationsPerUser !== undefined &&
            members.length >= limits.organizationsPerUser
          ) {
            return { ok: false as const, code: "limit_reached" as const };
          }

          const organizationId = uow.create("organization", {
            name: input.name,
            slug: normalizedSlug,
            logoUrl: input.logoUrl ?? null,
            metadata: input.metadata ?? null,
            createdBy: input.creatorUserId,
            createdAt: now,
            updatedAt: now,
          });

          const memberId = uow.create("organizationMember", {
            organizationId,
            userId: input.creatorUserId,
            createdAt: now,
            updatedAt: now,
          });

          for (const role of creatorRoles) {
            uow.create("organizationMemberRole", {
              memberId,
              role,
              createdAt: now,
            });
          }

          if (input.sessionId && session && !session.activeOrganizationId) {
            uow.update("session", session.id, (b) =>
              b.set({ activeOrganizationId: organizationId }).check(),
            );
          }

          const organization = mapOrganization({
            id: organizationId,
            name: input.name,
            slug: normalizedSlug,
            logoUrl: input.logoUrl ?? null,
            metadata: input.metadata ?? null,
            createdBy: input.creatorUserId,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
          });

          const member = mapMember(
            {
              id: memberId,
              organizationId,
              userId: input.creatorUserId,
              createdAt: now,
              updatedAt: now,
            },
            creatorRoles,
          );

          const actorSummary = creatorUser
            ? mapUserSummary({
                id: creatorUser.id,
                email: creatorUser.email,
                role: creatorUser.role,
                bannedAt: creatorUser.bannedAt ?? null,
              })
            : null;

          uow.triggerHook("onOrganizationCreated", {
            organization,
            actor: actorSummary,
          });
          uow.triggerHook("onMemberAdded", {
            organization,
            member,
            actor: actorSummary,
          });

          return {
            ok: true as const,
            organization,
            member,
          };
        })
        .build();
    },

    /**
     * Fetch an organization by id, excluding deleted records.
     */
    getOrganizationById: function (this: AuthServiceContext, organizationId: string) {
      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow.findFirst("organization", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", organizationId)),
          ),
        )
        .transformRetrieve(([organization]) =>
          organization && organization.deletedAt == null
            ? {
                organization: mapOrganization({
                  id: organization.id,
                  name: organization.name,
                  slug: organization.slug,
                  logoUrl: organization.logoUrl,
                  metadata: organization.metadata,
                  createdBy: organization.createdBy,
                  createdAt: organization.createdAt,
                  updatedAt: organization.updatedAt,
                  deletedAt: organization.deletedAt,
                }),
              }
            : null,
        )
        .build();
    },

    /**
     * Fetch an organization by slug, excluding deleted records.
     */
    getOrganizationBySlug: function (this: AuthServiceContext, slug: string) {
      const normalizedSlug = normalizeOrganizationSlug(slug);
      if (!normalizedSlug) {
        return this.serviceTx(authSchema)
          .mutate(() => null)
          .build();
      }

      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow.findFirst("organization", (b) =>
            b.whereIndex("idx_organization_slug", (eb) => eb("slug", "=", normalizedSlug)),
          ),
        )
        .transformRetrieve(([organization]) =>
          organization && organization.deletedAt == null
            ? {
                organization: mapOrganization({
                  id: organization.id,
                  name: organization.name,
                  slug: organization.slug,
                  logoUrl: organization.logoUrl,
                  metadata: organization.metadata,
                  createdBy: organization.createdBy,
                  createdAt: organization.createdAt,
                  updatedAt: organization.updatedAt,
                  deletedAt: organization.deletedAt,
                }),
              }
            : null,
        )
        .build();
    },

    /**
     * Update organization fields with permission checks.
     */
    updateOrganization: function (
      this: AuthServiceContext,
      organizationId: string,
      patch: {
        name?: string;
        slug?: string;
        logoUrl?: string | null;
        metadata?: Record<string, unknown> | null;
      },
      actor: { userId: string; userRole: Role },
    ) {
      const nextSlug = patch.slug ? normalizeOrganizationSlug(patch.slug) : undefined;
      if (patch.slug && !nextSlug) {
        return this.serviceTx(authSchema)
          .mutate(() => ({
            ok: false as const,
            code: "invalid_slug" as const,
          }))
          .build();
      }

      const now = new Date();

      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow
            .findFirst("organization", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", organizationId)),
            )
            .findFirst("organization", (b) =>
              b.whereIndex("idx_organization_slug", (eb) => eb("slug", "=", nextSlug ?? "")),
            )
            .findFirst("organizationMember", (b) =>
              b.whereIndex("idx_org_member_org_user", (eb) =>
                eb.and(eb("organizationId", "=", organizationId), eb("userId", "=", actor.userId)),
              ),
            )
            // NOTE: actorMember is resolved in the same retrieve phase, so we filter in memory.
            .find("organizationMemberRole", (b) =>
              b.whereIndex("primary").join((j) => j.organizationMemberRoleMember()),
            )
            .findFirst("user", (b) => b.whereIndex("primary", (eb) => eb("id", "=", actor.userId))),
        )
        .mutate(
          ({ uow, retrieveResult: [existing, slugMatch, actorMember, actorRoles, actorUser] }) => {
            if (!existing) {
              return { ok: false as const, code: "organization_not_found" as const };
            }

            if (!actorMember) {
              return { ok: false as const, code: "permission_denied" as const };
            }

            const roles = filterRolesForMemberId(actorRoles, actorMember);
            if (!isGlobalAdmin(actor.userRole) && !canManageOrganization(roles)) {
              return { ok: false as const, code: "permission_denied" as const };
            }

            if (nextSlug && slugMatch && toExternalId(slugMatch.id) !== organizationId) {
              return { ok: false as const, code: "organization_slug_taken" as const };
            }

            const updated = {
              name: patch.name ?? existing.name,
              slug: nextSlug ?? existing.slug,
              logoUrl: patch.logoUrl !== undefined ? patch.logoUrl : existing.logoUrl,
              metadata: patch.metadata !== undefined ? patch.metadata : existing.metadata,
              createdBy: existing.createdBy,
              createdAt: existing.createdAt,
              updatedAt: now,
              deletedAt: existing.deletedAt,
            };

            uow.update("organization", existing.id, (b) =>
              b
                .set({
                  name: updated.name,
                  slug: updated.slug,
                  logoUrl: updated.logoUrl,
                  metadata: updated.metadata,
                  updatedAt: updated.updatedAt,
                })
                .check(),
            );

            const organization = mapOrganization({
              id: existing.id,
              name: updated.name,
              slug: updated.slug,
              logoUrl: updated.logoUrl,
              metadata: updated.metadata,
              createdBy: existing.createdBy,
              createdAt: updated.createdAt,
              updatedAt: updated.updatedAt,
              deletedAt: updated.deletedAt,
            });

            const actorSummary = actorUser
              ? mapUserSummary({
                  id: actorUser.id,
                  email: actorUser.email,
                  role: actorUser.role,
                  bannedAt: actorUser.bannedAt ?? null,
                })
              : null;

            uow.triggerHook("onOrganizationUpdated", {
              organization,
              actor: actorSummary,
            });

            return {
              ok: true as const,
              organization,
            };
          },
        )
        .build();
    },

    /**
     * Soft-delete an organization with permission checks.
     */
    deleteOrganization: function (
      this: AuthServiceContext,
      organizationId: string,
      actor: { userId: string; userRole: Role },
    ) {
      const now = new Date();

      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow
            .findFirst("organization", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", organizationId)),
            )
            .findFirst("organizationMember", (b) =>
              b.whereIndex("idx_org_member_org_user", (eb) =>
                eb.and(eb("organizationId", "=", organizationId), eb("userId", "=", actor.userId)),
              ),
            )
            // NOTE: actorMember is resolved in the same retrieve phase, so we filter in memory.
            .find("organizationMemberRole", (b) =>
              b.whereIndex("primary").join((j) => j.organizationMemberRoleMember()),
            )
            .findFirst("user", (b) => b.whereIndex("primary", (eb) => eb("id", "=", actor.userId))),
        )
        .mutate(({ uow, retrieveResult: [organization, actorMember, actorRoles, actorUser] }) => {
          if (!organization) {
            return { ok: false as const, code: "organization_not_found" as const };
          }

          if (!actorMember) {
            return { ok: false as const, code: "permission_denied" as const };
          }

          const roles = filterRolesForMemberId(actorRoles, actorMember);
          if (!isGlobalAdmin(actor.userRole) && !canDeleteOrganization(roles)) {
            return { ok: false as const, code: "permission_denied" as const };
          }

          uow.update("organization", organization.id, (b) =>
            b.set({ deletedAt: now, updatedAt: now }).check(),
          );

          const organizationSummary = mapOrganization({
            id: organization.id,
            name: organization.name,
            slug: organization.slug,
            logoUrl: organization.logoUrl,
            metadata: organization.metadata,
            createdBy: organization.createdBy,
            createdAt: organization.createdAt,
            updatedAt: now,
            deletedAt: now,
          });

          const actorSummary = actorUser
            ? mapUserSummary({
                id: actorUser.id,
                email: actorUser.email,
                role: actorUser.role,
                bannedAt: actorUser.bannedAt ?? null,
              })
            : null;

          uow.triggerHook("onOrganizationDeleted", {
            organization: organizationSummary,
            actor: actorSummary,
          });

          return { ok: true as const };
        })
        .build();
    },

    /**
     * List organizations for a user with cursor-based pagination.
     */
    getOrganizationsForUser: function (
      this: AuthServiceContext,
      params: { userId: string; pageSize: number; cursor?: Cursor },
    ) {
      const { userId, cursor, pageSize } = params;
      const effectivePageSize = cursor ? cursor.pageSize : pageSize;
      const effectiveSortOrder = cursor ? cursor.orderDirection : "asc";

      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow.findWithCursor("organizationMember", (b) => {
            const query = b
              .whereIndex("idx_org_member_user", (eb) => eb("userId", "=", userId))
              .orderByIndex("idx_org_member_user", effectiveSortOrder)
              .pageSize(effectivePageSize)
              .join((j) => j.organizationMemberOrganization().organizationMemberUser());

            return cursor ? query.after(cursor) : query;
          }),
        )
        .transformRetrieve(([result]) => {
          const organizations = result.items
            .filter(
              (member) =>
                member.organizationMemberOrganization &&
                member.organizationMemberOrganization.deletedAt == null,
            )
            .map((member) => {
              const organization = member.organizationMemberOrganization;
              const memberUserId = member.organizationMemberUser
                ? toExternalId(member.organizationMemberUser.id)
                : toExternalId(member.userId);
              return {
                organization: mapOrganization({
                  id: organization!.id,
                  name: organization!.name,
                  slug: organization!.slug,
                  logoUrl: organization!.logoUrl,
                  metadata: organization!.metadata,
                  createdBy: organization!.createdBy,
                  createdAt: organization!.createdAt,
                  updatedAt: organization!.updatedAt,
                  deletedAt: organization!.deletedAt,
                }),
                member: mapMember(
                  {
                    id: member.id,
                    organizationId: member.organizationId,
                    userId: member.userId,
                    createdAt: member.createdAt,
                    updatedAt: member.updatedAt,
                  },
                  [],
                  {
                    organizationId: toExternalId(organization!.id),
                    userId: memberUserId,
                  },
                ),
              };
            });

          return {
            organizations,
            cursor: result.cursor,
            hasNextPage: result.hasNextPage,
          };
        })
        .build();
    },
  };
}
