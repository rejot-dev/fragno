import { defineFragment } from "@fragno-dev/core";
import { withDatabase, type HookFn } from "@fragno-dev/db";

import { listMcpTools } from "./mcp-api";
import type { McpFragmentConfig as BaseMcpFragmentConfig } from "./mcp-types";
import { mcpSchema } from "./schema";
import {
  createOAuthCallbackSnapshot,
  createMcpOperationAuth,
  createOAuthStartSnapshot,
  defaultOAuthRedirectUri,
  resolveMcpOperationAuth,
  tokenExpiry,
  type AuthPersistenceChanges,
} from "./services";

export interface McpServerConfigurationChangedPayload {
  serverId: string;
  current: {
    tools: unknown[];
  };
}

export interface McpServerConfigurationDeletedPayload {
  serverId: string;
}

export interface McpFragmentHooksConfig {
  onServerConfigurationChanged?: (
    payload: McpServerConfigurationChangedPayload,
    idempotencyKey: string,
  ) => Promise<void> | void;
  onServerConfigurationDeleted?: (
    payload: McpServerConfigurationDeletedPayload,
    idempotencyKey: string,
  ) => Promise<void> | void;
}

export type McpFragmentConfig = BaseMcpFragmentConfig & McpFragmentHooksConfig;

export interface McpInternalRefreshServerConfigurationPayload {
  serverId: string;
}

export type McpHooksMap = {
  internalRefreshServerConfiguration: HookFn<McpInternalRefreshServerConfigurationPayload>;
  onServerConfigurationChanged: HookFn<McpServerConfigurationChangedPayload>;
  onServerConfigurationDeleted: HookFn<McpServerConfigurationDeletedPayload>;
};

