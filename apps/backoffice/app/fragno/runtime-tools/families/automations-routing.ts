import type {
  AutomationForwardAccept,
  AutomationForwardAcceptCreateInput,
  AutomationForwardAcceptUpdateInput,
  AutomationRouteDefinition,
  AutomationRouteCreateInput,
  AutomationRouteUpdateInput,
} from "@fragno-dev/backoffice-api/v0/automation";

import {
  defineCliArgsParser,
  defineNoInputArgsParser,
  ensureTrailingNewline,
  parseCliTokens,
  readOutputOptions,
  readStringOption,
  type ParsedCliTokens,
} from "@/fragno/runtime-tools/bash-cli";

import {
  backofficeApiOperationToolFields,
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "../runtime-tools";

export type AutomationRouterRuntime = {
  listRoutes(): Promise<AutomationRouteDefinition[]>;
  getRoute(input: { id: string }): Promise<AutomationRouteDefinition | null>;
  createRoute(input: AutomationRouteCreateInput): Promise<AutomationRouteDefinition>;
  updateRoute(input: AutomationRouteUpdateInput): Promise<AutomationRouteDefinition | null>;
  deleteRoute(input: { id: string }): Promise<true>;
  triggerScheduledRouteNow(input: { id: string }): Promise<{
    accepted: true;
    eventId: string;
  } | null>;
  listForwardAccepts(): Promise<AutomationForwardAccept[]>;
  createForwardAccept(input: AutomationForwardAcceptCreateInput): Promise<AutomationForwardAccept>;
  updateForwardAccept(
    input: AutomationForwardAcceptUpdateInput,
  ): Promise<AutomationForwardAccept | null>;
  deleteForwardAccept(input: { id: string }): Promise<true>;
};

export const createUnavailableAutomationRouterRuntime = (
  message = "Automation router runtime is not available in this execution context",
): AutomationRouterRuntime => ({
  listRoutes: async () => {
    throw new Error(message);
  },
  getRoute: async () => {
    throw new Error(message);
  },
  createRoute: async () => {
    throw new Error(message);
  },
  updateRoute: async () => {
    throw new Error(message);
  },
  deleteRoute: async () => {
    throw new Error(message);
  },
  triggerScheduledRouteNow: async () => {
    throw new Error(message);
  },
  listForwardAccepts: async () => {
    throw new Error(message);
  },
  createForwardAccept: async () => {
    throw new Error(message);
  },
  updateForwardAccept: async () => {
    throw new Error(message);
  },
  deleteForwardAccept: async () => {
    throw new Error(message);
  },
});

type AutomationRouterToolContext = BackofficeToolContext<{
  automations?: AutomationRouterRuntime;
}>;

const getRuntime = (context: AutomationRouterToolContext): AutomationRouterRuntime => {
  if (!context.runtimes.automations) {
    throw new Error("Automation router runtime is not available in this execution context");
  }
  return context.runtimes.automations;
};

const readJsonObjectOption = (parsed: ParsedCliTokens, name: string, required = false) => {
  const raw = readStringOption(parsed, name, required);
  if (typeof raw === "undefined") {
    return undefined;
  }

  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`--${name} must be a JSON object`);
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.message.includes("must be a JSON object")) {
      throw error;
    }
    throw new Error(`--${name} must be valid JSON`);
  }
};

const parseJsonPayload = () => (args: string[]) => {
  const parsed = parseCliTokens(args);
  return readJsonObjectOption(parsed, "json", true) ?? {};
};

const parseRouteUpdate = (args: string[]) => {
  const parsed = parseCliTokens(args);
  const id = readStringOption(parsed, "id", true)?.trim() ?? "";
  const patch = readJsonObjectOption(parsed, "json", true) ?? {};
  return { ...patch, id };
};

const outputOptions = (args: string[]) => readOutputOptions(parseCliTokens(args));
const outputOptionsWithoutJsonPayload = (args: string[]) => {
  const parsed = parseCliTokens(args);
  parsed.options.delete("json");
  return readOutputOptions(parsed);
};

