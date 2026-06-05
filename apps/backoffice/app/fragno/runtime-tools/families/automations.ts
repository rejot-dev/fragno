import { z } from "zod";

import {
  automationIdentityBindingRecordSchema,
  type AutomationIdentityBindingRecord,
} from "@/fragno/automation/identity";
import { automationRunResultSchema } from "@/fragno/automation/run-result";
import type {
  IdentityBindActorArgs,
  IdentityLookupBindingArgs,
  ScriptRunArgs,
  ScriptRunnerRuntime,
} from "@/fragno/runtime-tools/automation-types";
import {
  assertNoPositionals,
  parseCliTokens,
  readJsonOption,
  readStringOption,
} from "@/fragno/runtime-tools/bash-cli";

import {
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeRuntimeTool,
  type BackofficeToolContext,
} from "../runtime-tools";

export type { AutomationIdentityBindingRecord };

export type AutomationsRuntime = {
  lookupBinding: (
    input: IdentityLookupBindingArgs,
  ) => Promise<AutomationIdentityBindingRecord | null>;
  bindActor: (input: IdentityBindActorArgs) => Promise<AutomationIdentityBindingRecord>;
};

export type WorkflowInstanceStatus = {
  status: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
  error?: { name: string; message: string };
  output?: unknown;
};

export type WorkflowCreateInstanceArgs = {
  workflowName: string;
  instanceId?: string;
  params?: unknown;
};

export type WorkflowCreateInstanceResult = {
  workflowName: string;
  instanceId: string;
};

export type WorkflowGetStatusArgs = {
  workflowName: string;
  instanceId: string;
};

export type WorkflowsRuntime = {
  createInstance: (input: WorkflowCreateInstanceArgs) => Promise<WorkflowCreateInstanceResult>;
  getStatus: (input: WorkflowGetStatusArgs) => Promise<WorkflowInstanceStatus>;
};

export type { ScriptRunnerRuntime };

type AutomationsToolContext = BackofficeToolContext<
  { automations?: AutomationsRuntime; workflow?: WorkflowsRuntime },
  ScriptRunnerRuntime
>;

const nonEmptyString = z.string().trim().min(1);

const workflowInstanceStatusSchema = z.object({
  status: z.enum(["active", "paused", "errored", "terminated", "complete", "waiting"]),
  error: z
    .object({
      name: z.string(),
      message: z.string(),
    })
    .optional(),
  output: z.unknown().optional(),
});

const workflowCreateInstanceResultSchema = z.object({
  workflowName: nonEmptyString,
  instanceId: nonEmptyString,
});

const defineAutomationRuntimeTool = <
  TInputSchema extends z.ZodType,
  TOutputSchema extends z.ZodType,
