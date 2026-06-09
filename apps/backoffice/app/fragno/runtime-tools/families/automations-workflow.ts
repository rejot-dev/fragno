import { z } from "zod";

import { defineCliArgsParser, defineEmptyArgsParser } from "@/fragno/runtime-tools/bash-cli";

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

export type WorkflowRetryInstanceArgs = {
  workflowName: string;
  instanceId: string;
  stepKey?: string;
  delayMs?: number;
  reason?: string;
};

export type WorkflowSendEventArgs = {
  workflowName: string;
  instanceId: string;
  type: string;
  payload?: unknown;
};

export type WorkflowListResult = { workflows: Array<{ name: string }> };

export type WorkflowListInstancesArgs = {
  workflowName: string;
  status?: WorkflowInstanceStatus["status"];
  remoteWorkflowName?: string;
  pageSize?: number;
  cursor?: string;
};

export type WorkflowInstanceSummary = {
  id: string;
  details: WorkflowInstanceStatus;
  createdAt: string | Date;
};

export type WorkflowListInstancesResult = {
  instances: WorkflowInstanceSummary[];
  nextCursor?: string;
  hasNextPage: boolean;
};

export type WorkflowGetInstanceArgs = WorkflowGetStatusArgs;

export type WorkflowInstanceDetails = {
  id: string;
  details: WorkflowInstanceStatus;
  meta: Record<string, unknown>;
};

export type WorkflowRetryInstanceResult = {
  accepted: true;
  instance: {
    id: string;
    details: WorkflowInstanceStatus;
  };
  retry: {
    stepKey: string;
    attempts: number;
    maxAttempts: number;
    scheduledAt: string | Date;
  };
};

export type WorkflowHistory = {
  steps: unknown[];
  events: unknown[];
  emissions: unknown[];
};

export type AutomationWorkflowRuntime = {
  createInstance: (input: WorkflowCreateInstanceArgs) => Promise<WorkflowCreateInstanceResult>;
  getStatus: (input: WorkflowGetStatusArgs) => Promise<WorkflowInstanceStatus>;
  sendEvent: (input: WorkflowSendEventArgs) => Promise<unknown>;
  listWorkflows?: () => Promise<WorkflowListResult>;
  listInstances?: (input: WorkflowListInstancesArgs) => Promise<WorkflowListInstancesResult>;
  getInstance?: (input: WorkflowGetInstanceArgs) => Promise<WorkflowInstanceDetails>;
  retryInstance?: (input: WorkflowRetryInstanceArgs) => Promise<WorkflowRetryInstanceResult>;
  getHistory?: (input: WorkflowGetInstanceArgs) => Promise<WorkflowHistory>;
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

const workflowListResultSchema = z.object({
  workflows: z.array(z.object({ name: nonEmptyString })),
});

const workflowListInstancesResultSchema = z.object({
  instances: z.array(
    z.object({
      id: nonEmptyString,
      details: workflowInstanceStatusSchema,
      createdAt: z.union([z.string(), z.date()]),
    }),
  ),
  nextCursor: z.string().optional(),
  hasNextPage: z.boolean(),
});

const workflowInstanceDetailsSchema = z.object({
  id: nonEmptyString,
  details: workflowInstanceStatusSchema,
  meta: z.record(z.string(), z.unknown()),
});

const workflowRetryInstanceResultSchema = z.object({
  accepted: z.literal(true),
  instance: z.object({
    id: nonEmptyString,
    details: workflowInstanceStatusSchema,
  }),
  retry: z.object({
    stepKey: nonEmptyString,
    attempts: z.number(),
    maxAttempts: z.number(),
    scheduledAt: z.union([z.string(), z.date()]),
  }),
});

const workflowHistorySchema = z.object({
  steps: z.array(z.unknown()),
  events: z.array(z.unknown()),
  emissions: z.array(z.unknown()),
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

const getWorkflowRuntimeMethod = <TMethod extends keyof AutomationWorkflowRuntime>(
  runtime: AutomationWorkflowRuntime,
  method: TMethod,
): NonNullable<AutomationWorkflowRuntime[TMethod]> => {
  const fn = runtime[method];
  if (!fn) {
    throw new Error(
      `Workflow runtime method ${String(method)} is not available in this execution context`,
    );
  }
  return fn as NonNullable<AutomationWorkflowRuntime[TMethod]>;
};

const parseWorkflowCreateInstanceArgs = defineCliArgsParser<WorkflowCreateInstanceArgs>(
  "workflow.instances.create",
  {
    workflowName: { required: true },
    remoteWorkflowName: {},
    instanceId: {},
    params: { kind: "json", option: "params-json" },
  },
);

const parseWorkflowListInstancesArgs = defineCliArgsParser<WorkflowListInstancesArgs>(
  "workflow.instances.list",
  {
    workflowName: { required: true },
    status: {},
    remoteWorkflowName: {},
    pageSize: { kind: "positiveInteger" },
    cursor: {},
  },
);

const parseWorkflowGetInstanceArgs = (command: string) =>
  defineCliArgsParser<WorkflowGetInstanceArgs>(command, {
    workflowName: { required: true },
    instanceId: { required: true },
  });

const formatWorkflowStatusSummary = (status: WorkflowInstanceStatus) =>
  status.error ? `${status.status} (${status.error.name}: ${status.error.message})` : status.status;

const formatWorkflowListText = (result: WorkflowListResult) => {
  const lines = result.workflows.map((workflow) => workflow.name);
  return `${lines.length ? lines.join("\n") : "(no workflows)"}\n`;
};

const formatWorkflowInstancesText = (result: WorkflowListInstancesResult) => {
  const lines = result.instances.map((instance) =>
    [
      instance.id,
      formatWorkflowStatusSummary(instance.details),
      new Date(instance.createdAt).toISOString(),
    ].join("\t"),
  );
  if (result.hasNextPage && result.nextCursor) {
    lines.push(`next cursor: ${result.nextCursor}`);
  }
  return `${lines.length ? lines.join("\n") : "(no instances)"}\n`;
};

const parseWorkflowInstanceSendEventArgs = defineCliArgsParser<WorkflowSendEventArgs>(
  "workflow.instances.send-event",
  {
    workflowName: { required: true },
    instanceId: { required: true },
    type: { required: true },
    payload: { kind: "json", option: "payload-json" },
  },
);

const parseWorkflowRetryInstanceArgs = defineCliArgsParser<WorkflowRetryInstanceArgs>(
  "workflow.instances.retry",
  {
    workflowName: { required: true },
    instanceId: { required: true },
    stepKey: {},
    delayMs: { kind: "nonNegativeInteger" },
    reason: {},
  },
);

const workflowInstanceCreateTool = defineAutomationWorkflowTool({
  id: "workflow.instances.create",
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
      command: "workflow.instances.create",
      help: {
        summary: "workflow.instances.create creates a durable workflow instance by workflow name.",
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
          'workflow.instances.create --workflow-name exec-codemode-workflow --instance-id run-1 --params-json "{}"',
        ],
      },
      parse: parseWorkflowCreateInstanceArgs,
      format: (result, options) =>
        options.format === "json"
          ? { data: result }
          : { stdout: `${result.workflowName}\t${result.instanceId}\n` },
    },
  },
});

