import { defineFragment } from "@fragno-dev/core";
import { withDatabase, type HookFn } from "@fragno-dev/db";

import type { ApiFragmentConfig as BaseApiFragmentConfig } from "./api-types";
import type { ApiRequestInput } from "./api-types";
import { apiSchema } from "./schema";
import {
  createOAuthCallbackSnapshot,
  createOAuthStartSnapshot,
  defaultOAuthRedirectUri,
  performApiRequest,
  resolveApiOperationAuth,
  storedAuthPayloadSchema,
} from "./services";

export interface ApiConnectionHookSnapshot {
  slug: string;
  name: string | null;
  baseUrl: string;
  authMode: string;
  status: string;
}

export interface ApiConnectionChangedPayload {
  connectionId: string;
  connection: ApiConnectionHookSnapshot;
}

export interface ApiConnectionDeletedPayload {
  connectionId: string;
  previous: ApiConnectionHookSnapshot;
}

export interface ApiConnectionAvailablePayload {
  connectionId: string;
  connection: ApiConnectionHookSnapshot;
  authMode: string;
}

interface InternalWebhookReceivedPayload {
  endpointId: string;
  deliveryId: string;
  hookId: string;
  receivedAt: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  rawBody: string;
  body: Record<string, unknown>;
  contentType: string | null;
}

export interface WebhookReceivedPayload {
  endpointId: string;
  deliveryId: string;
  hookId: string;
  receivedAt: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  body: Record<string, unknown>;
  contentType: string | null;
}

export interface ApiHookContext {
  idempotencyKey: string;
  hookId: string;
}

export interface ApiFragmentHooksConfig {
  onConnectionChanged?: (
    payload: ApiConnectionChangedPayload,
    context: ApiHookContext,
  ) => Promise<void> | void;
  onConnectionDeleted?: (
    payload: ApiConnectionDeletedPayload,
    context: ApiHookContext,
  ) => Promise<void> | void;
  onConnectionAvailable?: (
    payload: ApiConnectionAvailablePayload,
    context: ApiHookContext,
  ) => Promise<void> | void;
  onWebhookReceived?: (payload: WebhookReceivedPayload) => Promise<void> | void;
}

export type ApiFragmentConfig = BaseApiFragmentConfig & ApiFragmentHooksConfig;

export type ApiHooksMap = {
  onConnectionChanged: HookFn<ApiConnectionChangedPayload>;
  onConnectionDeleted: HookFn<ApiConnectionDeletedPayload>;
  onConnectionAvailable: HookFn<ApiConnectionAvailablePayload>;
  onWebhookReceived: HookFn<InternalWebhookReceivedPayload>;
};

function connectionHookSnapshot(connection: {
  id: { toString(): string } | string;
  name?: string | null;
  baseUrl: string;
  authMode: string;
  status: string;
}): ApiConnectionHookSnapshot {
  return {
    slug: connection.id.toString(),
    name: connection.name ?? null,
    baseUrl: connection.baseUrl,
    authMode: connection.authMode,
    status: connection.status,
  };
}

