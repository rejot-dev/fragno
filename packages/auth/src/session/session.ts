import { defineRoute, defineRoutes } from "@fragno-dev/core";
import type { SimpleQueryInterface } from "@fragno-dev/db/query";
import { authSchema } from "../schema";
import { z } from "zod";
import {
  buildClearCookieHeader,
  buildSetCookieHeader,
  extractSessionId,
  type CookieOptions,
} from "../utils/cookie";
import type { Role, authFragmentDefinition } from "..";

export function createSessionServices(
  orm: SimpleQueryInterface<typeof authSchema>,
  cookieOptions?: CookieOptions,
) {
  const services = {
    buildSessionCookie: (sessionId: string): string => {
      return buildSetCookieHeader(sessionId, cookieOptions);
    },
    createSession: async (userId: string) => {
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 30); // 30 days from now

      const id = await orm.create("session", {
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
      const session = await orm.findFirst("session", (b) =>
        b
          .whereIndex("primary", (eb) => eb("id", "=", sessionId))
          .join((j) => j.sessionOwner((b) => b.select(["id", "email", "role"]))),
      );

      if (!session) {
        return null;
      }

      // Check if session has expired
      if (session.expiresAt < new Date()) {
        await orm.delete("session", session.id);
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
    },
    invalidateSession: async (sessionId: string) => {
      const session = await orm.findFirst("session", (b) =>
        b.whereIndex("primary", (eb) => eb("id", "=", sessionId)),
      );

      if (!session) {
        return false;
      }

      await orm.delete("session", session.id);
      return true;
    },
    getSession: async (
      headers: Headers,
    ): Promise<{ userId: string; email: string } | undefined> => {
      const sessionId = extractSessionId(headers);

      if (!sessionId) {
        return undefined;
      }

      const session = await services.validateSession(sessionId);

      if (!session) {
        return undefined;
      }

      return {
        userId: session.user.id,
        email: session.user.email,
      };
    },
  };
  return services;
}

export const sessionRoutesFactory = defineRoutes<typeof authFragmentDefinition>().create(
  ({ services }) => {
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
        handler: async ({ input, headers }, { json, error }) => {
          const body = await input.valid();

          // Extract session ID from cookies first, then body
          const sessionId = extractSessionId(headers, null, body?.sessionId);

          if (!sessionId) {
            return error({ message: "Session ID required", code: "session_not_found" }, 400);
          }

          const success = await services.invalidateSession(sessionId);

          // Build response with clear cookie header
          const clearCookieHeader = buildClearCookieHeader();

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
          userId: z.string(),
          email: z.string(),
          role: z.enum(["user", "admin"]),
        }),
        errorCodes: ["session_invalid"],
        handler: async ({ query, headers }, { json, error }) => {
          // Extract session ID from cookies first, then query params
          const sessionId = extractSessionId(headers, query.get("sessionId"));

          if (!sessionId) {
            return error({ message: "Session ID required", code: "session_invalid" }, 400);
          }

          const session = await services.validateSession(sessionId);

          if (!session) {
            return error({ message: "Invalid session", code: "session_invalid" }, 401);
          }

          return json({
            userId: session.user.id,
            email: session.user.email,
            role: session.user.role as Role,
          });
        },
      }),
    ];
  },
);
