import { z } from "zod";

import { defineRoutes } from "@fragno-dev/core";

import { mcpFragmentDefinition } from "./definition";
import { buildAuthDiagnostics, errorMessage, refreshOutputSchema } from "./diagnostics";
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
import { createMcpOperationAuth, type AuthPersistenceChanges } from "./services";

const serverConnectionCacheOutputSchema = z.object({
  protocolVersion: z.string().nullable().optional(),
  serverInfo: z.unknown().nullable().optional(),
  capabilities: z.unknown().nullable().optional(),
  tools: z.array(z.unknown()).nullable().optional(),
  updatedAt: z.union([z.string(), z.date()]).optional(),
});

const serverOutputSchema = z.object({
  slug: z.string(),
  name: z.string().nullable().optional(),
  endpointUrl: z.string(),
  authMode: z.string(),
  cache: serverConnectionCacheOutputSchema.nullable().optional(),
});

const serversOutputSchema = z.object({ servers: z.array(serverOutputSchema) });
const authStatusSchema = z.object({ authenticated: z.boolean(), mode: z.string() });
const oauthStartOutputSchema = z.object({ authorizationUrl: z.string(), state: z.string() });
const oauthCallbackOutputSchema = z.object({ authenticated: z.boolean(), mode: z.string() });
const toolResultSchema = z.record(z.string(), z.unknown());

