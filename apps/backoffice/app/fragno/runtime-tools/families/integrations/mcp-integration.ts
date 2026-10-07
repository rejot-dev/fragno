import { createRouteCaller } from "@fragno-dev/core/api";
import {
  MCP_OAUTH_REDIRECT_URI_QUERY_PARAMETER,
  authConfigSchema,
  createServerInputSchema,
  mcpServerSlugSchema,
  mcpToolCallResultSchema,
  tokenAuthInputSchema,
  type McpAuthStatus,
  type McpTool,
} from "@fragno-dev/mcp-fragment/types";
import { z } from "zod";

import type { Validator } from "@cfworker/json-schema";

import { authorizedBackofficeObjectHttp } from "@/backoffice-runtime/authorized-object-http";
import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import { BackofficeUnavailableError } from "@/backoffice-runtime/kernel";
import { isBackofficeObjectAvailableInContext } from "@/backoffice-runtime/object-registry";
import {
  BACKOFFICE_PERMISSION,
  type BackofficePermissionRequirement,
} from "@/backoffice-runtime/permissions";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import { mcpCapability } from "@/fragno/backoffice-capabilities/capabilities/mcp";
import type { McpFragment } from "@/fragno/mcp";
import { mcpPublicAddress } from "@/fragno/scoped-public-fragment-routes";
import { jsonValueSchema } from "@/lib/zod/json-value";

import {
  isSuccessStatus,
  throwOnBackofficeRouteAuthorizationError,
  throwOnRouteRuntimeError,
} from "../../runtime-errors";
import { resolveRuntimePublicScopePathSegment } from "../../runtime-public-scope";
import { compileIntegrationActionSchema } from "./integration-action-json-schema";
import type { IntegrationInspection, IntegrationSetupProgress } from "./integration-contracts";
import type {
  IntegrationActionImplementation,
  IntegrationContext,
  IntegrationImplementation,
} from "./integration-implementation";

const mcpIntegrationId = "mcp";
const mcpServerShape = createServerInputSchema.omit({ slug: true, auth: true }).shape;
const [noAuth, bearerAuth, clientCredentialsAuth, oauthAuth] = authConfigSchema.options;
// Flat variants keep secrets top-level, where secretFields can name them for input controls.
const mcpSetupServerInputSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...mcpServerShape, ...noAuth.shape }),
  z.strictObject({ ...mcpServerShape, ...bearerAuth.shape }),
  z.strictObject({ ...mcpServerShape, ...clientCredentialsAuth.shape }),
  z.strictObject({ ...mcpServerShape, ...oauthAuth.shape }),
]);
type McpSetupServerInput = z.output<typeof mcpSetupServerInputSchema>;
const mcpSetupSecretFields = ["token", "clientSecret"] as const satisfies readonly (
  | keyof z.input<typeof bearerAuth>
  | keyof z.input<typeof clientCredentialsAuth>
)[];
const mcpOAuthSetupInputSchema = z.strictObject({
  start: z.literal(true).describe("Explicitly start OAuth consent for this server."),
});
const mcpReauthorizeInputSchema = z.strictObject({
  reauthorize: z
    .literal(true)
    .describe("Discard the stored OAuth tokens and start consent again with the stored client."),
});
const mcpToolsCheck = { id: "tools.list", label: "List server tools" };

function encodeMcpConnectionId(slug: string) {
  return `mcp#${slug}`;
}

type PublishableTool = { tool: McpTool; input: Validator; output: Validator | null };

/** Tools whose contracts cannot be validated faithfully are withheld rather than weakened. */
function partitionTools(tools: readonly McpTool[]) {
  const publishable: PublishableTool[] = [];
  const unsupported: string[] = [];
  for (const tool of tools) {
    // tools/call sends an arguments object, so a non-object root would promise an unusable action.
    const input =
      tool.inputSchema.type === "object" ? compileIntegrationActionSchema(tool.inputSchema) : null;
    const output = tool.outputSchema ? compileIntegrationActionSchema(tool.outputSchema) : null;
    if (input && (output || !tool.outputSchema)) {
      publishable.push({ tool, input, output });
    } else {
      unsupported.push(tool.name);
    }
  }
  return { publishable, unsupported };
}

