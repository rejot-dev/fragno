import { defineFragment, defineRoutes, instantiate } from "@fragno-dev/core";
import { createClientBuilder, type FragnoPublicClientConfig } from "@fragno-dev/core/client";
import type { FragnoPublicConfigWithDatabase } from "@fragno-dev/db";
import { withDatabase } from "@fragno-dev/db/fragment-definition-builder";
import { authSchema } from "./schema";
import { z } from "zod";

export interface AuthConfig {
  sendEmail?: (params: { to: string; subject: string; body: string }) => Promise<void>;
}

// Password hashing utilities using WebCrypto
async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iterations = 100000;

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );

  const hashBuffer = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt,
      iterations: iterations,
      hash: "SHA-256",
    },
    keyMaterial,
    256,
  );

  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const saltArray = Array.from(salt);

  return `${saltArray.map((b) => b.toString(16).padStart(2, "0")).join("")}:${iterations}:${hashArray.map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [saltHex, iterationsStr, hashHex] = storedHash.split(":");
  const iterations = parseInt(iterationsStr, 10);

  const salt = new Uint8Array(saltHex.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16)));
  const storedHashBytes = new Uint8Array(
    hashHex.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16)),
  );

  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );

  const hashBuffer = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt,
      iterations: iterations,
      hash: "SHA-256",
    },
    keyMaterial,
    256,
  );

  const hashArray = new Uint8Array(hashBuffer);

  if (hashArray.length !== storedHashBytes.length) {
    return false;
  }

  let isEqual = true;
  for (let i = 0; i < hashArray.length; i++) {
    if (hashArray[i] !== storedHashBytes[i]) {
      isEqual = false;
    }
  }
  return isEqual;
}

export const authFragmentDef = defineFragment<AuthConfig>("simple-auth")
  .extend(withDatabase(authSchema))
  .withDependencies(({ db }) => ({ db }))
  .providesBaseService(({ deps }) => {
    // db is already an ORM instance for the fragment's schema
    return {
      createUser: async (email: string, password: string) => {
        const passwordHash = await hashPassword(password);
        const id = await deps.db.create("user", {
          email,
          passwordHash,
        });
        return {
          id: id.valueOf(),
          email,
        };
      },
      getUserByEmail: async (email: string) => {
        const users = await deps.db.findFirst("user", (b) =>
          b.whereIndex("idx_user_email", (eb) => eb("email", "=", email)),
        );
        return users
          ? {
              id: users.id.valueOf(),
              email: users.email,
              passwordHash: users.passwordHash,
            }
          : null;
      },
      createSession: async (userId: string) => {
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 30); // 30 days from now

        const id = await deps.db.create("session", {
          userId,
          expiresAt,
        });

        return {
          id: id.valueOf(),
          userId,
          expiresAt,
        };
      },
      validateSession: async (sessionId: string) => {
        const session = await deps.db.findFirst("session", (b) =>
          b
            .whereIndex("primary", (eb) => eb("id", "=", sessionId))
            .join((j) => j.sessionOwner((b) => b.select(["id", "email"]))),
        );

        if (!session) {
          return null;
        }

        // Check if session has expired
        if (session.expiresAt < new Date()) {
          await deps.db.delete("session", session.id);
          return null;
        }

        if (!session.sessionOwner) {
          return null;
        }

        return {
          id: session.id.toJSON(),
          userId: session.userId,
          user: {
            id: session.sessionOwner.id.valueOf(),
            email: session.sessionOwner.email,
          },
        };
      },
      invalidateSession: async (sessionId: string) => {
        const session = await deps.db.findFirst("session", (b) =>
          b.whereIndex("primary", (eb) => eb("id", "=", sessionId)),
        );

        if (!session) {
          return false;
        }

        await deps.db.delete("session", session.id);
        return true;
      },
    };
  })
  .build();

export const routesFactory = defineRoutes(authFragmentDef).create(({ services, defineRoute }) => [
  defineRoute({
    method: "POST",
    path: "/sign-up",
    inputSchema: z.object({
      email: z.string().email(),
      password: z.string().min(8).max(100),
    }),
    outputSchema: z.object({
      sessionId: z.string(),
      userId: z.string(),
      email: z.string(),
    }),
    errorCodes: ["email_already_exists", "invalid_input"] as const,
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

      return json({
        sessionId: session.id,
        userId: user.id,
        email: user.email,
      });
    },
  }),
  defineRoute({
    method: "POST",
    path: "/sign-in",
    inputSchema: z.object({
      email: z.string().email(),
      password: z.string().min(8).max(100),
    }),
    outputSchema: z.object({
      sessionId: z.string(),
      userId: z.string(),
      email: z.string(),
    }),
    errorCodes: ["invalid_credentials"] as const,
    handler: async ({ input }, { json, error }) => {
      const { email, password } = await input.valid();

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

      return json({
        sessionId: session.id,
        userId: user.id,
        email: user.email,
      });
    },
  }),
  defineRoute({
    method: "POST",
    path: "/sign-out",
    inputSchema: z.object({
      sessionId: z.string(),
    }),
    outputSchema: z.object({
      success: z.boolean(),
    }),
    errorCodes: ["session_not_found"] as const,
    handler: async ({ input }, { json, error }) => {
      const { sessionId } = await input.valid();

      const success = await services.invalidateSession(sessionId);

      if (!success) {
        return error({ message: "Session not found", code: "session_not_found" }, 404);
      }

      return json({ success: true });
    },
  }),
  defineRoute({
    method: "GET",
    path: "/me",
    queryParameters: ["sessionId"] as const,
    outputSchema: z
      .object({
        userId: z.string(),
        email: z.string(),
      })
      .nullable(),
    errorCodes: ["session_invalid"] as const,
    handler: async ({ query }, { json, error }) => {
      const sessionId = query.get("sessionId");

      if (!sessionId) {
        return error({ message: "Session ID required", code: "session_invalid" }, 400);
      }

      const session = await services.validateSession(sessionId);

      if (!session) {
        return error({ message: "Session ID required", code: "session_invalid" }, 400);
      }

      return json({
        userId: session.user.id,
        email: session.user.email,
      });
    },
  }),
]);

export const routes = [routesFactory] as const;

export function createAuthFragment(
  config: AuthConfig = {},
  fragnoConfig: FragnoPublicConfigWithDatabase,
) {
  return instantiate(authFragmentDef)
    .withConfig(config)
    .withRoutes(routes)
    .withOptions(fragnoConfig)
    .build();
}

export function createAuthFragmentClients(fragnoConfig: FragnoPublicClientConfig) {
  const b = createClientBuilder(authFragmentDef, fragnoConfig, routes);

  return {
    useSignUp: b.createMutator("POST", "/sign-up"),
    useSignIn: b.createMutator("POST", "/sign-in"),
    useSignOut: b.createMutator("POST", "/sign-out"),
    useMe: b.createHook("/me"),
  };
}

export type { FragnoRouteConfig } from "@fragno-dev/core";