function publicServer(
  server: {
    id: { toString(): string } | string;
    name?: string | null;
    endpointUrl: string;
    authMode: string;
  },
  cache?: {
    protocolVersion?: string | null;
    serverInfo?: unknown;
    capabilities?: unknown;
    tools?: unknown;
    updatedAt?: Date;
  } | null,
) {
  return {
    slug: server.id.toString(),
    name: server.name,
    endpointUrl: server.endpointUrl,
    authMode: server.authMode,
    ...(cache
      ? {
          cache: {
            protocolVersion: cache.protocolVersion ?? null,
            serverInfo: cache.serverInfo ?? null,
            capabilities: cache.capabilities ?? null,
            tools: Array.isArray(cache.tools) ? cache.tools : null,
            updatedAt: cache.updatedAt,
          },
        }
      : {}),
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
              if (body.auth.type !== "oauth") {
                uow.triggerHook("internalRefreshServerConfiguration", { serverId: body.slug });
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
          const [servers, caches] = await this.handlerTx()
            .retrieve(({ forSchema }) =>
              forSchema(mcpSchema)
                .find("server_configuration", (b) => b.whereIndex("primary"))
                .find("server_connection_cache", (b) => b.whereIndex("primary")),
            )
            .execute();
          const cacheByServerId = new Map(caches.map((cache) => [cache.id.toString(), cache]));
          return json({
            servers: servers.map((server) =>
              publicServer(server, cacheByServerId.get(server.id.toString())),
            ),
          });
        },
      }),

      defineRoute({
        method: "GET",
        path: "/servers/:slug",
        outputSchema: serverOutputSchema,
        errorCodes: ["SERVER_NOT_FOUND"],
        handler: async function ({ pathParams }, { json, error }) {
          const [server, cache] = await this.handlerTx()
            .retrieve(({ forSchema }) =>
              forSchema(mcpSchema)
                .findFirst("server_configuration", (b) =>
                  b.whereIndex("primary", (eb) => eb("id", "=", pathParams.slug)),
                )
                .findFirst("server_connection_cache", (b) =>
                  b.whereIndex("primary", (eb) => eb("id", "=", pathParams.slug)),
                ),
            )
            .execute();
          if (!server) {
            return error({ code: "SERVER_NOT_FOUND", message: "MCP server not found" }, 404);
          }
          return json(publicServer(server, cache));
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
                )
                .findFirst("server_connection_cache", (b) =>
                  b.whereIndex("primary", (eb) => eb("id", "=", pathParams.slug)),
                ),
            )
            .mutate(({ forSchema, retrieveResult: [server, secrets, oauthStates, cache] }) => {
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
              if (cache) {
                uow.delete("server_connection_cache", cache.id);
              }
              uow.delete("server_configuration", server.id);
              uow.triggerHook("onServerConfigurationDeleted", { serverId: pathParams.slug });
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
                )
                .findFirst("server_connection_cache", (b) =>
                  b.whereIndex("primary", (eb) => eb("id", "=", pathParams.slug)),
                ),
            )
            .mutate(({ forSchema, retrieveResult: [server, secret, cache] }) => {
              if (!server) {
                return { found: false as const };
              }
              const uow = forSchema(mcpSchema);
              uow.update("server_configuration", server.id, (b) =>
                b.set({ authMode: "bearer", updatedAt: b.now() }).check(),
              );
              if (cache) {
                uow.delete("server_connection_cache", cache.id);
              }
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
              uow.triggerHook("internalRefreshServerConfiguration", { serverId: pathParams.slug });
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
                )
                .findFirst("server_connection_cache", (b) =>
                  b.whereIndex("primary", (eb) => eb("id", "=", pathParams.slug)),
                ),
            )
            .mutate(({ forSchema, retrieveResult: [server, secrets, oauthStates, cache] }) => {
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
              if (cache) {
                uow.delete("server_connection_cache", cache.id);
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
        method: "POST",
        path: "/servers/:slug/refresh",
        outputSchema: refreshOutputSchema,
        errorCodes: ["SERVER_NOT_FOUND"],
        handler: async function ({ pathParams }, { json, error }) {
          const checkedAt = new Date().toISOString();
          let prepared:
            | {
                authChanges?: AuthPersistenceChanges;
                toolsOperation: Awaited<ReturnType<typeof listMcpTools<AuthPersistenceChanges>>>;
              }
            | undefined;
          let authError: unknown;

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
                .findFirst("server_connection_cache", (b) =>
                  b.whereIndex("primary", (eb) => eb("id", "=", pathParams.slug)),
                )
                .find("oauthState", (b) =>
                  b.whereIndex("idx_oauth_state_server", (eb) =>
                    eb("serverId", "=", pathParams.slug),
                  ),
                ),
            )
            .afterRetrieve(async (_uow, [server, secrets]) => {
              if (!server) {
                return;
              }

              try {
                const auth = await createMcpOperationAuth({ config, server, secrets });
                const toolsOperation = await listMcpTools({
                  endpointUrl: server.endpointUrl,
                  auth,
                  fetchImplementation: config.fetch,
                });
                prepared = {
                  authChanges: toolsOperation.authChanges,
                  toolsOperation,
                };
              } catch (err) {
                authError = err;
              }
            })
            .mutate(({ forSchema, retrieveResult: [server, secrets, cache, oauthStates] }) => {
              if (!server) {
                return { found: false as const };
              }

              const serverId = server.id.toString();
              const previousTools = Array.isArray(cache?.tools) ? cache.tools : null;
              const baseDiagnostics = {
                checkedAt,
                server: publicServer(server),
                cache: {
                  presentBeforeCheck: Boolean(cache),
                  previousToolCount: previousTools?.length ?? null,
                  updatedToolCount: null,
                },
              };

              if (authError) {
                return {
                  found: true as const,
                  refresh: {
                    ...baseDiagnostics,
                    ok: false,
                    tools: [],
                    stage: "auth" as const,
                    auth: buildAuthDiagnostics({
                      mode: server.authMode,
                      secrets,
                      oauthStates,
                    }),
                    live: {
                      reachable: false,
                      listToolsOk: false,
                      toolCount: null,
                      protocolVersion: null,
                      serverInfo: null,
                      capabilities: null,
                    },
                    error: { code: "AUTH_ERROR", message: errorMessage(authError) },
                  },
                };
              }

              if (!prepared) {
                throw new Error("MCP refresh operation was not prepared");
              }

              const preparedOperation = prepared;
              const uow = forSchema(mcpSchema);
              const upsertSecret = (kind: string, payload: string, expiresAt: Date | null) => {
                const existing = secrets.find((secret) => secret.kind === kind);
                if (existing) {
                  uow.update("secret", existing.id, (b) =>
                    b.set({ payload, expiresAt, updatedAt: b.now() }).check(),
                  );
                  return;
                }
                uow.create("secret", {
                  id: `${serverId}:${kind}`,
                  serverId,
                  kind,
                  payload,
                  expiresAt,
                });
              };

              if (preparedOperation.authChanges?.clientInformationPayload) {
                upsertSecret(
                  "oauth-client",
                  preparedOperation.authChanges.clientInformationPayload,
                  null,
                );
              }
              if (preparedOperation.authChanges?.discoveryStatePayload) {
                upsertSecret(
                  "oauth-discovery",
                  preparedOperation.authChanges.discoveryStatePayload,
                  null,
                );
              }
              if (preparedOperation.authChanges?.authPayload) {
                upsertSecret(
                  "auth",
                  preparedOperation.authChanges.authPayload,
                  preparedOperation.authChanges.authExpiresAt ?? null,
                );
              }

              const auth = buildAuthDiagnostics({
                mode: server.authMode,
                secrets,
                oauthStates,
                authChanges: preparedOperation.authChanges,
              });

              if (!preparedOperation.toolsOperation.ok) {
                return {
                  found: true as const,
                  refresh: {
                    ...baseDiagnostics,
                    ok: false,
                    tools: [],
                    stage: "list_tools" as const,
                    auth,
                    live: {
                      reachable: false,
                      listToolsOk: false,
                      toolCount: null,
                      protocolVersion: null,
                      serverInfo: null,
                      capabilities: null,
                    },
                    error: {
                      code: "MCP_ERROR",
                      message: errorMessage(preparedOperation.toolsOperation.error),
                    },
                  },
                };
              }

              const tools = Array.isArray(preparedOperation.toolsOperation.result.tools)
                ? preparedOperation.toolsOperation.result.tools
                : [];
              if (!previousTools || JSON.stringify(previousTools) !== JSON.stringify(tools)) {
                uow.triggerHook("onServerConfigurationChanged", {
                  serverId,
                  current: { tools },
                });
              }
              uow.delete("server_connection_cache", serverId);
              uow.create("server_connection_cache", {
                id: serverId,
                serverId,
                protocolVersion: preparedOperation.toolsOperation.metadata.protocolVersion ?? null,
                serverInfo: preparedOperation.toolsOperation.metadata.serverInfo ?? null,
                capabilities: preparedOperation.toolsOperation.metadata.capabilities ?? null,
                tools,
              });

              return {
                found: true as const,
                refresh: {
                  ...baseDiagnostics,
                  ok: true,
                  tools,
                  stage: null,
                  auth,
                  live: {
                    reachable: true,
                    listToolsOk: true,
                    toolCount: tools.length,
                    protocolVersion:
                      preparedOperation.toolsOperation.metadata.protocolVersion ?? null,
                    serverInfo: preparedOperation.toolsOperation.metadata.serverInfo ?? null,
                    capabilities: preparedOperation.toolsOperation.metadata.capabilities ?? null,
                  },
                  cache: {
                    ...baseDiagnostics.cache,
                    updatedToolCount: tools.length,
                  },
                  error: null,
                },
              };
            })
            .execute();

          if (!result.found) {
            return error({ code: "SERVER_NOT_FOUND", message: "MCP server not found" }, 404);
          }

          return json(result.refresh);
        },
      }),

      defineRoute({
        method: "POST",
        path: "/servers/:slug/tools/execute",
        inputSchema: toolCallInputSchema,
        outputSchema: toolResultSchema,
        errorCodes: ["SERVER_NOT_FOUND", "MCP_ERROR"],
        handler: async function ({ input, pathParams }, { json, error }) {
          const body = await input.valid();
          try {
            let prepared:
              | {
                  serverId: string;
                  authChanges?: AuthPersistenceChanges;
                  toolOperation: Awaited<ReturnType<typeof callMcpTool<AuthPersistenceChanges>>>;
                }
              | undefined;

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
                  .findFirst("server_connection_cache", (b) =>
                    b.whereIndex("primary", (eb) => eb("id", "=", pathParams.slug)),
                  ),
              )
              .afterRetrieve(async (_uow, [server, secrets]) => {
                if (!server) {
                  return;
                }

                const auth = await createMcpOperationAuth({ config, server, secrets });
                const toolOperation = await callMcpTool({
                  endpointUrl: server.endpointUrl,
                  auth,
                  name: body.name,
                  toolArguments: body.arguments,
                  timeoutMs: body.timeoutMs,
                  fetchImplementation: config.fetch,
                });
                prepared = {
                  serverId: server.id.toString(),
                  authChanges: toolOperation.authChanges,
                  toolOperation,
                };
              })
              .mutate(({ forSchema, retrieveResult: [server, secrets, cache] }) => {
                if (!server) {
                  return { found: false as const };
                }
                if (!prepared) {
                  throw new Error("MCP operation was not prepared");
                }

                const preparedOperation = prepared;
                const uow = forSchema(mcpSchema);
                const upsertSecret = (kind: string, payload: string, expiresAt: Date | null) => {
                  const existing = secrets.find((secret) => secret.kind === kind);
                  if (existing) {
                    uow.update("secret", existing.id, (b) =>
                      b.set({ payload, expiresAt, updatedAt: b.now() }).check(),
                    );
                    return;
                  }
                  uow.create("secret", {
                    id: `${preparedOperation.serverId}:${kind}`,
                    serverId: preparedOperation.serverId,
                    kind,
                    payload,
                    expiresAt,
                  });
                };

                if (preparedOperation.authChanges?.clientInformationPayload) {
                  upsertSecret(
                    "oauth-client",
                    preparedOperation.authChanges.clientInformationPayload,
                    null,
                  );
                }
                if (preparedOperation.authChanges?.discoveryStatePayload) {
                  upsertSecret(
                    "oauth-discovery",
                    preparedOperation.authChanges.discoveryStatePayload,
                    null,
                  );
                }
                if (preparedOperation.authChanges?.authPayload) {
                  upsertSecret(
                    "auth",
                    preparedOperation.authChanges.authPayload,
                    preparedOperation.authChanges.authExpiresAt ?? null,
                  );
                }

                const toolOperation = preparedOperation.toolOperation;
                if (!toolOperation.ok) {
                  return {
                    found: true as const,
                    error:
                      toolOperation.error instanceof Error
                        ? toolOperation.error.message
                        : String(toolOperation.error),
                  };
                }

                if (cache) {
                  uow.update("server_connection_cache", cache.id, (b) =>
                    b
                      .set({
                        protocolVersion: toolOperation.metadata.protocolVersion ?? null,
                        serverInfo: toolOperation.metadata.serverInfo ?? null,
                        capabilities: toolOperation.metadata.capabilities ?? null,
                        updatedAt: b.now(),
                      })
                      .check(),
                  );
                } else {
                  uow.create("server_connection_cache", {
                    id: pathParams.slug,
                    serverId: pathParams.slug,
                    protocolVersion: toolOperation.metadata.protocolVersion ?? null,
                    serverInfo: toolOperation.metadata.serverInfo ?? null,
                    capabilities: toolOperation.metadata.capabilities ?? null,
                    tools: null,
                  });
                }
                return { found: true as const, result: toolOperation.result };
              })
              .execute();

            if (!result.found) {
              return error({ code: "SERVER_NOT_FOUND", message: "MCP server not found" }, 404);
            }
            if ("error" in result) {
              return error(
                { code: "MCP_ERROR", message: result.error ?? "MCP operation failed" },
                502,
              );
            }
            return json(result.result);
          } catch (err) {
            return error({ code: "MCP_ERROR", message: (err as Error).message }, 502);
          }
        },
      }),
    ];
  },
);
