import {
  projectConnectorAccountsSchema,
  projectConnectorConnectInputSchema,
  projectConnectorConnectionSchema,
  projectConnectorExecutionSchema,
  projectConnectorProfileSchema,
  projectConnectorProviderActionsSchema,
  projectConnectorProviderConfigsSchema,
  projectConnectorStatusSchema,
} from "@fragno-dev/project-connector-fragment/contracts";
import { z } from "zod";

import type { AutomationCommandOutputOptions } from "../automation-types";
import {
  defineCliArgsParser,
  defineNoInputArgsParser,
  ensureTrailingNewline,
  readOutputOptions,
  type ParsedCliTokens,
} from "../bash-cli";
import {
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "../runtime-tools";
import type { ProjectConnectorRuntime } from "./project-connector-runtime";

const connectInputSchema = z.union([
  projectConnectorConnectInputSchema.options[0].omit({ returnUri: true }),
  projectConnectorConnectInputSchema.options[1].omit({ returnUri: true }),
]);
const requestInputSchema = z.strictObject({ requestId: z.string().min(1) });
const accountsInputSchema = z
  .strictObject({ cursor: z.string().nullable().default(null) })
  .optional()
  .default({ cursor: null });
const profileInputSchema = z.strictObject({ accountId: z.string().min(1) });
const actionInputSchema = profileInputSchema.extend({
  actionId: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
});
const providerActionsInputSchema = z.strictObject({
  providerConfigId: projectConnectorProviderActionsSchema.shape.providerConfigId,
});
const noInputSchema = z.void();
type ProjectConnectorToolContext = BackofficeToolContext<{
  projectConnector: ProjectConnectorRuntime | undefined;
}>;

function getProjectConnectorRuntime(context: ProjectConnectorToolContext): ProjectConnectorRuntime {
  if (!context.runtimes.projectConnector) {
    throw new Error("Connector runtime is not available in this execution context");
  }
  return context.runtimes.projectConnector;
}
function outputOptions(_args: string[], parsed: ParsedCliTokens) {
  return readOutputOptions(parsed);
}
const parseConnectSelectors = defineCliArgsParser<{
  service: string | null;
  providerConfigId: string | null;
  connectionName: string;
}>("connector.connect", {
  service: { defaultValue: null },
  providerConfigId: { defaultValue: null },
  connectionName: { required: true },
});
function parseProjectConnectorConnect(args: string[]): z.input<typeof connectInputSchema> {
  const { service, providerConfigId, connectionName } = parseConnectSelectors(args);
  if (service && providerConfigId) {
    throw new Error("Connector connect requires exactly one of --service or --provider-config-id");
  }
  return providerConfigId
    ? { providerConfigId, connectionName }
    : { service: service ?? "", connectionName };
}

function formatConnectorProviderConfigs(
  output: z.output<typeof projectConnectorProviderConfigsSchema>,
  options: AutomationCommandOutputOptions,
) {
  if (options.format === "json" || options.print) {
    return { data: output };
  }
  const lines = [
    `Project: ${output.projectId}`,
    output.providerConfigs.length
      ? `OAuth provider configurations (${output.providerConfigs.length}):`
      : "No OAuth provider configurations available.",
    ...output.providerConfigs.map(
      (config) =>
        `- ${config.id}: ${config.displayName} (${config.service}) | proxy: ${config.proxyAvailable ? "yes" : "no"}`,
    ),
  ];
  return { stdout: ensureTrailingNewline(lines.join("\n")) };
}

function formatConnectorProviderActions(
  output: z.output<typeof projectConnectorProviderActionsSchema>,
  options: AutomationCommandOutputOptions,
) {
  if (options.format === "json" || options.print) {
    return { data: output };
  }
  const lines = [
    `Project: ${output.projectId}`,
    `Provider configuration: ${output.providerConfigId}`,
    output.actionIds.length
      ? `Action IDs (${output.actionIds.length}):`
      : "No action IDs available.",
    ...output.actionIds.map((actionId) => `- ${actionId}`),
  ];
  return { stdout: ensureTrailingNewline(lines.join("\n")) };
}

/** Provider actions require an explicit account and independent execution permission. */
export const projectConnectorToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "connector",
  permissions: {
    "providers.read":
      "Read the project's OAuth provider overviews and configuration-specific action IDs.",
    "accounts.read": "Read verified account bindings, profiles, and project authentication status.",
    "connections.create": "Start OAuth and confirm connection requests for the owning user.",
    "actions.execute": "Execute provider actions on an explicitly selected connected account.",
  },
  isAvailable: (context: ProjectConnectorToolContext) => !!context.runtimes.projectConnector,
  tools: [
    defineBackofficeRuntimeTool({
      id: "connector.providers.list",
      namespace: "connector",
      name: "listProviderConfigs",
      capabilityId: "connector",
      description:
        "List the project's OAuth provider configuration overviews without action IDs. Use listProviderActions for a selected providerConfigId; discovery does not verify user accounts.",
      requiredPermissions: ["providers.read"],
      inputSchema: noInputSchema,
      outputSchema: projectConnectorProviderConfigsSchema,
      execute: async (_input, context: ProjectConnectorToolContext) =>
        await getProjectConnectorRuntime(context).listProviderConfigs(),
      adapters: {
        bash: {
          command: "connector.providers.list",
          help: {
            summary:
              "connector.providers.list shows an overview of the project's OAuth provider configurations, without action IDs.",
            options: [],
            examples: ["connector.providers.list", "connector.providers.list --format json"],
          },
          parse: defineNoInputArgsParser("connector.providers.list"),
          outputOptions,
          format: formatConnectorProviderConfigs,
        },
      },
    }),
    defineBackofficeRuntimeTool({
      id: "connector.providers.actions",
      namespace: "connector",
      name: "listProviderActions",
      capabilityId: "connector",
      description:
        "List available action IDs for one exact OAuth provider configuration; this does not execute actions.",
      requiredPermissions: ["providers.read"],
      inputSchema: providerActionsInputSchema,
      outputSchema: projectConnectorProviderActionsSchema,
      getResource: (input) => ({ providerConfigId: input.providerConfigId }),
      execute: async (input, context: ProjectConnectorToolContext) =>
        await getProjectConnectorRuntime(context).listProviderActions(input),
      adapters: {
        bash: {
          command: "connector.providers.actions",
          help: {
            summary:
              "connector.providers.actions lists action IDs for one OAuth provider configuration, without executing them.",
            options: [
              {
                name: "provider-config-id",
                required: true,
                valueRequired: true,
                description: "Exact configuration ID from connector.providers.list",
              },
            ],
            examples: [
              "connector.providers.actions --provider-config-id PROVIDER_CONFIG_ID",
              "connector.providers.actions --provider-config-id PROVIDER_CONFIG_ID --format json",
            ],
          },
          parse: defineCliArgsParser<z.input<typeof providerActionsInputSchema>>(
            "connector.providers.actions",
            { providerConfigId: { required: true } },
          ),
          outputOptions,
          format: formatConnectorProviderActions,
        },
      },
    }),
    defineBackofficeRuntimeTool({
      id: "connector.status",
      namespace: "connector",
      name: "check",
      capabilityId: "connector",
      description:
        "Check gateway project-key authentication, not individual provider availability.",
      requiredPermissions: ["accounts.read"],
      inputSchema: noInputSchema,
      outputSchema: projectConnectorStatusSchema,
      execute: async (_input, context: ProjectConnectorToolContext) =>
        await getProjectConnectorRuntime(context).check(),
      adapters: {
        bash: {
          command: "connector.status",
          help: {
            summary: "connector.status checks gateway authentication.",
            options: [],
            examples: ["connector.status"],
          },
          parse: defineNoInputArgsParser("connector.status"),
          outputOptions,
        },
      },
    }),
    defineBackofficeRuntimeTool({
      id: "connector.connect",
      namespace: "connector",
      name: "connect",
      capabilityId: "connector",
      description:
        "Start provider OAuth for the owning user. Return the authorization URL and retain the request ID for refresh.",
      requiredPermissions: ["connections.create"],
      inputSchema: connectInputSchema,
      outputSchema: projectConnectorConnectionSchema,
      execute: async (input, context: ProjectConnectorToolContext) =>
        await getProjectConnectorRuntime(context).connect(input),
      adapters: {
        bash: {
          command: "connector.connect",
          help: {
            summary: "connector.connect starts OAuth; the user must complete browser consent.",
            options: [
              {
                name: "service",
                valueRequired: true,
                description: "Service, such as gmail; mutually exclusive with provider-config-id",
              },
              {
                name: "provider-config-id",
                valueRequired: true,
                description: "Explicit provider config; mutually exclusive with service",
              },
              {
                name: "connection-name",
                required: true,
                valueRequired: true,
                description: "Name for this connection",
              },
            ],
            examples: ["connector.connect --service gmail --connection-name work"],
          },
          parse: parseProjectConnectorConnect,
          outputOptions,
        },
      },
    }),
    defineBackofficeRuntimeTool({
      id: "connector.connections.refresh",
      namespace: "connector",
      name: "refreshConnection",
      capabilityId: "connector",
      description:
        "Verify a saved OAuth request against the gateway and persist a confirmed account binding. Callback query parameters are not proof.",
      requiredPermissions: ["connections.create"],
      inputSchema: requestInputSchema,
      outputSchema: projectConnectorConnectionSchema,
      getResource: (input) => ({ requestId: input.requestId }),
      execute: async (input, context: ProjectConnectorToolContext) =>
        await getProjectConnectorRuntime(context).refreshConnection(input),
      adapters: {
        bash: {
          command: "connector.connections.refresh",
          help: {
            summary: "connector.connections.refresh confirms OAuth completion with the gateway.",
            options: [
              {
                name: "request-id",
                required: true,
                valueRequired: true,
                description: "Saved request ID returned by connect",
              },
            ],
            examples: ["connector.connections.refresh --request-id REQUEST_ID"],
          },
          parse: defineCliArgsParser<z.input<typeof requestInputSchema>>(
            "connector.connections.refresh",
            { requestId: { required: true } },
          ),
          outputOptions,
        },
      },
    }),
    defineBackofficeRuntimeTool({
      id: "connector.accounts.list",
      namespace: "connector",
      name: "listAccounts",
      capabilityId: "connector",
      description: "List the owning user's locally verified accounts, one cursor page at a time.",
      requiredPermissions: ["accounts.read"],
      inputSchema: accountsInputSchema,
      outputSchema: projectConnectorAccountsSchema,
      execute: async (input, context: ProjectConnectorToolContext) =>
        await getProjectConnectorRuntime(context).listAccounts(input),
      adapters: {
        bash: {
          command: "connector.accounts.list",
          help: {
            summary: "connector.accounts.list lists one page of verified accounts.",
            options: [
              {
                name: "cursor",
                valueRequired: true,
                description: "Cursor from the preceding page",
              },
            ],
            examples: ["connector.accounts.list", "connector.accounts.list --cursor CURSOR"],
          },
          parse: defineCliArgsParser<z.output<typeof accountsInputSchema>>(
            "connector.accounts.list",
            { cursor: { defaultValue: null } },
          ),
          outputOptions,
        },
      },
    }),
    defineBackofficeRuntimeTool({
      id: "connector.accounts.profile",
      namespace: "connector",
      name: "getProfile",
      capabilityId: "connector",
      description:
        "Read the provider identity of a verified account; this does not read Gmail messages.",
      requiredPermissions: ["accounts.read"],
      inputSchema: profileInputSchema,
      outputSchema: projectConnectorProfileSchema,
      getResource: (input) => ({ accountId: input.accountId }),
      execute: async (input, context: ProjectConnectorToolContext) =>
        await getProjectConnectorRuntime(context).getProfile(input),
      adapters: {
        bash: {
          command: "connector.accounts.profile",
          help: {
            summary: "connector.accounts.profile performs a read-only profile check.",
            options: [
              {
                name: "account-id",
                required: true,
                valueRequired: true,
                description: "Verified connected account ID",
              },
            ],
            examples: ["connector.accounts.profile --account-id ACCOUNT_ID"],
          },
          parse: defineCliArgsParser<z.input<typeof profileInputSchema>>(
            "connector.accounts.profile",
            { accountId: { required: true } },
          ),
          outputOptions,
        },
      },
    }),
    defineBackofficeRuntimeTool({
      id: "connector.actions.execute",
      namespace: "connector",
      name: "executeAction",
      capabilityId: "connector",
      description:
        "Execute an explicit provider action on a verified account. Actions can write external data and are never automatically retried.",
      requiredPermissions: ["actions.execute"],
      inputSchema: actionInputSchema,
      outputSchema: projectConnectorExecutionSchema,
      getResource: (input) => ({ accountId: input.accountId, actionId: input.actionId }),
      execute: async (input, context: ProjectConnectorToolContext) =>
        await getProjectConnectorRuntime(context).executeAction(input),
      adapters: {
        bash: {
          command: "connector.actions.execute",
          help: {
            summary:
              "connector.actions.execute can modify provider data; choose the account and action explicitly.",
            options: [
              {
                name: "account-id",
                required: true,
                valueRequired: true,
                description: "Verified connected account ID",
              },
              {
                name: "action-id",
                required: true,
                valueRequired: true,
                description: "Action in this account's service",
              },
              {
                name: "input-json",
                required: true,
                valueRequired: true,
                description: "Provider-specific JSON object",
              },
            ],
            examples: [
              'connector.actions.execute --account-id ACCOUNT_ID --action-id gmail.search_threads --input-json \'{"query":"is:unread"}\'',
            ],
          },
          parse: defineCliArgsParser<z.input<typeof actionInputSchema>>(
            "connector.actions.execute",
            {
              accountId: { required: true },
              actionId: { required: true },
              input: { option: "input-json", kind: "json", required: true },
            },
          ),
          outputOptions,
        },
      },
    }),
  ],
});
