import { z } from "zod";

import { defineRoute, defineRoutes } from "@fragno-dev/core";
import type { DatabaseServiceContext } from "@fragno-dev/db";

import type { Role, authFragmentDefinition } from "..";
import { buildClearedCredentialHeaders } from "../auth/credential-strategy";
import { resolveRequestCredential } from "../auth/request-auth";
import { buildIssuedAuthResponse } from "../auth/response-auth";
import {
  mintSessionAccessToken,
  resolveAccessTokenConfig,
  resolveBackingSessionCredential,
  resolveRefreshCredential,
  verifySessionAccessToken,
} from "../auth/session-access-token";
import type { ValidatedCredential } from "../auth/types";
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

type CurrentSessionOrganizations = {
  organizations: Array<{
    organization: z.infer<typeof organizationSchema>;
    member: z.infer<typeof memberSchema>;
  }>;
  activeOrganizationId: string | null;
};

type CurrentSessionInvitations = Array<{
  invitation: z.infer<typeof invitationSummarySchema>;
  organization: z.infer<typeof organizationSchema>;
}>;

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

const normalizeMetadata = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return Object.fromEntries(Object.entries(value));
};

const normalizeStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
};

const normalizeInvitationStatus = (status: string): OrganizationInvitationStatus => {
  switch (status) {
    case "accepted":
    case "canceled":
    case "expired":
    case "pending":
    case "rejected":
      return status;
    default:
      return "pending";
  }
};

const normalizeRole = (role: string): Role => (role === "admin" ? "admin" : "user");

