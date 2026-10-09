import {
  type ApiAuthStatus,
  type ApiConnection,
  type ApiListConnectionsOutput,
  type ApiOAuthStartOutput,
  type ApiRequestOutput,
  type ApiWebhookEndpoint,
  type ApiWebhookEndpointsOutput,
  apiOAuthStartInputSchema,
  apiSetTokenInputSchema,
  createConnectionInputSchema,
  requestInputSchema,
  webhookEndpointCreateInputSchema,
  webhookEndpointUpdateInputSchema,
} from "@fragno-dev/backoffice-api/v0/http-api";
import { z } from "zod";

import {
  defineCliArgsParser,
  defineNoInputArgsParser,
  readOutputOptions,
  type ParsedCliTokens,
} from "@/fragno/runtime-tools/bash-cli";

import {
  backofficeApiOperationToolFields,
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "../runtime-tools";
import type { ApiRuntime } from "./api-runtime";

const requestCliInputSchema = requestInputSchema.omit({ body: true }).extend({
  json: z.unknown().optional(),
  text: z.string().optional(),
});
export type ApiSetTokenInput = Omit<z.infer<typeof apiSetTokenInputSchema>, "slug">;
export type ApiOAuthStartInput = Omit<z.infer<typeof apiOAuthStartInputSchema>, "slug">;
export type ApiWebhookEndpointInput = Omit<
  z.infer<typeof webhookEndpointCreateInputSchema>,
  "endpointId"
>;
export type ApiWebhookEndpointUpdateInput = Omit<
  z.infer<typeof webhookEndpointUpdateInputSchema>,
  "endpointId"
>;
export type { ApiRuntime } from "./api-runtime";

type ApiToolContext = BackofficeToolContext<{ api?: ApiRuntime }>;

const getApiRuntime = (runtime: ApiToolContext["runtimes"]["api"]): ApiRuntime => {
  if (!runtime) {
    throw new Error("API runtime is not available in this execution context");
  }
  return runtime;
};

const defaultOutput = (_args: string[], parsed: ParsedCliTokens) => readOutputOptions(parsed);

const textOrDataFormat =
  <T>(renderText: (result: T) => string) =>
  (result: T, output: { format?: "text" | "json"; print?: string }) => {
    if (output.format === "json" || output.print) {
      return { data: result };
    }
    const stdout = renderText(result);
    return { data: result, stdout: stdout.endsWith("\n") ? stdout : `${stdout}\n` };
  };

const cell = (value: unknown) => {
  if (typeof value === "boolean") {
    return value ? "yes" : "no";
  }
  if (value === undefined || value === null || value === "") {
    return "-";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
};

const renderTable = (headers: readonly string[], rows: readonly (readonly unknown[])[]) => {
  const normalizedRows = rows.map((row) => row.map(cell));
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...normalizedRows.map((row) => row[index]?.length ?? 0)),
  );
  const renderRow = (row: readonly string[]) =>
    row
      .map((value, index) => value.padEnd(widths[index] ?? value.length))
      .join("  ")
      .trimEnd();
  return [
    renderRow(headers),
    renderRow(widths.map((width) => "-".repeat(width))),
    ...normalizedRows.map(renderRow),
  ].join("\n");
};

const renderConnectionRows = (connections: readonly ApiConnection[]) =>
  renderTable(
    ["connection", "name", "auth", "status", "base URL"],
    connections.map((connection) => [
      connection.slug,
      connection.name,
      connection.authMode,
      connection.status,
      connection.baseUrl,
    ]),
  );

const renderConnections = (result: ApiListConnectionsOutput) =>
  result.connections.length
    ? renderConnectionRows(result.connections)
    : "No API connections configured.";

const renderRequest = (result: ApiRequestOutput) => {
  if (!result.ok && !result.response) {
    return `${result.error.code}: ${result.error.message}`;
  }

  const response = result.response;
  if (!response) {
    return "API request failed without an error response.";
  }

  const body =
    response.body.type === "json"
      ? JSON.stringify(response.body.value, null, 2)
      : response.body.type === "text"
        ? response.body.value
        : "";
  const status = `${response.status} ${response.statusText}`;
  return [result.ok ? status : `${status}\n${result.error.code}: ${result.error.message}`, body]
    .filter(Boolean)
    .join("\n");
};

