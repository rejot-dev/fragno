import { defineRoute, defineRoutes } from "@fragno-dev/core";
import { type Cursor, decodeCursor } from "@fragno-dev/db/cursor";
import { z } from "zod";
import type { authFragmentDefinition } from "..";
import { extractSessionId } from "../utils/cookie";
import {
  serializeInvitation,
  serializeInvitationSummary,
  serializeMember,
  serializeOrganization,
} from "./serializers";

const organizationSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  logoUrl: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
});

const memberSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  userId: z.string(),
  roles: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const invitationSchema = z.object({
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
});

const invitationSummarySchema = invitationSchema.omit({ token: true });

const createOrganizationInputSchema = z.object({
  name: z.string().min(1).max(120),
  slug: z.string().min(1),
  logoUrl: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
});

const updateOrganizationInputSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    slug: z.string().min(1).optional(),
    logoUrl: z.string().nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field must be provided",
  });

const pageQuerySchema = z.object({
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const parseCursor = (cursorParam: string | null): Cursor | undefined => {
  if (!cursorParam) {
    return undefined;
  }
  try {
    return decodeCursor(cursorParam);
  } catch {
    return undefined;
  }
};

export const organizationRoutesFactory = defineRoutes<typeof authFragmentDefinition>().create(
  ({ services }) => {
    return [
      defineRoute({
        method: "POST",
        path: "/organizations",
        inputSchema: createOrganizationInputSchema,
        outputSchema: z.object({
          organization: organizationSchema,
          member: memberSchema,
        }),
        errorCodes: [
          "invalid_input",
          "organization_slug_taken",
          "permission_denied",
          "limit_reached",
          "session_invalid",
        ],
        handler: async function ({ input, headers, query }, { json, error }) {
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

          const body = await input.valid();
          const [result] = await this.handlerTx()
            .withServiceCalls(() => [
              services.createOrganization({
                name: body.name,
                slug: body.slug,
                logoUrl: body.logoUrl ?? null,
                metadata: body.metadata ?? null,
                creatorUserId: session.user.id,
                sessionId,
              }),
            ])
            .execute();

          if (!result.ok) {
            if (result.code === "organization_slug_taken") {
              return error(
                { message: "Organization slug taken", code: "organization_slug_taken" },
                400,
              );
            }

            if (result.code === "invalid_slug") {
              return error({ message: "Invalid input", code: "invalid_input" }, 400);
            }

            return error({ message: "Permission denied", code: "permission_denied" }, 401);
          }

          return json({
            organization: serializeOrganization(result.organization),
            member: serializeMember(result.member),
          });
        },
      }),

      defineRoute({
        method: "GET",
        path: "/organizations",
        queryParameters: ["pageSize", "cursor", "sessionId"],
        outputSchema: z.object({
          organizations: z.array(
            z.object({
              organization: organizationSchema,
              member: memberSchema,
            }),
          ),
          cursor: z.string().optional(),
          hasNextPage: z.boolean(),
        }),
        errorCodes: ["invalid_input", "session_invalid"],
        handler: async function ({ query, headers }, { json, error }) {
          const parsed = pageQuerySchema.safeParse(Object.fromEntries(query.entries()));
          if (!parsed.success) {
            return error({ message: "Invalid query parameters", code: "invalid_input" }, 400);
          }

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

          const cursor = parseCursor(query.get("cursor"));
          const [result] = await this.handlerTx()
            .withServiceCalls(() => [
              services.getOrganizationsForUser({
                userId: session.user.id,
                pageSize: parsed.data.pageSize,
                cursor,
              }),
            ])
            .execute();

          const memberIds = result.organizations.map((entry) => entry.member.id);
          const [rolesResult] = await this.handlerTx()
            .withServiceCalls(() => [services.listOrganizationMemberRolesForMembers(memberIds)])
            .execute();

          return json({
            organizations: result.organizations.map((entry) => ({
              organization: serializeOrganization(entry.organization),
              member: serializeMember({
                ...entry.member,
                roles: rolesResult.rolesByMemberId[entry.member.id] ?? [],
              }),
            })),
            cursor: result.cursor?.encode(),
            hasNextPage: result.hasNextPage,
          });
        },
      }),

      defineRoute({
        method: "GET",
        path: "/organizations/active",
        queryParameters: ["sessionId"],
        outputSchema: z
          .object({
            organization: organizationSchema,
            member: memberSchema,
          })
          .nullable(),
        errorCodes: ["session_invalid"],
        handler: async function ({ headers, query }, { json, error }) {
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

          const [activeResult] = await this.handlerTx()
            .withServiceCalls(() => [services.getActiveOrganization(sessionId)])
            .execute();

          if (!activeResult.organizationId) {
            return json(null);
          }

          const [organizationResult] = await this.handlerTx()
            .withServiceCalls(() => [services.getOrganizationById(activeResult.organizationId)])
            .execute();

          if (!organizationResult) {
            return json(null);
          }

          const [memberResult] = await this.handlerTx()
            .withServiceCalls(() => [
              services.getOrganizationMemberByUser({
                organizationId: activeResult.organizationId,
                userId: session.user.id,
              }),
            ])
            .execute();

          if (!memberResult) {
            return json(null);
          }

          const [rolesResult] = await this.handlerTx()
            .withServiceCalls(() => [services.listOrganizationMemberRoles(memberResult.id)])
            .execute();

          return json({
            organization: serializeOrganization(organizationResult.organization),
            member: serializeMember({
              ...memberResult,
              roles: rolesResult.roles,
            }),
          });
        },
      }),

      defineRoute({
        method: "POST",
        path: "/organizations/active",
        queryParameters: ["sessionId"],
        inputSchema: z.object({
          organizationId: z.string(),
        }),
        outputSchema: z.object({
          organization: organizationSchema,
          member: memberSchema,
        }),
        errorCodes: ["organization_not_found", "membership_not_found", "session_invalid"],
        handler: async function ({ input, headers, query }, { json, error }) {
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

          const body = await input.valid();

          const [organizationResult] = await this.handlerTx()
            .withServiceCalls(() => [services.getOrganizationById(body.organizationId)])
            .execute();

          if (!organizationResult) {
            return error(
              { message: "Organization not found", code: "organization_not_found" },
              404,
            );
          }

          const [memberResult] = await this.handlerTx()
            .withServiceCalls(() => [
              services.getOrganizationMemberByUser({
                organizationId: body.organizationId,
                userId: session.user.id,
              }),
            ])
            .execute();

          if (!memberResult) {
            return error({ message: "Membership not found", code: "membership_not_found" }, 404);
          }

          await this.handlerTx()
            .withServiceCalls(() => [
              services.setActiveOrganization(sessionId, body.organizationId),
            ])
            .execute();

          const [rolesResult] = await this.handlerTx()
            .withServiceCalls(() => [services.listOrganizationMemberRoles(memberResult.id)])
            .execute();

          return json({
            organization: serializeOrganization(organizationResult.organization),
            member: serializeMember({
              ...memberResult,
              roles: rolesResult.roles,
            }),
          });
        },
      }),

      defineRoute({
        method: "GET",
        path: "/organizations/invitations",
        queryParameters: ["sessionId"],
        outputSchema: z.object({
          invitations: z.array(
            z.object({
              invitation: invitationSchema,
              organization: organizationSchema,
            }),
          ),
        }),
        errorCodes: ["session_invalid"],
        handler: async function ({ headers, query }, { json, error }) {
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

          const [result] = await this.handlerTx()
            .withServiceCalls(() => [
              services.listOrganizationInvitationsForUser(session.user.email),
            ])
            .execute();

          return json({
            invitations: result.invitations
              .filter((entry) => entry.organization && entry.invitation.status === "pending")
              .map((entry) => ({
                invitation: serializeInvitation(entry.invitation),
                organization: serializeOrganization(entry.organization!),
              })),
          });
        },
      }),

      defineRoute({
        method: "PATCH",
        path: "/organizations/invitations/:invitationId",
        queryParameters: ["sessionId"],
        inputSchema: z.object({
          action: z.enum(["accept", "reject", "cancel"]),
          token: z.string().optional(),
        }),
        outputSchema: z.object({
          invitation: invitationSchema,
        }),
        errorCodes: [
          "invitation_not_found",
          "invitation_expired",
          "permission_denied",
          "invalid_token",
          "session_invalid",
        ],
        handler: async function ({ input, pathParams, headers, query }, { json, error }) {
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

          const body = await input.valid();

          if ((body.action === "accept" || body.action === "reject") && !body.token) {
            return error({ message: "Invalid token", code: "invalid_token" }, 400);
          }

          const [result] = await this.handlerTx()
            .withServiceCalls(() => [
              services.respondToOrganizationInvitation({
                invitationId: pathParams.invitationId,
                action: body.action,
                token: body.token,
                userId: body.action === "accept" ? session.user.id : undefined,
              }),
            ])
            .execute();

          if (!result.ok) {
            if (result.code === "invalid_token") {
              return error({ message: "Invalid token", code: "invalid_token" }, 400);
            }

            if (result.code === "invitation_expired") {
              return error({ message: "Invitation expired", code: "invitation_expired" }, 400);
            }

            return error({ message: "Invitation not found", code: "invitation_not_found" }, 404);
          }

          return json({
            invitation: serializeInvitation(result.invitation),
          });
        },
      }),

      defineRoute({
        method: "GET",
        path: "/organizations/:organizationId",
        queryParameters: ["sessionId"],
        outputSchema: z.object({
          organization: organizationSchema,
          member: memberSchema,
        }),
        errorCodes: ["organization_not_found", "permission_denied", "session_invalid"],
        handler: async function ({ pathParams, headers, query }, { json, error }) {
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

          const [organizationResult] = await this.handlerTx()
            .withServiceCalls(() => [services.getOrganizationById(pathParams.organizationId)])
            .execute();

          if (!organizationResult) {
            return error(
              { message: "Organization not found", code: "organization_not_found" },
              404,
            );
          }

          const [memberResult] = await this.handlerTx()
            .withServiceCalls(() => [
              services.getOrganizationMemberByUser({
                organizationId: pathParams.organizationId,
                userId: session.user.id,
              }),
            ])
            .execute();

          if (!memberResult) {
            return error({ message: "Permission denied", code: "permission_denied" }, 401);
          }

          const [rolesResult] = await this.handlerTx()
            .withServiceCalls(() => [services.listOrganizationMemberRoles(memberResult.id)])
            .execute();

          return json({
            organization: serializeOrganization(organizationResult.organization),
            member: serializeMember({
              ...memberResult,
              roles: rolesResult.roles,
            }),
          });
        },
      }),

      defineRoute({
        method: "PATCH",
        path: "/organizations/:organizationId",
        queryParameters: ["sessionId"],
        inputSchema: updateOrganizationInputSchema,
        outputSchema: z.object({
          organization: organizationSchema,
        }),
        errorCodes: [
          "invalid_input",
          "organization_not_found",
          "organization_slug_taken",
          "permission_denied",
          "session_invalid",
        ],
        handler: async function ({ input, pathParams, headers, query }, { json, error }) {
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

          const [memberResult] = await this.handlerTx()
            .withServiceCalls(() => [
              services.getOrganizationMemberByUser({
                organizationId: pathParams.organizationId,
                userId: session.user.id,
              }),
            ])
            .execute();

          if (!memberResult) {
            return error({ message: "Permission denied", code: "permission_denied" }, 401);
          }

          const body = await input.valid();
          const [result] = await this.handlerTx()
            .withServiceCalls(() => [services.updateOrganization(pathParams.organizationId, body)])
            .execute();

          if (!result.ok) {
            if (result.code === "organization_not_found") {
              return error(
                { message: "Organization not found", code: "organization_not_found" },
                404,
              );
            }

            if (result.code === "organization_slug_taken") {
              return error(
                { message: "Organization slug taken", code: "organization_slug_taken" },
                400,
              );
            }

            return error({ message: "Invalid input", code: "invalid_input" }, 400);
          }

          return json({
            organization: serializeOrganization(result.organization),
          });
        },
      }),

      defineRoute({
        method: "DELETE",
        path: "/organizations/:organizationId",
        queryParameters: ["sessionId"],
        outputSchema: z.object({
          success: z.boolean(),
        }),
        errorCodes: ["organization_not_found", "permission_denied", "session_invalid"],
        handler: async function ({ pathParams, headers, query }, { json, error }) {
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

          const [memberResult] = await this.handlerTx()
            .withServiceCalls(() => [
              services.getOrganizationMemberByUser({
                organizationId: pathParams.organizationId,
                userId: session.user.id,
              }),
            ])
            .execute();

          if (!memberResult) {
            return error({ message: "Permission denied", code: "permission_denied" }, 401);
          }

          const [result] = await this.handlerTx()
            .withServiceCalls(() => [services.deleteOrganization(pathParams.organizationId)])
            .execute();

          if (!result.ok) {
            return error(
              { message: "Organization not found", code: "organization_not_found" },
              404,
            );
          }

          return json({ success: true });
        },
      }),

      defineRoute({
        method: "GET",
        path: "/organizations/:organizationId/members",
        queryParameters: ["pageSize", "cursor", "sessionId"],
        outputSchema: z.object({
          members: z.array(memberSchema),
          cursor: z.string().optional(),
          hasNextPage: z.boolean(),
        }),
        errorCodes: [
          "invalid_input",
          "organization_not_found",
          "permission_denied",
          "session_invalid",
        ],
        handler: async function ({ pathParams, query, headers }, { json, error }) {
          const parsed = pageQuerySchema.safeParse(Object.fromEntries(query.entries()));
          if (!parsed.success) {
            return error({ message: "Invalid query parameters", code: "invalid_input" }, 400);
          }

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

          const [organizationResult] = await this.handlerTx()
            .withServiceCalls(() => [services.getOrganizationById(pathParams.organizationId)])
            .execute();

          if (!organizationResult) {
            return error(
              { message: "Organization not found", code: "organization_not_found" },
              404,
            );
          }

          const [memberResult] = await this.handlerTx()
            .withServiceCalls(() => [
              services.getOrganizationMemberByUser({
                organizationId: pathParams.organizationId,
                userId: session.user.id,
              }),
            ])
            .execute();

          if (!memberResult) {
            return error({ message: "Permission denied", code: "permission_denied" }, 401);
          }

          const cursor = parseCursor(query.get("cursor"));
          const [result] = await this.handlerTx()
            .withServiceCalls(() => [
              services.listOrganizationMembers({
                organizationId: pathParams.organizationId,
                pageSize: parsed.data.pageSize,
                cursor,
              }),
            ])
            .execute();

          const memberIds = result.members.map((member) => member.id);
          const [rolesResult] = await this.handlerTx()
            .withServiceCalls(() => [services.listOrganizationMemberRolesForMembers(memberIds)])
            .execute();

          return json({
            members: result.members.map((member) =>
              serializeMember({
                ...member,
                roles: rolesResult.rolesByMemberId[member.id] ?? [],
              }),
            ),
            cursor: result.cursor?.encode(),
            hasNextPage: result.hasNextPage,
          });
        },
      }),

      defineRoute({
        method: "POST",
        path: "/organizations/:organizationId/members",
        queryParameters: ["sessionId"],
        inputSchema: z.object({
          userId: z.string(),
          roles: z.array(z.string()).optional(),
        }),
        outputSchema: z.object({
          member: memberSchema,
        }),
        errorCodes: [
          "organization_not_found",
          "permission_denied",
          "member_already_exists",
          "limit_reached",
          "session_invalid",
        ],
        handler: async function ({ input, pathParams, headers, query }, { json, error }) {
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

          const [organizationResult] = await this.handlerTx()
            .withServiceCalls(() => [services.getOrganizationById(pathParams.organizationId)])
            .execute();

          if (!organizationResult) {
            return error(
              { message: "Organization not found", code: "organization_not_found" },
              404,
            );
          }

          const [memberResult] = await this.handlerTx()
            .withServiceCalls(() => [
              services.getOrganizationMemberByUser({
                organizationId: pathParams.organizationId,
                userId: session.user.id,
              }),
            ])
            .execute();

          if (!memberResult) {
            return error({ message: "Permission denied", code: "permission_denied" }, 401);
          }

          const body = await input.valid();
          const [result] = await this.handlerTx()
            .withServiceCalls(() => [
              services.createOrganizationMember({
                organizationId: pathParams.organizationId,
                userId: body.userId,
                roles: body.roles,
              }),
            ])
            .execute();

          if (!result.ok) {
            return error({ message: "Member already exists", code: "member_already_exists" }, 400);
          }

          return json({
            member: serializeMember(result.member),
          });
        },
      }),

      defineRoute({
        method: "PATCH",
        path: "/organizations/:organizationId/members/:memberId",
        queryParameters: ["sessionId"],
        inputSchema: z.object({
          roles: z.array(z.string()).min(1),
        }),
        outputSchema: z.object({
          member: memberSchema,
        }),
        errorCodes: ["member_not_found", "permission_denied", "last_owner", "session_invalid"],
        handler: async function ({ input, pathParams, headers, query }, { json, error }) {
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

          const [memberResult] = await this.handlerTx()
            .withServiceCalls(() => [
              services.getOrganizationMemberByUser({
                organizationId: pathParams.organizationId,
                userId: session.user.id,
              }),
            ])
            .execute();

          if (!memberResult) {
            return error({ message: "Permission denied", code: "permission_denied" }, 401);
          }

          const body = await input.valid();
          const [result] = await this.handlerTx()
            .withServiceCalls(() => [
              services.updateOrganizationMemberRoles(pathParams.memberId, body.roles),
            ])
            .execute();

          if (!result.ok) {
            return error({ message: "Member not found", code: "member_not_found" }, 404);
          }

          return json({
            member: serializeMember(result.member),
          });
        },
      }),

      defineRoute({
        method: "DELETE",
        path: "/organizations/:organizationId/members/:memberId",
        queryParameters: ["sessionId"],
        outputSchema: z.object({
          success: z.boolean(),
        }),
        errorCodes: ["member_not_found", "permission_denied", "last_owner", "session_invalid"],
        handler: async function ({ pathParams, headers, query }, { json, error }) {
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

          const [memberResult] = await this.handlerTx()
            .withServiceCalls(() => [
              services.getOrganizationMemberByUser({
                organizationId: pathParams.organizationId,
                userId: session.user.id,
              }),
            ])
            .execute();

          if (!memberResult) {
            return error({ message: "Permission denied", code: "permission_denied" }, 401);
          }

          const [result] = await this.handlerTx()
            .withServiceCalls(() => [services.removeOrganizationMember(pathParams.memberId)])
            .execute();

          if (!result.ok) {
            return error({ message: "Member not found", code: "member_not_found" }, 404);
          }

          return json({ success: true });
        },
      }),

      defineRoute({
        method: "GET",
        path: "/organizations/:organizationId/invitations",
        queryParameters: ["sessionId"],
        outputSchema: z.object({
          invitations: z.array(invitationSummarySchema),
        }),
        errorCodes: ["organization_not_found", "permission_denied", "session_invalid"],
        handler: async function ({ pathParams, headers, query }, { json, error }) {
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

          const [organizationResult] = await this.handlerTx()
            .withServiceCalls(() => [services.getOrganizationById(pathParams.organizationId)])
            .execute();

          if (!organizationResult) {
            return error(
              { message: "Organization not found", code: "organization_not_found" },
              404,
            );
          }

          const [memberResult] = await this.handlerTx()
            .withServiceCalls(() => [
              services.getOrganizationMemberByUser({
                organizationId: pathParams.organizationId,
                userId: session.user.id,
              }),
            ])
            .execute();

          if (!memberResult) {
            return error({ message: "Permission denied", code: "permission_denied" }, 401);
          }

          const [result] = await this.handlerTx()
            .withServiceCalls(() => [
              services.listOrganizationInvitations({
                organizationId: pathParams.organizationId,
              }),
            ])
            .execute();

          return json({
            invitations: result.invitations.map(serializeInvitationSummary),
          });
        },
      }),

      defineRoute({
        method: "POST",
        path: "/organizations/:organizationId/invitations",
        queryParameters: ["sessionId"],
        inputSchema: z.object({
          email: z.email(),
          roles: z.array(z.string()).optional(),
        }),
        outputSchema: z.object({
          invitation: invitationSchema,
        }),
        errorCodes: [
          "organization_not_found",
          "permission_denied",
          "limit_reached",
          "session_invalid",
        ],
        handler: async function ({ input, pathParams, headers, query }, { json, error }) {
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

          const [organizationResult] = await this.handlerTx()
            .withServiceCalls(() => [services.getOrganizationById(pathParams.organizationId)])
            .execute();

          if (!organizationResult) {
            return error(
              { message: "Organization not found", code: "organization_not_found" },
              404,
            );
          }

          const [memberResult] = await this.handlerTx()
            .withServiceCalls(() => [
              services.getOrganizationMemberByUser({
                organizationId: pathParams.organizationId,
                userId: session.user.id,
              }),
            ])
            .execute();

          if (!memberResult) {
            return error({ message: "Permission denied", code: "permission_denied" }, 401);
          }

          const body = await input.valid();
          const [result] = await this.handlerTx()
            .withServiceCalls(() => [
              services.createOrganizationInvitation({
                organizationId: pathParams.organizationId,
                email: body.email,
                roles: body.roles,
                inviterId: session.user.id,
              }),
            ])
            .execute();

          if (!result.ok) {
            return error({ message: "Permission denied", code: "permission_denied" }, 401);
          }

          return json({
            invitation: serializeInvitation(result.invitation),
          });
        },
      }),
    ];
  },
);
