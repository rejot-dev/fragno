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
const getDurableHooksRuntime = (
  runtime: DurableHooksToolContext["runtimes"]["durableHooks"],
): DurableHooksRuntime => {
  if (!runtime) {
    throw new Error("Durable hooks runtime is not available in this execution context");
  }
  return runtime;
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

const listHooksTool = defineBackofficeRuntimeTool({
  id: "hooks.list",
  namespace: "hooks",
  name: "list",
  description: "List durable hook queue entries for a runtime fragment.",
  requiredPermissions: ["read"],
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
  requiredPermissions: ["read"],
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

export const hooksRuntimeTools = [listHooksTool, getHookTool] as const;

export const hooksToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "hooks",
  permissions: {
    read: "Read durable hooks.",
  },
  tools: hooksRuntimeTools,
  isAvailable: (context: DurableHooksToolContext) => !!context.runtimes.durableHooks,
});
