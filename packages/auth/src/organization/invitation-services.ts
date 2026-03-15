import type { DatabaseServiceContext } from "@fragno-dev/db";

import type { AuthHooksMap } from "../hooks";
import { authSchema } from "../schema";
import type { Role } from "../types";
import { mapUserSummary } from "../user/summary";
import { bytesToHex, randomBytes } from "../utils/crypto";
import { canManageOrganization, isGlobalAdmin } from "./permissions";
import type {
  Organization,
  OrganizationConfig,
  OrganizationInvitation,
  OrganizationInvitationStatus,
} from "./types";
import { DEFAULT_MEMBER_ROLES, normalizeRoleNames, toExternalId } from "./utils";

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

type ListInvitationsForSessionParams = {
  sessionId: string;
};

type RespondInvitationWithSessionParams = {
  sessionId: string;
  invitationId: string;
  action: "accept" | "reject" | "cancel";
  token?: string;
};

type ListOrganizationInvitationsWithSessionParams = {
  sessionId: string;
  organizationId: string;
};

type CreateOrganizationInvitationWithSessionParams = {
  sessionId: string;
  organizationId: string;
  email: string;
  roles?: readonly string[];
};

type OrganizationInvitationServiceOptions = {
  organizationConfig?: OrganizationConfig<string>;
};

type OrganizationRow = {
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
};

type InvitationRow = {
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
  organization?: OrganizationRow | null;
};

