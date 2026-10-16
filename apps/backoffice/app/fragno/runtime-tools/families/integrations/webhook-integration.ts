import {
  apiConnectionSlugSchema,
  webhookDeliveryIdentitySchema,
  webhookEndpointAuthInputSchema,
  webhookEndpointOutputSchema,
  type WebhookDeliveryEvidence,
  type WebhookEndpoint,
  type WebhookRejectionCode,
} from "@fragno-dev/api-fragment/types";
import { webhookVerificationConfigSchema } from "@fragno-dev/api-fragment/webhooks/verification";
import type {
  IntegrationAuthMethod,
  IntegrationInspection,
} from "@fragno-dev/backoffice-api/v0/integrations";
import {
  BACKOFFICE_PERMISSION,
  type BackofficePermissionRequirement,
} from "@fragno-dev/backoffice-api/v0/shared/permissions";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { createRouteCaller } from "@fragno-dev/core/api";
import { z } from "zod";

import { authorizedBackofficeObjectHttp } from "@/backoffice-runtime/authorized-object-http";
import { BackofficeUnavailableError } from "@/backoffice-runtime/kernel";
import { isBackofficeObjectAvailableInContext } from "@/backoffice-runtime/object-registry";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import type { ApiFragment } from "@/fragno/api";
import { backofficeCapabilities } from "@/fragno/backoffice-capabilities/backoffice-capabilities";
import { apiCapability } from "@/fragno/backoffice-capabilities/capabilities/api";
import { apiPublicAddress, apiWebhookPublicUrl } from "@/fragno/scoped-public-fragment-routes";

import { isSuccessStatus, throwOnRouteRuntimeError } from "../../runtime-errors";
import { resolveRuntimePublicScopePathSegment } from "../../runtime-public-scope";
import type { IntegrationConnectionState } from "./integration-events";
import type { IntegrationContext, IntegrationImplementation } from "./integration-implementation";

const webhookIntegrationId = "webhook";
const webhookSetupInputSchema = z.strictObject({
  name: z.string().trim().min(1).describe("Display name, usually the provider's name."),
  verification: webhookVerificationConfigSchema.describe(
    'A challenge the provider sends, usually when its URL is entered, that the endpoint must answer before deliveries start; { type: "none" } when it sends none.',
  ),
  deliveryIdentity: webhookDeliveryIdentitySchema.describe(
    "Where each delivery carries the provider's unique delivery ID. Repeated IDs are accepted once.",
  ),
  auth: webhookEndpointAuthInputSchema.describe(
    "How the provider authenticates deliveries. A provider's webhook or signing secret usually means hmac.",
  ),
});
const webhookKeepAuthSchema = z
  .strictObject({ type: z.literal("keep") })
  .describe("Keep the stored authentication and its secrets.");
const webhookReconfigureInputSchema = webhookSetupInputSchema.extend({
  auth: z.discriminatedUnion("type", [
    webhookKeepAuthSchema,
    ...webhookEndpointAuthInputSchema.options,
  ]),
});
// Paths, because the auth variants nest their secrets and apiKey's `name` would collide with the
// endpoint's display name at the top level.
const webhookSetupSecretFields = ["auth.token", "auth.secret", "auth.username", "auth.password"];
const webhookEndpointDescriptionSchema = z.strictObject({
  endpointId: z.string(),
  publicUrl: z
    .string()
    .nullable()
    .describe(
      "The URL to give the provider; null when this deployment has no public origin, so no provider can reach it.",
    ),
  ...webhookEndpointOutputSchema.pick({
    name: true,
    status: true,
    authConfig: true,
    verification: true,
    deliveryIdentity: true,
    deliveries: true,
  }).shape,
});
const webhookDescribeActionDefinition = {
  id: "endpoint.describe",
  label: "Describe endpoint",
  description:
    "Read the endpoint's webhook URL, status, contract, and latest delivery outcomes. Stored secrets are named by reference, never returned.",
  inputSchema: z.toJSONSchema(z.strictObject({}), { io: "input" }),
  outputSchema: z.toJSONSchema(webhookEndpointDescriptionSchema, { io: "output" }),
};
const deliveryCheckIdentity = { id: "delivery.received", label: "Receive a delivery" };
const rejectionReasons: Record<WebhookRejectionCode, string> = {
  WEBHOOK_ENDPOINT_DISABLED: "the endpoint is disabled",
  WEBHOOK_ENDPOINT_DRAFT: "the endpoint was not configured yet",
  WEBHOOK_AUTH_FAILED:
    "authentication failed, so the provider's secret or signature settings differ",
  WEBHOOK_VERIFICATION_NOT_MATCHED: "a GET request did not match the verification challenge",
  WEBHOOK_VERIFICATION_RESPONSE_INVALID: "the verification challenge had no value to echo",
  WEBHOOK_BODY_INVALID: "the body was not a JSON object",
  WEBHOOK_DELIVERY_ID_MISSING: "the configured delivery ID was missing",
  WEBHOOK_DELIVERY_ID_INVALID: "the configured delivery ID was not a string or number",
};
const unconfiguredFields = ["name", "verification", "deliveryIdentity", "auth"];

