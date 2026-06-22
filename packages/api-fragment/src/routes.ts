import { z } from "zod";

import { defineRoutes } from "@fragno-dev/core";

import {
  apiConnectionOutputSchema,
  apiRequestInputSchema,
  createApiConnectionInputSchema,
  oauthStartInputSchema,
  tokenAuthInputSchema,
} from "./api-types";
import { apiFragmentDefinition } from "./definition";
import { apiSchema } from "./schema";
import { assertAllowedBaseUrl, storedAuthPayloadSchema } from "./services";

const connectionsOutputSchema = z.object({ connections: z.array(apiConnectionOutputSchema) });
const authStatusSchema = z.object({
  authenticated: z.boolean(),
  mode: z.string(),
  tokenPresent: z.boolean().optional(),
  expiresAt: z.union([z.string(), z.date()]).nullable().optional(),
});
const oauthStartOutputSchema = z.object({ authorizationUrl: z.string(), state: z.string() });
const oauthCallbackOutputSchema = z.object({ authenticated: z.boolean(), mode: z.string() });
const requestOutputSchema = z.object({
  status: z.number(),
  statusText: z.string(),
  headers: z.record(z.string(), z.string()),
  body: z.unknown(),
});

const logApiRouteError = (message: string, err: unknown) => {
  const detail = err instanceof Error ? err.message : String(err);
  console.error(message, detail, err);
};

