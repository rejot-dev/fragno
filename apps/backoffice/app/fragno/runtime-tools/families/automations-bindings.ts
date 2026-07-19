import { z } from "zod";

import type { AutomationEventActor } from "@/fragno/automation/contracts";
import {
  automationStoreActorSchema,
  automationStoreDeleteResultSchema,
  automationStoreEntrySchema,
  automationStoreListInputSchema,
  automationStoreSetInputSchema,
  automationStoreSetResultSchema,
  automationStoreVerificationSchema,
  type AutomationStoreDeleteResult,
  type AutomationStoreEntry,
  type AutomationStoreSetResult,
} from "@/fragno/automation/store";
import type {
  StoreDeleteArgs,
  StoreGetArgs,
  StoreListArgs,
  StoreSetArgs,
} from "@/fragno/runtime-tools/automation-types";
import {
  defineCliArgsParser,
  ensureTrailingNewline,
  readStringOption,
  type ParsedCliTokens,
} from "@/fragno/runtime-tools/bash-cli";

import {
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeRuntimeTool,
  type BackofficeToolContext,
} from "../runtime-tools";

export type { AutomationStoreDeleteResult, AutomationStoreEntry, AutomationStoreSetResult };

export type AutomationStoreRuntime = {
  get: (input: StoreGetArgs) => Promise<AutomationStoreEntry | null>;
  set: (input: StoreSetArgs) => Promise<AutomationStoreSetResult>;
  delete: (input: StoreDeleteArgs) => Promise<AutomationStoreDeleteResult | null>;
  list: (input: StoreListArgs) => Promise<AutomationStoreEntry[]>;
};

type AutomationStoreToolContext = BackofficeToolContext<
  { automations?: AutomationStoreRuntime },
  { actor?: AutomationEventActor | null }
>;

const readJsonValueOption = (
  parsed: ParsedCliTokens,
  name: string,
  required = false,
): StoreSetArgs["actor"] | undefined => {
  const raw = readStringOption(parsed, name, required);
  if (typeof raw === "undefined") {
    return undefined;
  }

  try {
    return JSON.parse(raw) as StoreSetArgs["actor"];
  } catch {
    throw new Error(`--${name} must be valid JSON`);
  }
};

const isUnknownArray = (value: unknown): value is unknown[] => Array.isArray(value);

const readJsonArrayOption = (
  parsed: ParsedCliTokens,
  name: string,
  required = false,
): StoreSetArgs["verification"] => {
  const raw = readStringOption(parsed, name, required);
  if (typeof raw === "undefined") {
    return undefined;
  }

  try {
    const value: unknown = JSON.parse(raw);
    if (!isUnknownArray(value)) {
      throw new Error(`--${name} must be a JSON array`);
    }
    return value as NonNullable<StoreSetArgs["verification"]>;
  } catch (error) {
    if (error instanceof Error && error.message.includes("must be a JSON array")) {
      throw error;
    }
    throw new Error(`--${name} must be valid JSON`);
  }
};

const defineAutomationStoreTool = <TInputSchema extends z.ZodType, TOutputSchema extends z.ZodType>(
  tool: BackofficeRuntimeTool<TInputSchema, TOutputSchema, AutomationStoreToolContext>,
) => defineBackofficeRuntimeTool(tool);

const parseStoreGetArgs = defineCliArgsParser<StoreGetArgs>("store.get", {
  key: { required: true },
});

type StoreSetCliArgs = Omit<StoreSetArgs, "actor"> & { actor?: StoreSetArgs["actor"] };

const parseStoreSetArgs = defineCliArgsParser<StoreSetCliArgs>("store.set", {
  key: { required: true },
  value: { required: true },
  actor: {
    read: (parsed, optionName, required) => readJsonValueOption(parsed, optionName, required),
    transform: (value): StoreSetArgs["actor"] => automationStoreActorSchema.nullable().parse(value),
  },
  description: {},
  category: { kind: "stringArray" },
  verification: {
    read: (parsed, optionName, required) => readJsonArrayOption(parsed, optionName, required),
    transform: (value) => automationStoreVerificationSchema.parse(value),
  },
});

