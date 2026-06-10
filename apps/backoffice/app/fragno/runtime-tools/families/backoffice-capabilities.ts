import { z } from "zod";

import { listAutomationEventDescriptors } from "@/fragno/backoffice-capabilities/backoffice-capabilities";
import {
  getConnectionCapability,
  listConnectionCapabilities,
} from "@/fragno/backoffice-capabilities/backoffice-capabilities";
import { listHookScopes } from "@/fragno/backoffice-capabilities/backoffice-capabilities";
import { backofficeCapabilities } from "@/fragno/backoffice-capabilities/backoffice-capabilities";
import type { ConnectionStatus } from "@/fragno/backoffice-capabilities/backoffice-capabilities";
import {
  defineCliArgsParser,
  defineEmptyArgsParser,
  parseCliTokens,
  readOutputOptions,
} from "@/fragno/runtime-tools/bash-cli";
import { formatJsonSchemaFields } from "@/lib/zod/zod-formatter";

import {
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "../runtime-tools";

export type BackofficeCapabilitiesRuntime = {
  listCapabilities(): Promise<CapabilitiesListOutput>;
  listHookScopes(): Promise<HookScopesListOutput>;
  listConnections(): Promise<ConnectionsListOutput>;
  getConnection(input: { id: string }): Promise<ConnectionStatus>;
  setupConnection(input: { id: string }): Promise<ConnectionSetupOutput>;
  getConnectionSchema(input: { id: string }): Promise<ConnectionSchemaOutput>;
  verifyConnection(input: { id: string }): Promise<ConnectionStatus>;
  resetConnection(input: { id: string; confirm: string }): Promise<ConnectionStatus>;
  configureConnection(input: {
    id: string;
    payload: unknown;
    origin?: string;
  }): Promise<ConnectionStatus>;
  listAutomationEvents(): Promise<AutomationEventsCatalogListOutput>;
  getAutomationEvent(
    input: AutomationEventCatalogGetInput,
  ): Promise<AutomationEventCatalogEntry | null>;
};

type BackofficeCapabilitiesToolContext = BackofficeToolContext<{
  backoffice?: BackofficeCapabilitiesRuntime;
}>;

const nonEmptyString = z.string().trim().min(1);

const capabilitySummarySchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(["connection", "system"]),
  available: z.boolean(),
  configured: z.boolean(),
  healthy: z.boolean().optional(),
  reason: z.string().optional(),
});
const capabilitiesListOutputSchema = z.array(capabilitySummarySchema);
export type CapabilitiesListOutput = z.infer<typeof capabilitiesListOutputSchema>;

const hookScopeOutputSchema = z.object({
  id: z.string(),
  label: z.string(),
  capabilityId: z.string(),
  capabilityLabel: z.string(),
  kind: z.enum(["connection", "system"]),
  configured: z.boolean().optional(),
  healthy: z.boolean().optional(),
});
const hookScopesListOutputSchema = z.array(hookScopeOutputSchema);
export type HookScopesListOutput = z.infer<typeof hookScopesListOutputSchema>;

const connectionSummarySchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(["connection", "system"]),
  configured: z.boolean(),
  hookScopes: z.array(z.string()),
  runtimeToolNamespaces: z.array(z.string()),
  automationEvents: z.array(z.string()),
  missing: z.array(z.string()).optional(),
});
const connectionsListOutputSchema = z.array(connectionSummarySchema);
export type ConnectionsListOutput = z.infer<typeof connectionsListOutputSchema>;

const connectionStatusSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(["connection", "system"]),
  configured: z.boolean(),
  config: z.record(z.string(), z.unknown()).optional(),
  missing: z.array(z.string()).optional(),
  nextSteps: z.array(z.string()).optional(),
  verification: z.object({ ok: z.boolean(), message: z.string() }).optional(),
});

const connectionSetupOutputSchema = z.object({
  id: z.string(),
  label: z.string(),
  overview: z.string(),
  manualSteps: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      instructions: z.string(),
      expectedUserInput: z.array(z.string()).optional(),
    }),
  ),
  fields: z.array(
    z.object({
      name: z.string(),
      required: z.boolean().optional(),
      secret: z.boolean().optional(),
      description: z.string().optional(),
    }),
  ),
  verify: z.object({ tool: z.string(), description: z.string() }).optional(),
  configureExample: z.string(),
});
export type ConnectionSetupOutput = z.infer<typeof connectionSetupOutputSchema>;

