import { createRouteCaller, type RouteCallerForFragment } from "@fragno-dev/core/api";
import { useEffect, useMemo, useState } from "react";
import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  redirect,
  useNavigation,
  useSearchParams,
} from "react-router";
import type { RouterContextProvider } from "react-router";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import { isBackofficeRoutableScope } from "@/backoffice-runtime/scope-codec";
import { FormField } from "@/components/backoffice";
import type { ApiFragment } from "@/fragno/api";
import { requireBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import type { Route } from "./+types/api";
import { automationScopeFromRouteParams } from "./scope";

type ApiConnectionSummary = {
  slug: string;
  name?: string | null;
  baseUrl: string;
  authMode: string;
  status: string;
  createdAt?: string | Date;
  updatedAt?: string | Date;
  authStatus?: ApiAuthStatus;
  authError?: string;
};

type ApiAuthStatus = {
  authenticated: boolean;
  mode: string;
  tokenPresent?: boolean;
  expiresAt?: string | Date | null;
};

type WebhookDeliveryIdentity =
  | { type: "header"; name: string }
  | { type: "query"; name: string }
  | { type: "jsonBodyPath"; path: string[] };

type WebhookAuthConfig =
  | { type: "none" }
  | { type: "bearer"; tokenRef: string }
  | { type: "apiKey"; location: "header" | "query"; name: string; secretRef: string }
  | { type: "basic"; usernameRef: string; passwordRef: string }
  | {
      type: "hmac";
      secretRef: string;
      algorithm: "sha1" | "sha256" | "sha512";
      signature: {
        location: "header" | "query";
        name: string;
        encoding: "hex" | "base64" | "base64url";
        prefix?: string;
      };
      signedPayload:
        | { type: "rawBody" }
        | {
            type: "timestampBody";
            timestampHeader: string;
            delimiter: string;
            toleranceSeconds: number;
          };
    };

type ApiWebhookEndpointSummary = {
  id: string;
  name: string;
  status: "draft" | "active" | "disabled";
  authConfig: WebhookAuthConfig;
  deliveryIdentity: WebhookDeliveryIdentity;
  secretRefs: string[];
  createdAt?: string | Date;
  updatedAt?: string | Date;
  publicUrl: string | null;
};

type ApiRequestResult = {
  connectionSlug: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: unknown;
};

type ApiActionData = {
  ok: boolean;
  intent: string;
  message: string;
  authorizationUrl?: string;
  requestResult?: ApiRequestResult;
};

type ApiConfigurationLoaderData = {
  publicBaseUrl: string | null;
  connections: ApiConnectionSummary[];
  webhooks: ApiWebhookEndpointSummary[];
  connectionsError: string | null;
  webhooksError: string | null;
  configError: string | null;
};

type ConnectionAuthMode = "none" | "bearer" | "oauth" | "client_credentials";
type WebhookAuthMode = "none" | "bearer" | "apiKey" | "basic" | "hmac";
type DeliveryIdentityMode = "header" | "query" | "jsonBodyPath";
type SignedPayloadMode = "rawBody" | "timestampBody";
type HmacAlgorithm = "sha1" | "sha256" | "sha512";
type HmacEncoding = "hex" | "base64" | "base64url";

const webhookAuthModeFromConfig = (authConfig: WebhookAuthConfig): WebhookAuthMode =>
  authConfig.type;

const deliveryModeFromIdentity = (identity: WebhookDeliveryIdentity): DeliveryIdentityMode =>
  identity.type;

const signedPayloadModeFromAuth = (authConfig: WebhookAuthConfig): SignedPayloadMode =>
  authConfig.type === "hmac" ? authConfig.signedPayload.type : "rawBody";

const getFormString = (formData: FormData, key: string) => {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
};

const parseScopes = (value: string) =>
  value
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);

const parseJsonObject = (value: string, label: string): Record<string, string> | undefined => {
  if (!value.trim()) {
    return undefined;
  }
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return Object.fromEntries(
    Object.entries(parsed as Record<string, unknown>).map(([key, entry]) => [key, String(entry)]),
  );
};

const parseJsonValue = (value: string) => {
  if (!value.trim()) {
    return undefined;
  }
  return JSON.parse(value) as unknown;
};

const routeResponseMessage = (response: {
  type: string;
  status: number;
  error?: { message: string };
  data?: unknown;
}) => {
  if (response.type === "json") {
    return JSON.stringify(response.data);
  }
  if (response.type === "error") {
    return response.error?.message ?? `Request failed with status ${response.status}.`;
  }
  return `Request failed with status ${response.status}.`;
};

const isSuccessResponse = (response: { status: number }) =>
  response.status >= 200 && response.status < 300;

const formatMaybeDate = (value?: string | Date | null) =>
  value ? new Date(value).toLocaleString() : "—";

const selectedConnectionPath = (slug: string) =>
  `?tab=connections&connection=${encodeURIComponent(slug)}`;
const selectedWebhookPath = (endpointId: string) =>
  `?tab=webhooks&webhook=${encodeURIComponent(endpointId)}`;

const webhookPublicUrl = (publicBaseUrl: string | null, endpointId: string) =>
  publicBaseUrl && endpointId
    ? `${publicBaseUrl}/webhooks/endpoints/${encodeURIComponent(endpointId)}/events`
    : null;

const appendWebhookPublicUrl = (
  endpoint: Omit<ApiWebhookEndpointSummary, "publicUrl">,
  publicBaseUrl: string | null,
): ApiWebhookEndpointSummary => ({
  ...endpoint,
  publicUrl: webhookPublicUrl(publicBaseUrl, endpoint.id),
});

const slugifyEndpointId = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const getApiObjectForScope = (
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
) => {
  if (!isBackofficeRoutableScope(scope)) {
    throw new Error(`API is not available in ${scope.kind} scope.`);
  }
  return context.get(BackofficeWorkerContext).runtime.objects.api.for(scope);
};

const createApiRouteCallerForScope = (
  request: Request,
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
): RouteCallerForFragment<ApiFragment> => {
  const apiObject = getApiObjectForScope(context, scope);
  return createRouteCaller<ApiFragment>({
    baseUrl: new URL(request.url).origin,
    mountRoute: "/api/api",
    fetch: async (outboundRequest) => apiObject.fetch(outboundRequest),
  });
};

async function ensureApiConfiguredForScope(
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
) {
  const apiObject = getApiObjectForScope(context, scope);
  const status = await apiObject.getAdminConfig();
  if (!status.configured) {
    return await apiObject.setAdminConfig({ scope });
  }
  return status;
}

async function fetchApiConnectionsForScope(
  request: Request,
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
): Promise<{ connections: ApiConnectionSummary[]; connectionsError: string | null }> {
  try {
    const callRoute = createApiRouteCallerForScope(request, context, scope);
    const response = await callRoute("GET", "/connections");
    if (response.type !== "json" || !isSuccessResponse(response)) {
      return {
        connections: [],
        connectionsError: routeResponseMessage(response) || "Unable to load API connections.",
      };
    }

    const connections = response.data.connections as ApiConnectionSummary[];
    const withAuth = await Promise.all(
      connections.map(async (connection) => {
        if (connection.authMode === "none") {
          return connection;
        }
        const authResponse = await callRoute("GET", "/connections/:slug/auth/status", {
          pathParams: { slug: connection.slug },
        });
        if (authResponse.type === "json" && isSuccessResponse(authResponse)) {
          return { ...connection, authStatus: authResponse.data as ApiAuthStatus };
        }
        return { ...connection, authError: routeResponseMessage(authResponse) };
      }),
    );
    return { connections: withAuth, connectionsError: null };
  } catch (error) {
    return {
      connections: [],
      connectionsError: error instanceof Error ? error.message : "Unable to load API connections.",
    };
  }
}

