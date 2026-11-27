import {
  integrationActionSchema,
  integrationGenerateClientInputSchema,
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
  integrationRequestInputSchema,
  integrationSetupInputSchema,
  integrationSetupProgressSchema,
} from "@fragno-dev/backoffice-api/v0/integrations";
import type { JsonValue } from "@fragno-dev/backoffice-api/v0/shared/json";
import { z } from "zod";

import { AUTOMATION_STATIC_ROOT } from "@/fragno/automation/automation-source";
import type { BackofficeStateBackend } from "@/fragno/codemode/state-backend";
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
import type { AutomationWorkflowRuntime, WorkflowRunPresenter } from "../automations-workflow";
import { writeIntegrationClientModule } from "./integration-client-module";
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
  state: BackofficeStateBackend | undefined;
  workflow?: AutomationWorkflowRuntime;
  workflowRunPresenter?: WorkflowRunPresenter;
}>;

/**
 * Agents read a check's instructions just before they act, and took the setup form for a card the
 * product shows by itself; the instructions name the call that shows it.
 */
function pointSecretsAtRequestInput(
  progress: z.output<typeof integrationSetupProgressSchema>,
  operation: "setup" | "reconfigure",
): z.output<typeof integrationSetupProgressSchema> {
  if (progress.status !== "needs-input" || progress.secretFields.length === 0) {
    return progress;
  }
  return {
    ...progress,
    instructions: `${progress.instructions} Ask the user for ${progress.secretFields.join(", ")} with integrations.requestInput({ operation: "${operation}", ... }) in this turn: it shows the form card, and no card exists until you call it.`,
  };
}

/** The form card integrations.requestInput starts; it submits the secrets once the user sends them. */
const INTEGRATION_INPUT_WORKFLOW_PATH = `${AUTOMATION_STATIC_ROOT}/integration-input.workflow.js`;

/**
 * Starts the form that asks the user for a connection's secrets. Only the check's secret fields can
 * be asked for, and input carries none of them, so secrets reach the connection only through the
 * form.
 */