const parseStoreDeleteArgs = defineCliArgsParser<StoreDeleteArgs>("store.delete", {
  key: { required: true },
});

const parseStoreListArgs = defineCliArgsParser<StoreListArgs>("store.list", {
  prefix: {},
  limit: { kind: "positiveInteger" },
});

const formatStoreEntryText = (entry: AutomationStoreEntry) =>
  ensureTrailingNewline(
    [
      `key: ${entry.key}`,
      `value: ${entry.value}`,
      entry.description ? `description: ${entry.description}` : undefined,
      entry.category.length ? `category: ${entry.category.join(", ")}` : undefined,
      `actor: ${entry.actor ? JSON.stringify(entry.actor) : "null"}`,
    ]
      .filter(Boolean)
      .join("\n"),
  );

const formatStoreEntryListText = (entries: AutomationStoreEntry[]) => {
  if (entries.length === 0) {
    return "No store entries found.\n";
  }

  return ensureTrailingNewline(
    entries
      .map((entry) => {
        const category = entry.category.length ? ` [${entry.category.join(", ")}]` : "";
        return `${entry.key}=${entry.value}${category}`;
      })
      .join("\n"),
  );
};

const getAutomationStoreRuntime = (
  runtime: AutomationStoreToolContext["runtimes"]["automations"],
): AutomationStoreRuntime => {
  if (!runtime) {
    throw new Error("Automation store runtime is not available in this execution context");
  }
  return runtime;
};

const storeGetTool = defineAutomationStoreTool({
  id: "store.get",
  namespace: "store",
  name: "get",
  description: "Get an automation store entry by key.",
  requiredPermissions: ["read"],
  inputSchema: z.object({ key: z.string().trim().min(1) }),
  outputSchema: automationStoreEntrySchema.nullable(),
  execute: async (input, context) =>
    await getAutomationStoreRuntime(context.runtimes.automations).get(input),
  adapters: {
    bash: {
      command: "store.get",
      help: {
        summary: "store.get checks whether a key is present in the automation store.",
        options: [
          {
            name: "key",
            required: true,
            valueRequired: true,
            valueName: "key",
            description: "Store key",
          },
        ],
        examples: ["store.get --key telegram/chat-123 --print value"],
      },
      parse: parseStoreGetArgs,
      format: (entry, options) =>
        !entry
          ? { stderr: "Store entry not found.\n", exitCode: 1 }
          : options.format === "json" || options.print
            ? { data: entry }
            : { stdout: formatStoreEntryText(entry) },
    },
  },
});

