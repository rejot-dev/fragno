import { z } from "zod";

import {
  getHookScope,
  listHookScopes,
} from "@/fragno/backoffice-capabilities/backoffice-capabilities";
import type { DurableHookQueueResponse } from "@/fragno/durable-hooks";
import { defineCliArgsParser } from "@/fragno/runtime-tools/bash-cli";

import {
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "../runtime-tools";

const AUTOMATION_INGEST_EVENT_HOOK_NAME = "internalIngestEvent";

const durableHookFragmentSchema = z
  .string()
  .trim()
  .min(1)
  .superRefine((value, context) => {
    if (!getHookScope(value)) {
      context.addIssue({
        code: "custom",
        message: `Unknown hook fragment '${value}'. Run hooks.scopes.list to discover available hook scopes.`,
      });
    }
  });

export type DurableHookFragment = string;

export type DurableHooksListArgs = {
  fragment: DurableHookFragment;
  cursor?: string;
  pageSize?: number;
};

export type DurableHooksGetArgs = {
  fragment: DurableHookFragment;
  hookId: string;
};

type AutomationEventsListArgs = {
  cursor?: string;
  pageSize?: number;
};

type AutomationEventsGetArgs = {
  hookId: string;
};

export type DurableHooksRuntime = {
  listHooks: (input: DurableHooksListArgs) => Promise<DurableHookQueueResponse>;
  getHook: (
    input: DurableHooksGetArgs,
  ) => Promise<DurableHookQueueResponse["items"][number] | null>;
};

type DurableHooksToolContext = BackofficeToolContext<{
  durableHooks?: DurableHooksRuntime;
}>;

const durableHookRecordSchema = z.object({
  id: z.string(),
  hookName: z.string(),
  status: z.string(),
  attempts: z.number(),
  maxAttempts: z.number(),
  lastAttemptAt: z.string().nullable(),
  nextRetryAt: z.string().nullable(),
  createdAt: z.string().nullable(),
  error: z.string().nullable(),
  payload: z.unknown(),
});
const durableHookQueueResponseSchema = z.object({
  configured: z.boolean(),
  hooksEnabled: z.boolean(),
  namespace: z.string().nullable(),
  items: z.array(durableHookRecordSchema),
  cursor: z.string().optional(),
  hasNextPage: z.boolean(),
});
const automationEventRecordSchema = z.object({
  source: z.string(),
  eventType: z.string(),
  hookId: z.string(),
  actor: z.object({
    scope: z.string(),
    source: z.string().optional(),
    type: z.string(),
    id: z.string(),
  }),
  actors: z
    .array(
      z.object({
        scope: z.string(),
        source: z.string().optional(),
        type: z.string(),
        id: z.string(),
      }),
    )
    .optional(),
});
const automationEventsQueueResponseSchema = durableHookQueueResponseSchema.extend({
  items: z.array(automationEventRecordSchema),
});

type AutomationEventRecord = z.infer<typeof automationEventRecordSchema>;

type AutomationEventsQueueResponse = Omit<DurableHookQueueResponse, "items"> & {
  items: AutomationEventRecord[];
};

const getDurableHooksRuntime = (
  runtime: DurableHooksToolContext["runtimes"]["durableHooks"],
): DurableHooksRuntime => {
  if (!runtime) {
    throw new Error("Durable hooks runtime is not available in this execution context");
  }
  return runtime;
};

const listAutomationEventHooks = async (
  input: AutomationEventsListArgs,
  context: DurableHooksToolContext,
): Promise<AutomationEventsQueueResponse> => {
  const response = await getDurableHooksRuntime(context.runtimes.durableHooks).listHooks({
    fragment: "automations",
    ...input,
  });

  return {
    ...response,
    items: response.items
      .filter((hook) => hook.hookName === AUTOMATION_INGEST_EVENT_HOOK_NAME)
      .map((hook) =>
        automationEventRecordSchema.parse({
          ...(typeof hook.payload === "object" && hook.payload ? hook.payload : {}),
          hookId: hook.id,
        }),
      ),
  };
};

const getAutomationEventHook = async (
  input: AutomationEventsGetArgs,
  context: DurableHooksToolContext,
) => {
  const hook = await getDurableHooksRuntime(context.runtimes.durableHooks).getHook({
    fragment: "automations",
    hookId: input.hookId,
  });

  return hook?.hookName === AUTOMATION_INGEST_EVENT_HOOK_NAME ? hook : null;
};

const formatDurableHookQueue = (result: DurableHookQueueResponse, options: { format?: string }) => {
  if (options.format === "json") {
    return { data: result };
  }
  const lines = [
    `configured=${result.configured} hooksEnabled=${result.hooksEnabled} namespace=${result.namespace ?? "unavailable"}`,
    ...result.items.map(
      (item) =>
        `${item.id}\t${item.status}\t${item.hookName}\tattempts=${item.attempts}/${item.maxAttempts}`,
    ),
    ...(result.hasNextPage && result.cursor ? [`next cursor: ${result.cursor}`] : []),
  ];
  return { stdout: `${lines.join("\n")}\n` };
};

const pad = (value: string, width: number) => value.padEnd(width, " ");

const formatAutomationEventQueue = (
  result: AutomationEventsQueueResponse,
  options: { format?: string },
) => {
  if (options.format === "json") {
    return { data: result };
  }

  const rows = result.items.map((item) => ({
    source: item.source,
    eventType: item.eventType,
    hookId: item.hookId,
    actorScope: item.actor?.scope ?? "-",
    actorSource: item.actor?.source ?? "-",
    actorType: item.actor?.type ?? "-",
    actorId: item.actor?.id ?? "-",
  }));
  const widths = {
    source: Math.max("source".length, ...rows.map((row) => row.source.length)),
    eventType: Math.max("eventType".length, ...rows.map((row) => row.eventType.length)),
    hookId: Math.max("hookId".length, ...rows.map((row) => row.hookId.length)),
    actorScope: Math.max("actor.scope".length, ...rows.map((row) => row.actorScope.length)),
    actorSource: Math.max("actor.source".length, ...rows.map((row) => row.actorSource.length)),
    actorType: Math.max("actor.type".length, ...rows.map((row) => row.actorType.length)),
    actorId: Math.max("actor.id".length, ...rows.map((row) => row.actorId.length)),
  };

  const lines = [
    `configured=${result.configured} hooksEnabled=${result.hooksEnabled} namespace=${result.namespace ?? "unavailable"}`,
    [
      pad("source", widths.source),
      pad("eventType", widths.eventType),
      pad("hookId", widths.hookId),
      pad("actor.scope", widths.actorScope),
      pad("actor.source", widths.actorSource),
      pad("actor.type", widths.actorType),
      pad("actor.id", widths.actorId),
    ].join("  "),
    [
      "-".repeat(widths.source),
      "-".repeat(widths.eventType),
      "-".repeat(widths.hookId),
      "-".repeat(widths.actorScope),
      "-".repeat(widths.actorSource),
      "-".repeat(widths.actorType),
      "-".repeat(widths.actorId),
    ].join("  "),
    ...rows.map((row) =>
      [
        pad(row.source, widths.source),
        pad(row.eventType, widths.eventType),
        pad(row.hookId, widths.hookId),
        pad(row.actorScope, widths.actorScope),
        pad(row.actorSource, widths.actorSource),
        pad(row.actorType, widths.actorType),
        pad(row.actorId, widths.actorId),
      ].join("  "),
    ),
    ...(result.hasNextPage && result.cursor ? [`next cursor: ${result.cursor}`] : []),
  ];
  return { stdout: `${lines.join("\n")}\n` };
};

const formatDurableHookRecord = (
  result: DurableHookQueueResponse["items"][number] | null,
  options: { format?: string },
) => {
  if (options.format === "json") {
    return result ? { data: result } : { exitCode: 1 };
  }
  return result
    ? {
        stdout: `${result.id}\t${result.status}\t${result.hookName}\tattempts=${result.attempts}/${result.maxAttempts}\n`,
      }
    : { stderr: "Hook not found", exitCode: 1 };
};

const listHooksTool = defineBackofficeRuntimeTool({
  id: "hooks.list",
  namespace: "hooks",
  name: "list",
  description: "List durable hook queue entries for a runtime fragment.",
  inputSchema: z.object({
    fragment: durableHookFragmentSchema,
    cursor: z.string().trim().min(1).optional(),
    pageSize: z.number().int().positive().optional(),
  }),
  outputSchema: durableHookQueueResponseSchema,
  execute: async (input, context: DurableHooksToolContext) =>
    await getDurableHooksRuntime(context.runtimes.durableHooks).listHooks(input),
  adapters: {
    bash: {
      command: "hooks.list",
      help: {
        summary: "hooks.list lists durable hook queue entries.",
        options: [
          {
            name: "fragment",
            required: true,
            valueRequired: true,
            valueName: "fragment",
            description: `Fragment scope. Run hooks.scopes.list to discover values. Current values: ${listHookScopes()
              .map((scope) => scope.id)
              .join(", ")}.`,
          },
          {
            name: "cursor",
            valueRequired: true,
            valueName: "cursor",
            description: "Optional pagination cursor.",
          },
          {
            name: "page-size",
            valueRequired: true,
            valueName: "number",
            description: "Optional page size.",
          },
        ],
        examples: [
          "hooks.scopes.list --format json",
          "hooks.list --fragment automations --page-size 50 --format json",
        ],
      },
      parse: defineCliArgsParser<DurableHooksListArgs>("hooks.list", {
        fragment: { required: true, transform: (value) => durableHookFragmentSchema.parse(value) },
        cursor: {},
        pageSize: { kind: "positiveInteger" },
      }),
      format: formatDurableHookQueue,
    },
  },
});

const getHookTool = defineBackofficeRuntimeTool({
  id: "hooks.get",
  namespace: "hooks",
  name: "get",
  description: "Get a durable hook queue entry by id.",
  inputSchema: z.object({ fragment: durableHookFragmentSchema, hookId: z.string().trim().min(1) }),
  outputSchema: durableHookRecordSchema.nullable(),
  execute: async (input, context: DurableHooksToolContext) =>
    await getDurableHooksRuntime(context.runtimes.durableHooks).getHook(input),
  adapters: {
    bash: {
      command: "hooks.get",
      help: {
        summary: "hooks.get returns one durable hook entry by id.",
        options: [
          {
            name: "fragment",
            required: true,
            valueRequired: true,
            valueName: "fragment",
            description: "Fragment scope.",
          },
          {
            name: "hook-id",
            required: true,
            valueRequired: true,
            valueName: "id",
            description: "Durable hook id.",
          },
        ],
        examples: ["hooks.get --fragment automations --hook-id hook_123 --format json"],
      },
      parse: defineCliArgsParser<DurableHooksGetArgs>("hooks.get", {
        fragment: { required: true, transform: (value) => durableHookFragmentSchema.parse(value) },
        hookId: { required: true },
      }),
      format: formatDurableHookRecord,
    },
  },
});

const listAutomationEventsTool = defineBackofficeRuntimeTool({
  id: "events.list",
  namespace: "events",
  name: "listEvents",
  description: "List automation events queued through internal ingest hooks.",
  inputSchema: z.object({
    cursor: z.string().trim().min(1).optional(),
    pageSize: z.number().int().positive().optional(),
  }),
  outputSchema: automationEventsQueueResponseSchema,
  execute: listAutomationEventHooks,
  adapters: {
    bash: {
      command: "events.list",
      help: {
        summary: "events.list lists automation events queued through internal ingest hooks.",
        options: [
          {
            name: "cursor",
            valueRequired: true,
            valueName: "cursor",
            description: "Optional pagination cursor.",
          },
          {
            name: "page-size",
            valueRequired: true,
            valueName: "number",
            description: "Optional page size.",
          },
        ],
        examples: ["events.list --page-size 50 --format json"],
      },
      parse: defineCliArgsParser<AutomationEventsListArgs>("events.list", {
        cursor: {},
        pageSize: { kind: "positiveInteger" },
      }),
      format: formatAutomationEventQueue,
    },
  },
});

const getAutomationEventTool = defineBackofficeRuntimeTool({
  id: "events.get",
  namespace: "events",
  name: "getEvent",
  description: "Get an automation ingest event hook queue entry by durable hook id.",
  inputSchema: z.object({ hookId: z.string().trim().min(1) }),
  outputSchema: durableHookRecordSchema.nullable(),
  execute: getAutomationEventHook,
  adapters: {
    bash: {
      command: "events.get",
      help: {
        summary: "events.get returns one automation ingest event hook queue entry by id.",
        options: [
          {
            name: "hook-id",
            required: true,
            valueRequired: true,
            valueName: "id",
            description: "Durable hook id.",
          },
        ],
        examples: ["events.get --hook-id hook_123 --format json"],
      },
      parse: defineCliArgsParser<AutomationEventsGetArgs>("events.get", {
        hookId: { required: true },
      }),
      format: formatDurableHookRecord,
    },
  },
});

export const hooksRuntimeTools = [listHooksTool, getHookTool] as const;
export const automationEventsRuntimeTools = [
  listAutomationEventsTool,
  getAutomationEventTool,
] as const;

export const hooksToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "hooks",
  tools: hooksRuntimeTools,
  isAvailable: (context: DurableHooksToolContext) => !!context.runtimes.durableHooks,
});

export const automationEventsToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "events",
  tools: automationEventsRuntimeTools,
  isAvailable: (context: DurableHooksToolContext) => !!context.runtimes.durableHooks,
});
