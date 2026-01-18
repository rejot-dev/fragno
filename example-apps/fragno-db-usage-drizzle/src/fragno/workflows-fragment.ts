import { instantiate } from "@fragno-dev/core";
import type { DatabaseAdapter } from "@fragno-dev/db";
import {
  createWorkflowsRunner,
  workflowsFragmentDefinition,
  workflowsRoutesFactory,
  workflowsSchema,
  WorkflowEntrypoint,
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
  const db = a.createQueryEngine(workflowsSchema, "workflows");
  const runner = createWorkflowsRunner({ db, workflows });
  const dispatcher = createInProcessDispatcher({
    wake: () => {
      void runner.tick({ maxInstances: 5, maxSteps: 50 });
    },
    pollIntervalMs: 2000,
  });

  const fragment = instantiate(workflowsFragmentDefinition)
    .withConfig({ workflows, runner, dispatcher, enableRunnerTick: true })
    .withRoutes([workflowsRoutesFactory])
    .withOptions({ databaseAdapter: a })
    .build();

  return { fragment, dispatcher };
}

const runtime = createWorkflowsFragmentServer(adapter);
export const fragment = runtime.fragment;
export const dispatcher = runtime.dispatcher;
