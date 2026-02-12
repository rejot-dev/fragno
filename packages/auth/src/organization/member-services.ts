import type { DatabaseServiceContext } from "@fragno-dev/db";
import type { Cursor } from "@fragno-dev/db/cursor";
import { authSchema } from "../schema";
import type { OrganizationMember } from "./types";
import { DEFAULT_MEMBER_ROLES, normalizeRoleNames, toExternalId } from "./utils";

type AuthServiceContext = DatabaseServiceContext<{}>;

type CreateMemberInput = {
  organizationId: string;
  userId: string;
  roles?: readonly string[];
};

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

export function createOrganizationMemberServices() {
  return {
    createOrganizationMember: function (this: AuthServiceContext, input: CreateMemberInput) {
      const roles = normalizeRoleNames(input.roles, DEFAULT_MEMBER_ROLES);
      const now = new Date();

      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow.findFirst("organizationMember", (b) =>
            b.whereIndex("idx_org_member_org_user", (eb) =>
              eb.and(
                eb("organizationId", "=", input.organizationId),
                eb("userId", "=", input.userId),
              ),
            ),
          ),
        )
        .mutate(({ uow, retrieveResult: [existing] }) => {
          if (existing) {
            return { ok: false as const, code: "member_already_exists" as const };
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

          return {
            ok: true as const,
            member: mapMember(
              {
                id: memberId,
                organizationId: input.organizationId,
                userId: input.userId,
                createdAt: now,
                updatedAt: now,
              },
              roles,
            ),
          };
        })
        .build();
    },

    createOrganizationMemberRole: function (
      this: AuthServiceContext,
      memberId: string,
      role: string,
    ) {
      const now = new Date();

      return this.serviceTx(authSchema)
        .mutate(({ uow }) => {
          uow.create("organizationMemberRole", {
            memberId,
            role,
            createdAt: now,
          });

          return { ok: true as const };
        })
        .build();
    },

    removeOrganizationMemberRole: function (
      this: AuthServiceContext,
      memberId: string,
      role: string,
    ) {
      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow.findFirst("organizationMemberRole", (b) =>
            b.whereIndex("idx_org_member_role_member_role", (eb) =>
              eb.and(eb("memberId", "=", memberId), eb("role", "=", role)),
            ),
          ),
        )
        .mutate(({ uow, retrieveResult: [existing] }) => {
          if (!existing) {
            return { ok: false as const, code: "role_not_found" as const };
          }

          uow.delete("organizationMemberRole", existing.id, (b) => b.check());
          return { ok: true as const };
        })
        .build();
    },

    updateOrganizationMemberRoles: function (
      this: AuthServiceContext,
      memberId: string,
      roles: readonly string[],
    ) {
      const nextRoles = normalizeRoleNames(roles, DEFAULT_MEMBER_ROLES);
      const now = new Date();

      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow
            .findFirst("organizationMember", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", memberId)),
            )
            .find("organizationMemberRole", (b) =>
              b.whereIndex("idx_org_member_role_member", (eb) => eb("memberId", "=", memberId)),
            ),
        )
        .mutate(({ uow, retrieveResult: [member, existingRoles] }) => {
          if (!member) {
            return { ok: false as const, code: "member_not_found" as const };
          }

          for (const existing of existingRoles) {
            uow.delete("organizationMemberRole", existing.id, (b) => b.check());
          }

          for (const role of nextRoles) {
            uow.create("organizationMemberRole", {
              memberId,
              role,
              createdAt: now,
            });
          }

          uow.update("organizationMember", member.id, (b) => b.set({ updatedAt: now }).check());

          return {
            ok: true as const,
            member: mapMember(
              {
                id: member.id,
                organizationId: member.organizationId,
                userId: member.userId,
                createdAt: member.createdAt,
                updatedAt: now,
              },
              nextRoles,
            ),
          };
        })
        .build();
    },

    removeOrganizationMember: function (this: AuthServiceContext, memberId: string) {
      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow
            .findFirst("organizationMember", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", memberId)),
            )
            .find("organizationMemberRole", (b) =>
              b.whereIndex("idx_org_member_role_member", (eb) => eb("memberId", "=", memberId)),
            ),
        )
        .mutate(({ uow, retrieveResult: [member, roles] }) => {
          if (!member) {
            return { ok: false as const, code: "member_not_found" as const };
          }

          for (const role of roles) {
            uow.delete("organizationMemberRole", role.id, (b) => b.check());
          }

          uow.delete("organizationMember", member.id, (b) => b.check());
          return { ok: true as const };
        })
        .build();
    },

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
              .pageSize(effectivePageSize);

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
  };
}