/**
 * Projects sanitized auth state and the source's tool cache. Null tools mean discovery has not
 * completed; stored credentials never prove live access.
 */
function inspectMcpServer(
  status: McpAuthStatus | null,
  tools: readonly McpTool[] | null,
): IntegrationInspection {
  const notChecked = {
    ...mcpToolsCheck,
    status: "not-checked",
    reason: "Run integrations.verify to list the server's tools.",
  } as const;
  if (status === null) {
    return {
      configuration: { status: "missing", missingFields: ["endpointUrl", "type"] },
      authorization: { status: "missing" },
      checks: [notChecked],
      nextSteps: ["Run setup at this address to register the MCP server."],
    };
  }
  const [authorization, authSteps] = ((): [IntegrationInspection["authorization"], string[]] => {
    if (status.mode === "none") {
      return [{ status: "not-required" }, []];
    }
    if (status.mode !== "oauth") {
      if (status.credentials === "present") {
        return [{ status: "available" }, []];
      }
      return [
        { status: "missing" },
        status.mode === "bearer"
          ? ["Run setup to provide a bearer token."]
          : ["Run integrations.reconfigure with the full configuration and new credentials."],
      ];
    }
    switch (status.state) {
      case "authorized":
        return [{ status: "available" }, []];
      case "expired":
        return [{ status: "expired" }, ["Run setup to start OAuth consent again."]];
      case "consent-pending":
        return [
          { status: "missing" },
          ["Complete the pending OAuth consent; setup returns its link."],
        ];
      case "consent-required":
        return [{ status: "missing" }, ["Run setup to start OAuth consent."]];
      default:
        throw new Error("MCP integration OAuth state is unsupported.", {
          cause: status.state satisfies never,
        });
    }
  })();
  const unsupported = tools === null ? [] : partitionTools(tools).unsupported;
  return {
    configuration: { status: "configured" },
    authorization,
    checks: [notChecked],
    nextSteps: [
      ...authSteps,
      ...(tools === null && authSteps.length === 0
        ? ["The server's tools have not been discovered yet; run integrations.verify."]
        : []),
      ...(unsupported.length > 0
        ? [
            `Tools ${unsupported.join(", ")} publish schemas that cannot be validated, so they are not offered as actions; call them through mcp.callTool.`,
          ]
        : []),
    ],
  };
}

function describeCallback(callbackUrl: string | null) {
  return callbackUrl === null
    ? "OAuth is unavailable: this deployment has no public origin for OAuth callbacks."
    : `For OAuth with a pre-registered client, register this exact callback URL in the provider's OAuth app: ${callbackUrl}. Servers with dynamic client registration register it themselves.`;
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
    instructions: `Open the authorization link and complete consent, then check setup again. Any pending link for this server completes it. If the provider rejects the redirect URI, its OAuth app must register this exact callback URL: ${callbackUrl}`,
    authorizationUrl,
  };
}

function describeOAuthStartFailure(connectionId: string): IntegrationSetupProgress {
  // The source's discovery error can echo provider responses, so only the remedy is reported.
  return {
    connectionId,
    status: "blocked",
    reason:
      "The MCP server's OAuth discovery or client registration failed. If the server does not support dynamic client registration, run integrations.reconfigure with a clientId and clientSecret.",
  };
}

function serverBody(slug: string, { name, endpointUrl, ...auth }: McpSetupServerInput) {
  return { slug, ...(name === undefined ? {} : { name }), endpointUrl, auth };
}