>(
  tool: BackofficeRuntimeTool<TInputSchema, TOutputSchema, AutomationsToolContext>,
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

const parseWorkflowCreateInstanceArgs = (args: string[]): WorkflowCreateInstanceArgs => {
  const parsed = parseCliTokens(args);
  assertNoPositionals(parsed, "workflow.create-instance");
  return {
    workflowName: readStringOption(parsed, "workflow-name", true)!,
    instanceId: readStringOption(parsed, "instance-id"),
    params: readJsonOption(parsed, "params-json"),
  };
};

const parseWorkflowGetStatusArgs = (args: string[]): WorkflowGetStatusArgs => {
  const parsed = parseCliTokens(args);
  assertNoPositionals(parsed, "workflow.get-status");
  return {
    workflowName: readStringOption(parsed, "workflow-name", true)!,
    instanceId: readStringOption(parsed, "instance-id", true)!,
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

const getAutomationsRuntime = (
  runtime: AutomationsToolContext["runtimes"]["automations"],
): AutomationsRuntime => {
  if (!runtime) {
    throw new Error("Automations runtime is not available in this execution context");
  }
  return runtime;
};

const getScriptRunner = (
  scriptRunner: AutomationsToolContext["scriptRunner"],
): ScriptRunnerRuntime => {
  if (!scriptRunner) {
    throw new Error("scripts.run is not available in this execution context");
  }
  return scriptRunner;
};

const getWorkflowsRuntime = (
  runtime: AutomationsToolContext["runtimes"]["workflow"],
): WorkflowsRuntime => {
  if (!runtime) {
    throw new Error("Workflow runtime is not available in this execution context");
  }
  return runtime;
};

const lookupBindingTool = defineAutomationRuntimeTool({
  id: "automations.identity.lookup-binding",
  namespace: "automations",
  name: "lookupBinding",
  description: "Lookup a linked automation identity binding by source and key.",
  inputSchema: z.object({
    source: nonEmptyString,
    key: nonEmptyString,
  }),
  outputSchema: automationIdentityBindingRecordSchema.nullable(),
  execute: async (input, context) =>
    await getAutomationsRuntime(context.runtimes.automations).lookupBinding(input),
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

const bindActorTool = defineAutomationRuntimeTool({
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
    await getAutomationsRuntime(context.runtimes.automations).bindActor(input),
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

const workflowCreateInstanceTool = defineAutomationRuntimeTool({
  id: "workflow.create-instance",
  namespace: "workflow",
  name: "createInstance",
  description: "Create a durable workflow instance by workflow name.",
  inputSchema: z.object({
    workflowName: nonEmptyString,
    instanceId: nonEmptyString.optional(),
    params: z.unknown().optional(),
  }),
  outputSchema: workflowCreateInstanceResultSchema,
  execute: async (input, context) =>
    await getWorkflowsRuntime(context.runtimes.workflow).createInstance(input),
  reference: {
    codemode: {
      description:
        "Create a durable workflow instance. Use this for launching named workflows from codemode.",
    },
  },
  adapters: {
    bash: {
      command: "workflow.create-instance",
      help: {
        summary: "workflow.create-instance creates a durable workflow instance by workflow name.",
        options: [
          {
            name: "workflow-name",
            required: true,
            valueRequired: true,
            valueName: "name",
            description: "Registered workflow name.",
          },
          {
            name: "instance-id",
            valueRequired: true,
            valueName: "id",
            description: "Optional caller-provided workflow instance id.",
          },
          {
            name: "params-json",
            valueRequired: true,
            valueName: "json",
            description: "Optional workflow params as a JSON object.",
          },
        ],
        examples: [
          'workflow.create-instance --workflow-name exec-codemode-workflow --instance-id run-1 --params-json "{}"',
        ],
      },
      parse: parseWorkflowCreateInstanceArgs,
      format: (result) => ({ data: result }),
    },
  },
});

const workflowGetStatusTool = defineAutomationRuntimeTool({
  id: "workflow.get-status",
  namespace: "workflow",
  name: "getStatus",
  description: "Get the current status for a durable workflow instance.",
  inputSchema: z.object({
    workflowName: nonEmptyString,
    instanceId: nonEmptyString,
  }),
  outputSchema: workflowInstanceStatusSchema,
  execute: async (input, context) =>
    await getWorkflowsRuntime(context.runtimes.workflow).getStatus(input),
  reference: {
    codemode: {
      description: "Get the current status, output, or error for a durable workflow instance.",
    },
  },
  adapters: {
    bash: {
      command: "workflow.get-status",
      help: {
        summary: "workflow.get-status returns the current status for a durable workflow instance.",
        options: [
          {
            name: "workflow-name",
            required: true,
            valueRequired: true,
            valueName: "name",
            description: "Registered workflow name.",
          },
          {
            name: "instance-id",
            required: true,
            valueRequired: true,
            valueName: "id",
            description: "Workflow instance id.",
          },
        ],
        examples: [
          "workflow.get-status --workflow-name exec-codemode-workflow --instance-id run-1",
        ],
      },
      parse: parseWorkflowGetStatusArgs,
      format: (status) => ({ data: status }),
    },
  },
});

const scriptRunTool = defineAutomationRuntimeTool({
  id: "scripts.run",
  namespace: "automations",
  name: "runScript",
  description: "Execute an automation script against an event fixture for manual testing.",
  inputSchema: z.object({
    script: nonEmptyString,
    event: nonEmptyString,
  }),
  outputSchema: automationRunResultSchema,
  execute: async (input, context) => await getScriptRunner(context.scriptRunner).runScript(input),
  adapters: {
    bash: {
      command: "scripts.run",
      help: {
        summary:
          "scripts.run executes a bash or codemode automation script against an event fixture from an interactive shell context for manual testing.",
        options: [
          {
            name: "script",
            required: true,
            valueRequired: true,
            valueName: "path",
            description:
              "Path to the script file. Relative paths resolve under /workspace/automations/; absolute paths resolve against the master filesystem. *.cm.js files run through codemode; other files run through bash",
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
          "scripts.run --script scripts/my-script.cm.js --event /events/2026-03-25/2026-03-25T10:00:00.000Z_hook-id.json --format json",
          "scripts.run --script /workspace/automations/scripts/my-script.sh --event /events/2026-03-25/2026-03-25T10:00:00.000Z_hook-id.json --format json",
        ],
      },
      parse: parseScriptRunArgs,
      format: (result, options) => {
        const hasExplicitFormat = options.format === "json" || !!options.print;
        const data = {
          runtime: result.runtime,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          logs: result.logs,
          ...(result.result !== undefined ? { result: result.result } : {}),
          commandCalls: result.commandCalls,
          toolCalls: result.toolCalls,
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
  },
});

export const automationsRuntimeTools = [lookupBindingTool, bindActorTool, scriptRunTool] as const;
export const automationIdentityRuntimeTools = [lookupBindingTool, bindActorTool] as const;
export const workflowRuntimeTools = [workflowCreateInstanceTool, workflowGetStatusTool] as const;

export const automationsToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "automations",
  tools: automationsRuntimeTools,
  isAvailable: (context: AutomationsToolContext) => !!context.runtimes.automations,
});

export const automationIdentityToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "automations",
  tools: automationIdentityRuntimeTools,
  isAvailable: (context: AutomationsToolContext) => !!context.runtimes.automations,
});

export const workflowToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "workflow",
  tools: workflowRuntimeTools,
  isAvailable: (context: AutomationsToolContext) => !!context.runtimes.workflow,
});