export const mcpFragmentDefinition = defineFragment<McpFragmentConfig>("mcp-fragment")
  .extend(withDatabase(mcpSchema))
  .provideHooks<McpHooksMap>(({ defineHook, config }) => ({
    internalRefreshServerConfiguration: defineHook(async function ({ serverId }) {
      let prepared:
        | {
            authChanges?: AuthPersistenceChanges;
            toolsOperation: Awaited<ReturnType<typeof listMcpTools<AuthPersistenceChanges>>>;
          }
        | undefined;

      const result = await this.handlerTx()
        .retrieve(({ forSchema }) =>
          forSchema(mcpSchema)
            .findFirst("server_configuration", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", serverId)),
            )
            .find("secret", (b) =>
              b.whereIndex("idx_secret_server_kind", (eb) => eb("serverId", "=", serverId)),
            )
            .findFirst("server_connection_cache", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", serverId)),
            ),
        )
        .afterRetrieve(async (_uow, [server, secrets]) => {
          if (!server) {
            return;
          }

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
        })
        .mutate(({ forSchema, retrieveResult: [server, secrets, cache] }) => {
          if (!server) {
            return { action: "missing" as const };
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

          if (!preparedOperation.toolsOperation.ok) {
            return {
              action: "error" as const,
              error:
                preparedOperation.toolsOperation.error instanceof Error
                  ? preparedOperation.toolsOperation.error.message
                  : String(preparedOperation.toolsOperation.error),
            };
          }

          const tools = Array.isArray(preparedOperation.toolsOperation.result.tools)
            ? preparedOperation.toolsOperation.result.tools
            : [];
          const previousTools = Array.isArray(cache?.tools) ? cache.tools : null;
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

          return { action: "refreshed" as const };
        })
        .execute();

      if (result.action === "error") {
        throw new Error(result.error);
      }
    }),
    onServerConfigurationChanged: defineHook(async function (payload) {
      await config.onServerConfigurationChanged?.(payload, this.idempotencyKey);
    }),
    onServerConfigurationDeleted: defineHook(async function (payload) {
      await config.onServerConfigurationDeleted?.(payload, this.idempotencyKey);
    }),
  }))
  .providesBaseService(({ defineService, config }) =>
    defineService({
      startOAuth: function (input: {
        serverId: string;
        stateId: string;
        scope?: string;
        clientId?: string;
        clientSecret?: string;
      }) {
        const redirectUri = defaultOAuthRedirectUri(config);
        return this.serviceTx(mcpSchema)
          .retrieve((uow) =>
            uow
              .findFirst("server_configuration", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", input.serverId)),
              )
              .find("secret", (b) =>
                b.whereIndex("idx_secret_server_kind", (eb) => eb("serverId", "=", input.serverId)),
              ),
          )
          .transformRetrieve(async ([server, secrets]) => {
            if (!server) {
              return { found: false as const };
            }
            const { authorizationUrl, changes } = await createOAuthStartSnapshot({
              config,
              server,
              secrets,
              stateId: input.stateId,
              redirectUri,
              scope: input.scope,
              clientId: input.clientId,
              clientSecret: input.clientSecret,
            });
            return {
              found: true as const,
              authorizationUrl: authorizationUrl.toString(),
              serverId: server.id.toString(),
              secrets,
              changes,
            };
          })
          .mutate(({ uow, retrieveResult }) => {
            if (!retrieveResult.found) {
              return { found: false as const };
            }

            const upsertSecret = (kind: string, payload: string, expiresAt: Date | null) => {
              const existing = retrieveResult.secrets.find((secret) => secret.kind === kind);
              if (existing) {
                uow.update("secret", existing.id, (b) =>
                  b.set({ payload, expiresAt, updatedAt: b.now() }).check(),
                );
                return;
              }
              uow.create("secret", {
                id: `${retrieveResult.serverId}:${kind}`,
                serverId: retrieveResult.serverId,
                kind,
                payload,
                expiresAt,
              });
            };

            if (retrieveResult.changes.clientInformationPayload) {
              upsertSecret("oauth-client", retrieveResult.changes.clientInformationPayload, null);
            }
            if (retrieveResult.changes.discoveryStatePayload) {
              upsertSecret("oauth-discovery", retrieveResult.changes.discoveryStatePayload, null);
            }
            if (retrieveResult.changes.oauthState) {
              uow.create("oauthState", {
                id: retrieveResult.changes.oauthState.id,
                serverId: retrieveResult.serverId,
                codeVerifier: retrieveResult.changes.oauthState.codeVerifier,
                redirectUri: retrieveResult.changes.oauthState.redirectUri,
                scope: retrieveResult.changes.oauthState.scope ?? null,
                expiresAt: retrieveResult.changes.oauthState.expiresAt,
                consumedAt: null,
              });
            }

            return { found: true as const };
          })
          .transform(({ retrieveResult }) =>
            retrieveResult.found
              ? {
                  found: true as const,
                  authorizationUrl: retrieveResult.authorizationUrl,
                }
              : { found: false as const },
          )
          .build();
      },

      completeOAuthCallback: function (input: { stateId: string; code: string }) {
        const serverId = input.stateId.split(":")[0] ?? "";
        return this.serviceTx(mcpSchema)
          .retrieve((uow) =>
            uow
              .findFirst("oauthState", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", input.stateId)),
              )
              .findFirst("server_configuration", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", serverId)),
              )
              .find("secret", (b) =>
                b.whereIndex("idx_secret_server_kind", (eb) => eb("serverId", "=", serverId)),
              )
              .findFirst("server_connection_cache", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", serverId)),
              ),
          )
          .transformRetrieve(async ([state, server, secrets, cache]) => {
            if (!state || state.consumedAt || new Date(state.expiresAt).getTime() < Date.now()) {
              return { found: false as const, reason: "invalid_state" as const };
            }
            if (!server) {
              return { found: false as const, reason: "server_not_found" as const };
            }
            const changes = await createOAuthCallbackSnapshot({
              config,
              stateId: input.stateId,
              code: input.code,
              state,
              server,
              secrets,
            });
            return { found: true as const, server, secrets, cache, changes };
          })
          .mutate(({ uow, retrieveResult }) => {
            if (!retrieveResult.found) {
              return { found: false as const, reason: retrieveResult.reason };
            }

            const serverId = retrieveResult.server.id.toString();
            const upsertSecret = (kind: string, payload: string, expiresAt: Date | null) => {
              const existing = retrieveResult.secrets.find((secret) => secret.kind === kind);
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

            if (retrieveResult.changes.clientInformationPayload) {
              upsertSecret("oauth-client", retrieveResult.changes.clientInformationPayload, null);
            }
            if (retrieveResult.changes.discoveryStatePayload) {
              upsertSecret("oauth-discovery", retrieveResult.changes.discoveryStatePayload, null);
            }
            if (retrieveResult.changes.tokens && retrieveResult.changes.tokensPayload) {
              upsertSecret(
                "auth",
                retrieveResult.changes.tokensPayload,
                tokenExpiry(retrieveResult.changes.tokens),
              );
              uow.update("server_configuration", retrieveResult.server.id, (b) =>
                b.set({ authMode: "oauth", updatedAt: b.now() }).check(),
              );
              if (retrieveResult.cache) {
                uow.delete("server_connection_cache", retrieveResult.cache.id);
              }
              uow.triggerHook("internalRefreshServerConfiguration", { serverId });
            }
            if (retrieveResult.changes.consumeStateId) {
              uow.update("oauthState", input.stateId, (b) => b.set({ consumedAt: b.now() }));
            }

            return { found: true as const };
          })
          .transform(({ retrieveResult }) =>
            retrieveResult.found
              ? { found: true as const }
              : { found: false as const, reason: retrieveResult.reason },
          )
          .build();
      },

      prepareMcpOperation: function (input: { serverId: string }) {
        return this.serviceTx(mcpSchema)
          .retrieve((uow) =>
            uow
              .findFirst("server_configuration", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", input.serverId)),
              )
              .find("secret", (b) =>
                b.whereIndex("idx_secret_server_kind", (eb) => eb("serverId", "=", input.serverId)),
              )
              .findFirst("server_connection_cache", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", input.serverId)),
              ),
          )
          .transformRetrieve(async ([server, secrets, cache]) => {
            if (!server) {
              return { found: false as const };
            }
            const resolved = await resolveMcpOperationAuth({ config, server, secrets });
            return {
              found: true as const,
              serverId: server.id.toString(),
              endpointUrl: server.endpointUrl,
              token: resolved.token,
              secrets,
              cache,
              authChanges: resolved.authChanges,
            };
          })
          .transform(({ retrieveResult }) =>
            retrieveResult.found
              ? {
                  found: true as const,
                  endpointUrl: retrieveResult.endpointUrl,
                  token: retrieveResult.token,
                  secrets: retrieveResult.secrets,
                  cache: retrieveResult.cache,
                  authChanges: retrieveResult.authChanges,
                  serverId: retrieveResult.serverId,
                }
              : { found: false as const },
          )
          .build();
      },
    }),
  )
  .build();
