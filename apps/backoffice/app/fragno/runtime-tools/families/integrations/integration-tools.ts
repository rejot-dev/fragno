import {
  integrationActionSchema,
  integrationConnectionInputSchema,
  integrationConnectionSchema,
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
const parseIntegrationSetupFields = defineCliArgsParser<
  z.input<typeof integrationConnectionInputSchema> & { operation: IntegrationSetupOperation }
>("integrations.setup", {
  ...integrationConnectionCliFields,
  operation: { option: "input-json", read: readIntegrationSetupOperation },
});

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
          parse: (args) => {
            const { connectionId, operation } = parseIntegrationSetupFields(args);
            return { connectionId, ...operation };
          },
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