const renderWebhookEndpointRows = (endpoints: readonly ApiWebhookEndpoint[]) =>
  renderTable(
    ["endpoint", "name", "status", "public URL"],
    endpoints.map((endpoint) => [endpoint.id, endpoint.name, endpoint.status, endpoint.publicUrl]),
  );

const renderWebhookEndpoints = (result: ApiWebhookEndpointsOutput) =>
  result.endpoints.length
    ? renderWebhookEndpointRows(result.endpoints)
    : "No API webhook endpoints configured.";

const parseScopes = (value: string | undefined) =>
  value
    ?.split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);

const readCliRawString = (parsed: ParsedCliTokens, name: string) => {
  const value = parsed.options.get(name);
  const lastValue = Array.isArray(value) ? value.at(-1) : value;
  if (typeof lastValue === "boolean") {
    throw new Error(`--${name} requires a value`);
  }
  return lastValue;
};

const readCliString = (parsed: ParsedCliTokens, name: string) =>
  readCliRawString(parsed, name)?.trim() || undefined;

const parseConnectionCreate = defineCliArgsParser<z.input<typeof createConnectionInputSchema>>(
  "api.connections.create",
  {
    slug: { required: true },
    baseUrl: { option: "base-url", required: true },
    name: {},
    auth: {
      read: (parsed) => {
        const mode = readCliString(parsed, "auth") ?? "none";
        const scopes = parseScopes(readCliString(parsed, "scope"));
        const tokenEndpointAuthMethod = readCliString(parsed, "token-endpoint-auth-method");
        if (mode === "none") {
          return { type: "none" };
        }
        if (mode === "bearer") {
          return { type: "bearer", token: readCliString(parsed, "token") ?? "" };
        }
        if (mode === "basic") {
          return {
            type: "basic",
            username: readCliString(parsed, "username") ?? "",
            password: readCliRawString(parsed, "password") ?? "",
          };
        }
        if (mode === "oauth") {
          return {
            type: "oauth",
            authorizationEndpoint: readCliString(parsed, "authorization-endpoint") ?? "",
            tokenEndpoint: readCliString(parsed, "token-endpoint") ?? "",
            clientId: readCliString(parsed, "client-id") ?? "",
            clientSecret: readCliString(parsed, "client-secret"),
            ...(scopes?.length ? { scopes } : {}),
            tokenEndpointAuthMethod: z
              .enum(["client_secret_basic", "client_secret_post", "none"])
              .parse(tokenEndpointAuthMethod ?? "client_secret_basic"),
          };
        }
        if (mode === "client_credentials") {
          return {
            type: "client_credentials",
            tokenEndpoint: readCliString(parsed, "token-endpoint") ?? "",
            clientId: readCliString(parsed, "client-id") ?? "",
            clientSecret: readCliString(parsed, "client-secret") ?? "",
            ...(scopes?.length ? { scopes } : {}),
            audience: readCliString(parsed, "audience"),
            tokenEndpointAuthMethod: z
              .enum(["client_secret_basic", "client_secret_post"])
              .parse(tokenEndpointAuthMethod ?? "client_secret_basic"),
          };
        }
        throw new Error("--auth must be one of: none, bearer, basic, oauth, client_credentials");
      },
    },
  },
);
const parseSlug = defineCliArgsParser<{ slug: string }>("api.connection", {
  slug: { required: true, option: "connection" },
});
const parseSetToken = defineCliArgsParser<z.input<typeof apiSetTokenInputSchema>>(
  "api.auth.token",
  {
    slug: { required: true, option: "connection" },
    token: { required: true },
  },
);
const parseOAuthStart = defineCliArgsParser<z.input<typeof apiOAuthStartInputSchema>>(
  "api.oauth.start",
  {
    slug: { required: true, option: "connection" },
    scopes: { option: "scope", read: (parsed) => parseScopes(readCliString(parsed, "scope")) },
    extraAuthorizationParams: { option: "extra-authorization-params-json", kind: "json" },
  },
);
const parseRequestCliInput = defineCliArgsParser<z.input<typeof requestCliInputSchema>>(
  "api.request",
  {
    slug: { required: true, option: "connection" },
    method: { required: true },
    path: { required: true },
    query: { option: "query-json", kind: "json" },
    headers: { option: "headers-json", kind: "json" },
    json: { option: "json", kind: "json" },
    text: { option: "body" },
    timeoutMs: { option: "timeout-ms", kind: "integer" },
  },
);
function parseRequest(args: string[]): z.input<typeof requestInputSchema> {
  const { json, text, ...input } = parseRequestCliInput(args);
  if (json !== undefined && text !== undefined) {
    throw new Error("api.request accepts either --json or --body, not both");
  }
  return {
    ...input,
    body:
      json !== undefined
        ? { type: "json", value: json }
        : text !== undefined
          ? { type: "text", value: text }
          : { type: "empty" },
  };
}
const parseEndpoint = defineCliArgsParser<{ endpointId: string }>("api.webhooks.endpoint", {
  endpointId: { required: true, option: "endpoint" },
});
const parseWebhookCreate = defineCliArgsParser<z.input<typeof webhookEndpointCreateInputSchema>>(
  "api.webhooks.create",
  {
    endpointId: { required: true, option: "endpoint" },
    name: { required: true },
    status: {},
    verification: { required: true, option: "verification-json", kind: "json" },
    deliveryIdentity: { required: true, option: "delivery-identity-json", kind: "json" },
    auth: { required: true, option: "auth-json", kind: "json" },
  },
);
const parseWebhookUpdate = defineCliArgsParser<z.input<typeof webhookEndpointUpdateInputSchema>>(
  "api.webhooks.update",
  {
    endpointId: { required: true, option: "endpoint" },
    name: {},
    status: {},
    verification: { option: "verification-json", kind: "json" },
    deliveryIdentity: { option: "delivery-identity-json", kind: "json" },
    auth: { option: "auth-json", kind: "json" },
  },
);

