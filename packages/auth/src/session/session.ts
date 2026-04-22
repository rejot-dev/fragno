import { z } from "zod";

import { defineRoute, defineRoutes } from "@fragno-dev/core";
import type { DatabaseServiceContext } from "@fragno-dev/db";

import type { Role, authFragmentDefinition } from "..";
import { buildClearedCredentialHeaders } from "../auth/credential-strategy";
import { resolveRequestCredential } from "../auth/request-auth";
import type { AuthHooksMap } from "../hooks";
import { invitationSummarySchema, memberSchema, organizationSchema } from "../organization/schemas";
import {
  serializeInvitationSummary,
  serializeMember,
  serializeOrganization,
} from "../organization/serializers";
import type {
  Organization,
  OrganizationInvitation,
  OrganizationInvitationStatus,
  OrganizationMember,
} from "../organization/types";
import { toExternalId } from "../organization/utils";
import { authSchema } from "../schema";
import { mapUserSummary } from "../user/summary";
import { buildSetCookieHeader, type CookieOptions } from "../utils/cookie";
import { resolveCredentialSeedFromMembers, type CredentialSeedInput } from "./session-seed";

type AuthServiceContext = DatabaseServiceContext<AuthHooksMap>;

const requiredOrganizationServiceNames = [
  "getOrganizationsForUser",
  "listOrganizationMemberRolesForMembers",
  "listOrganizationInvitationsForUser",
] as const;

export function assertOrganizationServices(
  services: Record<string, unknown>,
): asserts services is Record<
  (typeof requiredOrganizationServiceNames)[number],
  (...args: unknown[]) => unknown
> {
  const missing = requiredOrganizationServiceNames.filter(
    (name) => typeof services[name] !== "function",
  );
  if (missing.length > 0) {
    throw new Error(`Missing organization services: ${missing.join(", ")}`);
  }
}

