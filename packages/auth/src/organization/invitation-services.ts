import { randomBytes } from "node:crypto";
import type { DatabaseServiceContext } from "@fragno-dev/db";
import type { AuthHooksMap } from "../hooks";
import { authSchema } from "../schema";
import type {
  Organization,
  OrganizationConfig,
  OrganizationInvitation,
  OrganizationInvitationStatus,
} from "./types";
import { DEFAULT_MEMBER_ROLES, normalizeRoleNames, toExternalId } from "./utils";
import { canManageOrganization, isGlobalAdmin } from "./permissions";
import type { Role } from "../types";
import { mapUserSummary } from "../user/summary";

type AuthServiceContext = DatabaseServiceContext<AuthHooksMap>;

type CreateInvitationInput = {
  organizationId: string;
  email: string;
  roles?: readonly string[];
  inviterId: string;
  expiresAt?: Date;
  expiresInDays?: number;
  actor: { userId: string; userRole: Role };
  actorMemberId?: string;
};

type RespondInvitationInput = {
  invitationId: string;
  action: "accept" | "reject" | "cancel";
  token?: string;
  actor: { userId: string; userRole: Role };
  organizationId?: string;
  actorMemberId?: string;
};

type OrganizationInvitationServiceOptions = {
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

const mapInvitation = (invitation: {
  id: unknown;
  organizationId: unknown;
  email: string;
  roles: unknown;
  status: string;
  token: string;
  inviterId: unknown;
  expiresAt: Date;
  createdAt: Date;
  respondedAt: Date | null;
}): OrganizationInvitation<string> => ({
  id: toExternalId(invitation.id),
  organizationId: toExternalId(invitation.organizationId),
  email: invitation.email,
  roles: Array.isArray(invitation.roles) ? (invitation.roles as string[]) : [],
  status: invitation.status as OrganizationInvitationStatus,
  token: invitation.token,
  inviterId: toExternalId(invitation.inviterId),
  expiresAt: invitation.expiresAt,
  createdAt: invitation.createdAt,
  respondedAt: invitation.respondedAt ?? null,
});

const buildExpiresAt = (input: CreateInvitationInput): Date => {
  if (input.expiresAt) {
    return input.expiresAt;
  }
  const days = input.expiresInDays ?? 3;
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + days);
  return expiresAt;
};

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