const connectionSchemaOutputSchema = z.object({
  id: z.string(),
  label: z.string(),
  fields: connectionSetupOutputSchema.shape.fields,
});
export type ConnectionSchemaOutput = z.infer<typeof connectionSchemaOutputSchema>;

const jsonSchemaSchema = z.record(z.string(), z.unknown());

const automationEventDescriptorSchema = z.object({
  source: z.string(),
  eventType: z.string(),
  label: z.string(),
  description: z.string().optional(),
  capabilityId: z.string(),
  payloadSchema: jsonSchemaSchema.optional(),
  actorSchema: jsonSchemaSchema.optional(),
  subjectSchema: jsonSchemaSchema.optional(),
  example: z.unknown().optional(),
});
const automationEventsCatalogListOutputSchema = z.array(
  automationEventDescriptorSchema.omit({
    payloadSchema: true,
    actorSchema: true,
    subjectSchema: true,
  }),
);
const automationEventCatalogGetInputSchema = z.object({
  source: nonEmptyString,
  type: nonEmptyString,
});
const automationEventCatalogGetOutputSchema = automationEventDescriptorSchema.nullable();
export type AutomationEventCatalogEntry = z.infer<typeof automationEventDescriptorSchema>;
export type AutomationEventsCatalogListOutput = z.infer<
  typeof automationEventsCatalogListOutputSchema
>;
export type AutomationEventCatalogGetInput = z.infer<typeof automationEventCatalogGetInputSchema>;

const getRuntime = (context: BackofficeCapabilitiesToolContext) => {
  if (!context.runtimes.backoffice) {
    throw new Error("Backoffice capability runtime is not available in this execution context");
  }
  return context.runtimes.backoffice;
};

const parseIdOnly = (command: string) =>
  defineCliArgsParser<{ id: string }>(command, { id: { required: true } });

const parseReset = defineCliArgsParser<{ id: string; confirm: string }>("connections.reset", {
  id: { required: true },
  confirm: { required: true },
});

const parseConfigure = defineCliArgsParser<{ id: string; payload: unknown; origin?: string }>(
  "connections.configure",
  {
    id: { required: true },
    payload: { kind: "json", option: "json", required: true },
    origin: {},
  },
);

type OutputOptions = ReturnType<typeof readOutputOptions>;

const readOutput = (args: string[]) => readOutputOptions(parseCliTokens(args));
const shouldReturnData = (options: OutputOptions) =>
  options.format === "json" || Boolean(options.print);
const dataFormat = <T>(data: T) => ({ data });
const cell = (value: unknown) => {
  if (Array.isArray(value)) {
    return value.length ? value.join(", ") : "-";
  }
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
  return `${[
    renderRow(headers),
    renderRow(widths.map((width) => "-".repeat(width))),
    ...normalizedRows.map(renderRow),
  ].join("\n")}\n`;
};

const formatCapabilitiesList = (data: CapabilitiesListOutput, options: OutputOptions) =>
  shouldReturnData(options)
    ? dataFormat(data)
    : {
        stdout: renderTable(
          ["capability", "kind", "available", "configured", "healthy", "reason"],
          data.map((item) => [
            item.id,
            item.kind,
            item.available,
            item.configured,
            item.healthy ?? "-",
            item.reason ?? "",
          ]),
        ),
      };

const formatHookScopesList = (data: HookScopesListOutput, options: OutputOptions) =>
  shouldReturnData(options)
    ? dataFormat(data)
    : {
        stdout: renderTable(
          ["fragment", "label", "capability", "kind", "configured", "healthy"],
          data.map((item) => [
            item.id,
            item.label,
            item.capabilityId,
            item.kind,
            item.configured ?? "-",
            item.healthy ?? "-",
          ]),
        ),
      };