export const apiFragmentDefinition = defineFragment<ApiFragmentConfig>("api-fragment")
  .extend(withDatabase(apiSchema))
  .provideHooks<ApiHooksMap>(({ defineHook, config }) => ({
    onConnectionChanged: defineHook(async function (payload) {
      await config.onConnectionChanged?.(payload, {
        idempotencyKey: this.idempotencyKey,
        hookId: this.hookId.toString(),
      });
    }),
    onConnectionDeleted: defineHook(async function (payload) {
      await config.onConnectionDeleted?.(payload, {
        idempotencyKey: this.idempotencyKey,
        hookId: this.hookId.toString(),
      });
    }),
    onConnectionAvailable: defineHook(async function (payload) {
      await config.onConnectionAvailable?.(payload, {
        idempotencyKey: this.idempotencyKey,
        hookId: this.hookId.toString(),
      });
    }),
    onWebhookReceived: defineHook(async function (payload) {
      await config.onWebhookReceived?.({
        endpointId: payload.endpointId,
        deliveryId: payload.deliveryId,
        hookId: payload.hookId,
        receivedAt: payload.receivedAt,
        headers: payload.headers,
        query: payload.query,
        body: payload.body,
        contentType: payload.contentType,
      });
    }),
  }))
  .providesBaseService(({ defineService, config }) =>
    defineService({
      startOAuth: function (input: {
        connectionId: string;
        stateId: string;
        scopes?: string[];
        extraAuthorizationParams?: Record<string, string>;
      }) {
        const redirectUri = defaultOAuthRedirectUri(config);
        return this.serviceTx(apiSchema)
          .retrieve((uow) =>
            uow
              .findFirst("api_connection", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", input.connectionId)),
              )
              .findFirst("secret", (b) =>
                b.whereIndex("idx_secret_connection_kind", (eb) =>
                  eb.and(eb("connectionId", "=", input.connectionId), eb("kind", "=", "auth")),
                ),
              ),
          )
          .transformRetrieve(async ([connection, secret]) => {
            if (!connection) {
              return { found: false as const, reason: "connection_not_found" as const };
            }
            if (!secret) {
              return { found: false as const, reason: "auth_not_configured" as const };
            }
            const auth = storedAuthPayloadSchema.parse(JSON.parse(secret.payload));
            if (auth.type !== "oauth") {
              return { found: false as const, reason: "auth_not_oauth" as const };
            }
            const snapshot = await createOAuthStartSnapshot({
              config,
              connection,
              auth,
              stateId: input.stateId,
              redirectUri,
              scopes: input.scopes,
              extraAuthorizationParams: input.extraAuthorizationParams,
            });
            return {
              found: true as const,
              authorizationUrl: snapshot.authorizationUrl.toString(),
              oauthState: snapshot.oauthState,
            };
          })
          .mutate(({ uow, retrieveResult }) => {
            if (!retrieveResult.found) {
              return retrieveResult;
            }
            uow.create("oauthState", {
              id: retrieveResult.oauthState.id,
              connectionId: retrieveResult.oauthState.connectionId,
              codeVerifier: retrieveResult.oauthState.codeVerifier,
              redirectUri: retrieveResult.oauthState.redirectUri,
              scope: retrieveResult.oauthState.scope,
              expiresAt: retrieveResult.oauthState.expiresAt,
              consumedAt: null,
            });
            return { found: true as const, authorizationUrl: retrieveResult.authorizationUrl };
          })
          .transform(({ retrieveResult }) => retrieveResult)
          .build();
      },

      completeOAuthCallback: function (input: { stateId: string; code: string }) {
        const stateConnectionSeparatorIndex = input.stateId.lastIndexOf(":");
        const connectionId =
          stateConnectionSeparatorIndex === -1
            ? ""
            : input.stateId.slice(0, stateConnectionSeparatorIndex);
        return this.serviceTx(apiSchema)
          .retrieve((uow) =>
            uow
              .findFirst("oauthState", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", input.stateId)),
              )
              .findFirst("api_connection", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", connectionId)),
              )
              .findFirst("secret", (b) =>
                b.whereIndex("idx_secret_connection_kind", (eb) =>
                  eb.and(eb("connectionId", "=", connectionId), eb("kind", "=", "auth")),
                ),
              ),
          )
          .transformRetrieve(async ([state, connection, secret]) => {
            if (!state || state.consumedAt || new Date(state.expiresAt).getTime() < Date.now()) {
              return { found: false as const, reason: "invalid_state" as const };
            }
            if (!connection) {
              return { found: false as const, reason: "connection_not_found" as const };
            }
            if (!secret) {
              return { found: false as const, reason: "auth_not_configured" as const };
            }
            const auth = storedAuthPayloadSchema.parse(JSON.parse(secret.payload));
            if (auth.type !== "oauth") {
              return { found: false as const, reason: "auth_not_oauth" as const };
            }
            const changes = await createOAuthCallbackSnapshot({
              config,
              stateId: input.stateId,
              code: input.code,
              state,
              auth,
            });
            return { found: true as const, connection, changes };
          })
          .mutate(({ uow, retrieveResult }) => {
            if (!retrieveResult.found) {
              return retrieveResult;
            }
            const connectionId = retrieveResult.connection.id.toString();
            if (retrieveResult.changes.authPayload) {
              uow.update("secret", `${connectionId}:auth`, (b) =>
                b.set({
                  payload: retrieveResult.changes.authPayload,
                  expiresAt: retrieveResult.changes.authExpiresAt ?? null,
                  updatedAt: b.now(),
                }),
              );
              uow.update("api_connection", retrieveResult.connection.id, (b) =>
                b.set({ authMode: "oauth", updatedAt: b.now() }).check(),
              );
              const connection = connectionHookSnapshot({
                ...retrieveResult.connection,
                authMode: "oauth",
              });
              uow.triggerHook("onConnectionChanged", { connectionId, connection });
              uow.triggerHook("onConnectionAvailable", {
                connectionId,
                connection,
                authMode: "oauth",
              });
            }
            uow.update("oauthState", input.stateId, (b) => b.set({ consumedAt: b.now() }));
            return { found: true as const };
          })
          .transform(({ retrieveResult }) => retrieveResult)
          .build();
      },

      executeApiRequest: function (input: { connectionId: string; request: ApiRequestInput }) {
        return this.serviceTx(apiSchema)
          .retrieve((uow) =>
            uow
              .findFirst("api_connection", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", input.connectionId)),
              )
              .find("secret", (b) =>
                b.whereIndex("idx_secret_connection_kind", (eb) =>
                  eb("connectionId", "=", input.connectionId),
                ),
              ),
          )
          .transformRetrieve(async ([connection, secrets]) => {
            if (!connection) {
              return { found: false as const };
            }
            if (connection.status !== "active") {
              return { found: false as const, reason: "connection_disabled" as const };
            }
            const resolved = await resolveApiOperationAuth({ config, secrets });
            const response = await performApiRequest({
              config,
              baseUrl: connection.baseUrl,
              token: resolved.token,
              request: input.request,
            });
            return {
              found: true as const,
              connection,
              secrets,
              authChanges: resolved.authChanges,
              response,
            };
          })
          .mutate(({ uow, retrieveResult }) => {
            if (!retrieveResult.found) {
              return retrieveResult;
            }
            const connectionId = retrieveResult.connection.id.toString();
            const authChanges = retrieveResult.authChanges;
            if (authChanges?.authPayload) {
              const existing = retrieveResult.secrets.find((secret) => secret.kind === "auth");
              if (existing) {
                uow.update("secret", existing.id, (b) =>
                  b
                    .set({
                      payload: authChanges.authPayload,
                      expiresAt: authChanges.authExpiresAt ?? null,
                      updatedAt: b.now(),
                    })
                    .check(),
                );
              } else {
                uow.create("secret", {
                  id: `${connectionId}:auth`,
                  connectionId,
                  kind: "auth",
                  payload: authChanges.authPayload,
                  expiresAt: authChanges.authExpiresAt ?? null,
                });
              }
              uow.triggerHook("onConnectionChanged", {
                connectionId,
                connection: connectionHookSnapshot(retrieveResult.connection),
              });
            }
            return { found: true as const, response: retrieveResult.response };
          })
          .transform(({ mutateResult }) => mutateResult)
          .build();
      },

      refreshClientCredentialsToken: function (input: { connectionId: string }) {
        return this.serviceTx(apiSchema)
          .retrieve((uow) =>
            uow
              .findFirst("api_connection", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", input.connectionId)),
              )
              .find("secret", (b) =>
                b.whereIndex("idx_secret_connection_kind", (eb) =>
                  eb("connectionId", "=", input.connectionId),
                ),
              ),
          )
          .transformRetrieve(async ([connection, secrets]) => {
            if (!connection) {
              return { found: false as const };
            }
            const resolved = await resolveApiOperationAuth({ config, secrets });
            return {
              found: true as const,
              connection,
              secrets,
              authChanges: resolved.authChanges,
              tokenPresent: Boolean(resolved.token),
            };
          })
          .mutate(({ uow, retrieveResult }) => {
            if (!retrieveResult.found) {
              return retrieveResult;
            }
            if (retrieveResult.authChanges?.authPayload) {
              const existing = retrieveResult.secrets.find((secret) => secret.kind === "auth");
              if (existing) {
                uow.update("secret", existing.id, (b) =>
                  b
                    .set({
                      payload: retrieveResult.authChanges!.authPayload!,
                      expiresAt: retrieveResult.authChanges!.authExpiresAt ?? null,
                      updatedAt: b.now(),
                    })
                    .check(),
                );
              }
              const connectionId = retrieveResult.connection.id.toString();
              const connection = connectionHookSnapshot(retrieveResult.connection);
              uow.triggerHook("onConnectionChanged", { connectionId, connection });
              uow.triggerHook("onConnectionAvailable", {
                connectionId,
                connection,
                authMode: retrieveResult.connection.authMode,
              });
            }
            return { found: true as const, tokenPresent: retrieveResult.tokenPresent };
          })
          .transform(({ mutateResult }) => mutateResult)
          .build();
      },
    }),
  )
  .build();