const workflowInstanceSendEventTool = defineAutomationWorkflowTool({
  id: "workflow.instances.send-event",
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
      command: "workflow.instances.send-event",
      help: {
        summary: "workflow.instances.send-event sends an event to a durable workflow instance.",
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
          'workflow.instances.send-event --workflow-name exec-codemode-workflow --instance-id run-1 --type continue --payload-json "{}"',
        ],
      },
      parse: parseWorkflowInstanceSendEventArgs,
      format: (result, options) =>
        options.format === "json" ? { data: result } : { stdout: "event sent\n" },
    },
  },
});

const workflowInstanceRetryTool = defineAutomationWorkflowTool({
  id: "workflow.instances.retry",
  namespace: "workflow",
  name: "retryInstance",
  description: "Retry a durable workflow instance from a selected step.",
  inputSchema: z.object({
    workflowName: nonEmptyString,
    instanceId: nonEmptyString,
    stepKey: nonEmptyString.optional(),
    delayMs: z.number().int().nonnegative().optional(),
    reason: nonEmptyString.optional(),
  }),
  outputSchema: workflowRetryInstanceResultSchema,
  execute: async (input, context) => {
    const runtime = getAutomationWorkflowRuntime(context.runtimes.workflow);
    return await getWorkflowRuntimeMethod(runtime, "retryInstance")(input);
  },
  reference: { codemode: { description: "Retry a durable workflow instance step." } },
  adapters: {
    bash: {
      command: "workflow.instances.retry",
      help: {
        summary: "workflow.instances.retry retries a durable workflow instance step.",
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
            name: "step-key",
            valueRequired: true,
            valueName: "key",
            description: "Optional step key to retry; defaults to the latest step.",
          },
          {
            name: "delay-ms",
            valueRequired: true,
            valueName: "ms",
            description: "Optional delay before retry processing in milliseconds.",
          },
          {
            name: "reason",
            valueRequired: true,
            valueName: "text",
            description: "Optional human-readable retry reason.",
          },
        ],
        examples: [
          "workflow.instances.retry --workflow-name automation-codemode-script --instance-id run-1 --step-key do:flaky --format json",
        ],
      },
      parse: parseWorkflowRetryInstanceArgs,
      format: (result, options) =>
        options.format === "json"
          ? { data: result }
          : { stdout: `${result.instance.id}\t${result.retry.stepKey}\tretry scheduled\n` },
    },
  },
});