const formatConnectionsList = (data: ConnectionsListOutput, options: OutputOptions) =>
  shouldReturnData(options)
    ? dataFormat(data)
    : {
        stdout: renderTable(
          ["connection", "configured", "hooks", "tools", "events", "missing"],
          data.map((item) => [
            item.id,
            item.configured,
            item.hookScopes,
            item.runtimeToolNamespaces,
            item.automationEvents,
            item.missing ?? [],
          ]),
        ),
      };

const formatConnectionStatus = (data: ConnectionStatus, options: OutputOptions) => {
  if (shouldReturnData(options)) {
    return dataFormat(data);
  }
  const lines = [
    `${data.id}\tconfigured=${cell(data.configured)}`,
    ...(data.missing?.length ? [`missing=${data.missing.join(", ")}`] : []),
    ...(data.verification
      ? [`verification=${data.verification.ok ? "ok" : "failed"}: ${data.verification.message}`]
      : []),
  ];
  if (data.config) {
    lines.push("", renderTable(["config", "value"], Object.entries(data.config)));
  }
  return { stdout: `${lines.join("\n").trimEnd()}\n` };
};

const formatConnectionSchema = (data: ConnectionSchemaOutput, options: OutputOptions) =>
  shouldReturnData(options)
    ? dataFormat(data)
    : {
        stdout: renderTable(
          ["field", "required", "secret", "description"],
          data.fields.map((field) => [
            field.name,
            field.required ?? false,
            field.secret ?? false,
            field.description ?? "",
          ]),
        ),
      };

const formatConnectionSetup = (data: ConnectionSetupOutput, options: OutputOptions) =>
  shouldReturnData(options)
    ? dataFormat(data)
    : {
        stdout:
          [
            `${data.id} (${data.label}) setup`,
            data.overview,
            "",
            ...data.manualSteps.map(
              (step, index) =>
                `${index + 1}. ${step.title}: ${step.instructions}${
                  step.expectedUserInput?.length
                    ? ` (collect: ${step.expectedUserInput.join(", ")})`
                    : ""
                }`,
            ),
            ...(data.fields.length
              ? [
                  "",
                  renderTable(
                    ["field", "required", "secret", "description"],
                    data.fields.map((field) => [
                      field.name,
                      field.required ?? false,
                      field.secret ?? false,
                      field.description ?? "",
                    ]),
                  ).trimEnd(),
                ]
              : []),
            ...(data.verify
              ? ["", `Verify: ${data.verify.tool} — ${data.verify.description}`]
              : []),
            `Configure: ${data.configureExample}`,
          ].join("\n") + "\n",
      };

const formatAutomationEventsCatalogList = (
  data: AutomationEventsCatalogListOutput,
  options: OutputOptions,
) =>
  shouldReturnData(options)
    ? dataFormat(data)
    : {
        stdout: renderTable(
          ["source", "event type", "capability", "label"],
          data.map((item) => [item.source, item.eventType, item.capabilityId, item.label]),
        ),
      };

const formatAutomationEventCatalogEntry = (
  data: AutomationEventCatalogEntry | null,
  options: OutputOptions,
) => {
  if (!data) {
    return { stderr: "Automation event not found", exitCode: 1 };
  }
  if (shouldReturnData(options)) {
    return dataFormat(data);
  }
  return {
    stdout: `${data.source}:${data.eventType}\n${data.description ?? data.label}\n\npayload\n${formatJsonSchemaFields(data.payloadSchema)}\n\nactor\n${formatJsonSchemaFields(data.actorSchema)}\n\nsubject\n${formatJsonSchemaFields(data.subjectSchema)}\n`,
  };
};

const capabilitiesListTool = defineBackofficeRuntimeTool({
  id: "capabilities.list",
  namespace: "capabilities",
  name: "list",
  description: "List Backoffice capabilities and availability/configuration status.",
  inputSchema: z.object({}),
  outputSchema: capabilitiesListOutputSchema,
  execute: async (_input, context: BackofficeCapabilitiesToolContext) =>
    await getRuntime(context).listCapabilities(),
  adapters: {
    bash: {
      command: "capabilities.list",
      help: {
        summary: "capabilities.list lists Backoffice capabilities and status.",
        options: [],
        examples: ["capabilities.list", "capabilities.list --format json"],
      },
      parse: defineEmptyArgsParser("capabilities.list"),
      outputOptions: readOutput,
      format: formatCapabilitiesList,
    },
  },
});

