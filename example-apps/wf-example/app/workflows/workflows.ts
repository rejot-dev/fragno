import {
  type WorkflowEvent,
  type WorkflowStep,
  defineWorkflow,
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

export const ApprovalWorkflow = defineWorkflow(
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

export const DemoDataWorkflow = defineWorkflow(
  { name: "demo-data-workflow" },
  async (_event: WorkflowEvent<unknown>, step: WorkflowStep) => {
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
  },
);

export const ParallelStepsWorkflow = defineWorkflow(
  { name: "parallel-steps-workflow" },
  async (_event: WorkflowEvent<unknown>, step: WorkflowStep) => {
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
  },
);

export const WaitTimeoutWorkflow = defineWorkflow(
  { name: "wait-timeout-workflow" },
  async (_event: WorkflowEvent<unknown>, step: WorkflowStep) => {
    const startedAt = await step.do("record-start", () => Date.now());
    const edge = await step.waitForEvent("edge-wait", {
      type: "edge",
      timeout: "2 s",
    });

    return {
      startedAt,
      edge,
    };
  },
);

export const CrashTestWorkflow = defineWorkflow(
  { name: "crash-test-workflow" },
  async (_event: WorkflowEvent<unknown>, step: WorkflowStep) => {
    const startedAt = await step.do("record-start", () => Date.now());
    const slowStep = await step.do("slow-step", async () => {
      await new Promise((resolve) => setTimeout(resolve, 15_000));
      return { finishedAt: Date.now() };
    });
    const finishedAt = await step.do("record-finish", () => Date.now());

    return {
      startedAt,
      slowStep,
      finishedAt,
    };
  },
);

export const workflows = {
  approval: ApprovalWorkflow,
  demoData: DemoDataWorkflow,
  parallel: ParallelStepsWorkflow,
  waitTimeout: WaitTimeoutWorkflow,
  crashTest: CrashTestWorkflow,
} as const;