export function encodeWebhookConnectionId(endpointId: string) {
  return `webhook#${endpointId}`;
}

/** Deliveries are the only evidence a passive endpoint has, so they are its check. */
function deliveryCheck({
  lastAcceptedAt,
  lastRejection,
}: WebhookDeliveryEvidence): IntegrationInspection["checks"][number] {
  if (
    lastRejection !== null &&
    (lastAcceptedAt === null || Date.parse(lastRejection.receivedAt) > Date.parse(lastAcceptedAt))
  ) {
    return {
      ...deliveryCheckIdentity,
      status: "failed",
      checkedAt: lastRejection.receivedAt,
      message: `Rejected the latest request: ${rejectionReasons[lastRejection.code]}.`,
    };
  }
  if (lastAcceptedAt !== null) {
    return {
      ...deliveryCheckIdentity,
      status: "passed",
      checkedAt: lastAcceptedAt,
      message: "Accepted the latest request.",
    };
  }
  return {
    ...deliveryCheckIdentity,
    status: "not-checked",
    reason: "No request has reached the endpoint since its configuration last changed.",
  };
}

export function authMethodOfWebhookAuth(
  auth: WebhookEndpoint["authConfig"],
): IntegrationAuthMethod {
  switch (auth.type) {
    case "none":
    case "bearer":
    case "basic":
      return auth.type;
    case "apiKey":
      return "api-key";
    case "hmac":
      return "signature";
    default:
      throw new Error("Webhook auth type is unsupported.", { cause: auth satisfies never });
  }
}

function inspectWebhookEndpoint(
  endpoint: WebhookEndpoint | null,
  publicUrl: string | null,
): IntegrationInspection {
  if (endpoint === null) {
    return {
      configuration: { status: "missing", missingFields: unconfiguredFields },
      authorization: { status: "missing" },
      checks: [],
      nextSteps: ["Run setup at this address to configure the endpoint."],
    };
  }
  const check = deliveryCheck(endpoint.deliveries);
  const authorization: IntegrationInspection["authorization"] = {
    status: endpoint.authConfig.type === "none" ? "not-required" : "available",
  };
  switch (endpoint.status) {
    case "draft":
      return {
        // A draft's stored values were never confirmed as the provider's contract.
        configuration: { status: "missing", missingFields: unconfiguredFields },
        authorization,
        checks: [check],
        nextSteps: [
          "Run setup to finish configuring the endpoint; it rejects deliveries until then.",
        ],
      };
    case "disabled":
      return {
        configuration: { status: "configured" },
        authorization,
        checks: [check],
        nextSteps: [
          "The endpoint is disabled and rejects deliveries. Run integrations.reconfigure to activate it.",
        ],
      };
    case "active":
      return {
        configuration: { status: "configured" },
        authorization,
        checks: [check],
        nextSteps:
          check.status === "passed"
            ? []
            : check.status === "failed"
              ? [
                  "Correct the provider's webhook settings or reconfigure the endpoint to match them, then send another delivery.",
                ]
              : [
                  publicUrl === null
                    ? "This deployment has no public origin, so no provider can reach the endpoint."
                    : `Give the provider this webhook URL, send a test delivery, then run verify: ${publicUrl}`,
                ],
      };
    default:
      throw new Error("Webhook endpoint status is unsupported.", {
        cause: endpoint.status satisfies never,
      });
  }
}

/**
 * Endpoint IDs also name the event source that reclassified deliveries use, so a new endpoint may
 * not take over a source Backoffice already declares.
 */
function isDeclaredEventSource(source: string) {
  return backofficeCapabilities.some(
    (capability) =>
      capability.contributions.automationEvents.some((event) => event.source === source) ||
      capability.contributions.eventSources.some((eventSource) => eventSource.source === source),
  );
}