const apiPermissions = {
  "connections.read": "Read API connection configuration and auth status.",
  "connections.create": "Create API connections and auth state.",
  "connections.delete": "Delete API connections and auth state.",
  "requests.execute": "Execute HTTP requests through configured API connections.",
  "webhooks.read": "Read API webhook endpoint configuration.",
  "webhooks.manage": "Create, update, and delete API webhook endpoints.",
} as const;

export const apiRuntimeTools = [
  defineBackofficeRuntimeTool({
    ...backofficeApiOperationToolFields("api.connections.list"),
    namespace: "api",
    name: "listConnections",
    capabilityId: "api",
    requiredPermissions: ["connections.read"],
    execute: async (_input, context: ApiToolContext) =>
      await getApiRuntime(context.runtimes.api).listConnections(),
    adapters: {
      bash: {
        command: "api.connections.list",
        help: {
          summary: "api.connections.list lists configured API connections.",
          options: [],
          examples: ["api.connections.list"],
        },
        parse: defineNoInputArgsParser("api.connections.list"),
        outputOptions: defaultOutput,
        format: textOrDataFormat(renderConnections),
      },
    },
  }),
  defineBackofficeRuntimeTool({
    ...backofficeApiOperationToolFields("api.connections.create"),
    namespace: "api",
    name: "createConnection",
    capabilityId: "api",
    requiredPermissions: ["connections.create"],
    getResource: (input) => ({ slug: input.slug }),
    execute: async (input, context: ApiToolContext) =>
      await getApiRuntime(context.runtimes.api).createConnection(input),
    adapters: {
      bash: {
        command: "api.connections.create",
        help: {
          summary: "api.connections.create configures an outbound HTTP API connection.",
          options: [
            {
              name: "slug",
              required: true,
              valueRequired: true,
              valueName: "slug",
              description: "Stable connection slug",
            },
            {
              name: "base-url",
              required: true,
              valueRequired: true,
              valueName: "url",
              description: "Base URL for the upstream API",
            },
            { name: "name", valueRequired: true, valueName: "name", description: "Display name" },
            {
              name: "auth",
              valueRequired: true,
              valueName: "mode",
              description: "none|bearer|basic|oauth|client_credentials",
            },
            { name: "token", valueRequired: true, valueName: "token", description: "Bearer token" },
            {
              name: "username",
              valueRequired: true,
              valueName: "username",
              description: "Basic auth username",
            },
            {
              name: "password",
              valueRequired: true,
              valueName: "password",
              description: "Basic auth password",
            },
            {
              name: "authorization-endpoint",
              valueRequired: true,
              valueName: "url",
              description: "OAuth authorization endpoint",
            },
            {
              name: "token-endpoint",
              valueRequired: true,
              valueName: "url",
              description: "OAuth token endpoint",
            },
            {
              name: "client-id",
              valueRequired: true,
              valueName: "id",
              description: "OAuth client id",
            },
            {
              name: "client-secret",
              valueRequired: true,
              valueName: "secret",
              description: "OAuth client secret",
            },
            {
              name: "scope",
              valueRequired: true,
              valueName: "scopes",
              description: "Space/comma separated scopes",
            },
            {
              name: "audience",
              valueRequired: true,
              valueName: "audience",
              description: "Client credentials audience",
            },
            {
              name: "token-endpoint-auth-method",
              valueRequired: true,
              valueName: "method",
              description: "client_secret_basic|client_secret_post|none",
            },
          ],
          examples: [
            "api.connections.create --slug stripe --base-url https://api.stripe.com --auth bearer --token $TOKEN",
            "api.connections.create --slug jira --base-url https://example.atlassian.net --auth basic --username user@example.com --password $API_TOKEN",
            "api.connections.create --slug billing --base-url https://billing.example.com --auth client_credentials --token-endpoint https://auth.example.com/token --client-id $CLIENT_ID --client-secret $CLIENT_SECRET",
          ],
        },
        parse: parseConnectionCreate,
        outputOptions: defaultOutput,
        format: textOrDataFormat(
          (connection: ApiConnection) =>
            `Created API connection\n\n${renderConnectionRows([connection])}`,
        ),
      },
    },
  }),
  defineBackofficeRuntimeTool({
    ...backofficeApiOperationToolFields("api.connections.delete"),
    namespace: "api",
    name: "deleteConnection",
    capabilityId: "api",
    requiredPermissions: ["connections.delete"],
    getResource: (input) => ({ slug: input.slug }),
    execute: async (input, context: ApiToolContext) =>
      await getApiRuntime(context.runtimes.api).deleteConnection(input),
    adapters: {
      bash: {
        command: "api.connections.delete",
        help: {
          summary: "api.connections.delete removes a configured API connection.",
          options: [
            {
              name: "connection",
              required: true,
              valueRequired: true,
              valueName: "slug",
              description: "API connection slug",
            },
          ],
          examples: ["api.connections.delete --connection stripe"],
        },
        parse: parseSlug,
        outputOptions: defaultOutput,
        format: textOrDataFormat(() => "Deleted API connection."),
      },
    },
  }),
  defineBackofficeRuntimeTool({
    ...backofficeApiOperationToolFields("api.auth.status"),
    namespace: "api",
    name: "getAuthStatus",
    capabilityId: "api",
    requiredPermissions: ["connections.read"],
    getResource: (input) => ({ slug: input.slug }),
    execute: async (input, context: ApiToolContext) =>
      await getApiRuntime(context.runtimes.api).getAuthStatus(input),
    adapters: {
      bash: {
        command: "api.auth.status",
        help: {
          summary: "api.auth.status shows auth status for an API connection.",
          options: [
            {
              name: "connection",
              required: true,
              valueRequired: true,
              valueName: "slug",
              description: "API connection slug",
            },
          ],
          examples: ["api.auth.status --connection stripe"],
        },
        parse: parseSlug,
        outputOptions: defaultOutput,
        format: textOrDataFormat((result: ApiAuthStatus) =>
          renderTable(
            ["authenticated", "mode", "expires"],
            [[result.authenticated, result.mode, result.expiresAt]],
          ),
        ),
      },
    },
  }),
  defineBackofficeRuntimeTool({
    ...backofficeApiOperationToolFields("api.auth.token"),
    namespace: "api",
    name: "setToken",
    capabilityId: "api",
    requiredPermissions: ["connections.create"],
    getResource: (input) => ({ slug: input.slug }),
    execute: async (input, context: ApiToolContext) =>
      await getApiRuntime(context.runtimes.api).setToken(input),
    adapters: {
      bash: {
        command: "api.auth.token",
        help: {
          summary: "api.auth.token stores a bearer token for an API connection.",
          options: [
            {
              name: "connection",
              required: true,
              valueRequired: true,
              valueName: "slug",
              description: "API connection slug",
            },
            {
              name: "token",
              required: true,
              valueRequired: true,
              valueName: "token",
              description: "Bearer token",
            },
          ],
          examples: ["api.auth.token --connection stripe --token $TOKEN"],
        },
        parse: parseSetToken,
        outputOptions: defaultOutput,
        format: textOrDataFormat((result: ApiAuthStatus) =>
          renderTable(["authenticated", "mode"], [[result.authenticated, result.mode]]),
        ),
      },
    },
  }),
  defineBackofficeRuntimeTool({
    ...backofficeApiOperationToolFields("api.oauth.start"),
    namespace: "api",
    name: "startOAuth",
    capabilityId: "api",
    requiredPermissions: ["connections.create"],
    getResource: (input) => ({ slug: input.slug }),
    execute: async (input, context: ApiToolContext) =>
      await getApiRuntime(context.runtimes.api).startOAuth(input),
    adapters: {
      bash: {
        command: "api.oauth.start",
        help: {
          summary: "api.oauth.start starts OAuth login for an API connection.",
          options: [
            {
              name: "connection",
              required: true,
              valueRequired: true,
              valueName: "slug",
              description: "API connection slug",
            },
            {
              name: "scope",
              valueRequired: true,
              valueName: "scopes",
              description: "Override configured scopes with a space/comma separated list",
            },
            {
              name: "extra-authorization-params-json",
              valueRequired: true,
              valueName: "json",
              description: "Extra OAuth authorization URL params as JSON object",
            },
          ],
          examples: ["api.oauth.start --connection billing --scope user,activity"],
        },
        parse: parseOAuthStart,
        outputOptions: defaultOutput,
        format: textOrDataFormat(
          (result: ApiOAuthStartOutput) =>
            `Open this URL to authorize API access:\n${result.authorizationUrl}\nstate=${result.state}`,
        ),
      },
    },
  }),
  defineBackofficeRuntimeTool({
    ...backofficeApiOperationToolFields("api.auth.delete"),
    namespace: "api",
    name: "deleteAuth",
    capabilityId: "api",
    requiredPermissions: ["connections.delete"],
    getResource: (input) => ({ slug: input.slug }),
    execute: async (input, context: ApiToolContext) =>
      await getApiRuntime(context.runtimes.api).deleteAuth(input),
    adapters: {
      bash: {
        command: "api.auth.delete",
        help: {
          summary: "api.auth.delete removes stored auth for an API connection.",
          options: [
            {
              name: "connection",
              required: true,
              valueRequired: true,
              valueName: "slug",
              description: "API connection slug",
            },
          ],
          examples: ["api.auth.delete --connection stripe"],
        },
        parse: parseSlug,
        outputOptions: defaultOutput,
        format: textOrDataFormat(() => "Deleted API connection auth."),
      },
    },
  }),
  defineBackofficeRuntimeTool({
    ...backofficeApiOperationToolFields("api.webhooks.list"),
    namespace: "api",
    name: "listWebhookEndpoints",
    capabilityId: "api",
    requiredPermissions: ["webhooks.read"],
    execute: async (_input, context: ApiToolContext) =>
      await getApiRuntime(context.runtimes.api).listWebhookEndpoints(),
    adapters: {
      bash: {
        command: "api.webhooks.list",
        help: {
          summary: "api.webhooks.list lists configured API webhook endpoints.",
          options: [],
          examples: ["api.webhooks.list"],
        },
        parse: defineNoInputArgsParser("api.webhooks.list"),
        outputOptions: defaultOutput,
        format: textOrDataFormat(renderWebhookEndpoints),
      },
    },
  }),
  defineBackofficeRuntimeTool({
    ...backofficeApiOperationToolFields("api.webhooks.get"),
    namespace: "api",
    name: "getWebhookEndpoint",
    capabilityId: "api",
    requiredPermissions: ["webhooks.read"],
    getResource: (input) => ({ endpointId: input.endpointId }),
    execute: async (input, context: ApiToolContext) =>
      await getApiRuntime(context.runtimes.api).getWebhookEndpoint(input),
    adapters: {
      bash: {
        command: "api.webhooks.get",
        help: {
          summary: "api.webhooks.get shows an API webhook endpoint.",
          options: [
            {
              name: "endpoint",
              required: true,
              valueRequired: true,
              valueName: "id",
              description: "Endpoint id",
            },
          ],
          examples: ["api.webhooks.get --endpoint stripe"],
        },
        parse: parseEndpoint,
        outputOptions: defaultOutput,
        format: textOrDataFormat((endpoint: ApiWebhookEndpoint) =>
          renderWebhookEndpointRows([endpoint]),
        ),
      },
    },
  }),
  defineBackofficeRuntimeTool({
    ...backofficeApiOperationToolFields("api.webhooks.create"),
    namespace: "api",
    name: "createWebhookEndpoint",
    capabilityId: "api",
    requiredPermissions: ["webhooks.manage"],
    getResource: (input) => ({ endpointId: input.endpointId }),
    execute: async (input, context: ApiToolContext) =>
      await getApiRuntime(context.runtimes.api).createWebhookEndpoint(input),
    adapters: {
      bash: {
        command: "api.webhooks.create",
        help: {
          summary: "api.webhooks.create configures an API webhook endpoint.",
          options: [
            {
              name: "endpoint",
              required: true,
              valueRequired: true,
              valueName: "id",
              description: "Endpoint id",
            },
            {
              name: "name",
              required: true,
              valueRequired: true,
              valueName: "name",
              description: "Display name",
            },
            {
              name: "status",
              valueRequired: true,
              valueName: "draft|active|disabled",
              description: "Endpoint status",
            },
            {
              name: "delivery-identity-json",
              required: true,
              valueRequired: true,
              valueName: "json",
              description: "Delivery id extractor",
            },
            {
              name: "auth-json",
              required: true,
              valueRequired: true,
              valueName: "json",
              description: "Webhook auth config with secret values",
            },
          ],
          examples: [
            'api.webhooks.create --endpoint stripe --name Stripe --delivery-identity-json \'{"type":"header","name":"stripe-signature"}\' --auth-json \'{"type":"none"}\'',
          ],
        },
        parse: parseWebhookCreate,
        outputOptions: defaultOutput,
        format: textOrDataFormat(
          (endpoint: ApiWebhookEndpoint) =>
            `Created API webhook endpoint\n\n${renderWebhookEndpointRows([endpoint])}`,
        ),
      },
    },
  }),
  defineBackofficeRuntimeTool({
    ...backofficeApiOperationToolFields("api.webhooks.update"),
    namespace: "api",
    name: "updateWebhookEndpoint",
    capabilityId: "api",
    requiredPermissions: ["webhooks.manage"],
    getResource: (input) => ({ endpointId: input.endpointId }),
    execute: async (input, context: ApiToolContext) =>
      await getApiRuntime(context.runtimes.api).updateWebhookEndpoint(input),
    adapters: {
      bash: {
        command: "api.webhooks.update",
        help: {
          summary: "api.webhooks.update updates an API webhook endpoint.",
          options: [
            {
              name: "endpoint",
              required: true,
              valueRequired: true,
              valueName: "id",
              description: "Endpoint id",
            },
            { name: "name", valueRequired: true, valueName: "name", description: "Display name" },
            {
              name: "status",
              valueRequired: true,
              valueName: "draft|active|disabled",
              description: "Endpoint status",
            },
            {
              name: "delivery-identity-json",
              valueRequired: true,
              valueName: "json",
              description: "Delivery id extractor",
            },
            {
              name: "auth-json",
              valueRequired: true,
              valueName: "json",
              description: "Webhook auth config with secret values",
            },
          ],
          examples: ["api.webhooks.update --endpoint stripe --status disabled"],
        },
        parse: parseWebhookUpdate,
        outputOptions: defaultOutput,
        format: textOrDataFormat((endpoint: ApiWebhookEndpoint) =>
          renderWebhookEndpointRows([endpoint]),
        ),
      },
    },
  }),
  defineBackofficeRuntimeTool({
    ...backofficeApiOperationToolFields("api.webhooks.delete"),
    namespace: "api",
    name: "deleteWebhookEndpoint",
    capabilityId: "api",
    requiredPermissions: ["webhooks.manage"],
    getResource: (input) => ({ endpointId: input.endpointId }),
    execute: async (input, context: ApiToolContext) =>
      await getApiRuntime(context.runtimes.api).deleteWebhookEndpoint(input),
    adapters: {
      bash: {
        command: "api.webhooks.delete",
        help: {
          summary: "api.webhooks.delete removes an API webhook endpoint.",
          options: [
            {
              name: "endpoint",
              required: true,
              valueRequired: true,
              valueName: "id",
              description: "Endpoint id",
            },
          ],
          examples: ["api.webhooks.delete --endpoint stripe"],
        },
        parse: parseEndpoint,
        outputOptions: defaultOutput,
        format: textOrDataFormat(() => "Deleted API webhook endpoint."),
      },
    },
  }),
  defineBackofficeRuntimeTool({
    ...backofficeApiOperationToolFields("api.request"),
    namespace: "api",
    name: "request",
    capabilityId: "api",
    requiredPermissions: ["requests.execute"],
    getResource: (input) => ({ slug: input.slug, path: input.path }),
    execute: async (input, context: ApiToolContext) =>
      await getApiRuntime(context.runtimes.api).request(input),
    adapters: {
      bash: {
        command: "api.request",
        help: {
          summary: "api.request executes an HTTP request through a configured API connection.",
          options: [
            {
              name: "connection",
              required: true,
              valueRequired: true,
              valueName: "slug",
              description: "API connection slug",
            },
            {
              name: "method",
              required: true,
              valueRequired: true,
              valueName: "method",
              description: "HTTP method",
            },
            {
              name: "path",
              required: true,
              valueRequired: true,
              valueName: "path",
              description: "Relative request path",
            },
            {
              name: "query-json",
              valueRequired: true,
              valueName: "json",
              description: "Query params as JSON object",
            },
            {
              name: "headers-json",
              valueRequired: true,
              valueName: "json",
              description: "Request headers as JSON object",
            },
            {
              name: "json",
              valueRequired: true,
              valueName: "json",
              description: "JSON request body",
            },
            {
              name: "body",
              valueRequired: true,
              valueName: "text",
              description: "Text request body",
            },
            {
              name: "timeout-ms",
              valueRequired: true,
              valueName: "ms",
              description: "Request timeout in milliseconds",
            },
          ],
          examples: [
            "api.request --connection stripe --method GET --path /v1/customers",
            "api.request --connection billing --method POST --path /invoices --json '{\"amount\":100}'",
          ],
        },
        parse: parseRequest,
        outputOptions: defaultOutput,
        format: textOrDataFormat(renderRequest),
      },
    },
  }),
] as const;

export const apiToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "api",
  permissions: apiPermissions,
  tools: apiRuntimeTools,
  isAvailable: (context: ApiToolContext) => !!context.runtimes.api,
});