function publicConnection(connection: {
  id: { toString(): string } | string;
  name?: string | null;
  baseUrl: string;
  authMode: string;
  status: string;
  createdAt?: Date;
  updatedAt?: Date;
}) {
  return {
    slug: connection.id.toString(),
    name: connection.name ?? null,
    baseUrl: connection.baseUrl,
    authMode: connection.authMode,
    status: connection.status,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}

function connectionHookSnapshot(connection: {
  id: { toString(): string } | string;
  name?: string | null;
  baseUrl: string;
  authMode: string;
  status: string;
}) {
  return {
    slug: connection.id.toString(),
    name: connection.name ?? null,
    baseUrl: connection.baseUrl,
    authMode: connection.authMode,
    status: connection.status,
  };
}

export const apiRoutesFactory = defineRoutes(apiFragmentDefinition).create(
  ({ services, defineRoute, config }) => [
    defineRoute({
      method: "PUT",
      path: "/connections/:slug",
      inputSchema: createApiConnectionInputSchema,
      outputSchema: apiConnectionOutputSchema,
      errorCodes: ["CONNECTION_EXISTS", "BASE_URL_NOT_ALLOWED"],
      handler: async function ({ input, pathParams }, { json, error }) {
        const body = await input.valid();
        try {
          assertAllowedBaseUrl(body.baseUrl, config);
        } catch (err) {
          logApiRouteError("API connection base URL rejected", err);
          return error(
            { code: "BASE_URL_NOT_ALLOWED", message: "API base URL is not allowed" },
            400,
          );
        }

        const payload = body.auth.type === "none" ? undefined : JSON.stringify(body.auth);
        const result = await this.handlerTx()
          .retrieve(({ forSchema }) =>
            forSchema(apiSchema).findFirst("api_connection", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", pathParams.slug)),
            ),
          )
          .mutate(({ forSchema, retrieveResult: [existing] }) => {
            if (existing) {
              return { exists: true as const };
            }
            const uow = forSchema(apiSchema);
            uow.create("api_connection", {
              id: pathParams.slug,
              name: body.name ?? null,
              baseUrl: body.baseUrl,
              authMode: body.auth.type,
              status: "active",
            });
            if (payload) {
              uow.create("secret", {
                id: `${pathParams.slug}:auth`,
                connectionId: pathParams.slug,
                kind: "auth",
                payload,
                expiresAt: null,
              });
            }
            uow.triggerHook("onConnectionChanged", {
              connectionId: pathParams.slug,
              connection: connectionHookSnapshot({
                id: pathParams.slug,
                name: body.name ?? null,
                baseUrl: body.baseUrl,
                authMode: body.auth.type,
                status: "active",
              }),
            });
            return { exists: false as const };
          })
          .execute();

        if (result.exists) {
          return error(
            { code: "CONNECTION_EXISTS", message: "API connection already exists" },
            409,
          );
        }
        return json(
          publicConnection({
            id: pathParams.slug,
            name: body.name ?? null,
            baseUrl: body.baseUrl,
            authMode: body.auth.type,
            status: "active",
          }),
          201,
        );
      },
    }),

    defineRoute({
      method: "GET",
      path: "/connections",
      outputSchema: connectionsOutputSchema,
      handler: async function (_, { json }) {
        const [connections] = await this.handlerTx()
          .retrieve(({ forSchema }) =>
            forSchema(apiSchema).find("api_connection", (b) => b.whereIndex("primary")),
          )
          .execute();
        return json({ connections: connections.map(publicConnection) });
      },
    }),

    defineRoute({
      method: "GET",
      path: "/connections/:slug",
      outputSchema: apiConnectionOutputSchema,
      errorCodes: ["CONNECTION_NOT_FOUND"],
      handler: async function ({ pathParams }, { json, error }) {
        const [connection] = await this.handlerTx()
          .retrieve(({ forSchema }) =>
            forSchema(apiSchema).findFirst("api_connection", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", pathParams.slug)),
            ),
          )
          .execute();
        if (!connection) {
          return error({ code: "CONNECTION_NOT_FOUND", message: "API connection not found" }, 404);
        }
        return json(publicConnection(connection));
      },
    }),

    defineRoute({
      method: "DELETE",
      path: "/connections/:slug",
      errorCodes: ["CONNECTION_NOT_FOUND"],
      handler: async function ({ pathParams }, { empty, error }) {
        const result = await this.handlerTx()
          .retrieve(({ forSchema }) =>
            forSchema(apiSchema)
              .findFirst("api_connection", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", pathParams.slug)),
              )
              .find("secret", (b) =>
                b.whereIndex("idx_secret_connection_kind", (eb) =>
                  eb("connectionId", "=", pathParams.slug),
                ),
              )
              .find("oauthState", (b) =>
                b.whereIndex("idx_oauth_state_connection", (eb) =>
                  eb("connectionId", "=", pathParams.slug),
                ),
              ),
          )
          .mutate(({ forSchema, retrieveResult: [connection, secrets, states] }) => {
            if (!connection) {
              return { deleted: false as const };
            }
            const uow = forSchema(apiSchema);
            for (const secret of secrets) {
              uow.delete("secret", secret.id);
            }
            for (const state of states) {
              uow.delete("oauthState", state.id);
            }
            uow.delete("api_connection", connection.id);
            uow.triggerHook("onConnectionDeleted", {
              connectionId: pathParams.slug,
              previous: connectionHookSnapshot(connection),
            });
            return { deleted: true as const };
          })
          .execute();
        if (!result.deleted) {
          return error({ code: "CONNECTION_NOT_FOUND", message: "API connection not found" }, 404);
        }
        return empty(204);
      },
    }),

    defineRoute({
      method: "GET",
      path: "/connections/:slug/auth/status",
      outputSchema: authStatusSchema,
      errorCodes: ["CONNECTION_NOT_FOUND"],
      handler: async function ({ pathParams }, { json, error }) {
        const [connection, secret] = await this.handlerTx()
          .retrieve(({ forSchema }) =>
            forSchema(apiSchema)
              .findFirst("api_connection", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", pathParams.slug)),
              )
              .findFirst("secret", (b) =>
                b.whereIndex("idx_secret_connection_kind", (eb) =>
                  eb.and(eb("connectionId", "=", pathParams.slug), eb("kind", "=", "auth")),
                ),
              ),
          )
          .execute();
        if (!connection) {
          return error({ code: "CONNECTION_NOT_FOUND", message: "API connection not found" }, 404);
        }
        const auth = secret ? storedAuthPayloadSchema.parse(JSON.parse(secret.payload)) : undefined;
        const tokenPresent = Boolean(
          auth?.type === "bearer" ? auth.token : auth?.tokens?.accessToken,
        );
        return json({
          authenticated: connection.authMode === "none" || tokenPresent,
          mode: connection.authMode,
          tokenPresent,
          expiresAt: secret?.expiresAt ?? null,
        });
      },
    }),

    defineRoute({
      method: "POST",
      path: "/connections/:slug/auth/token",
      inputSchema: tokenAuthInputSchema,
      outputSchema: authStatusSchema,
      errorCodes: ["CONNECTION_NOT_FOUND"],
      handler: async function ({ input, pathParams }, { json, error }) {
        const { token } = await input.valid();
        const payload = JSON.stringify({ type: "bearer", token });
        const result = await this.handlerTx()
          .retrieve(({ forSchema }) =>
            forSchema(apiSchema)
              .findFirst("api_connection", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", pathParams.slug)),
              )
              .findFirst("secret", (b) =>
                b.whereIndex("idx_secret_connection_kind", (eb) =>
                  eb.and(eb("connectionId", "=", pathParams.slug), eb("kind", "=", "auth")),
                ),
              ),
          )
          .mutate(({ forSchema, retrieveResult: [connection, secret] }) => {
            if (!connection) {
              return { found: false as const };
            }
            const uow = forSchema(apiSchema);
            uow.update("api_connection", connection.id, (b) =>
              b.set({ authMode: "bearer", updatedAt: b.now() }).check(),
            );
            if (secret) {
              uow.update("secret", secret.id, (b) =>
                b.set({ payload, expiresAt: null, updatedAt: b.now() }).check(),
              );
            } else {
              uow.create("secret", {
                id: `${pathParams.slug}:auth`,
                connectionId: pathParams.slug,
                kind: "auth",
                payload,
                expiresAt: null,
              });
            }
            const changedConnection = connectionHookSnapshot({
              ...connection,
              authMode: "bearer",
            });
            uow.triggerHook("onConnectionChanged", {
              connectionId: pathParams.slug,
              connection: changedConnection,
            });
            uow.triggerHook("onConnectionAvailable", {
              connectionId: pathParams.slug,
              connection: changedConnection,
              authMode: "bearer",
            });
            return { found: true as const };
          })
          .execute();
        if (!result.found) {
          return error({ code: "CONNECTION_NOT_FOUND", message: "API connection not found" }, 404);
        }
        return json({ authenticated: true, mode: "bearer", tokenPresent: true, expiresAt: null });
      },
    }),

    defineRoute({
      method: "POST",
      path: "/connections/:slug/auth/oauth/start",
      inputSchema: oauthStartInputSchema,
      outputSchema: oauthStartOutputSchema,
      errorCodes: ["CONNECTION_NOT_FOUND", "AUTH_NOT_CONFIGURED", "AUTH_NOT_OAUTH", "OAUTH_ERROR"],
      handler: async function ({ input, pathParams }, { json, error }) {
        const body = await input.valid();
        const state = `${pathParams.slug}:${crypto.randomUUID()}`;
        try {
          const [result] = await this.handlerTx()
            .withServiceCalls(
              () =>
                [
                  services.startOAuth({
                    connectionId: pathParams.slug,
                    stateId: state,
                    scopes: body.scopes,
                    extraAuthorizationParams: body.extraAuthorizationParams,
                  }),
                ] as const,
            )
            .execute();
          if (!result.found) {
            if (result.reason === "connection_not_found") {
              return error(
                { code: "CONNECTION_NOT_FOUND", message: "API connection not found" },
                404,
              );
            }
            if (result.reason === "auth_not_configured") {
              return error(
                { code: "AUTH_NOT_CONFIGURED", message: "API connection auth is not configured" },
                400,
              );
            }
            return error(
              { code: "AUTH_NOT_OAUTH", message: "API connection auth is not OAuth" },
              400,
            );
          }
          return json({ authorizationUrl: result.authorizationUrl, state });
        } catch (err) {
          logApiRouteError("API OAuth start failed", err);
          return error({ code: "OAUTH_ERROR", message: "An authentication error occurred" }, 502);
        }
      },
    }),

    defineRoute({
      method: "GET",
      path: "/oauth/callback",
      outputSchema: oauthCallbackOutputSchema,
      errorCodes: [
        "CONNECTION_NOT_FOUND",
        "AUTH_NOT_CONFIGURED",
        "AUTH_NOT_OAUTH",
        "OAUTH_ERROR",
        "INVALID_OAUTH_STATE",
      ],
      handler: async function ({ query }, { json, error }) {
        const code = query.get("code");
        const stateId = query.get("state");
        if (!code || !stateId) {
          return error(
            { code: "INVALID_OAUTH_STATE", message: "Missing OAuth code or state" },
            400,
          );
        }
        try {
          const [result] = await this.handlerTx()
            .withServiceCalls(() => [services.completeOAuthCallback({ stateId, code })] as const)
            .execute();
          if (!result.found) {
            if (result.reason === "connection_not_found") {
              return error(
                { code: "CONNECTION_NOT_FOUND", message: "API connection not found" },
                404,
              );
            }
            if (result.reason === "auth_not_configured") {
              return error(
                { code: "AUTH_NOT_CONFIGURED", message: "API connection auth is not configured" },
                400,
              );
            }
            if (result.reason === "auth_not_oauth") {
              return error(
                { code: "AUTH_NOT_OAUTH", message: "API connection auth is not OAuth" },
                400,
              );
            }
            return error({ code: "INVALID_OAUTH_STATE", message: "Invalid OAuth state" }, 400);
          }
          return json({ authenticated: true, mode: "oauth" });
        } catch (err) {
          logApiRouteError("API OAuth callback failed", err);
          return error({ code: "OAUTH_ERROR", message: "An authentication error occurred" }, 502);
        }
      },
    }),

    defineRoute({
      method: "DELETE",
      path: "/connections/:slug/auth",
      outputSchema: authStatusSchema,
      errorCodes: ["CONNECTION_NOT_FOUND"],
      handler: async function ({ pathParams }, { json, error }) {
        const result = await this.handlerTx()
          .retrieve(({ forSchema }) =>
            forSchema(apiSchema)
              .findFirst("api_connection", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", pathParams.slug)),
              )
              .find("secret", (b) =>
                b.whereIndex("idx_secret_connection_kind", (eb) =>
                  eb("connectionId", "=", pathParams.slug),
                ),
              )
              .find("oauthState", (b) =>
                b.whereIndex("idx_oauth_state_connection", (eb) =>
                  eb("connectionId", "=", pathParams.slug),
                ),
              ),
          )
          .mutate(({ forSchema, retrieveResult: [connection, secrets, states] }) => {
            if (!connection) {
              return { found: false as const };
            }
            const uow = forSchema(apiSchema);
            for (const secret of secrets) {
              uow.delete("secret", secret.id);
            }
            for (const state of states) {
              uow.delete("oauthState", state.id);
            }
            uow.update("api_connection", connection.id, (b) =>
              b.set({ authMode: "none", updatedAt: b.now() }).check(),
            );
            uow.triggerHook("onConnectionChanged", {
              connectionId: pathParams.slug,
              connection: connectionHookSnapshot({ ...connection, authMode: "none" }),
            });
            return { found: true as const };
          })
          .execute();
        if (!result.found) {
          return error({ code: "CONNECTION_NOT_FOUND", message: "API connection not found" }, 404);
        }
        return json({ authenticated: true, mode: "none", tokenPresent: false, expiresAt: null });
      },
    }),

    defineRoute({
      method: "POST",
      path: "/connections/:slug/request",
      inputSchema: apiRequestInputSchema,
      outputSchema: requestOutputSchema,
      errorCodes: ["CONNECTION_NOT_FOUND", "CONNECTION_DISABLED", "API_REQUEST_ERROR"],
      handler: async function ({ input, pathParams }, { json, error }) {
        const request = await input.valid();
        try {
          const [result] = await this.handlerTx()
            .withServiceCalls(
              () =>
                [services.executeApiRequest({ connectionId: pathParams.slug, request })] as const,
            )
            .execute();
          if (!result.found) {
            if (result.reason === "connection_disabled") {
              return error(
                { code: "CONNECTION_DISABLED", message: "API connection is disabled" },
                403,
              );
            }
            return error(
              { code: "CONNECTION_NOT_FOUND", message: "API connection not found" },
              404,
            );
          }
          return json(result.response);
        } catch (err) {
          logApiRouteError("API request failed", err);
          return error(
            { code: "API_REQUEST_ERROR", message: "An API request error occurred" },
            502,
          );
        }
      },
    }),
  ],
);