const formatRouteTrigger = (route: AutomationRouteDefinition) =>
  route.trigger.kind === "event"
    ? `${route.trigger.source}/${route.trigger.eventType}`
    : `schedule ${JSON.stringify(route.trigger.cadence)}`;

const formatRoutesTable = (routes: AutomationRouteDefinition[]) =>
  ensureTrailingNewline(
    routes
      .map((route) =>
        [route.id.padEnd(36, " "), route.enabled ? "on " : "off", formatRouteTrigger(route)].join(
          "  ",
        ),
      )
      .join("\n"),
  );

const formatRouteText = (route: AutomationRouteDefinition) =>
  ensureTrailingNewline(
    [
      `id: ${route.id}`,
      `name: ${route.name}`,
      `enabled: ${route.enabled ? "yes" : "no"}`,
      `trigger: ${JSON.stringify(route.trigger)}`,
      `action: ${route.action.kind}`,
      route.trigger.kind === "schedule" ? `next: ${route.nextOccurrenceAt ?? "none"}` : undefined,
      route.description ? `description: ${route.description}` : undefined,
    ]
      .filter(Boolean)
      .join("\n"),
  );

const routerListTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("router.list"),
  namespace: "router",
  name: "list",
  execute: async (_input, context: AutomationRouterToolContext) =>
    await getRuntime(context).listRoutes(),
  adapters: {
    bash: {
      command: "router.list",
      help: {
        summary: "router.list lists database-backed automation routes.",
        options: [],
        examples: ["router.list", "router.list --format json"],
      },
      parse: defineNoInputArgsParser("router.list"),
      outputOptions,
      format: (routes, options) =>
        options.format === "json" || options.print
          ? { data: routes }
          : { stdout: formatRoutesTable(routes) },
    },
  },
});

const routerGetTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("router.get"),
  namespace: "router",
  name: "get",
  execute: async (input, context: AutomationRouterToolContext) =>
    await getRuntime(context).getRoute(input),
  adapters: {
    bash: {
      command: "router.get",
      help: {
        summary: "router.get shows one automation route.",
        options: [
          {
            name: "id",
            required: true,
            valueRequired: true,
            valueName: "id",
            description: "Automation route id",
          },
        ],
        examples: ["router.get --id my-route", "router.get --id my-route --format json"],
      },
      parse: defineCliArgsParser<{ id: string }>("router.get", { id: { required: true } }),
      outputOptions,
      format: (route, options) =>
        !route
          ? { stderr: "Automation route not found.\n", exitCode: 1 }
          : options.format === "json" || options.print
            ? { data: route }
            : { stdout: formatRouteText(route) },
    },
  },
});

const routerCreateTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("router.create"),
  namespace: "router",
  name: "create",
  execute: async (input, context: AutomationRouterToolContext) =>
    await getRuntime(context).createRoute(input),
  adapters: {
    bash: {
      command: "router.create",
      help: {
        summary: "router.create creates an automation route from a JSON payload.",
        options: [
          {
            name: "json",
            required: true,
            valueRequired: true,
            valueName: "json",
            description: "Automation route JSON payload",
          },
        ],
        examples: [
          'router.create --json \'{"id":"telegram-hello","name":"Telegram hello","trigger":{"kind":"event","source":"telegram","eventType":"message.received"},"action":{"kind":"start_workflow","authority":{"kind":"organization-automation","grants":[]},"workflowScriptPath":"/workspace/automations/telegram-hello.workflow.js","instanceIdTemplate":"telegram-hello-${event}"}}\' --format json',
        ],
      },
      parse: parseJsonPayload() as (args: string[]) => AutomationRouteCreateInput,
      outputOptions: outputOptionsWithoutJsonPayload,
      format: (route, options) =>
        options.format === "json" || options.print
          ? { data: route }
          : { stdout: `Created route ${route.id}\n${formatRouteText(route)}` },
    },
  },
});

const routerUpdateTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("router.update"),
  namespace: "router",
  name: "update",
  execute: async (input, context: AutomationRouterToolContext) =>
    await getRuntime(context).updateRoute(input),
  adapters: {
    bash: {
      command: "router.update",
      help: {
        summary: "router.update patches an automation route from a JSON payload.",
        options: [
          {
            name: "id",
            required: true,
            valueRequired: true,
            valueName: "id",
            description: "Automation route id",
          },
          {
            name: "json",
            required: true,
            valueRequired: true,
            valueName: "json",
            description: "Partial route JSON payload",
          },
        ],
        examples: [
          "router.update --id telegram-hello --json '{\"enabled\":false}'",
          "router.update --id telegram-hello --json '{\"priority\":900}' --format json",
        ],
      },
      parse: parseRouteUpdate as (args: string[]) => AutomationRouteUpdateInput,
      outputOptions: outputOptionsWithoutJsonPayload,
      format: (route, options) =>
        !route
          ? { stderr: "Automation route not found.\n", exitCode: 1 }
          : options.format === "json" || options.print
            ? { data: route }
            : { stdout: `Updated route ${route.id}\n${formatRouteText(route)}` },
    },
  },
});

const routerDeleteTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("router.delete"),
  namespace: "router",
  name: "delete",
  execute: async (input, context: AutomationRouterToolContext) => {
    return { deleted: await getRuntime(context).deleteRoute(input) };
  },
  adapters: {
    bash: {
      command: "router.delete",
      help: {
        summary: "router.delete ensures an automation route is absent.",
        options: [{ name: "id", required: true, valueRequired: true, description: "Route id" }],
        examples: ["router.delete --id daily-digest"],
      },
      parse: defineCliArgsParser<{ id: string }>("router.delete", { id: { required: true } }),
      format: () => ({ stdout: "Deleted automation route.\n" }),
    },
  },
});

const routerTriggerNowTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("router.trigger-now"),
  namespace: "router",
  name: "triggerNow",
  execute: async (input, context: AutomationRouterToolContext) =>
    await getRuntime(context).triggerScheduledRouteNow(input),
  adapters: {
    bash: {
      command: "router.trigger-now",
      help: {
        summary: "router.trigger-now triggers a scheduled automation route immediately.",
        options: [{ name: "id", required: true, valueRequired: true, description: "Route id" }],
        examples: ["router.trigger-now --id daily-digest --format json"],
      },
      parse: defineCliArgsParser<{ id: string }>("router.trigger-now", {
        id: { required: true },
      }),
      format: (result) =>
        result ? { data: result } : { stderr: "Automation route not found.\n", exitCode: 1 },
    },
  },
});

const formatForwardSenders = (accept: AutomationForwardAccept) =>
  accept.from.kind === "members" ? "members" : JSON.stringify(accept.from.scope);

const formatForwardAcceptsTable = (accepts: AutomationForwardAccept[]) =>
  ensureTrailingNewline(
    accepts
      .map((accept) =>
        [
          accept.id.padEnd(36, " "),
          accept.enabled ? "on " : "off",
          `from ${formatForwardSenders(accept)}`,
        ].join("  "),
      )
      .join("\n"),
  );

const formatForwardAcceptText = (accept: AutomationForwardAccept) =>
  ensureTrailingNewline(
    [
      `id: ${accept.id}`,
      `name: ${accept.name}`,
      `enabled: ${accept.enabled ? "yes" : "no"}`,
      `from: ${formatForwardSenders(accept)}`,
      `matcher: ${accept.matcher ? JSON.stringify(accept.matcher) : "every event"}`,
      accept.description ? `description: ${accept.description}` : undefined,
    ]
      .filter(Boolean)
      .join("\n"),
  );

const routerAcceptsListTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("router.accepts.list"),
  namespace: "router",
  name: "acceptsList",
  execute: async (_input, context: AutomationRouterToolContext) =>
    await getRuntime(context).listForwardAccepts(),
  adapters: {
    bash: {
      command: "router.accepts.list",
      help: {
        summary: "router.accepts.list lists which scopes may forward events into this one.",
        options: [],
        examples: ["router.accepts.list", "router.accepts.list --format json"],
      },
      parse: defineNoInputArgsParser("router.accepts.list"),
      outputOptions,
      format: (accepts, options) =>
        options.format === "json" || options.print
          ? { data: accepts }
          : { stdout: formatForwardAcceptsTable(accepts) },
    },
  },
});

const routerAcceptsCreateTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("router.accepts.create"),
  namespace: "router",
  name: "acceptsCreate",
  execute: async (input, context: AutomationRouterToolContext) =>
    await getRuntime(context).createForwardAccept(input),
  adapters: {
    bash: {
      command: "router.accepts.create",
      help: {
        summary: "router.accepts.create lets scopes of another owner forward events into this one.",
        options: [
          {
            name: "json",
            required: true,
            valueRequired: true,
            valueName: "json",
            description: "Forward accept JSON payload",
          },
        ],
        examples: [
          'router.accepts.create --json \'{"id":"member-messages","name":"Member Telegram messages","from":{"kind":"members"},"matcher":{"all":[{"path":"$.source","op":"eq","value":"telegram"},{"path":"$.eventType","op":"eq","value":"message.received"}]}}\'',
        ],
      },
      parse: parseJsonPayload() as (args: string[]) => AutomationForwardAcceptCreateInput,
      outputOptions: outputOptionsWithoutJsonPayload,
      format: (accept, options) =>
        options.format === "json" || options.print
          ? { data: accept }
          : { stdout: `Created forward accept ${accept.id}\n${formatForwardAcceptText(accept)}` },
    },
  },
});

const routerAcceptsUpdateTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("router.accepts.update"),
  namespace: "router",
  name: "acceptsUpdate",
  execute: async (input, context: AutomationRouterToolContext) =>
    await getRuntime(context).updateForwardAccept(input),
  adapters: {
    bash: {
      command: "router.accepts.update",
      help: {
        summary: "router.accepts.update patches a forward accept from a JSON payload.",
        options: [
          {
            name: "id",
            required: true,
            valueRequired: true,
            valueName: "id",
            description: "Forward accept id",
          },
          {
            name: "json",
            required: true,
            valueRequired: true,
            valueName: "json",
            description: "Partial forward accept JSON payload",
          },
        ],
        examples: ["router.accepts.update --id member-messages --json '{\"enabled\":false}'"],
      },
      parse: parseRouteUpdate as (args: string[]) => AutomationForwardAcceptUpdateInput,
      outputOptions: outputOptionsWithoutJsonPayload,
      format: (accept, options) =>
        !accept
          ? { stderr: "Forward accept not found.\n", exitCode: 1 }
          : options.format === "json" || options.print
            ? { data: accept }
            : { stdout: `Updated forward accept ${accept.id}\n${formatForwardAcceptText(accept)}` },
    },
  },
});

const routerAcceptsDeleteTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("router.accepts.delete"),
  namespace: "router",
  name: "acceptsDelete",
  execute: async (input, context: AutomationRouterToolContext) => {
    return { deleted: await getRuntime(context).deleteForwardAccept(input) };
  },
  adapters: {
    bash: {
      command: "router.accepts.delete",
      help: {
        summary: "router.accepts.delete ensures a forward accept is absent.",
        options: [
          { name: "id", required: true, valueRequired: true, description: "Forward accept id" },
        ],
        examples: ["router.accepts.delete --id member-messages"],
      },
      parse: defineCliArgsParser<{ id: string }>("router.accepts.delete", {
        id: { required: true },
      }),
      format: () => ({ stdout: "Deleted forward accept.\n" }),
    },
  },
});

export const automationRouterRuntimeTools = [
  routerListTool,
  routerGetTool,
  routerCreateTool,
  routerUpdateTool,
  routerDeleteTool,
  routerTriggerNowTool,
  routerAcceptsListTool,
  routerAcceptsCreateTool,
  routerAcceptsUpdateTool,
  routerAcceptsDeleteTool,
] as const;

export const automationRouterToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "router",
  tools: automationRouterRuntimeTools,
  isAvailable: (context: AutomationRouterToolContext) => Boolean(context.runtimes.automations),
});
