import { defineRoute, defineRoutes } from "@fragno-dev/core";
import type { DatabaseServiceContext } from "@fragno-dev/db";
import { authSchema } from "../schema";
import { z } from "zod";
import { hashPassword, verifyPassword } from "./password";
import { buildSetCookieHeader, extractSessionId } from "../utils/cookie";
import type { authFragmentDefinition } from "..";
import type { AuthHooksMap, BeforeCreateUserHook } from "../hooks";
import { createAutoOrganization, type AutoCreateOrganizationOptions } from "./auto-organization";
import { mapUserSummary } from "./summary";

type AuthServiceContext = DatabaseServiceContext<AuthHooksMap>;

export function createUserServices(
  options?: AutoCreateOrganizationOptions,
  beforeCreateUser?: BeforeCreateUserHook,
) {
  const runBeforeCreateUser = (email: string, role: "user" | "admin") => {
    beforeCreateUser?.({ email, role });
  };

  const createUserUnvalidated = function (
    this: AuthServiceContext,
    email: string,
    passwordHash: string,
    role: "user" | "admin" = "user",
    autoCreateOptions?: AutoCreateOrganizationOptions,
  ) {
    return this.serviceTx(authSchema)
      .mutate(({ uow }) => {
        runBeforeCreateUser(email, role);
        const now = new Date();
        const id = uow.create("user", {
          email,
          passwordHash,
          role,
        });
        const userSummary = mapUserSummary({
          id: id.valueOf(),
          email,
          role,
          bannedAt: null,
        });

        const autoOrganization = createAutoOrganization(uow, {
          userId: id.valueOf(),
          email,
          now,
          options: autoCreateOptions ?? options,
        });

        uow.triggerHook("onUserCreated", {
          user: userSummary,
          actor: null,
        });

        if (autoOrganization) {
          uow.triggerHook("onOrganizationCreated", {
            organization: autoOrganization.organization,
            actor: userSummary,
          });
          uow.triggerHook("onMemberAdded", {
            organization: autoOrganization.organization,
            member: autoOrganization.member,
            actor: userSummary,
          });
        }

        return {
          id: id.valueOf(),
          email,
          role,
        };
      })
      .build();
  };

  return {
    /**
     * Create a user without email uniqueness checks or session creation.
     */
    createUserUnvalidated,
    /**
     * Fetch a user by email with password hash metadata.
     */
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
                passwordHash: user.passwordHash ?? null,
                role: user.role as "user" | "admin",
              }
            : null,
        )
        .build();
    },
    /**
     * Update a user's role without session enforcement.
     */
    updateUserRole: function (this: AuthServiceContext, userId: string, role: "user" | "admin") {
      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow.findFirst("user", (b) => b.whereIndex("primary", (eb) => eb("id", "=", userId))),
        )
        .mutate(({ uow, retrieveResult: [user] }) => {
          uow.update("user", userId, (b) => b.set({ role }));

          if (user) {
            uow.triggerHook("onUserRoleUpdated", {
              user: mapUserSummary({
                id: userId,
                email: user.email,
                role,
                bannedAt: user.bannedAt ?? null,
              }),
              actor: null,
            });
          }
          return { success: true };
        })
        .build();
    },
    /**
     * Update a user's password hash without session enforcement.
     */
    updateUserPassword: function (this: AuthServiceContext, userId: string, passwordHash: string) {
      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow.findFirst("user", (b) => b.whereIndex("primary", (eb) => eb("id", "=", userId))),
        )
        .mutate(({ uow, retrieveResult: [user] }) => {
          uow.update("user", userId, (b) => b.set({ passwordHash }));

          if (user) {
            uow.triggerHook("onUserPasswordChanged", {
              user: mapUserSummary({
                id: userId,
                email: user.email,
                role: user.role,
                bannedAt: user.bannedAt ?? null,
              }),
              actor: null,
            });
          }
          return { success: true };
        })
        .build();
    },
    /**
     * Create a user and session for email/password sign-up.
     */
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
          runBeforeCreateUser(email, "user");

          const userId = uow.create("user", {
            email,
            passwordHash,
            role: "user",
          });

          const autoOrganization = createAutoOrganization(uow, {
            userId: userId.valueOf(),
            email,
            now,
            options: autoCreateOptions ?? options,
          });

          const sessionId = uow.create("session", {
            userId,
            activeOrganizationId: autoOrganization?.organization.id ?? null,
            expiresAt,
          });
          const userSummary = mapUserSummary({
            id: userId.valueOf(),
            email,
            role: "user",
            bannedAt: null,
          });

          uow.triggerHook("onUserCreated", {
            user: userSummary,
            actor: userSummary,
          });
          uow.triggerHook("onSessionCreated", {
            session: {
              id: sessionId.valueOf(),
              user: userSummary,
              expiresAt,
              activeOrganizationId: autoOrganization?.organization.id ?? null,
            },
            actor: userSummary,
          });

          if (autoOrganization) {
            uow.triggerHook("onOrganizationCreated", {
              organization: autoOrganization.organization,
              actor: userSummary,
            });
            uow.triggerHook("onMemberAdded", {
              organization: autoOrganization.organization,
              member: autoOrganization.member,
              actor: userSummary,
            });
          }

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
    /**
     * Update a user's role with admin session enforcement.
     */
    updateUserRoleWithSession: function (
      this: AuthServiceContext,
      sessionId: string,
      userId: string,
      role: "user" | "admin",
    ) {
      const now = new Date();
      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow
            .findFirst("session", (b) =>
              b
                .whereIndex("primary", (eb) => eb("id", "=", sessionId))
                .join((j) => j.sessionOwner((b) => b.select(["id", "email", "role", "bannedAt"]))),
            )
            .findFirst("user", (b) => b.whereIndex("primary", (eb) => eb("id", "=", userId))),
        )
        .mutate(({ uow, retrieveResult: [session, user] }) => {
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

          if (user) {
            const actorSummary = mapUserSummary({
              id: session.sessionOwner.id,
              email: session.sessionOwner.email,
              role: session.sessionOwner.role,
              bannedAt: session.sessionOwner.bannedAt ?? null,
            });
            uow.triggerHook("onUserRoleUpdated", {
              user: mapUserSummary({
                id: userId,
                email: user.email,
                role,
                bannedAt: user.bannedAt ?? null,
              }),
              actor: actorSummary,
            });
          }
          return { ok: true as const };
        })
        .build();
    },
    /**
     * Change the current session user's password.
     */
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
              .join((j) => j.sessionOwner((b) => b.select(["id", "email", "role", "bannedAt"]))),
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
          const actorSummary = mapUserSummary({
            id: session.sessionOwner.id,
            email: session.sessionOwner.email,
            role: session.sessionOwner.role,
            bannedAt: session.sessionOwner.bannedAt ?? null,
          });
          uow.triggerHook("onUserPasswordChanged", {
            user: actorSummary,
            actor: actorSummary,
          });
          return { ok: true as const };
        })
        .build();
    },
  };
}

