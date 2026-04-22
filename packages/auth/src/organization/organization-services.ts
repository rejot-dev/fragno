import { createCursorFromRecord, type Cursor } from "@fragno-dev/db/cursor";

import type { DatabaseServiceContext } from "@fragno-dev/db";

import type { AuthActor, AuthPrincipal } from "../auth/types";
import type { AuthHooksMap } from "../hooks";
import { authSchema } from "../schema";
import type { Role } from "../types";
import { mapUserSummary } from "../user/summary";
import { canDeleteOrganization, canManageOrganization, isGlobalAdmin } from "./permissions";
import type { Organization, OrganizationConfig, OrganizationMember } from "./types";
import {
  DEFAULT_CREATOR_ROLES,
  normalizeOrganizationSlug,
  normalizeRoleNames,
  toExternalId,
} from "./utils";

type AuthServiceContext = DatabaseServiceContext<AuthHooksMap>;

type CreateOrganizationInput = {
  name: string;
  slug: string;
  creatorUserId: string;
  creatorUserRole: Role;
  logoUrl?: string | null;
  metadata?: Record<string, unknown> | null;
  creatorRoles?: readonly string[];
  credentialToken?: string;
};

type CreateOrganizationForCredentialInput = {
  credentialToken: string;
  input: {
    name: string;
    slug: string;
    logoUrl?: string | null;
    metadata?: Record<string, unknown> | null;
  } | null;
  inputError?: unknown | null;
};

type CreateOrganizationForActorInput = {
  actor: AuthActor;
  principal?: AuthPrincipal | null;
  input: {
    name: string;
    slug: string;
    logoUrl?: string | null;
    metadata?: Record<string, unknown> | null;
  } | null;
  inputError?: unknown | null;
};

type GetOrganizationsForActorParams = {
  actor: AuthActor;
  pageSize: number;
  cursor?: Cursor;
};

type GetOrganizationForActorParams = {
  actor: AuthActor;
  organizationId: string;
};

type GetActiveOrganizationDetailsForPrincipalParams = {
  principal: AuthPrincipal;
};

type GetOrganizationsForCredentialParams = {
  credentialToken: string;
  pageSize: number;
  cursor?: Cursor;
};

type GetActiveOrganizationForCredentialParams = {
  credentialToken: string;
};

type SetActiveOrganizationForCredentialParams = {
  credentialToken: string;
  organizationId: string;
};

type GetOrganizationForCredentialParams = {
  credentialToken: string;
  organizationId: string;
};

type UpdateOrganizationForCredentialParams = {
  credentialToken: string;
  organizationId: string;
  patch: {
    name?: string;
    slug?: string;
    logoUrl?: string | null;
    metadata?: Record<string, unknown> | null;
  };
};