async function fetchApiWebhooksForScope(
  request: Request,
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
  publicBaseUrl: string | null,
): Promise<{ webhooks: ApiWebhookEndpointSummary[]; webhooksError: string | null }> {
  try {
    const callRoute = createApiRouteCallerForScope(request, context, scope);
    const response = await callRoute("GET", "/webhooks/endpoints");
    if (response.type === "json" && isSuccessResponse(response)) {
      return {
        webhooks: (response.data.endpoints as Array<Omit<ApiWebhookEndpointSummary, "publicUrl">>)
          .map((endpoint) => appendWebhookPublicUrl(endpoint, publicBaseUrl))
          .sort((left, right) => left.id.localeCompare(right.id)),
        webhooksError: null,
      };
    }
    return {
      webhooks: [],
      webhooksError: routeResponseMessage(response) || "Unable to load API webhook endpoints.",
    };
  } catch (error) {
    return {
      webhooks: [],
      webhooksError:
        error instanceof Error ? error.message : "Unable to load API webhook endpoints.",
    };
  }
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const scope = automationScopeFromRouteParams(params);
  await requireBackofficeContext(request, context, scope);

  let publicBaseUrl: string | null = null;
  let configError: string | null = null;
  try {
    const configState = await ensureApiConfiguredForScope(context, scope);
    publicBaseUrl = configState.configured ? (configState.config?.publicBaseUrl ?? null) : null;
  } catch (error) {
    configError = error instanceof Error ? error.message : "Unable to initialize API capability.";
  }

  if (configError) {
    return {
      publicBaseUrl,
      connections: [],
      webhooks: [],
      connectionsError: null,
      webhooksError: null,
      configError,
    } satisfies ApiConfigurationLoaderData;
  }

  const [connectionsResult, webhooksResult] = await Promise.all([
    fetchApiConnectionsForScope(request, context, scope),
    fetchApiWebhooksForScope(request, context, scope, publicBaseUrl),
  ]);

  return {
    publicBaseUrl,
    connections: connectionsResult.connections,
    webhooks: webhooksResult.webhooks,
    connectionsError: connectionsResult.connectionsError,
    webhooksError: webhooksResult.webhooksError,
    configError,
  } satisfies ApiConfigurationLoaderData;
}

type OAuthTokenEndpointAuthMethod = "client_secret_basic" | "client_secret_post" | "none";
type ClientCredentialsTokenEndpointAuthMethod = "client_secret_basic" | "client_secret_post";

const readOAuthTokenEndpointAuthMethod = (value: string): OAuthTokenEndpointAuthMethod => {
  if (value === "client_secret_basic" || value === "client_secret_post" || value === "none") {
    return value;
  }
  return "client_secret_basic";
};

const readClientCredentialsTokenEndpointAuthMethod = (
  value: string,
): ClientCredentialsTokenEndpointAuthMethod => {
  if (value === "client_secret_post") {
    return value;
  }
  return "client_secret_basic";
};

const readHttpMethod = (value: string) => {
  if (
    value === "GET" ||
    value === "POST" ||
    value === "PUT" ||
    value === "PATCH" ||
    value === "DELETE"
  ) {
    return value;
  }
  return "GET";
};

const readWebhookStatus = (value: string) => {
  if (value === "active" || value === "disabled" || value === "draft") {
    return value;
  }
  return "draft";
};

const readConnectionAuth = (formData: FormData) => {
  const authMode = (getFormString(formData, "authMode") || "none") as ConnectionAuthMode;
  const scopes = parseScopes(getFormString(formData, "scopes"));
  if (authMode === "bearer") {
    return { type: "bearer" as const, token: getFormString(formData, "token") };
  }
  if (authMode === "oauth") {
    return {
      type: "oauth" as const,
      authorizationEndpoint: getFormString(formData, "authorizationEndpoint"),
      tokenEndpoint: getFormString(formData, "tokenEndpoint"),
      clientId: getFormString(formData, "clientId"),
      ...(getFormString(formData, "clientSecret")
        ? { clientSecret: getFormString(formData, "clientSecret") }
        : {}),
      ...(scopes.length ? { scopes } : {}),
      tokenEndpointAuthMethod: readOAuthTokenEndpointAuthMethod(
        getFormString(formData, "tokenEndpointAuthMethod"),
      ),
    };
  }
  if (authMode === "client_credentials") {
    return {
      type: "client_credentials" as const,
      tokenEndpoint: getFormString(formData, "tokenEndpoint"),
      clientId: getFormString(formData, "clientId"),
      clientSecret: getFormString(formData, "clientSecret"),
      ...(scopes.length ? { scopes } : {}),
      ...(getFormString(formData, "audience")
        ? { audience: getFormString(formData, "audience") }
        : {}),
      tokenEndpointAuthMethod: readClientCredentialsTokenEndpointAuthMethod(
        getFormString(formData, "tokenEndpointAuthMethod"),
      ),
    };
  }
  return { type: "none" as const };
};

const readWebhookDeliveryIdentity = (formData: FormData): WebhookDeliveryIdentity => {
  const deliveryMode = (getFormString(formData, "deliveryMode") ||
    "header") as DeliveryIdentityMode;
  if (deliveryMode === "jsonBodyPath") {
    const path = getFormString(formData, "deliveryJsonPath")
      .split(/[.,]/)
      .map((segment) => segment.trim())
      .filter(Boolean);
    return { type: "jsonBodyPath", path: path.length ? path : ["id"] };
  }
  return { type: deliveryMode, name: getFormString(formData, "deliveryName") || "x-delivery-id" };
};

const readWebhookAuth = (formData: FormData) => {
  const authMode = (getFormString(formData, "webhookAuthMode") || "none") as WebhookAuthMode;
  if (authMode === "bearer") {
    return { type: "bearer" as const, token: getFormString(formData, "webhookBearerToken") };
  }
  if (authMode === "apiKey") {
    return {
      type: "apiKey" as const,
      location: (getFormString(formData, "apiKeyLocation") || "header") as "header" | "query",
      name: getFormString(formData, "apiKeyName"),
      secret: getFormString(formData, "apiKeySecret"),
    };
  }
  if (authMode === "basic") {
    return {
      type: "basic" as const,
      username: getFormString(formData, "basicUsername"),
      password: getFormString(formData, "basicPassword"),
    };
  }
  if (authMode === "hmac") {
    const signedPayloadMode = (getFormString(formData, "signedPayloadMode") ||
      "rawBody") as SignedPayloadMode;
    return {
      type: "hmac" as const,
      secret: getFormString(formData, "hmacSecret"),
      algorithm: (getFormString(formData, "hmacAlgorithm") || "sha256") as
        | "sha1"
        | "sha256"
        | "sha512",
      signature: {
        location: (getFormString(formData, "signatureLocation") || "header") as "header" | "query",
        name: getFormString(formData, "signatureName"),
        encoding: (getFormString(formData, "signatureEncoding") || "hex") as
          | "hex"
          | "base64"
          | "base64url",
        ...(getFormString(formData, "signaturePrefix")
          ? { prefix: getFormString(formData, "signaturePrefix") }
          : {}),
      },
      signedPayload:
        signedPayloadMode === "timestampBody"
          ? {
              type: "timestampBody" as const,
              timestampHeader: getFormString(formData, "timestampHeader"),
              delimiter: getFormString(formData, "timestampDelimiter") || ".",
              toleranceSeconds: Number(getFormString(formData, "toleranceSeconds") || "300"),
            }
          : { type: "rawBody" as const },
    };
  }
  return { type: "none" as const };
};