const mapOrganization = (organization: OrganizationRow): Organization => ({
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

const mapInvitation = (invitation: InvitationRow): OrganizationInvitation<string> => ({
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

const mapInvitationRow = (
  invitation: InvitationRow,
  organizationIdOverride?: unknown,
): OrganizationInvitation<string> => ({
  id: toExternalId(invitation.id),
  organizationId: toExternalId(organizationIdOverride ?? invitation.organizationId),
  email: invitation.email,
  roles: Array.isArray(invitation.roles) ? (invitation.roles as string[]) : [],
  status: invitation.status as OrganizationInvitationStatus,
  token: invitation.token,
  inviterId: toExternalId(invitation.inviterId),
  expiresAt: invitation.expiresAt,
  createdAt: invitation.createdAt,
  respondedAt: invitation.respondedAt ?? null,
});

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

const matchesOrganizationId = (left: unknown, right: unknown): boolean => {
  const leftInternal = resolveInternalId(left);
  const rightInternal = resolveInternalId(right);
  if (leftInternal !== undefined && rightInternal !== undefined) {
    return String(leftInternal) === String(rightInternal);
  }
  return toExternalId(left) === toExternalId(right);
};

const buildExpiresAt = (input: CreateInvitationInput): Date => {
  if (input.expiresAt) {
    return input.expiresAt;
  }
  const days = input.expiresInDays ?? 3;
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + days);
  return expiresAt;
};

const normalizeEmail = (value: string) => value.trim().toLowerCase();

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
    /**
     * Fetch an invitation by id and include its organization.
     */
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

    /**
     * Create an organization invitation with permission checks.
     */
    createOrganizationInvitation: function (
      this: AuthServiceContext,
      input: CreateInvitationInput,
    ) {
      const roles = normalizeRoleNames(input.roles, defaultMemberRoles ?? DEFAULT_MEMBER_ROLES);
      const now = new Date();
      const token = bytesToHex(randomBytes(32));
      const actorMemberId = input.actorMemberId;
      const normalizedEmail = normalizeEmail(input.email);
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

          const pendingInvitesForEmail = invitations.filter(
            (invitation) => normalizeEmail(invitation.email) === normalizedEmail,
          );
          const existingInvitation =
            pendingInvitesForEmail.length > 0
              ? pendingInvitesForEmail.reduce((latest, invitation) =>
                  invitation.createdAt > latest.createdAt ? invitation : latest,
                )
              : null;

          const organization = actorMember.organizationMemberOrganization
            ? mapOrganization(actorMember.organizationMemberOrganization)
            : null;
          const actorSummary = actorUser ? mapUserSummary(actorUser) : null;

          if (existingInvitation) {
            for (const invitation of pendingInvitesForEmail) {
              if (invitation.id !== existingInvitation.id) {
                uow.update("organizationInvitation", invitation.id, (b) =>
                  b.set({ status: "canceled", respondedAt: now }).check(),
                );
              }
            }

            uow.update("organizationInvitation", existingInvitation.id, (b) =>
              b
                .set({
                  organizationId: input.organizationId,
                  email: input.email,
                  roles,
                  status: "pending",
                  token,
                  inviterId: input.inviterId,
                  expiresAt,
                  createdAt: now,
                  respondedAt: null,
                })
                .check(),
            );

            uow.triggerHook(
              "onInvitationExpired",
              { invitationId: toExternalId(existingInvitation.id) },
              { processAt: expiresAt },
            );

            const invitation = mapInvitation({
              id: existingInvitation.id,
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

          uow.triggerHook(
            "onInvitationExpired",
            { invitationId: toExternalId(invitationId) },
            { processAt: expiresAt },
          );

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

    /**
     * List invitations for an organization, optionally by status.
     */
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

    /**
     * List invitations for an email address with organization details.
     */
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
            ).join((j) =>
              j.organizationInvitationOrganization((org) =>
                org.join((j) => j.organizationCreator()),
              ),
            ),
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
                      invitation.organizationInvitationOrganization.organizationCreator?.id ??
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

    /**
     * Accept, reject, or cancel an invitation with validation and hooks.
     */
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
              return {
                ok: false as const,
                code:
                  status === "expired"
                    ? ("invitation_expired" as const)
                    : ("invitation_not_found" as const),
              };
            }

            if (input.action !== "cancel") {
              if (!input.token || input.token !== invitation.token) {
                return { ok: false as const, code: "invalid_token" as const };
              }

              if (invitation.expiresAt < now) {
                uow.update("organizationInvitation", invitation.id, (b) =>
                  b.set({ status: "expired", respondedAt: now }).check(),
                );
                return { ok: false as const, code: "invitation_expired" as const };
              }

              const actorEmail = actorUser?.email;
              if (!actorEmail) {
                return { ok: false as const, code: "permission_denied" as const };
              }

              if (normalizeEmail(actorEmail) !== normalizeEmail(invitation.email)) {
                return { ok: false as const, code: "permission_denied" as const };
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

    /**
     * List invitations for a session.
     */
    listInvitationsForSession: function (
      this: AuthServiceContext,
      params: ListInvitationsForSessionParams,
    ) {
      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow
            .find("session", (b) =>
              b
                .whereIndex("idx_session_id_expiresAt", (eb) =>
                  eb.and(eb("id", "=", params.sessionId), eb("expiresAt", ">", eb.now())),
                )
                .join((jb) =>
                  jb.sessionOwner((ub) =>
                    ub
                      .select(["id", "email", "role", "bannedAt"])
                      .join((jb2) =>
                        jb2["invitations"]((ib) => ib.join((jb3) => jb3["organization"]())),
                      ),
                  ),
                ),
            )
            .findFirst("session", (b) =>
              b.whereIndex("idx_session_id_expiresAt", (eb) =>
                eb.and(eb("id", "=", params.sessionId), eb("expiresAt", "<=", eb.now())),
              ),
            ),
        )
        .mutate(({ uow, retrieveResult: [sessions, expiredSession] }) => {
          if (expiredSession) {
            uow.delete("session", expiredSession.id, (b) => b.check());
          }

          const session = sessions[0] ?? null;
          if (!session || !session.sessionOwner) {
            return { ok: false as const, code: "session_invalid" as const };
          }

          const invitations: Array<{
            invitation: OrganizationInvitation<string>;
            organization: Organization;
          }> = [];
          const seenInvitationIds = new Set<string>();

          for (const row of sessions) {
            const sessionOwner = row.sessionOwner;
            if (!sessionOwner) {
              continue;
            }

            const invitationsForUser = normalizeMany(
              (sessionOwner as { invitations?: unknown }).invitations,
            ) as InvitationRow[];
            for (const invitation of invitationsForUser) {
              if (!invitation || invitation.status !== "pending") {
                continue;
              }

              const organizationRow = invitation.organization;
              if (!organizationRow || organizationRow.deletedAt) {
                continue;
              }

              const invitationId = toExternalId(invitation.id);
              if (seenInvitationIds.has(invitationId)) {
                continue;
              }
              seenInvitationIds.add(invitationId);

              const organization = mapOrganization(organizationRow);
              const mappedInvitation = mapInvitationRow(invitation, organization.id);
              invitations.push({
                invitation: mappedInvitation,
                organization,
              });
            }
          }

          return { ok: true as const, invitations };
        })
        .build();
    },

    /**
     * Respond to an invitation using session permissions.
     */
    respondToInvitationWithSession: function (
      this: AuthServiceContext,
      params: RespondInvitationWithSessionParams,
    ) {
      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow
            .find("session", (b) =>
              b
                .whereIndex("idx_session_id_expiresAt", (eb) =>
                  eb.and(eb("id", "=", params.sessionId), eb("expiresAt", ">", eb.now())),
                )
                .join((j) =>
                  j
                    .sessionOwner((b) => b.select(["id", "email", "role", "bannedAt"]))
                    .sessionMembers((mb) => mb.join((jb) => jb["organizationMemberRoles"]())),
                ),
            )
            .findFirst("session", (b) =>
              b.whereIndex("idx_session_id_expiresAt", (eb) =>
                eb.and(eb("id", "=", params.sessionId), eb("expiresAt", "<=", eb.now())),
              ),
            )
            .find("organizationInvitation", (b) =>
              b
                .whereIndex("primary", (eb) => eb("id", "=", params.invitationId))
                .join((j) =>
                  j.organizationInvitationOrganization((ob) =>
                    ob.join((jb) => jb["organizationMembers"]()),
                  ),
                ),
            ),
        )
        .mutate(({ uow, retrieveResult: [sessions, expiredSession, invitations] }) => {
          if (expiredSession) {
            uow.delete("session", expiredSession.id, (b) => b.check());
          }

          const session = sessions[0] ?? null;
          if (!session || !session.sessionOwner) {
            return { ok: false as const, code: "session_invalid" as const };
          }
          const sessionOwner = session.sessionOwner;

          const invitation = invitations[0] ?? null;
          if (!invitation) {
            return { ok: false as const, code: "invitation_not_found" as const };
          }

          const status = invitation.status as OrganizationInvitationStatus;
          if (status !== "pending") {
            return {
              ok: false as const,
              code:
                status === "expired"
                  ? ("invitation_expired" as const)
                  : ("invitation_not_found" as const),
            };
          }

          const now = new Date();
          if (params.action !== "cancel") {
            if (!params.token || params.token !== invitation.token) {
              return { ok: false as const, code: "invalid_token" as const };
            }
            if (invitation.expiresAt < now) {
              uow.update("organizationInvitation", invitation.id, (b) =>
                b.set({ status: "expired", respondedAt: now }).check(),
              );
              return { ok: false as const, code: "invitation_expired" as const };
            }

            const actorEmail = sessionOwner.email;
            if (!actorEmail) {
              return { ok: false as const, code: "permission_denied" as const };
            }
            if (normalizeEmail(actorEmail) !== normalizeEmail(invitation.email)) {
              return { ok: false as const, code: "permission_denied" as const };
            }
          }

          const invitationOrganization = (
            invitation as {
              organizationInvitationOrganization?:
                | (OrganizationRow & { organizationMembers?: unknown })
                | null;
            }
          ).organizationInvitationOrganization;
          if (!invitationOrganization || invitationOrganization.deletedAt) {
            return { ok: false as const, code: "invitation_not_found" as const };
          }
          const organizationSummary = mapOrganization(invitationOrganization);
          const memberRows = invitations.flatMap((entry) => {
            const organization = (
              entry as {
                organizationInvitationOrganization?:
                  | (OrganizationRow & { organizationMembers?: unknown })
                  | null;
              }
            ).organizationInvitationOrganization;
            if (!organization) {
              return [];
            }
            return normalizeMany(
              (organization as { organizationMembers?: unknown }).organizationMembers,
            ) as Array<{ id: unknown; userId: unknown; organizationId: unknown }>;
          });
          const memberIds = new Set(
            memberRows.map((member) => toExternalId((member as { id?: unknown }).id ?? member)),
          );

          const sessionMembers = sessions.flatMap((entry) => normalizeMany(entry.sessionMembers));
          const invitationOrgId = invitationOrganization?.id ?? invitation.organizationId;
          const actorMember = sessionMembers.find((member) =>
            matchesOrganizationId(member.organizationId, invitationOrgId),
          );

          if (params.action === "cancel") {
            const actorRoles = actorMember
              ? extractRoles(
                  (actorMember as { organizationMemberRoles?: unknown }).organizationMemberRoles,
                )
              : [];
            const isInviter = toExternalId(invitation.inviterId) === toExternalId(sessionOwner.id);
            const canCancel =
              isInviter ||
              isGlobalAdmin(sessionOwner.role as Role) ||
              (actorMember && canManageOrganization(actorRoles));

            if (!canCancel) {
              return { ok: false as const, code: "permission_denied" as const };
            }
          }

          const actorSummary = mapUserSummary({
            id: sessionOwner.id,
            email: sessionOwner.email,
            role: sessionOwner.role,
            bannedAt: sessionOwner.bannedAt ?? null,
          });

          const invitationRoles = Array.isArray(invitation.roles)
            ? (invitation.roles as string[])
            : [];
          const existingMember =
            actorMember ??
            memberRows.find(
              (member) => toExternalId(member.userId) === toExternalId(sessionOwner.id),
            );

          if (params.action === "accept") {
            if (existingMember) {
              uow.update("organizationInvitation", invitation.id, (b) =>
                b.set({ status: "accepted", respondedAt: now }).check(),
              );

              const acceptedInvitation = mapInvitationRow({
                ...invitation,
                status: "accepted",
                respondedAt: now,
              });

              if (organizationSummary) {
                uow.triggerHook("onInvitationAccepted", {
                  organization: organizationSummary,
                  invitation: acceptedInvitation,
                  actor: actorSummary,
                });
              }

              return {
                ok: true as const,
                invitation: acceptedInvitation,
              };
            }

            if (
              limits?.membersPerOrganization !== undefined &&
              memberIds.size >= limits.membersPerOrganization
            ) {
              return { ok: false as const, code: "limit_reached" as const };
            }

            const memberId = uow.create("organizationMember", {
              organizationId: invitation.organizationId,
              userId: sessionOwner.id,
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

            const acceptedInvitation = mapInvitationRow({
              ...invitation,
              status: "accepted",
              respondedAt: now,
            });

            if (organizationSummary) {
              uow.triggerHook("onInvitationAccepted", {
                organization: organizationSummary,
                invitation: acceptedInvitation,
                actor: actorSummary,
              });
              uow.triggerHook("onMemberAdded", {
                organization: organizationSummary,
                member: {
                  id: toExternalId(memberId),
                  organizationId: toExternalId(invitation.organizationId),
                  userId: toExternalId(sessionOwner.id),
                  roles: invitationRoles,
                  createdAt: now,
                  updatedAt: now,
                },
                actor: actorSummary,
              });
            }

            return {
              ok: true as const,
              invitation: acceptedInvitation,
            };
          }

          const nextStatus = params.action === "reject" ? "rejected" : "canceled";
          uow.update("organizationInvitation", invitation.id, (b) =>
            b.set({ status: nextStatus, respondedAt: now }).check(),
          );

          const nextInvitation = mapInvitationRow({
            ...invitation,
            status: nextStatus,
            respondedAt: now,
          });

          if (organizationSummary) {
            const hookName =
              params.action === "reject" ? "onInvitationRejected" : "onInvitationCanceled";
            uow.triggerHook(hookName, {
              organization: organizationSummary,
              invitation: nextInvitation,
              actor: actorSummary,
            });
          }

          return {
            ok: true as const,
            invitation: nextInvitation,
          };
        })
        .build();
    },

    /**
     * List invitations for an organization using session permissions.
     */
    listOrganizationInvitationsWithSession: function (
      this: AuthServiceContext,
      params: ListOrganizationInvitationsWithSessionParams,
    ) {
      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow
            .findFirst("session", (b) =>
              b
                .whereIndex("idx_session_id_expiresAt", (eb) =>
                  eb.and(eb("id", "=", params.sessionId), eb("expiresAt", ">", eb.now())),
                )
                .join((j) => j.sessionMembers()),
            )
            .findFirst("session", (b) =>
              b.whereIndex("idx_session_id_expiresAt", (eb) =>
                eb.and(eb("id", "=", params.sessionId), eb("expiresAt", "<=", eb.now())),
              ),
            )
            .findFirst("organization", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", params.organizationId)),
            )
            .find("organizationInvitation", (b) =>
              b.whereIndex("idx_org_invitation_org_status", (eb) =>
                eb("organizationId", "=", params.organizationId),
              ),
            ),
        )
        .mutate(({ uow, retrieveResult: [session, expiredSession, organization, invitations] }) => {
          if (expiredSession) {
            uow.delete("session", expiredSession.id, (b) => b.check());
          }

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

          const mappedInvitations = invitations.map((invitation) => mapInvitationRow(invitation));

          return { ok: true as const, invitations: mappedInvitations };
        })
        .build();
    },

    /**
     * Create an invitation using session permissions.
     */
    createOrganizationInvitationWithSession: function (
      this: AuthServiceContext,
      params: CreateOrganizationInvitationWithSessionParams,
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
                .join((j) =>
                  j
                    .sessionOwner((b) => b.select(["id", "email", "role", "bannedAt"]))
                    .sessionMembers((mb) => mb.join((jb) => jb["organizationMemberRoles"]())),
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
            .find("organizationInvitation", (b) =>
              b.whereIndex("idx_org_invitation_org_status", (eb) =>
                eb.and(
                  eb("organizationId", "=", params.organizationId),
                  eb("status", "=", "pending"),
                ),
              ),
            ),
        )
        .mutate(({ uow, retrieveResult: [session, expiredSession, organization, invitations] }) => {
          if (expiredSession) {
            uow.delete("session", expiredSession.id, (b) => b.check());
          }

          if (!session || !session.sessionOwner) {
            return { ok: false as const, code: "session_invalid" as const };
          }
          const sessionOwner = session.sessionOwner;

          if (!organization || organization.deletedAt != null) {
            return { ok: false as const, code: "organization_not_found" as const };
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
          if (!isGlobalAdmin(sessionOwner.role as Role) && !canManageOrganization(actorRoles)) {
            return { ok: false as const, code: "permission_denied" as const };
          }

          const actorSummary = mapUserSummary({
            id: sessionOwner.id,
            email: sessionOwner.email,
            role: sessionOwner.role,
            bannedAt: sessionOwner.bannedAt ?? null,
          });

          const normalizedEmail = normalizeEmail(params.email);
          const pendingInvitesForEmail = invitations.filter(
            (invitation) => normalizeEmail(invitation.email) === normalizedEmail,
          );
          const existingInvitation =
            pendingInvitesForEmail.length > 0
              ? pendingInvitesForEmail.reduce((latest, invitation) =>
                  invitation.createdAt > latest.createdAt ? invitation : latest,
                )
              : null;

          const now = new Date();
          const token = bytesToHex(randomBytes(32));
          const expiresAt = buildExpiresAt({
            organizationId: params.organizationId,
            email: params.email,
            roles,
            inviterId: toExternalId(sessionOwner.id),
            actor: {
              userId: toExternalId(sessionOwner.id),
              userRole: sessionOwner.role as Role,
            },
            expiresInDays: invitationExpiresInDays,
          });

          if (existingInvitation) {
            for (const invitation of pendingInvitesForEmail) {
              if (invitation.id !== existingInvitation.id) {
                uow.update("organizationInvitation", invitation.id, (b) =>
                  b.set({ status: "canceled", respondedAt: now }).check(),
                );
              }
            }

            uow.update("organizationInvitation", existingInvitation.id, (b) =>
              b
                .set({
                  organizationId: params.organizationId,
                  email: params.email,
                  roles,
                  status: "pending",
                  token,
                  inviterId: sessionOwner.id,
                  expiresAt,
                  createdAt: now,
                  respondedAt: null,
                })
                .check(),
            );

            uow.triggerHook(
              "onInvitationExpired",
              { invitationId: toExternalId(existingInvitation.id) },
              { processAt: expiresAt },
            );

            const invitation = mapInvitationRow({
              id: existingInvitation.id,
              organizationId: params.organizationId,
              email: params.email,
              roles,
              status: "pending",
              token,
              inviterId: sessionOwner.id,
              expiresAt,
              createdAt: now,
              respondedAt: null,
            });

            uow.triggerHook("onInvitationCreated", {
              organization: mapOrganization(organization),
              invitation,
              actor: actorSummary,
            });

            return {
              ok: true as const,
              invitation,
            };
          }

          if (
            limits?.invitationsPerOrganization !== undefined &&
            invitations.length >= limits.invitationsPerOrganization
          ) {
            return { ok: false as const, code: "limit_reached" as const };
          }

          const invitationId = uow.create("organizationInvitation", {
            organizationId: params.organizationId,
            email: params.email,
            roles,
            status: "pending",
            token,
            inviterId: sessionOwner.id,
            expiresAt,
            createdAt: now,
            respondedAt: null,
          });

          uow.triggerHook(
            "onInvitationExpired",
            { invitationId: toExternalId(invitationId) },
            { processAt: expiresAt },
          );

          const invitation = mapInvitationRow({
            id: invitationId,
            organizationId: params.organizationId,
            email: params.email,
            roles,
            status: "pending",
            token,
            inviterId: sessionOwner.id,
            expiresAt,
            createdAt: now,
            respondedAt: null,
          });

          uow.triggerHook("onInvitationCreated", {
            organization: mapOrganization(organization),
            invitation,
            actor: actorSummary,
          });

          return {
            ok: true as const,
            invitation,
          };
        })
        .build();
    },
  };
}