async function requestIntegrationInput(
  request: z.output<typeof integrationRequestInputSchema>,
  context: IntegrationsToolContext,
) {
  const integrations = requireIntegrationsRuntime(context);
  const check = { kind: "check" as const, connectionId: request.connectionId };
  const progress =
    request.operation === "setup"
      ? await integrations.setup(check)
      : await integrations.reconfigure(check);
  if (progress.status !== "needs-input") {
    throw new Error(
      `${request.connectionId} does not need input for ${request.operation}: its check is ${progress.status}.`,
    );
  }
  const secretFields = new Set(progress.secretFields);
  for (const { field } of request.secrets) {
    if (!secretFields.has(field)) {
      throw new Error(
        `${field} is not a secret field of ${request.connectionId}; its secret fields are ${[...secretFields].join(", ")}.`,
      );
    }
    if (field in request.input) {
      throw new Error(`${field} is secret, so only the form collects it: leave it out of input.`);
    }
  }
  const { workflow, workflowRunPresenter } = context.runtimes;
  if (!workflow || !workflowRunPresenter) {
    throw new Error("Only an agent's own turn can show a form to the user.");
  }
  const { instanceId } = await workflow.createInstance({
    path: INTEGRATION_INPUT_WORKFLOW_PATH,
    instanceId: crypto.randomUUID(),
    payload: request,
    notifyWhenDone: true,
  });
  workflowRunPresenter.show(instanceId);
  return { instanceId };
}

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
  description:
    "Deterministic connection address in the selected scope, such as backoffice#telegram",
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
      activity: { label: "Discover services", target: () => null },
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
      activity: { label: "List connections", target: () => null },
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
      activity: { label: "Inspect connection", target: (input) => input.connectionId },
      getResource: (input) => ({ connectionId: input.connectionId }),
      execute: async (input, context: IntegrationsToolContext) =>
        await requireIntegrationsRuntime(context).get(input),
      adapters: {
        bash: {
          command: "integrations.get",
          help: {
            summary: "Inspect saved connection configuration without a live health check.",
            options: [integrationConnectionOption],
            examples: ["integrations.get --connection-id 'backoffice#telegram' --format json"],
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
      activity: { label: "Set up connection", target: (input) => input.connectionId },
      getResource: (input) => ({ connectionId: input.connectionId }),
      execute: async (input, context: IntegrationsToolContext) =>
        pointSecretsAtRequestInput(await requireIntegrationsRuntime(context).setup(input), "setup"),
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
              "integrations.setup --connection-id 'backoffice#telegram' --format json",
              "integrations.setup --connection-id 'backoffice#telegram' --input-json '{\"botToken\":\"...\"}' --format json",
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
      activity: { label: "Reconfigure connection", target: (input) => input.connectionId },
      getResource: (input) => ({ connectionId: input.connectionId }),
      execute: async (input, context: IntegrationsToolContext) =>
        pointSecretsAtRequestInput(
          await requireIntegrationsRuntime(context).reconfigure(input),
          "reconfigure",
        ),
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
      activity: { label: "Disconnect", target: (input) => input.connectionId },
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
      activity: { label: "Record connection states", target: () => null },
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
      activity: { label: "List connection actions", target: (input) => input.connectionId },
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
            examples: ["integrations.actions --connection-id 'backoffice#telegram' --format json"],
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
      activity: {
        label: "Run connection action",
        target: (input) => `${input.actionId} on ${input.connectionId}`,
      },
      getResource: (input, scope) => ({
        kind: "integration-connection",
        scope,
        connectionId: input.connectionId,
        actionId: input.actionId,
      }),
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
              {
                name: "unchecked",
                description:
                  "Run an action whose validation is unchecked, without validating input or output",
              },
            ],
            examples: [
              'integrations.execute --connection-id \'backoffice#telegram\' --action-id messages.send --input-json \'{"chatId":"123","text":"Hello","parseMode":null,"disableWebPagePreview":false,"replyToMessageId":null}\' --format json',
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
              unchecked: { kind: "boolean" },
            },
          ),
          format: formatIntegrationCommandOutput,
        },
      },
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("integrations.requestInput"),
      namespace: "integrations",
      name: "requestInput",
      activity: { label: "Ask for connection secrets", target: (input) => input.connectionId },
      getResource: (input) => ({ connectionId: input.connectionId }),
      execute: requestIntegrationInput,
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("integrations.generateClient"),
      namespace: "integrations",
      name: "generateClient",
      activity: { label: "Generate connection client", target: (input) => input.out },
      getResource: (input) => ({ connectionId: input.connectionId, path: input.out }),
      execute: async ({ connectionId, out }, context: IntegrationsToolContext) => {
        const integrations = requireIntegrationsRuntime(context);
        if (!context.runtimes.state) {
          throw new Error("Generating a client requires the workspace filesystem.");
        }
        return await writeIntegrationClientModule({
          connectionId,
          out,
          actions: await integrations.actions({ connectionId }),
          state: context.runtimes.state,
        });
      },
      adapters: {
        bash: {
          command: "integrations.generateClient",
          help: {
            summary:
              "Write a JavaScript module with one typed function per connection action, for codemode to import.",
            options: [
              integrationConnectionOption,
              {
                name: "out",
                required: true,
                valueRequired: true,
                valueName: "path",
                description:
                  "Output .js module under /workspace; only a previously generated client is replaced",
              },
            ],
            examples: [
              "integrations.generateClient --connection-id 'mcp#linear' --out /workspace/integrations/linear.js",
            ],
          },
          parse: defineCliArgsParser<z.input<typeof integrationGenerateClientInputSchema>>(
            "integrations.generateClient",
            { ...integrationConnectionCliFields, out: { required: true } },
          ),
          format: (client, options) =>
            options.format === "json" || options.print
              ? { data: client }
              : {
                  stdout: `${client.path}\n${client.exports.map(({ name, actionId }) => `${name}\t${actionId}\n`).join("")}`,
                },
        },
      },
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("integrations.verify"),
      namespace: "integrations",
      name: "verify",
      activity: { label: "Verify connection", target: (input) => input.connectionId },
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
            examples: ["integrations.verify --connection-id 'backoffice#telegram' --format json"],
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