export async function action({ request, context, params }: Route.ActionArgs) {
  const scope = automationScopeFromRouteParams(params);
  await requireBackofficeContext(request, context, scope);
  const formData = await request.formData();
  const intent = getFormString(formData, "intent");

  try {
    await ensureApiConfiguredForScope(context, scope);
    const callRoute = createApiRouteCallerForScope(request, context, scope);

    if (intent === "add-connection") {
      const slug = getFormString(formData, "slug");
      const name = getFormString(formData, "name");
      const response = await callRoute("PUT", "/connections/:slug", {
        pathParams: { slug },
        body: {
          baseUrl: getFormString(formData, "baseUrl"),
          ...(name ? { name } : {}),
          auth: readConnectionAuth(formData),
        },
      });
      if (response.type !== "json" || !isSuccessResponse(response)) {
        return {
          ok: false,
          intent,
          message: routeResponseMessage(response),
        } satisfies ApiActionData;
      }
      if (getFormString(formData, "authMode") === "oauth") {
        const oauthResponse = await callRoute("POST", "/connections/:slug/auth/oauth/start", {
          pathParams: { slug },
        });
        if (oauthResponse.type === "json" && isSuccessResponse(oauthResponse)) {
          return {
            ok: true,
            intent,
            message: "API connection saved. OAuth authorization URL created.",
            authorizationUrl: oauthResponse.data.authorizationUrl,
          } satisfies ApiActionData;
        }
        return {
          ok: false,
          intent,
          message: `Connection saved, but OAuth could not start: ${routeResponseMessage(oauthResponse)}`,
        } satisfies ApiActionData;
      }
      return { ok: true, intent, message: "API connection saved." } satisfies ApiActionData;
    }

    if (intent === "start-oauth") {
      const slug = getFormString(formData, "slug");
      const scopes = parseScopes(getFormString(formData, "scopes"));
      const extraAuthorizationParams = parseJsonObject(
        getFormString(formData, "extraAuthorizationParams"),
        "Extra authorization params",
      );
      const response = await callRoute("POST", "/connections/:slug/auth/oauth/start", {
        pathParams: { slug },
        body: {
          ...(scopes.length ? { scopes } : {}),
          ...(extraAuthorizationParams ? { extraAuthorizationParams } : {}),
        },
      });
      if (response.type === "json" && isSuccessResponse(response)) {
        return {
          ok: true,
          intent,
          message: "OAuth authorization URL created.",
          authorizationUrl: response.data.authorizationUrl,
        } satisfies ApiActionData;
      }
      return { ok: false, intent, message: routeResponseMessage(response) } satisfies ApiActionData;
    }

    if (intent === "set-token") {
      const token = getFormString(formData, "token");
      if (!token) {
        return { ok: false, intent, message: "Bearer token is required." } satisfies ApiActionData;
      }
      const response = await callRoute("POST", "/connections/:slug/auth/token", {
        pathParams: { slug: getFormString(formData, "slug") },
        body: { token },
      });
      if (response.type === "json" && isSuccessResponse(response)) {
        return { ok: true, intent, message: "Bearer token saved." } satisfies ApiActionData;
      }
      return { ok: false, intent, message: routeResponseMessage(response) } satisfies ApiActionData;
    }

    if (intent === "delete-auth") {
      const response = await callRoute("DELETE", "/connections/:slug/auth", {
        pathParams: { slug: getFormString(formData, "slug") },
      });
      if (isSuccessResponse(response)) {
        return {
          ok: true,
          intent,
          message: "Stored connection auth deleted.",
        } satisfies ApiActionData;
      }
      return { ok: false, intent, message: routeResponseMessage(response) } satisfies ApiActionData;
    }

    if (intent === "delete-connection") {
      const response = await callRoute("DELETE", "/connections/:slug", {
        pathParams: { slug: getFormString(formData, "slug") },
      });
      if (isSuccessResponse(response)) {
        return { ok: true, intent, message: "API connection deleted." } satisfies ApiActionData;
      }
      return { ok: false, intent, message: routeResponseMessage(response) } satisfies ApiActionData;
    }

    if (intent === "execute-request") {
      const jsonBody = parseJsonValue(getFormString(formData, "json"));
      const response = await callRoute("POST", "/connections/:slug/request", {
        pathParams: { slug: getFormString(formData, "slug") },
        body: {
          method: readHttpMethod(getFormString(formData, "method")),
          path: getFormString(formData, "path"),
          ...(parseJsonObject(getFormString(formData, "query"), "Query")
            ? { query: parseJsonObject(getFormString(formData, "query"), "Query") }
            : {}),
          ...(parseJsonObject(getFormString(formData, "headers"), "Headers")
            ? { headers: parseJsonObject(getFormString(formData, "headers"), "Headers") }
            : {}),
          ...(jsonBody === undefined ? {} : { json: jsonBody }),
          ...(getFormString(formData, "body") ? { body: getFormString(formData, "body") } : {}),
          ...(getFormString(formData, "timeoutMs")
            ? { timeoutMs: Number(getFormString(formData, "timeoutMs")) }
            : {}),
        },
      });
      if (response.type === "json" && isSuccessResponse(response)) {
        return {
          ok: true,
          intent,
          message: "API request completed.",
          requestResult: {
            connectionSlug: getFormString(formData, "slug"),
            ...(response.data as Omit<ApiRequestResult, "connectionSlug">),
          },
        } satisfies ApiActionData;
      }
      return { ok: false, intent, message: routeResponseMessage(response) } satisfies ApiActionData;
    }

    if (intent === "save-webhook") {
      const endpointId = getFormString(formData, "endpointId");
      const response = await callRoute("PUT", "/webhooks/endpoints/:endpointId", {
        pathParams: { endpointId },
        body: {
          name: getFormString(formData, "name"),
          status: readWebhookStatus(getFormString(formData, "status")),
          deliveryIdentity: readWebhookDeliveryIdentity(formData),
          auth: readWebhookAuth(formData),
        },
      });
      if (response.type === "json" && isSuccessResponse(response)) {
        return redirect(`?tab=webhooks&webhook=${encodeURIComponent(endpointId)}`);
      }
      return { ok: false, intent, message: routeResponseMessage(response) } satisfies ApiActionData;
    }

    if (intent === "update-webhook-status") {
      const response = await callRoute("PATCH", "/webhooks/endpoints/:endpointId", {
        pathParams: { endpointId: getFormString(formData, "endpointId") },
        body: { status: readWebhookStatus(getFormString(formData, "status")) },
      });
      if (response.type === "json" && isSuccessResponse(response)) {
        return { ok: true, intent, message: "Webhook status updated." } satisfies ApiActionData;
      }
      return { ok: false, intent, message: routeResponseMessage(response) } satisfies ApiActionData;
    }

    if (intent === "delete-webhook") {
      const response = await callRoute("DELETE", "/webhooks/endpoints/:endpointId", {
        pathParams: { endpointId: getFormString(formData, "endpointId") },
      });
      if (isSuccessResponse(response)) {
        return { ok: true, intent, message: "Webhook endpoint deleted." } satisfies ApiActionData;
      }
      return { ok: false, intent, message: routeResponseMessage(response) } satisfies ApiActionData;
    }

    return { ok: false, intent, message: "Unknown API action." } satisfies ApiActionData;
  } catch (error) {
    return {
      ok: false,
      intent,
      message: error instanceof Error ? error.message : "Unable to update API configuration.",
    } satisfies ApiActionData;
  }
}