const hookScopesListTool = defineBackofficeRuntimeTool({
  id: "hooks.scopes.list",
  namespace: "hooks",
  name: "scopesList",
  description: "List hook scopes usable with hooks.list --fragment.",
  inputSchema: z.object({}),
  outputSchema: hookScopesListOutputSchema,
  execute: async (_input, context: BackofficeCapabilitiesToolContext) =>
    await getRuntime(context).listHookScopes(),
  adapters: {
    bash: {
      command: "hooks.scopes.list",
      help: {
        summary: "hooks.scopes.list lists hook scopes available to hooks.list --fragment.",
        options: [],
        examples: ["hooks.scopes.list", "hooks.scopes.list --format json"],
      },
      parse: defineEmptyArgsParser("hooks.scopes.list"),
      outputOptions: readOutput,
      format: formatHookScopesList,
    },
  },
});

const connectionsListTool = defineBackofficeRuntimeTool({
  id: "connections.list",
  namespace: "connections",
  name: "list",
  description: "List configurable Backoffice connections and their configuration status.",
  inputSchema: z.object({}),
  outputSchema: connectionsListOutputSchema,
  execute: async (_input, context: BackofficeCapabilitiesToolContext) =>
    await getRuntime(context).listConnections(),
  adapters: {
    bash: {
      command: "connections.list",
      help: {
        summary: "connections.list lists configurable Backoffice connections.",
        options: [],
        examples: ["connections.list", "connections.list --format json"],
      },
      parse: defineEmptyArgsParser("connections.list"),
      outputOptions: readOutput,
      format: formatConnectionsList,
    },
  },
});

const connectionsGetTool = defineBackofficeRuntimeTool({
  id: "connections.get",
  namespace: "connections",
  name: "get",
  description: "Get one Backoffice connection status with masked configuration values.",
  inputSchema: z.object({ id: nonEmptyString }),
  outputSchema: connectionStatusSchema,
  execute: async (input, context: BackofficeCapabilitiesToolContext) =>
    await getRuntime(context).getConnection(input),
  adapters: {
    bash: {
      command: "connections.get",
      help: {
        summary: "connections.get shows one connection status.",
        options: [
          {
            name: "id",
            required: true,
            valueRequired: true,
            valueName: "id",
            description: "Connection id",
          },
        ],
        examples: ["connections.get --id telegram --format json"],
      },
      parse: parseIdOnly("connections.get"),
      outputOptions: readOutput,
      format: formatConnectionStatus,
    },
  },
});

const connectionsSetupTool = defineBackofficeRuntimeTool({
  id: "connections.setup",
  namespace: "connections",
  name: "setup",
  description: "Show human steps for configuring a Backoffice connection.",
  inputSchema: z.object({ id: nonEmptyString }),
  outputSchema: connectionSetupOutputSchema,
  execute: async (input, context: BackofficeCapabilitiesToolContext) =>
    await getRuntime(context).setupConnection(input),
  adapters: {
    bash: {
      command: "connections.setup",
      help: {
        summary: "connections.setup prints manual setup steps for a connection.",
        options: [
          {
            name: "id",
            required: true,
            valueRequired: true,
            valueName: "id",
            description: "Connection id",
          },
        ],
        examples: ["connections.setup --id telegram"],
      },
      parse: parseIdOnly("connections.setup"),
      outputOptions: readOutput,
      format: formatConnectionSetup,
    },
  },
});

const connectionsSchemaTool = defineBackofficeRuntimeTool({
  id: "connections.schema",
  namespace: "connections",
  name: "schema",
  description: "Show the accepted configuration fields for a Backoffice connection.",
  inputSchema: z.object({ id: nonEmptyString }),
  outputSchema: connectionSchemaOutputSchema,
  execute: async (input, context: BackofficeCapabilitiesToolContext) =>
    await getRuntime(context).getConnectionSchema(input),
  adapters: {
    bash: {
      command: "connections.schema",
      help: {
        summary: "connections.schema prints configuration fields for a connection.",
        options: [
          {
            name: "id",
            required: true,
            valueRequired: true,
            valueName: "id",
            description: "Connection id",
          },
        ],
        examples: [
          "connections.schema --id telegram",
          "connections.schema --id telegram --format json",
        ],
      },
      parse: parseIdOnly("connections.schema"),
      outputOptions: readOutput,
      format: formatConnectionSchema,
    },
  },
});

