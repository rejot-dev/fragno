import { decodeCursor, type Cursor } from "@fragno-dev/db/cursor";
import { z } from "zod";

import { defineRoutes } from "@fragno-dev/core";
import { isUniqueConstraintError } from "@fragno-dev/db";

import {
  API_OAUTH_REDIRECT_URI_QUERY_PARAMETER,
  apiAuthStatusSchema,
  apiConnectionOutputSchema,
  apiConnectionSlugSchema,
  apiConnectionsPageSchema,
  apiOAuthPendingSchema,
  apiRequestInputSchema,
  apiRequestOutputSchema,
  createApiConnectionInputSchema,
  createWebhookEndpointInputSchema,
  oauthRedirectUriSchema,
  oauthStartInputSchema,
  tokenAuthInputSchema,
  updateWebhookEndpointInputSchema,
  webhookEndpointOutputSchema,
  type WebhookDeliveryIdentity,
  type WebhookEndpoint,
  type WebhookEndpointAuthInput,
} from "./api-types";
import { sha256Base64Url, utf8Bytes } from "./crypto";
import { apiFragmentDefinition, type WebhookEndpointHookSnapshot } from "./definition";
import { apiSchema } from "./schema";
import { assertAllowedBaseUrl, pendingOAuthLink, projectApiAuthStatus } from "./services";
import {
  getSensitiveWebhookAuthValues,
  getWebhookAuthSecretRefs,
  verifyWebhookAuth,
  type WebhookAuthConfig,
} from "./webhooks/auth";
import {
  createWebhookRequestValues,
  evaluateWebhookVerification,
  type WebhookRequestValues,
  type WebhookVerificationConfig,
} from "./webhooks/verification";

const CONNECTIONS_PAGE_SIZE = 50;
const webhookEndpointsOutputSchema = z.object({ endpoints: z.array(webhookEndpointOutputSchema) });
const oauthStartOutputSchema = z.object({ authorizationUrl: z.string(), state: z.string() });
const oauthCallbackOutputSchema = z.object({ authenticated: z.boolean(), mode: z.string() });
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

function parseWebhookEndpointStatus(status: string): "draft" | "active" | "disabled" {
  if (status === "draft" || status === "active" || status === "disabled") {
    return status;
  }
  throw new Error(`Unexpected webhook endpoint status: ${status}`);
}

function webhookEndpointHookSnapshot(endpoint: {
  name: string;
  status: string;
  authConfig: WebhookAuthConfig;
  verification: WebhookVerificationConfig;
  deliveryIdentity: WebhookDeliveryIdentity;
}): WebhookEndpointHookSnapshot {
  return {
    name: endpoint.name,
    status: parseWebhookEndpointStatus(endpoint.status),
    authConfig: endpoint.authConfig,
    verification: endpoint.verification,
    deliveryIdentity: endpoint.deliveryIdentity,
    secretRefs: [...getWebhookAuthSecretRefs(endpoint.authConfig)],
  };
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

type WebhookDeliveryIdentityResult =
  | { ok: true; deliveryId: string }
  | { ok: false; reason: "missing" | "invalid_value" };

type WebhookRequestFailure = {
  ok: false;
  code:
    | "WEBHOOK_ENDPOINT_NOT_FOUND"
    | "WEBHOOK_ENDPOINT_DISABLED"
    | "WEBHOOK_ENDPOINT_DRAFT"
    | "WEBHOOK_AUTH_FAILED"
    | "WEBHOOK_VERIFICATION_RESPONSE_INVALID"
    | "WEBHOOK_BODY_INVALID"
    | "WEBHOOK_DELIVERY_ID_MISSING"
    | "WEBHOOK_DELIVERY_ID_INVALID";
};

type WebhookReceiveResult =
  | WebhookRequestFailure
  | { ok: true; type: "verification"; body: string }
  | { ok: true; type: "delivery" };

function extractWebhookDeliveryId(input: {
  identity: WebhookDeliveryIdentity;
  requestValues: WebhookRequestValues;
}): WebhookDeliveryIdentityResult {
  const value = input.requestValues.read(input.identity);
  if (!value.ok) {
    return {
      ok: false,
      reason: value.reason === "missing" ? "missing" : "invalid_value",
    };
  }
  return normalizeWebhookDeliveryId(value.value);
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

function webhookVerificationResponse(body: string) {
  const bytes = utf8Bytes(body);
  return new Response(bytes, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-length": `${bytes.byteLength}`,
      "x-content-type-options": "nosniff",
    },
  });
}