const mapOrganizationRow = (organization: OrganizationRow): Organization => ({
  id: toExternalId(organization.id),
  name: organization.name,
  slug: organization.slug,
  logoUrl: organization.logoUrl ?? null,
  metadata: normalizeMetadata(organization.metadata),
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
  roles: normalizeStringArray(invitation.roles),
  status: normalizeInvitationStatus(invitation.status),
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

    const roles = normalizeMany(member.roles);
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
    if (invitation?.status !== "pending") {
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
            members.map((member) => ({
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
                    .select(["id", "email", "role", "bannedAt"]),
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
          if (session.sessionOwner?.bannedAt !== null) {
            return null;
          }

          return {
            id: session.id.valueOf(),
            userId: toExternalId(session.userId),
            expiresAt: session.expiresAt,
            activeOrganizationId: session.activeOrganizationId
              ? String(session.activeOrganizationId)
              : null,
            user: {
              id: session.sessionOwner.id.valueOf(),
              email: session.sessionOwner.email,
              role: normalizeRole(session.sessionOwner.role),
            },
          };
        })
        .build();
    },
    /**
     * Return full organization/member rows for the user behind a valid session credential.
     */
    getCredentialOrganizations: function (this: AuthServiceContext, credentialToken: string) {
      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow.findFirst("session", (b) =>
            b
              .whereIndex("idx_session_id_expiresAt", (eb) =>
                eb.and(eb("id", "=", credentialToken), eb("expiresAt", ">", eb.now())),
              )
              .joinOne("sessionActiveOrganization", "organization", (organization) =>
                organization
                  .onIndex("primary", (eb) => eb("id", "=", eb.parent("activeOrganizationId")))
                  .select(["id"]),
              )
              .joinMany("sessionMembers", "organizationMember", (member) =>
                member
                  .onIndex("idx_org_member_user", (eb) => eb("userId", "=", eb.parent("userId")))
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
          ),
        )
        .transformRetrieve(([session]) => {
          if (!session) {
            return { organizations: [], activeOrganizationId: null };
          }

          return {
            organizations: buildOrganizationsFromRows(
              normalizeMany(session.sessionMembers),
              toExternalId(session.userId),
            ),
            activeOrganizationId:
              session.sessionActiveOrganization?.id != null
                ? toExternalId(session.sessionActiveOrganization.id)
                : null,
          };
        })
        .mutate(({ retrieveResult }) => retrieveResult)
        .build();
    },
    /**
     * Return pending invitations for the user behind a valid session credential.
     */
    getCredentialInvitations: function (this: AuthServiceContext, credentialToken: string) {
      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow.findFirst("session", (b) =>
            b
              .whereIndex("idx_session_id_expiresAt", (eb) =>
                eb.and(eb("id", "=", credentialToken), eb("expiresAt", ">", eb.now())),
              )
              .joinOne("sessionOwner", "user", (owner) =>
                owner
                  .onIndex("primary", (eb) => eb("id", "=", eb.parent("userId")))
                  .select(["email"])
                  .joinMany("invitations", "organizationInvitation", (invitation) =>
                    invitation
                      .onIndex("idx_org_invitation_email", (eb) =>
                        eb("email", "=", eb.parent("email")),
                      )
                      .joinOne("organization", "organization", (organization) =>
                        organization
                          .onIndex("primary", (eb) => eb("id", "=", eb.parent("organizationId")))
                          .select(organizationSelect),
                      ),
                  ),
              ),
          ),
        )
        .transformRetrieve(([session]) =>
          buildInvitationsFromRows(normalizeMany(session?.sessionOwner?.invitations)),
        )
        .mutate(({ retrieveResult }) => retrieveResult)
        .build();
    },
    /**
     * Return non-deleted organization ids for the user behind a valid session credential.
     */
    getCredentialOrganizationIds: function (this: AuthServiceContext, credentialToken: string) {
      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow.findFirst("session", (b) =>
            b
              .whereIndex("idx_session_id_expiresAt", (eb) =>
                eb.and(eb("id", "=", credentialToken), eb("expiresAt", ">", eb.now())),
              )
              .joinMany("sessionMembers", "organizationMember", (member) =>
                member
                  .onIndex("idx_org_member_user", (eb) => eb("userId", "=", eb.parent("userId")))
                  .joinOne("organization", "organization", (organization) =>
                    organization
                      .onIndex("primary", (eb) => eb("id", "=", eb.parent("organizationId")))
                      .select(["id", "deletedAt"]),
                  ),
              ),
          ),
        )
        .transformRetrieve(([session]) => {
          if (!session) {
            return [];
          }
          const sessionMembers = normalizeMany(session.sessionMembers);

          return Array.from(
            new Set(
              sessionMembers.flatMap((member) =>
                member.organization && !member.organization.deletedAt
                  ? [toExternalId(member.organization.id)]
                  : [],
              ),
            ),
          );
        })
        .mutate(({ retrieveResult }) => retrieveResult)
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
    const accessTokens = resolveAccessTokenConfig(config.authentication?.accessTokens);

    return [
      defineRoute({
        method: "POST",
        path: "/token/refresh",
        inputSchema: z.object({}).optional(),
        outputSchema: z.object({
          auth: z.object({
            token: z.string(),
            kind: z.enum(["jwt"]),
            expiresAt: z.string().nullable(),
            activeOrganizationId: z.string().nullable(),
            refreshToken: z.string().optional(),
            refreshExpiresAt: z.string().nullable().optional(),
          }),
        }),
        errorCodes: ["credential_invalid", "access_tokens_disabled"],
        handler: async function ({ input, headers }, { error }) {
          await input.valid();
          if (!accessTokens) {
            return error(
              { message: "Access tokens are disabled", code: "access_tokens_disabled" },
              404,
            );
          }
          const credential = resolveRefreshCredential(headers, config.cookieOptions, {
            acceptBearer: accessTokens.acceptBearer,
            issueCookie: accessTokens.issueCookie,
          });
          if (!credential.ok) {
            return error({ message: "Authentication required", code: "credential_invalid" }, 400);
          }
          const credentialToken = credential.credential.token;
          const [session, organizationIds] = (await this.handlerTx()
            .withServiceCalls(() => [
              services.validateCredential(credentialToken),
              services.getCredentialOrganizationIds(credentialToken),
            ])
            .execute()) as [ValidatedCredential | null, string[]];
          if (!session) {
            return error({ message: "Invalid credential", code: "credential_invalid" }, 401);
          }
          const issued = await mintSessionAccessToken({
            config: accessTokens,
            session: { ...session, organizationIds },
          });
          const response = buildIssuedAuthResponse(issued, config.cookieOptions, {
            issueCookie: accessTokens.issueCookie,
          });
          return Response.json({ auth: response.auth }, { headers: response.headers });
        },
      }),

      defineRoute({
        method: "POST",
        path: "/sign-out",
        inputSchema: z.object({}).optional(),
        outputSchema: z.object({
          success: z.boolean(),
        }),
        errorCodes: ["credential_invalid"],
        handler: async function ({ input, headers }, { error }) {
          await input.valid();

          const credential = accessTokens
            ? resolveRefreshCredential(headers, config.cookieOptions, {
                acceptBearer: accessTokens.acceptBearer,
                issueCookie: accessTokens.issueCookie,
              })
            : resolveRequestCredential(headers, config.cookieOptions);

          let credentialToken: string | null = credential.ok ? credential.credential.token : null;
          if (
            !credential.ok &&
            accessTokens &&
            credential.reason !== "malformed" &&
            credential.reason !== "multiple"
          ) {
            const accessCredential = resolveRequestCredential(headers, config.cookieOptions);
            if (accessCredential.ok) {
              const principal = await verifySessionAccessToken({
                config: accessTokens,
                token: accessCredential.credential.token,
                source: accessCredential.credential.source,
              });
              credentialToken = principal?.auth.credentialId ?? null;
            }
          }

          if (!credentialToken) {
            return error(
              {
                message:
                  !credential.ok && credential.reason === "malformed"
                    ? "Malformed authentication"
                    : !credential.ok && credential.reason === "multiple"
                      ? "Multiple authentication credentials"
                      : "Authentication required",
                code: "credential_invalid",
              },
              400,
            );
          }

          const [invalidated] = await this.handlerTx()
            .withServiceCalls(() => [services.invalidateCredential(credentialToken)])
            .execute();

          const clearedCredentialHeaders = buildClearedCredentialHeaders(
            config.cookieOptions,
            accessTokens != null,
          );

          if (!invalidated) {
            return Response.json(
              { message: "Invalid credential", code: "credential_invalid" },
              { status: 401, headers: clearedCredentialHeaders },
            );
          }

          return Response.json({ success: true }, { headers: clearedCredentialHeaders });
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
          const credential = await resolveBackingSessionCredential({
            headers,
            cookieOptions: config.cookieOptions,
            accessTokens,
          });
          if (!credential.ok) {
            return error(
              {
                message:
                  credential.reason === "malformed"
                    ? "Malformed authentication"
                    : "Authentication required",
                code: "credential_invalid",
              },
              credential.reason === "invalid" ? 401 : 400,
            );
          }

          const credentialToken = credential.credential.token;

          if (config.organizations === false) {
            const [session] = await this.handlerTx()
              .withServiceCalls(() => [services.validateCredential(credentialToken)])
              .execute();

            if (!session) {
              return error({ message: "Invalid credential", code: "credential_invalid" }, 401);
            }

            return json({
              user: session.user,
              organizations: [],
              activeOrganization: null,
              invitations: [],
            });
          }

          const [session, organizationResult, invitations] = (await this.handlerTx()
            .withServiceCalls(() => [
              services.validateCredential(credentialToken),
              services.getCredentialOrganizations(credentialToken),
              services.getCredentialInvitations(credentialToken),
            ])
            .execute()) as [
            ValidatedCredential | null,
            CurrentSessionOrganizations,
            CurrentSessionInvitations,
          ];

          if (!session) {
            return error({ message: "Invalid credential", code: "credential_invalid" }, 401);
          }

          const activeOrganization = organizationResult.activeOrganizationId
            ? (organizationResult.organizations.find(
                (entry) => entry.organization.id === organizationResult.activeOrganizationId,
              ) ?? null)
            : null;

          return json({
            user: session.user,
            organizations: organizationResult.organizations,
            activeOrganization,
            invitations,
          });
        },
      }),
    ];
  },
);

export type SessionRoutesFactory = typeof sessionRoutesFactory;
