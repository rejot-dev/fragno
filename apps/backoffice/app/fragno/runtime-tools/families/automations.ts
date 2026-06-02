import { z } from "zod";

import {
  assertNoPositionals,
  parseCliTokens,
  readStringOption,
} from "@/fragno/automation/commands/cli";
import type {
  IdentityBindActorArgs,
  IdentityLookupBindingArgs,
  ScriptRunArgs,
  ScriptRunnerRuntime,
} from "@/fragno/automation/commands/types";

import { defineBackofficeRuntimeTool } from "../runtime-tools";

export type AutomationIdentityBindingRecord = {
  id?: unknown;
  source: string;
  key: string;
  value: string;
  description?: string | null;
  status: string;
  linkedAt?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
};

export type AutomationsBashRuntime = {
  lookupBinding: (
    input: IdentityLookupBindingArgs,
  ) => Promise<AutomationIdentityBindingRecord | null>;
  bindActor: (input: IdentityBindActorArgs) => Promise<AutomationIdentityBindingRecord>;
};

export type { ScriptRunnerRuntime };

const nonEmptyString = z.string().trim().min(1);

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

const parseScriptRunArgs = (args: string[]): ScriptRunArgs => {
  const parsed = parseCliTokens(args);
  assertNoPositionals(parsed, "scripts.run");
  return {
    script: readStringOption(parsed, "script", true)!,
    event: readStringOption(parsed, "event", true)!,
  };
};

const getAutomationsRuntime = (runtime: unknown): AutomationsBashRuntime => {
  if (!runtime) {
    throw new Error("Automations runtime is not available in this execution context");
  }
  return runtime as AutomationsBashRuntime;
};

const getScriptRunner = (scriptRunner: unknown): ScriptRunnerRuntime => {
  if (!scriptRunner) {
    throw new Error("scripts.run is not available in this execution context");
  }
  return scriptRunner as ScriptRunnerRuntime;
};

const lookupBindingTool = defineBackofficeRuntimeTool({
  id: "automations.identity.lookup-binding",
  namespace: "automations",
  name: "lookupBinding",
  description: "Lookup a linked automation identity binding by source and key.",
  inputSchema: z.object({
    source: nonEmptyString,
    key: nonEmptyString,
  }),
  outputSchema: z
    .object({
      id: z.unknown().optional(),
      source: z.string(),
      key: z.string(),
      value: z.string(),
      description: z.string().nullable().optional(),
      status: z.string(),
      linkedAt: z.unknown().optional(),
      createdAt: z.unknown().optional(),
      updatedAt: z.unknown().optional(),
    })
    .nullable(),
  execute: async (input, context) =>
    getAutomationsRuntime(context.runtimes.automations).lookupBinding(input),
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
});

const bindActorTool = defineBackofficeRuntimeTool({
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
  outputSchema: z.object({
    id: z.unknown().optional(),
    source: z.string(),
    key: z.string(),
    value: z.string(),
    description: z.string().nullable().optional(),
    status: z.string(),
    linkedAt: z.unknown().optional(),
    createdAt: z.unknown().optional(),
    updatedAt: z.unknown().optional(),
  }),
  execute: async (input, context) =>
    getAutomationsRuntime(context.runtimes.automations).bindActor(input),
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
});

const scriptRunTool = defineBackofficeRuntimeTool({
  id: "scripts.run",
  namespace: "automations",
  name: "runScript",
  description: "Execute an automation script against an event fixture for manual testing.",
  inputSchema: z.object({
    script: nonEmptyString,
    event: nonEmptyString,
  }),
  outputSchema: z.object({
    eventId: z.string(),
    scriptId: z.string(),
    exitCode: z.number(),
    stdout: z.string(),
    stderr: z.string(),
    commandCalls: z.array(
      z.object({
        command: z.string(),
        output: z.string(),
        exitCode: z.number(),
      }),
    ),
  }),
  execute: async (input, context) => getScriptRunner(context.scriptRunner).runScript(input),
  bash: {
    command: "scripts.run",
    help: {
      summary:
        "scripts.run executes a script against an event fixture from an interactive shell context for manual testing.",
      options: [
        {
          name: "script",
          required: true,
          valueRequired: true,
          valueName: "path",
          description:
            "Path to the script file. Relative paths resolve under /workspace/automations/; absolute paths resolve against the master filesystem",
        },
        {
          name: "event",
          required: true,
          valueRequired: true,
          valueName: "path",
          description:
            "Path to an event JSON file (e.g. /events/2026-03-25/...json). The current interactive orgId is injected when the fixture omits orgId; mismatches are rejected",
        },
      ],
      examples: [
        "scripts.run --script scripts/my-script.sh --event /events/2026-03-25/2026-03-25T10:00:00.000Z_hook-id.json",
        "scripts.run --script /workspace/automations/scripts/my-script.sh --event /events/2026-03-25/2026-03-25T10:00:00.000Z_hook-id.json --format json",
      ],
    },
    parse: parseScriptRunArgs,
    format: (result, options) => {
      const hasExplicitFormat = options.format === "json" || !!options.print;
      const data = {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        commandCalls: result.commandCalls,
      };

      if (result.exitCode !== 0) {
        return {
          data,
          ...(!hasExplicitFormat ? { stdout: result.stdout } : {}),
          stderr: result.stderr || `Script exited with code ${result.exitCode}`,
          exitCode: result.exitCode,
        };
      }

      return {
        data,
        ...(!hasExplicitFormat ? { stdout: result.stdout } : {}),
      };
    },
  },
});

export const automationsRuntimeTools = [lookupBindingTool, bindActorTool, scriptRunTool] as const;
export const automationIdentityRuntimeTools = [lookupBindingTool, bindActorTool] as const;
