import { z } from "zod";

import type { AutomationCommandOutputOptions } from "@/fragno/runtime-tools/automation-types";
import {
  defineCliArgsParser,
  defineNoInputArgsParser,
  readOpaqueStringOption,
  readStringOption,
  type ParsedCliTokens,
} from "@/fragno/runtime-tools/bash-cli";
import { jsonValueSchema, type JsonValue } from "@/lib/zod/json-value";

import {
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "../../runtime-tools";
import {
  integrationActionSchema,
  integrationConnectionInputSchema,
  integrationConnectionSchema,
  integrationDisconnectInputSchema,
  integrationDisconnectResultSchema,
  integrationExecuteInputSchema,
  integrationListInputSchema,
  integrationListOutputSchema,
  integrationOverviewSchema,
  integrationSetupInputSchema,
  integrationSetupProgressSchema,
  type IntegrationSetupOperation,
} from "./integration-contracts";

/** Connection IDs address existing sources within the execution scope; they never confer authority. */
export type IntegrationsRuntime = {
  discover(): Promise<z.output<typeof integrationOverviewSchema>[]>;
  list(
    input: z.output<typeof integrationListInputSchema>,
  ): Promise<z.output<typeof integrationListOutputSchema>>;
  get(
    input: z.output<typeof integrationConnectionInputSchema>,
  ): Promise<z.output<typeof integrationConnectionSchema>>;
  setup(
    input: z.output<typeof integrationSetupInputSchema>,
  ): Promise<z.output<typeof integrationSetupProgressSchema>>;
  reconfigure(
    input: z.output<typeof integrationSetupInputSchema>,
  ): Promise<z.output<typeof integrationSetupProgressSchema>>;
  disconnect(
    input: z.output<typeof integrationDisconnectInputSchema>,
  ): Promise<z.output<typeof integrationDisconnectResultSchema>>;
  actions(
    input: z.output<typeof integrationConnectionInputSchema>,
  ): Promise<z.output<typeof integrationActionSchema>[]>;
  execute(input: z.output<typeof integrationExecuteInputSchema>): Promise<JsonValue>;
  verify(
    input: z.output<typeof integrationConnectionInputSchema>,
  ): Promise<z.output<typeof integrationConnectionSchema>>;
};
type IntegrationsToolContext = BackofficeToolContext<{
  integrations: IntegrationsRuntime | undefined;
}>;

function requireIntegrationsRuntime(context: IntegrationsToolContext): IntegrationsRuntime {
  if (!context.runtimes.integrations) {
    throw new Error("Integrations runtime is not implemented in this execution context.");
  }
  return context.runtimes.integrations;
}

const integrationConnectionOption = {
  name: "connection-id",
  required: true,
  valueRequired: true,
  description: "Deterministic connection address in the selected scope, such as backoffice#reson8",
};
const integrationConnectionCliFields = {
  connectionId: { required: true, read: readOpaqueStringOption },
} as const;
function parseIntegrationProgressFields(
  command: "integrations.setup" | "integrations.reconfigure",
) {
  const parse = defineCliArgsParser<
    z.input<typeof integrationConnectionInputSchema> & { operation: IntegrationSetupOperation }
  >(command, {
    ...integrationConnectionCliFields,
    operation: { option: "input-json", read: readIntegrationSetupOperation },
  });
  return (args: string[]) => {
    const { connectionId, operation } = parse(args);
    return { connectionId, ...operation };
  };
}

function readIntegrationJsonInput(
  parsed: ParsedCliTokens,
  optionName: string,
  required: true,
): JsonValue;
function readIntegrationJsonInput(
  parsed: ParsedCliTokens,
  optionName: string,
  required: boolean,
): JsonValue | undefined;
function readIntegrationJsonInput(
  parsed: ParsedCliTokens,
  optionName: string,
  required: boolean,
): JsonValue | undefined {
  const raw = readStringOption(parsed, optionName, required);
  if (raw === undefined) {
    return undefined;
  }
  // The shared JSON reader accepts only objects; actions can also accept scalars, arrays, or null.
  try {
    return JSON.parse(raw) as JsonValue;
  } catch {
    throw new Error("Integrations --input-json must be valid JSON.");
  }
}

function readIntegrationSetupOperation(
  parsed: ParsedCliTokens,
  optionName: string,
): IntegrationSetupOperation {
  if (!parsed.options.has(optionName)) {
    return { kind: "check" };
  }
  // Keep the JSON payload inside an operation so the shared parser cannot coalesce null into omission.
  return { kind: "input", input: readIntegrationJsonInput(parsed, optionName, true) };
}

function formatIntegrationCommandOutput(data: unknown, options: AutomationCommandOutputOptions) {
  if (options.format === "json" || options.print) {
    return { data };
  }
  return { stdout: `${JSON.stringify(data, null, 2)}\n` };
}

/** Registered tools generate both Codemode contracts and terminal commands from their canonical schemas. */
export const integrationsToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "integrations",
  permissions: {
    read: "Discover services and actions, and inspect scoped integration state.",
    manage:
      "Set up, reconfigure, disconnect, and verify scoped integrations using their existing service-owned stores.",
    execute: "Dispatch scoped integration actions, subject to their own authorization checks.",
  },
  isAvailable: (context: IntegrationsToolContext) => !!context.runtimes.integrations,
  tools: [
    defineBackofficeRuntimeTool({
      id: "integrations.discover",
      namespace: "integrations",
      name: "discover",
      description:
        "Discover available services and unconfigured services in the selected scope. Service availability does not prove live health.",
      requiredPermissions: ["read"],
      inputSchema: z.void(),
      outputSchema: z.array(integrationOverviewSchema),
      execute: async (_input, context: IntegrationsToolContext) =>
        await requireIntegrationsRuntime(context).discover(),
      adapters: {
        bash: {
          command: "integrations.discover",
          help: {
            summary:
              "Discover services in the selected scope without configuring or checking them.",
            options: [],
            examples: ["integrations.discover", "integrations.discover --format json"],
          },
          parse: defineNoInputArgsParser("integrations.discover"),
          format: formatIntegrationCommandOutput,
        },
      },
    }),
    defineBackofficeRuntimeTool({
      id: "integrations.list",
      namespace: "integrations",
      name: "list",
      description:
        "List existing configured connections in the selected scope, one cursor page at a time. Deterministic IDs reuse source-owned identities; configuration does not imply live access.",
      requiredPermissions: ["read"],
      inputSchema: integrationListInputSchema,
      outputSchema: integrationListOutputSchema,
      execute: async (input, context: IntegrationsToolContext) =>
        await requireIntegrationsRuntime(context).list(input),
      adapters: {
        bash: {
          command: "integrations.list",
          help: {
            summary: "List one page of configured connections with their deterministic scoped IDs.",
            options: [
              {
                name: "cursor",
                valueRequired: true,
                description: "Opaque cursor from the preceding page; omit to start",
              },
            ],
            examples: ["integrations.list", "integrations.list --print connections.0.connectionId"],
          },
          parse: defineCliArgsParser<z.input<typeof integrationListInputSchema>>(
            "integrations.list",
            { cursor: { defaultValue: null, read: readOpaqueStringOption } },
          ),
          format: formatIntegrationCommandOutput,
        },
      },
    }),
    defineBackofficeRuntimeTool({
      id: "integrations.get",
      namespace: "integrations",
      name: "get",
      description:
        "Inspect source-owned connection configuration and available evidence without performing a live health check. The connection ID resolves only within the selected scope.",
      requiredPermissions: ["read"],
      inputSchema: integrationConnectionInputSchema,
      outputSchema: integrationConnectionSchema,
      getResource: (input) => ({ connectionId: input.connectionId }),
      execute: async (input, context: IntegrationsToolContext) =>
        await requireIntegrationsRuntime(context).get(input),
      adapters: {
        bash: {
          command: "integrations.get",
          help: {
            summary: "Inspect saved connection configuration without a live health check.",
            options: [integrationConnectionOption],
            examples: ["integrations.get --connection-id 'backoffice#reson8' --format json"],
          },
          parse: defineCliArgsParser<z.input<typeof integrationConnectionInputSchema>>(
            "integrations.get",
            integrationConnectionCliFields,
          ),
          format: formatIntegrationCommandOutput,
        },
      },
    }),
    defineBackofficeRuntimeTool({
      id: "integrations.setup",
      namespace: "integrations",
      name: "setup",
      description:
        "Read current requirements or submit input for a deterministic connection address. Setup is source-owned; this operation retains no attempt state or independent binding. Ready connections keep their configuration and credentials; reconfigure replaces them.",
      requiredPermissions: ["manage"],
      inputSchema: integrationSetupInputSchema,
      outputSchema: integrationSetupProgressSchema,
      getResource: (input) => ({ connectionId: input.connectionId }),
      execute: async (input, context: IntegrationsToolContext) =>
        await requireIntegrationsRuntime(context).setup(input),
      adapters: {
        bash: {
          command: "integrations.setup",
          help: {
            summary:
              "Read source-owned setup requirements, or submit requested input without retaining a setup handle.",
            options: [
              integrationConnectionOption,
              {
                name: "input-json",
                valueRequired: true,
                description:
                  "Direct JSON setup input, including null; omit to check current requirements",
              },
            ],
            examples: [
              "integrations.setup --connection-id 'backoffice#reson8' --format json",
              "integrations.setup --connection-id 'backoffice#reson8' --input-json '{\"apiKey\":\"...\"}' --format json",
            ],
          },
          parse: parseIntegrationProgressFields("integrations.setup"),
          format: formatIntegrationCommandOutput,
        },
      },
    }),
    defineBackofficeRuntimeTool({
      id: "integrations.reconfigure",
      namespace: "integrations",
      name: "reconfigure",
      description:
        "Read replacement requirements or submit replacement configuration or credentials for an existing connection. Submission replaces source-owned state; continue with setup checks until ready. A missing connection needs setup.",
      requiredPermissions: ["manage"],
      inputSchema: integrationSetupInputSchema,
      outputSchema: integrationSetupProgressSchema,
      getResource: (input) => ({ connectionId: input.connectionId }),
      execute: async (input, context: IntegrationsToolContext) =>
        await requireIntegrationsRuntime(context).reconfigure(input),
      adapters: {
        bash: {
          command: "integrations.reconfigure",
          help: {
            summary:
              "Read replacement requirements, or submit a replacement for an existing connection's configuration or credentials.",
            options: [
              integrationConnectionOption,
              {
                name: "input-json",
                valueRequired: true,
                description:
                  "Direct JSON replacement input, including null; omit to read replacement requirements",
              },
            ],
            examples: [
              "integrations.reconfigure --connection-id 'api#stripe' --format json",
              "integrations.reconfigure --connection-id 'api#github' --input-json '{\"reauthorize\":true}' --format json",
            ],
          },
          parse: parseIntegrationProgressFields("integrations.reconfigure"),
          format: formatIntegrationCommandOutput,
        },
      },
    }),
    defineBackofficeRuntimeTool({
      id: "integrations.disconnect",
      namespace: "integrations",
      name: "disconnect",
      description:
        "Remove a connection's source-owned configuration and credentials in the selected scope. The address stays valid for a later setup. Requires confirm to repeat the connection ID.",
      requiredPermissions: ["manage"],
      inputSchema: integrationDisconnectInputSchema,
      outputSchema: integrationDisconnectResultSchema,
      getResource: (input) => ({ connectionId: input.connectionId }),
      execute: async (input, context: IntegrationsToolContext) =>
        await requireIntegrationsRuntime(context).disconnect(input),
      adapters: {
        bash: {
          command: "integrations.disconnect",
          help: {
            summary:
              "Remove a connection's configuration and credentials; the address remains available for setup.",
            options: [
              integrationConnectionOption,
              {
                name: "confirm",
                required: true,
                valueRequired: true,
                description: "Repeat the connection ID to confirm removal",
              },
            ],
            examples: [
              "integrations.disconnect --connection-id 'api#stripe' --confirm 'api#stripe' --format json",
            ],
          },
          parse: defineCliArgsParser<z.input<typeof integrationDisconnectInputSchema>>(
            "integrations.disconnect",
            {
              ...integrationConnectionCliFields,
              confirm: { required: true, read: readOpaqueStringOption },
            },
          ),
          format: formatIntegrationCommandOutput,
        },
      },
    }),
    defineBackofficeRuntimeTool({
      id: "integrations.actions",
      namespace: "integrations",
      name: "actions",
      description:
        "Discover the selected connection's supported actions and authoritative input/output contracts without executing them. Never infer schemas from action IDs.",
      requiredPermissions: ["read"],
      inputSchema: integrationConnectionInputSchema,
      outputSchema: z.array(integrationActionSchema),
      getResource: (input) => ({ connectionId: input.connectionId }),
      execute: async (input, context: IntegrationsToolContext) =>
        await requireIntegrationsRuntime(context).actions(input),
      adapters: {
        bash: {
          command: "integrations.actions",
          help: {
            summary:
              "Discover a connection's authoritative action contracts without executing them.",
            options: [integrationConnectionOption],
            examples: ["integrations.actions --connection-id 'backoffice#reson8' --format json"],
          },
          parse: defineCliArgsParser<z.input<typeof integrationConnectionInputSchema>>(
            "integrations.actions",
            integrationConnectionCliFields,
          ),
          format: formatIntegrationCommandOutput,
        },
      },
    }),
    defineBackofficeRuntimeTool({
      id: "integrations.execute",
      namespace: "integrations",
      name: "execute",
      description:
        "Execute an explicit connection action with JSON input/output, validated against its live contracts and service permissions. Binary inputs are schema-declared byte arrays; results retain the action's domain and asynchronous semantics.",
      requiredPermissions: ["execute"],
      inputSchema: integrationExecuteInputSchema,
      outputSchema: jsonValueSchema.meta({ codemodeType: "JsonValue" }),
      getResource: (input) => ({ connectionId: input.connectionId, actionId: input.actionId }),
      execute: async (input, context: IntegrationsToolContext) =>
        await requireIntegrationsRuntime(context).execute(input),
      adapters: {
        bash: {
          command: "integrations.execute",
          help: {
            summary:
              "Execute an explicit action; live contracts and permissions apply, and actions may modify external data.",
            options: [
              integrationConnectionOption,
              {
                name: "action-id",
                required: true,
                valueRequired: true,
                description: "Action ID returned by integrations.actions",
              },
              {
                name: "input-json",
                required: true,
                valueRequired: true,
                description:
                  "JSON input, including null; binary fields use schema-declared byte arrays",
              },
            ],
            examples: [
              'integrations.execute --connection-id \'backoffice#reson8\' --action-id prerecorded.transcribe --input-json \'{"audio":{"bytes":[0,127,255]},"query":null}\' --format json',
            ],
          },
          parse: defineCliArgsParser<z.input<typeof integrationExecuteInputSchema>>(
            "integrations.execute",
            {
              ...integrationConnectionCliFields,
              actionId: { required: true, read: readOpaqueStringOption },
              input: {
                option: "input-json",
                required: true,
                read: readIntegrationJsonInput,
                defaultValue: null,
              },
            },
          ),
          format: formatIntegrationCommandOutput,
        },
      },
    }),
    defineBackofficeRuntimeTool({
      id: "integrations.verify",
      namespace: "integrations",
      name: "verify",
      description:
        "Perform explicit supported live checks without authorizing the connection or executing service actions. Return timestamped evidence, not blanket health or retained verification state.",
      requiredPermissions: ["manage"],
      inputSchema: integrationConnectionInputSchema,
      outputSchema: integrationConnectionSchema,
      getResource: (input) => ({ connectionId: input.connectionId }),
      execute: async (input, context: IntegrationsToolContext) =>
        await requireIntegrationsRuntime(context).verify(input),
      adapters: {
        bash: {
          command: "integrations.verify",
          help: {
            summary:
              "Perform explicit live checks without running service actions or retaining a health cache.",
            options: [integrationConnectionOption],
            examples: ["integrations.verify --connection-id 'backoffice#reson8' --format json"],
          },
          parse: defineCliArgsParser<z.input<typeof integrationConnectionInputSchema>>(
            "integrations.verify",
            integrationConnectionCliFields,
          ),
          format: formatIntegrationCommandOutput,
        },
      },
    }),
  ],
});