const connectionsVerifyTool = defineBackofficeRuntimeTool({
  id: "connections.verify",
  namespace: "connections",
  name: "verify",
  description: "Verify a Backoffice connection without changing its configuration.",
  inputSchema: z.object({ id: nonEmptyString }),
  outputSchema: connectionStatusSchema,
  execute: async (input, context: BackofficeCapabilitiesToolContext) =>
    await getRuntime(context).verifyConnection(input),
  adapters: {
    bash: {
      command: "connections.verify",
      help: {
        summary: "connections.verify checks one connection status/health.",
        options: [
          {
            name: "id",
            required: true,
            valueRequired: true,
            valueName: "id",
            description: "Connection id",
          },
        ],
        examples: [
          "connections.verify --id telegram",
          "connections.verify --id telegram --format json",
        ],
      },
      parse: parseIdOnly("connections.verify"),
      outputOptions: readOutput,
      format: formatConnectionStatus,
    },
  },
});

const connectionsResetTool = defineBackofficeRuntimeTool({
  id: "connections.reset",
  namespace: "connections",
  name: "reset",
  description: "Reset a Backoffice connection configuration. Requires --confirm <id>.",
  inputSchema: z.object({ id: nonEmptyString, confirm: nonEmptyString }),
  outputSchema: connectionStatusSchema,
  execute: async (input, context: BackofficeCapabilitiesToolContext) =>
    await getRuntime(context).resetConnection(input),
  adapters: {
    bash: {
      command: "connections.reset",
      help: {
        summary: "connections.reset clears one connection configuration.",
        options: [
          {
            name: "id",
            required: true,
            valueRequired: true,
            valueName: "id",
            description: "Connection id",
          },
          {
            name: "confirm",
            required: true,
            valueRequired: true,
            valueName: "id",
            description: "Must exactly match --id",
          },
        ],
        examples: ["connections.reset --id reson8 --confirm reson8"],
      },
      parse: parseReset,
      outputOptions: readOutput,
      format: formatConnectionStatus,
    },
  },
});

const connectionsConfigureTool = defineBackofficeRuntimeTool({
  id: "connections.configure",
  namespace: "connections",
  name: "configure",
  description:
    "Configure a Backoffice connection. Secrets are accepted in input but masked in output.",
  inputSchema: z.object({
    id: nonEmptyString,
    payload: z.unknown(),
    origin: nonEmptyString.optional(),
  }),
  outputSchema: connectionStatusSchema,
  execute: async (input, context: BackofficeCapabilitiesToolContext) =>
    await getRuntime(context).configureConnection(input),
  adapters: {
    bash: {
      command: "connections.configure",
      help: {
        summary: "connections.configure configures a connection from a JSON payload.",
        options: [
          {
            name: "id",
            required: true,
            valueRequired: true,
            valueName: "id",
            description: "Connection id",
          },
          {
            name: "json",
            required: true,
            valueRequired: true,
            valueName: "json",
            description: "Connection configuration JSON payload",
          },
          {
            name: "origin",
            valueRequired: true,
            valueName: "url",
            description: "Public origin used for webhook registration",
          },
        ],
        examples: [
          'connections.configure --id reson8 --json \'{"apiKey":"..."}\' --format json',
          'connections.configure --id telegram --json \'{"botToken":"...","webhookSecretToken":"...","webhookBaseUrl":"https://example.com"}\' --format json',
        ],
      },
      parse: parseConfigure,
      outputOptions: readOutput,
      format: formatConnectionStatus,
    },
  },
});

