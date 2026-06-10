import { z } from "zod";

import {
  automationStoreDeleteResultSchema,
  automationStoreEntrySchema,
  type AutomationStoreDeleteResult,
  type AutomationStoreEntry,
} from "@/fragno/automation/store";
import type {
  StoreDeleteArgs,
  StoreGetArgs,
  StoreSetArgs,
} from "@/fragno/runtime-tools/automation-types";
import { defineCliArgsParser } from "@/fragno/runtime-tools/bash-cli";

import {
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeRuntimeTool,
  type BackofficeToolContext,
} from "../runtime-tools";

export type { AutomationStoreDeleteResult, AutomationStoreEntry };

export type AutomationStoreRuntime = {
  get: (input: StoreGetArgs) => Promise<AutomationStoreEntry | null>;
  set: (input: StoreSetArgs) => Promise<AutomationStoreEntry>;
  delete: (input: StoreDeleteArgs) => Promise<AutomationStoreDeleteResult | null>;
};

export type AutomationStoreToolContext = BackofficeToolContext<{
  automations?: AutomationStoreRuntime;
}>;

const nonEmptyString = z.string().trim().min(1);

const defineAutomationStoreTool = <TInputSchema extends z.ZodType, TOutputSchema extends z.ZodType>(
  tool: BackofficeRuntimeTool<TInputSchema, TOutputSchema, AutomationStoreToolContext>,
) => defineBackofficeRuntimeTool(tool);

const parseStoreGetArgs = defineCliArgsParser<StoreGetArgs>("store.get", {
  key: { required: true },
});

const parseStoreSetArgs = defineCliArgsParser<StoreSetArgs>("store.set", {
  key: { required: true },
  value: { required: true },
});

const parseStoreDeleteArgs = defineCliArgsParser<StoreDeleteArgs>("store.delete", {
  key: { required: true },
});

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
  inputSchema: z.object({ key: nonEmptyString }),
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
      format: (entry) => (!entry ? { exitCode: 1 } : { data: entry }),
    },
  },
});

const storeSetTool = defineAutomationStoreTool({
  id: "store.set",
  namespace: "store",
  name: "set",
  description: "Create or update an automation store entry.",
  inputSchema: z.object({
    key: nonEmptyString,
    value: nonEmptyString,
  }),
  outputSchema: automationStoreEntrySchema,
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
        ],
        examples: ["store.set --key telegram/chat-123 --value user-55"],
      },
      parse: parseStoreSetArgs,
      format: (entry) => ({ data: entry }),
    },
  },
});

const storeDeleteTool = defineAutomationStoreTool({
  id: "store.delete",
  namespace: "store",
  name: "delete",
  description: "Delete an automation store entry by key.",
  inputSchema: z.object({ key: nonEmptyString }),
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
      format: (result) => (!result ? { exitCode: 1 } : { data: result }),
    },
  },
});

export const automationStoreRuntimeTools = [storeGetTool, storeSetTool, storeDeleteTool] as const;

export const automationStoreToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "store",
  tools: automationStoreRuntimeTools,
  isAvailable: (context: AutomationStoreToolContext) => !!context.runtimes.automations,
});
