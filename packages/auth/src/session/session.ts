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
          userId: z.string(),
          email: z.string(),
          role: z.enum(["user", "admin"]),
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
