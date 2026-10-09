import { z } from "zod";

import { defineCliArgsParser } from "@/fragno/runtime-tools/bash-cli";

import {
  backofficeApiOperationToolFields,
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
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

export type WorkflowRetryFailedStepArgs = {
  instanceId: string;
  delayMs?: number;
};

export type WorkflowSendEventArgs = {
  instanceId: string;
  type: string;
  payload?: unknown;
};

export type WorkflowSendEventResult = {
  accepted: true;
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

export type WorkflowRetryFailedStepResult = {
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

export type InternalWorkflowRetryFailedStepArgs = WorkflowRetryFailedStepArgs & {
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
  sendInternalEvent: (input: InternalWorkflowSendEventArgs) => Promise<WorkflowSendEventResult>;
  listInternalWorkflows: () => Promise<{ workflows: Array<{ name: string }> }>;
  listInternalInstances: (
    input: InternalWorkflowListInstancesArgs,
  ) => Promise<WorkflowListInstancesResult>;
  getInternalInstance: (input: InternalWorkflowInstanceArgs) => Promise<{
    id: string;
    details: WorkflowInstanceStatus;
    meta: Record<string, unknown>;
  }>;
  retryFailedInternalStep: (
    input: InternalWorkflowRetryFailedStepArgs,
  ) => Promise<WorkflowRetryFailedStepResult>;
  getInternalHistory: (input: InternalWorkflowInstanceArgs) => Promise<WorkflowHistory>;
};

/** Hostless workflow operations exposed to runtime tools and agents. */
export type AutomationWorkflowRuntime = {
  createInstance: (input: WorkflowCreateInstanceArgs) => Promise<WorkflowCreateInstanceResult>;
  listInstances: (input: WorkflowListInstancesArgs) => Promise<WorkflowListInstancesResult>;
  getInstance: (input: WorkflowGetInstanceArgs) => Promise<WorkflowInstanceDetails>;
  retryFailedStep: (input: WorkflowRetryFailedStepArgs) => Promise<WorkflowRetryFailedStepResult>;
  sendEvent: (input: WorkflowSendEventArgs) => Promise<WorkflowSendEventResult>;
  getHistory: (input: WorkflowGetInstanceArgs) => Promise<WorkflowHistory>;
};

type AutomationWorkflowToolContext = BackofficeToolContext<{
  workflow?: AutomationWorkflowRuntime;
}>;

const defineAutomationWorkflowTool = <
  TInputSchema extends z.ZodType,
  TOutputSchema extends z.ZodType,
>(
  tool: Parameters<
    typeof defineBackofficeRuntimeTool<TInputSchema, TOutputSchema, AutomationWorkflowToolContext>
  >[0],
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

const parseWorkflowRetryFailedStepArgs = defineCliArgsParser<WorkflowRetryFailedStepArgs>(
  "workflow.instances.retry-failed-step",
  {
    instanceId: { required: true },
    delayMs: { kind: "nonNegativeInteger" },
  },
);

const workflowInstanceCreateTool = defineAutomationWorkflowTool({
  ...backofficeApiOperationToolFields("workflow.instances.create"),
  namespace: "workflow",
  name: "createInstance",
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
  ...backofficeApiOperationToolFields("workflow.instances.send-event"),
  namespace: "workflow",
  name: "sendEvent",
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

const workflowRetryFailedStepTool = defineAutomationWorkflowTool({
  ...backofficeApiOperationToolFields("workflow.instances.retry-failed-step"),
  namespace: "workflow",
  name: "retryFailedStep",
  execute: async (input, context) => {
    return await getAutomationWorkflowRuntime(context.runtimes.workflow).retryFailedStep(input);
  },
  reference: {
    codemode: { description: "Retry an errored instance's failed top-level step." },
  },
  adapters: {
    bash: {
      command: "workflow.instances.retry-failed-step",
      help: {
        summary:
          "workflow.instances.retry-failed-step retries an errored instance's failed top-level step.",
        options: [
          {
            name: "instance-id",
            required: true,
            valueRequired: true,
            valueName: "id",
            description: "Workflow instance id.",
          },
          {
            name: "delay-ms",
            valueRequired: true,
            valueName: "ms",
            description: "Optional delay before retry processing in milliseconds.",
          },
        ],
        examples: ["workflow.instances.retry-failed-step --instance-id run-1 --format json"],
      },
      parse: parseWorkflowRetryFailedStepArgs,
      format: (result, options) =>
        options.format === "json"
          ? { data: result }
          : { stdout: `${result.instance.id}\t${result.retry.stepKey}\tretry scheduled\n` },
    },
  },
});

const workflowListInstancesTool = defineAutomationWorkflowTool({
  ...backofficeApiOperationToolFields("workflow.instances.list"),
  namespace: "workflow",
  name: "listInstances",
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
  ...backofficeApiOperationToolFields("workflow.instances.get"),
  namespace: "workflow",
  name: "getInstance",
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
  ...backofficeApiOperationToolFields("workflow.instances.history"),
  namespace: "workflow",
  name: "getHistory",
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
  workflowRetryFailedStepTool,
] as const;

export const automationWorkflowToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "automations-workflow",
  tools: automationWorkflowRuntimeTools,
  isAvailable: (context: AutomationWorkflowToolContext) => Boolean(context.runtimes.workflow),
});