const automationEventsCatalogListTool = defineBackofficeRuntimeTool({
  id: "events.catalog.list",
  namespace: "events",
  name: "eventsCatalogList",
  description:
    "List known automation event source/type pairs from the Backoffice capability registry.",
  inputSchema: z.object({}),
  outputSchema: automationEventsCatalogListOutputSchema,
  execute: async (_input, context: BackofficeCapabilitiesToolContext) =>
    await getRuntime(context).listAutomationEvents(),
  adapters: {
    bash: {
      command: "events.catalog.list",
      help: {
        summary: "events.catalog.list lists known automation event source/type pairs.",
        options: [],
        examples: ["events.catalog.list --format json"],
      },
      parse: defineEmptyArgsParser("events.catalog.list"),
      outputOptions: readOutput,
      format: formatAutomationEventsCatalogList,
    },
  },
});

const automationEventsCatalogGetTool = defineBackofficeRuntimeTool({
  id: "events.catalog.get",
  namespace: "events",
  name: "eventsCatalogGet",
  description: "Get one automation event descriptor and its JSON schemas.",
  inputSchema: automationEventCatalogGetInputSchema,
  outputSchema: automationEventCatalogGetOutputSchema,
  execute: async (input, context: BackofficeCapabilitiesToolContext) =>
    await getRuntime(context).getAutomationEvent(input),
  adapters: {
    bash: {
      command: "events.catalog.get",
      help: {
        summary: "events.catalog.get returns one automation event descriptor and its JSON schemas.",
        options: [
          {
            name: "source",
            required: true,
            valueRequired: true,
            valueName: "source",
            description: "Automation event source.",
          },
          {
            name: "type",
            required: true,
            valueRequired: true,
            valueName: "type",
            description: "Automation event type.",
          },
        ],
        examples: [
          "events.catalog.get --source telegram --type message.received",
          "events.catalog.get --source telegram --type message.received --format json",
        ],
      },
      parse: defineCliArgsParser<AutomationEventCatalogGetInput>("events.catalog.get", {
        source: { required: true },
        type: { required: true },
      }),
      outputOptions: readOutput,
      format: formatAutomationEventCatalogEntry,
    },
  },
});