type OrganizationRow = {
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

type OrganizationMemberRoleRow = {
  role: string;
};

type OrganizationMemberRow = {
  id: unknown;
  createdAt: Date;
  updatedAt: Date;
  organization?: OrganizationRow | null;
  roles?: OrganizationMemberRoleRow | OrganizationMemberRoleRow[] | null;
};

type OrganizationInvitationRow = {
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

type CredentialSeedMemberRow = {
  createdAt: Date;
  organizationMemberOrganization?: OrganizationRow | null;
};

const organizationSelect = [
  "id",
  "name",
  "slug",
  "logoUrl",
  "metadata",
  "createdBy",
  "createdAt",
  "updatedAt",
  "deletedAt",
] as const;

const normalizeMany = <T>(value: T | T[] | null | undefined): T[] => {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
};

const mapOrganizationRow = (organization: OrganizationRow): Organization => ({
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

const mapMemberRow = (
  member: OrganizationMemberRow,
  organizationId: string,
  userId: string,
  roles: string[],
): OrganizationMember<string> => ({
  id: toExternalId(member.id),
  organizationId,
  userId,
  roles,
  createdAt: member.createdAt,
  updatedAt: member.updatedAt,
});

const mapInvitationRow = (
  invitation: OrganizationInvitationRow,
  organizationId: string,
): OrganizationInvitation<string> => ({
  id: toExternalId(invitation.id),
  organizationId,
  email: invitation.email,
  roles: Array.isArray(invitation.roles) ? (invitation.roles as string[]) : [],
  status: invitation.status as OrganizationInvitationStatus,
  token: invitation.token,
  inviterId: toExternalId(invitation.inviterId),
  expiresAt: invitation.expiresAt,
  createdAt: invitation.createdAt,
  respondedAt: invitation.respondedAt ?? null,
});

const buildOrganizationsFromRows = (
  rows: OrganizationMemberRow[],
  userId: string,
): Array<{
  organization: ReturnType<typeof serializeOrganization>;
  member: ReturnType<typeof serializeMember>;
}> => {
  const organizationsByMemberId = new Map<
    string,
    {
      organization: Organization;
      member: OrganizationMember<string>;
      roles: Set<string>;
    }
  >();

  for (const member of rows) {
    const organizationRow = member.organization;
    if (!organizationRow || organizationRow.deletedAt) {
      continue;
    }
    const memberId = toExternalId(member.id);
    let entry = organizationsByMemberId.get(memberId);
    if (!entry) {
      const organization = mapOrganizationRow(organizationRow);
      entry = {
        organization,
        member: mapMemberRow(member, organization.id, userId, []),
        roles: new Set(),
      };
      organizationsByMemberId.set(memberId, entry);
    }

    const roles = normalizeMany(member.roles) as OrganizationMemberRoleRow[];
    for (const role of roles) {
      if (role?.role) {
        entry.roles.add(role.role);
      }
    }
  }

  return Array.from(organizationsByMemberId.values()).map((entry) => ({
    organization: serializeOrganization(entry.organization),
    member: serializeMember({
      ...entry.member,
      roles: Array.from(entry.roles),
    }),
  }));
};

const buildInvitationsFromRows = (
  rows: OrganizationInvitationRow[],
): Array<{
  invitation: ReturnType<typeof serializeInvitationSummary>;
  organization: ReturnType<typeof serializeOrganization>;
}> => {
  const invitations: Array<{
    invitation: ReturnType<typeof serializeInvitationSummary>;
    organization: ReturnType<typeof serializeOrganization>;
  }> = [];
  const seenInvitationIds = new Set<string>();

  for (const invitation of rows) {
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

    const organization = mapOrganizationRow(organizationRow);
    const mappedInvitation = mapInvitationRow(invitation, organization.id);
    invitations.push({
      invitation: serializeInvitationSummary(mappedInvitation),
      organization: serializeOrganization(organization),
    });
  }

  return invitations;
};

export function createSessionServices(cookieOptions?: CookieOptions) {
  const services = {
    resolveCredentialSeedForUser: function (
      this: AuthServiceContext,
      userId: string,
      session?: CredentialSeedInput | null,
    ) {
      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow.find("organizationMember", (b) =>
            b
              .whereIndex("idx_org_member_user", (eb) => eb("userId", "=", userId))
              .joinOne("organizationMemberOrganization", "organization", (organization) =>
                organization
                  .onIndex("primary", (eb) => eb("id", "=", eb.parent("organizationId")))
                  .select(["id", "deletedAt", "createdAt"]),
              ),
          ),
        )
        .transformRetrieve(([members]) => {
          return resolveCredentialSeedFromMembers(
            (members as CredentialSeedMemberRow[]).map((member) => ({
              createdAt: member.createdAt,
              organization: member.organizationMemberOrganization ?? null,
            })),
            session,
          );
        })
        .mutate(({ retrieveResult }) => retrieveResult)
        .build();
    },
    /**
     * Build a Set-Cookie header value for the current auth credential token.
     */
    buildAuthCookie: function (credentialToken: string): string {
      return buildSetCookieHeader(credentialToken, cookieOptions);
    },
    /**
     * Issue a session-backed credential for a user, rejecting banned or missing users.
     *
     * When `options.activeOrganizationId` is provided, it is written into the stored session row
     * as-is. This function does not verify that the user is a member of that organization;
     * callers must validate membership before passing the id.
     */
    issueCredential: function (
      this: AuthServiceContext,
      userId: string,
      options?: { activeOrganizationId?: string | null },
    ) {
      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow.findFirst("user", (b) => b.whereIndex("primary", (eb) => eb("id", "=", userId))),
        )
        .mutate(({ uow, retrieveResult: [user] }) => {
          if (!user) {
            return { ok: false as const, code: "user_not_found" as const };
          }
          if (user.bannedAt) {
            return { ok: false as const, code: "user_banned" as const };
          }

          const expiresAt = uow.now().plus({ days: 30 });
          const id = uow.create("session", {
            userId,
            activeOrganizationId: options?.activeOrganizationId ?? null,
            expiresAt,
          });
          const userSummary = mapUserSummary(user);

          uow.triggerHook("onCredentialIssued", {
            credential: {
              id: id.valueOf(),
              user: userSummary,
              expiresAt,
              activeOrganizationId: options?.activeOrganizationId ?? null,
            },
            actor: userSummary,
          });

          return {
            ok: true as const,
            credential: {
              id: id.valueOf(),
              userId,
              expiresAt,
              activeOrganizationId: options?.activeOrganizationId ?? null,
            },
          };
        })
        .build();
    },
    /**
     * Validate a credential and return user info or null when invalid.
     */
    validateCredential: function (this: AuthServiceContext, credentialToken: string) {
      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow
            .findFirst("session", (b) =>
              b
                .whereIndex("idx_session_id_expiresAt", (eb) =>
                  eb.and(eb("id", "=", credentialToken), eb("expiresAt", ">", eb.now())),
                )
                .joinOne("sessionOwner", "user", (owner) =>
                  owner
                    .onIndex("primary", (eb) => eb("id", "=", eb.parent("userId")))
                    .select(["id", "email", "role"]),
                ),
            )
            .findFirst("session", (b) =>
              b.whereIndex("idx_session_id_expiresAt", (eb) =>
                eb.and(eb("id", "=", credentialToken), eb("expiresAt", "<=", eb.now())),
              ),
            ),
        )
        .mutate(({ uow, retrieveResult: [session, expiredSession] }) => {
          if (expiredSession) {
            uow.delete("session", expiredSession.id, (b) => b.check());
          }
          if (!session) {
            return null;
          }
          if (!session.sessionOwner) {
            return null;
          }

          return {
            id: session.id.valueOf(),
            userId: session.userId as unknown as string,
            expiresAt: session.expiresAt,
            activeOrganizationId: session.activeOrganizationId
              ? String(session.activeOrganizationId)
              : null,
            user: {
              id: session.sessionOwner.id.valueOf(),
              email: session.sessionOwner.email,
              role: session.sessionOwner.role,
            },
          };
        })
        .build();
    },
    /**
     * Invalidate a session-backed credential and emit credential invalidation hooks.
     */
    invalidateCredential: function (this: AuthServiceContext, credentialToken: string) {
      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow.findFirst("session", (b) =>
            b
              .whereIndex("primary", (eb) => eb("id", "=", credentialToken))
              .joinOne("sessionOwner", "user", (owner) =>
                owner
                  .onIndex("primary", (eb) => eb("id", "=", eb.parent("userId")))
                  .select(["id", "email", "role", "bannedAt"]),
              ),
          ),
        )
        .mutate(({ uow, retrieveResult: [session] }) => {
          if (!session) {
            return false;
          }

          uow.delete("session", session.id, (b) => b.check());
          if (session.sessionOwner) {
            const userSummary = mapUserSummary({
              id: session.sessionOwner.id,
              email: session.sessionOwner.email,
              role: session.sessionOwner.role,
              bannedAt: session.sessionOwner.bannedAt ?? null,
            });
            uow.triggerHook("onCredentialInvalidated", {
              credential: {
                id: session.id.valueOf(),
                user: userSummary,
                expiresAt: session.expiresAt,
                activeOrganizationId: session.activeOrganizationId
                  ? String(session.activeOrganizationId)
                  : null,
              },
              actor: userSummary,
            });
          }
          return true;
        })
        .build();
    },
  };
  return services;
}

