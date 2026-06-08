import { z } from "zod";

import type { DurableHookQueueResponse } from "@/fragno/durable-hooks";
import {
  assertNoPositionals,
  parseCliTokens,
  readStringOption,
} from "@/fragno/runtime-tools/bash-cli";

import {
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeRuntimeTool,
  type BackofficeToolContext,
} from "../runtime-tools";

const AUTOMATION_INGEST_EVENT_HOOK_NAME = "internalIngestEvent";

export const durableHookFragmentSchema = z.enum([
  "cloudflare",
  "telegram",
  "otp",
  "resend",
  "github",
  "upload",
  "automations",
  "pi",
  "pi-workflows",
  "auth",
]);

export type DurableHookFragment = z.infer<typeof durableHookFragmentSchema>;

export type DurableHooksListArgs = {
  fragment: DurableHookFragment;
  cursor?: string;
  pageSize?: number;
};

export type DurableHooksGetArgs = {
  fragment: DurableHookFragment;
  hookId: string;
};

export type AutomationEventsListArgs = {
  cursor?: string;
  pageSize?: number;
};

export type AutomationEventsGetArgs = {
  hookId: string;
};

export type DurableHooksRuntime = {
  listHooks: (input: DurableHooksListArgs) => Promise<DurableHookQueueResponse>;
  getHook: (
    input: DurableHooksGetArgs,
  ) => Promise<DurableHookQueueResponse["items"][number] | null>;
};

export type DurableHooksToolContext = BackofficeToolContext<{
  durableHooks?: DurableHooksRuntime;
}>;

const nonEmptyString = z.string().trim().min(1);
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

const defineDurableHooksTool = <TInputSchema extends z.ZodType, TOutputSchema extends z.ZodType>(
  tool: BackofficeRuntimeTool<TInputSchema, TOutputSchema, DurableHooksToolContext>,
) => defineBackofficeRuntimeTool(tool);

const getDurableHooksRuntime = (
  runtime: DurableHooksToolContext["runtimes"]["durableHooks"],
): DurableHooksRuntime => {
  if (!runtime) {
    throw new Error("Durable hooks runtime is not available in this execution context");
  }
  return runtime;
};

const readPageSizeOption = (parsed: ReturnType<typeof parseCliTokens>) => {
  const value = readStringOption(parsed, "page-size");
  if (!value) {
    return undefined;
  }
  if (!/^\d+$/.test(value)) {
    throw new Error("--page-size must be a positive integer");
  }
  const parsedValue = Number(value);
  if (!Number.isSafeInteger(parsedValue) || parsedValue <= 0) {
    throw new Error("--page-size must be a positive integer");
  }
  return parsedValue;
};

const parseListHooksArgs = (args: string[]): DurableHooksListArgs => {
  const parsed = parseCliTokens(args);
  assertNoPositionals(parsed, "hooks.list");
  return {
    fragment: durableHookFragmentSchema.parse(readStringOption(parsed, "fragment", true)),
    cursor: readStringOption(parsed, "cursor"),
    pageSize: readPageSizeOption(parsed),
  };
};

const parseGetHookArgs = (args: string[]): DurableHooksGetArgs => {
  const parsed = parseCliTokens(args);
  assertNoPositionals(parsed, "hooks.get");
  return {
    fragment: durableHookFragmentSchema.parse(readStringOption(parsed, "fragment", true)),
    hookId: readStringOption(parsed, "hook-id", true)!,
  };
};

const parseListAutomationEventsArgs = (args: string[]): AutomationEventsListArgs => {
  const parsed = parseCliTokens(args);
  assertNoPositionals(parsed, "automations.events.list");
  return {
    cursor: readStringOption(parsed, "cursor"),
    pageSize: readPageSizeOption(parsed),
  };
};

const parseGetAutomationEventArgs = (args: string[]): AutomationEventsGetArgs => {
  const parsed = parseCliTokens(args);
  assertNoPositionals(parsed, "automations.events.get");
  return {
    hookId: readStringOption(parsed, "hook-id", true)!,
  };
};

