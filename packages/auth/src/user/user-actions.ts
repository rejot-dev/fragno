import { defineRoute, defineRoutes } from "@fragno-dev/core";
import type { SimpleQueryInterface } from "@fragno-dev/db/query";
import { authSchema } from "../schema";
import { z } from "zod";
import { hashPassword, verifyPassword } from "./password";
import { buildSetCookieHeader, extractSessionId } from "../utils/cookie";
import { FragnoApiValidationError } from "@fragno-dev/core/api";
import type { authFragmentDefinition } from "..";

export function createUserServices(orm: SimpleQueryInterface<typeof authSchema>) {
  return {
    createUser: async (email: string, password: string, role: "user" | "admin" = "user") => {
      const passwordHash = await hashPassword(password);
      const id = await orm.create("user", {
        email,
        passwordHash,
        role,
      });
      return {
        id: id.valueOf(),
        email,
        role,
      };
    },
    getUserByEmail: async (email: string) => {
      const users = await orm.findFirst("user", (b) =>
        b.whereIndex("idx_user_email", (eb) => eb("email", "=", email)),
      );
      return users
        ? {
            id: users.id.valueOf(),
            email: users.email,
            passwordHash: users.passwordHash,
            role: users.role as "user" | "admin",
          }
        : null;
    },
    updateUserRole: async (userId: string, role: "user" | "admin") => {
      await orm.update("user", userId, (b) => b.set({ role }));
      return { success: true };
    },
    updateUserPassword: async (userId: string, password: string) => {
      const passwordHash = await hashPassword(password);
      await orm.update("user", userId, (b) => b.set({ passwordHash }));
      return { success: true };
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
        handler: async ({ input, pathParams, headers, query }, { json, error }) => {
          const { role } = await input.valid();
          const { userId } = pathParams;

          const sessionId = extractSessionId(headers, query.get("sessionId"));

          if (!sessionId) {
            return error({ message: "Session ID required", code: "session_invalid" }, 400);
          }

          const session = await services.validateSession(sessionId);

          if (!session) {
            return error({ message: "Invalid session", code: "session_invalid" }, 401);
          }

          if (session.user.role === "admin") {
            await services.updateUserRole(userId, role);
            return json({ success: true });
          } else {
            return error({ message: "Unauthorized", code: "permission_denied" }, 401);
          }
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
        handler: async ({ input }, { json, error }) => {
          const { email, password } = await input.valid();

          // Check if user already exists
          const existingUser = await services.getUserByEmail(email);
          if (existingUser) {
            return error({ message: "Email already exists", code: "email_already_exists" }, 400);
          }

          // Create user
          const user = await services.createUser(email, password);
          // Create session
          const session = await services.createSession(user.id);

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
        handler: async ({ input }, { json, error }) => {
          let email: string;
          let password: string;
          try {
            ({ email, password } = await input.valid());
          } catch (error) {
            if (error instanceof FragnoApiValidationError) {
              console.log("validation failed", { issues: error.issues });
            }

            throw error;
          }

          // Get user by email
          const user = await services.getUserByEmail(email);
          if (!user) {
            return error({ message: "Invalid credentials", code: "invalid_credentials" }, 401);
          }

          // Verify password
          const isValid = await verifyPassword(password, user.passwordHash);
          if (!isValid) {
            return error({ message: "Invalid credentials", code: "invalid_credentials" }, 401);
          }

          // Create session
          const session = await services.createSession(user.id);

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
        handler: async ({ input, headers, query }, { json, error }) => {
          const { newPassword } = await input.valid();

          const sessionId = extractSessionId(headers, query.get("sessionId"));

          if (!sessionId) {
            return error({ message: "Session ID required", code: "session_invalid" }, 400);
          }

          const session = await services.validateSession(sessionId);

          if (!session) {
            return error({ message: "Invalid session", code: "session_invalid" }, 401);
          }

          await services.updateUserPassword(session.user.id, newPassword);

          return json({ success: true });
        },
      }),
    ];
  },
);