/** Projects the API Fragment's inbound webhook endpoints; their contracts and secrets stay there. */
export function createWebhookIntegration({
  runtime,
}: {
  runtime: Pick<BackofficeRuntimeServices, "objects" | "config">;
}): IntegrationImplementation {
  function isApiAvailable(scope: BackofficeContextScope) {
    return runtime.config.bindings.api && isBackofficeObjectAvailableInContext("API", scope);
  }

  function createWebhookAccess(context: IntegrationContext) {
    if (!isApiAvailable(context.execution.scope)) {
      throw new BackofficeUnavailableError(
        "Webhook endpoints require an available organization, user, or project API store.",
      );
    }
    const object = context.kernel.scoped("API", context.execution.scope, runtime.objects.api);
    const transport = authorizedBackofficeObjectHttp(object.http, context.execution);
    const callRoute = createRouteCaller<ApiFragment>({
      baseUrl: "https://api.do",
      mountRoute: "/api/api",
      fetch: transport.fetch.bind(transport),
    });
    type ApiRouteResponse = Awaited<ReturnType<typeof callRoute>>;
    function invoke<TResult>(
      operation: BackofficePermissionRequirement,
      resource: Record<string, string>,
      execute: () => Promise<TResult>,
    ) {
      return context.kernel.invoke({
        execution: context.execution,
        operation,
        resource: { capabilityId: "api", ...resource },
        execute,
      });
    }
    function fail(response: ApiRouteResponse): never {
      return throwOnRouteRuntimeError(response, {
        runtimeLabel: "Webhook integration",
        label: "Webhook endpoint operation",
      });
    }
    function isEndpointNotFound(response: ApiRouteResponse) {
      return (
        response.type === "error" &&
        response.status === 404 &&
        response.error.code === "WEBHOOK_ENDPOINT_NOT_FOUND"
      );
    }
    /** Null without a public origin: the URL would be unreachable for any provider. */
    async function publicBaseUrl(): Promise<string | null> {
      if (runtime.config.docsPublicBaseUrl === undefined) {
        return null;
      }
      return apiPublicAddress(
        runtime.config.docsPublicBaseUrl,
        await resolveRuntimePublicScopePathSegment(runtime, context.execution.scope, "API"),
      ).baseUrl;
    }
    async function publicUrl(endpointId: string) {
      const baseUrl = await publicBaseUrl();
      return baseUrl === null ? null : apiWebhookPublicUrl(baseUrl, endpointId);
    }
    async function endpoint(endpointId: string): Promise<WebhookEndpoint | null> {
      const response = await invoke(BACKOFFICE_PERMISSION.connections.read, { endpointId }, () =>
        callRoute("GET", "/webhooks/endpoints/:endpointId", { pathParams: { endpointId } }),
      );
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data;
      }
      return isEndpointNotFound(response) ? null : fail(response);
    }
    async function endpoints(): Promise<WebhookEndpoint[]> {
      const response = await invoke(BACKOFFICE_PERMISSION.connections.read, {}, () =>
        callRoute("GET", "/webhooks/endpoints"),
      );
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data.endpoints;
      }
      return fail(response);
    }
    /** Activates a new or draft endpoint with the submitted contract. */
    async function activate(endpointId: string, values: z.output<typeof webhookSetupInputSchema>) {
      const response = await invoke(BACKOFFICE_PERMISSION.connections.manage, { endpointId }, () =>
        callRoute("PUT", "/webhooks/endpoints/:endpointId", {
          pathParams: { endpointId },
          body: { ...values, status: "active" },
        }),
      );
      if (!(response.type === "json" && isSuccessStatus(response.status))) {
        fail(response);
      }
    }
    async function reconfigure(
      endpointId: string,
      { auth, ...values }: z.output<typeof webhookReconfigureInputSchema>,
    ) {
      const response = await invoke(BACKOFFICE_PERMISSION.connections.manage, { endpointId }, () =>
        callRoute("PATCH", "/webhooks/endpoints/:endpointId", {
          pathParams: { endpointId },
          // The Fragment keeps the stored auth when the patch omits it.
          body: { ...values, status: "active", ...(auth.type === "keep" ? {} : { auth }) },
        }),
      );
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return true;
      }
      return isEndpointNotFound(response) ? false : fail(response);
    }
    async function remove(endpointId: string) {
      const response = await invoke(BACKOFFICE_PERMISSION.connections.manage, { endpointId }, () =>
        callRoute("DELETE", "/webhooks/endpoints/:endpointId", { pathParams: { endpointId } }),
      );
      if (!isSuccessStatus(response.status)) {
        fail(response);
      }
    }
    return { publicBaseUrl, publicUrl, endpoint, endpoints, activate, reconfigure, remove };
  }

  function describeSetup(publicUrl: string) {
    return `Give the user this webhook URL now, before asking for anything else, so they can create the webhook in the provider: ${publicUrl}. Most providers reveal the signing secret only once the webhook exists. Then submit the provider's webhook contract from its documentation, sample payloads, and headers: a display name, its verification challenge, where each delivery carries its ID, and how it authenticates. The URL answers 404 until setup completes, so finish setup before test deliveries; a provider that sends a verification challenge when the URL is entered, like Slack, needs setup finished first.`;
  }

  return {
    connectionIds: [{ kind: "namespace", namespace: "webhook" }],
    setup: {
      kind: "supported",
      async run(context, { localId, operation }) {
        const connectionId = encodeWebhookConnectionId(localId);
        if (!isApiAvailable(context.execution.scope)) {
          return {
            connectionId,
            status: "blocked",
            reason:
              "Webhook endpoints require an available organization-, user-, or project-owned API store.",
          };
        }
        const access = createWebhookAccess(context);
        const existing = await access.endpoint(localId);
        if (existing?.status === "active") {
          return { connectionId, status: "ready" };
        }
        if (existing?.status === "disabled") {
          return {
            connectionId,
            status: "blocked",
            reason: "The endpoint is disabled. Run integrations.reconfigure to activate it.",
          };
        }
        // Existing drafts were created elsewhere and are completed in place.
        if (existing === null) {
          const endpointId = apiConnectionSlugSchema.safeParse(localId);
          if (!endpointId.success) {
            return {
              connectionId,
              status: "blocked",
              reason:
                "Webhook endpoint IDs start with a letter or digit and contain only letters, digits, '.', '_', or '-'.",
            };
          }
          if (isDeclaredEventSource(localId)) {
            return {
              connectionId,
              status: "blocked",
              reason: `The endpoint ID also names its event source, and Backoffice already declares the '${localId}' source. Choose another ID, such as '${localId}-webhooks'.`,
            };
          }
        }
        const publicUrl = await access.publicUrl(localId);
        if (publicUrl === null) {
          return {
            connectionId,
            status: "blocked",
            reason:
              "Backoffice has no public base URL (DOCS_PUBLIC_BASE_URL), so no provider could deliver to the endpoint.",
          };
        }
        if (operation.kind === "check") {
          return {
            connectionId,
            status: "needs-input",
            instructions: describeSetup(publicUrl),
            inputSchema: z.toJSONSchema(webhookSetupInputSchema, { io: "input" }),
            secretFields: webhookSetupSecretFields,
          };
        }
        await access.activate(localId, webhookSetupInputSchema.parse(operation.input));
        return { connectionId, status: "ready" };
      },
    },
    reconfigure: {
      kind: "supported",
      async run(context, { localId, operation }) {
        const connectionId = encodeWebhookConnectionId(localId);
        const access = createWebhookAccess(context);
        const existing = await access.endpoint(localId);
        if (existing === null) {
          return {
            connectionId,
            status: "blocked",
            reason: "No webhook endpoint exists at this address. Run setup to create it.",
          };
        }
        if (operation.kind === "check") {
          const publicUrl = await access.publicUrl(localId);
          return {
            connectionId,
            status: "needs-input",
            instructions:
              `Submit the complete contract, as in setup; auth { type: "keep" } keeps the stored authentication and its secrets. The endpoint becomes active, and its delivery outcomes reset. ${
                publicUrl === null ? "" : `Its URL stays ${publicUrl}.`
              }`.trim(),
            inputSchema: z.toJSONSchema(webhookReconfigureInputSchema, { io: "input" }),
            secretFields: webhookSetupSecretFields,
          };
        }
        if (
          !(await access.reconfigure(localId, webhookReconfigureInputSchema.parse(operation.input)))
        ) {
          return {
            connectionId,
            status: "blocked",
            reason: "The webhook endpoint was removed meanwhile. Run setup to create it.",
          };
        }
        return { connectionId, status: "ready" };
      },
    },
    disconnect: {
      kind: "supported",
      async run(context, { localId }) {
        const access = createWebhookAccess(context);
        const connectionId = encodeWebhookConnectionId(localId);
        // Deletion is idempotent, so only a read tells a removal from a missing endpoint.
        if ((await access.endpoint(localId)) === null) {
          return { connectionId, status: "not-configured" };
        }
        await access.remove(localId);
        return { connectionId, status: "disconnected" };
      },
    },
    async discover(context) {
      return [
        {
          id: webhookIntegrationId,
          label: "Inbound webhook",
          description:
            "A public URL that accepts a provider's webhook deliveries and records each one as an api.webhook.received event. Choose an address webhook#<endpointId>; the endpoint ID also names the event source that reclassified deliveries use.",
          connectionCardinality: "multiple",
          availability: !runtime.config.bindings.api
            ? { status: "unavailable", reason: "The API object binding is unavailable." }
            : isApiAvailable(context.execution.scope)
              ? { status: "available" }
              : {
                  status: "unavailable",
                  reason: "Webhook endpoints are owned by an organization, user, or project.",
                },
          // Endpoint IDs are caller-chosen, so there is no fixed slot to advertise.
          setupTargets: [],
          automationEvents: apiCapability.contributions.automationEvents.map(
            ({ source, eventType }) => ({ source, eventType }),
          ),
        },
      ];
    },
    async list(context, cursor) {
      if (!isApiAvailable(context.execution.scope)) {
        return { connections: [], cursor: null };
      }
      if (cursor !== null) {
        throw new Error("Webhook integration listing cursor is invalid.");
      }
      const access = createWebhookAccess(context);
      // The Fragment lists every endpoint in one page.
      const [endpoints, publicBaseUrl] = await Promise.all([
        access.endpoints(),
        access.publicBaseUrl(),
      ]);
      return {
        // Listings hold configured connections; drafts resolve only by address.
        connections: endpoints.flatMap((endpoint) => {
          const inspection = inspectWebhookEndpoint(
            endpoint,
            publicBaseUrl === null ? null : apiWebhookPublicUrl(publicBaseUrl, endpoint.id),
          );
          return inspection.configuration.status === "configured"
            ? [
                {
                  connectionId: encodeWebhookConnectionId(endpoint.id),
                  integrationId: webhookIntegrationId,
                  name: endpoint.name,
                  authMethod: authMethodOfWebhookAuth(endpoint.authConfig),
                  ...inspection,
                  configuration: inspection.configuration,
                },
              ]
            : [];
        }),
        cursor: null,
      };
    },
    async resolve(context, localId) {
      const access = createWebhookAccess(context);
      const resolved = await access.endpoint(localId);
      async function inspect() {
        const [endpoint, publicUrl] = await Promise.all([
          access.endpoint(localId),
          access.publicUrl(localId),
        ]);
        return inspectWebhookEndpoint(endpoint, publicUrl);
      }
      return {
        identity: {
          connectionId: encodeWebhookConnectionId(localId),
          integrationId: webhookIntegrationId,
          name: resolved?.name ?? localId,
          authMethod: resolved && authMethodOfWebhookAuth(resolved.authConfig),
        },
        inspect,
        // A disabled endpoint keeps its configuration and secret but rejects deliveries, which
        // inspection alone cannot express; the endpoint hook reports it the same way.
        async state(): Promise<IntegrationConnectionState> {
          return (await access.endpoint(localId))?.status === "active" ? "ready" : "unavailable";
        },
        async details() {
          const [endpoint, publicUrl] = await Promise.all([
            access.endpoint(localId),
            access.publicUrl(localId),
          ]);
          return { kind: "webhook", endpoint, publicUrl };
        },
        async settings() {
          const endpoint = await access.endpoint(localId);
          // "keep" stands for the stored secrets, so these settings are a complete replacement.
          return (
            endpoint && {
              name: endpoint.name,
              verification: endpoint.verification,
              deliveryIdentity: endpoint.deliveryIdentity,
              auth: { type: "keep" },
            }
          );
        },
        async actions() {
          return [
            {
              definition: webhookDescribeActionDefinition,
              async invoke(input) {
                z.strictObject({}).parse(input);
                const [endpoint, publicUrl] = await Promise.all([
                  access.endpoint(localId),
                  access.publicUrl(localId),
                ]);
                if (endpoint === null) {
                  throw new Error("Webhook endpoint not found. Run setup to create it.");
                }
                return {
                  endpointId: endpoint.id,
                  publicUrl,
                  name: endpoint.name,
                  status: endpoint.status,
                  authConfig: endpoint.authConfig,
                  verification: endpoint.verification,
                  deliveryIdentity: endpoint.deliveryIdentity,
                  deliveries: endpoint.deliveries,
                } satisfies z.output<typeof webhookEndpointDescriptionSchema>;
              },
            },
          ];
        },
        // A passive endpoint cannot be probed; recorded deliveries are the only evidence.
        verify: inspect,
      };
    },
  };
}
