import { z } from "zod";

import { defineRoutes } from "@fragno-dev/core";
import { isUniqueConstraintError } from "@fragno-dev/db";

import {
  apiConnectionOutputSchema,
  apiRequestInputSchema,
  createApiConnectionInputSchema,
  createWebhookEndpointInputSchema,
  oauthStartInputSchema,
  tokenAuthInputSchema,
  updateWebhookEndpointInputSchema,
  webhookEndpointOutputSchema,
  type WebhookDeliveryIdentity,
  type WebhookEndpoint,
  type WebhookEndpointAuthInput,
} from "./api-types";
import { sha256Base64Url } from "./crypto";
import { apiFragmentDefinition } from "./definition";
import { apiSchema } from "./schema";
import { assertAllowedBaseUrl, storedAuthPayloadSchema } from "./services";
import {
  getSensitiveWebhookAuthValues,
  getWebhookAuthSecretRefs,
  verifyWebhookAuth,
  type WebhookAuthConfig,
} from "./webhooks/auth";

const connectionsOutputSchema = z.object({ connections: z.array(apiConnectionOutputSchema) });
const webhookEndpointsOutputSchema = z.object({ endpoints: z.array(webhookEndpointOutputSchema) });
const webhookReceivedOutputSchema = z.object({ accepted: z.boolean() });
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

type WebhookSecretDraft = { ref: string; payload: string };

function webhookSecretId(endpointId: string, ref: string) {
  return `${endpointId}:${ref}`;
}

function webhookEndpointAuthStorage(auth: WebhookEndpointAuthInput): {
  authConfig: WebhookAuthConfig;
  secrets: WebhookSecretDraft[];
} {
  if (auth.type === "none") {
    return { authConfig: { type: "none" }, secrets: [] };
  }
  if (auth.type === "bearer") {
    return {
      authConfig: { type: "bearer", tokenRef: "token" },
      secrets: [{ ref: "token", payload: auth.token }],
    };
  }
  if (auth.type === "apiKey") {
    return {
      authConfig: {
        type: "apiKey",
        location: auth.location,
        name: auth.name,
        secretRef: "secret",
      },
      secrets: [{ ref: "secret", payload: auth.secret }],
    };
  }
  if (auth.type === "basic") {
    return {
      authConfig: { type: "basic", usernameRef: "username", passwordRef: "password" },
      secrets: [
        { ref: "username", payload: auth.username },
        { ref: "password", payload: auth.password },
      ],
    };
  }

  return {
    authConfig: {
      type: "hmac",
      secretRef: "secret",
      algorithm: auth.algorithm,
      signature: auth.signature,
      signedPayload: auth.signedPayload,
    },
    secrets: [{ ref: "secret", payload: auth.secret }],
  };
}

function parseWebhookEndpointStatus(status: string): "active" | "disabled" {
  if (status === "active" || status === "disabled") {
    return status;
  }
  throw new Error(`Unexpected webhook endpoint status: ${status}`);
}

function recordFromSearchParams(
  query: URLSearchParams,
  sensitiveQueryNames: ReadonlySet<string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of query.entries()) {
    result[name] = sensitiveQueryNames.has(name) ? "[redacted]" : value;
  }
  return result;
}

function recordFromHeaders(
  headers: Headers,
  sensitiveHeaderNames: ReadonlySet<string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of headers.entries()) {
    result[name] = sensitiveHeaderNames.has(name.toLowerCase()) ? "[redacted]" : value;
  }
  return result;
}

type WebhookJsonBodyResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; reason: "invalid_json" | "invalid_value" };

type WebhookDeliveryIdentityResult =
  | { ok: true; deliveryId: string }
  | { ok: false; reason: "missing" | "invalid_value" };

