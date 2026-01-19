import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "@fragno-dev/fragment-workflows";

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

export class ApprovalWorkflow extends WorkflowEntrypoint<unknown, ApprovalParams> {
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

export class DemoDataWorkflow extends WorkflowEntrypoint {
  async run(_event: WorkflowEvent<unknown>, step: WorkflowStep) {
    const randomValue = await step.do("random-number", () => Math.floor(Math.random() * 1000));

    const remoteData = await step.do("fetch-remote", async () => {
      const response = await fetch("https://jsonplaceholder.typicode.com/todos/1");
      if (!response.ok) {
        throw new Error(`REMOTE_FETCH_FAILED_${response.status}`);
      }
      return (await response.json()) as unknown;
    });

    const flakyResult = await step.do(
      "flaky-step",
      { retries: { limit: 3, delay: "500 ms", backoff: "constant" } },
      () => {
        const roll = Math.random();
        if (roll > 0.25) {
          throw new Error("FLAKY_RANDOM_FAILURE");
        }
        return { ok: true, roll };
      },
    );

    return {
      randomValue,
      remoteData,
      flakyResult,
    };
  }
}

export class ParallelStepsWorkflow extends WorkflowEntrypoint {
  async run(_event: WorkflowEvent<unknown>, step: WorkflowStep) {
    const startedAt = await step.do("record-start", () => Date.now());
    const [todo, user] = await Promise.all([
      step.do(
        "fetch-todo",
        { retries: { limit: 6, delay: "2 s", backoff: "constant" } },
        async () => {
          const readyAt = startedAt + 10_000;
          if (Date.now() < readyAt) {
            throw new Error("TODO_FETCH_NOT_READY");
          }
          await new Promise((resolve) => setTimeout(resolve, 750));
          const response = await fetch("https://jsonplaceholder.typicode.com/todos/2");
          if (!response.ok) {
            throw new Error(`REMOTE_FETCH_FAILED_${response.status}`);
          }
          return (await response.json()) as unknown;
        },
      ),
      step.do(
        "fetch-user",
        { retries: { limit: 4, delay: "400 ms", backoff: "constant" } },
        async () => {
          if (Math.random() > 0.35) {
            throw new Error("FLAKY_USER_FETCH");
          }
          const response = await fetch("https://jsonplaceholder.typicode.com/users/2");
          if (!response.ok) {
            throw new Error(`REMOTE_FETCH_FAILED_${response.status}`);
          }
          return (await response.json()) as unknown;
        },
      ),
    ]);

    return {
      todo,
      user,
    };
  }
}

export const workflows = {
  approval: { name: "approval-workflow", workflow: ApprovalWorkflow },
  demoData: { name: "demo-data-workflow", workflow: DemoDataWorkflow },
  parallel: { name: "parallel-steps-workflow", workflow: ParallelStepsWorkflow },
} as const;