/** Projects scoped MCP Fragment servers; configuration, credentials, OAuth, and tools stay in the source. */
export function createMcpIntegration({
  runtime,
  nowEpochMs,
}: {
  runtime: Pick<BackofficeRuntimeServices, "objects" | "config">;
  nowEpochMs: () => number;
}): IntegrationImplementation {
  function isMcpAvailable(scope: BackofficeContextScope) {
    return runtime.config.bindings.mcp && isBackofficeObjectAvailableInContext("MCP", scope);
  }

  function createMcpAccess(context: IntegrationContext) {
    if (!isMcpAvailable(context.execution.scope)) {
      throw new BackofficeUnavailableError(
        "MCP integration requires an available organization, user, or project MCP store.",
      );
    }
    const object = context.kernel.scoped("MCP", context.execution.scope, runtime.objects.mcp);
    const transport = authorizedBackofficeObjectHttp(object.http, context.execution);
    const callRoute = createRouteCaller<McpFragment>({
      baseUrl: "https://mcp.do",
      mountRoute: "/api/mcp",
      fetch: transport.fetch.bind(transport),
    });
    type McpRouteResponse = Awaited<ReturnType<typeof callRoute>>;
    function invoke<TResult>(
      operation: BackofficePermissionRequirement,
      resource: Record<string, string>,
      execute: () => Promise<TResult>,
    ) {
      return context.kernel.invoke({
        execution: context.execution,
        operation,
        resource: { capabilityId: "mcp", ...resource },
        execute,
      });
    }
    function fail(response: McpRouteResponse): never {
      return throwOnRouteRuntimeError(response, {
        runtimeLabel: "MCP integration",
        label: "MCP source operation",
      });
    }
    function isServerNotFound(response: McpRouteResponse) {
      return (
        response.type === "error" &&
        response.status === 404 &&
        response.error.code === "SERVER_NOT_FOUND"
      );
    }
    async function authStatus(slug: string): Promise<McpAuthStatus | null> {
      const response = await invoke(BACKOFFICE_PERMISSION.mcp.serversRead, { slug }, () =>
        callRoute("GET", "/servers/:slug/auth/status", { pathParams: { slug } }),
      );
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data;
      }
      return isServerNotFound(response) ? null : fail(response);
    }
    async function server(slug: string) {
      const response = await invoke(BACKOFFICE_PERMISSION.mcp.serversRead, { slug }, () =>
        callRoute("GET", "/servers/:slug", { pathParams: { slug } }),
      );
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data;
      }
      return isServerNotFound(response) ? null : fail(response);
    }
    async function pendingAuthorizationUrl(slug: string): Promise<string | null> {
      const response = await invoke(BACKOFFICE_PERMISSION.mcp.serversCreate, { slug }, () =>
        callRoute("GET", "/servers/:slug/auth/pending", { pathParams: { slug } }),
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
      return mcpPublicAddress(
        runtime.config.docsPublicBaseUrl,
        await resolveRuntimePublicScopePathSegment(runtime, context.execution.scope, "MCP"),
      ).oauthRedirectUri;
    }
    /** Returns null when the server's OAuth discovery or registration rejects the start. */
    async function startOAuth(slug: string, discardTokens: boolean): Promise<string | null> {
      const redirectUri = await oauthCallbackUrl();
      if (redirectUri === null) {
        throw new BackofficeUnavailableError(describeCallback(null));
      }
      const response = await invoke(BACKOFFICE_PERMISSION.mcp.serversCreate, { slug }, () =>
        callRoute("POST", "/servers/:slug/auth/start", {
          pathParams: { slug },
          query: { [MCP_OAUTH_REDIRECT_URI_QUERY_PARAMETER]: redirectUri },
          body: { discardTokens },
        }),
      );
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data.authorizationUrl;
      }
      if (response.type === "error" && response.error.code === "OAUTH_ERROR") {
        return null;
      }
      return fail(response);
    }
    async function createServer(slug: string, values: McpSetupServerInput) {
      return await invoke(BACKOFFICE_PERMISSION.mcp.serversCreate, { slug }, () =>
        callRoute("POST", "/servers", { body: serverBody(slug, values) }),
      );
    }
    async function replaceConfiguration(slug: string, values: McpSetupServerInput) {
      const { slug: _slug, ...body } = serverBody(slug, values);
      const response = await invoke(BACKOFFICE_PERMISSION.mcp.serversCreate, { slug }, () =>
        callRoute("PUT", "/servers/:slug/configuration", { pathParams: { slug }, body }),
      );
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return true;
      }
      return isServerNotFound(response) ? false : fail(response);
    }
    async function deleteServer(slug: string) {
      const response = await invoke(BACKOFFICE_PERMISSION.mcp.serversDelete, { slug }, () =>
        callRoute("DELETE", "/servers/:slug", { pathParams: { slug } }),
      );
      if (isSuccessStatus(response.status)) {
        return true;
      }
      return isServerNotFound(response) ? false : fail(response);
    }
    async function setToken(slug: string, token: string) {
      const response = await invoke(BACKOFFICE_PERMISSION.mcp.serversCreate, { slug }, () =>
        callRoute("POST", "/servers/:slug/auth/token", { pathParams: { slug }, body: { token } }),
      );
      if (!(response.type === "json" && isSuccessStatus(response.status))) {
        fail(response);
      }
    }
    async function refresh(slug: string) {
      const response = await invoke(BACKOFFICE_PERMISSION.mcp.serversRead, { slug }, () =>
        callRoute("POST", "/servers/:slug/refresh", { pathParams: { slug } }),
      );
      // A receiving-object denial is an execution failure, not evidence about server health.
      throwOnBackofficeRouteAuthorizationError(response);
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data;
      }
      return isServerNotFound(response) ? null : fail(response);
    }
    async function callTool(
      slug: string,
      name: string,
      args: Record<string, z.output<typeof jsonValueSchema>>,
    ) {
      const response = await invoke(BACKOFFICE_PERMISSION.mcp.toolsCall, { slug, tool: name }, () =>
        callRoute("POST", "/servers/:slug/tools/execute", {
          pathParams: { slug },
          body: { name, arguments: args },
        }),
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
      server,
      pendingAuthorizationUrl,
      oauthCallbackUrl,
      startOAuth,
      createServer,
      replaceConfiguration,
      deleteServer,
      setToken,
      refresh,
      callTool,
    };
  }
  type McpAccess = ReturnType<typeof createMcpAccess>;

  async function describeStartedOAuth(
    access: McpAccess,
    slug: string,
    discardTokens: boolean,
  ): Promise<IntegrationSetupProgress> {
    const connectionId = encodeMcpConnectionId(slug);
    const authorizationUrl = await access.startOAuth(slug, discardTokens);
    return authorizationUrl === null
      ? describeOAuthStartFailure(connectionId)
      : describeAuthorization(connectionId, authorizationUrl);
  }

  async function setupExistingServer(
    access: McpAccess,
    slug: string,
    status: McpAuthStatus,
    input: { submitted: false } | { submitted: true; value: unknown },
  ): Promise<IntegrationSetupProgress> {
    const connectionId = encodeMcpConnectionId(slug);
    // Ready means auth is usable; tool discovery is the source's background refresh, not setup.
    const ready = { connectionId, status: "ready" } as const;
    // Ready servers ignore submissions: setup never replaces stored credentials.
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
              "Submit a bearer token for this server. The token stays in the MCP server store.",
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
      case "consent-pending": {
        // Resuming never starts a new flow; any pending link completes this server.
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
        inputSchema: z.toJSONSchema(mcpOAuthSetupInputSchema, { io: "input" }),
        secretFields: [],
      };
    }
    mcpOAuthSetupInputSchema.parse(input.value);
    return await describeStartedOAuth(access, slug, false);
  }

  function unavailable(connectionId: string): IntegrationSetupProgress {
    return {
      connectionId,
      status: "blocked",
      reason: "MCP servers require an available organization-, user-, or project-owned MCP store.",
    };
  }

  return {
    connectionIds: [{ kind: "namespace", namespace: "mcp" }],
    setup: {
      kind: "supported",
      async run(context, { localId, operation }) {
        const connectionId = encodeMcpConnectionId(localId);
        if (!isMcpAvailable(context.execution.scope)) {
          return unavailable(connectionId);
        }
        const access = createMcpAccess(context);
        const input =
          operation.kind === "check"
            ? ({ submitted: false } as const)
            : ({ submitted: true, value: operation.input } as const);
        const status = await access.authStatus(localId);
        if (status !== null) {
          return await setupExistingServer(access, localId, status, input);
        }
        const slug = mcpServerSlugSchema.safeParse(localId);
        if (!slug.success) {
          return {
            connectionId,
            status: "blocked",
            reason:
              "MCP server slugs start with a lowercase letter or digit and contain only lowercase letters, digits, or '-'.",
          };
        }
        if (!input.submitted) {
          return {
            connectionId,
            status: "needs-input",
            instructions: `Submit the streamable HTTP endpoint URL, an optional display name, and the auth settings beside them; \`type\` selects none, bearer, client_credentials, or oauth. This address supplies the slug. OAuth submissions start consent immediately; include clientId and clientSecret when the server does not support dynamic client registration. ${describeCallback(
              await access.oauthCallbackUrl(),
            )}`,
            inputSchema: z.toJSONSchema(mcpSetupServerInputSchema, { io: "input" }),
            secretFields: [...mcpSetupSecretFields],
          };
        }
        const values = mcpSetupServerInputSchema.parse(input.value);
        const created = await access.createServer(localId, values);
        if (created.type === "json" && isSuccessStatus(created.status)) {
          return values.type === "oauth"
            ? await describeStartedOAuth(access, localId, false)
            : { connectionId, status: "ready" };
        }
        if (created.type === "error" && created.error.code === "SERVER_EXISTS") {
          // A concurrent creation won; report its state instead of overwriting it.
          const current = await access.authStatus(localId);
          if (current !== null) {
            return await setupExistingServer(access, localId, current, { submitted: false });
          }
        }
        return access.fail(created);
      },
    },
    reconfigure: {
      kind: "supported",
      async run(context, { localId, operation }) {
        const connectionId = encodeMcpConnectionId(localId);
        if (!isMcpAvailable(context.execution.scope)) {
          return unavailable(connectionId);
        }
        const access = createMcpAccess(context);
        const status = await access.authStatus(localId);
        if (status === null) {
          return {
            connectionId,
            status: "blocked",
            reason: "No MCP server exists at this address. Run setup to register it.",
          };
        }
        const canReauthorize = status.mode === "oauth";
        const inputSchema = canReauthorize
          ? z.union([mcpSetupServerInputSchema, mcpReauthorizeInputSchema])
          : mcpSetupServerInputSchema;
        if (operation.kind === "check") {
          return {
            connectionId,
            status: "needs-input",
            instructions: `Submit a complete replacement with the endpoint URL, an optional display name, and auth settings, as in setup. It replaces the stored configuration, credentials, and registered OAuth client; OAuth replacements start consent immediately.${
              canReauthorize
                ? " Submit { reauthorize: true } to discard the stored tokens and consent again with the stored OAuth client, for example after the server revoked access."
                : ""
            } ${describeCallback(await access.oauthCallbackUrl())}`,
            inputSchema: z.toJSONSchema(inputSchema, { io: "input" }),
            secretFields: [...mcpSetupSecretFields],
          };
        }
        const values = inputSchema.parse(operation.input);
        if ("reauthorize" in values) {
          return await describeStartedOAuth(access, localId, true);
        }
        if (!(await access.replaceConfiguration(localId, values))) {
          return {
            connectionId,
            status: "blocked",
            reason: "The MCP server was removed meanwhile. Run setup to register it.",
          };
        }
        return values.type === "oauth"
          ? await describeStartedOAuth(access, localId, false)
          : { connectionId, status: "ready" };
      },
    },
    disconnect: {
      kind: "supported",
      async run(context, { localId }) {
        const removed = await createMcpAccess(context).deleteServer(localId);
        return {
          connectionId: encodeMcpConnectionId(localId),
          status: removed ? "disconnected" : "not-configured",
        };
      },
    },
    async discover(context) {
      return [
        {
          id: mcpIntegrationId,
          label: "MCP server",
          description:
            "Remote Model Context Protocol servers over streamable HTTP; each server tool is an action. Choose an address mcp#<slug>; the slug becomes the server's identity.",
          connectionCardinality: "multiple",
          availability: !runtime.config.bindings.mcp
            ? { status: "unavailable", reason: "The MCP object binding is unavailable." }
            : isMcpAvailable(context.execution.scope)
              ? { status: "available" }
              : {
                  status: "unavailable",
                  reason: "MCP servers are owned by an organization, user, or project.",
                },
          // Slugs are caller-chosen, so there is no fixed slot to advertise.
          setupTargets: [],
          automationEvents: mcpCapability.contributions.automationEvents.map(
            ({ source, eventType }) => ({ source, eventType }),
          ),
        },
      ];
    },
    async list(context, cursor) {
      // The source lists every server in one read; there is never a next page.
      if (cursor !== null) {
        throw new Error("MCP integration listing cursor is invalid.");
      }
      if (!isMcpAvailable(context.execution.scope)) {
        return { connections: [], cursor: null };
      }
      const access = createMcpAccess(context);
      const response = await access.invoke(BACKOFFICE_PERMISSION.mcp.serversRead, {}, () =>
        access.callRoute("GET", "/servers"),
      );
      if (response.type !== "json" || !isSuccessStatus(response.status)) {
        return access.fail(response);
      }
      return {
        connections: response.data.servers.map((server) => ({
          connectionId: encodeMcpConnectionId(server.slug),
          integrationId: mcpIntegrationId,
          name: server.name ?? server.slug,
          configuration: { status: "configured" },
          // Listing reads no auth state; only auth-free servers are known without checking.
          authorization: {
            status: server.authMode === "none" ? "not-required" : "not-checked",
          },
          checks: [],
          nextSteps: [],
        })),
        cursor: null,
      };
    },
    async resolve(context, localId) {
      const access = createMcpAccess(context);
      const resolved = await access.server(localId);
      const cachedTools = resolved?.cache?.tools ?? null;
      return {
        identity: {
          connectionId: encodeMcpConnectionId(localId),
          integrationId: mcpIntegrationId,
          name: resolved?.name ?? localId,
        },
        async inspect() {
          return inspectMcpServer(await access.authStatus(localId), cachedTools);
        },
        async actions() {
          return partitionTools(cachedTools ?? []).publishable.map(
            ({ tool, input, output }): IntegrationActionImplementation => ({
              definition: {
                id: tool.name,
                label: tool.title ?? tool.name,
                description: `${tool.description ?? ""}${
                  tool.outputSchema
                    ? " Successful results carry structuredContent matching the tool's output schema."
                    : ""
                } Tool errors return isError: true with an explanation in content.`.trim(),
                inputSchema: tool.inputSchema,
                outputSchema: z.toJSONSchema(mcpToolCallResultSchema, { io: "output" }),
              },
              async invoke(value) {
                const args = z.record(z.string(), jsonValueSchema).parse(value);
                if (!input.validate(args).valid) {
                  throw new Error("MCP integration tool input failed its published JSON Schema.");
                }
                const result = mcpToolCallResultSchema.safeParse(
                  await access.callTool(localId, tool.name, args),
                );
                const json = result.success ? jsonValueSchema.safeParse(result.data) : null;
                if (
                  !result.success ||
                  !json?.success ||
                  (output &&
                    !result.data.isError &&
                    !output.validate(result.data.structuredContent).valid)
                ) {
                  throw new Error(
                    "MCP integration tool output failed its published schema. The tool has already run and must not be automatically retried.",
                  );
                }
                return json.data;
              },
            }),
          );
        },
        async verify() {
          const checked = await access.refresh(localId);
          const status = await access.authStatus(localId);
          if (checked === null || status === null) {
            return inspectMcpServer(null, null);
          }
          const inspection = inspectMcpServer(status, checked.ok ? checked.tools : cachedTools);
          return {
            ...inspection,
            checks: [
              {
                ...mcpToolsCheck,
                status: checked.ok ? "passed" : "failed",
                checkedAt: new Date(nowEpochMs()).toISOString(),
                // Refresh errors can echo server responses, so only the failing stage is reported.
                message: checked.ok
                  ? `The server listed ${checked.tools.length} tools. Calling them has not been tested.`
                  : `Listing tools failed at the ${checked.stage === "auth" ? "authentication" : "tools/list"} stage.`,
              },
            ],
            nextSteps: checked.ok
              ? inspection.nextSteps
              : [
                  ...inspection.nextSteps,
                  "Check the server's endpoint and authorization, then verify again.",
                ],
          };
        },
      };
    },
  };
}
