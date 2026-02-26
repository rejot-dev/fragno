import { defineRoute, defineRoutes } from "@fragno-dev/core";
import type { DatabaseServiceContext } from "@fragno-dev/db";
import type { Cursor } from "@fragno-dev/db/cursor";
import { authSchema } from "../schema";
import { z } from "zod";
import {
  buildClearCookieHeader,
  buildSetCookieHeader,
  extractSessionId,
  type CookieOptions,
} from "../utils/cookie";
import type { Role, authFragmentDefinition } from "..";
import type { AuthHooksMap } from "../hooks";
import type { Organization, OrganizationMemberSummary } from "../organization/types";
import {
  serializeInvitationSummary,
  serializeMember,
  serializeOrganization,
} from "../organization/serializers";
import { invitationSummarySchema, memberSchema, organizationSchema } from "../organization/schemas";
import { mapUserSummary } from "../user/summary";

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

export function createSessionServices(cookieOptions?: CookieOptions) {
  const services = {
    /**
     * Build a Set-Cookie header value for the session id.
     */
    buildSessionCookie: function (sessionId: string): string {
      return buildSetCookieHeader(sessionId, cookieOptions);
    },
    /**
     * Create a session for a user, rejecting banned or missing users.
     */
    createSession: function (this: AuthServiceContext, userId: string) {
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 30); // 30 days from now

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

          const id = uow.create("session", {
            userId,
            expiresAt,
          });
          const userSummary = mapUserSummary(user);

          uow.triggerHook("onSessionCreated", {
            session: {
              id: id.valueOf(),
              user: userSummary,
              expiresAt,
              activeOrganizationId: null,
            },
            actor: userSummary,
          });

          return {
            ok: true as const,
            session: {
              id: id.valueOf(),
              userId,
              expiresAt,
              activeOrganizationId: null,
            },
          };
        })
        .build();
    },
    /**
     * Validate a session and return user info or null when invalid.
     */
    validateSession: function (this: AuthServiceContext, sessionId: string) {
      const now = new Date();
      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow.findFirst("session", (b) =>
            b
              .whereIndex("primary", (eb) => eb("id", "=", sessionId))
              .join((j) => j.sessionOwner((b) => b.select(["id", "email", "role"]))),
          ),
        )
        .mutate(({ uow, retrieveResult: [session] }) => {
          if (!session) {
            return null;
          }

          // Check if session has expired
          if (session.expiresAt < now) {
            uow.delete("session", session.id, (b) => b.check());
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
              .join((j) => j.sessionOwner((b) => b.select(["id", "email", "role", "bannedAt"]))),
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
      const now = new Date();

      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow.findFirst("session", (b) =>
            b
              .whereIndex("primary", (eb) => eb("id", "=", sessionId ?? ""))
              .join((j) => j.sessionOwner((b) => b.select(["id", "email", "role"]))),
          ),
        )
        .mutate(({ uow, retrieveResult: [session] }) => {
          if (!session || !sessionId) {
            return undefined;
          }

          if (session.expiresAt < now) {
            uow.delete("session", session.id, (b) => b.check());
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

          const [session] = await this.handlerTx()
            .withServiceCalls(() => [services.validateSession(sessionId)])
            .execute();

          if (!session) {
            return error({ message: "Invalid session", code: "session_invalid" }, 401);
          }

          if (config.organizations === false) {
            return json({
              user: {
                id: session.user.id,
                email: session.user.email,
                role: session.user.role as Role,
              },
              organizations: [],
              activeOrganization: null,
              invitations: [],
            });
          }

          assertOrganizationServices(services);
          const organizationServices = services as Required<typeof services>;

          const organizations: Array<{
            organization: Organization;
            member: OrganizationMemberSummary;
          }> = [];
          let cursor: Cursor | undefined;
          let hasNextPage = true;
          const maxOrganizationPages = 50;
          let pageCount = 0;
          while (hasNextPage) {
            if (++pageCount > maxOrganizationPages) {
              throw new Error(
                `Exceeded organization page limit (${maxOrganizationPages}) for user ${session.user.id}`,
              );
            }
            const [organizationsResult] = await this.handlerTx()
              .withServiceCalls(() => [
                organizationServices.getOrganizationsForUser({
                  userId: session.user.id,
                  pageSize: 1000,
                  cursor,
                }),
              ])
              .execute();

            organizations.push(...organizationsResult.organizations);
            cursor = organizationsResult.cursor;
            hasNextPage = organizationsResult.hasNextPage;
          }

          const memberIds = organizations.map((entry) => entry.member.id);
          const [rolesResult] = await this.handlerTx()
            .withServiceCalls(() => [
              organizationServices.listOrganizationMemberRolesForMembers(memberIds),
            ])
            .execute();

          const organizationsWithRoles = organizations.map((entry) => ({
            organization: serializeOrganization(entry.organization),
            member: serializeMember({
              ...entry.member,
              roles: rolesResult.rolesByMemberId[entry.member.id] ?? [],
            }),
          }));

          const [invitationsResult] = await this.handlerTx()
            .withServiceCalls(() => [
              organizationServices.listOrganizationInvitationsForUser({
                email: session.user.email,
                status: "pending",
              }),
            ])
            .execute();

          const invitations = invitationsResult.invitations
            .filter((entry) => entry.organization)
            .map((entry) => ({
              invitation: serializeInvitationSummary(entry.invitation),
              organization: serializeOrganization(entry.organization!),
            }));

          const [activeResult] = await this.handlerTx()
            .withServiceCalls(() => [organizationServices.getActiveOrganization(sessionId)])
            .execute();

          const activeOrganization = activeResult.organizationId
            ? (organizationsWithRoles.find(
                (entry) => entry.organization.id === activeResult.organizationId,
              ) ?? null)
            : null;

          return json({
            user: {
              id: session.user.id,
              email: session.user.email,
              role: session.user.role as Role,
            },
            organizations: organizationsWithRoles,
            activeOrganization,
            invitations,
          });
        },
      }),
    ];
  },
);
