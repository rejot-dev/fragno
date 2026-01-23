import { defaultFragnoRuntime, instantiate } from "@fragno-dev/core";
import type { DatabaseAdapter } from "@fragno-dev/db";
import {
  createWorkflowsRunner,
  workflowsFragmentDefinition,
  workflowsRoutesFactory,
  WorkflowEntrypoint,
  type WorkflowsFragmentConfig,
  type WorkflowEvent,
  type WorkflowStep,
} from "@fragno-dev/fragment-workflows";
import { createInProcessDispatcher } from "@fragno-dev/workflows-dispatcher-node";
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

class ApprovalWorkflow extends WorkflowEntrypoint<unknown, ApprovalParams> {
  async run(event: WorkflowEvent<ApprovalParams>, step: WorkflowStep) {
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
  }
}

const workflows = {
  approval: { name: "approval-workflow", workflow: ApprovalWorkflow },
} as const;

// oxlint-disable-next-line no-explicit-any
export function createWorkflowsFragmentServer(a: DatabaseAdapter<any>) {
  const runtime = defaultFragnoRuntime;
  let runner: ReturnType<typeof createWorkflowsRunner> | null = null;
  const dispatcher = createInProcessDispatcher({
    wake: () => {
      if (!runner) {
        return;
      }
      Promise.resolve(runner.tick({ maxInstances: 5, maxSteps: 50 })).catch((error: unknown) => {
        console.error("Workflows runner tick failed", error);
      });
    },
    pollIntervalMs: 2000,
  });

  const config: WorkflowsFragmentConfig = {
    workflows,
    dispatcher,
    enableRunnerTick: true,
    runtime,
  };
  const fragment = instantiate(workflowsFragmentDefinition)
    .withConfig(config)
    .withRoutes([workflowsRoutesFactory])
    .withOptions({ databaseAdapter: a })
    .build();

  runner = createWorkflowsRunner({ fragment, workflows, runtime });
  config.runner = runner;

  return { fragment, dispatcher };
}

export const { fragment, dispatcher } = createWorkflowsFragmentServer(adapter);