function parseWebhookJsonBody(rawBody: string | undefined): WebhookJsonBodyResult {
  let value: unknown;
  try {
    value = JSON.parse(rawBody ?? "");
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
  if (!isJsonObject(value)) {
    return { ok: false, reason: "invalid_value" };
  }
  return { ok: true, body: value };
}

function extractWebhookDeliveryId(input: {
  identity: WebhookDeliveryIdentity;
  headers: Headers;
  query: URLSearchParams;
  body: Record<string, unknown>;
}): WebhookDeliveryIdentityResult {
  if (input.identity.type === "header") {
    return normalizeWebhookDeliveryId(input.headers.get(input.identity.name));
  }
  if (input.identity.type === "query") {
    return normalizeWebhookDeliveryId(input.query.get(input.identity.name));
  }

  let value: unknown = input.body;
  for (const segment of input.identity.path) {
    if (!isJsonObject(value) || !(segment in value)) {
      return { ok: false, reason: "missing" };
    }
    value = value[segment];
  }
  return normalizeWebhookDeliveryId(value);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeWebhookDeliveryId(value: unknown): WebhookDeliveryIdentityResult {
  if (typeof value !== "string" && typeof value !== "number") {
    return value == null
      ? { ok: false, reason: "missing" }
      : { ok: false, reason: "invalid_value" };
  }
  const deliveryId = `${value}`.trim();
  if (!deliveryId) {
    return { ok: false, reason: "missing" };
  }
  return { ok: true, deliveryId };
}

async function webhookHookId(endpointId: string, deliveryId: string) {
  return `webhook_${await sha256Base64Url(`${endpointId}\0${deliveryId}`)}`;
}

function publicWebhookEndpoint(endpoint: {
  id: { toString(): string } | string;
  name: string;
  status: string;
  authConfig: WebhookAuthConfig;
  deliveryIdentity: WebhookDeliveryIdentity;
  createdAt?: Date;
  updatedAt?: Date;
}): WebhookEndpoint {
  return {
    id: endpoint.id.toString(),
    name: endpoint.name,
    status: parseWebhookEndpointStatus(endpoint.status),
    authConfig: endpoint.authConfig,
    deliveryIdentity: endpoint.deliveryIdentity,
    secretRefs: [...getWebhookAuthSecretRefs(endpoint.authConfig)],
    createdAt: endpoint.createdAt,
    updatedAt: endpoint.updatedAt,
  };
}

export const apiRoutesFactory = defineRoutes(apiFragmentDefinition).create(
  ({ services, defineRoute, config }) => [
    defineRoute({
      method: "PUT",
      path: "/webhooks/endpoints/:endpointId",
      inputSchema: createWebhookEndpointInputSchema,
      outputSchema: webhookEndpointOutputSchema,
      handler: async function ({ input, pathParams }, { json }) {
        const body = await input.valid();
        const authStorage = webhookEndpointAuthStorage(body.auth);
        const result = await this.handlerTx()
          .retrieve(({ forSchema }) =>
            forSchema(apiSchema)
              .findFirst("webhookEndpoint", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", pathParams.endpointId)),
              )
              .find("webhookSecret", (b) =>
                b.whereIndex("idx_webhook_secret_endpoint_ref", (eb) =>
                  eb("endpointId", "=", pathParams.endpointId),
                ),
              ),
          )
          .mutate(({ forSchema, retrieveResult: [existing, existingSecrets] }) => {
            const uow = forSchema(apiSchema);
            if (existing) {
              uow.update("webhookEndpoint", existing.id, (b) =>
                b
                  .set({
                    name: body.name,
                    status: body.status,
                    authConfig: authStorage.authConfig,
                    deliveryIdentity: body.deliveryIdentity,
                    updatedAt: b.now(),
                  })
                  .check(),
              );
            } else {
              uow.create("webhookEndpoint", {
                id: pathParams.endpointId,
                name: body.name,
                status: body.status,
                authConfig: authStorage.authConfig,
                deliveryIdentity: body.deliveryIdentity,
              });
            }

            const nextSecretRefs = new Set(authStorage.secrets.map((secret) => secret.ref));
            for (const secret of existingSecrets) {
              if (!nextSecretRefs.has(secret.ref)) {
                uow.delete("webhookSecret", secret.id);
              }
            }
            for (const secret of authStorage.secrets) {
              const existingSecret = existingSecrets.find(
                (candidate) => candidate.ref === secret.ref,
              );
              if (existingSecret) {
                uow.update("webhookSecret", existingSecret.id, (b) =>
                  b.set({ payload: secret.payload, updatedAt: b.now() }).check(),
                );
              } else {
                uow.create("webhookSecret", {
                  id: webhookSecretId(pathParams.endpointId, secret.ref),
                  endpointId: pathParams.endpointId,
                  ref: secret.ref,
                  payload: secret.payload,
                });
              }
            }

            return {
              created: !existing,
              endpoint: {
                id: pathParams.endpointId,
                name: body.name,
                status: body.status,
                authConfig: authStorage.authConfig,
                deliveryIdentity: body.deliveryIdentity,
                createdAt: existing?.createdAt,
              },
            };
          })
          .execute();

        return json(publicWebhookEndpoint(result.endpoint), result.created ? 201 : 200);
      },
    }),

    defineRoute({
      method: "GET",
      path: "/webhooks/endpoints",
      outputSchema: webhookEndpointsOutputSchema,
      handler: async function (_, { json }) {
        const [endpoints] = await this.handlerTx()
          .retrieve(({ forSchema }) =>
            forSchema(apiSchema).find("webhookEndpoint", (b) => b.whereIndex("primary")),
          )
          .execute();
        return json({ endpoints: endpoints.map(publicWebhookEndpoint) });
      },
    }),

    defineRoute({
      method: "GET",
      path: "/webhooks/endpoints/:endpointId",
      outputSchema: webhookEndpointOutputSchema,
      errorCodes: ["WEBHOOK_ENDPOINT_NOT_FOUND"],
      handler: async function ({ pathParams }, { json, error }) {
        const [endpoint] = await this.handlerTx()
          .retrieve(({ forSchema }) =>
            forSchema(apiSchema).findFirst("webhookEndpoint", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", pathParams.endpointId)),
            ),
          )
          .execute();
        if (!endpoint) {
          return error(
            { code: "WEBHOOK_ENDPOINT_NOT_FOUND", message: "Webhook endpoint not found" },
            404,
          );
        }
        return json(publicWebhookEndpoint(endpoint));
      },
    }),

    defineRoute({
      method: "POST",
      path: "/webhooks/endpoints/:endpointId/events",
      errorCodes: [
        "WEBHOOK_ENDPOINT_NOT_FOUND",
        "WEBHOOK_ENDPOINT_DISABLED",
        "WEBHOOK_AUTH_FAILED",
        "WEBHOOK_BODY_INVALID",
        "WEBHOOK_DELIVERY_ID_MISSING",
        "WEBHOOK_DELIVERY_ID_INVALID",
      ],
      outputSchema: webhookReceivedOutputSchema,
      handler: async function ({ pathParams, headers, query, rawBody, request }, { json, error }) {
        let result:
          | {
              ok: true;
            }
          | {
              ok: false;
              code:
                | "WEBHOOK_ENDPOINT_NOT_FOUND"
                | "WEBHOOK_ENDPOINT_DISABLED"
                | "WEBHOOK_AUTH_FAILED"
                | "WEBHOOK_BODY_INVALID"
                | "WEBHOOK_DELIVERY_ID_MISSING"
                | "WEBHOOK_DELIVERY_ID_INVALID";
              reason?: string;
            };
        try {
          result = await this.handlerTx()
            .retrieve(({ forSchema }) =>
              forSchema(apiSchema)
                .findFirst("webhookEndpoint", (b) =>
                  b.whereIndex("primary", (eb) => eb("id", "=", pathParams.endpointId)),
                )
                .find("webhookSecret", (b) =>
                  b.whereIndex("idx_webhook_secret_endpoint_ref", (eb) =>
                    eb("endpointId", "=", pathParams.endpointId),
                  ),
                ),
            )
            .transformRetrieve(async ([endpoint, secrets]) => {
              if (!endpoint) {
                return { ok: false as const, code: "WEBHOOK_ENDPOINT_NOT_FOUND" as const };
              }
              if (endpoint.status !== "active") {
                return { ok: false as const, code: "WEBHOOK_ENDPOINT_DISABLED" as const };
              }

              const authConfig = endpoint.authConfig;
              const secretValues = new Map(secrets.map((secret) => [secret.ref, secret.payload]));
              if (!request) {
                throw new Error("Webhook receive route requires a web-standard Request");
              }
              const auth = await verifyWebhookAuth({
                config: authConfig,
                request,
                secrets: { get: async (ref) => secretValues.get(ref) },
              });
              if (!auth.ok) {
                return {
                  ok: false as const,
                  code: "WEBHOOK_AUTH_FAILED" as const,
                  reason: auth.reason,
                };
              }

              const body = parseWebhookJsonBody(rawBody);
              if (!body.ok) {
                return { ok: false as const, code: "WEBHOOK_BODY_INVALID" as const };
              }

              const deliveryIdentity = endpoint.deliveryIdentity;
              const deliveryId = extractWebhookDeliveryId({
                identity: deliveryIdentity,
                headers,
                query,
                body: body.body,
              });
              if (!deliveryId.ok) {
                return {
                  ok: false as const,
                  code:
                    deliveryId.reason === "missing"
                      ? ("WEBHOOK_DELIVERY_ID_MISSING" as const)
                      : ("WEBHOOK_DELIVERY_ID_INVALID" as const),
                };
              }

              return {
                ok: true as const,
                authConfig,
                deliveryId: deliveryId.deliveryId,
                hookId: await webhookHookId(pathParams.endpointId, deliveryId.deliveryId),
                body: body.body,
              };
            })
            .mutate(({ forSchema, retrieveResult }) => {
              if (!retrieveResult.ok) {
                return retrieveResult;
              }

              const sensitiveValues = getSensitiveWebhookAuthValues(retrieveResult.authConfig);
              const sensitiveHeaderNames = new Set(
                sensitiveValues
                  .filter((value) => value.location === "header")
                  .map((value) => value.name.toLowerCase()),
              );
              const sensitiveQueryNames = new Set(
                sensitiveValues
                  .filter((value) => value.location === "query")
                  .map((value) => value.name),
              );

              const uow = forSchema(apiSchema);
              uow.triggerHook(
                "onWebhookReceived",
                {
                  endpointId: pathParams.endpointId,
                  deliveryId: retrieveResult.deliveryId,
                  hookId: retrieveResult.hookId,
                  receivedAt: new Date().toISOString(),
                  headers: recordFromHeaders(headers, sensitiveHeaderNames),
                  query: recordFromSearchParams(query, sensitiveQueryNames),
                  rawBody: rawBody ?? "",
                  body: retrieveResult.body,
                  contentType: headers.get("content-type"),
                },
                { id: retrieveResult.hookId },
              );
              return { ok: true as const };
            })
            .execute();
        } catch (err) {
          if (isUniqueConstraintError(err)) {
            return json({ accepted: true }, 202);
          }
          throw err;
        }

        if (!result.ok) {
          if (result.code === "WEBHOOK_ENDPOINT_NOT_FOUND") {
            return error({ code: result.code, message: "Webhook endpoint not found" }, 404);
          }
          if (result.code === "WEBHOOK_ENDPOINT_DISABLED") {
            return error({ code: result.code, message: "Webhook endpoint is disabled" }, 409);
          }
          if (result.code === "WEBHOOK_BODY_INVALID") {
            return error({ code: result.code, message: "Webhook body must be a JSON object" }, 400);
          }
          if (result.code === "WEBHOOK_DELIVERY_ID_MISSING") {
            return error({ code: result.code, message: "Webhook delivery ID is missing" }, 400);
          }
          if (result.code === "WEBHOOK_DELIVERY_ID_INVALID") {
            return error({ code: result.code, message: "Webhook delivery ID is invalid" }, 400);
          }
          return error({ code: result.code, message: "Webhook authentication failed" }, 401);
        }

        return json({ accepted: true }, 202);
      },
    }),

    defineRoute({
      method: "PATCH",
      path: "/webhooks/endpoints/:endpointId",
      inputSchema: updateWebhookEndpointInputSchema,
      outputSchema: webhookEndpointOutputSchema,
      errorCodes: ["WEBHOOK_ENDPOINT_NOT_FOUND"],
      handler: async function ({ input, pathParams }, { json, error }) {
        const body = await input.valid();
        const authStorage = body.auth ? webhookEndpointAuthStorage(body.auth) : null;
        const result = await this.handlerTx()
          .retrieve(({ forSchema }) =>
            forSchema(apiSchema)
              .findFirst("webhookEndpoint", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", pathParams.endpointId)),
              )
              .find("webhookSecret", (b) =>
                b.whereIndex("idx_webhook_secret_endpoint_ref", (eb) =>
                  eb("endpointId", "=", pathParams.endpointId),
                ),
              ),
          )
          .mutate(({ forSchema, retrieveResult: [endpoint, secrets] }) => {
            if (!endpoint) {
              return { found: false as const };
            }
            const uow = forSchema(apiSchema);
            const authConfig = authStorage?.authConfig ?? endpoint.authConfig;
            const deliveryIdentity = body.deliveryIdentity ?? endpoint.deliveryIdentity;
            const next = {
              id: endpoint.id,
              name: body.name ?? endpoint.name,
              status: body.status ?? endpoint.status,
              authConfig,
              deliveryIdentity,
              createdAt: endpoint.createdAt,
            };
            uow.update("webhookEndpoint", endpoint.id, (b) =>
              b
                .set({
                  name: next.name,
                  status: next.status,
                  authConfig,
                  deliveryIdentity,
                  updatedAt: b.now(),
                })
                .check(),
            );
            if (authStorage) {
              for (const secret of secrets) {
                uow.delete("webhookSecret", secret.id);
              }
              for (const secret of authStorage.secrets) {
                uow.create("webhookSecret", {
                  id: webhookSecretId(pathParams.endpointId, secret.ref),
                  endpointId: pathParams.endpointId,
                  ref: secret.ref,
                  payload: secret.payload,
                });
              }
            }
            return { found: true as const, endpoint: next };
          })
          .execute();

        if (!result.found) {
          return error(
            { code: "WEBHOOK_ENDPOINT_NOT_FOUND", message: "Webhook endpoint not found" },
            404,
          );
        }

        return json(publicWebhookEndpoint(result.endpoint));
      },
    }),

    defineRoute({
      method: "DELETE",
      path: "/webhooks/endpoints/:endpointId",
      handler: async function ({ pathParams }, { empty }) {
        await this.handlerTx()
          .retrieve(({ forSchema }) =>
            forSchema(apiSchema)
              .findFirst("webhookEndpoint", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", pathParams.endpointId)),
              )
              .find("webhookSecret", (b) =>
                b.whereIndex("idx_webhook_secret_endpoint_ref", (eb) =>
                  eb("endpointId", "=", pathParams.endpointId),
                ),
              ),
          )
          .mutate(({ forSchema, retrieveResult: [endpoint, secrets] }) => {
            if (!endpoint) {
              return { deleted: false as const };
            }
            const uow = forSchema(apiSchema);
            for (const secret of secrets) {
              uow.delete("webhookSecret", secret.id);
            }
            uow.delete("webhookEndpoint", endpoint.id);
            return { deleted: true as const };
          })
          .execute();

        return empty(204);
      },
    }),

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
