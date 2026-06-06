import { z } from "zod";

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

export type WorkflowInstanceStatus = {
  status: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
  error?: { name: string; message: string };
  output?: unknown;
};

export type WorkflowCreateInstanceArgs = {
  workflowName: string;
  remoteWorkflowName?: string;
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

export type WorkflowSendEventArgs = {
  workflowName: string;
  instanceId: string;
  type: string;
  payload?: unknown;
};

export type AutomationWorkflowRuntime = {
  createInstance: (input: WorkflowCreateInstanceArgs) => Promise<WorkflowCreateInstanceResult>;
  getStatus: (input: WorkflowGetStatusArgs) => Promise<WorkflowInstanceStatus>;
  sendEvent: (input: WorkflowSendEventArgs) => Promise<unknown>;
};

export type AutomationWorkflowToolContext = BackofficeToolContext<{
  workflow?: AutomationWorkflowRuntime;
}>;

const nonEmptyString = z.string().trim().min(1);

const workflowInstanceStatusSchema = z.object({
  status: z.enum(["active", "paused", "errored", "terminated", "complete", "waiting"]),
  error: z.object({ name: z.string(), message: z.string() }).optional(),
  output: z.unknown().optional(),
});

const workflowCreateInstanceResultSchema = z.object({
  workflowName: nonEmptyString,
  instanceId: nonEmptyString,
});

const defineAutomationWorkflowTool = <
  TInputSchema extends z.ZodType,
  TOutputSchema extends z.ZodType,
>(
  tool: BackofficeRuntimeTool<TInputSchema, TOutputSchema, AutomationWorkflowToolContext>,
) => defineBackofficeRuntimeTool(tool);

const getAutomationWorkflowRuntime = (
  runtime: AutomationWorkflowToolContext["runtimes"]["workflow"],
): AutomationWorkflowRuntime => {
  if (!runtime) {
    throw new Error("Automation workflow runtime is not available in this execution context");
  }
  return runtime;
};

const parseWorkflowCreateInstanceArgs = (args: string[]): WorkflowCreateInstanceArgs => {
  const parsed = parseCliTokens(args);
  assertNoPositionals(parsed, "workflow.create-instance");
  return {
    workflowName: readStringOption(parsed, "workflow-name", true)!,
    remoteWorkflowName: readStringOption(parsed, "remote-workflow-name"),
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

const parseWorkflowSendEventArgs = (args: string[]): WorkflowSendEventArgs => {
  const parsed = parseCliTokens(args);
  assertNoPositionals(parsed, "workflow.send-event");
  return {
    workflowName: readStringOption(parsed, "workflow-name", true)!,
    instanceId: readStringOption(parsed, "instance-id", true)!,
    type: readStringOption(parsed, "type", true)!,
    payload: readJsonOption(parsed, "payload-json"),
  };
};

const workflowCreateInstanceTool = defineAutomationWorkflowTool({
  id: "workflow.create-instance",
  namespace: "workflow",
  name: "createInstance",
  description: "Create a durable workflow instance by workflow name.",
  inputSchema: z.object({
    workflowName: nonEmptyString,
    remoteWorkflowName: nonEmptyString.optional(),
    instanceId: nonEmptyString.optional(),
    params: z.unknown().optional(),
  }),
  outputSchema: workflowCreateInstanceResultSchema,
  execute: async (input, context) =>
    await getAutomationWorkflowRuntime(context.runtimes.workflow).createInstance(input),
  reference: { codemode: { description: "Create a durable workflow instance." } },
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
            description:
              "Workflow name to create or dynamic public workflow name for remote workflows.",
          },
          {
            name: "remote-workflow-name",
            valueRequired: true,
            valueName: "name",
            description:
              "Optional registered remote host workflow name used to execute this dynamic workflow.",
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

const workflowGetStatusTool = defineAutomationWorkflowTool({
  id: "workflow.get-status",
  namespace: "workflow",
  name: "getStatus",
  description: "Get the current status for a durable workflow instance.",
  inputSchema: z.object({ workflowName: nonEmptyString, instanceId: nonEmptyString }),
  outputSchema: workflowInstanceStatusSchema,
  execute: async (input, context) =>
    await getAutomationWorkflowRuntime(context.runtimes.workflow).getStatus(input),
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

const workflowSendEventTool = defineAutomationWorkflowTool({
  id: "workflow.send-event",
  namespace: "workflow",
  name: "sendEvent",
  description: "Send an event to a durable workflow instance.",
  inputSchema: z.object({
    workflowName: nonEmptyString,
    instanceId: nonEmptyString,
    type: nonEmptyString,
    payload: z.unknown().optional(),
  }),
  outputSchema: z.unknown(),
  execute: async (input, context) =>
    await getAutomationWorkflowRuntime(context.runtimes.workflow).sendEvent(input),
  reference: { codemode: { description: "Send an event to a waiting durable workflow instance." } },
  adapters: {
    bash: {
      command: "workflow.send-event",
      help: {
        summary: "workflow.send-event sends an event to a durable workflow instance.",
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
          {
            name: "type",
            required: true,
            valueRequired: true,
            valueName: "type",
            description: "Event type.",
          },
          {
            name: "payload-json",
            valueRequired: true,
            valueName: "json",
            description: "Optional event payload JSON.",
          },
        ],
        examples: [
          'workflow.send-event --workflow-name exec-codemode-workflow --instance-id run-1 --type continue --payload-json "{}"',
        ],
      },
      parse: parseWorkflowSendEventArgs,
      format: (result) => ({ data: result }),
    },
  },
});

export const automationWorkflowRuntimeTools = [
  workflowCreateInstanceTool,
  workflowGetStatusTool,
  workflowSendEventTool,
] as const;

export const automationWorkflowToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "automations-workflow",
  tools: automationWorkflowRuntimeTools,
  isAvailable: (context: AutomationWorkflowToolContext) => !!context.runtimes.workflow,
});
