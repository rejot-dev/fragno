import {
  type ApiWebhookEndpoint,
  type ApiWebhookEndpointsOutput,
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

const renderWebhookEndpointRows = (endpoints: readonly ApiWebhookEndpoint[]) =>
  renderTable(
    ["endpoint", "name", "status", "public URL"],
    endpoints.map((endpoint) => [endpoint.id, endpoint.name, endpoint.status, endpoint.publicUrl]),
  );

const renderWebhookEndpoints = (result: ApiWebhookEndpointsOutput) =>
  result.endpoints.length
    ? renderWebhookEndpointRows(result.endpoints)
    : "No API webhook endpoints configured.";

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

export const apiRuntimeTools = [
  defineBackofficeRuntimeTool({
    ...backofficeApiOperationToolFields("api.webhooks.list"),
    namespace: "api",
    name: "listWebhookEndpoints",
    capabilityId: "api",
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
] as const;

export const apiToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "api",
  tools: apiRuntimeTools,
  isAvailable: (context: ApiToolContext) => !!context.runtimes.api,
});
