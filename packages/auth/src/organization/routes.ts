import { defineRoute, defineRoutes } from "@fragno-dev/core";
import { type Cursor, decodeCursor } from "@fragno-dev/db/cursor";
import { z } from "zod";
import type { authFragmentDefinition } from "..";
import { extractSessionId } from "../utils/cookie";
import { serializeInvitation, serializeMember, serializeOrganization } from "./serializers";
import { invitationSchema, memberSchema, organizationSchema } from "./schemas";

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
  ({ config, services }) => {
    const organizationsEnabled = config.organizations !== false;
    const defineOrganizationRoute = ((route: Parameters<typeof defineRoute>[0]) =>
      defineRoute({
        ...route,
        errorCodes: route.errorCodes
          ? Array.from(new Set([...route.errorCodes, "feature_disabled"]))
          : ["feature_disabled"],
        handler: async function (input, helpers) {
          if (!organizationsEnabled) {
            return helpers.error(
              { message: "Organizations are disabled", code: "feature_disabled" },
              403,
            );
          }
          return (route.handler as typeof route.handler).call(this, input, helpers);
        },
      })) as typeof defineRoute;

    return [
      defineOrganizationRoute({
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

          let body: z.infer<typeof createOrganizationInputSchema> | null = null;
          let inputError: unknown = null;
          try {
            body = await input.valid();
          } catch (err) {
            inputError = err;
          }

          const [result] = await this.handlerTx()
            .withServiceCalls(() => [
              services.createOrganizationWithSession({
                sessionId,
                input: body,
                inputError,
              }),
            ])
            .execute();

          if (!result.ok) {
            if (result.code === "session_invalid") {
              return error({ message: "Invalid session", code: "session_invalid" }, 401);
            }

            if (result.code === "input_invalid") {
              if (inputError) {
                throw inputError;
              }
              return error({ message: "Invalid input", code: "invalid_input" }, 400);
            }

            if (result.code === "organization_slug_taken") {
              return error(
                { message: "Organization slug taken", code: "organization_slug_taken" },
                400,
              );
            }

            if (result.code === "invalid_slug") {
              return error({ message: "Invalid input", code: "invalid_input" }, 400);
            }

            if (result.code === "limit_reached") {
              return error({ message: "Limit reached", code: "limit_reached" }, 400);
            }

            return error({ message: "Permission denied", code: "permission_denied" }, 403);
          }

          return json({
            organization: serializeOrganization(result.organization),
            member: serializeMember(result.member),
          });
        },
      }),

      defineOrganizationRoute({
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

          const rawCursor = parseCursor(query.get("cursor"));
          const cursor =
            rawCursor && (rawCursor.indexName === "_primary" || rawCursor.indexName === "primary")
              ? rawCursor
              : undefined;
          const [result] = await this.handlerTx()
            .withServiceCalls(() => [
              services.getOrganizationsForSession({
                sessionId,
                pageSize: parsed.data.pageSize,
                cursor,
              }),
            ])
            .execute();

          if (!result.ok) {
            return error({ message: "Invalid session", code: "session_invalid" }, 401);
          }

          return json({
            organizations: result.organizations.map((entry) => ({
              organization: serializeOrganization(entry.organization),
              member: serializeMember(entry.member),
            })),
            cursor: result.cursor,
            hasNextPage: result.hasNextPage,
          });
        },
      }),

      defineOrganizationRoute({
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

          const [result] = await this.handlerTx()
            .withServiceCalls(() => [
              services.getActiveOrganizationForSession({
                sessionId,
              }),
            ])
            .execute();

          if (!result.ok) {
            return error({ message: "Invalid session", code: "session_invalid" }, 401);
          }

          if (!result.data) {
            return json(null);
          }

          return json({
            organization: serializeOrganization(result.data.organization),
            member: serializeMember(result.data.member),
          });
        },
      }),

      defineOrganizationRoute({
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

          const body = await input.valid();

          const [result] = await this.handlerTx()
            .withServiceCalls(() => [
              services.setActiveOrganizationForSession({
                sessionId,
                organizationId: body.organizationId,
              }),
            ])
            .execute();

          if (!result.ok) {
            if (result.code === "organization_not_found") {
              return error(
                { message: "Organization not found", code: "organization_not_found" },
                404,
              );
            }

            if (result.code === "membership_not_found") {
              return error({ message: "Membership not found", code: "membership_not_found" }, 404);
            }

            return error({ message: "Invalid session", code: "session_invalid" }, 401);
          }

          return json({
            organization: serializeOrganization(result.organization),
            member: serializeMember(result.member),
          });
        },
      }),

      defineOrganizationRoute({
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

          const [result] = await this.handlerTx()
            .withServiceCalls(() => [services.listInvitationsForSession({ sessionId })])
            .execute();

          if (!result.ok) {
            return error({ message: "Invalid session", code: "session_invalid" }, 401);
          }

          return json({
            invitations: result.invitations.map((entry) => ({
              invitation: serializeInvitation(entry.invitation),
              organization: serializeOrganization(entry.organization),
            })),
          });
        },
      }),

      defineOrganizationRoute({
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
          "limit_reached",
          "session_invalid",
        ],
        handler: async function ({ input, pathParams, headers, query }, { json, error }) {
          const sessionId = extractSessionId(headers, query.get("sessionId"));
          if (!sessionId) {
            return error({ message: "Session ID required", code: "session_invalid" }, 400);
          }

          const body = await input.valid();

          if ((body.action === "accept" || body.action === "reject") && !body.token) {
            return error({ message: "Invalid token", code: "invalid_token" }, 400);
          }

          const [result] = await this.handlerTx()
            .withServiceCalls(() => [
              services.respondToInvitationWithSession({
                sessionId,
                invitationId: pathParams.invitationId,
                action: body.action,
                token: body.token,
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

            if (result.code === "limit_reached") {
              return error({ message: "Limit reached", code: "limit_reached" }, 400);
            }

            if (result.code === "permission_denied") {
              return error({ message: "Permission denied", code: "permission_denied" }, 403);
            }

            if (result.code === "session_invalid") {
              return error({ message: "Invalid session", code: "session_invalid" }, 401);
            }

            return error({ message: "Invitation not found", code: "invitation_not_found" }, 404);
          }

          return json({
            invitation: serializeInvitation(result.invitation),
          });
        },
      }),

      defineOrganizationRoute({
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

          const [result] = await this.handlerTx()
            .withServiceCalls(() => [
              services.getOrganizationForSession({
                sessionId,
                organizationId: pathParams.organizationId,
              }),
            ])
            .execute();

          if (!result.ok) {
            if (result.code === "organization_not_found") {
              return error(
                { message: "Organization not found", code: "organization_not_found" },
                404,
              );
            }

            if (result.code === "permission_denied") {
              return error({ message: "Permission denied", code: "permission_denied" }, 403);
            }

            return error({ message: "Invalid session", code: "session_invalid" }, 401);
          }

          return json({
            organization: serializeOrganization(result.organization),
            member: serializeMember(result.member),
          });
        },
      }),

      defineOrganizationRoute({
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

          const body = await input.valid();

          const [result] = await this.handlerTx()
            .withServiceCalls(() => [
              services.updateOrganizationWithSession({
                sessionId,
                organizationId: pathParams.organizationId,
                patch: body,
              }),
            ])
            .execute();

          if (!result.ok) {
            if (result.code === "session_invalid") {
              return error({ message: "Invalid session", code: "session_invalid" }, 401);
            }

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

            if (result.code === "permission_denied") {
              return error({ message: "Permission denied", code: "permission_denied" }, 403);
            }

            return error({ message: "Invalid input", code: "invalid_input" }, 400);
          }

          return json({
            organization: serializeOrganization(result.organization),
          });
        },
      }),

      defineOrganizationRoute({
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

          const [result] = await this.handlerTx()
            .withServiceCalls(() => [
              services.deleteOrganizationWithSession({
                sessionId,
                organizationId: pathParams.organizationId,
              }),
            ])
            .execute();

          if (!result.ok) {
            if (result.code === "session_invalid") {
              return error({ message: "Invalid session", code: "session_invalid" }, 401);
            }

            if (result.code === "organization_not_found") {
              return error(
                { message: "Organization not found", code: "organization_not_found" },
                404,
              );
            }

            return error({ message: "Permission denied", code: "permission_denied" }, 403);
          }

          return json({ success: true });
        },
      }),

      defineOrganizationRoute({
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
          const cursor = parseCursor(query.get("cursor"));
          const [result] = await this.handlerTx()
            .withServiceCalls(() => [
              services.listOrganizationMembersWithSession({
                sessionId,
                organizationId: pathParams.organizationId,
                pageSize: parsed.data.pageSize,
                cursor,
              }),
            ])
            .execute();

          if (!result.ok) {
            if (result.code === "session_invalid") {
              return error({ message: "Invalid session", code: "session_invalid" }, 401);
            }

            if (result.code === "organization_not_found") {
              return error(
                { message: "Organization not found", code: "organization_not_found" },
                404,
              );
            }

            return error({ message: "Permission denied", code: "permission_denied" }, 403);
          }

          return json({
            members: result.members.map((member) => serializeMember(member)),
            cursor: result.cursor,
            hasNextPage: result.hasNextPage,
          });
        },
      }),

      defineOrganizationRoute({
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
          const body = await input.valid();
          const [result] = await this.handlerTx()
            .withServiceCalls(() => [
              services.createOrganizationMemberWithSession({
                sessionId,
                organizationId: pathParams.organizationId,
                userId: body.userId,
                roles: body.roles,
              }),
            ])
            .execute();

          if (!result.ok) {
            if (result.code === "session_invalid") {
              return error({ message: "Invalid session", code: "session_invalid" }, 401);
            }

            if (result.code === "organization_not_found") {
              return error(
                { message: "Organization not found", code: "organization_not_found" },
                404,
              );
            }

            if (result.code === "member_already_exists") {
              return error(
                { message: "Member already exists", code: "member_already_exists" },
                400,
              );
            }

            if (result.code === "limit_reached") {
              return error({ message: "Limit reached", code: "limit_reached" }, 400);
            }

            return error({ message: "Permission denied", code: "permission_denied" }, 403);
          }

          return json({
            member: serializeMember(result.member),
          });
        },
      }),

      defineOrganizationRoute({
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
          const body = await input.valid();
          const [result] = await this.handlerTx()
            .withServiceCalls(() => [
              services.updateOrganizationMemberRolesWithSession({
                sessionId,
                organizationId: pathParams.organizationId,
                memberId: pathParams.memberId,
                roles: body.roles,
              }),
            ])
            .execute();

          if (!result.ok) {
            if (result.code === "session_invalid") {
              return error({ message: "Invalid session", code: "session_invalid" }, 401);
            }

            if (result.code === "member_not_found") {
              return error({ message: "Member not found", code: "member_not_found" }, 404);
            }

            if (result.code === "last_owner") {
              return error({ message: "Last owner", code: "last_owner" }, 400);
            }

            return error({ message: "Permission denied", code: "permission_denied" }, 403);
          }

          return json({
            member: serializeMember(result.member),
          });
        },
      }),

      defineOrganizationRoute({
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
          const [result] = await this.handlerTx()
            .withServiceCalls(() => [
              services.deleteOrganizationMemberWithSession({
                sessionId,
                organizationId: pathParams.organizationId,
                memberId: pathParams.memberId,
              }),
            ])
            .execute();

          if (!result.ok) {
            if (result.code === "session_invalid") {
              return error({ message: "Invalid session", code: "session_invalid" }, 401);
            }

            if (result.code === "member_not_found") {
              return error({ message: "Member not found", code: "member_not_found" }, 404);
            }

            if (result.code === "last_owner") {
              return error({ message: "Last owner", code: "last_owner" }, 400);
            }

            return error({ message: "Permission denied", code: "permission_denied" }, 403);
          }

          return json({ success: true });
        },
      }),

      defineOrganizationRoute({
        method: "GET",
        path: "/organizations/:organizationId/invitations",
        queryParameters: ["sessionId"],
        outputSchema: z.object({
          invitations: z.array(invitationSchema),
        }),
        errorCodes: ["organization_not_found", "permission_denied", "session_invalid"],
        handler: async function ({ pathParams, headers, query }, { json, error }) {
          const sessionId = extractSessionId(headers, query.get("sessionId"));
          if (!sessionId) {
            return error({ message: "Session ID required", code: "session_invalid" }, 400);
          }

          const [result] = await this.handlerTx()
            .withServiceCalls(() => [
              services.listOrganizationInvitationsWithSession({
                sessionId,
                organizationId: pathParams.organizationId,
              }),
            ])
            .execute();

          if (!result.ok) {
            if (result.code === "session_invalid") {
              return error({ message: "Invalid session", code: "session_invalid" }, 401);
            }

            if (result.code === "organization_not_found") {
              return error(
                { message: "Organization not found", code: "organization_not_found" },
                404,
              );
            }

            return error({ message: "Permission denied", code: "permission_denied" }, 403);
          }

          return json({
            invitations: result.invitations.map(serializeInvitation),
          });
        },
      }),

      defineOrganizationRoute({
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

          const body = await input.valid();
          const [result] = await this.handlerTx()
            .withServiceCalls(() => [
              services.createOrganizationInvitationWithSession({
                sessionId,
                organizationId: pathParams.organizationId,
                email: body.email,
                roles: body.roles,
              }),
            ])
            .execute();

          if (!result.ok) {
            if (result.code === "session_invalid") {
              return error({ message: "Invalid session", code: "session_invalid" }, 401);
            }

            if (result.code === "organization_not_found") {
              return error(
                { message: "Organization not found", code: "organization_not_found" },
                404,
              );
            }

            if (result.code === "limit_reached") {
              return error({ message: "Limit reached", code: "limit_reached" }, 400);
            }

            return error({ message: "Permission denied", code: "permission_denied" }, 403);
          }

          return json({
            invitation: serializeInvitation(result.invitation),
          });
        },
      }),
    ];
  },
);