export const createBackofficeCapabilitiesRuntime = ({
  env,
  orgId,
  origin = "https://backoffice.local",
  runtimeToolNamespacesByCapability,
}: {
  env: CloudflareEnv;
  orgId: string;
  origin?: string;
  runtimeToolNamespacesByCapability?: ReadonlyMap<string, readonly string[]>;
}): BackofficeCapabilitiesRuntime => ({
  listCapabilities: async () =>
    await Promise.all(
      backofficeCapabilities.map(async (capability) => {
        if (!capability.connection) {
          return {
            id: capability.id,
            label: capability.label,
            kind: capability.kind,
            available: true,
            configured: true,
            healthy: true,
          };
        }
        try {
          const status = await capability.connection.getStatus({ env, orgId });
          return {
            id: capability.id,
            label: capability.label,
            kind: capability.kind,
            available: true,
            configured: status.configured,
            ...(status.verification ? { healthy: status.verification.ok } : {}),
            ...(status.missing?.length ? { reason: `missing: ${status.missing.join(", ")}` } : {}),
          };
        } catch (error) {
          return {
            id: capability.id,
            label: capability.label,
            kind: capability.kind,
            available: false,
            configured: false,
            healthy: false,
            reason: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    ),
  listHookScopes: async () => {
    const statuses = new Map(
      (await Promise.all(
        backofficeCapabilities.map(async (capability) => {
          if (!capability.connection) {
            return [capability.id, { configured: true, healthy: true }] as const;
          }
          const status = await capability.connection.getStatus({ env, orgId });
          return [
            capability.id,
            {
              configured: status.configured,
              healthy: status.verification?.ok,
            },
          ] as const;
        }),
      )) as readonly (readonly [string, { configured: boolean; healthy?: boolean }])[],
    );
    return listHookScopes().map((scope) => ({ ...scope, ...statuses.get(scope.capabilityId) }));
  },
  listConnections: async () =>
    await Promise.all(
      listConnectionCapabilities().map(async (capability) => {
        const status = await capability.connection!.getStatus({ env, orgId });
        return {
          id: capability.id,
          label: capability.label,
          kind: capability.kind,
          configured: status.configured,
          hookScopes: (capability.hooks ?? []).map((hook) => hook.id),
          runtimeToolNamespaces: [
            ...(runtimeToolNamespacesByCapability?.get(capability.id) ??
              capability.runtimeToolNamespaces ??
              []),
          ],
          automationEvents: (capability.automationEvents ?? []).map(
            (event) => `${event.source}:${event.eventType}`,
          ),
          ...(status.missing ? { missing: status.missing } : {}),
        };
      }),
    ),
  getConnection: async ({ id }) => {
    const capability = getConnectionCapability(id);
    if (!capability?.connection) {
      throw new Error(`Unknown configurable connection: ${id}`);
    }
    return await capability.connection.getStatus({ env, orgId });
  },
  setupConnection: async ({ id }) => {
    const capability = getConnectionCapability(id);
    if (!capability?.connection) {
      throw new Error(`Unknown configurable connection: ${id}`);
    }
    const skillPath = Object.keys(capability.files ?? {}).find(
      (path) => path.startsWith("skills/") && path.endsWith("/SKILL.md"),
    );
    const hasSkill = Boolean(skillPath);
    return {
      id: capability.id,
      label: capability.label,
      overview: hasSkill
        ? `Use /starter/${skillPath} for setup, event, and tool guidance.`
        : `${capability.label} does not provide a setup guide yet.`,
      manualSteps: hasSkill
        ? [
            {
              id: "read-agent-skill",
              title: "Read agent skill",
              instructions: `Open /starter/${skillPath} and follow its guidance.`,
            },
          ]
        : [],
      fields: [...(capability.connection.configureFields ?? [])],
      verify: {
        tool: `connections.get --id ${capability.id}`,
        description: `Check configured=true for ${capability.label}.`,
      },
      configureExample: `connections.configure --id ${capability.id} --json '{...}' --format json`,
    };
  },
  getConnectionSchema: async ({ id }) => {
    const capability = getConnectionCapability(id);
    if (!capability?.connection) {
      throw new Error(`Unknown configurable connection: ${id}`);
    }
    return {
      id: capability.id,
      label: capability.label,
      fields: [...(capability.connection.configureFields ?? [])],
    };
  },
  verifyConnection: async ({ id }) => {
    const capability = getConnectionCapability(id);
    if (!capability?.connection) {
      throw new Error(`Unknown configurable connection: ${id}`);
    }
    return await (capability.connection.verify?.({ env, orgId }) ??
      capability.connection.getStatus({ env, orgId }));
  },
  resetConnection: async ({ id, confirm }) => {
    if (confirm !== id) {
      throw new Error(`Refusing to reset '${id}' without --confirm ${id}.`);
    }
    const capability = getConnectionCapability(id);
    if (!capability?.connection?.reset) {
      throw new Error(`Connection cannot be reset through runtime tools: ${id}`);
    }
    return await capability.connection.reset({ env, orgId });
  },
  configureConnection: async ({ id, payload, origin: inputOrigin }) => {
    const capability = getConnectionCapability(id);
    if (!capability?.connection?.configure) {
      throw new Error(`Connection is not configurable through runtime tools: ${id}`);
    }
    const parsedPayload = capability.connection.configureInputSchema?.parse(payload) ?? payload;
    return await capability.connection.configure({
      env,
      orgId,
      origin: inputOrigin ?? origin,
      payload: parsedPayload,
    });
  },
  listAutomationEvents: async () =>
    listAutomationEventDescriptors().map(
      ({ payloadSchema, actorSchema, subjectSchema, ...event }) => event,
    ),
  getAutomationEvent: async ({ source, type }) =>
    listAutomationEventDescriptors().find(
      (event) => event.source === source && event.eventType === type,
    ) ?? null,
});

export const backofficeCapabilitiesRuntimeTools = [
  capabilitiesListTool,
  hookScopesListTool,
  connectionsListTool,
  connectionsGetTool,
  connectionsSetupTool,
  connectionsSchemaTool,
  connectionsVerifyTool,
  connectionsResetTool,
  connectionsConfigureTool,
  automationEventsCatalogListTool,
  automationEventsCatalogGetTool,
] as const;

export const backofficeCapabilitiesToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "backoffice-capabilities",
  tools: backofficeCapabilitiesRuntimeTools,
  isAvailable: (context: BackofficeCapabilitiesToolContext) => !!context.runtimes.backoffice,
});

export { backofficeCapabilities };