const tabButtonClass = (active: boolean) =>
  active
    ? "border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] text-[var(--bo-accent-fg)]"
    : "border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] text-[var(--bo-muted)] hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]";

function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="grid gap-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-1 md:auto-cols-fr md:grid-flow-col">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => {
            onChange(option.value);
          }}
          className={`min-h-10 border px-3 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase transition-colors active:scale-[0.96] ${tabButtonClass(value === option.value)}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function CompactSegmentedControl<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="grid auto-cols-fr grid-flow-col border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)]">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => {
            onChange(option.value);
          }}
          className={`min-h-9 border-r border-[color:var(--bo-border)] px-2 text-[10px] font-semibold tracking-[0.12em] uppercase last:border-r-0 active:scale-[0.96] ${
            value === option.value
              ? "bg-[var(--bo-accent-bg)] text-[var(--bo-accent-fg)]"
              : "text-[var(--bo-muted)] hover:text-[var(--bo-fg)]"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

const inputClass =
  "w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] outline-none placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)]";
const selectClass = inputClass;

function ConnectionConfigureForm({
  authMode,
  setAuthMode,
  saving,
}: {
  authMode: ConnectionAuthMode;
  setAuthMode: (mode: ConnectionAuthMode) => void;
  saving: boolean;
}) {
  const needsTokenEndpoint = authMode === "oauth" || authMode === "client_credentials";
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4">
      <div>
        <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
          Configure
        </p>
        <h2 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">External API connection</h2>
        <p className="mt-2 max-w-3xl text-sm text-[var(--bo-muted)]">
          Register an outbound HTTP API base URL. Automations can call relative paths through this
          connection without handling credentials in scripts.
        </p>
      </div>

      <div className="mt-4">
        <SegmentedControl
          value={authMode}
          onChange={setAuthMode}
          options={[
            { value: "none", label: "No auth" },
            { value: "bearer", label: "Bearer" },
            { value: "oauth", label: "OAuth" },
            { value: "client_credentials", label: "Client creds" },
          ]}
        />
      </div>

      <Form method="post" className="mt-4 min-h-0 flex-1 overflow-auto pr-1">
        <input type="hidden" name="intent" value="add-connection" />
        <input type="hidden" name="authMode" value={authMode} />
        <div className="grid gap-4 md:grid-cols-2">
          <FormField label="Slug" hint="Stable lowercase id used by automation scripts.">
            <input name="slug" required placeholder="stripe" className={inputClass} />
          </FormField>
          <FormField label="Display name" hint="Optional.">
            <input name="name" placeholder="Stripe" className={inputClass} />
          </FormField>
          <FormField label="Base URL" hint="Requests use relative paths under this origin.">
            <input
              name="baseUrl"
              type="url"
              required
              placeholder="https://api.stripe.com"
              className={inputClass}
            />
          </FormField>

          {authMode === "bearer" ? (
            <FormField label="Bearer token" hint="Stored server-side for this connection.">
              <input
                name="token"
                type="password"
                required
                placeholder="sk_..."
                className={inputClass}
              />
            </FormField>
          ) : null}

          {authMode === "oauth" ? (
            <FormField label="Authorization endpoint" hint="Provider OAuth authorization URL.">
              <input name="authorizationEndpoint" type="url" required className={inputClass} />
            </FormField>
          ) : null}

          {needsTokenEndpoint ? (
            <>
              <FormField label="Token endpoint" hint="Provider token URL.">
                <input name="tokenEndpoint" type="url" required className={inputClass} />
              </FormField>
              <FormField label="Client ID">
                <input name="clientId" required className={inputClass} />
              </FormField>
              <FormField
                label="Client secret"
                hint={authMode === "oauth" ? "Optional for public PKCE clients." : undefined}
              >
                <input
                  name="clientSecret"
                  type="password"
                  required={authMode === "client_credentials"}
                  className={inputClass}
                />
              </FormField>
              <FormField label="Scopes" hint="Space or comma separated.">
                <input name="scopes" placeholder="read write" className={inputClass} />
              </FormField>
              {authMode === "client_credentials" ? (
                <FormField label="Audience" hint="Optional token audience.">
                  <input name="audience" className={inputClass} />
                </FormField>
              ) : null}
              <FormField label="Token endpoint auth method">
                <select
                  name="tokenEndpointAuthMethod"
                  className={selectClass}
                  defaultValue="client_secret_basic"
                >
                  <option value="client_secret_basic">client_secret_basic</option>
                  <option value="client_secret_post">client_secret_post</option>
                  {authMode === "oauth" ? <option value="none">none / PKCE</option> : null}
                </select>
              </FormField>
            </>
          ) : null}
        </div>
        <button
          type="submit"
          disabled={saving}
          className="mt-4 w-full border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[11px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase transition-transform active:scale-[0.96] disabled:opacity-60"
        >
          {saving ? "Saving…" : "Save API connection"}
        </button>
      </Form>
    </div>
  );
}

function ConnectionDetail({
  connection,
  requestResult,
  submittingIntent,
}: {
  connection: ApiConnectionSummary;
  requestResult: ApiRequestResult | undefined;
  submittingIntent: FormDataEntryValue | null | undefined;
}) {
  const auth = connection.authStatus;
  const [editingAuth, setEditingAuth] = useState(false);
  const [headersValue, setHeadersValue] = useState('{"Accept":"application/json"}');
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4">
      <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
              Connection
            </p>
            <h2 className="mt-2 text-2xl leading-tight font-semibold text-[var(--bo-fg)]">
              {connection.name || connection.slug}
            </h2>
            <p className="mt-2 text-sm break-all text-[var(--bo-muted)]">{connection.baseUrl}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                setEditingAuth((editing) => !editing);
              }}
              className="min-h-10 border border-[color:var(--bo-border)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase active:scale-[0.96]"
            >
              {editingAuth ? "Close edit" : "Edit"}
            </button>
            <Form method="post">
              <input type="hidden" name="intent" value="delete-connection" />
              <input type="hidden" name="slug" value={connection.slug} />
              <button
                type="submit"
                className="min-h-10 border border-red-500/40 px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-red-500 uppercase active:scale-[0.96]"
              >
                Delete
              </button>
            </Form>
          </div>
        </div>

        <div className="mt-4 grid gap-2 text-sm text-[var(--bo-muted)] md:grid-cols-2">
          <p>Auth: {connection.authMode}</p>
          <p>Status: {connection.status}</p>
          <p>Updated: {formatMaybeDate(connection.updatedAt)}</p>
          <p>Script id: {connection.slug}</p>
          {connection.authError ? <p className="text-red-500">{connection.authError}</p> : null}
          {auth ? (
            <p>
              {auth.authenticated ? "Authenticated" : "Needs auth"}
              {auth.expiresAt ? ` · expires ${formatMaybeDate(auth.expiresAt)}` : ""}
            </p>
          ) : null}
        </div>
      </div>

      {editingAuth ? (
        <div className="mt-4 grid gap-4 xl:grid-cols-2">
          {connection.authMode !== "none" ? (
            <Form
              method="post"
              className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-4"
            >
              <input type="hidden" name="intent" value="delete-auth" />
              <input type="hidden" name="slug" value={connection.slug} />
              <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                Stored auth
              </p>
              <p className="mt-2 text-sm text-[var(--bo-muted)]">
                Clear stored credentials for this connection.
              </p>
              <button
                type="submit"
                className="mt-3 min-h-10 border border-[color:var(--bo-border)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase active:scale-[0.96]"
              >
                Clear
              </button>
            </Form>
          ) : null}
          {connection.authMode === "oauth" ? (
            <Form
              method="post"
              className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-4"
            >
              <input type="hidden" name="intent" value="start-oauth" />
              <input type="hidden" name="slug" value={connection.slug} />
              <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                OAuth
              </p>
              <p className="mt-2 text-sm text-[var(--bo-muted)]">
                Start or restart provider authorization for this connection.
              </p>
              <input name="scopes" placeholder="scope override" className={`${inputClass} mt-3`} />
              <textarea
                name="extraAuthorizationParams"
                placeholder='extra params JSON, e.g. {"prompt":"consent"}'
                className={`${inputClass} mt-3 min-h-20 font-mono text-xs`}
              />
              <button
                type="submit"
                className="mt-3 min-h-10 border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase active:scale-[0.96]"
              >
                Start OAuth
              </button>
            </Form>
          ) : null}

          {connection.authMode === "bearer" ? (
            <Form
              method="post"
              className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-4"
            >
              <input type="hidden" name="intent" value="set-token" />
              <input type="hidden" name="slug" value={connection.slug} />
              <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                Bearer token
              </p>
              <p className="mt-2 text-sm text-[var(--bo-muted)]">
                Replace a missing, expired, or revoked bearer token.
              </p>
              <input
                type="password"
                name="token"
                required
                placeholder="Bearer token"
                className={`${inputClass} mt-3`}
              />
              <button
                type="submit"
                className="mt-3 min-h-10 border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase active:scale-[0.96]"
              >
                Save token
              </button>
            </Form>
          ) : null}
        </div>
      ) : null}

      <Form
        method="post"
        className="mt-4 min-h-0 flex-1 overflow-auto border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-4"
      >
        <input type="hidden" name="intent" value="execute-request" />
        <input type="hidden" name="slug" value={connection.slug} />
        <div className="flex flex-wrap items-end gap-3">
          <FormField label="Method">
            <select name="method" defaultValue="GET" className={selectClass}>
              {["GET", "POST", "PUT", "PATCH", "DELETE"].map((method) => (
                <option key={method} value={method}>
                  {method}
                </option>
              ))}
            </select>
          </FormField>
          <div className="min-w-72 flex-1">
            <FormField label="Path" hint="Relative to base URL.">
              <input name="path" required placeholder="/v1/customers" className={inputClass} />
            </FormField>
          </div>
          <FormField label="Timeout ms">
            <input
              name="timeoutMs"
              type="number"
              min="1"
              max="120000"
              placeholder="30000"
              className={inputClass}
            />
          </FormField>
        </div>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <FormField label="Query JSON" hint='Example: {"limit":"10"}'>
            <textarea name="query" className={`${inputClass} min-h-24 font-mono text-xs`} />
          </FormField>
          <div className="space-y-2 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[11px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                Headers JSON
              </span>
              <button
                type="button"
                onClick={() => {
                  setHeadersValue("");
                }}
                className="text-[10px] font-semibold tracking-[0.18em] text-[var(--bo-accent)] uppercase"
              >
                Clear
              </button>
            </div>
            <textarea
              name="headers"
              value={headersValue}
              onChange={(event) => {
                setHeadersValue(event.currentTarget.value);
              }}
              className={`${inputClass} min-h-24 font-mono text-xs`}
            />
          </div>
          <FormField label="Body">
            <textarea name="json" className={`${inputClass} min-h-28 font-mono text-xs`} />
          </FormField>
        </div>
        <button
          type="submit"
          className="mt-4 w-full border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[11px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase active:scale-[0.96]"
        >
          {submittingIntent === "execute-request" ? "Sending…" : "Send test request"}
        </button>
        {requestResult?.connectionSlug === connection.slug ? (
          <div className="mt-4 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3">
            <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
              Response
            </p>
            <p className="mt-2 text-sm font-semibold text-[var(--bo-fg)]">
              {requestResult.status} {requestResult.statusText}
            </p>
            <pre className="mt-3 max-h-96 overflow-auto bg-[var(--bo-panel-2)] p-3 font-mono text-[11px] whitespace-pre text-[var(--bo-fg)]">
              <code>{JSON.stringify(requestResult.body, null, 2)}</code>
            </pre>
          </div>
        ) : null}
      </Form>
    </div>
  );
}