export const userActionsRoutesFactory = defineRoutes<typeof authFragmentDefinition>().create(
  ({ services, config }) => {
    const emailAndPasswordEnabled = config.emailAndPassword?.enabled !== false;

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
        errorCodes: ["email_already_exists", "invalid_input", "email_password_disabled"],
        handler: async function ({ input }, { json, error }) {
          if (!emailAndPasswordEnabled) {
            return error(
              { message: "Email/password auth is disabled", code: "email_password_disabled" },
              403,
            );
          }

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
        errorCodes: ["invalid_credentials", "user_banned", "email_password_disabled"],
        handler: async function ({ input }, { json, error }) {
          if (!emailAndPasswordEnabled) {
            return error(
              { message: "Email/password auth is disabled", code: "email_password_disabled" },
              403,
            );
          }

          const { email, password } = await input.valid();

          // Get user by email
          const [user] = await this.handlerTx()
            .withServiceCalls(() => [services.getUserByEmail(email)])
            .execute();
          if (!user) {
            return error({ message: "Invalid credentials", code: "invalid_credentials" }, 401);
          }

          // Verify password
          if (!user.passwordHash) {
            return error({ message: "Invalid credentials", code: "invalid_credentials" }, 401);
          }

          const isValid = await verifyPassword(password, user.passwordHash);
          if (!isValid) {
            return error({ message: "Invalid credentials", code: "invalid_credentials" }, 401);
          }

          // Create session
          const [session] = await this.handlerTx()
            .withServiceCalls(() => [services.createSession(user.id)])
            .execute();
          if (!session.ok) {
            if (session.code === "user_banned") {
              return error({ message: "User is banned", code: "user_banned" }, 403);
            }
            return error({ message: "Invalid credentials", code: "invalid_credentials" }, 401);
          }

          // Build response with Set-Cookie header
          const setCookieHeader = buildSetCookieHeader(session.session.id, config.cookieOptions);

          return json(
            {
              sessionId: session.session.id,
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
