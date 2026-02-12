import { defineRoute, defineRoutes } from "@fragno-dev/core";
import type { DatabaseServiceContext, TypedUnitOfWork } from "@fragno-dev/db";
import { authSchema } from "../schema";
import { z } from "zod";
import { hashPassword, verifyPassword } from "./password";
import { buildSetCookieHeader, extractSessionId } from "../utils/cookie";
import type { authFragmentDefinition } from "..";
import type { AutoCreateOrganizationConfig } from "../organization/types";
import {
  DEFAULT_CREATOR_ROLES,
  buildAutoOrganizationInput,
  normalizeOrganizationSlug,
  normalizeRoleNames,
} from "../organization/utils";

type AuthServiceContext = DatabaseServiceContext<{}>;
type AuthUow = TypedUnitOfWork<typeof authSchema, unknown[], unknown, {}>;

type AutoCreateOrganizationOptions = {
  autoCreateOrganization?: AutoCreateOrganizationConfig;
  creatorRoles?: readonly string[];
};

const resolveAutoOrganizationSlug = (name: string, userId: string): string => {
  const normalized = normalizeOrganizationSlug(name);
  if (normalized) {
    return normalized;
  }

  const fallback = normalizeOrganizationSlug(`org-${userId.slice(0, 8)}`);
  if (!fallback) {
    throw new Error("Invalid auto organization slug");
  }
  return fallback;
};

const createAutoOrganization = (
  uow: AuthUow,
  input: {
    userId: string;
    email: string;
    now: Date;
    options?: AutoCreateOrganizationOptions;
  },
) => {
  if (!input.options?.autoCreateOrganization) {
    return null;
  }

  const { name, slug, logoUrl, metadata } = buildAutoOrganizationInput(
    input.options.autoCreateOrganization,
    {
      userId: input.userId,
      email: input.email,
    },
  );

  const normalizedSlug = slug ?? resolveAutoOrganizationSlug(name, input.userId);
  const creatorRoles = normalizeRoleNames(input.options.creatorRoles, DEFAULT_CREATOR_ROLES);

  const organizationId = uow.create("organization", {
    name,
    slug: normalizedSlug,
    logoUrl: logoUrl ?? null,
    metadata: metadata ?? null,
    createdBy: input.userId,
    createdAt: input.now,
    updatedAt: input.now,
  });

  const memberId = uow.create("organizationMember", {
    organizationId,
    userId: input.userId,
    createdAt: input.now,
    updatedAt: input.now,
  });

  for (const role of creatorRoles) {
    uow.create("organizationMemberRole", {
      memberId,
      role,
      createdAt: input.now,
    });
  }

  return organizationId;
};

export function createUserServices(options?: AutoCreateOrganizationOptions) {
  return {
    createUser: function (
      this: AuthServiceContext,
      email: string,
      passwordHash: string,
      role: "user" | "admin" = "user",
      autoCreateOptions?: AutoCreateOrganizationOptions,
    ) {
      return this.serviceTx(authSchema)
        .mutate(({ uow }) => {
          const now = new Date();
          const id = uow.create("user", {
            email,
            passwordHash,
            role,
          });

          createAutoOrganization(uow, {
            userId: id.valueOf(),
            email,
            now,
            options: autoCreateOptions ?? options,
          });

          return {
            id: id.valueOf(),
            email,
            role,
          };
        })
        .build();
    },
    getUserByEmail: function (this: AuthServiceContext, email: string) {
      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow.findFirst("user", (b) =>
            b.whereIndex("idx_user_email", (eb) => eb("email", "=", email)),
          ),
        )
        .transformRetrieve(([user]) =>
          user
            ? {
                id: user.id.valueOf(),
                email: user.email,
                passwordHash: user.passwordHash,
                role: user.role as "user" | "admin",
              }
            : null,
        )
        .build();
    },
    updateUserRole: function (this: AuthServiceContext, userId: string, role: "user" | "admin") {
      return this.serviceTx(authSchema)
        .mutate(({ uow }) => {
          uow.update("user", userId, (b) => b.set({ role }));
          return { success: true };
        })
        .build();
    },
    updateUserPassword: function (this: AuthServiceContext, userId: string, passwordHash: string) {
      return this.serviceTx(authSchema)
        .mutate(({ uow }) => {
          uow.update("user", userId, (b) => b.set({ passwordHash }));
          return { success: true };
        })
        .build();
    },
    signUpWithSession: function (
      this: AuthServiceContext,
      email: string,
      passwordHash: string,
      autoCreateOptions?: AutoCreateOrganizationOptions,
    ) {
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 30); // 30 days from now

      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow.findFirst("user", (b) =>
            b.whereIndex("idx_user_email", (eb) => eb("email", "=", email)),
          ),
        )
        .mutate(({ uow, retrieveResult: [existingUser] }) => {
          if (existingUser) {
            return { ok: false as const, code: "email_already_exists" as const };
          }

          const now = new Date();

          const userId = uow.create("user", {
            email,
            passwordHash,
            role: "user",
          });

          const organizationId = createAutoOrganization(uow, {
            userId: userId.valueOf(),
            email,
            now,
            options: autoCreateOptions ?? options,
          });

          const sessionId = uow.create("session", {
            userId,
            activeOrganizationId: organizationId ?? null,
            expiresAt,
          });

          return {
            ok: true as const,
            sessionId: sessionId.valueOf(),
            userId: userId.valueOf(),
            email,
            role: "user" as const,
          };
        })
        .build();
    },
    updateUserRoleWithSession: function (
      this: AuthServiceContext,
      sessionId: string,
      userId: string,
      role: "user" | "admin",
    ) {
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
          if (!session || !session.sessionOwner) {
            return { ok: false as const, code: "session_invalid" as const };
          }

          if (session.expiresAt < now) {
            uow.delete("session", session.id, (b) => b.check());
            return { ok: false as const, code: "session_invalid" as const };
          }

          if (session.sessionOwner.role !== "admin") {
            return { ok: false as const, code: "permission_denied" as const };
          }

          uow.update("user", userId, (b) => b.set({ role }));
          return { ok: true as const };
        })
        .build();
    },
    changePasswordWithSession: function (
      this: AuthServiceContext,
      sessionId: string,
      passwordHash: string,
    ) {
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
          if (!session || !session.sessionOwner) {
            return { ok: false as const, code: "session_invalid" as const };
          }

          if (session.expiresAt < now) {
            uow.delete("session", session.id, (b) => b.check());
            return { ok: false as const, code: "session_invalid" as const };
          }

          uow.update("user", session.sessionOwner.id, (b) => b.set({ passwordHash }).check());
          return { ok: true as const };
        })
        .build();
    },
  };
}