const isAutomationIngestEventHook = (hook: DurableHookQueueResponse["items"][number]) =>
  hook.hookName === AUTOMATION_INGEST_EVENT_HOOK_NAME;

const listAutomationEventHooks = async (
  input: AutomationEventsListArgs,
  context: DurableHooksToolContext,
) => {
  const response = await getDurableHooksRuntime(context.runtimes.durableHooks).listHooks({
    fragment: "automations",
    ...input,
  });

  return {
    ...response,
    items: response.items.filter(isAutomationIngestEventHook),
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

  return hook && isAutomationIngestEventHook(hook) ? hook : null;
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

const listHooksTool = defineDurableHooksTool({
  id: "hooks.list",
  namespace: "hooks",
  name: "list",
  description: "List durable hook queue entries for a runtime fragment.",
  inputSchema: z.object({
    fragment: durableHookFragmentSchema,
    cursor: nonEmptyString.optional(),
    pageSize: z.number().int().positive().optional(),
  }),
  outputSchema: durableHookQueueResponseSchema,
  execute: async (input, context) =>
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
            description:
              "Fragment scope: automations, pi, pi-workflows, auth, telegram, otp, resend, github, upload, cloudflare.",
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
        examples: ["hooks.list --fragment automations --page-size 50 --format json"],
      },
      parse: parseListHooksArgs,
      format: formatDurableHookQueue,
    },
  },
});

const getHookTool = defineDurableHooksTool({
  id: "hooks.get",
  namespace: "hooks",
  name: "get",
  description: "Get a durable hook queue entry by id.",
  inputSchema: z.object({ fragment: durableHookFragmentSchema, hookId: nonEmptyString }),
  outputSchema: durableHookRecordSchema.nullable(),
  execute: async (input, context) =>
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
      parse: parseGetHookArgs,
      format: formatDurableHookRecord,
    },
  },
});

const listAutomationEventsTool = defineDurableHooksTool({
  id: "automations.events.list",
  namespace: "automations",
  name: "listEvents",
  description: "List automation ingest event hook queue entries.",
  inputSchema: z.object({
    cursor: nonEmptyString.optional(),
    pageSize: z.number().int().positive().optional(),
  }),
  outputSchema: durableHookQueueResponseSchema,
  execute: listAutomationEventHooks,
  adapters: {
    bash: {
      command: "automations.events.list",
      help: {
        summary:
          "automations.events.list lists durable hook queue entries for automation ingest events.",
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
        examples: ["automations.events.list --page-size 50 --format json"],
      },
      parse: parseListAutomationEventsArgs,
      format: formatDurableHookQueue,
    },
  },
});

const getAutomationEventTool = defineDurableHooksTool({
  id: "automations.events.get",
  namespace: "automations",
  name: "getEvent",
  description: "Get an automation ingest event hook queue entry by durable hook id.",
  inputSchema: z.object({ hookId: nonEmptyString }),
  outputSchema: durableHookRecordSchema.nullable(),
  execute: getAutomationEventHook,
  adapters: {
    bash: {
      command: "automations.events.get",
      help: {
        summary:
          "automations.events.get returns one automation ingest event hook queue entry by id.",
        options: [
          {
            name: "hook-id",
            required: true,
            valueRequired: true,
            valueName: "id",
            description: "Durable hook id.",
          },
        ],
        examples: ["automations.events.get --hook-id hook_123 --format json"],
      },
      parse: parseGetAutomationEventArgs,
      format: formatDurableHookRecord,
    },
  },
});

export const hooksRuntimeTools = [listHooksTool, getHookTool] as const;
export const automationEventsRuntimeTools = [
  listAutomationEventsTool,
  getAutomationEventTool,
] as const;
export const durableHooksRuntimeTools = hooksRuntimeTools;

export const hooksToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "hooks",
  tools: hooksRuntimeTools,
  isAvailable: (context: DurableHooksToolContext) => !!context.runtimes.durableHooks,
});

export const automationEventsToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "automations-events",
  tools: automationEventsRuntimeTools,
  isAvailable: (context: DurableHooksToolContext) => !!context.runtimes.durableHooks,
});

export const durableHooksToolFamily = hooksToolFamily;
