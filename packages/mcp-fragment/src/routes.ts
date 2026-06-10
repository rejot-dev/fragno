import { z } from "zod";

import { defineRoutes } from "@fragno-dev/core";

import { mcpFragmentDefinition } from "./definition";
import {
  assertAllowedEndpoint,
  callMcpTool,
  parseSecretPayload,
  stringifySecretPayload,
  listMcpTools,
} from "./mcp-api";
import {
  createServerInputSchema,
  oauthStartInputSchema,
  tokenAuthInputSchema,
  toolCallInputSchema,
  type AuthConfig,
} from "./mcp-types";
import { mcpSchema } from "./schema";

const serverOutputSchema = z.object({
  slug: z.string(),
  name: z.string().nullable().optional(),
  endpointUrl: z.string(),
  authMode: z.string(),
});

const serversOutputSchema = z.object({ servers: z.array(serverOutputSchema) });
const authStatusSchema = z.object({ authenticated: z.boolean(), mode: z.string() });
const oauthStartOutputSchema = z.object({ authorizationUrl: z.string(), state: z.string() });
const oauthCallbackOutputSchema = z.object({ authenticated: z.boolean(), mode: z.string() });
const toolListSchema = z.object({ tools: z.array(z.unknown()) });
const toolResultSchema = z.record(z.string(), z.unknown());

function publicServer(server: {
  id: { toString(): string } | string;
  name?: string | null;
  endpointUrl: string;
  authMode: string;
}) {
  return {
    slug: server.id.toString(),
    name: server.name,
    endpointUrl: server.endpointUrl,
    authMode: server.authMode,
  };
}

function authMode(auth: AuthConfig) {
  return auth.type;
}

