import { defineRoute, defineRoutes } from "@fragno-dev/core";
import type { DatabaseServiceContext } from "@fragno-dev/db";
import { authSchema } from "../schema";
import { z } from "zod";
import {
  buildClearCookieHeader,
  buildSetCookieHeader,
  extractSessionId,
  type CookieOptions,
} from "../utils/cookie";
import type { Role, authFragmentDefinition } from "..";
import {
  serializeInvitation,
  serializeMember,
  serializeOrganization,
} from "../organization/serializers";

type AuthServiceContext = DatabaseServiceContext<{}>;

export function createSessionServices(cookieOptions?: CookieOptions) {
  const services = {
    buildSessionCookie: function (sessionId: string): string {
      return buildSetCookieHeader(sessionId, cookieOptions);
    },
    createSession: function (this: AuthServiceContext, userId: string) {
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 30); // 30 days from now

      return this.serviceTx(authSchema)
        .mutate(({ uow }) => {
          const id = uow.create("session", {
            userId,
            expiresAt,
          });

          return {
            id: id.valueOf(),
            userId,
            expiresAt,
          };
        })
        .build();
    },
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
    invalidateSession: function (this: AuthServiceContext, sessionId: string) {
      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow.findFirst("session", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", sessionId)),
          ),
        )
        .mutate(({ uow, retrieveResult: [session] }) => {
          if (!session) {
            return false;
          }

          uow.delete("session", session.id, (b) => b.check());
          return true;
        })
        .build();
    },
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
              organization: z.object({
                id: z.string(),
                name: z.string(),
                slug: z.string(),
                logoUrl: z.string().nullable(),
                metadata: z.record(z.string(), z.unknown()).nullable(),
                createdBy: z.string(),
                createdAt: z.string(),
                updatedAt: z.string(),
                deletedAt: z.string().nullable(),
              }),
              member: z.object({
                id: z.string(),
                organizationId: z.string(),
                userId: z.string(),
                roles: z.array(z.string()),
                createdAt: z.string(),
                updatedAt: z.string(),
              }),
            }),
          ),
          activeOrganization: z
            .object({
              organization: z.object({
                id: z.string(),
                name: z.string(),
                slug: z.string(),
                logoUrl: z.string().nullable(),
                metadata: z.record(z.string(), z.unknown()).nullable(),
                createdBy: z.string(),
                createdAt: z.string(),
                updatedAt: z.string(),
                deletedAt: z.string().nullable(),
              }),
              member: z.object({
                id: z.string(),
                organizationId: z.string(),
                userId: z.string(),
                roles: z.array(z.string()),
                createdAt: z.string(),
                updatedAt: z.string(),
              }),
            })
            .nullable(),
          invitations: z.array(
            z.object({
              invitation: z.object({
                id: z.string(),
                organizationId: z.string(),
                email: z.string(),
                roles: z.array(z.string()),
                status: z.enum(["pending", "accepted", "rejected", "canceled", "expired"]),
                token: z.string(),
                inviterId: z.string(),
                expiresAt: z.string(),
                createdAt: z.string(),
                respondedAt: z.string().nullable(),
              }),
              organization: z.object({
                id: z.string(),
                name: z.string(),
                slug: z.string(),
                logoUrl: z.string().nullable(),
                metadata: z.record(z.string(), z.unknown()).nullable(),
                createdBy: z.string(),
                createdAt: z.string(),
                updatedAt: z.string(),
                deletedAt: z.string().nullable(),
              }),
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

          const [organizationsResult] = await this.handlerTx()
            .withServiceCalls(() => [
              services.getOrganizationsForUser({
                userId: session.user.id,
                pageSize: 1000,
              }),
            ])
            .execute();

          const memberIds = organizationsResult.organizations.map((entry) => entry.member.id);
          const [rolesResult] = await this.handlerTx()
            .withServiceCalls(() => [services.listOrganizationMemberRolesForMembers(memberIds)])
            .execute();

          const organizations = organizationsResult.organizations.map((entry) => ({
            organization: serializeOrganization(entry.organization),
            member: serializeMember({
              ...entry.member,
              roles: rolesResult.rolesByMemberId[entry.member.id] ?? [],
            }),
          }));

          const [invitationsResult] = await this.handlerTx()
            .withServiceCalls(() => [
              services.listOrganizationInvitationsForUser(session.user.email),
            ])
            .execute();

          const invitations = invitationsResult.invitations
            .filter((entry) => entry.organization && entry.invitation.status === "pending")
            .map((entry) => ({
              invitation: serializeInvitation(entry.invitation),
              organization: serializeOrganization(entry.organization!),
            }));

          const [activeResult] = await this.handlerTx()
            .withServiceCalls(() => [services.getActiveOrganization(sessionId)])
            .execute();

          const activeOrganization = activeResult.organizationId
            ? (organizations.find(
                (entry) => entry.organization.id === activeResult.organizationId,
              ) ?? null)
            : null;

          return json({
            user: {
              id: session.user.id,
              email: session.user.email,
              role: session.user.role as Role,
            },
            organizations,
            activeOrganization,
            invitations,
          });
        },
      }),
    ];
  },
);
