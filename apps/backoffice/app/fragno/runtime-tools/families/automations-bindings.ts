import { z } from "zod";

import {
  automationIdentityBindingRecordSchema,
  type AutomationIdentityBindingRecord,
} from "@/fragno/automation/identity";
import type {
  IdentityBindActorArgs,
  IdentityLookupBindingArgs,
} from "@/fragno/runtime-tools/automation-types";
import { defineCliArgsParser } from "@/fragno/runtime-tools/bash-cli";

import {
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeRuntimeTool,
  type BackofficeToolContext,
} from "../runtime-tools";

export type { AutomationIdentityBindingRecord };

export type AutomationBindingsRuntime = {
  lookupBinding: (
    input: IdentityLookupBindingArgs,
  ) => Promise<AutomationIdentityBindingRecord | null>;
  bindActor: (input: IdentityBindActorArgs) => Promise<AutomationIdentityBindingRecord>;
};

export type AutomationBindingsToolContext = BackofficeToolContext<{
  automations?: AutomationBindingsRuntime;
}>;

const nonEmptyString = z.string().trim().min(1);

const defineAutomationBindingsTool = <
  TInputSchema extends z.ZodType,
  TOutputSchema extends z.ZodType,
>(
  tool: BackofficeRuntimeTool<TInputSchema, TOutputSchema, AutomationBindingsToolContext>,
) => defineBackofficeRuntimeTool(tool);

const parseLookupBindingArgs = defineCliArgsParser<IdentityLookupBindingArgs>(
  "identity.lookup-binding",
  { source: { required: true }, key: { required: true } },
);

const parseBindActorArgs = defineCliArgsParser<IdentityBindActorArgs>("identity.bind-actor", {
  source: { required: true },
  key: { required: true },
  value: { required: true },
  description: {},
});

const getAutomationBindingsRuntime = (
  runtime: AutomationBindingsToolContext["runtimes"]["automations"],
): AutomationBindingsRuntime => {
  if (!runtime) {
    throw new Error("Automation bindings runtime is not available in this execution context");
  }
  return runtime;
};

const lookupBindingTool = defineAutomationBindingsTool({
  id: "identity.lookup-binding",
  namespace: "identity",
  name: "lookupBinding",
  description: "Lookup a linked automation identity binding by source and key.",
  inputSchema: z.object({ source: nonEmptyString, key: nonEmptyString }),
  outputSchema: automationIdentityBindingRecordSchema.nullable(),
  execute: async (input, context) =>
    await getAutomationBindingsRuntime(context.runtimes.automations).lookupBinding(input),
  adapters: {
    bash: {
      command: "identity.lookup-binding",
      help: {
        summary:
          "identity.lookup-binding checks whether a key is already present in automation identity bindings.",
        options: [
          {
            name: "source",
            required: true,
            valueRequired: true,
            valueName: "source",
            description: "Identity source name (e.g. telegram)",
          },
          {
            name: "key",
            required: true,
            valueRequired: true,
            valueName: "key",
            description: "Storage key for this source (e.g. external chat id)",
          },
        ],
        examples: ["identity.lookup-binding --source telegram --key chat-123 --print value"],
      },
      parse: parseLookupBindingArgs,
      format: (binding) =>
        !binding || binding.status !== "linked" ? { exitCode: 1 } : { data: binding },
    },
  },
});

const bindActorTool = defineAutomationBindingsTool({
  id: "identity.bind-actor",
  namespace: "identity",
  name: "bindActor",
  description: "Create or update an automation identity binding.",
  inputSchema: z.object({
    source: nonEmptyString,
    key: nonEmptyString,
    value: nonEmptyString,
    description: z.string().optional(),
  }),
  outputSchema: automationIdentityBindingRecordSchema,
  execute: async (input, context) =>
    await getAutomationBindingsRuntime(context.runtimes.automations).bindActor(input),
  adapters: {
    bash: {
      command: "identity.bind-actor",
      help: {
        summary: "identity.bind-actor creates or updates a key/value identity binding.",
        options: [
          {
            name: "source",
            required: true,
            valueRequired: true,
            valueName: "source",
            description: "Identity source name (e.g. telegram)",
          },
          {
            name: "key",
            required: true,
            valueRequired: true,
            valueName: "key",
            description: "Storage key for this source",
          },
          {
            name: "value",
            required: true,
            valueRequired: true,
            valueName: "value",
            description: "Value to store (e.g. Fragno user id)",
          },
          {
            name: "description",
            valueRequired: true,
            valueName: "text",
            description: "Optional human-readable description of this binding",
          },
        ],
        examples: [
          "identity.bind-actor --source telegram --key chat-123 --value user-55",
          'identity.bind-actor --source telegram --key chat-123 --value user-55 --description "Primary device"',
        ],
      },
      parse: parseBindActorArgs,
      format: (binding) => ({ data: binding }),
    },
  },
});

export const automationBindingsRuntimeTools = [lookupBindingTool, bindActorTool] as const;

export const automationBindingsToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "identity",
  tools: automationBindingsRuntimeTools,
  isAvailable: (context: AutomationBindingsToolContext) => !!context.runtimes.automations,
});
