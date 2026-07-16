import { z } from "zod";

import type { AutomationRouteDefinition } from "@/fragno/automation/routing";
import {
  automationRouteCreateInputSchema,
  automationRouteSchema,
  automationRouteUpdateInputSchema,
  type AutomationRouteCreateInput,
  type AutomationRouteUpdateInput,
} from "@/fragno/automation/routing-schemas";
import {
  defineCliArgsParser,
  defineEmptyArgsParser,
  ensureTrailingNewline,
  parseCliTokens,
  readOutputOptions,
  readStringOption,
  type ParsedCliTokens,
} from "@/fragno/runtime-tools/bash-cli";

import {
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
  id: "router.list",
  namespace: "router",
  name: "list",
  description: "List database-backed automation routing rules.",
  requiredPermissions: ["read"],
  inputSchema: z.object({}),
  outputSchema: z.array(automationRouteSchema),
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
      parse: defineEmptyArgsParser("router.list"),
      outputOptions,
      format: (routes, options) =>
        options.format === "json" || options.print
          ? { data: routes }
          : { stdout: formatRoutesTable(routes) },
    },
  },
});

const routerGetTool = defineBackofficeRuntimeTool({
  id: "router.get",
  namespace: "router",
  name: "get",
  description: "Get one database-backed automation routing rule.",
  requiredPermissions: ["read"],
  inputSchema: z.object({ id: z.string().trim().min(1) }),
  outputSchema: automationRouteSchema.nullable(),
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
  id: "router.create",
  namespace: "router",
  name: "create",
  description: "Create a database-backed automation routing rule.",
  requiredPermissions: ["modify"],
  inputSchema: automationRouteCreateInputSchema,
  outputSchema: automationRouteSchema,
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
          'router.create --json \'{"id":"telegram-hello","name":"Telegram hello","trigger":{"kind":"event","source":"telegram","eventType":"message.received"},"action":{"kind":"start_workflow","remoteWorkflowName":"telegram-hello","workflowScriptPath":"/workspace/automations/telegram-hello.workflow.js","instanceIdTemplate":"telegram-hello-${event}"}}\' --format json',
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
  id: "router.update",
  namespace: "router",
  name: "update",
  description: "Update a database-backed automation routing rule.",
  requiredPermissions: ["modify"],
  inputSchema: automationRouteUpdateInputSchema,
  outputSchema: automationRouteSchema.nullable(),
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
  id: "router.delete",
  namespace: "router",
  name: "delete",
  description: "Idempotently delete a database-backed automation route.",
  requiredPermissions: ["modify"],
  inputSchema: z.object({ id: z.string().trim().min(1) }),
  outputSchema: z.object({ deleted: z.literal(true) }),
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
  id: "router.trigger-now",
  namespace: "router",
  name: "triggerNow",
  description: "Trigger a scheduled automation route immediately without changing its cadence.",
  requiredPermissions: ["modify"],
  inputSchema: z.object({ id: z.string().trim().min(1) }),
  outputSchema: z.object({ accepted: z.literal(true), eventId: z.string() }).nullable(),
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

export const automationRouterRuntimeTools = [
  routerListTool,
  routerGetTool,
  routerCreateTool,
  routerUpdateTool,
  routerDeleteTool,
  routerTriggerNowTool,
] as const;

export const automationRouterToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "router",
  permissions: {
    read: "Read automation routing rules.",
    modify: "Create and update automation routing rules.",
  },
  tools: automationRouterRuntimeTools,
  isAvailable: (context: AutomationRouterToolContext) => Boolean(context.runtimes.automations),
});
