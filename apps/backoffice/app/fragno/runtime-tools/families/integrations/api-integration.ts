import {
  API_OAUTH_REDIRECT_URI_QUERY_PARAMETER,
  apiAuthStatusSchema,
  apiConnectionOutputSchema,
  apiConnectionSlugSchema,
  apiRequestInputSchema,
  apiRequestOutputSchema,
  authConfigSchema,
  createApiConnectionInputSchema,
  tokenAuthInputSchema,
  type ApiAuthStatus,
} from "@fragno-dev/api-fragment/types";
import { createRouteCaller } from "@fragno-dev/core/api";
import { z } from "zod";

import { authorizedBackofficeObjectHttp } from "@/backoffice-runtime/authorized-object-http";
import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import { BackofficeUnavailableError } from "@/backoffice-runtime/kernel";
import { isBackofficeObjectAvailableInContext } from "@/backoffice-runtime/object-registry";
import {
  BACKOFFICE_PERMISSION,
  type BackofficePermissionRequirement,
} from "@/backoffice-runtime/permissions";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import type { ApiFragment } from "@/fragno/api";
import { apiCapability } from "@/fragno/backoffice-capabilities/capabilities/api";
import { apiPublicAddress } from "@/fragno/scoped-public-fragment-routes";
import { jsonValueSchema } from "@/lib/zod/json-value";

import { isSuccessStatus, throwOnRouteRuntimeError } from "../../runtime-errors";
import { resolveRuntimePublicScopePathSegment } from "../../runtime-public-scope";
import type { IntegrationInspection, IntegrationSetupProgress } from "./integration-contracts";
import type { IntegrationContext, IntegrationImplementation } from "./integration-implementation";

const apiIntegrationId = "api";
const apiConnectionShape = createApiConnectionInputSchema.omit({ auth: true }).shape;
const [noAuth, bearerAuth, basicAuth, clientCredentialsAuth, oauthAuth] = authConfigSchema.options;
// Flat variants keep secrets top-level, where secretFields can name them for input controls.
const apiSetupConnectionInputSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...apiConnectionShape, ...noAuth.shape }),
  z.strictObject({ ...apiConnectionShape, ...bearerAuth.shape }),
  z.strictObject({ ...apiConnectionShape, ...basicAuth.shape }),
  z.strictObject({ ...apiConnectionShape, ...clientCredentialsAuth.shape }),
  z.strictObject({ ...apiConnectionShape, ...oauthAuth.shape }),
]);
type ApiSetupConnectionInput = z.output<typeof apiSetupConnectionInputSchema>;
const apiSetupSecretFields = ["token", "password", "clientSecret"] as const satisfies readonly (
  | keyof z.input<typeof bearerAuth>
  | keyof z.input<typeof basicAuth>
  | keyof z.input<typeof clientCredentialsAuth>
)[];
const apiOAuthSetupInputSchema = z.strictObject({
  start: z.literal(true).describe("Explicitly start OAuth consent for this connection."),
});
const apiReauthorizeInputSchema = z.strictObject({
  reauthorize: z
    .literal(true)
    .describe(
      "Discard the stored OAuth tokens and start consent again with the stored client configuration.",
    ),
});
const apiConnectionDescriptionSchema = z.strictObject({
  ...apiConnectionOutputSchema.pick({ slug: true, baseUrl: true, authMode: true, status: true })
    .shape,
  name: z.string().nullable(),
  auth: apiAuthStatusSchema,
});
const apiDescribeActionDefinition = {
  id: "connection.describe",
  label: "Describe connection",
  description:
    "Read the stored base URL, auth mode, connection status, and sanitized auth state without contacting the provider. Request paths are relative to this base URL.",
  inputSchema: z.toJSONSchema(z.strictObject({}), { io: "input" }),
  outputSchema: z.toJSONSchema(apiConnectionDescriptionSchema, { io: "output" }),
};
// The slug comes from the resolved address; requests cannot name another connection.
const apiIntegrationRequestInputSchema = z.strictObject(apiRequestInputSchema.shape);
const apiRequestActionDefinition = {
  id: "request",
  label: "Send HTTP request",
  description:
    "Send one HTTP request relative to the connection's base URL, which connection.describe returns, with its stored authentication. Upstream errors are returned in the result envelope.",
  inputSchema: z.toJSONSchema(apiIntegrationRequestInputSchema, { io: "input" }),
  outputSchema: z.toJSONSchema(apiRequestOutputSchema, { io: "output" }),
};

export function encodeApiConnectionId(slug: string) {
  return `api#${slug}`;
}

