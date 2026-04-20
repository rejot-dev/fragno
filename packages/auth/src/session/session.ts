import type { FragnoId } from "@fragno-dev/db/schema";
import { z } from "zod";

import { defineRoute, defineRoutes } from "@fragno-dev/core";
import type { DatabaseServiceContext } from "@fragno-dev/db";

import type { Role, authFragmentDefinition } from "..";
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
import {
  buildClearCookieHeader,
  buildSetCookieHeader,
  extractSessionId,
  type CookieOptions,
} from "../utils/cookie";
import { resolveSessionSeedFromMembers, type SessionSeedInput } from "./session-seed";

type AuthServiceContext = DatabaseServiceContext<AuthHooksMap>;

const requiredOrganizationServiceNames = [
  "getOrganizationsForUser",
  "listOrganizationMemberRolesForMembers",
  "listOrganizationInvitationsForUser",
  "getActiveOrganization",
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

type ActiveOrganizationRow = {
  id: unknown;
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

type SessionOwnerRow = {
  id: unknown;
  email: string;
  role: Role;
};

type SessionMemberRow = {
  id: FragnoId;
  expiresAt: Date;
  sessionOwner?: SessionOwnerRow | null;
  sessionActiveOrganization?: ActiveOrganizationRow | null;
  sessionMembers?: OrganizationMemberRow | OrganizationMemberRow[] | null;
};

type SessionInvitationRow = {
  id: FragnoId;
  expiresAt: Date;
  sessionActiveOrganization?: ActiveOrganizationRow | null;
  sessionOwner?:
    | (SessionOwnerRow & {
        invitations?: OrganizationInvitationRow | OrganizationInvitationRow[] | null;
      })
    | null;
};

type SessionExpiryRow = {
  id: FragnoId;
};

type SessionSeedMemberRow = {
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
  rows: SessionMemberRow[],
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

  for (const row of rows) {
    const sessionOwner = row.sessionOwner;
    if (!sessionOwner) {
      continue;
    }
    const userId = toExternalId(sessionOwner.id);
    const members = normalizeMany(row.sessionMembers) as OrganizationMemberRow[];
    for (const member of members) {
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
  rows: SessionInvitationRow[],
): Array<{
  invitation: ReturnType<typeof serializeInvitationSummary>;
  organization: ReturnType<typeof serializeOrganization>;
}> => {
  const invitations: Array<{
    invitation: ReturnType<typeof serializeInvitationSummary>;
    organization: ReturnType<typeof serializeOrganization>;
  }> = [];
  const seenInvitationIds = new Set<string>();

  for (const row of rows) {
    const sessionOwner = row.sessionOwner;
    if (!sessionOwner) {
      continue;
    }
    const invitationsForUser = normalizeMany(
      sessionOwner.invitations,
    ) as OrganizationInvitationRow[];
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

      const organization = mapOrganizationRow(organizationRow);
      const mappedInvitation = mapInvitationRow(invitation, organization.id);
      invitations.push({
        invitation: serializeInvitationSummary(mappedInvitation),
        organization: serializeOrganization(organization),
      });
    }
  }

  return invitations;
};

export function createSessionServices(cookieOptions?: CookieOptions) {
  const services = {
    resolveSessionSeedForUser: function (
      this: AuthServiceContext,
      userId: string,
      session?: SessionSeedInput | null,
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
          return resolveSessionSeedFromMembers(
            (members as SessionSeedMemberRow[]).map((member) => ({
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
     * Build a Set-Cookie header value for the session id.
     */
    buildSessionCookie: function (sessionId: string): string {
      return buildSetCookieHeader(sessionId, cookieOptions);
    },
    /**
     * Create a session for a user, rejecting banned or missing users.
     *
     * When `options.activeOrganizationId` is provided, it is written into the session as-is.
     * This function does not verify that the user is a member of that organization; callers
     * must validate membership before passing the id.
     */
    createSession: function (
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

          uow.triggerHook("onSessionCreated", {
            session: {
              id: id.valueOf(),
              user: userSummary,
              expiresAt,
              activeOrganizationId: options?.activeOrganizationId ?? null,
            },
            actor: userSummary,
          });

          return {
            ok: true as const,
            session: {
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
     * Validate a session and return user info or null when invalid.
     */
    validateSession: function (this: AuthServiceContext, sessionId: string) {
      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow
            .findFirst("session", (b) =>
              b
                .whereIndex("idx_session_id_expiresAt", (eb) =>
                  eb.and(eb("id", "=", sessionId), eb("expiresAt", ">", eb.now())),
                )
                .joinOne("sessionOwner", "user", (owner) =>
                  owner
                    .onIndex("primary", (eb) => eb("id", "=", eb.parent("userId")))
                    .select(["id", "email", "role"]),
                ),
            )
            .findFirst("session", (b) =>
              b.whereIndex("idx_session_id_expiresAt", (eb) =>
                eb.and(eb("id", "=", sessionId), eb("expiresAt", "<=", eb.now())),
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
     * Invalidate a session and emit session invalidation hooks.
     */
    invalidateSession: function (this: AuthServiceContext, sessionId: string) {
      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow.findFirst("session", (b) =>
            b
              .whereIndex("primary", (eb) => eb("id", "=", sessionId))
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
            uow.triggerHook("onSessionInvalidated", {
              session: {
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
    /**
     * Resolve a session from request headers for sign-in checks.
     */
    getSession: function (this: AuthServiceContext, headers: Headers) {
      const sessionId = extractSessionId(headers);

      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow
            .findFirst("session", (b) =>
              b
                .whereIndex("idx_session_id_expiresAt", (eb) =>
                  eb.and(eb("id", "=", sessionId ?? ""), eb("expiresAt", ">", eb.now())),
                )
                .joinOne("sessionOwner", "user", (owner) =>
                  owner
                    .onIndex("primary", (eb) => eb("id", "=", eb.parent("userId")))
                    .select(["id", "email", "role"]),
                ),
            )
            .findFirst("session", (b) =>
              b.whereIndex("idx_session_id_expiresAt", (eb) =>
                eb.and(eb("id", "=", sessionId ?? ""), eb("expiresAt", "<=", eb.now())),
              ),
            ),
        )
        .mutate(({ uow, retrieveResult: [session, expiredSession] }) => {
          if (expiredSession) {
            uow.delete("session", expiredSession.id, (b) => b.check());
          }
          if (!session || !sessionId) {
            return undefined;
          }
          if (!session.sessionOwner) {
            return undefined;
          }

          return {
            userId: session.sessionOwner.id.valueOf(),
            email: session.sessionOwner.email,
          };
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
        inputSchema: z
          .object({
            sessionId: z.string().optional(),
          })
          .optional(),
        outputSchema: z.object({
          success: z.boolean(),
        }),
        errorCodes: ["session_not_found"],
        handler: async function ({ input, headers }, { json, error }) {
          const body = await input.valid();

          // Extract session ID from cookies first, then body
          const sessionId = extractSessionId(headers, null, body?.sessionId);

          if (!sessionId) {
            return error({ message: "Session ID required", code: "session_not_found" }, 400);
          }

          const [success] = await this.handlerTx()
            .withServiceCalls(() => [services.invalidateSession(sessionId)])
            .execute();

          // Build response with clear cookie header
          const clearCookieHeader = buildClearCookieHeader(config.cookieOptions ?? {});

          if (!success) {
            // Still clear the cookie even if session not found in DB
            return json(
              { success: false },
              {
                headers: {
                  "Set-Cookie": clearCookieHeader,
                },
              },
            );
          }

          return json(
            { success: true },
            {
              headers: {
                "Set-Cookie": clearCookieHeader,
              },
            },
          );
        },
      }),

      defineRoute({
        method: "GET",
        path: "/me",
        queryParameters: ["sessionId"],
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
        errorCodes: ["session_invalid"],
        handler: async function ({ query, headers }, { json, error }) {
          // Extract session ID from cookies first, then query params
          const sessionId = extractSessionId(headers, query.get("sessionId"));

          if (!sessionId) {
            return error({ message: "Session ID required", code: "session_invalid" }, 400);
          }

          if (config.organizations !== false) {
            assertOrganizationServices(services);
          }

          const result = await this.handlerTx()
            .retrieve(({ forSchema }) => {
              const uow = forSchema(authSchema);
              const scheduleExpiredLookup = () => {
                uow.findFirst("session", (b) =>
                  b.whereIndex("idx_session_id_expiresAt", (eb) =>
                    eb.and(eb("id", "=", sessionId), eb("expiresAt", "<=", eb.now())),
                  ),
                );
              };

              if (config.organizations === false) {
                uow.find("session", (b) =>
                  b
                    .whereIndex("idx_session_id_expiresAt", (eb) =>
                      eb.and(eb("id", "=", sessionId), eb("expiresAt", ">", eb.now())),
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
                    eb.and(eb("id", "=", sessionId), eb("expiresAt", ">", eb.now())),
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
                    eb.and(eb("id", "=", sessionId), eb("expiresAt", ">", eb.now())),
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
                  SessionMemberRow[],
                  SessionExpiryRow | null,
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
                SessionMemberRow[],
                SessionInvitationRow[],
                SessionExpiryRow | null,
              ];
              const session = memberRows[0] ?? invitationRows[0] ?? null;
              const activeOrganizationId =
                session?.sessionActiveOrganization && session.sessionActiveOrganization.id
                  ? toExternalId(session.sessionActiveOrganization.id)
                  : null;

              return {
                session,
                organizations: buildOrganizationsFromRows(memberRows),
                invitations: buildInvitationsFromRows(invitationRows),
                activeOrganizationId,
                expiredSession,
              };
            })
            .mutate(({ forSchema, retrieveResult }) => {
              const { session, expiredSession } = retrieveResult;
              if (expiredSession) {
                const uow = forSchema(authSchema);
                uow.delete("session", expiredSession.id, (b) => b.check());
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
            return error({ message: "Invalid session", code: "session_invalid" }, 401);
          }

          return json(result.data);
        },
      }),
    ];
  },
);