export const sessionRoutesFactory = defineRoutes<typeof authFragmentDefinition>().create(
  ({ services, config }) => {
    return [
      defineRoute({
        method: "POST",
        path: "/sign-out",
        inputSchema: z.object({}).optional(),
        outputSchema: z.object({
          success: z.boolean(),
        }),
        errorCodes: ["credential_invalid"],
        handler: async function ({ input, headers }, { json, error }) {
          await input.valid();

          const credential = resolveRequestCredential(headers, config.cookieOptions);
          if (!credential.ok) {
            return error(
              {
                message:
                  credential.reason === "malformed"
                    ? "Malformed authentication"
                    : "Authentication required",
                code: "credential_invalid",
              },
              400,
            );
          }

          const [invalidated] = await this.handlerTx()
            .withServiceCalls(() => [services.invalidateCredential(credential.credential.token)])
            .execute();

          const clearedCredentialHeaders = buildClearedCredentialHeaders(config.cookieOptions);

          if (!invalidated) {
            return error(
              { message: "Invalid credential", code: "credential_invalid" },
              { status: 401, headers: clearedCredentialHeaders },
            );
          }

          return json(
            { success: true },
            {
              headers: clearedCredentialHeaders,
            },
          );
        },
      }),

      defineRoute({
        method: "GET",
        path: "/me",
        outputSchema: z.object({
          user: z.object({
            id: z.string(),
            email: z.string(),
            role: z.enum(["user", "admin"]),
          }),
          organizations: z.array(
            z.object({
              organization: organizationSchema,
              member: memberSchema,
            }),
          ),
          activeOrganization: z
            .object({
              organization: organizationSchema,
              member: memberSchema,
            })
            .nullable(),
          invitations: z.array(
            z.object({
              invitation: invitationSummarySchema,
              organization: organizationSchema,
            }),
          ),
        }),
        errorCodes: ["credential_invalid"],
        handler: async function ({ headers }, { json, error }) {
          const credential = resolveRequestCredential(headers, config.cookieOptions);
          if (!credential.ok) {
            return error(
              {
                message:
                  credential.reason === "malformed"
                    ? "Malformed authentication"
                    : "Authentication required",
                code: "credential_invalid",
              },
              400,
            );
          }

          const credentialToken = credential.credential.token;
          const result = await this.handlerTx()
            .retrieve(({ forSchema }) => {
              const uow = forSchema(authSchema);
              const scheduleExpiredLookup = () => {
                uow.findFirst("session", (b) =>
                  b.whereIndex("idx_session_id_expiresAt", (eb) =>
                    eb.and(eb("id", "=", credentialToken), eb("expiresAt", "<=", eb.now())),
                  ),
                );
              };

              if (config.organizations === false) {
                uow.find("session", (b) =>
                  b
                    .whereIndex("idx_session_id_expiresAt", (eb) =>
                      eb.and(eb("id", "=", credentialToken), eb("expiresAt", ">", eb.now())),
                    )
                    .joinOne("sessionOwner", "user", (owner) =>
                      owner
                        .onIndex("primary", (eb) => eb("id", "=", eb.parent("userId")))
                        .select(["id", "email", "role"]),
                    ),
                );
                scheduleExpiredLookup();
                return uow;
              }

              uow.find("session", (b) =>
                b
                  .whereIndex("idx_session_id_expiresAt", (eb) =>
                    eb.and(eb("id", "=", credentialToken), eb("expiresAt", ">", eb.now())),
                  )
                  .joinOne("sessionOwner", "user", (owner) =>
                    owner
                      .onIndex("primary", (eb) => eb("id", "=", eb.parent("userId")))
                      .select(["id", "email", "role"]),
                  )
                  .joinOne("sessionActiveOrganization", "organization", (organization) =>
                    organization
                      .onIndex("primary", (eb) => eb("id", "=", eb.parent("activeOrganizationId")))
                      .select(["id"]),
                  )
                  .joinMany("sessionMembers", "organizationMember", (member) =>
                    member
                      .onIndex("idx_org_member_user", (eb) =>
                        eb("userId", "=", eb.parent("userId")),
                      )
                      .joinOne("organization", "organization", (organization) =>
                        organization
                          .onIndex("primary", (eb) => eb("id", "=", eb.parent("organizationId")))
                          .select(organizationSelect),
                      )
                      .joinMany("roles", "organizationMemberRole", (role) =>
                        role
                          .onIndex("idx_org_member_role_member", (eb) =>
                            eb("memberId", "=", eb.parent("id")),
                          )
                          .select(["role"]),
                      ),
                  ),
              );

              uow.find("session", (b) =>
                b
                  .whereIndex("idx_session_id_expiresAt", (eb) =>
                    eb.and(eb("id", "=", credentialToken), eb("expiresAt", ">", eb.now())),
                  )
                  .joinOne("sessionOwner", "user", (owner) =>
                    owner
                      .onIndex("primary", (eb) => eb("id", "=", eb.parent("userId")))
                      .select(["id", "email", "role"])
                      .joinMany("invitations", "organizationInvitation", (invitation) =>
                        invitation
                          .onIndex("idx_org_invitation_email", (eb) =>
                            eb("email", "=", eb.parent("email")),
                          )
                          .joinOne("organization", "organization", (organization) =>
                            organization
                              .onIndex("primary", (eb) =>
                                eb("id", "=", eb.parent("organizationId")),
                              )
                              .select(organizationSelect),
                          ),
                      ),
                  ),
              );

              scheduleExpiredLookup();
              return uow;
            })
            .transformRetrieve((retrieveResult) => {
              if (config.organizations === false) {
                const [sessions, expiredSession] = retrieveResult as unknown as [
                  Array<{
                    id: unknown;
                    sessionOwner?: { id: unknown; email: string; role: Role } | null;
                  }>,
                  { id: unknown } | null,
                ];
                return {
                  session: sessions[0] ?? null,
                  organizations: [],
                  invitations: [],
                  activeOrganizationId: null,
                  expiredSession,
                };
              }

              const [memberRows, invitationRows, expiredSession] = retrieveResult as unknown as [
                Array<{
                  id: unknown;
                  sessionOwner?: { id: unknown; email: string; role: Role } | null;
                  sessionActiveOrganization?: { id: unknown } | null;
                  sessionMembers?: OrganizationMemberRow | OrganizationMemberRow[] | null;
                }>,
                Array<{
                  id: unknown;
                  sessionOwner?: {
                    email?: string;
                    role?: Role;
                    invitations?: OrganizationInvitationRow | OrganizationInvitationRow[] | null;
                  } | null;
                }>,
                { id: unknown } | null,
              ];
              const memberSession = memberRows[0] ?? null;
              const invitationSession = invitationRows[0] ?? null;
              const session = memberSession ?? invitationSession;
              const activeOrganizationId =
                memberSession?.sessionActiveOrganization?.id != null
                  ? toExternalId(memberSession.sessionActiveOrganization.id)
                  : null;

              const sessionMembers = memberSession?.sessionMembers
                ? Array.isArray(memberSession.sessionMembers)
                  ? memberSession.sessionMembers
                  : [memberSession.sessionMembers]
                : [];
              const sessionInvitations = invitationSession?.sessionOwner?.invitations
                ? Array.isArray(invitationSession.sessionOwner.invitations)
                  ? invitationSession.sessionOwner.invitations
                  : [invitationSession.sessionOwner.invitations]
                : [];
              const sessionUserId = memberSession?.sessionOwner?.id
                ? toExternalId(memberSession.sessionOwner.id)
                : "";

              return {
                session,
                organizations: buildOrganizationsFromRows(sessionMembers, sessionUserId),
                invitations: buildInvitationsFromRows(sessionInvitations),
                activeOrganizationId,
                expiredSession,
              };
            })
            .mutate(({ forSchema, retrieveResult }) => {
              const { session, expiredSession } = retrieveResult;
              if (expiredSession) {
                const uow = forSchema(authSchema);
                uow.delete("session", expiredSession.id as string, (b) => b.check());
              }
              if (!session) {
                return { invalid: true as const };
              }
              if (!session.sessionOwner) {
                return { invalid: true as const };
              }
              return { invalid: false as const };
            })
            .transform(({ retrieveResult, mutateResult }) => {
              const { session, organizations, invitations, activeOrganizationId } = retrieveResult;
              if (mutateResult.invalid || !session || !session.sessionOwner) {
                return { ok: false as const };
              }

              const user = session.sessionOwner;
              const userId = toExternalId(user.id);
              const activeOrganization = activeOrganizationId
                ? (organizations.find((entry) => entry.organization.id === activeOrganizationId) ??
                  null)
                : null;

              return {
                ok: true as const,
                data: {
                  user: {
                    id: userId,
                    email: user.email,
                    role: user.role as Role,
                  },
                  organizations,
                  activeOrganization,
                  invitations,
                },
              };
            })
            .execute();

          if (!result.ok) {
            return error({ message: "Invalid credential", code: "credential_invalid" }, 401);
          }

          return json(result.data);
        },
      }),
    ];
  },
);

export type SessionRoutesFactory = typeof sessionRoutesFactory;