/** Projects the source's sanitized auth state; stored credentials never prove live access. */
function inspectApiAuth(status: ApiAuthStatus | null): IntegrationInspection {
  const inspection = (
    authorization: IntegrationInspection["authorization"],
    nextSteps: string[],
  ): IntegrationInspection => ({
    configuration: { status: "configured" },
    authorization,
    checks: [],
    nextSteps,
  });
  if (status === null) {
    return {
      configuration: { status: "missing", missingFields: ["baseUrl", "type"] },
      authorization: { status: "missing" },
      checks: [],
      nextSteps: ["Run setup at this address to create the API connection."],
    };
  }
  if (status.mode === "none") {
    return inspection({ status: "not-required" }, []);
  }
  if (status.mode !== "oauth") {
    if (status.credentials === "present") {
      return inspection({ status: "available" }, []);
    }
    return inspection(
      { status: "missing" },
      status.mode === "bearer"
        ? ["Run setup to provide a bearer token."]
        : ["Run integrations.reconfigure with the full configuration and new credentials."],
    );
  }
  switch (status.state) {
    case "authorized":
      return inspection({ status: "available" }, []);
    case "expired":
      return inspection({ status: "expired" }, ["Run setup to start OAuth consent again."]);
    case "consent-pending":
      return inspection({ status: "missing" }, [
        "Complete the pending OAuth consent; setup returns its link.",
      ]);
    case "consent-required":
      return inspection({ status: "missing" }, ["Run setup to start OAuth consent."]);
    case "client-missing":
      return inspection({ status: "missing" }, [
        "Run integrations.reconfigure with the full OAuth configuration.",
      ]);
    default:
      throw new Error("API integration OAuth state is unsupported.", {
        cause: status.state satisfies never,
      });
  }
}

function connectionBody({ name, baseUrl, ...auth }: ApiSetupConnectionInput) {
  return { ...(name === undefined ? {} : { name }), baseUrl, auth };
}

function describeCallback(callbackUrl: string | null) {
  return callbackUrl === null
    ? "OAuth is unavailable: this deployment has no public origin for OAuth callbacks."
    : `For OAuth, register this exact callback URL in the provider's OAuth app before creating its credentials: ${callbackUrl}`;
}

function describeAuthorization(
  connectionId: string,
  authorizationUrl: string,
): IntegrationSetupProgress {
  // The link carries the callback the provider checks, which can predate a configuration change.
  const callbackUrl = new URL(authorizationUrl).searchParams.get("redirect_uri");
  return {
    connectionId,
    status: "needs-authorization",
    instructions: `Open the authorization link and complete consent, then check setup again. Any pending link for this connection completes it. If the provider rejects the redirect URI, its OAuth app must register this exact callback URL: ${callbackUrl}`,
    authorizationUrl,
  };
}