export const mcpRoutesFactory = defineRoutes(mcpFragmentDefinition).create(
  ({ services, defineRoute, config }) => {
    return [
      defineRoute({
        method: "POST",
        path: "/servers",
        inputSchema: createServerInputSchema,
        outputSchema: serverOutputSchema,
        errorCodes: ["SERVER_EXISTS", "ENDPOINT_NOT_ALLOWED"],
        handler: async function ({ input }, { json, error }) {
          const body = await input.valid();
          try {
            assertAllowedEndpoint(body.endpointUrl, config);
          } catch (err) {
            return error({ code: "ENDPOINT_NOT_ALLOWED", message: (err as Error).message }, 400);
          }

          const payload = body.auth.type === "none" ? undefined : stringifySecretPayload(body.auth);

          const result = await this.handlerTx()
            .retrieve(({ forSchema }) =>
              forSchema(mcpSchema).findFirst("server_configuration", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", body.slug)),
              ),
            )
            .mutate(({ forSchema, retrieveResult: [existing] }) => {
              if (existing) {
                return { exists: true as const };
              }

              const uow = forSchema(mcpSchema);
              uow.create("server_configuration", {
                id: body.slug,
                name: body.name ?? null,
                endpointUrl: body.endpointUrl,
                authMode: authMode(body.auth),
              });
              if (payload) {
                uow.create("secret", {
                  id: `${body.slug}:auth`,
                  serverId: body.slug,
                  kind: "auth",
                  payload,
                  expiresAt: null,
                });
              }
              return { exists: false as const };
            })
            .execute();

          if (result.exists) {
            return error({ code: "SERVER_EXISTS", message: "MCP server already exists" }, 409);
          }

          return json(publicServer({ ...body, id: body.slug, authMode: authMode(body.auth) }), 201);
        },
      }),

      defineRoute({
        method: "GET",
        path: "/servers",
        outputSchema: serversOutputSchema,
        handler: async function (_, { json }) {
          const [servers] = await this.handlerTx()
            .retrieve(({ forSchema }) =>
              forSchema(mcpSchema).find("server_configuration", (b) => b.whereIndex("primary")),
            )
            .execute();
          return json({ servers: servers.map(publicServer) });
        },
      }),

      defineRoute({
        method: "GET",
        path: "/servers/:slug",
        outputSchema: serverOutputSchema,
        errorCodes: ["SERVER_NOT_FOUND"],
        handler: async function ({ pathParams }, { json, error }) {
          const [server] = await this.handlerTx()
            .retrieve(({ forSchema }) =>
              forSchema(mcpSchema).findFirst("server_configuration", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", pathParams.slug)),
              ),
            )
            .execute();
          if (!server) {
            return error({ code: "SERVER_NOT_FOUND", message: "MCP server not found" }, 404);
          }
          return json(publicServer(server));
        },
      }),

      defineRoute({
        method: "DELETE",
        path: "/servers/:slug",
        errorCodes: ["SERVER_NOT_FOUND"],
        handler: async function ({ pathParams }, { empty, error }) {
          const result = await this.handlerTx()
            .retrieve(({ forSchema }) =>
              forSchema(mcpSchema)
                .findFirst("server_configuration", (b) =>
                  b.whereIndex("primary", (eb) => eb("id", "=", pathParams.slug)),
                )
                .find("secret", (b) =>
                  b.whereIndex("idx_secret_server_kind", (eb) =>
                    eb("serverId", "=", pathParams.slug),
                  ),
                )
                .find("oauthState", (b) =>
                  b.whereIndex("idx_oauth_state_server", (eb) =>
                    eb("serverId", "=", pathParams.slug),
                  ),
                ),
            )
            .mutate(({ forSchema, retrieveResult: [server, secrets, oauthStates] }) => {
              if (!server) {
                return { deleted: false as const };
              }
              const uow = forSchema(mcpSchema);
              for (const secret of secrets) {
                uow.delete("secret", secret.id);
              }
              for (const oauthState of oauthStates) {
                uow.delete("oauthState", oauthState.id);
              }
              uow.delete("server_configuration", server.id);
              return { deleted: true as const };
            })
            .execute();
          if (!result.deleted) {
            return error({ code: "SERVER_NOT_FOUND", message: "MCP server not found" }, 404);
          }
          return empty(204);
        },
      }),

      defineRoute({
        method: "GET",
        path: "/servers/:slug/auth/status",
        outputSchema: authStatusSchema,
        errorCodes: ["SERVER_NOT_FOUND"],
        handler: async function ({ pathParams }, { json, error }) {
          const [server, secret] = await this.handlerTx()
            .retrieve(({ forSchema }) =>
              forSchema(mcpSchema)
                .findFirst("server_configuration", (b) =>
                  b.whereIndex("primary", (eb) => eb("id", "=", pathParams.slug)),
                )
                .findFirst("secret", (b) =>
                  b.whereIndex("idx_secret_server_kind", (eb) =>
                    eb.and(eb("serverId", "=", pathParams.slug), eb("kind", "=", "auth")),
                  ),
                ),
            )
            .execute();
          if (!server) {
            return error({ code: "SERVER_NOT_FOUND", message: "MCP server not found" }, 404);
          }
          const auth = secret
            ? parseSecretPayload<{
                type: string;
                token?: string;
                tokens?: { access_token: string };
              }>(secret.payload)
            : undefined;
          return json({
            authenticated:
              server.authMode === "none" ||
              Boolean(auth?.token) ||
              Boolean(auth?.tokens?.access_token),
            mode: server.authMode,
          });
        },
      }),

      defineRoute({
        method: "POST",
        path: "/servers/:slug/auth/token",
        inputSchema: tokenAuthInputSchema,
        outputSchema: authStatusSchema,
        errorCodes: ["SERVER_NOT_FOUND"],
        handler: async function ({ input, pathParams }, { json, error }) {
          const { token } = await input.valid();
          const payload = stringifySecretPayload({ type: "bearer", token });
          const result = await this.handlerTx()
            .retrieve(({ forSchema }) =>
              forSchema(mcpSchema)
                .findFirst("server_configuration", (b) =>
                  b.whereIndex("primary", (eb) => eb("id", "=", pathParams.slug)),
                )
                .findFirst("secret", (b) =>
                  b.whereIndex("idx_secret_server_kind", (eb) =>
                    eb.and(eb("serverId", "=", pathParams.slug), eb("kind", "=", "auth")),
                  ),
                ),
            )
            .mutate(({ forSchema, retrieveResult: [server, secret] }) => {
              if (!server) {
                return { found: false as const };
              }
              const uow = forSchema(mcpSchema);
              uow.update("server_configuration", server.id, (b) =>
                b.set({ authMode: "bearer", updatedAt: b.now() }).check(),
              );
              if (secret) {
                uow.update("secret", secret.id, (b) =>
                  b.set({ payload, expiresAt: null, updatedAt: b.now() }).check(),
                );
              } else {
                uow.create("secret", {
                  id: `${pathParams.slug}:auth`,
                  serverId: pathParams.slug,
                  kind: "auth",
                  payload,
                  expiresAt: null,
                });
              }
              return { found: true as const };
            })
            .execute();
          if (!result.found) {
            return error({ code: "SERVER_NOT_FOUND", message: "MCP server not found" }, 404);
          }
          return json({ authenticated: true, mode: "bearer" });
        },
      }),

      defineRoute({
        method: "POST",
        path: "/servers/:slug/auth/start",
        inputSchema: oauthStartInputSchema,
        outputSchema: oauthStartOutputSchema,
        errorCodes: ["SERVER_NOT_FOUND", "OAUTH_ERROR"],
        handler: async function ({ input, pathParams }, { json, error }) {
          const body = await input.valid();
          const state = `${pathParams.slug}:${crypto.randomUUID()}`;
          try {
            const [result] = await this.handlerTx()
              .withServiceCalls(
                () =>
                  [
                    services.startOAuth({
                      serverId: pathParams.slug,
                      stateId: state,
                      scope: body.scope,
                      clientId: body.clientId,
                      clientSecret: body.clientSecret,
                    }),
                  ] as const,
              )
              .execute();
            if (!result.found) {
              return error({ code: "SERVER_NOT_FOUND", message: "MCP server not found" }, 404);
            }
            return json({ authorizationUrl: result.authorizationUrl, state });
          } catch (err) {
            return error({ code: "OAUTH_ERROR", message: (err as Error).message }, 502);
          }
        },
      }),

      defineRoute({
        method: "GET",
        path: "/oauth/callback",
        outputSchema: oauthCallbackOutputSchema,
        errorCodes: ["SERVER_NOT_FOUND", "OAUTH_ERROR", "INVALID_OAUTH_STATE"],
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
              if (result.reason === "server_not_found") {
                return error({ code: "SERVER_NOT_FOUND", message: "MCP server not found" }, 404);
              }
              return error({ code: "INVALID_OAUTH_STATE", message: "Invalid OAuth state" }, 400);
            }
            return json({ authenticated: true, mode: "oauth" });
          } catch (err) {
            return error({ code: "OAUTH_ERROR", message: (err as Error).message }, 502);
          }
        },
      }),

      defineRoute({
        method: "DELETE",
        path: "/servers/:slug/auth",
        errorCodes: ["SERVER_NOT_FOUND"],
        handler: async function ({ pathParams }, { json, error }) {
          const result = await this.handlerTx()
            .retrieve(({ forSchema }) =>
              forSchema(mcpSchema)
                .findFirst("server_configuration", (b) =>
                  b.whereIndex("primary", (eb) => eb("id", "=", pathParams.slug)),
                )
                .find("secret", (b) =>
                  b.whereIndex("idx_secret_server_kind", (eb) =>
                    eb("serverId", "=", pathParams.slug),
                  ),
                )
                .find("oauthState", (b) =>
                  b.whereIndex("idx_oauth_state_server", (eb) =>
                    eb("serverId", "=", pathParams.slug),
                  ),
                ),
            )
            .mutate(({ forSchema, retrieveResult: [server, secrets, oauthStates] }) => {
              if (!server) {
                return { found: false as const };
              }
              const uow = forSchema(mcpSchema);
              for (const secret of secrets) {
                uow.delete("secret", secret.id);
              }
              for (const oauthState of oauthStates) {
                uow.delete("oauthState", oauthState.id);
              }
              uow.update("server_configuration", server.id, (b) =>
                b.set({ authMode: "none", updatedAt: b.now() }).check(),
              );
              return { found: true as const };
            })
            .execute();
          if (!result.found) {
            return error({ code: "SERVER_NOT_FOUND", message: "MCP server not found" }, 404);
          }
          return json({ authenticated: true, mode: "none" });
        },
      }),

      defineRoute({
        method: "GET",
        path: "/servers/:slug/tools",
        outputSchema: toolListSchema,
        errorCodes: ["SERVER_NOT_FOUND", "MCP_ERROR"],
        handler: async function ({ pathParams }, { json, error }) {
          try {
            const [result] = await this.handlerTx()
              .withServiceCalls(
                () => [services.prepareMcpOperation({ serverId: pathParams.slug })] as const,
              )
              .execute();
            if (!result.found) {
              return error({ code: "SERVER_NOT_FOUND", message: "MCP server not found" }, 404);
            }
            const { result: toolsResult } = await listMcpTools({
              endpointUrl: result.endpointUrl,
              token: result.token,
              fetchImplementation: config.fetch,
            });
            return json({ tools: Array.isArray(toolsResult.tools) ? toolsResult.tools : [] });
          } catch (err) {
            return error({ code: "MCP_ERROR", message: (err as Error).message }, 502);
          }
        },
      }),

      defineRoute({
        method: "POST",
        path: "/servers/:slug/tool",
        inputSchema: toolCallInputSchema,
        outputSchema: toolResultSchema,
        errorCodes: ["SERVER_NOT_FOUND", "MCP_ERROR"],
        handler: async function ({ input, pathParams }, { json, error }) {
          const body = await input.valid();
          try {
            const [result] = await this.handlerTx()
              .withServiceCalls(
                () => [services.prepareMcpOperation({ serverId: pathParams.slug })] as const,
              )
              .execute();
            if (!result.found) {
              return error({ code: "SERVER_NOT_FOUND", message: "MCP server not found" }, 404);
            }
            const { result: toolResult } = await callMcpTool({
              endpointUrl: result.endpointUrl,
              token: result.token,
              name: body.name,
              toolArguments: body.arguments,
              timeoutMs: body.timeoutMs,
              fetchImplementation: config.fetch,
            });
            return json(toolResult);
          } catch (err) {
            return error({ code: "MCP_ERROR", message: (err as Error).message }, 502);
          }
        },
      }),
    ];
  },
);
