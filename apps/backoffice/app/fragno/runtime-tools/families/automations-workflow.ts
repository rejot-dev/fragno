import { z } from "zod";

import { defineCliArgsParser } from "@/fragno/runtime-tools/bash-cli";

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
  path: string;
  instanceId: string;
  payload?: Record<string, unknown>;
};

export type WorkflowCreateInstanceResult = {
  instanceId: string;
};

export type WorkflowGetStatusArgs = {
  instanceId: string;
};

export type WorkflowRetryInstanceArgs = {
  instanceId: string;
  stepKey?: string;
  delayMs?: number;
  reason?: string;
};

export type WorkflowSendEventArgs = {
  instanceId: string;
  type: string;
  payload?: unknown;
};

export type WorkflowListInstancesArgs = {
  status?: WorkflowInstanceStatus["status"];
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
  meta: {
    name: string;
    path: string;
    createdAt: string | Date;
    updatedAt: string | Date;
    startedAt: string | Date | null;
    completedAt: string | Date | null;
  };
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

export type InternalWorkflowCreateInstanceArgs = {
  workflowName: string;
  remoteWorkflowName?: string;
  instanceId?: string;
  params?: unknown;
};

export type InternalWorkflowInstanceArgs = {
  workflowName: string;
  instanceId: string;
};

export type InternalWorkflowListInstancesArgs = WorkflowListInstancesArgs & {
  workflowName: string;
  remoteWorkflowName?: string;
};

export type InternalWorkflowRetryInstanceArgs = WorkflowRetryInstanceArgs & {
  workflowName: string;
};

export type InternalWorkflowSendEventArgs = WorkflowSendEventArgs & {
  workflowName: string;
};

export type InternalAutomationWorkflowRuntime = {
  createInternalInstance: (
    input: InternalWorkflowCreateInstanceArgs,
  ) => Promise<{ workflowName: string; instanceId: string }>;
  getInternalStatus: (input: InternalWorkflowInstanceArgs) => Promise<WorkflowInstanceStatus>;
  sendInternalEvent: (input: InternalWorkflowSendEventArgs) => Promise<unknown>;
  listInternalWorkflows: () => Promise<{ workflows: Array<{ name: string }> }>;
  listInternalInstances: (
    input: InternalWorkflowListInstancesArgs,
  ) => Promise<WorkflowListInstancesResult>;
  getInternalInstance: (input: InternalWorkflowInstanceArgs) => Promise<{
    id: string;
    details: WorkflowInstanceStatus;
    meta: Record<string, unknown>;
  }>;
  retryInternalInstance: (
    input: InternalWorkflowRetryInstanceArgs,
  ) => Promise<WorkflowRetryInstanceResult>;
  getInternalHistory: (input: InternalWorkflowInstanceArgs) => Promise<WorkflowHistory>;
};

/** Hostless workflow operations exposed to runtime tools and agents. */
export type AutomationWorkflowRuntime = {
  createInstance: (input: WorkflowCreateInstanceArgs) => Promise<WorkflowCreateInstanceResult>;
  listInstances: (input: WorkflowListInstancesArgs) => Promise<WorkflowListInstancesResult>;
  getInstance: (input: WorkflowGetInstanceArgs) => Promise<WorkflowInstanceDetails>;
  retryInstance: (input: WorkflowRetryInstanceArgs) => Promise<WorkflowRetryInstanceResult>;
  sendEvent: (input: WorkflowSendEventArgs) => Promise<unknown>;
  getHistory: (input: WorkflowGetInstanceArgs) => Promise<WorkflowHistory>;
};

type AutomationWorkflowToolContext = BackofficeToolContext<{
  workflow?: AutomationWorkflowRuntime;
}>;

const workflowInstanceStatusSchema = z.object({
  status: z.enum(["active", "paused", "errored", "terminated", "complete", "waiting"]),
  error: z.object({ name: z.string(), message: z.string() }).optional(),
  output: z.unknown().optional(),
});

const workflowCreateInstanceResultSchema = z.object({
  instanceId: z.string().trim().min(1),
});

const workflowListInstancesResultSchema = z.object({
  instances: z.array(
    z.object({
      id: z.string().trim().min(1),
      details: workflowInstanceStatusSchema,
      createdAt: z.union([z.string(), z.date()]),
    }),
  ),
  nextCursor: z.string().optional(),
  hasNextPage: z.boolean(),
});

const workflowInstanceDetailsSchema = z.object({
  id: z.string().trim().min(1),
  details: workflowInstanceStatusSchema,
  meta: z.object({
    name: z.string().trim().min(1),
    path: z.string().trim().min(1),
    createdAt: z.union([z.string(), z.date()]),
    updatedAt: z.union([z.string(), z.date()]),
    startedAt: z.union([z.string(), z.date()]).nullable(),
    completedAt: z.union([z.string(), z.date()]).nullable(),
  }),
});

const workflowRetryInstanceResultSchema = z.object({
  accepted: z.literal(true),
  instance: z.object({
    id: z.string().trim().min(1),
    details: workflowInstanceStatusSchema,
  }),
  retry: z.object({
    stepKey: z.string().trim().min(1),
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

const parseWorkflowCreateInstanceArgs = defineCliArgsParser<WorkflowCreateInstanceArgs>(
  "workflow.instances.create",
  {
    path: { required: true },
    instanceId: { required: true },
    payload: { kind: "json", option: "payload-json" },
  },
);

const parseWorkflowListInstancesArgs = defineCliArgsParser<WorkflowListInstancesArgs>(
  "workflow.instances.list",
  {
    status: {},
    pageSize: { kind: "positiveInteger" },
    cursor: {},
  },
);

const parseWorkflowGetInstanceArgs = (command: string) =>
  defineCliArgsParser<WorkflowGetInstanceArgs>(command, {
    instanceId: { required: true },
  });

const formatWorkflowStatusSummary = (status: WorkflowInstanceStatus) =>
  status.error ? `${status.status} (${status.error.name}: ${status.error.message})` : status.status;

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
    instanceId: { required: true },
    type: { required: true },
    payload: { kind: "json", option: "payload-json" },
  },
);

const parseWorkflowRetryInstanceArgs = defineCliArgsParser<WorkflowRetryInstanceArgs>(
  "workflow.instances.retry",
  {
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
  description: "Start a saved durable workflow from its source path.",
  requiredPermissions: ["modify"],
  inputSchema: z.strictObject({
    path: z.string().trim().min(1),
    instanceId: z.string().trim().min(1),
    payload: z.record(z.string(), z.unknown()).optional(),
  }),
  outputSchema: workflowCreateInstanceResultSchema,
  execute: async (input, context) =>
    await getAutomationWorkflowRuntime(context.runtimes.workflow).createInstance(input),
  reference: {
    codemode: {
      description:
        "Start a saved .workflow.js file by path. Inline defineWorkflow declarations start automatically.",
    },
  },
  adapters: {
    bash: {
      command: "workflow.instances.create",
      help: {
        summary: "workflow.instances.create starts a saved workflow file by path.",
        options: [
          {
            name: "path",
            required: true,
            valueRequired: true,
            valueName: "path",
            description: "Saved .workflow.js path under an automation root.",
          },
          {
            name: "instance-id",
            required: true,
            valueRequired: true,
            valueName: "id",
            description: "Stable workflow instance id to reuse across isolated calls.",
          },
          {
            name: "payload-json",
            valueRequired: true,
            valueName: "json",
            description:
              "Optional domain payload delivered directly to the authored workflow event.",
          },
        ],
        examples: [
          'workflow.instances.create --path /workspace/automations/example.workflow.js --instance-id run-1 --payload-json "{}"',
        ],
      },
      parse: parseWorkflowCreateInstanceArgs,
      format: (result, options) =>
        options.format === "json" ? { data: result } : { stdout: `${result.instanceId}\n` },
    },
  },
});

const workflowInstanceSendEventTool = defineAutomationWorkflowTool({
  id: "workflow.instances.send-event",
  namespace: "workflow",
  name: "sendEvent",
  description: "Send an event to a durable workflow instance.",
  requiredPermissions: ["modify"],
  inputSchema: z.strictObject({
    instanceId: z.string().trim().min(1),
    type: z.string().trim().min(1),
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
          'workflow.instances.send-event --instance-id run-1 --type continue --payload-json "{}"',
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
  requiredPermissions: ["modify"],
  inputSchema: z.strictObject({
    instanceId: z.string().trim().min(1),
    stepKey: z.string().trim().min(1).optional(),
    delayMs: z.number().int().nonnegative().optional(),
    reason: z.string().trim().min(1).optional(),
  }),
  outputSchema: workflowRetryInstanceResultSchema,
  execute: async (input, context) => {
    return await getAutomationWorkflowRuntime(context.runtimes.workflow).retryInstance(input);
  },
  reference: { codemode: { description: "Retry a durable workflow instance step." } },
  adapters: {
    bash: {
      command: "workflow.instances.retry",
      help: {
        summary: "workflow.instances.retry retries a durable workflow instance step.",
        options: [
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
          "workflow.instances.retry --instance-id run-1 --step-key do:flaky --format json",
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

const workflowListInstancesTool = defineAutomationWorkflowTool({
  id: "workflow.instances.list",
  namespace: "workflow",
  name: "listInstances",
  description: "List durable saved-workflow instances.",
  requiredPermissions: ["read"],
  inputSchema: z.strictObject({
    status: workflowInstanceStatusSchema.shape.status.optional(),
    pageSize: z.number().int().positive().optional(),
    cursor: z.string().trim().min(1).optional(),
  }),
  outputSchema: workflowListInstancesResultSchema,
  execute: async (input, context) => {
    return await getAutomationWorkflowRuntime(context.runtimes.workflow).listInstances(input);
  },
  adapters: {
    bash: {
      command: "workflow.instances.list",
      help: {
        summary: "workflow.instances.list lists durable saved-workflow instances.",
        options: [
          {
            name: "status",
            valueRequired: true,
            valueName: "status",
            description: "Optional status filter.",
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
        examples: ["workflow.instances.list --format json"],
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
  requiredPermissions: ["read"],
  inputSchema: z.strictObject({
    instanceId: z.string().trim().min(1),
  }),
  outputSchema: workflowInstanceDetailsSchema,
  execute: async (input, context) => {
    return await getAutomationWorkflowRuntime(context.runtimes.workflow).getInstance(input);
  },
  adapters: {
    bash: {
      command: "workflow.instances.get",
      help: {
        summary: "workflow.instances.get gets durable workflow instance details.",
        options: [
          {
            name: "instance-id",
            required: true,
            valueRequired: true,
            valueName: "id",
            description: "Workflow instance id.",
          },
        ],
        examples: ["workflow.instances.get --instance-id run-1 --format json"],
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
  requiredPermissions: ["read"],
  inputSchema: z.strictObject({
    instanceId: z.string().trim().min(1),
  }),
  outputSchema: workflowHistorySchema,
  execute: async (input, context) => {
    return await getAutomationWorkflowRuntime(context.runtimes.workflow).getHistory(input);
  },
  adapters: {
    bash: {
      command: "workflow.instances.history",
      help: {
        summary: "workflow.instances.history gets durable workflow history.",
        options: [
          {
            name: "instance-id",
            required: true,
            valueRequired: true,
            valueName: "id",
            description: "Workflow instance id.",
          },
        ],
        examples: ["workflow.instances.history --instance-id run-1 --format json"],
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
  workflowInstanceCreateTool,
  workflowListInstancesTool,
  workflowGetInstanceTool,
  workflowHistoryTool,
  workflowInstanceSendEventTool,
  workflowInstanceRetryTool,
] as const;

export const automationWorkflowToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "automations-workflow",
  permissions: {
    read: "Read durable workflow instances and history.",
    modify: "Create, signal, and retry durable workflow instances.",
  },
  tools: automationWorkflowRuntimeTools,
  isAvailable: (context: AutomationWorkflowToolContext) => Boolean(context.runtimes.workflow),
});
