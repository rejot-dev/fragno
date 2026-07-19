import {
  createWebhookEndpointInputSchema as apiFragmentCreateWebhookEndpointInputSchema,
  updateWebhookEndpointInputSchema as apiFragmentUpdateWebhookEndpointInputSchema,
  webhookEndpointOutputSchema,
} from "@fragno-dev/api-fragment/types";
import { z } from "zod";

import {
  defineCliArgsParser,
  defineEmptyArgsParser,
  readOutputOptions,
  type ParsedCliTokens,
} from "@/fragno/runtime-tools/bash-cli";

import {
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "../runtime-tools";
import type { ApiRuntime } from "./api-runtime";

const authSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({ type: z.literal("bearer"), token: z.string().trim().min(1) }),
  z.object({
    type: z.literal("oauth"),
    authorizationEndpoint: z.url(),
    tokenEndpoint: z.url(),
    clientId: z.string().trim().min(1),
    clientSecret: z.string().trim().min(1).optional(),
    scopes: z.array(z.string().trim().min(1)).optional(),
    tokenEndpointAuthMethod: z.enum(["client_secret_basic", "client_secret_post", "none"]),
  }),
  z.object({
    type: z.literal("client_credentials"),
    tokenEndpoint: z.url(),
    clientId: z.string().trim().min(1),
    clientSecret: z.string().trim().min(1),
    scopes: z.array(z.string().trim().min(1)).optional(),
    audience: z.string().trim().min(1).optional(),
    tokenEndpointAuthMethod: z.enum(["client_secret_basic", "client_secret_post"]),
  }),
]);