export function createOrganizationInvitationServices(
  options: OrganizationInvitationServiceOptions = {},
) {
  const limits = options.organizationConfig?.limits;
  const invitationExpiresInDays = options.organizationConfig?.invitationExpiresInDays;
  const defaultMemberRoles = options.organizationConfig?.defaultMemberRoles;
  return {
    getOrganizationInvitationById: function (this: AuthServiceContext, invitationId: string) {
      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow.findFirst("organizationInvitation", (b) =>
            b
              .whereIndex("primary", (eb) => eb("id", "=", invitationId))
              .join((j) => j.organizationInvitationOrganization()),
          ),
        )
        .transformRetrieve(([invitation]) =>
          invitation
            ? {
                invitation: mapInvitation({
                  id: invitation.id,
                  organizationId: invitation.organizationInvitationOrganization
                    ? invitation.organizationInvitationOrganization.id
                    : invitation.organizationId,
                  email: invitation.email,
                  roles: invitation.roles,
                  status: invitation.status,
                  token: invitation.token,
                  inviterId: invitation.inviterId,
                  expiresAt: invitation.expiresAt,
                  createdAt: invitation.createdAt,
                  respondedAt: invitation.respondedAt,
                }),
              }
            : null,
        )
        .build();
    },

    createOrganizationInvitation: function (
      this: AuthServiceContext,
      input: CreateInvitationInput,
    ) {
      const roles = normalizeRoleNames(input.roles, defaultMemberRoles ?? DEFAULT_MEMBER_ROLES);
      const now = new Date();
      const token = randomBytes(32).toString("hex");
      const actorMemberId = input.actorMemberId;
      const expiresAt = buildExpiresAt({
        ...input,
        expiresInDays: input.expiresInDays ?? invitationExpiresInDays,
      });

      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow
            .findFirst("organizationMember", (b) =>
              b
                .whereIndex("idx_org_member_org_user", (eb) =>
                  eb.and(
                    eb("organizationId", "=", input.organizationId),
                    eb("userId", "=", input.actor.userId),
                  ),
                )
                .join((j) => j.organizationMemberOrganization()),
            )
            .find("organizationMemberRole", (b) => {
              const scoped = actorMemberId
                ? b.whereIndex("idx_org_member_role_member", (eb) =>
                    eb("memberId", "=", actorMemberId),
                  )
                : b.whereIndex("primary");
              return scoped.join((j) => j.organizationMemberRoleMember());
            })
            .find("organizationInvitation", (b) =>
              b.whereIndex("idx_org_invitation_org_status", (eb) =>
                eb.and(
                  eb("organizationId", "=", input.organizationId),
                  eb("status", "=", "pending"),
                ),
              ),
            )
            .findFirst("user", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", input.actor.userId)),
            ),
        )
        .mutate(({ uow, retrieveResult: [actorMember, actorRoles, invitations, actorUser] }) => {
          if (!actorMember) {
            return { ok: false as const, code: "permission_denied" as const };
          }

          const actorRoleNames = filterRolesForMemberId(actorRoles, actorMember);
          if (!isGlobalAdmin(input.actor.userRole) && !canManageOrganization(actorRoleNames)) {
            return { ok: false as const, code: "permission_denied" as const };
          }

          if (
            limits?.invitationsPerOrganization !== undefined &&
            invitations.length >= limits.invitationsPerOrganization
          ) {
            return { ok: false as const, code: "limit_reached" as const };
          }

          const invitationId = uow.create("organizationInvitation", {
            organizationId: input.organizationId,
            email: input.email,
            roles,
            status: "pending",
            token,
            inviterId: input.inviterId,
            expiresAt,
            createdAt: now,
            respondedAt: null,
          });

          const organization = actorMember.organizationMemberOrganization
            ? mapOrganization(actorMember.organizationMemberOrganization)
            : null;
          const invitation = mapInvitation({
            id: invitationId,
            organizationId: input.organizationId,
            email: input.email,
            roles,
            status: "pending",
            token,
            inviterId: input.inviterId,
            expiresAt,
            createdAt: now,
            respondedAt: null,
          });
          const actorSummary = actorUser ? mapUserSummary(actorUser) : null;

          if (organization) {
            uow.triggerHook("onInvitationCreated", {
              organization,
              invitation,
              actor: actorSummary,
            });
          }

          return {
            ok: true as const,
            invitation,
          };
        })
        .build();
    },

    listOrganizationInvitations: function (
      this: AuthServiceContext,
      params: { organizationId: string; status?: OrganizationInvitationStatus },
    ) {
      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow.find("organizationInvitation", (b) =>
            b.whereIndex("idx_org_invitation_org_status", (eb) =>
              params.status
                ? eb.and(
                    eb("organizationId", "=", params.organizationId),
                    eb("status", "=", params.status),
                  )
                : eb("organizationId", "=", params.organizationId),
            ),
          ),
        )
        .transformRetrieve(([invitations]) => ({
          invitations: invitations.map(mapInvitation),
        }))
        .build();
    },

    listOrganizationInvitationsForUser: function (
      this: AuthServiceContext,
      params: { email: string; status?: OrganizationInvitationStatus },
    ) {
      const { email, status } = params;
      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow.find("organizationInvitation", (b) =>
            (status
              ? b.whereIndex("idx_org_invitation_email_status", (eb) =>
                  eb.and(eb("email", "=", email), eb("status", "=", status)),
                )
              : b.whereIndex("idx_org_invitation_email", (eb) => eb("email", "=", email))
            ).join((j) => j.organizationInvitationOrganization()),
          ),
        )
        .transformRetrieve(([invitations]) => ({
          invitations: invitations.map((invitation) => ({
            invitation: mapInvitation({
              id: invitation.id,
              organizationId: invitation.organizationId,
              email: invitation.email,
              roles: invitation.roles,
              status: invitation.status,
              token: invitation.token,
              inviterId: invitation.inviterId,
              expiresAt: invitation.expiresAt,
              createdAt: invitation.createdAt,
              respondedAt: invitation.respondedAt,
            }),
            organization:
              invitation.organizationInvitationOrganization &&
              invitation.organizationInvitationOrganization.deletedAt == null
                ? {
                    id: toExternalId(invitation.organizationInvitationOrganization.id),
                    name: invitation.organizationInvitationOrganization.name,
                    slug: invitation.organizationInvitationOrganization.slug,
                    logoUrl: invitation.organizationInvitationOrganization.logoUrl ?? null,
                    metadata: invitation.organizationInvitationOrganization.metadata ?? null,
                    createdBy: toExternalId(
                      invitation.organizationInvitationOrganization.createdBy,
                    ),
                    createdAt: invitation.organizationInvitationOrganization.createdAt,
                    updatedAt: invitation.organizationInvitationOrganization.updatedAt,
                    deletedAt: invitation.organizationInvitationOrganization.deletedAt ?? null,
                  }
                : null,
          })),
        }))
        .build();
    },

    respondToOrganizationInvitation: function (
      this: AuthServiceContext,
      input: RespondInvitationInput,
    ) {
      const now = new Date();
      const actorMemberId = input.actorMemberId;

      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow
            .findFirst("organizationInvitation", (b) =>
              b
                .whereIndex("primary", (eb) => eb("id", "=", input.invitationId))
                .join((j) => j.organizationInvitationOrganization()),
            )
            .findFirst("organizationMember", (b) =>
              b.whereIndex("idx_org_member_org_user", (eb) =>
                eb.and(
                  eb("organizationId", "=", input.organizationId ?? ""),
                  eb("userId", "=", input.actor.userId),
                ),
              ),
            )
            .find("organizationMemberRole", (b) => {
              const scoped = actorMemberId
                ? b.whereIndex("idx_org_member_role_member", (eb) =>
                    eb("memberId", "=", actorMemberId),
                  )
                : b.whereIndex("primary");
              return scoped.join((j) => j.organizationMemberRoleMember());
            })
            .find("organizationMember", (b) =>
              b
                .whereIndex("idx_org_member_org", (eb) =>
                  eb("organizationId", "=", input.organizationId ?? ""),
                )
                .join((j) => j.organizationMemberUser()),
            )
            .findFirst("user", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", input.actor.userId)),
            ),
        )
        .mutate(
          ({ uow, retrieveResult: [invitation, actorMember, actorRoles, members, actorUser] }) => {
            if (!invitation) {
              return { ok: false as const, code: "invitation_not_found" as const };
            }

            const status = invitation.status as OrganizationInvitationStatus;
            if (status !== "pending") {
              return { ok: false as const, code: "invitation_not_found" as const };
            }

            if (input.action !== "cancel") {
              if (!input.token || input.token !== invitation.token) {
                return { ok: false as const, code: "invalid_token" as const };
              }

              if (invitation.expiresAt < now) {
                return { ok: false as const, code: "invitation_expired" as const };
              }
            }

            if (input.action === "cancel") {
              const actorRoleNames = filterRolesForMemberId(actorRoles, actorMember);
              const isInviter = toExternalId(invitation.inviterId) === input.actor.userId;
              const canCancel =
                isInviter ||
                isGlobalAdmin(input.actor.userRole) ||
                (actorMember && canManageOrganization(actorRoleNames));

              if (!canCancel) {
                return { ok: false as const, code: "permission_denied" as const };
              }
            }

            const organization = invitation.organizationInvitationOrganization
              ? mapOrganization(invitation.organizationInvitationOrganization)
              : null;
            const actorSummary = actorUser ? mapUserSummary(actorUser) : null;
            const invitationRoles = Array.isArray(invitation.roles)
              ? (invitation.roles as string[])
              : [];

            if (input.action === "accept") {
              const existingMember =
                actorMember ??
                members.find(
                  (member) =>
                    member.organizationMemberUser &&
                    toExternalId(member.organizationMemberUser.id) === input.actor.userId,
                );

              if (existingMember) {
                uow.update("organizationInvitation", invitation.id, (b) =>
                  b.set({ status: "accepted", respondedAt: now }).check(),
                );

                const acceptedInvitation = mapInvitation({
                  id: invitation.id,
                  organizationId: invitation.organizationId,
                  email: invitation.email,
                  roles: invitation.roles,
                  status: "accepted",
                  token: invitation.token,
                  inviterId: invitation.inviterId,
                  expiresAt: invitation.expiresAt,
                  createdAt: invitation.createdAt,
                  respondedAt: now,
                });

                if (organization) {
                  uow.triggerHook("onInvitationAccepted", {
                    organization,
                    invitation: acceptedInvitation,
                    actor: actorSummary,
                  });
                }

                return {
                  ok: true as const,
                  invitation: acceptedInvitation,
                  memberId: toExternalId(existingMember.id),
                };
              }

              if (
                limits?.membersPerOrganization !== undefined &&
                members.length >= limits.membersPerOrganization
              ) {
                return { ok: false as const, code: "limit_reached" as const };
              }

              const memberId = uow.create("organizationMember", {
                organizationId: invitation.organizationId,
                userId: input.actor.userId,
                createdAt: now,
                updatedAt: now,
              });

              for (const role of invitationRoles) {
                uow.create("organizationMemberRole", {
                  memberId,
                  role,
                  createdAt: now,
                });
              }

              uow.update("organizationInvitation", invitation.id, (b) =>
                b.set({ status: "accepted", respondedAt: now }).check(),
              );

              const acceptedInvitation = mapInvitation({
                id: invitation.id,
                organizationId: invitation.organizationId,
                email: invitation.email,
                roles: invitation.roles,
                status: "accepted",
                token: invitation.token,
                inviterId: invitation.inviterId,
                expiresAt: invitation.expiresAt,
                createdAt: invitation.createdAt,
                respondedAt: now,
              });

              const member = {
                id: toExternalId(memberId),
                organizationId: organization?.id ?? toExternalId(invitation.organizationId),
                userId: input.actor.userId,
                roles: invitationRoles,
                createdAt: now,
                updatedAt: now,
              };

              if (organization) {
                uow.triggerHook("onInvitationAccepted", {
                  organization,
                  invitation: acceptedInvitation,
                  actor: actorSummary,
                });
                uow.triggerHook("onMemberAdded", {
                  organization,
                  member,
                  actor: actorSummary,
                });
              }

              return {
                ok: true as const,
                invitation: acceptedInvitation,
                memberId: toExternalId(memberId),
              };
            }

            const nextStatus = input.action === "reject" ? "rejected" : "canceled";
            uow.update("organizationInvitation", invitation.id, (b) =>
              b.set({ status: nextStatus, respondedAt: now }).check(),
            );

            const nextInvitation = mapInvitation({
              id: invitation.id,
              organizationId: invitation.organizationId,
              email: invitation.email,
              roles: invitation.roles,
              status: nextStatus,
              token: invitation.token,
              inviterId: invitation.inviterId,
              expiresAt: invitation.expiresAt,
              createdAt: invitation.createdAt,
              respondedAt: now,
            });

            if (organization) {
              const hookName =
                input.action === "reject" ? "onInvitationRejected" : "onInvitationCanceled";
              uow.triggerHook(hookName, {
                organization,
                invitation: nextInvitation,
                actor: actorSummary,
              });
            }

            return {
              ok: true as const,
              invitation: nextInvitation,
            };
          },
        )
        .build();
    },
  };
}
