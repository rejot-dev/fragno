import { defineFragment } from "@fragno-dev/core";
import { withDatabase } from "@fragno-dev/db";

import type { McpFragmentConfig } from "./mcp-types";
import { mcpSchema } from "./schema";
import {
  createOAuthCallbackSnapshot,
  createOAuthStartSnapshot,
  defaultOAuthRedirectUri,
  resolveMcpOperationAuth,
  tokenExpiry,
} from "./services";

export const mcpFragmentDefinition = defineFragment<McpFragmentConfig>("mcp-fragment")
  .extend(withDatabase(mcpSchema))
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
              ),
          )
          .transformRetrieve(async ([state, server, secrets]) => {
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
            return { found: true as const, server, secrets, changes };
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
              ),
          )
          .transformRetrieve(async ([server, secrets]) => {
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
              authChanges: resolved.authChanges,
            };
          })
          .mutate(({ uow, retrieveResult }) => {
            if (!retrieveResult.found) {
              return { found: false as const };
            }
            const authChanges = retrieveResult.authChanges;
            if (!authChanges) {
              return { found: true as const };
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

            if (authChanges.clientInformationPayload) {
              upsertSecret("oauth-client", authChanges.clientInformationPayload, null);
            }
            if (authChanges.discoveryStatePayload) {
              upsertSecret("oauth-discovery", authChanges.discoveryStatePayload, null);
            }
            if (authChanges.authPayload) {
              upsertSecret("auth", authChanges.authPayload, authChanges.authExpiresAt ?? null);
            }

            return { found: true as const };
          })
          .transform(({ retrieveResult }) =>
            retrieveResult.found
              ? {
                  found: true as const,
                  endpointUrl: retrieveResult.endpointUrl,
                  token: retrieveResult.token,
                }
              : { found: false as const },
          )
          .build();
      },
    }),
  )
  .build();
