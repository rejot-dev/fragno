import { z } from "zod";

import {
  automationIdentityBindingRecordSchema,
  type AutomationIdentityBindingRecord,
} from "@/fragno/automation/identity";
import type {
  IdentityBindActorArgs,
  IdentityLookupBindingArgs,
} from "@/fragno/runtime-tools/automation-types";
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

const parseLookupBindingArgs = (args: string[]): IdentityLookupBindingArgs => {
  const parsed = parseCliTokens(args);
  assertNoPositionals(parsed, "automations.identity.lookup-binding");
  return {
    source: readStringOption(parsed, "source", true)!,
    key: readStringOption(parsed, "key", true)!,
  };
};

const parseBindActorArgs = (args: string[]): IdentityBindActorArgs => {
  const parsed = parseCliTokens(args);
  assertNoPositionals(parsed, "automations.identity.bind-actor");
  return {
    source: readStringOption(parsed, "source", true)!,
    key: readStringOption(parsed, "key", true)!,
    value: readStringOption(parsed, "value", true)!,
    description: readStringOption(parsed, "description"),
  };
};

const getAutomationBindingsRuntime = (
  runtime: AutomationBindingsToolContext["runtimes"]["automations"],
): AutomationBindingsRuntime => {
  if (!runtime) {
    throw new Error("Automation bindings runtime is not available in this execution context");
  }
  return runtime;
};

const lookupBindingTool = defineAutomationBindingsTool({
  id: "automations.identity.lookup-binding",
  namespace: "automations",
  name: "lookupBinding",
  description: "Lookup a linked automation identity binding by source and key.",
  inputSchema: z.object({ source: nonEmptyString, key: nonEmptyString }),
  outputSchema: automationIdentityBindingRecordSchema.nullable(),
  execute: async (input, context) =>
    await getAutomationBindingsRuntime(context.runtimes.automations).lookupBinding(input),
  adapters: {
    bash: {
      command: "automations.identity.lookup-binding",
      help: {
        summary:
          "automations.identity.lookup-binding checks whether a key is already present in automation identity bindings.",
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
        examples: [
          "automations.identity.lookup-binding --source telegram --key chat-123 --print value",
        ],
      },
      parse: parseLookupBindingArgs,
      format: (binding) =>
        !binding || binding.status !== "linked" ? { exitCode: 1 } : { data: binding },
    },
  },
});

const bindActorTool = defineAutomationBindingsTool({
  id: "automations.identity.bind-actor",
  namespace: "automations",
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
      command: "automations.identity.bind-actor",
      help: {
        summary: "automations.identity.bind-actor creates or updates a key/value identity binding.",
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
          "automations.identity.bind-actor --source telegram --key chat-123 --value user-55",
          'automations.identity.bind-actor --source telegram --key chat-123 --value user-55 --description "Primary device"',
        ],
      },
      parse: parseBindActorArgs,
      format: (binding) => ({ data: binding }),
    },
  },
});

export const automationBindingsRuntimeTools = [lookupBindingTool, bindActorTool] as const;

export const automationBindingsToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "automations-bindings",
  tools: automationBindingsRuntimeTools,
  isAvailable: (context: AutomationBindingsToolContext) => !!context.runtimes.automations,
});