function publicWebhookEndpoint(endpoint: {
  id: { toString(): string } | string;
  name: string;
  status: string;
  authConfig: WebhookAuthConfig;
  verification: WebhookVerificationConfig;
  deliveryIdentity: WebhookDeliveryIdentity;
  createdAt?: Date;
  updatedAt?: Date;
}): WebhookEndpoint {
  return {
    id: endpoint.id.toString(),
    name: endpoint.name,
    status: parseWebhookEndpointStatus(endpoint.status),
    authConfig: endpoint.authConfig,
    verification: endpoint.verification,
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
            const endpoint = {
              id: pathParams.endpointId,
              name: body.name,
              status: body.status,
              authConfig: authStorage.authConfig,
              verification: body.verification,
              deliveryIdentity: body.deliveryIdentity,
              createdAt: existing?.createdAt,
            };
            if (existing) {
              uow.update("webhookEndpoint", existing.id, (b) =>
                b
                  .set({
                    name: endpoint.name,
                    status: endpoint.status,
                    authConfig: endpoint.authConfig,
                    verification: endpoint.verification,
                    deliveryIdentity: endpoint.deliveryIdentity,
                    updatedAt: b.now(),
                  })
                  .check(),
              );
            } else {
              uow.create("webhookEndpoint", {
                id: endpoint.id,
                name: endpoint.name,
                status: endpoint.status,
                authConfig: endpoint.authConfig,
                verification: endpoint.verification,
                deliveryIdentity: endpoint.deliveryIdentity,
              });
            }

            const nextSecretRefs = new Set(authStorage.secrets.map((secret) => secret.ref));
            const existingSecretsByRef = new Map(
              existingSecrets.map((secret) => [secret.ref, secret] as const),
            );
            for (const secret of existingSecrets) {
              if (!nextSecretRefs.has(secret.ref)) {
                uow.delete("webhookSecret", secret.id);
              }
            }
            for (const secret of authStorage.secrets) {
              const existingSecret = existingSecretsByRef.get(secret.ref);
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

            uow.triggerHook("onWebhookEndpointChanged", {
              change: existing ? "updated" : "created",
              endpointId: pathParams.endpointId,
              endpoint: webhookEndpointHookSnapshot(endpoint),
            });

            return { created: !existing, endpoint };
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
      method: "GET",
      path: "/webhooks/endpoints/:endpointId/events",
      errorCodes: [
        "WEBHOOK_ENDPOINT_NOT_FOUND",
        "WEBHOOK_ENDPOINT_DISABLED",
        "WEBHOOK_ENDPOINT_DRAFT",
        "WEBHOOK_AUTH_FAILED",
        "WEBHOOK_VERIFICATION_NOT_MATCHED",
        "WEBHOOK_VERIFICATION_RESPONSE_INVALID",
      ],
      handler: async function ({ pathParams, headers, query, rawBody, request }, { error }) {
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
          .transformRetrieve(async ([endpoint, secrets]) => {
            if (!endpoint) {
              return { ok: false as const, code: "WEBHOOK_ENDPOINT_NOT_FOUND" as const };
            }
            if (endpoint.status === "draft") {
              return { ok: false as const, code: "WEBHOOK_ENDPOINT_DRAFT" as const };
            }
            if (endpoint.status !== "active") {
              return { ok: false as const, code: "WEBHOOK_ENDPOINT_DISABLED" as const };
            }
            if (!request) {
              throw new Error("Webhook receive route requires a web-standard Request");
            }

            const secretValues = new Map(secrets.map((secret) => [secret.ref, secret.payload]));
            const auth = await verifyWebhookAuth({
              config: endpoint.authConfig,
              request,
              secrets: { get: async (ref) => secretValues.get(ref) },
            });
            if (!auth.ok) {
              return { ok: false as const, code: "WEBHOOK_AUTH_FAILED" as const };
            }

            const verification = evaluateWebhookVerification({
              config: endpoint.verification,
              method: "GET",
              requestValues: createWebhookRequestValues({ headers, query, rawBody }),
            });
            if (verification.type === "not_verification") {
              return { ok: false as const, code: "WEBHOOK_VERIFICATION_NOT_MATCHED" as const };
            }
            if (verification.type === "invalid_response") {
              return {
                ok: false as const,
                code: "WEBHOOK_VERIFICATION_RESPONSE_INVALID" as const,
              };
            }
            return { ok: true as const, body: verification.body };
          })
          .mutate(({ retrieveResult }) => retrieveResult)
          .execute();

        if (!result.ok) {
          if (result.code === "WEBHOOK_ENDPOINT_NOT_FOUND") {
            return error({ code: result.code, message: "Webhook endpoint not found" }, 404);
          }
          if (result.code === "WEBHOOK_ENDPOINT_DISABLED") {
            return error({ code: result.code, message: "Webhook endpoint is disabled" }, 409);
          }
          if (result.code === "WEBHOOK_ENDPOINT_DRAFT") {
            return error(
              { code: result.code, message: "Webhook endpoint is not configured yet" },
              409,
            );
          }
          if (result.code === "WEBHOOK_AUTH_FAILED") {
            return error({ code: result.code, message: "Webhook authentication failed" }, 401);
          }
          if (result.code === "WEBHOOK_VERIFICATION_RESPONSE_INVALID") {
            return error({ code: result.code, message: "Webhook challenge is invalid" }, 400);
          }
          return error(
            { code: result.code, message: "Webhook verification request not found" },
            404,
          );
        }

        return webhookVerificationResponse(result.body);
      },
    }),

    defineRoute({
      method: "POST",
      path: "/webhooks/endpoints/:endpointId/events",
      errorCodes: [
        "WEBHOOK_ENDPOINT_NOT_FOUND",
        "WEBHOOK_ENDPOINT_DISABLED",
        "WEBHOOK_ENDPOINT_DRAFT",
        "WEBHOOK_AUTH_FAILED",
        "WEBHOOK_VERIFICATION_RESPONSE_INVALID",
        "WEBHOOK_BODY_INVALID",
        "WEBHOOK_DELIVERY_ID_MISSING",
        "WEBHOOK_DELIVERY_ID_INVALID",
      ],
      handler: async function ({ pathParams, headers, query, rawBody, request }, { json, error }) {
        let result: WebhookReceiveResult;
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
              if (endpoint.status === "draft") {
                return { ok: false as const, code: "WEBHOOK_ENDPOINT_DRAFT" as const };
              }
              if (endpoint.status !== "active") {
                return { ok: false as const, code: "WEBHOOK_ENDPOINT_DISABLED" as const };
              }
              if (!request) {
                throw new Error("Webhook receive route requires a web-standard Request");
              }

              const authConfig = endpoint.authConfig;
              const secretValues = new Map(secrets.map((secret) => [secret.ref, secret.payload]));
              const auth = await verifyWebhookAuth({
                config: authConfig,
                request,
                secrets: { get: async (ref) => secretValues.get(ref) },
              });
              if (!auth.ok) {
                return { ok: false as const, code: "WEBHOOK_AUTH_FAILED" as const };
              }

              const requestValues = createWebhookRequestValues({ headers, query, rawBody });
              const verification = evaluateWebhookVerification({
                config: endpoint.verification,
                method: "POST",
                requestValues,
              });
              if (verification.type === "invalid_response") {
                return {
                  ok: false as const,
                  code: "WEBHOOK_VERIFICATION_RESPONSE_INVALID" as const,
                };
              }
              if (verification.type === "response") {
                return {
                  ok: true as const,
                  type: "verification" as const,
                  body: verification.body,
                };
              }

              const body = requestValues.jsonBody();
              if (!body.ok) {
                return { ok: false as const, code: "WEBHOOK_BODY_INVALID" as const };
              }

              const deliveryId = extractWebhookDeliveryId({
                identity: endpoint.deliveryIdentity,
                requestValues,
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
                type: "delivery" as const,
                authConfig,
                deliveryId: deliveryId.deliveryId,
                hookId: await webhookHookId(pathParams.endpointId, deliveryId.deliveryId),
                body: body.body,
              };
            })
            .mutate(({ forSchema, retrieveResult }) => {
              if (!retrieveResult.ok || retrieveResult.type === "verification") {
                return retrieveResult;
              }

              const sensitiveValues = getSensitiveWebhookAuthValues(retrieveResult.authConfig);
              const sensitiveHeaderNames = new Set(
                sensitiveValues.flatMap((value) =>
                  value.location === "header" ? [value.name.toLowerCase()] : [],
                ),
              );
              const sensitiveQueryNames = new Set(
                sensitiveValues.flatMap((value) =>
                  value.location === "query" ? [value.name] : [],
                ),
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
              return { ok: true as const, type: "delivery" as const };
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
          if (result.code === "WEBHOOK_ENDPOINT_DRAFT") {
            return error(
              { code: result.code, message: "Webhook endpoint is not configured yet" },
              409,
            );
          }
          if (result.code === "WEBHOOK_VERIFICATION_RESPONSE_INVALID") {
            return error({ code: result.code, message: "Webhook challenge is invalid" }, 400);
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

        if (result.type === "verification") {
          return webhookVerificationResponse(result.body);
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
            const verification = body.verification ?? endpoint.verification;
            const deliveryIdentity = body.deliveryIdentity ?? endpoint.deliveryIdentity;
            const next = {
              id: endpoint.id,
              name: body.name ?? endpoint.name,
              status: body.status ?? endpoint.status,
              authConfig,
              verification,
              deliveryIdentity,
              createdAt: endpoint.createdAt,
            };
            uow.update("webhookEndpoint", endpoint.id, (b) =>
              b
                .set({
                  name: next.name,
                  status: next.status,
                  authConfig,
                  verification,
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
            uow.triggerHook("onWebhookEndpointChanged", {
              change: "updated",
              endpointId: pathParams.endpointId,
              endpoint: webhookEndpointHookSnapshot(next),
            });
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
      errorCodes: ["CONNECTION_EXISTS", "BASE_URL_NOT_ALLOWED", "INVALID_SLUG"],
      handler: async function ({ input, pathParams }, { json, error }) {
        const slug = apiConnectionSlugSchema.safeParse(pathParams.slug);
        if (!slug.success) {
          return error({ code: "INVALID_SLUG", message: slug.error.issues[0].message }, 400);
        }
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
      queryParameters: ["cursor"],
      outputSchema: apiConnectionsPageSchema,
      errorCodes: ["INVALID_CURSOR"],
      handler: async function ({ query }, { json, error }) {
        let cursor: Cursor | null = null;
        const rawCursor = query.get("cursor");
        if (rawCursor) {
          try {
            cursor = decodeCursor(rawCursor);
            if (
              cursor.indexName !== "_primary" ||
              cursor.orderDirection !== "asc" ||
              cursor.pageSize !== CONNECTIONS_PAGE_SIZE ||
              typeof cursor.indexValues["id"] !== "string"
            ) {
              throw new Error("Connection cursor does not match this listing");
            }
          } catch {
            return error({ code: "INVALID_CURSOR", message: "Invalid connection cursor" }, 400);
          }
        }
        const [page] = await this.handlerTx()
          .retrieve(({ forSchema }) =>
            forSchema(apiSchema).findWithCursor("api_connection", (b) => {
              const ordered = b
                .whereIndex("primary")
                .orderByIndex("primary", "asc")
                .pageSize(CONNECTIONS_PAGE_SIZE);
              return cursor ? ordered.after(cursor) : ordered;
            }),
          )
          .execute();
        return json({
          connections: page.items.map(publicConnection),
          cursor: page.cursor?.encode() ?? null,
        });
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
      method: "PUT",
      path: "/connections/:slug/configuration",
      inputSchema: createApiConnectionInputSchema,
      outputSchema: apiConnectionOutputSchema,
      errorCodes: ["CONNECTION_NOT_FOUND", "BASE_URL_NOT_ALLOWED"],
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
        const payload = body.auth.type === "none" ? null : JSON.stringify(body.auth);
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
              return { connection: null };
            }
            const uow = forSchema(apiSchema);
            const replaced = {
              ...connection,
              name: body.name ?? null,
              baseUrl: body.baseUrl,
              authMode: body.auth.type,
            };
            uow.update("api_connection", connection.id, (b) =>
              b
                .set({
                  name: replaced.name,
                  baseUrl: replaced.baseUrl,
                  authMode: replaced.authMode,
                  updatedAt: b.now(),
                })
                .check(),
            );
            // Replaced credentials take their tokens with them; pending links belong to the old client.
            const authSecret = secrets.find((secret) => secret.kind === "auth");
            for (const secret of secrets) {
              if (secret !== authSecret || payload === null) {
                uow.delete("secret", secret.id);
              }
            }
            if (payload !== null) {
              if (authSecret) {
                uow.update("secret", authSecret.id, (b) =>
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
            }
            for (const state of states) {
              uow.delete("oauthState", state.id);
            }
            uow.triggerHook("onConnectionChanged", {
              connectionId: pathParams.slug,
              connection: connectionHookSnapshot(replaced),
            });
            return { connection: replaced };
          })
          .execute();
        if (!result.connection) {
          return error({ code: "CONNECTION_NOT_FOUND", message: "API connection not found" }, 404);
        }
        return json(publicConnection(result.connection));
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
      outputSchema: apiAuthStatusSchema,
      errorCodes: ["CONNECTION_NOT_FOUND"],
      handler: async function ({ pathParams }, { json, error }) {
        const [connection, secret, pendingState] = await this.handlerTx()
          .retrieve(({ forSchema }) =>
            forSchema(apiSchema)
              .findFirst("api_connection", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", pathParams.slug)),
              )
              .findFirst("secret", (b) =>
                b.whereIndex("idx_secret_connection_kind", (eb) =>
                  eb.and(eb("connectionId", "=", pathParams.slug), eb("kind", "=", "auth")),
                ),
              )
              .findFirst("oauthState", (b) =>
                b
                  .whereIndex("idx_oauth_state_pending", (eb) =>
                    eb.and(
                      eb("connectionId", "=", pathParams.slug),
                      eb.isNull("consumedAt"),
                      eb("expiresAt", ">", eb.now()),
                    ),
                  )
                  .orderByIndex("idx_oauth_state_pending", "desc"),
              ),
          )
          .execute();
        if (!connection) {
          return error({ code: "CONNECTION_NOT_FOUND", message: "API connection not found" }, 404);
        }
        return json(
          projectApiAuthStatus({
            authMode: connection.authMode,
            authSecret: secret ?? undefined,
            hasPendingOAuth: pendingOAuthLink(pendingState) !== null,
          }),
        );
      },
    }),

    defineRoute({
      method: "GET",
      path: "/connections/:slug/auth/oauth/pending",
      outputSchema: apiOAuthPendingSchema,
      errorCodes: ["CONNECTION_NOT_FOUND"],
      handler: async function ({ pathParams }, { json, error }) {
        const [connection, pendingState] = await this.handlerTx()
          .retrieve(({ forSchema }) =>
            forSchema(apiSchema)
              .findFirst("api_connection", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", pathParams.slug)),
              )
              .findFirst("oauthState", (b) =>
                b
                  .whereIndex("idx_oauth_state_pending", (eb) =>
                    eb.and(
                      eb("connectionId", "=", pathParams.slug),
                      eb.isNull("consumedAt"),
                      eb("expiresAt", ">", eb.now()),
                    ),
                  )
                  .orderByIndex("idx_oauth_state_pending", "desc"),
              ),
          )
          .execute();
        if (!connection) {
          return error({ code: "CONNECTION_NOT_FOUND", message: "API connection not found" }, 404);
        }
        return json({ pending: pendingOAuthLink(pendingState) });
      },
    }),

    defineRoute({
      method: "POST",
      path: "/connections/:slug/auth/token",
      inputSchema: tokenAuthInputSchema,
      outputSchema: apiAuthStatusSchema,
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
        return json({ mode: "bearer" as const, credentials: "present" as const });
      },
    }),

    defineRoute({
      method: "POST",
      path: "/connections/:slug/auth/oauth/start",
      inputSchema: oauthStartInputSchema,
      outputSchema: oauthStartOutputSchema,
      queryParameters: [API_OAUTH_REDIRECT_URI_QUERY_PARAMETER],
      errorCodes: [
        "INVALID_OAUTH_REDIRECT_URI",
        "OAUTH_REDIRECT_URI_NOT_ALLOWED",
        "CONNECTION_NOT_FOUND",
        "AUTH_NOT_CONFIGURED",
        "AUTH_NOT_OAUTH",
        "OAUTH_ERROR",
      ],
      handler: async function ({ input, pathParams, query }, { json, error }) {
        const body = await input.valid();
        const redirectUri = oauthRedirectUriSchema.safeParse(
          query.get(API_OAUTH_REDIRECT_URI_QUERY_PARAMETER),
        );
        if (!redirectUri.success) {
          return error(
            {
              code: "INVALID_OAUTH_REDIRECT_URI",
              message: "OAuth redirect URI must be an HTTP or HTTPS URL",
            },
            400,
          );
        }
        const oauthRedirectUri = new URL(redirectUri.data);
        if (!config.allowedOAuthRedirectUris?.(oauthRedirectUri)) {
          return error(
            {
              code: "OAUTH_REDIRECT_URI_NOT_ALLOWED",
              message: "OAuth redirect URI is not allowed by the fragment configuration",
            },
            400,
          );
        }
        const state = `${pathParams.slug}:${crypto.randomUUID()}`;
        try {
          const [result] = await this.handlerTx()
            .withServiceCalls(
              () =>
                [
                  services.startOAuth({
                    connectionId: pathParams.slug,
                    stateId: state,
                    redirectUri: oauthRedirectUri.toString(),
                    scopes: body.scopes,
                    extraAuthorizationParams: body.extraAuthorizationParams,
                    discardTokens: body.discardTokens,
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
      outputSchema: apiAuthStatusSchema,
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
            // Keep the mode: clearing credentials must not turn the connection unauthenticated.
            uow.update("api_connection", connection.id, (b) =>
              b.set({ updatedAt: b.now() }).check(),
            );
            uow.triggerHook("onConnectionChanged", {
              connectionId: pathParams.slug,
              connection: connectionHookSnapshot(connection),
            });
            return {
              found: true as const,
              status: projectApiAuthStatus({
                authMode: connection.authMode,
                authSecret: undefined,
                hasPendingOAuth: false,
              }),
            };
          })
          .execute();
        if (!result.found) {
          return error({ code: "CONNECTION_NOT_FOUND", message: "API connection not found" }, 404);
        }
        return json(result.status);
      },
    }),

    defineRoute({
      method: "POST",
      path: "/connections/:slug/request",
      inputSchema: apiRequestInputSchema,
      outputSchema: apiRequestOutputSchema,
      handler: async function ({ input, pathParams }, { json }) {
        const request = await input.valid();
        const [result] = await this.handlerTx()
          .withServiceCalls(
            () => [services.executeApiRequest({ connectionId: pathParams.slug, request })] as const,
          )
          .execute();
        if (!result.found) {
          if (result.reason === "connection_disabled") {
            return json({
              ok: false,
              response: null,
              error: {
                code: "CONNECTION_DISABLED",
                message: "API connection is disabled",
              },
            });
          }
          return json({
            ok: false,
            response: null,
            error: {
              code: "CONNECTION_NOT_FOUND",
              message: "API connection not found",
            },
          });
        }
        return json(result.response);
      },
    }),
  ],
);