const workflowListTool = defineAutomationWorkflowTool({
  id: "workflow.list",
  namespace: "workflow",
  name: "listWorkflows",
  description: "List registered durable workflows.",
  inputSchema: z.object({}),
  outputSchema: workflowListResultSchema,
  execute: async (_input, context) => {
    const runtime = getAutomationWorkflowRuntime(context.runtimes.workflow);
    return await getWorkflowRuntimeMethod(runtime, "listWorkflows")();
  },
  adapters: {
    bash: {
      command: "workflow.list",
      help: {
        summary: "workflow.list lists registered durable workflows.",
        options: [],
        examples: ["workflow.list --format json"],
      },
      parse: defineEmptyArgsParser("workflow.list"),
      format: (result, options) =>
        options.format === "json" ? { data: result } : { stdout: formatWorkflowListText(result) },
    },
  },
});

const workflowListInstancesTool = defineAutomationWorkflowTool({
  id: "workflow.instances.list",
  namespace: "workflow",
  name: "listInstances",
  description: "List durable workflow instances.",
  inputSchema: z.object({
    workflowName: nonEmptyString,
    status: workflowInstanceStatusSchema.shape.status.optional(),
    remoteWorkflowName: nonEmptyString.optional(),
    pageSize: z.number().int().positive().optional(),
    cursor: nonEmptyString.optional(),
  }),
  outputSchema: workflowListInstancesResultSchema,
  execute: async (input, context) => {
    const runtime = getAutomationWorkflowRuntime(context.runtimes.workflow);
    return await getWorkflowRuntimeMethod(runtime, "listInstances")(input);
  },
  adapters: {
    bash: {
      command: "workflow.instances.list",
      help: {
        summary: "workflow.instances.list lists instances for a durable workflow.",
        options: [
          {
            name: "workflow-name",
            required: true,
            valueRequired: true,
            valueName: "name",
            description: "Registered workflow name.",
          },
          {
            name: "status",
            valueRequired: true,
            valueName: "status",
            description: "Optional status filter.",
          },
          {
            name: "remote-workflow-name",
            valueRequired: true,
            valueName: "name",
            description: "Optional remote workflow name filter.",
          },
          {
            name: "page-size",
            valueRequired: true,
            valueName: "number",
            description: "Optional page size.",
          },
          {
            name: "cursor",
            valueRequired: true,
            valueName: "cursor",
            description: "Optional pagination cursor.",
          },
        ],
        examples: [
          "workflow.instances.list --workflow-name automation-codemode-script --format json",
        ],
      },
      parse: parseWorkflowListInstancesArgs,
      format: (result, options) =>
        options.format === "json"
          ? { data: result }
          : { stdout: formatWorkflowInstancesText(result) },
    },
  },
});

const workflowGetInstanceTool = defineAutomationWorkflowTool({
  id: "workflow.instances.get",
  namespace: "workflow",
  name: "getInstance",
  description: "Get durable workflow instance details.",
  inputSchema: z.object({ workflowName: nonEmptyString, instanceId: nonEmptyString }),
  outputSchema: workflowInstanceDetailsSchema,
  execute: async (input, context) => {
    const runtime = getAutomationWorkflowRuntime(context.runtimes.workflow);
    return await getWorkflowRuntimeMethod(runtime, "getInstance")(input);
  },
  adapters: {
    bash: {
      command: "workflow.instances.get",
      help: {
        summary: "workflow.instances.get gets durable workflow instance details.",
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
          "workflow.instances.get --workflow-name automation-codemode-script --instance-id run-1 --format json",
        ],
      },
      parse: parseWorkflowGetInstanceArgs("workflow.instances.get"),
      format: (result, options) =>
        options.format === "json"
          ? { data: result }
          : { stdout: `${result.id}\t${formatWorkflowStatusSummary(result.details)}\n` },
    },
  },
});

const workflowHistoryTool = defineAutomationWorkflowTool({
  id: "workflow.instances.history",
  namespace: "workflow",
  name: "getHistory",
  description: "Get durable workflow step, event, and emission history.",
  inputSchema: z.object({ workflowName: nonEmptyString, instanceId: nonEmptyString }),
  outputSchema: workflowHistorySchema,
  execute: async (input, context) => {
    const runtime = getAutomationWorkflowRuntime(context.runtimes.workflow);
    return await getWorkflowRuntimeMethod(runtime, "getHistory")(input);
  },
  adapters: {
    bash: {
      command: "workflow.instances.history",
      help: {
        summary: "workflow.instances.history gets durable workflow history.",
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
          "workflow.instances.history --workflow-name automation-codemode-script --instance-id run-1 --format json",
        ],
      },
      parse: parseWorkflowGetInstanceArgs("workflow.instances.history"),
      format: (result, options) =>
        options.format === "json"
          ? { data: result }
          : {
              stdout: `steps=${result.steps.length}\tevents=${result.events.length}\temissions=${result.emissions.length}\n`,
            },
    },
  },
});

export const automationWorkflowRuntimeTools = [
  workflowListTool,
  workflowInstanceCreateTool,
  workflowListInstancesTool,
  workflowGetInstanceTool,
  workflowHistoryTool,
  workflowInstanceSendEventTool,
  workflowInstanceRetryTool,
] as const;

export const automationWorkflowToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "automations-workflow",
  tools: automationWorkflowRuntimeTools,
  isAvailable: (context: AutomationWorkflowToolContext) => !!context.runtimes.workflow,
});