/** Projects scoped API-fragment connections; configuration, credentials, and OAuth stay in the source. */
export function createApiIntegration({
  runtime,
}: {
  runtime: Pick<BackofficeRuntimeServices, "objects" | "config">;
}): IntegrationImplementation {
  function isApiAvailable(scope: BackofficeContextScope) {
    return runtime.config.bindings.api && isBackofficeObjectAvailableInContext("API", scope);
  }

  function createApiAccess(context: IntegrationContext) {
    if (!isApiAvailable(context.execution.scope)) {
      throw new BackofficeUnavailableError(
        "API integration requires an available organization, user, or project API store.",
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
        runtimeLabel: "API integration",
        label: "API source operation",
      });
    }
    function isConnectionNotFound(response: ApiRouteResponse) {
      return (
        response.type === "error" &&
        response.status === 404 &&
        response.error.code === "CONNECTION_NOT_FOUND"
      );
    }
    async function authStatus(slug: string): Promise<ApiAuthStatus | null> {
      const response = await invoke(BACKOFFICE_PERMISSION.api.connectionsRead, { slug }, () =>
        callRoute("GET", "/connections/:slug/auth/status", { pathParams: { slug } }),
      );
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data;
      }
      return isConnectionNotFound(response) ? null : fail(response);
    }
    async function connection(slug: string) {
      const response = await invoke(BACKOFFICE_PERMISSION.api.connectionsRead, { slug }, () =>
        callRoute("GET", "/connections/:slug", { pathParams: { slug } }),
      );
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data;
      }
      return isConnectionNotFound(response) ? null : fail(response);
    }
    async function pendingAuthorizationUrl(slug: string): Promise<string | null> {
      const response = await invoke(BACKOFFICE_PERMISSION.api.connectionsCreate, { slug }, () =>
        callRoute("GET", "/connections/:slug/auth/oauth/pending", { pathParams: { slug } }),
      );
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data.pending?.authorizationUrl ?? null;
      }
      return fail(response);
    }
    /** Fixed per scope, so callers can register it before the OAuth app exists. */
    async function oauthCallbackUrl(): Promise<string | null> {
      if (runtime.config.docsPublicBaseUrl === undefined) {
        return null;
      }
      return apiPublicAddress(
        runtime.config.docsPublicBaseUrl,
        await resolveRuntimePublicScopePathSegment(runtime, context.execution.scope, "API"),
      ).oauthRedirectUri;
    }
    /** Discarding tokens makes re-consent observable: status stays pending until it completes. */
    async function startOAuth(slug: string, discardTokens: boolean): Promise<string> {
      const redirectUri = await oauthCallbackUrl();
      if (redirectUri === null) {
        throw new BackofficeUnavailableError(describeCallback(null));
      }
      const response = await invoke(BACKOFFICE_PERMISSION.api.connectionsCreate, { slug }, () =>
        callRoute("POST", "/connections/:slug/auth/oauth/start", {
          pathParams: { slug },
          query: { [API_OAUTH_REDIRECT_URI_QUERY_PARAMETER]: redirectUri },
          body: { discardTokens },
        }),
      );
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data.authorizationUrl;
      }
      return fail(response);
    }
    async function createConnection(slug: string, values: ApiSetupConnectionInput) {
      return await invoke(BACKOFFICE_PERMISSION.api.connectionsCreate, { slug }, () =>
        callRoute("PUT", "/connections/:slug", {
          pathParams: { slug },
          body: connectionBody(values),
        }),
      );
    }
    async function replaceConfiguration(slug: string, values: ApiSetupConnectionInput) {
      const response = await invoke(BACKOFFICE_PERMISSION.api.connectionsCreate, { slug }, () =>
        callRoute("PUT", "/connections/:slug/configuration", {
          pathParams: { slug },
          body: connectionBody(values),
        }),
      );
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return true;
      }
      return isConnectionNotFound(response) ? false : fail(response);
    }
    async function deleteConnection(slug: string) {
      const response = await invoke(BACKOFFICE_PERMISSION.api.connectionsDelete, { slug }, () =>
        callRoute("DELETE", "/connections/:slug", { pathParams: { slug } }),
      );
      if (isSuccessStatus(response.status)) {
        return true;
      }
      return isConnectionNotFound(response) ? false : fail(response);
    }
    async function setToken(slug: string, token: string) {
      const response = await invoke(BACKOFFICE_PERMISSION.api.connectionsCreate, { slug }, () =>
        callRoute("POST", "/connections/:slug/auth/token", {
          pathParams: { slug },
          body: { token },
        }),
      );
      if (!(response.type === "json" && isSuccessStatus(response.status))) {
        fail(response);
      }
    }
    async function request(slug: string, input: z.output<typeof apiIntegrationRequestInputSchema>) {
      const response = await invoke(
        BACKOFFICE_PERMISSION.api.requestsExecute,
        { slug, path: input.path },
        () =>
          callRoute("POST", "/connections/:slug/request", { pathParams: { slug }, body: input }),
      );
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data;
      }
      return fail(response);
    }
    return {
      callRoute,
      invoke,
      fail,
      authStatus,
      connection,
      pendingAuthorizationUrl,
      oauthCallbackUrl,
      startOAuth,
      createConnection,
      replaceConfiguration,
      deleteConnection,
      setToken,
      request,
    };
  }
  type ApiAccess = ReturnType<typeof createApiAccess>;

  async function setupExistingConnection(
    access: ApiAccess,
    slug: string,
    status: ApiAuthStatus,
    input: { submitted: false } | { submitted: true; value: unknown },
  ): Promise<IntegrationSetupProgress> {
    const connectionId = encodeApiConnectionId(slug);
    const ready = { connectionId, status: "ready" } as const;
    // Ready connections ignore submissions: setup never replaces stored credentials.
    switch (status.mode) {
      case "none":
        return ready;
      case "bearer":
        if (status.credentials === "present") {
          return ready;
        }
        if (!input.submitted) {
          return {
            connectionId,
            status: "needs-input",
            instructions:
              "Submit a bearer token for this connection. The token stays in the API connection store.",
            inputSchema: z.toJSONSchema(z.strictObject(tokenAuthInputSchema.shape), {
              io: "input",
            }),
            secretFields: ["token"],
          };
        }
        await access.setToken(
          slug,
          z.strictObject(tokenAuthInputSchema.shape).parse(input.value).token,
        );
        return ready;
      case "basic":
      case "client_credentials":
        return status.credentials === "present"
          ? ready
          : {
              connectionId,
              status: "blocked",
              reason:
                "Stored credentials were cleared. Run integrations.reconfigure with the full configuration and new credentials.",
            };
      case "oauth":
        break;
    }
    switch (status.state) {
      case "authorized":
        return ready;
      case "client-missing":
        return {
          connectionId,
          status: "blocked",
          reason:
            "The OAuth configuration was cleared. Run integrations.reconfigure with the full OAuth configuration.",
        };
      case "consent-pending": {
        // Resuming never starts a new flow; any pending link completes this connection.
        const authorizationUrl = await access.pendingAuthorizationUrl(slug);
        if (authorizationUrl !== null) {
          return describeAuthorization(connectionId, authorizationUrl);
        }
        // The link expired between reads; fresh consent needs explicit input.
        break;
      }
      case "consent-required":
      case "expired":
        break;
    }
    if (!input.submitted) {
      return {
        connectionId,
        status: "needs-input",
        instructions: `${
          status.state === "consent-required"
            ? "OAuth consent has not been completed."
            : "The previous OAuth consent or authorization link expired."
        } Submit { start: true } to start OAuth and receive a new authorization link. ${describeCallback(
          await access.oauthCallbackUrl(),
        )}`,
        inputSchema: z.toJSONSchema(apiOAuthSetupInputSchema, { io: "input" }),
        secretFields: [],
      };
    }
    apiOAuthSetupInputSchema.parse(input.value);
    return describeAuthorization(connectionId, await access.startOAuth(slug, false));
  }

  return {
    connectionIds: [{ kind: "namespace", namespace: "api" }],
    setup: {
      kind: "supported",
      async run(context, { localId, operation }) {
        const connectionId = encodeApiConnectionId(localId);
        if (!isApiAvailable(context.execution.scope)) {
          return {
            connectionId,
            status: "blocked",
            reason:
              "API connections require an available organization-, user-, or project-owned API store.",
          };
        }
        const access = createApiAccess(context);
        const input =
          operation.kind === "check"
            ? ({ submitted: false } as const)
            : ({ submitted: true, value: operation.input } as const);
        const status = await access.authStatus(localId);
        if (status !== null) {
          return await setupExistingConnection(access, localId, status, input);
        }
        const slug = apiConnectionSlugSchema.safeParse(localId);
        if (!slug.success) {
          return { connectionId, status: "blocked", reason: slug.error.issues[0].message };
        }
        if (!input.submitted) {
          return {
            connectionId,
            status: "needs-input",
            instructions: `Submit the base URL, an optional display name, and the auth settings beside them; \`type\` selects none, bearer, basic, client_credentials, or oauth. This address supplies the slug. OAuth submissions start consent immediately. ${describeCallback(
              await access.oauthCallbackUrl(),
            )}`,
            inputSchema: z.toJSONSchema(apiSetupConnectionInputSchema, { io: "input" }),
            secretFields: [...apiSetupSecretFields],
          };
        }
        const values = apiSetupConnectionInputSchema.parse(input.value);
        const created = await access.createConnection(localId, values);
        if (created.type === "json" && isSuccessStatus(created.status)) {
          return values.type === "oauth"
            ? describeAuthorization(connectionId, await access.startOAuth(localId, false))
            : { connectionId, status: "ready" };
        }
        if (created.type === "error" && created.error.code === "CONNECTION_EXISTS") {
          // A concurrent creation won; report its state instead of overwriting it.
          const current = await access.authStatus(localId);
          if (current !== null) {
            return await setupExistingConnection(access, localId, current, { submitted: false });
          }
        }
        return access.fail(created);
      },
    },
    reconfigure: {
      kind: "supported",
      async run(context, { localId, operation }) {
        const connectionId = encodeApiConnectionId(localId);
        if (!isApiAvailable(context.execution.scope)) {
          return {
            connectionId,
            status: "blocked",
            reason:
              "API connections require an available organization-, user-, or project-owned API store.",
          };
        }
        const access = createApiAccess(context);
        const status = await access.authStatus(localId);
        if (status === null) {
          return {
            connectionId,
            status: "blocked",
            reason: "No API connection exists at this address. Run setup to create it.",
          };
        }
        const canReauthorize = status.mode === "oauth" && status.state !== "client-missing";
        const inputSchema = canReauthorize
          ? z.union([apiSetupConnectionInputSchema, apiReauthorizeInputSchema])
          : apiSetupConnectionInputSchema;
        if (operation.kind === "check") {
          return {
            connectionId,
            status: "needs-input",
            instructions: `Submit a complete replacement with the base URL, an optional display name, and auth settings, as in setup. It replaces the stored configuration and credentials; OAuth replacements start consent immediately.${
              canReauthorize
                ? " Submit { reauthorize: true } to discard the stored tokens and consent again with the stored OAuth client, for example after the provider revoked access."
                : ""
            } ${describeCallback(await access.oauthCallbackUrl())}`,
            inputSchema: z.toJSONSchema(inputSchema, { io: "input" }),
            secretFields: [...apiSetupSecretFields],
          };
        }
        const values = inputSchema.parse(operation.input);
        if ("reauthorize" in values) {
          return describeAuthorization(connectionId, await access.startOAuth(localId, true));
        }
        if (!(await access.replaceConfiguration(localId, values))) {
          return {
            connectionId,
            status: "blocked",
            reason: "The API connection was removed meanwhile. Run setup to create it.",
          };
        }
        return values.type === "oauth"
          ? describeAuthorization(connectionId, await access.startOAuth(localId, false))
          : { connectionId, status: "ready" };
      },
    },
    disconnect: {
      kind: "supported",
      async run(context, { localId }) {
        const removed = await createApiAccess(context).deleteConnection(localId);
        return {
          connectionId: encodeApiConnectionId(localId),
          status: removed ? "disconnected" : "not-configured",
        };
      },
    },
    async discover(context) {
      return [
        {
          id: apiIntegrationId,
          label: "Custom HTTP API",
          description:
            "Outbound HTTP connections to APIs without a native integration. Choose an address api#<slug>; the slug becomes the connection's identity.",
          connectionCardinality: "multiple",
          availability: !runtime.config.bindings.api
            ? { status: "unavailable", reason: "The API object binding is unavailable." }
            : isApiAvailable(context.execution.scope)
              ? { status: "available" }
              : {
                  status: "unavailable",
                  reason: "API connections are owned by an organization, user, or project.",
                },
          // Slugs are caller-chosen, so there is no fixed slot to advertise.
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
      const access = createApiAccess(context);
      const response = await access.invoke(BACKOFFICE_PERMISSION.api.connectionsRead, {}, () =>
        access.callRoute("GET", "/connections", { query: cursor === null ? {} : { cursor } }),
      );
      if (response.type === "error" && response.error.code === "INVALID_CURSOR") {
        throw new Error("API integration listing cursor is invalid.");
      }
      if (response.type !== "json" || !isSuccessStatus(response.status)) {
        return access.fail(response);
      }
      return {
        connections: response.data.connections.map((connection) => ({
          connectionId: encodeApiConnectionId(connection.slug),
          integrationId: apiIntegrationId,
          name: connection.name ?? connection.slug,
          configuration: { status: "configured" },
          // Listing reads no auth state; only auth-free connections are known without checking.
          authorization: {
            status: connection.authMode === "none" ? "not-required" : "not-checked",
          },
          checks: [],
          nextSteps: [],
        })),
        cursor: response.data.cursor,
      };
    },
    async resolve(context, localId) {
      const access = createApiAccess(context);
      const resolved = await access.connection(localId);
      return {
        identity: {
          connectionId: encodeApiConnectionId(localId),
          integrationId: apiIntegrationId,
          name: resolved?.name ?? localId,
        },
        async inspect() {
          return inspectApiAuth(await access.authStatus(localId));
        },
        async actions() {
          return [
            {
              definition: apiRequestActionDefinition,
              async invoke(input) {
                const result = await access.request(
                  localId,
                  apiIntegrationRequestInputSchema.parse(input),
                );
                const parsed = apiRequestOutputSchema.safeParse(result);
                const output = parsed.success ? jsonValueSchema.safeParse(parsed.data) : null;
                if (!output?.success) {
                  throw new Error(
                    "API integration request output failed its published schema. The request has already run and must not be automatically retried.",
                  );
                }
                return output.data;
              },
            },
            {
              definition: apiDescribeActionDefinition,
              async invoke(input) {
                z.strictObject({}).parse(input);
                const [connection, auth] = await Promise.all([
                  access.connection(localId),
                  access.authStatus(localId),
                ]);
                if (connection === null || auth === null) {
                  throw new Error("API integration connection not found. Run setup to create it.");
                }
                return {
                  slug: connection.slug,
                  name: connection.name ?? null,
                  baseUrl: connection.baseUrl,
                  authMode: connection.authMode,
                  status: connection.status,
                  auth,
                } satisfies z.output<typeof apiConnectionDescriptionSchema>;
              },
            },
          ];
        },
        // The source declares no live check; verification never contacts the provider.
        async verify() {
          return inspectApiAuth(await access.authStatus(localId));
        },
      };
    },
  };
}