type DeleteOrganizationForCredentialParams = {
  credentialToken: string;
  organizationId: string;
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
  organizationCreator?: { id?: unknown } | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}): Organization => ({
  id: toExternalId(organization.id),
  name: organization.name,
  slug: organization.slug,
  logoUrl: organization.logoUrl ?? null,
  metadata: (organization.metadata ?? null) as Record<string, unknown> | null,
  createdBy: toExternalId(organization.organizationCreator?.id ?? organization.createdBy),
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

const isActiveOrganization = <T extends { deletedAt: Date | null | undefined }>(
  organization: T | null | undefined,
): organization is T => organization != null && organization.deletedAt == null;

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

  const resolveSessionCredentialId = (principal?: AuthPrincipal | null) =>
    principal?.auth.credentialKind === "session" ? principal.auth.credentialId : null;

  const createOrganization = function (this: AuthServiceContext, input: CreateOrganizationInput) {
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
            b.whereIndex("primary", (eb) => eb("id", "=", input.credentialToken ?? "")),
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

        if (input.credentialToken && session && !session.activeOrganizationId) {
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
  };

  const services = {
    /**
     * Create a new organization and creator membership.
     */
    createOrganization,

    /**
     * Create a new organization from authenticated actor/principal context.
     */
    createOrganizationForActor: function (
      this: AuthServiceContext,
      params: CreateOrganizationForActorInput,
    ) {
      if (params.inputError) {
        return this.serviceTx(authSchema)
          .mutate(() => ({
            ok: false as const,
            code: "input_invalid" as const,
          }))
          .build();
      }

      if (!params.input) {
        return this.serviceTx(authSchema)
          .mutate(() => ({
            ok: false as const,
            code: "invalid_slug" as const,
          }))
          .build();
      }

      return createOrganization.call(this, {
        name: params.input.name,
        slug: params.input.slug,
        logoUrl: params.input.logoUrl,
        metadata: params.input.metadata,
        creatorUserId: params.actor.userId,
        creatorUserRole: params.actor.role,
        credentialToken: resolveSessionCredentialId(params.principal) ?? undefined,
      });
    },

    /**
     * Fetch an organization by id, excluding deleted records.
     */
    getOrganizationById: function (this: AuthServiceContext, organizationId: string) {
      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow.findFirst("organization", (b) =>
            b
              .whereIndex("primary", (eb) => eb("id", "=", organizationId))
              .joinOne("organizationCreator", "user", (creator) =>
                creator.onIndex("primary", (eb) => eb("id", "=", eb.parent("createdBy"))),
              ),
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
                  organizationCreator: organization.organizationCreator ?? null,
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
            b
              .whereIndex("idx_organization_slug", (eb) => eb("slug", "=", normalizedSlug))
              .joinOne("organizationCreator", "user", (creator) =>
                creator.onIndex("primary", (eb) => eb("id", "=", eb.parent("createdBy"))),
              ),
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
                  organizationCreator: organization.organizationCreator ?? null,
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
     * Fetch organization details for an authenticated actor.
     */
    getOrganizationForActor: function (
      this: AuthServiceContext,
      params: GetOrganizationForActorParams,
    ) {
      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow
            .findFirst("organization", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", params.organizationId)),
            )
            .findFirst("organizationMember", (b) =>
              b
                .whereIndex("idx_org_member_org_user", (eb) =>
                  eb.and(
                    eb("organizationId", "=", params.organizationId),
                    eb("userId", "=", params.actor.userId),
                  ),
                )
                .joinMany("organizationMemberRoles", "organizationMemberRole", (role) =>
                  role.onIndex("idx_org_member_role_member", (eb) =>
                    eb("memberId", "=", eb.parent("id")),
                  ),
                ),
            ),
        )
        .transformRetrieve(([organization, member]) => {
          if (!organization || organization.deletedAt != null) {
            return { ok: false as const, code: "organization_not_found" as const };
          }

          if (!member) {
            return { ok: false as const, code: "permission_denied" as const };
          }

          const roles = extractRoles(
            (member as { organizationMemberRoles?: unknown }).organizationMemberRoles,
          );

          return {
            ok: true as const,
            organization: mapOrganization({
              id: organization.id,
              name: organization.name,
              slug: organization.slug,
              logoUrl: organization.logoUrl ?? null,
              metadata: organization.metadata ?? null,
              createdBy: organization.createdBy,
              createdAt: organization.createdAt,
              updatedAt: organization.updatedAt,
              deletedAt: organization.deletedAt ?? null,
            }),
            member: mapMember(
              {
                id: member.id,
                organizationId: member.organizationId,
                userId: member.userId,
                createdAt: member.createdAt,
                updatedAt: member.updatedAt,
              },
              roles,
              {
                organizationId: toExternalId(organization.id),
                userId: params.actor.userId,
              },
            ),
          };
        })
        .build();
    },

    /**
     * Resolve active organization details for a principal.
     */
    getActiveOrganizationDetailsForPrincipal: function (
      this: AuthServiceContext,
      params: GetActiveOrganizationDetailsForPrincipalParams,
    ) {
      const activeOrganizationId = params.principal.auth.activeOrganizationId;
      if (!activeOrganizationId) {
        return this.serviceTx(authSchema)
          .mutate(() => ({ ok: true as const, data: null }))
          .build();
      }

      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow
            .findFirst("organization", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", activeOrganizationId)),
            )
            .findFirst("organizationMember", (b) =>
              b
                .whereIndex("idx_org_member_org_user", (eb) =>
                  eb.and(
                    eb("organizationId", "=", activeOrganizationId),
                    eb("userId", "=", params.principal.user.id),
                  ),
                )
                .joinMany("organizationMemberRoles", "organizationMemberRole", (role) =>
                  role.onIndex("idx_org_member_role_member", (eb) =>
                    eb("memberId", "=", eb.parent("id")),
                  ),
                ),
            ),
        )
        .transformRetrieve(([organization, member]) => {
          if (!organization || organization.deletedAt != null || !member) {
            return { ok: true as const, data: null };
          }

          const roles = extractRoles(
            (member as { organizationMemberRoles?: unknown }).organizationMemberRoles,
          );

          return {
            ok: true as const,
            data: {
              organization: mapOrganization({
                id: organization.id,
                name: organization.name,
                slug: organization.slug,
                logoUrl: organization.logoUrl ?? null,
                metadata: organization.metadata ?? null,
                createdBy: organization.createdBy,
                createdAt: organization.createdAt,
                updatedAt: organization.updatedAt,
                deletedAt: organization.deletedAt ?? null,
              }),
              member: mapMember(
                {
                  id: member.id,
                  organizationId: member.organizationId,
                  userId: member.userId,
                  createdAt: member.createdAt,
                  updatedAt: member.updatedAt,
                },
                roles,
                {
                  organizationId: toExternalId(organization.id),
                  userId: params.principal.user.id,
                },
              ),
            },
          };
        })
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
              b
                .whereIndex("primary", (eb) => eb("id", "=", organizationId))
                .joinOne("organizationCreator", "user", (creator) =>
                  creator.onIndex("primary", (eb) => eb("id", "=", eb.parent("createdBy"))),
                ),
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
              b
                .whereIndex("primary")
                .joinOne("organizationMemberRoleMember", "organizationMember", (member) =>
                  member.onIndex("primary", (eb) => eb("id", "=", eb.parent("memberId"))),
                ),
            )
            .findFirst("user", (b) => b.whereIndex("primary", (eb) => eb("id", "=", actor.userId))),
        )
        .mutate(
          ({ uow, retrieveResult: [existing, slugMatch, actorMember, actorRoles, actorUser] }) => {
            if (!isActiveOrganization(existing)) {
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
              organizationCreator: existing.organizationCreator ?? null,
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
              b
                .whereIndex("primary", (eb) => eb("id", "=", organizationId))
                .joinOne("organizationCreator", "user", (creator) =>
                  creator.onIndex("primary", (eb) => eb("id", "=", eb.parent("createdBy"))),
                ),
            )
            .findFirst("organizationMember", (b) =>
              b.whereIndex("idx_org_member_org_user", (eb) =>
                eb.and(eb("organizationId", "=", organizationId), eb("userId", "=", actor.userId)),
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
            .find("organizationInvitation", (b) =>
              b.whereIndex("idx_org_invitation_org_status", (eb) =>
                eb.and(eb("organizationId", "=", organizationId), eb("status", "=", "pending")),
              ),
            )
            .findFirst("user", (b) => b.whereIndex("primary", (eb) => eb("id", "=", actor.userId))),
        )
        .mutate(
          ({
            uow,
            retrieveResult: [organization, actorMember, actorRoles, invitations, actorUser],
          }) => {
            if (!isActiveOrganization(organization)) {
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

            if (invitations.length > 0) {
              for (const invitation of invitations) {
                uow.update("organizationInvitation", invitation.id, (b) =>
                  b.set({ status: "canceled", respondedAt: now }).check(),
                );
              }
            }

            const organizationSummary = mapOrganization({
              id: organization.id,
              name: organization.name,
              slug: organization.slug,
              logoUrl: organization.logoUrl,
              metadata: organization.metadata,
              createdBy: organization.createdBy,
              organizationCreator: organization.organizationCreator ?? null,
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
          },
        )
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
              .joinOne("organizationMemberOrganization", "organization", (organization) =>
                organization
                  .onIndex("primary", (eb) => eb("id", "=", eb.parent("organizationId")))
                  .joinOne("organizationCreator", "user", (creator) =>
                    creator.onIndex("primary", (eb) => eb("id", "=", eb.parent("createdBy"))),
                  ),
              )
              .joinOne("organizationMemberUser", "user", (user) =>
                user.onIndex("primary", (eb) => eb("id", "=", eb.parent("userId"))),
              );

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
                  organizationCreator: organization!.organizationCreator ?? null,
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

    /**
     * List organizations for an authenticated actor.
     */
    getOrganizationsForActor: function (
      this: AuthServiceContext,
      params: GetOrganizationsForActorParams,
    ) {
      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow.findWithCursor("organizationMember", (b) => {
            const query = b
              .whereIndex("idx_org_member_user", (eb) => eb("userId", "=", params.actor.userId))
              .orderByIndex("idx_org_member_user", params.cursor?.orderDirection ?? "asc")
              .pageSize(params.cursor?.pageSize ?? params.pageSize)
              .joinOne("organizationMemberOrganization", "organization", (organization) =>
                organization
                  .onIndex("primary", (eb) => eb("id", "=", eb.parent("organizationId")))
                  .joinOne("organizationCreator", "user", (creator) =>
                    creator.onIndex("primary", (eb) => eb("id", "=", eb.parent("createdBy"))),
                  ),
              )
              .joinOne("organizationMemberUser", "user", (user) =>
                user.onIndex("primary", (eb) => eb("id", "=", eb.parent("userId"))),
              );

            return params.cursor ? query.after(params.cursor) : query;
          }),
        )
        .transformRetrieve(([result]) => ({
          organizations: result.items
            .filter(
              (member) =>
                member.organizationMemberOrganization &&
                member.organizationMemberOrganization.deletedAt == null,
            )
            .map((member) => ({
              organization: mapOrganization({
                id: member.organizationMemberOrganization!.id,
                name: member.organizationMemberOrganization!.name,
                slug: member.organizationMemberOrganization!.slug,
                logoUrl: member.organizationMemberOrganization!.logoUrl,
                metadata: member.organizationMemberOrganization!.metadata,
                createdBy: member.organizationMemberOrganization!.createdBy,
                organizationCreator:
                  member.organizationMemberOrganization!.organizationCreator ?? null,
                createdAt: member.organizationMemberOrganization!.createdAt,
                updatedAt: member.organizationMemberOrganization!.updatedAt,
                deletedAt: member.organizationMemberOrganization!.deletedAt,
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
                  organizationId: toExternalId(member.organizationMemberOrganization!.id),
                  userId: params.actor.userId,
                },
              ),
            })),
          cursor: result.cursor,
          hasNextPage: result.hasNextPage,
        }))
        .build();
    },

    /**
     * Create an organization using the current credential context.
     */
    createOrganizationForCredential: function (
      this: AuthServiceContext,
      params: CreateOrganizationForCredentialInput,
    ) {
      const normalizedSlug = params.input ? normalizeOrganizationSlug(params.input.slug) : null;
      const slugLookup = normalizedSlug ?? "__invalid__";
      const creatorRoles = normalizeRoleNames(defaultCreatorRoles, DEFAULT_CREATOR_ROLES);

      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow
            .find("session", (b) =>
              b
                .whereIndex("idx_session_id_expiresAt", (eb) =>
                  eb.and(eb("id", "=", params.credentialToken), eb("expiresAt", ">", eb.now())),
                )
                .joinOne("sessionOwner", "user", (owner) =>
                  owner
                    .onIndex("primary", (eb) => eb("id", "=", eb.parent("userId")))
                    .select(["id", "email", "role", "bannedAt"]),
                )
                .joinMany("sessionMembers", "organizationMember", (member) =>
                  member.onIndex("idx_org_member_user", (eb) =>
                    eb("userId", "=", eb.parent("userId")),
                  ),
                ),
            )
            .findFirst("session", (b) =>
              b.whereIndex("idx_session_id_expiresAt", (eb) =>
                eb.and(eb("id", "=", params.credentialToken), eb("expiresAt", "<=", eb.now())),
              ),
            )
            .findFirst("organization", (b) =>
              b.whereIndex("idx_organization_slug", (eb) => eb("slug", "=", slugLookup)),
            ),
        )
        .mutate(async ({ uow, retrieveResult: [sessions, expiredSession, existing] }) => {
          if (expiredSession) {
            uow.delete("session", expiredSession.id, (b) => b.check());
          }

          const session = sessions[0] ?? null;
          if (!session || !session.sessionOwner) {
            return { ok: false as const, code: "credential_invalid" as const };
          }

          if (params.inputError) {
            return { ok: false as const, code: "input_invalid" as const };
          }

          if (!params.input || !normalizedSlug) {
            return { ok: false as const, code: "invalid_slug" as const };
          }

          if (existing) {
            return { ok: false as const, code: "organization_slug_taken" as const };
          }

          const creatorUserId = toExternalId(session.sessionOwner.id);
          const creatorUserRole = session.sessionOwner.role as Role;
          const allowed = await resolveAllowUserToCreateOrganization({
            userId: creatorUserId,
            userRole: creatorUserRole,
          });
          if (!allowed) {
            return { ok: false as const, code: "permission_denied" as const };
          }

          const memberIds = new Set<string>();
          for (const entry of sessions) {
            for (const member of normalizeMany(entry.sessionMembers)) {
              const memberId = (member as { id?: unknown }).id ?? member;
              memberIds.add(toExternalId(memberId));
            }
          }

          if (
            limits?.organizationsPerUser !== undefined &&
            memberIds.size >= limits.organizationsPerUser
          ) {
            return { ok: false as const, code: "limit_reached" as const };
          }

          const now = new Date();
          const organizationId = uow.create("organization", {
            name: params.input.name,
            slug: normalizedSlug,
            logoUrl: params.input.logoUrl ?? null,
            metadata: params.input.metadata ?? null,
            createdBy: creatorUserId,
            createdAt: now,
            updatedAt: now,
          });

          const memberId = uow.create("organizationMember", {
            organizationId,
            userId: creatorUserId,
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

          if (!session.activeOrganizationId) {
            uow.update("session", session.id, (b) =>
              b.set({ activeOrganizationId: organizationId }).check(),
            );
          }

          const organization = mapOrganization({
            id: organizationId,
            name: params.input.name,
            slug: normalizedSlug,
            logoUrl: params.input.logoUrl ?? null,
            metadata: params.input.metadata ?? null,
            createdBy: creatorUserId,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
          });

          const member = mapMember(
            {
              id: memberId,
              organizationId,
              userId: creatorUserId,
              createdAt: now,
              updatedAt: now,
            },
            creatorRoles,
            {
              organizationId: toExternalId(organizationId),
              userId: creatorUserId,
            },
          );

          const actorSummary = mapUserSummary({
            id: session.sessionOwner.id,
            email: session.sessionOwner.email,
            role: session.sessionOwner.role,
            bannedAt: session.sessionOwner.bannedAt ?? null,
          });

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
     * List organizations for a session with pagination.
     */
    getOrganizationsForCredential: function (
      this: AuthServiceContext,
      params: GetOrganizationsForCredentialParams,
    ) {
      const { credentialToken, cursor } = params;
      const effectivePageSize = cursor ? cursor.pageSize : params.pageSize;
      const effectiveSortOrder = cursor ? cursor.orderDirection : "asc";
      const resolveCursorId = (value: unknown): string | null => {
        if (typeof value === "string") {
          return value;
        }
        if (value && typeof value === "object" && "externalId" in value) {
          const externalId = (value as { externalId?: unknown }).externalId;
          if (typeof externalId === "string") {
            return externalId;
          }
        }
        return null;
      };
      const cursorId = cursor ? resolveCursorId(cursor.indexValues["id"]) : null;

      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow
            .find("session", (b) =>
              b
                .whereIndex("idx_session_id_expiresAt", (eb) =>
                  eb.and(eb("id", "=", credentialToken), eb("expiresAt", ">", eb.now())),
                )
                .joinOne("sessionOwner", "user", (owner) =>
                  owner
                    .onIndex("primary", (eb) => eb("id", "=", eb.parent("userId")))
                    .select(["id"]),
                )
                .joinMany("sessionMembers", "organizationMember", (member) => {
                  let memberQuery = member
                    .onIndex("idx_org_member_user", (eb) => eb("userId", "=", eb.parent("userId")))
                    .orderByIndex("primary", effectiveSortOrder)
                    .pageSize(effectivePageSize + 1)
                    .joinOne("organization", "organization", (organization) =>
                      organization.onIndex("primary", (eb) =>
                        eb("id", "=", eb.parent("organizationId")),
                      ),
                    )
                    .joinMany("roles", "organizationMemberRole", (role) =>
                      role
                        .onIndex("idx_org_member_role_member", (eb) =>
                          eb("memberId", "=", eb.parent("id")),
                        )
                        .select(["role"]),
                    );

                  if (cursorId) {
                    memberQuery = memberQuery.whereIndex("primary", (eb) =>
                      eb("id", effectiveSortOrder === "asc" ? ">" : "<", cursorId),
                    );
                  }

                  return memberQuery;
                }),
            )
            .findFirst("session", (b) =>
              b.whereIndex("idx_session_id_expiresAt", (eb) =>
                eb.and(eb("id", "=", credentialToken), eb("expiresAt", "<=", eb.now())),
              ),
            ),
        )
        .mutate(({ uow, retrieveResult: [sessions, expiredSession] }) => {
          if (expiredSession) {
            uow.delete("session", expiredSession.id, (b) => b.check());
          }

          const session = Array.isArray(sessions) ? sessions[0] : null;
          if (!session || !session.sessionOwner) {
            return { ok: false as const, code: "credential_invalid" as const };
          }

          const sessionOwner = session.sessionOwner;
          type SessionMemberRow = {
            id: unknown;
            organizationId: unknown;
            userId: unknown;
            createdAt: Date;
            updatedAt: Date;
            organization?: {
              id: unknown;
              name: string;
              slug: string;
              logoUrl: string | null;
              metadata: unknown;
              createdBy: unknown;
              createdAt: Date;
              updatedAt: Date;
              deletedAt: Date | null;
            } | null;
            roles?: { role: string }[];
          };

          const orderedMemberIds: string[] = [];
          const membersById = new Map<
            string,
            {
              member: SessionMemberRow;
              organization: NonNullable<SessionMemberRow["organization"]>;
              roles: Set<string>;
            }
          >();

          for (const row of sessions) {
            const members = normalizeMany(row.sessionMembers) as SessionMemberRow[];
            for (const member of members) {
              const organization = member.organization;
              if (!organization || organization.deletedAt) {
                continue;
              }

              const memberId = toExternalId(member.id);
              let entry = membersById.get(memberId);
              if (!entry) {
                entry = { member, organization, roles: new Set() };
                membersById.set(memberId, entry);
                orderedMemberIds.push(memberId);
              }

              const roles = normalizeMany(member.roles);
              for (const role of roles) {
                entry.roles.add(role.role);
              }
            }
          }

          const orderedEntries = orderedMemberIds
            .map((memberId) => membersById.get(memberId))
            .filter(Boolean) as Array<{
            member: SessionMemberRow;
            organization: NonNullable<SessionMemberRow["organization"]>;
            roles: Set<string>;
          }>;

          const hasNextPage = orderedEntries.length > effectivePageSize;
          const pagedEntries = orderedEntries.slice(0, effectivePageSize);
          const cursorRecord =
            hasNextPage && pagedEntries.length > 0
              ? pagedEntries[pagedEntries.length - 1]!.member
              : null;
          const nextCursor = cursorRecord
            ? createCursorFromRecord(
                cursorRecord,
                [authSchema.tables.organizationMember.getIdColumn()],
                {
                  indexName: "_primary",
                  orderDirection: effectiveSortOrder,
                  pageSize: effectivePageSize,
                },
              )
            : undefined;

          const organizations = pagedEntries.map((entry) => {
            const memberOrganizationId = toExternalId(entry.organization.id);
            const memberUserId = toExternalId(sessionOwner.id);

            return {
              organization: mapOrganization({
                id: entry.organization.id,
                name: entry.organization.name,
                slug: entry.organization.slug,
                logoUrl: entry.organization.logoUrl ?? null,
                metadata: entry.organization.metadata ?? null,
                createdBy: entry.organization.createdBy,
                createdAt: entry.organization.createdAt,
                updatedAt: entry.organization.updatedAt,
                deletedAt: entry.organization.deletedAt ?? null,
              }),
              member: mapMember(
                {
                  id: entry.member.id,
                  organizationId: entry.member.organizationId,
                  userId: entry.member.userId,
                  createdAt: entry.member.createdAt,
                  updatedAt: entry.member.updatedAt,
                },
                Array.from(entry.roles),
                {
                  organizationId: memberOrganizationId,
                  userId: memberUserId,
                },
              ),
            };
          });

          return {
            ok: true as const,
            organizations,
            cursor: nextCursor?.encode(),
            hasNextPage,
          };
        })
        .build();
    },

    /**
     * Resolve the active organization for the current credential.
     */
    getActiveOrganizationForCredential: function (
      this: AuthServiceContext,
      params: GetActiveOrganizationForCredentialParams,
    ) {
      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow
            .findFirst("session", (b) =>
              b
                .whereIndex("idx_session_id_expiresAt", (eb) =>
                  eb.and(eb("id", "=", params.credentialToken), eb("expiresAt", ">", eb.now())),
                )
                .joinOne("sessionOwner", "user", (owner) =>
                  owner
                    .onIndex("primary", (eb) => eb("id", "=", eb.parent("userId")))
                    .select(["id"]),
                )
                .joinOne("sessionActiveOrganization", "organization", (organization) =>
                  organization.onIndex("primary", (eb) =>
                    eb("id", "=", eb.parent("activeOrganizationId")),
                  ),
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
                eb.and(eb("id", "=", params.credentialToken), eb("expiresAt", "<=", eb.now())),
              ),
            ),
        )
        .mutate(({ uow, retrieveResult: [session, expiredSession] }) => {
          if (expiredSession) {
            uow.delete("session", expiredSession.id, (b) => b.check());
          }

          if (!session || !session.sessionOwner) {
            return { ok: false as const, code: "credential_invalid" as const };
          }

          const activeOrganization = session.sessionActiveOrganization;
          if (!activeOrganization || activeOrganization.deletedAt != null) {
            return { ok: true as const, data: null };
          }

          const member = normalizeMany(session.sessionMembers).find((entry) => {
            const entryInternal = resolveInternalId(entry.organizationId);
            const activeInternal = resolveInternalId(activeOrganization.id);
            const entryUserInternal = resolveInternalId(entry.userId);
            const sessionUserInternal = resolveInternalId(session.userId);
            if (entryInternal !== undefined && activeInternal !== undefined) {
              if (String(entryInternal) !== String(activeInternal)) {
                return false;
              }
              if (entryUserInternal !== undefined && sessionUserInternal !== undefined) {
                return String(entryUserInternal) === String(sessionUserInternal);
              }
              return false;
            }
            return false;
          });
          if (!member) {
            return { ok: true as const, data: null };
          }

          const roles = extractRoles(
            (member as { organizationMemberRoles?: unknown }).organizationMemberRoles,
          );
          const memberOrganizationId = toExternalId(activeOrganization.id);
          const memberUserId = toExternalId(session.sessionOwner.id);

          return {
            ok: true as const,
            data: {
              organization: mapOrganization({
                id: activeOrganization.id,
                name: activeOrganization.name,
                slug: activeOrganization.slug,
                logoUrl: activeOrganization.logoUrl ?? null,
                metadata: activeOrganization.metadata ?? null,
                createdBy: activeOrganization.createdBy,
                createdAt: activeOrganization.createdAt,
                updatedAt: activeOrganization.updatedAt,
                deletedAt: activeOrganization.deletedAt ?? null,
              }),
              member: mapMember(
                {
                  id: member.id,
                  organizationId: member.organizationId,
                  userId: member.userId,
                  createdAt: member.createdAt,
                  updatedAt: member.updatedAt,
                },
                roles,
                {
                  organizationId: memberOrganizationId,
                  userId: memberUserId,
                },
              ),
            },
          };
        })
        .build();
    },

    /**
     * Set the active organization for the current credential.
     */
    setActiveOrganizationForCredential: function (
      this: AuthServiceContext,
      params: SetActiveOrganizationForCredentialParams,
    ) {
      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow
            .findFirst("session", (b) =>
              b
                .whereIndex("idx_session_id_expiresAt", (eb) =>
                  eb.and(eb("id", "=", params.credentialToken), eb("expiresAt", ">", eb.now())),
                )
                .joinOne("sessionOwner", "user", (owner) =>
                  owner
                    .onIndex("primary", (eb) => eb("id", "=", eb.parent("userId")))
                    .select(["id"]),
                ),
            )
            .findFirst("session", (b) =>
              b.whereIndex("idx_session_id_expiresAt", (eb) =>
                eb.and(eb("id", "=", params.credentialToken), eb("expiresAt", "<=", eb.now())),
              ),
            )
            .findFirst("organization", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", params.organizationId)),
            )
            .find("organizationMember", (b) =>
              b
                .whereIndex("idx_org_member_org", (eb) =>
                  eb("organizationId", "=", params.organizationId),
                )
                .joinMany("organizationMemberRoles", "organizationMemberRole", (role) =>
                  role.onIndex("idx_org_member_role_member", (eb) =>
                    eb("memberId", "=", eb.parent("id")),
                  ),
                ),
            ),
        )
        .mutate(({ uow, retrieveResult: [session, expiredSession, organization, members] }) => {
          if (expiredSession) {
            uow.delete("session", expiredSession.id, (b) => b.check());
          }

          if (!session || !session.sessionOwner) {
            return { ok: false as const, code: "credential_invalid" as const };
          }

          if (!organization || organization.deletedAt != null) {
            return { ok: false as const, code: "organization_not_found" as const };
          }

          const member = normalizeMany(members).find((entry) => {
            const entryUserInternal = resolveInternalId(entry.userId);
            const sessionUserInternal = resolveInternalId(session.userId);
            if (entryUserInternal !== undefined && sessionUserInternal !== undefined) {
              return String(entryUserInternal) === String(sessionUserInternal);
            }
            return false;
          });
          if (!member) {
            return { ok: false as const, code: "membership_not_found" as const };
          }

          uow.update("session", session.id, (b) =>
            b.set({ activeOrganizationId: params.organizationId }).check(),
          );

          const roles = extractRoles(
            (member as { organizationMemberRoles?: unknown }).organizationMemberRoles,
          );
          const memberOrganizationId = toExternalId(organization.id);
          const memberUserId = toExternalId(session.sessionOwner.id);

          return {
            ok: true as const,
            organization: mapOrganization({
              id: organization.id,
              name: organization.name,
              slug: organization.slug,
              logoUrl: organization.logoUrl ?? null,
              metadata: organization.metadata ?? null,
              createdBy: organization.createdBy,
              createdAt: organization.createdAt,
              updatedAt: organization.updatedAt,
              deletedAt: organization.deletedAt ?? null,
            }),
            member: mapMember(
              {
                id: member.id,
                organizationId: member.organizationId,
                userId: member.userId,
                createdAt: member.createdAt,
                updatedAt: member.updatedAt,
              },
              roles,
              {
                organizationId: memberOrganizationId,
                userId: memberUserId,
              },
            ),
          };
        })
        .build();
    },

    /**
     * Fetch organization details for a session.
     */
    getOrganizationForCredential: function (
      this: AuthServiceContext,
      params: GetOrganizationForCredentialParams,
    ) {
      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow
            .findFirst("session", (b) =>
              b
                .whereIndex("idx_session_id_expiresAt", (eb) =>
                  eb.and(eb("id", "=", params.credentialToken), eb("expiresAt", ">", eb.now())),
                )
                .joinOne("sessionOwner", "user", (owner) =>
                  owner
                    .onIndex("primary", (eb) => eb("id", "=", eb.parent("userId")))
                    .select(["id", "email", "role"]),
                ),
            )
            .findFirst("session", (b) =>
              b.whereIndex("idx_session_id_expiresAt", (eb) =>
                eb.and(eb("id", "=", params.credentialToken), eb("expiresAt", "<=", eb.now())),
              ),
            )
            .findFirst("organization", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", params.organizationId)),
            )
            .find("organizationMember", (b) =>
              b
                .whereIndex("idx_org_member_org", (eb) =>
                  eb("organizationId", "=", params.organizationId),
                )
                .joinMany("organizationMemberRoles", "organizationMemberRole", (role) =>
                  role.onIndex("idx_org_member_role_member", (eb) =>
                    eb("memberId", "=", eb.parent("id")),
                  ),
                ),
            ),
        )
        .mutate(({ uow, retrieveResult: [session, expiredSession, organization, members] }) => {
          if (expiredSession) {
            uow.delete("session", expiredSession.id, (b) => b.check());
          }

          if (!session || !session.sessionOwner) {
            return { ok: false as const, code: "credential_invalid" as const };
          }

          if (!organization || organization.deletedAt != null) {
            return { ok: false as const, code: "organization_not_found" as const };
          }

          const member = normalizeMany(members).find((entry) => {
            const entryInternal = resolveInternalId(entry.organizationId);
            const organizationInternal = resolveInternalId(organization.id);
            const entryUserInternal = resolveInternalId(entry.userId);
            const sessionUserInternal = resolveInternalId(session.userId);
            if (entryInternal !== undefined && organizationInternal !== undefined) {
              if (String(entryInternal) !== String(organizationInternal)) {
                return false;
              }
              if (entryUserInternal !== undefined && sessionUserInternal !== undefined) {
                return String(entryUserInternal) === String(sessionUserInternal);
              }
              return false;
            }
            return false;
          });
          if (!member) {
            return { ok: false as const, code: "permission_denied" as const };
          }

          const roles = extractRoles(
            (member as { organizationMemberRoles?: unknown }).organizationMemberRoles,
          );
          const memberOrganizationId = toExternalId(organization.id);
          const memberUserId = toExternalId(session.sessionOwner.id);

          return {
            ok: true as const,
            organization: mapOrganization({
              id: organization.id,
              name: organization.name,
              slug: organization.slug,
              logoUrl: organization.logoUrl ?? null,
              metadata: organization.metadata ?? null,
              createdBy: organization.createdBy,
              createdAt: organization.createdAt,
              updatedAt: organization.updatedAt,
              deletedAt: organization.deletedAt ?? null,
            }),
            member: mapMember(
              {
                id: member.id,
                organizationId: member.organizationId,
                userId: member.userId,
                createdAt: member.createdAt,
                updatedAt: member.updatedAt,
              },
              roles,
              {
                organizationId: memberOrganizationId,
                userId: memberUserId,
              },
            ),
          };
        })
        .build();
    },

    /**
     * Update an organization using session permissions.
     */
    updateOrganizationForCredential: function (
      this: AuthServiceContext,
      params: UpdateOrganizationForCredentialParams,
    ) {
      const nextSlug = params.patch.slug ? normalizeOrganizationSlug(params.patch.slug) : undefined;

      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow
            .findFirst("session", (b) =>
              b
                .whereIndex("idx_session_id_expiresAt", (eb) =>
                  eb.and(eb("id", "=", params.credentialToken), eb("expiresAt", ">", eb.now())),
                )
                .joinOne("sessionOwner", "user", (owner) =>
                  owner
                    .onIndex("primary", (eb) => eb("id", "=", eb.parent("userId")))
                    .select(["id", "email", "role", "bannedAt"]),
                ),
            )
            .findFirst("session", (b) =>
              b.whereIndex("idx_session_id_expiresAt", (eb) =>
                eb.and(eb("id", "=", params.credentialToken), eb("expiresAt", "<=", eb.now())),
              ),
            )
            .findFirst("organization", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", params.organizationId)),
            )
            .findFirst("organization", (b) =>
              b.whereIndex("idx_organization_slug", (eb) => eb("slug", "=", nextSlug ?? "")),
            )
            .find("organizationMember", (b) =>
              b
                .whereIndex("idx_org_member_org", (eb) =>
                  eb("organizationId", "=", params.organizationId),
                )
                .joinMany("organizationMemberRoles", "organizationMemberRole", (role) =>
                  role.onIndex("idx_org_member_role_member", (eb) =>
                    eb("memberId", "=", eb.parent("id")),
                  ),
                ),
            ),
        )
        .mutate(
          ({
            uow,
            retrieveResult: [session, expiredSession, organization, slugMatch, members],
          }) => {
            if (expiredSession) {
              uow.delete("session", expiredSession.id, (b) => b.check());
            }

            if (!session || !session.sessionOwner) {
              return { ok: false as const, code: "credential_invalid" as const };
            }

            if (params.patch.slug && !nextSlug) {
              return { ok: false as const, code: "invalid_slug" as const };
            }

            if (!isActiveOrganization(organization)) {
              return { ok: false as const, code: "organization_not_found" as const };
            }

            const actorMember = normalizeMany(members).find((entry) => {
              const entryInternal = resolveInternalId(entry.organizationId);
              const organizationInternal = resolveInternalId(organization.id);
              const entryUserInternal = resolveInternalId(entry.userId);
              const sessionUserInternal = resolveInternalId(session.userId);
              if (entryInternal !== undefined && organizationInternal !== undefined) {
                if (String(entryInternal) !== String(organizationInternal)) {
                  return false;
                }
                if (entryUserInternal !== undefined && sessionUserInternal !== undefined) {
                  return String(entryUserInternal) === String(sessionUserInternal);
                }
                return false;
              }
              return false;
            });
            if (!actorMember) {
              return { ok: false as const, code: "permission_denied" as const };
            }

            const roles = extractRoles(
              (actorMember as { organizationMemberRoles?: unknown }).organizationMemberRoles,
            );
            if (
              !isGlobalAdmin(session.sessionOwner.role as Role) &&
              !canManageOrganization(roles)
            ) {
              return { ok: false as const, code: "permission_denied" as const };
            }

            if (nextSlug && slugMatch && toExternalId(slugMatch.id) !== params.organizationId) {
              return { ok: false as const, code: "organization_slug_taken" as const };
            }

            const now = new Date();
            const updated = {
              name: params.patch.name ?? organization.name,
              slug: nextSlug ?? organization.slug,
              logoUrl:
                params.patch.logoUrl !== undefined ? params.patch.logoUrl : organization.logoUrl,
              metadata:
                params.patch.metadata !== undefined ? params.patch.metadata : organization.metadata,
              createdBy: organization.createdBy,
              createdAt: organization.createdAt,
              updatedAt: now,
              deletedAt: organization.deletedAt,
            };

            uow.update("organization", organization.id, (b) =>
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

            const organizationSummary = mapOrganization({
              id: organization.id,
              name: updated.name,
              slug: updated.slug,
              logoUrl: updated.logoUrl ?? null,
              metadata: updated.metadata ?? null,
              createdBy: organization.createdBy,
              createdAt: updated.createdAt,
              updatedAt: updated.updatedAt,
              deletedAt: updated.deletedAt ?? null,
            });

            const actorSummary = mapUserSummary({
              id: session.sessionOwner.id,
              email: session.sessionOwner.email,
              role: session.sessionOwner.role,
              bannedAt: session.sessionOwner.bannedAt ?? null,
            });

            uow.triggerHook("onOrganizationUpdated", {
              organization: organizationSummary,
              actor: actorSummary,
            });

            return {
              ok: true as const,
              organization: organizationSummary,
            };
          },
        )
        .build();
    },

    /**
     * Delete an organization using session permissions.
     */
    deleteOrganizationForCredential: function (
      this: AuthServiceContext,
      params: DeleteOrganizationForCredentialParams,
    ) {
      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow
            .findFirst("session", (b) =>
              b
                .whereIndex("idx_session_id_expiresAt", (eb) =>
                  eb.and(eb("id", "=", params.credentialToken), eb("expiresAt", ">", eb.now())),
                )
                .joinOne("sessionOwner", "user", (owner) =>
                  owner
                    .onIndex("primary", (eb) => eb("id", "=", eb.parent("userId")))
                    .select(["id", "email", "role", "bannedAt"]),
                ),
            )
            .findFirst("session", (b) =>
              b.whereIndex("idx_session_id_expiresAt", (eb) =>
                eb.and(eb("id", "=", params.credentialToken), eb("expiresAt", "<=", eb.now())),
              ),
            )
            .findFirst("organization", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", params.organizationId)),
            )
            .find("organizationInvitation", (b) =>
              b.whereIndex("idx_org_invitation_org_status", (eb) =>
                eb.and(
                  eb("organizationId", "=", params.organizationId),
                  eb("status", "=", "pending"),
                ),
              ),
            )
            .find("organizationMember", (b) =>
              b
                .whereIndex("idx_org_member_org", (eb) =>
                  eb("organizationId", "=", params.organizationId),
                )
                .joinMany("organizationMemberRoles", "organizationMemberRole", (role) =>
                  role.onIndex("idx_org_member_role_member", (eb) =>
                    eb("memberId", "=", eb.parent("id")),
                  ),
                ),
            ),
        )
        .mutate(
          ({
            uow,
            retrieveResult: [session, expiredSession, organization, invitations, members],
          }) => {
            if (expiredSession) {
              uow.delete("session", expiredSession.id, (b) => b.check());
            }

            if (!session || !session.sessionOwner) {
              return { ok: false as const, code: "credential_invalid" as const };
            }

            if (!isActiveOrganization(organization)) {
              return { ok: false as const, code: "organization_not_found" as const };
            }

            const actorMember = normalizeMany(members).find((entry) => {
              const entryInternal = resolveInternalId(entry.organizationId);
              const organizationInternal = resolveInternalId(organization.id);
              const entryUserInternal = resolveInternalId(entry.userId);
              const sessionUserInternal = resolveInternalId(session.userId);
              if (entryInternal !== undefined && organizationInternal !== undefined) {
                if (String(entryInternal) !== String(organizationInternal)) {
                  return false;
                }
                if (entryUserInternal !== undefined && sessionUserInternal !== undefined) {
                  return String(entryUserInternal) === String(sessionUserInternal);
                }
                return false;
              }
              return false;
            });
            if (!actorMember) {
              return { ok: false as const, code: "permission_denied" as const };
            }

            const roles = extractRoles(
              (actorMember as { organizationMemberRoles?: unknown }).organizationMemberRoles,
            );
            if (
              !isGlobalAdmin(session.sessionOwner.role as Role) &&
              !canDeleteOrganization(roles)
            ) {
              return { ok: false as const, code: "permission_denied" as const };
            }

            const now = new Date();
            uow.update("organization", organization.id, (b) =>
              b.set({ deletedAt: now, updatedAt: now }).check(),
            );

            if (invitations.length > 0) {
              for (const invitation of invitations) {
                uow.update("organizationInvitation", invitation.id, (b) =>
                  b.set({ status: "canceled", respondedAt: now }).check(),
                );
              }
            }

            const organizationSummary = mapOrganization({
              id: organization.id,
              name: organization.name,
              slug: organization.slug,
              logoUrl: organization.logoUrl ?? null,
              metadata: organization.metadata ?? null,
              createdBy: organization.createdBy,
              createdAt: organization.createdAt,
              updatedAt: now,
              deletedAt: now,
            });

            const actorSummary = mapUserSummary({
              id: session.sessionOwner.id,
              email: session.sessionOwner.email,
              role: session.sessionOwner.role,
              bannedAt: session.sessionOwner.bannedAt ?? null,
            });

            uow.triggerHook("onOrganizationDeleted", {
              organization: organizationSummary,
              actor: actorSummary,
            });

            return { ok: true as const };
          },
        )
        .build();
    },
  };

  return services;
}
