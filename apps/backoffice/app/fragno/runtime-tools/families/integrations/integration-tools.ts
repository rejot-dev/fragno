import {
  integrationActionSchema,
  integrationConnectionEventsBackfillResultSchema,
  integrationConnectionInputSchema,
  integrationConnectionSchema,
  inspectedIntegrationConnectionSchema,
  integrationDisconnectInputSchema,
  integrationDisconnectResultSchema,
  integrationExecuteInputSchema,
  integrationListInputSchema,
  integrationListOutputSchema,
  integrationOverviewSchema,
  integrationSetupInputSchema,
  integrationSetupProgressSchema,
} from "@fragno-dev/backoffice-api/v0/integrations";
import type { JsonValue } from "@fragno-dev/backoffice-api/v0/shared/json";
import { z } from "zod";

import type { AutomationCommandOutputOptions } from "@/fragno/runtime-tools/automation-types";
import {
  defineCliArgsParser,
  defineNoInputArgsParser,
  readOpaqueStringOption,
  readStringOption,
  type ParsedCliTokens,
} from "@/fragno/runtime-tools/bash-cli";

import {
  backofficeApiOperationToolFields,
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "../../runtime-tools";
import { type IntegrationSetupOperation } from "./integration-contracts";
import type { IntegrationConnectionDetails } from "./integration-implementation";

/** Connection IDs address existing sources within the execution scope; they never confer authority. */
export type IntegrationsRuntime = {
  discover(): Promise<z.output<typeof integrationOverviewSchema>[]>;
  list(
    input: z.output<typeof integrationListInputSchema>,
  ): Promise<z.output<typeof integrationListOutputSchema>>;
  get(
    input: z.output<typeof integrationConnectionInputSchema>,
  ): Promise<z.output<typeof inspectedIntegrationConnectionSchema>>;
  setup(
    input: z.output<typeof integrationSetupInputSchema>,
  ): Promise<z.output<typeof integrationSetupProgressSchema>>;
  reconfigure(
    input: z.output<typeof integrationSetupInputSchema>,
  ): Promise<z.output<typeof integrationSetupProgressSchema>>;
  disconnect(
    input: z.output<typeof integrationDisconnectInputSchema>,
  ): Promise<z.output<typeof integrationDisconnectResultSchema>>;
  /** For Backoffice's read-only connection views; authorizes as integrations.get does. */
  describe(input: z.output<typeof integrationConnectionInputSchema>): Promise<{
    connection: z.output<typeof integrationConnectionSchema>;
    details: IntegrationConnectionDetails;
  }>;
  backfillConnectionEvents(): Promise<
    z.output<typeof integrationConnectionEventsBackfillResultSchema>
  >;
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
  isAvailable: (context: IntegrationsToolContext) => !!context.runtimes.integrations,
  tools: [
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("integrations.discover"),
      namespace: "integrations",
      name: "discover",
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
      ...backofficeApiOperationToolFields("integrations.list"),
      namespace: "integrations",
      name: "list",
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
      ...backofficeApiOperationToolFields("integrations.get"),
      namespace: "integrations",
      name: "get",
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
      ...backofficeApiOperationToolFields("integrations.setup"),
      namespace: "integrations",
      name: "setup",
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
      ...backofficeApiOperationToolFields("integrations.reconfigure"),
      namespace: "integrations",
      name: "reconfigure",
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
      ...backofficeApiOperationToolFields("integrations.disconnect"),
      namespace: "integrations",
      name: "disconnect",
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
      ...backofficeApiOperationToolFields("integrations.backfillConnectionEvents"),
      namespace: "integrations",
      name: "backfillConnectionEvents",
      execute: async (_input, context: IntegrationsToolContext) =>
        await requireIntegrationsRuntime(context).backfillConnectionEvents(),
      adapters: {
        bash: {
          command: "integrations.backfillConnectionEvents",
          help: {
            summary:
              "Record each configured connection's current state as an integrations.connection.* event.",
            options: [],
            examples: ["integrations.backfillConnectionEvents --format json"],
          },
          parse: defineNoInputArgsParser("integrations.backfillConnectionEvents"),
          format: formatIntegrationCommandOutput,
        },
      },
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("integrations.actions"),
      namespace: "integrations",
      name: "actions",
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
      ...backofficeApiOperationToolFields("integrations.execute"),
      namespace: "integrations",
      name: "execute",
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
      ...backofficeApiOperationToolFields("integrations.verify"),
      namespace: "integrations",
      name: "verify",
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
