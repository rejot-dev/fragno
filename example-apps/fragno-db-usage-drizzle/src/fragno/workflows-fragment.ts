import { defaultFragnoRuntime, instantiate } from "@fragno-dev/core";
import { type DatabaseAdapter } from "@fragno-dev/db";
import { createDurableHooksProcessor } from "@fragno-dev/db/dispatchers/node";
import {
  createWorkflowsRunner,
  workflowsFragmentDefinition,
  workflowsRoutesFactory,
  type WorkflowsFragmentConfig,
  type WorkflowEvent,
  type WorkflowStep,
  defineWorkflow,
} from "@fragno-dev/workflows";
import { adapter } from "../fragno-adapter";

export type ApprovalParams = {
  requestId: string;
  amount: number;
  requestedBy: string;
};

export type ApprovalEventPayload = {
  approved: boolean;
  approver: string;
  note?: string;
};

export type FulfillmentEventPayload = {
  confirmationId: string;
};

const ApprovalWorkflow = defineWorkflow(
  { name: "approval-workflow" },
  async (event: WorkflowEvent<ApprovalParams>, step: WorkflowStep) => {
    const approval = await step.waitForEvent<ApprovalEventPayload>("approval", {
      type: "approval",
      timeout: "15 min",
    });

    await step.sleep("cooldown", "2 s");

    const fulfillment = await step.waitForEvent<FulfillmentEventPayload>("fulfillment", {
      type: "fulfillment",
      timeout: "15 min",
    });

    return {
      request: event.payload,
      approval,
      fulfillment,
    };
  },
);

const workflows = {
  approval: ApprovalWorkflow,
} as const;

// oxlint-disable-next-line no-explicit-any
export function createWorkflowsFragmentServer(a: DatabaseAdapter<any>) {
  const runtime = defaultFragnoRuntime;
  let runner: ReturnType<typeof createWorkflowsRunner> | null = null;

  const config: WorkflowsFragmentConfig = {
    workflows,
    runtime,
  };
  const fragment = instantiate(workflowsFragmentDefinition)
    .withConfig(config)
    .withRoutes([workflowsRoutesFactory])
    .withOptions({ databaseAdapter: a })
    .build();

  runner = createWorkflowsRunner({ fragment, workflows, runtime });
  config.runner = runner;
  const dispatcher = createDurableHooksProcessor([fragment], {
    pollIntervalMs: 2000,
    onError: (error) => {
      console.error("Workflows durable hooks dispatcher failed", error);
    },
  });

  return { fragment, dispatcher };
}

export const { fragment, dispatcher } = createWorkflowsFragmentServer(adapter);