function WebhookConfigureForm({
  authMode,
  setAuthMode,
  deliveryMode,
  setDeliveryMode,
  signedPayloadMode,
  setSignedPayloadMode,
  saving,
  publicBaseUrl,
  endpoint,
}: {
  authMode: WebhookAuthMode;
  setAuthMode: (mode: WebhookAuthMode) => void;
  deliveryMode: DeliveryIdentityMode;
  setDeliveryMode: (mode: DeliveryIdentityMode) => void;
  signedPayloadMode: SignedPayloadMode;
  setSignedPayloadMode: (mode: SignedPayloadMode) => void;
  saving: boolean;
  publicBaseUrl: string | null;
  endpoint?: ApiWebhookEndpointSummary | null;
}) {
  const [name, setName] = useState(endpoint?.name ?? "");
  const [hmacAlgorithm, setHmacAlgorithm] = useState<HmacAlgorithm>("sha256");
  const [hmacEncoding, setHmacEncoding] = useState<HmacEncoding>("hex");
  useEffect(() => {
    setName(endpoint?.name ?? "");
    if (endpoint?.authConfig.type === "hmac") {
      setHmacAlgorithm(endpoint.authConfig.algorithm);
      setHmacEncoding(endpoint.authConfig.signature.encoding);
    }
  }, [endpoint]);

  const endpointId = endpoint?.id ?? slugifyEndpointId(name);
  const endpointUrl = webhookPublicUrl(publicBaseUrl, endpointId);
  const [copiedWebhookUrl, setCopiedWebhookUrl] = useState(false);

  const copyWebhookUrl = async () => {
    if (!endpointUrl) {
      return;
    }
    await navigator.clipboard.writeText(endpointUrl);
    setCopiedWebhookUrl(true);
    window.setTimeout(() => {
      setCopiedWebhookUrl(false);
    }, 1600);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4">
      <div>
        <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
          Configure
        </p>
        <h2 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">Webhook endpoint</h2>
        <p className="mt-2 max-w-3xl text-sm text-[var(--bo-muted)]">
          Create a stable public receiving URL, choose the provider delivery id, and add auth before
          activating.
        </p>
      </div>

      <Form method="post" className="mt-4 min-h-0 flex-1 overflow-auto pr-1">
        <input type="hidden" name="intent" value="save-webhook" />
        <input type="hidden" name="webhookAuthMode" value={authMode} />
        <input type="hidden" name="deliveryMode" value={deliveryMode} />
        <input type="hidden" name="signedPayloadMode" value={signedPayloadMode} />
        <input type="hidden" name="endpointId" value={endpointId} />
        <div className="grid gap-4 md:grid-cols-2">
          <FormField label="Display name">
            <input
              name="name"
              required
              placeholder="Stripe webhooks"
              value={name}
              onChange={(event) => {
                setName(event.currentTarget.value);
              }}
              className={inputClass}
            />
          </FormField>
          <FormField label="Endpoint ID">
            <input
              value={endpointId}
              readOnly
              placeholder="Generated from display name"
              className={inputClass}
            />
          </FormField>
          <FormField label="Status" hint="Draft reserves the URL but rejects deliveries.">
            <select
              name="status"
              defaultValue={endpoint?.status ?? "draft"}
              className={selectClass}
            >
              <option value="draft">draft</option>
              <option value="active">active</option>
              <option value="disabled">disabled</option>
            </select>
          </FormField>
        </div>

        <div className="mt-4 border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] p-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[10px] tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase">
              Webhook URL
            </p>
            {endpointUrl ? (
              <button
                type="button"
                onClick={() => void copyWebhookUrl()}
                className="border border-[color:var(--bo-accent)] px-2 py-1 text-[10px] font-semibold tracking-[0.18em] text-[var(--bo-accent-fg)] uppercase enabled:active:scale-[0.96]"
              >
                {copiedWebhookUrl ? "Copied" : "Copy"}
              </button>
            ) : null}
          </div>
          <p className="mt-2 font-mono text-xs break-all text-[var(--bo-accent-fg)]">
            {endpointUrl ?? "Enter a display name to generate the public webhook URL."}
          </p>
        </div>

        <div className="mt-5 space-y-3">
          <div>
            <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
              Delivery identity
            </p>
            <p className="mt-1 text-xs text-[var(--bo-muted)]">
              Used as the idempotency key so duplicate provider deliveries can be safely deduped.
            </p>
          </div>
          <SegmentedControl
            value={deliveryMode}
            onChange={setDeliveryMode}
            options={[
              { value: "header", label: "Header" },
              { value: "query", label: "Query" },
              { value: "jsonBodyPath", label: "JSON path" },
            ]}
          />
          {deliveryMode === "jsonBodyPath" ? (
            <FormField
              label="JSON body path"
              hint="Dot or comma separated path to provider delivery id."
            >
              <input
                name="deliveryJsonPath"
                defaultValue={
                  endpoint?.deliveryIdentity.type === "jsonBodyPath"
                    ? endpoint.deliveryIdentity.path.join(".")
                    : undefined
                }
                placeholder="event.id"
                className={inputClass}
              />
            </FormField>
          ) : (
            <FormField label={`${deliveryMode === "header" ? "Header" : "Query"} name`}>
              <input
                name="deliveryName"
                defaultValue={
                  endpoint?.deliveryIdentity.type === "header" ||
                  endpoint?.deliveryIdentity.type === "query"
                    ? endpoint.deliveryIdentity.name
                    : undefined
                }
                placeholder={deliveryMode === "header" ? "x-delivery-id" : "delivery_id"}
                className={inputClass}
              />
            </FormField>
          )}
        </div>

        <div className="mt-5 space-y-3">
          <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
            Webhook auth
          </p>
          <SegmentedControl
            value={authMode}
            onChange={setAuthMode}
            options={[
              { value: "none", label: "None" },
              { value: "bearer", label: "Bearer" },
              { value: "apiKey", label: "API key" },
              { value: "basic", label: "Basic" },
              { value: "hmac", label: "HMAC" },
            ]}
          />
          {authMode === "none" ? (
            <p className="text-sm text-[var(--bo-muted)]">
              No shared secret is checked. Use this only when the provider cannot sign or
              authenticate deliveries.
            </p>
          ) : null}
          {authMode === "bearer" ? (
            <>
              <p className="text-sm text-[var(--bo-muted)]">
                The provider must send an Authorization header with this bearer token on every
                delivery.
              </p>
              <FormField label="Bearer token">
                <input type="password" name="webhookBearerToken" required className={inputClass} />
              </FormField>
            </>
          ) : authMode === "apiKey" ? (
            <>
              <p className="text-sm text-[var(--bo-muted)]">
                The provider must include a fixed secret either in a request header or query
                parameter.
              </p>
              <div className="grid gap-4 md:grid-cols-3">
                <FormField label="Location">
                  <select
                    name="apiKeyLocation"
                    className={selectClass}
                    defaultValue={
                      endpoint?.authConfig.type === "apiKey"
                        ? endpoint.authConfig.location
                        : "header"
                    }
                  >
                    <option value="header">header</option>
                    <option value="query">query</option>
                  </select>
                </FormField>
                <FormField label="Name">
                  <input
                    name="apiKeyName"
                    required
                    defaultValue={
                      endpoint?.authConfig.type === "apiKey" ? endpoint.authConfig.name : undefined
                    }
                    className={inputClass}
                  />
                </FormField>
                <FormField label="Secret">
                  <input type="password" name="apiKeySecret" required className={inputClass} />
                </FormField>
              </div>
            </>
          ) : authMode === "basic" ? (
            <>
              <p className="text-sm text-[var(--bo-muted)]">
                The provider must send HTTP Basic authentication credentials with each delivery.
              </p>
              <div className="grid gap-4 md:grid-cols-2">
                <FormField label="Username">
                  <input name="basicUsername" required className={inputClass} />
                </FormField>
                <FormField label="Password">
                  <input type="password" name="basicPassword" required className={inputClass} />
                </FormField>
              </div>
            </>
          ) : authMode === "hmac" ? (
            <div className="space-y-4">
              <p className="text-sm text-[var(--bo-muted)]">
                The provider signs each delivery with a shared secret; Backoffice recomputes the
                signature before accepting it.
              </p>
              <input type="hidden" name="hmacAlgorithm" value={hmacAlgorithm} />
              <input type="hidden" name="signatureEncoding" value={hmacEncoding} />
              <div className="grid gap-4 md:grid-cols-3">
                <FormField label="Secret" hint="Shared signing secret.">
                  <input type="password" name="hmacSecret" required className={inputClass} />
                </FormField>
                <div className="space-y-2">
                  <p className="text-[11px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                    Algorithm
                  </p>
                  <p className="text-xs text-[var(--bo-muted)]">
                    Hash function used for the signature.
                  </p>
                  <CompactSegmentedControl
                    value={hmacAlgorithm}
                    onChange={setHmacAlgorithm}
                    options={[
                      { value: "sha1", label: "SHA-1" },
                      { value: "sha256", label: "SHA-256" },
                      { value: "sha512", label: "SHA-512" },
                    ]}
                  />
                </div>
                <div className="space-y-2">
                  <p className="text-[11px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                    Encoding
                  </p>
                  <p className="text-xs text-[var(--bo-muted)]">
                    How the provider formats the signature value.
                  </p>
                  <CompactSegmentedControl
                    value={hmacEncoding}
                    onChange={setHmacEncoding}
                    options={[
                      { value: "hex", label: "Hex" },
                      { value: "base64", label: "Base64" },
                      { value: "base64url", label: "Base64URL" },
                    ]}
                  />
                </div>
                <FormField label="Signature location" hint="Where to read the signature.">
                  <select
                    name="signatureLocation"
                    defaultValue={
                      endpoint?.authConfig.type === "hmac"
                        ? endpoint.authConfig.signature.location
                        : "header"
                    }
                    className={selectClass}
                  >
                    <option value="header">header</option>
                    <option value="query">query</option>
                  </select>
                </FormField>
                <FormField label="Signature name" hint="Header or query key.">
                  <input
                    name="signatureName"
                    required
                    defaultValue={
                      endpoint?.authConfig.type === "hmac"
                        ? endpoint.authConfig.signature.name
                        : undefined
                    }
                    placeholder="x-signature"
                    className={inputClass}
                  />
                </FormField>
                <FormField label="Signature prefix" hint="Optional, e.g. sha256=.">
                  <input
                    name="signaturePrefix"
                    defaultValue={
                      endpoint?.authConfig.type === "hmac"
                        ? endpoint.authConfig.signature.prefix
                        : undefined
                    }
                    className={inputClass}
                  />
                </FormField>
              </div>
              <div className="space-y-2">
                <p className="text-[11px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                  Signed payload
                </p>
                <p className="text-xs text-[var(--bo-muted)]">
                  {signedPayloadMode === "rawBody"
                    ? "Raw body signs exactly the bytes sent by the provider."
                    : "Timestamp + body signs the timestamp, a delimiter, and the raw request body to reduce replay risk."}
                </p>
                <SegmentedControl
                  value={signedPayloadMode}
                  onChange={setSignedPayloadMode}
                  options={[
                    { value: "rawBody", label: "Raw body" },
                    { value: "timestampBody", label: "Timestamp + body" },
                  ]}
                />
              </div>
              {signedPayloadMode === "timestampBody" ? (
                <div className="grid gap-4 md:grid-cols-3">
                  <FormField label="Timestamp header" hint="Header containing provider time.">
                    <input
                      name="timestampHeader"
                      required
                      defaultValue={
                        endpoint?.authConfig.type === "hmac" &&
                        endpoint.authConfig.signedPayload.type === "timestampBody"
                          ? endpoint.authConfig.signedPayload.timestampHeader
                          : undefined
                      }
                      placeholder="x-timestamp"
                      className={inputClass}
                    />
                  </FormField>
                  <FormField label="Delimiter" hint="Placed between timestamp and body.">
                    <input
                      name="timestampDelimiter"
                      defaultValue={
                        endpoint?.authConfig.type === "hmac" &&
                        endpoint.authConfig.signedPayload.type === "timestampBody"
                          ? endpoint.authConfig.signedPayload.delimiter
                          : "."
                      }
                      className={inputClass}
                    />
                  </FormField>
                  <FormField label="Tolerance seconds" hint="Maximum clock drift allowed.">
                    <input
                      name="toleranceSeconds"
                      type="number"
                      min="1"
                      defaultValue={
                        endpoint?.authConfig.type === "hmac" &&
                        endpoint.authConfig.signedPayload.type === "timestampBody"
                          ? endpoint.authConfig.signedPayload.toleranceSeconds
                          : 300
                      }
                      className={inputClass}
                    />
                  </FormField>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <button
          type="submit"
          disabled={saving || !endpointId}
          className="mt-5 w-full border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[11px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase transition-transform enabled:active:scale-[0.96] disabled:opacity-60"
        >
          {saving ? "Saving…" : "Save webhook endpoint"}
        </button>
      </Form>
    </div>
  );
}

function WebhookDetail({
  endpoint,
  publicBaseUrl,
  authMode,
  setAuthMode,
  deliveryMode,
  setDeliveryMode,
  signedPayloadMode,
  setSignedPayloadMode,
  saving,
}: {
  endpoint: ApiWebhookEndpointSummary;
  publicBaseUrl: string | null;
  authMode: WebhookAuthMode;
  setAuthMode: (mode: WebhookAuthMode) => void;
  deliveryMode: DeliveryIdentityMode;
  setDeliveryMode: (mode: DeliveryIdentityMode) => void;
  signedPayloadMode: SignedPayloadMode;
  setSignedPayloadMode: (mode: SignedPayloadMode) => void;
  saving: boolean;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4">
      <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
              Webhook endpoint
            </p>
            <h2 className="mt-2 text-2xl leading-tight font-semibold text-[var(--bo-fg)]">
              {endpoint.name}
            </h2>
            <p className="mt-2 font-mono text-xs break-all text-[var(--bo-muted)]">
              {endpoint.publicUrl ?? "Public URL unavailable"}
            </p>
          </div>
          <Form method="post">
            <input type="hidden" name="intent" value="delete-webhook" />
            <input type="hidden" name="endpointId" value={endpoint.id} />
            <button
              type="submit"
              className="min-h-10 border border-red-500/40 px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-red-500 uppercase active:scale-[0.96]"
            >
              Delete
            </button>
          </Form>
        </div>
      </div>

      <div className="mt-4 min-h-0 flex-1 overflow-auto">
        <WebhookConfigureForm
          authMode={authMode}
          setAuthMode={setAuthMode}
          deliveryMode={deliveryMode}
          setDeliveryMode={setDeliveryMode}
          signedPayloadMode={signedPayloadMode}
          setSignedPayloadMode={setSignedPayloadMode}
          saving={saving}
          publicBaseUrl={publicBaseUrl}
          endpoint={endpoint}
        />
      </div>
    </div>
  );
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-8 text-center">
      <div>
        <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
          Nothing selected
        </p>
        <h2 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">{title}</h2>
        <p className="mt-2 max-w-md text-sm text-[var(--bo-muted)]">{description}</p>
      </div>
    </div>
  );
}

export default function BackofficeAutomationApiConfiguration() {
  const { publicBaseUrl, connections, webhooks, connectionsError, webhooksError, configError } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const [searchParams] = useSearchParams();
  const [connectionAuthMode, setConnectionAuthMode] = useState<ConnectionAuthMode>("none");
  const [webhookAuthMode, setWebhookAuthMode] = useState<WebhookAuthMode>("none");
  const [deliveryMode, setDeliveryMode] = useState<DeliveryIdentityMode>("jsonBodyPath");
  const [signedPayloadMode, setSignedPayloadMode] = useState<SignedPayloadMode>("rawBody");

  const activePane = searchParams.get("tab") === "webhooks" ? "webhooks" : "connections";
  const configure = searchParams.get("configure");
  const selectedConnection =
    connections.find((connection) => connection.slug === searchParams.get("connection")) ?? null;
  const selectedWebhook =
    webhooks.find((webhook) => webhook.id === searchParams.get("webhook")) ?? null;

  useEffect(() => {
    if (!selectedWebhook) {
      return;
    }
    setWebhookAuthMode(webhookAuthModeFromConfig(selectedWebhook.authConfig));
    setDeliveryMode(deliveryModeFromIdentity(selectedWebhook.deliveryIdentity));
    setSignedPayloadMode(signedPayloadModeFromAuth(selectedWebhook.authConfig));
  }, [selectedWebhook]);

  const submittingIntent = navigation.formData?.get("intent");
  const saving = navigation.state === "submitting";
  const saveError = actionData && !actionData.ok ? actionData.message : null;
  const saveSuccess = actionData?.ok ? actionData.message : null;

  const visibleItems = useMemo(
    () => (activePane === "connections" ? connections : webhooks),
    [activePane, connections, webhooks],
  );

  if (configError) {
    return (
      <div className="border border-red-500/40 bg-red-500/5 p-4 text-sm text-red-500">
        API capability could not be initialized: {configError}
      </div>
    );
  }

  return (
    <section className="grid min-h-[min(820px,calc(100vh-15rem))] grid-rows-1 gap-4 lg:grid-cols-[minmax(300px,400px)_minmax(0,1fr)]">
      <div className="flex min-h-0 flex-col gap-4 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4">
        <div>
          <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">API</p>
          <h2 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">Connections & webhooks</h2>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Link
            to="?tab=connections"
            preventScrollReset
            className={`border px-3 py-2 text-center text-[10px] font-semibold tracking-[0.22em] uppercase ${tabButtonClass(activePane === "connections")}`}
          >
            Connections
          </Link>
          <Link
            to="?tab=webhooks"
            preventScrollReset
            className={`border px-3 py-2 text-center text-[10px] font-semibold tracking-[0.22em] uppercase ${tabButtonClass(activePane === "webhooks")}`}
          >
            Webhooks
          </Link>
        </div>

        <Link
          to={
            activePane === "connections"
              ? "?tab=connections&configure=connection"
              : "?tab=webhooks&configure=webhook"
          }
          preventScrollReset
          className={`block border px-3 py-3 text-left ${tabButtonClass(configure === (activePane === "connections" ? "connection" : "webhook"))}`}
        >
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-semibold text-[var(--bo-fg)]">
              {activePane === "connections"
                ? "Configure API connection"
                : "Configure webhook endpoint"}
            </p>
            <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-2 py-1 text-[9px] tracking-[0.22em] uppercase">
              New
            </span>
          </div>
        </Link>

        {connectionsError && activePane === "connections" ? (
          <p className="text-sm text-red-500">{connectionsError}</p>
        ) : null}
        {webhooksError && activePane === "webhooks" ? (
          <p className="text-sm text-red-500">{webhooksError}</p>
        ) : null}

        <div className="min-h-0 flex-1 overflow-auto pr-1">
          <div className="space-y-2">
            {visibleItems.length === 0 ? (
              <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-4 text-sm text-[var(--bo-muted)]">
                No {activePane === "connections" ? "API connections" : "webhook endpoints"}{" "}
                configured yet.
              </div>
            ) : activePane === "connections" ? (
              connections.map((connection) => {
                const isSelected =
                  selectedConnection?.slug === connection.slug && configure !== "connection";
                return (
                  <Link
                    key={connection.slug}
                    to={selectedConnectionPath(connection.slug)}
                    preventScrollReset
                    aria-current={isSelected ? "page" : undefined}
                    className={`block border px-3 py-3 text-left ${tabButtonClass(isSelected)}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-[var(--bo-fg)]">
                          {connection.name || connection.slug}
                        </p>
                        <p className="mt-1 truncate text-xs text-[var(--bo-muted-2)]">
                          {connection.baseUrl}
                        </p>
                      </div>
                      <span className="shrink-0 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-2 py-1 text-[9px] tracking-[0.22em] uppercase">
                        {connection.authMode}
                      </span>
                    </div>
                  </Link>
                );
              })
            ) : (
              webhooks.map((webhook) => {
                const isSelected = selectedWebhook?.id === webhook.id && configure !== "webhook";
                return (
                  <Link
                    key={webhook.id}
                    to={selectedWebhookPath(webhook.id)}
                    preventScrollReset
                    aria-current={isSelected ? "page" : undefined}
                    className={`block border px-3 py-3 text-left ${tabButtonClass(isSelected)}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-[var(--bo-fg)]">
                          {webhook.name}
                        </p>
                        <p className="mt-1 truncate text-xs text-[var(--bo-muted-2)]">
                          {webhook.id}
                        </p>
                      </div>
                      <span className="shrink-0 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-2 py-1 text-[9px] tracking-[0.22em] uppercase">
                        {webhook.status}
                      </span>
                    </div>
                  </Link>
                );
              })
            )}
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-col gap-3">
        {saveError ? (
          <div className="border border-red-500/40 bg-red-500/5 p-3 text-sm text-red-500">
            {saveError}
          </div>
        ) : null}
        {saveSuccess ? (
          <div className="border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] p-3 text-sm text-[var(--bo-accent-fg)]">
            {saveSuccess}
            {actionData?.authorizationUrl ? (
              <>
                {" "}
                <a
                  href={actionData.authorizationUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  Open authorization page
                </a>
              </>
            ) : null}
          </div>
        ) : null}

        {activePane === "connections" && configure === "connection" ? (
          <ConnectionConfigureForm
            authMode={connectionAuthMode}
            setAuthMode={setConnectionAuthMode}
            saving={saving && submittingIntent === "add-connection"}
          />
        ) : activePane === "webhooks" && configure === "webhook" ? (
          <WebhookConfigureForm
            authMode={webhookAuthMode}
            setAuthMode={setWebhookAuthMode}
            deliveryMode={deliveryMode}
            setDeliveryMode={setDeliveryMode}
            signedPayloadMode={signedPayloadMode}
            setSignedPayloadMode={setSignedPayloadMode}
            saving={saving && submittingIntent === "save-webhook"}
            publicBaseUrl={publicBaseUrl}
            endpoint={null}
          />
        ) : activePane === "connections" && selectedConnection ? (
          <ConnectionDetail
            connection={selectedConnection}
            requestResult={actionData?.requestResult}
            submittingIntent={submittingIntent}
          />
        ) : activePane === "webhooks" && selectedWebhook ? (
          <WebhookDetail
            endpoint={selectedWebhook}
            publicBaseUrl={publicBaseUrl}
            authMode={webhookAuthMode}
            setAuthMode={setWebhookAuthMode}
            deliveryMode={deliveryMode}
            setDeliveryMode={setDeliveryMode}
            signedPayloadMode={signedPayloadMode}
            setSignedPayloadMode={setSignedPayloadMode}
            saving={saving && submittingIntent === "save-webhook"}
          />
        ) : activePane === "connections" ? (
          <EmptyState
            title="Select a connection or configure a new one."
            description="Auth status, OAuth controls, token replacement, and test requests appear here."
          />
        ) : (
          <EmptyState
            title="Select a webhook or configure a new one."
            description="Public URL, delivery identity, authentication, and activation controls appear here."
          />
        )}
      </div>
    </section>
  );
}
