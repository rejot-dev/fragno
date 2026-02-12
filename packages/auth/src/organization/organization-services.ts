import type { DatabaseServiceContext } from "@fragno-dev/db";
import type { Cursor } from "@fragno-dev/db/cursor";
import { authSchema } from "../schema";
import type { Organization, OrganizationMember } from "./types";
import {
  DEFAULT_CREATOR_ROLES,
  normalizeOrganizationSlug,
  normalizeRoleNames,
  toExternalId,
} from "./utils";

type AuthServiceContext = DatabaseServiceContext<{}>;

type CreateOrganizationInput = {
  name: string;
  slug: string;
  creatorUserId: string;
  logoUrl?: string | null;
  metadata?: Record<string, unknown> | null;
  creatorRoles?: readonly string[];
  sessionId?: string;
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
): OrganizationMember<string> => ({
  id: toExternalId(member.id),
  organizationId: toExternalId(member.organizationId),
  userId: toExternalId(member.userId),
  roles,
  createdAt: member.createdAt,
  updatedAt: member.updatedAt,
});

export function createOrganizationServices() {
  return {
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

      const creatorRoles = normalizeRoleNames(input.creatorRoles, DEFAULT_CREATOR_ROLES);
      const now = new Date();

      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow
            .findFirst("organization", (b) =>
              b.whereIndex("idx_organization_slug", (eb) => eb("slug", "=", normalizedSlug)),
            )
            .findFirst("session", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", input.sessionId ?? "")),
            ),
        )
        .mutate(({ uow, retrieveResult: [existing, session] }) => {
          if (existing) {
            return { ok: false as const, code: "organization_slug_taken" as const };
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

          return {
            ok: true as const,
            organization: mapOrganization({
              id: organizationId,
              name: input.name,
              slug: normalizedSlug,
              logoUrl: input.logoUrl ?? null,
              metadata: input.metadata ?? null,
              createdBy: input.creatorUserId,
              createdAt: now,
              updatedAt: now,
              deletedAt: null,
            }),
            member: mapMember(
              {
                id: memberId,
                organizationId,
                userId: input.creatorUserId,
                createdAt: now,
                updatedAt: now,
              },
              creatorRoles,
            ),
          };
        })
        .build();
    },

    getOrganizationById: function (this: AuthServiceContext, organizationId: string) {
      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow.findFirst("organization", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", organizationId)),
          ),
        )
        .transformRetrieve(([organization]) =>
          organization
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
          organization
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

    updateOrganization: function (
      this: AuthServiceContext,
      organizationId: string,
      patch: {
        name?: string;
        slug?: string;
        logoUrl?: string | null;
        metadata?: Record<string, unknown> | null;
      },
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
            ),
        )
        .mutate(({ uow, retrieveResult: [existing, slugMatch] }) => {
          if (!existing) {
            return { ok: false as const, code: "organization_not_found" as const };
          }

          if (nextSlug && slugMatch && String(slugMatch.id) !== organizationId) {
            return { ok: false as const, code: "organization_slug_taken" as const };
          }

          const updated = {
            name: patch.name ?? existing.name,
            slug: nextSlug ?? existing.slug,
            logoUrl: patch.logoUrl ?? existing.logoUrl,
            metadata: patch.metadata ?? existing.metadata,
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

          return {
            ok: true as const,
            organization: mapOrganization({
              id: existing.id,
              name: updated.name,
              slug: updated.slug,
              logoUrl: updated.logoUrl,
              metadata: updated.metadata,
              createdBy: existing.createdBy,
              createdAt: updated.createdAt,
              updatedAt: updated.updatedAt,
              deletedAt: updated.deletedAt,
            }),
          };
        })
        .build();
    },

    deleteOrganization: function (this: AuthServiceContext, organizationId: string) {
      const now = new Date();

      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow.findFirst("organization", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", organizationId)),
          ),
        )
        .mutate(({ uow, retrieveResult: [organization] }) => {
          if (!organization) {
            return { ok: false as const, code: "organization_not_found" as const };
          }

          uow.update("organization", organization.id, (b) =>
            b.set({ deletedAt: now, updatedAt: now }).check(),
          );

          return { ok: true as const };
        })
        .build();
    },

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
              .join((j) => j.organizationMemberOrganization());

            return cursor ? query.after(cursor) : query;
          }),
        )
        .transformRetrieve(([result]) => {
          const organizations = result.items
            .filter((member) => member.organizationMemberOrganization)
            .map((member) => {
              const organization = member.organizationMemberOrganization;
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