const storeSetTool = defineAutomationStoreTool({
  id: "store.set",
  namespace: "store",
  name: "set",
  description: "Create or update an automation store entry.",
  requiredPermissions: ["modify"],
  inputSchema: automationStoreSetInputSchema,
  outputSchema: automationStoreSetResultSchema,
  execute: async (input, context) =>
    await getAutomationStoreRuntime(context.runtimes.automations).set(input),
  adapters: {
    bash: {
      command: "store.set",
      help: {
        summary: "store.set creates or updates a key/value automation store entry.",
        options: [
          {
            name: "key",
            required: true,
            valueRequired: true,
            valueName: "key",
            description: "Store key",
          },
          {
            name: "value",
            required: true,
            valueRequired: true,
            valueName: "value",
            description: "Value to store",
          },
          {
            name: "actor",
            valueRequired: true,
            valueName: "json",
            description:
              "JSON actor reference for who set this value, or null if unavailable. Defaults to the signed-in dashboard user when available.",
          },
          {
            name: "description",
            valueRequired: true,
            valueName: "text",
            description: "Optional human-readable description of this entry",
          },
          {
            name: "category",
            valueRequired: true,
            valueName: "category",
            description: "Optional category tag; repeat to provide multiple categories",
          },
          {
            name: "verification",
            valueRequired: true,
            valueName: "json",
            description: "Optional JSON verification list, for example json-schema checks",
          },
        ],
        examples: [
          'store.set --key telegram/chat-123 --value user-55 --actor \'{"scope":"external","source":"telegram","type":"chat","id":"chat-123"}\'',
        ],
      },
      parse: (args) => parseStoreSetArgs(args) as StoreSetArgs,
      execute: async ({ input, context, commandOutput }) => {
        const parsedInput = input as StoreSetCliArgs;
        const actor = "actor" in parsedInput ? parsedInput.actor : context.defaults?.actor;
        if (typeof actor === "undefined") {
          throw new Error(
            "Missing required option --actor. Dashboard commands provide it automatically; other contexts must pass --actor explicitly.",
          );
        }
        const entry = await getAutomationStoreRuntime(context.runtimes.automations).set({
          ...parsedInput,
          actor: actor,
        });
        return commandOutput.format === "json" || commandOutput.print
          ? { data: entry }
          : { stdout: `Stored ${entry.key}\n${formatStoreEntryText(entry)}` };
      },
    },
  },
});

const storeListTool = defineAutomationStoreTool({
  id: "store.list",
  namespace: "store",
  name: "list",
  description: "List automation store entries, optionally filtered by key prefix.",
  requiredPermissions: ["read"],
  inputSchema: automationStoreListInputSchema,
  outputSchema: z.array(automationStoreEntrySchema),
  execute: async (input, context) =>
    await getAutomationStoreRuntime(context.runtimes.automations).list(input),
  adapters: {
    bash: {
      command: "store.list",
      help: {
        summary: "store.list lists automation store entries, optionally filtered by key prefix.",
        options: [
          {
            name: "prefix",
            valueRequired: true,
            valueName: "prefix",
            description: "Optional store key prefix",
          },
          {
            name: "limit",
            valueRequired: true,
            valueName: "count",
            description: "Maximum number of entries to return",
          },
        ],
        examples: [
          "store.list --format json",
          "store.list --prefix telegram/ --limit 50 --format json",
        ],
      },
      parse: parseStoreListArgs,
      format: (entries, options) =>
        options.format === "json" || options.print
          ? { data: entries }
          : { stdout: formatStoreEntryListText(entries) },
    },
  },
});

const storeDeleteTool = defineAutomationStoreTool({
  id: "store.delete",
  namespace: "store",
  name: "delete",
  description: "Delete an automation store entry by key.",
  requiredPermissions: ["modify"],
  inputSchema: z.object({ key: z.string().trim().min(1) }),
  outputSchema: automationStoreDeleteResultSchema.nullable(),
  execute: async (input, context) =>
    await getAutomationStoreRuntime(context.runtimes.automations).delete(input),
  adapters: {
    bash: {
      command: "store.delete",
      help: {
        summary: "store.delete deletes an entry from the automation store.",
        options: [
          {
            name: "key",
            required: true,
            valueRequired: true,
            valueName: "key",
            description: "Store key",
          },
        ],
        examples: ["store.delete --key telegram/chat-123"],
      },
      parse: parseStoreDeleteArgs,
      format: (result, options) =>
        !result
          ? { stderr: "Store entry not found.\n", exitCode: 1 }
          : options.format === "json" || options.print
            ? { data: result }
            : { stdout: `Deleted ${result.key}\n` },
    },
  },
});

export const automationStoreRuntimeTools = [
  storeGetTool,
  storeSetTool,
  storeDeleteTool,
  storeListTool,
] as const;

export const automationStoreToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "store",
  permissions: {
    read: "Read automation store entries.",
    modify: "Create, update, and delete automation store entries.",
  },
  tools: automationStoreRuntimeTools,
  isAvailable: (context: AutomationStoreToolContext) => !!context.runtimes.automations,
});