const connectionSchema = z.object({
  slug: z.string().trim().min(1),
  name: z.string().nullable().optional(),
  baseUrl: z.url(),
  authMode: z.string().trim().min(1),
  status: z.string().trim().min(1),
  createdAt: z.union([z.string(), z.date()]).optional(),
  updatedAt: z.union([z.string(), z.date()]).optional(),
});
const connectionsOutputSchema = z.object({ connections: z.array(connectionSchema) });
const createConnectionInputSchema = z.object({
  slug: z
    .string()
    .trim()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().trim().optional(),
  baseUrl: z.url(),
  auth: authSchema.default({ type: "none" }),
});
const slugInputSchema = z.object({ slug: z.string().trim().min(1) });
const deleteOutputSchema = z.object({ ok: z.literal(true) });
const authStatusSchema = z.object({
  authenticated: z.boolean(),
  mode: z.string(),
  expiresAt: z.union([z.string(), z.date()]).nullable().optional(),
});
const setTokenInputSchema = z.object({
  slug: z.string().trim().min(1),
  token: z.string().trim().min(1),
});
const oauthStartInputSchema = z.object({
  slug: z.string().trim().min(1),
  scopes: z.array(z.string().trim().min(1)).optional(),
  extraAuthorizationParams: z.record(z.string(), z.string()).optional(),
});
const oauthStartOutputSchema = z.object({ authorizationUrl: z.url(), state: z.string() });
const requestInputSchema = z.object({
  slug: z.string().trim().min(1),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().trim().min(1),
  query: z.record(z.string(), z.string()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  json: z.unknown().optional(),
  body: z.string().optional(),
  timeoutMs: z.number().int().positive().max(120_000).optional(),
});
const requestOutputSchema = z.object({
  status: z.number().int(),
  statusText: z.string(),
  headers: z.record(z.string(), z.string()),
  body: z.unknown().nullable(),
});

const webhookEndpointSchema = webhookEndpointOutputSchema.extend({
  publicUrl: z.url().nullable(),
});
const webhookEndpointsOutputSchema = z.object({ endpoints: z.array(webhookEndpointSchema) });
const webhookEndpointCreateInputSchema = apiFragmentCreateWebhookEndpointInputSchema.extend({
  endpointId: z.string().trim().min(1),
});
const webhookEndpointUpdateInputSchema = apiFragmentUpdateWebhookEndpointInputSchema.extend({
  endpointId: z.string().trim().min(1),
});
const endpointInputSchema = z.object({ endpointId: z.string().trim().min(1) });

export type ApiConnection = z.infer<typeof connectionSchema>;
export type ApiListConnectionsOutput = z.infer<typeof connectionsOutputSchema>;
export type ApiAuthStatus = z.infer<typeof authStatusSchema>;
export type ApiSetTokenInput = Omit<z.infer<typeof setTokenInputSchema>, "slug">;
export type ApiOAuthStartInput = Omit<z.infer<typeof oauthStartInputSchema>, "slug">;
export type ApiOAuthStartOutput = z.infer<typeof oauthStartOutputSchema>;
export type ApiRequestOutput = z.infer<typeof requestOutputSchema>;
export type ApiWebhookEndpoint = z.infer<typeof webhookEndpointSchema>;
export type ApiWebhookEndpointsOutput = z.infer<typeof webhookEndpointsOutputSchema>;
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
  const body = typeof result.body === "string" ? result.body : JSON.stringify(result.body, null, 2);
  return [`${result.status} ${result.statusText}`, body].filter(Boolean).join("\n");
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

const readCliString = (parsed: ParsedCliTokens, name: string) => {
  const value = parsed.options.get(name);
  const lastValue = Array.isArray(value) ? value.at(-1) : value;
  if (typeof lastValue === "boolean") {
    throw new Error(`--${name} requires a value`);
  }
  return lastValue?.trim() || undefined;
};

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
        throw new Error("--auth must be one of: none, bearer, oauth, client_credentials");
      },
    },
  },
);
const parseSlug = defineCliArgsParser<{ slug: string }>("api.connection", {
  slug: { required: true, option: "connection" },
});
const parseSetToken = defineCliArgsParser<z.input<typeof setTokenInputSchema>>("api.auth.token", {
  slug: { required: true, option: "connection" },
  token: { required: true },
});
const parseOAuthStart = defineCliArgsParser<z.input<typeof oauthStartInputSchema>>(
  "api.oauth.start",
  {
    slug: { required: true, option: "connection" },
    scopes: { option: "scope", read: (parsed) => parseScopes(readCliString(parsed, "scope")) },
    extraAuthorizationParams: { option: "extra-authorization-params-json", kind: "json" },
  },
);
const parseRequest = defineCliArgsParser<z.input<typeof requestInputSchema>>("api.request", {
  slug: { required: true, option: "connection" },
  method: { required: true },
  path: { required: true },
  query: { option: "query-json", kind: "json" },
  headers: { option: "headers-json", kind: "json" },
  json: { option: "json", kind: "json" },
  body: { option: "body" },
  timeoutMs: { option: "timeout-ms", kind: "integer" },
});
const parseEndpoint = defineCliArgsParser<{ endpointId: string }>("api.webhooks.endpoint", {
  endpointId: { required: true, option: "endpoint" },
});
const parseWebhookCreate = defineCliArgsParser<z.input<typeof webhookEndpointCreateInputSchema>>(
  "api.webhooks.create",
  {
    endpointId: { required: true, option: "endpoint" },
    name: { required: true },
    status: {},
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
    id: "api.connections.list",
    namespace: "api",
    name: "listConnections",
    capabilityId: "api",
    description: "List API connections configured for the current scope.",
    requiredPermissions: ["connections.read"],
    inputSchema: z.object({}).optional().default({}),
    outputSchema: connectionsOutputSchema,
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
        parse: defineEmptyArgsParser("api.connections.list"),
        outputOptions: defaultOutput,
        format: textOrDataFormat(renderConnections),
      },
    },
  }),
  defineBackofficeRuntimeTool({
    id: "api.connections.create",
    namespace: "api",
    name: "createConnection",
    capabilityId: "api",
    description: "Create an outbound HTTP API connection.",
    requiredPermissions: ["connections.create"],
    getResource: (input) => ({ slug: input.slug }),
    inputSchema: createConnectionInputSchema,
    outputSchema: connectionSchema,
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
              description: "none|bearer|oauth|client_credentials",
            },
            { name: "token", valueRequired: true, valueName: "token", description: "Bearer token" },
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
    id: "api.connections.delete",
    namespace: "api",
    name: "deleteConnection",
    capabilityId: "api",
    description: "Delete an API connection and its stored auth state.",
    requiredPermissions: ["connections.delete"],
    getResource: (input) => ({ slug: input.slug }),
    inputSchema: slugInputSchema,
    outputSchema: deleteOutputSchema,
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
    id: "api.auth.status",
    namespace: "api",
    name: "getAuthStatus",
    capabilityId: "api",
    description: "Read auth status for an API connection.",
    requiredPermissions: ["connections.read"],
    getResource: (input) => ({ slug: input.slug }),
    inputSchema: slugInputSchema,
    outputSchema: authStatusSchema,
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
    id: "api.auth.token",
    namespace: "api",
    name: "setToken",
    capabilityId: "api",
    description: "Store a bearer token for a configured API connection.",
    requiredPermissions: ["connections.create"],
    getResource: (input) => ({ slug: input.slug }),
    inputSchema: setTokenInputSchema,
    outputSchema: authStatusSchema,
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
    id: "api.oauth.start",
    namespace: "api",
    name: "startOAuth",
    capabilityId: "api",
    description:
      "Start OAuth login for a configured API connection and return the authorization URL.",
    requiredPermissions: ["connections.create"],
    getResource: (input) => ({ slug: input.slug }),
    inputSchema: oauthStartInputSchema,
    outputSchema: oauthStartOutputSchema,
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
    id: "api.auth.delete",
    namespace: "api",
    name: "deleteAuth",
    capabilityId: "api",
    description: "Delete stored auth for an API connection.",
    requiredPermissions: ["connections.delete"],
    getResource: (input) => ({ slug: input.slug }),
    inputSchema: slugInputSchema,
    outputSchema: deleteOutputSchema,
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
    id: "api.webhooks.list",
    namespace: "api",
    name: "listWebhookEndpoints",
    capabilityId: "api",
    description: "List API webhook endpoints configured for the current scope.",
    requiredPermissions: ["webhooks.read"],
    inputSchema: z.object({}).optional().default({}),
    outputSchema: webhookEndpointsOutputSchema,
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
        parse: defineEmptyArgsParser("api.webhooks.list"),
        outputOptions: defaultOutput,
        format: textOrDataFormat(renderWebhookEndpoints),
      },
    },
  }),
  defineBackofficeRuntimeTool({
    id: "api.webhooks.get",
    namespace: "api",
    name: "getWebhookEndpoint",
    capabilityId: "api",
    description: "Read an API webhook endpoint.",
    requiredPermissions: ["webhooks.read"],
    getResource: (input) => ({ endpointId: input.endpointId }),
    inputSchema: endpointInputSchema,
    outputSchema: webhookEndpointSchema,
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
    id: "api.webhooks.create",
    namespace: "api",
    name: "createWebhookEndpoint",
    capabilityId: "api",
    description: "Create or replace an API webhook endpoint.",
    requiredPermissions: ["webhooks.manage"],
    getResource: (input) => ({ endpointId: input.endpointId }),
    inputSchema: webhookEndpointCreateInputSchema,
    outputSchema: webhookEndpointSchema,
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
    id: "api.webhooks.update",
    namespace: "api",
    name: "updateWebhookEndpoint",
    capabilityId: "api",
    description: "Update an API webhook endpoint.",
    requiredPermissions: ["webhooks.manage"],
    getResource: (input) => ({ endpointId: input.endpointId }),
    inputSchema: webhookEndpointUpdateInputSchema,
    outputSchema: webhookEndpointSchema,
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
    id: "api.webhooks.delete",
    namespace: "api",
    name: "deleteWebhookEndpoint",
    capabilityId: "api",
    description: "Delete an API webhook endpoint.",
    requiredPermissions: ["webhooks.manage"],
    getResource: (input) => ({ endpointId: input.endpointId }),
    inputSchema: endpointInputSchema,
    outputSchema: deleteOutputSchema,
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
    id: "api.request",
    namespace: "api",
    name: "request",
    capabilityId: "api",
    description: "Execute an HTTP request through a configured API connection.",
    requiredPermissions: ["requests.execute"],
    getResource: (input) => ({ slug: input.slug, path: input.path }),
    inputSchema: requestInputSchema,
    outputSchema: requestOutputSchema,
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