export const userActionsRoutesFactory = defineRoutes<typeof authFragmentDefinition>().create(
  ({ services, config }) => {
    return [
      defineRoute({
        method: "PATCH",
        path: "/users/:userId/role",
        inputSchema: z.object({
          role: z.enum(["user", "admin"]),
        }),
        outputSchema: z.object({
          success: z.boolean(),
        }),
        errorCodes: ["invalid_input", "session_invalid", "permission_denied"],
        handler: async function ({ input, pathParams, headers, query }, { json, error }) {
          const { role } = await input.valid();
          const { userId } = pathParams;

          const sessionId = extractSessionId(headers, query.get("sessionId"));

          if (!sessionId) {
            return error({ message: "Session ID required", code: "session_invalid" }, 400);
          }

          const [result] = await this.handlerTx()
            .withServiceCalls(() => [services.updateUserRoleWithSession(sessionId, userId, role)])
            .execute();

          if (!result.ok) {
            if (result.code === "permission_denied") {
              return error({ message: "Unauthorized", code: "permission_denied" }, 401);
            }

            return error({ message: "Invalid session", code: "session_invalid" }, 401);
          }

          return json({ success: true });
        },
      }),

      defineRoute({
        method: "POST",
        path: "/sign-up",
        inputSchema: z.object({
          email: z.email(),
          password: z.string().min(8).max(100),
        }),
        outputSchema: z.object({
          sessionId: z.string(),
          userId: z.string(),
          email: z.string(),
          role: z.enum(["user", "admin"]),
        }),
        errorCodes: ["email_already_exists", "invalid_input"],
        handler: async function ({ input }, { json, error }) {
          const { email, password } = await input.valid();

          const passwordHash = await hashPassword(password);

          const [result] = await this.handlerTx()
            .withServiceCalls(() => [services.signUpWithSession(email, passwordHash)])
            .execute();

          if (!result.ok) {
            return error({ message: "Email already exists", code: "email_already_exists" }, 400);
          }

          // Build response with Set-Cookie header
          const setCookieHeader = buildSetCookieHeader(result.sessionId, config.cookieOptions);

          return json(
            {
              sessionId: result.sessionId,
              userId: result.userId,
              email: result.email,
              role: result.role,
            },
            {
              headers: {
                "Set-Cookie": setCookieHeader,
              },
            },
          );
        },
      }),

      defineRoute({
        method: "POST",
        path: "/sign-in",
        inputSchema: z.object({
          email: z.email(),
          password: z.string().min(8).max(100),
        }),
        outputSchema: z.object({
          sessionId: z.string(),
          userId: z.string(),
          email: z.string(),
          role: z.enum(["user", "admin"]),
        }),
        errorCodes: ["invalid_credentials"],
        handler: async function ({ input }, { json, error }) {
          const { email, password } = await input.valid();

          // Get user by email
          const [user] = await this.handlerTx()
            .withServiceCalls(() => [services.getUserByEmail(email)])
            .execute();
          if (!user) {
            return error({ message: "Invalid credentials", code: "invalid_credentials" }, 401);
          }

          // Verify password
          const isValid = await verifyPassword(password, user.passwordHash);
          if (!isValid) {
            return error({ message: "Invalid credentials", code: "invalid_credentials" }, 401);
          }

          // Create session
          const [session] = await this.handlerTx()
            .withServiceCalls(() => [services.createSession(user.id)])
            .execute();

          // Build response with Set-Cookie header
          const setCookieHeader = buildSetCookieHeader(session.id, config.cookieOptions);

          return json(
            {
              sessionId: session.id,
              userId: user.id,
              email: user.email,
              role: user.role,
            },
            {
              headers: {
                "Set-Cookie": setCookieHeader,
              },
            },
          );
        },
      }),

      defineRoute({
        method: "POST",
        path: "/change-password",
        inputSchema: z.object({
          newPassword: z.string().min(8).max(100),
        }),
        outputSchema: z.object({
          success: z.boolean(),
        }),
        errorCodes: ["session_invalid"],
        handler: async function ({ input, headers, query }, { json, error }) {
          const { newPassword } = await input.valid();

          const sessionId = extractSessionId(headers, query.get("sessionId"));

          if (!sessionId) {
            return error({ message: "Session ID required", code: "session_invalid" }, 400);
          }

          const passwordHash = await hashPassword(newPassword);

          const [result] = await this.handlerTx()
            .withServiceCalls(() => [services.changePasswordWithSession(sessionId, passwordHash)])
            .execute();

          if (!result.ok) {
            return error({ message: "Invalid session", code: "session_invalid" }, 401);
          }

          return json({ success: true });
        },
      }),
    ];
  },
);
