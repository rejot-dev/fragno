import { describe, expect, it } from "vitest";
import {
  ModelCheckerAdapter,
  runModelCheckerWithActors,
  type ModelCheckerInvariant,
} from "@fragno-dev/test";
import type { SimpleQueryInterface } from "@fragno-dev/db/query";
import type { UnitOfWorkConfig } from "@fragno-dev/db/unit-of-work";
import { workflowsSchema } from "./schema";
import {
  defineWorkflow,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowsRegistry,
} from "./workflow";
import {
  createWorkflowsTestHarness,
  createWorkflowsTestRuntime,
  type WorkflowsTestHarness,
} from "./test";

const createContextFactory =
  (workflows: WorkflowsRegistry, idSeed: string) =>
  async (): Promise<{
    adapter: ModelCheckerAdapter<UnitOfWorkConfig>;
    ctx: WorkflowsTestHarness;
    queryEngine: SimpleQueryInterface<typeof workflowsSchema, UnitOfWorkConfig>;
    cleanup: () => Promise<void>;
  }> => {
    const runtime = createWorkflowsTestRuntime({
      startAt: new Date("2025-01-01T00:00:00.000Z"),
    });
    const harness = await createWorkflowsTestHarness({
      workflows,
      adapter: { type: "model-checker", options: { idSeed } },
      runtime,
      autoTickHooks: false,
    });

    return {
      adapter: harness.test.adapter as ModelCheckerAdapter<UnitOfWorkConfig>,
      ctx: harness,
      queryEngine: harness.db as SimpleQueryInterface<typeof workflowsSchema, UnitOfWorkConfig>,
      cleanup: harness.test.cleanup,
    };
  };

describe("Workflows model checker examples", () => {
  it("checks event delivery interleavings", async () => {
    const EventWorkflow = defineWorkflow(
      { name: "event-workflow" },
      async (_event: WorkflowEvent<unknown>, step: WorkflowStep) => {
        const received = await step.waitForEvent("wait-ready", {
          type: "ready",
          timeout: "1 hour",
        });
        return { received };
      },
    );

    const workflows: WorkflowsRegistry = {
      EVENT: EventWorkflow,
    };

    const invariant: ModelCheckerInvariant<
      typeof workflowsSchema,
      UnitOfWorkConfig,
      WorkflowsTestHarness
    > = async ({ queryEngine }) => {
      const events = await queryEngine.find("workflow_event", (b) => b.whereIndex("primary"));
      const delivered = events.filter(
        (event) =>
          event.workflowName === "event-workflow" &&
          event.instanceId === "evt-1" &&
          event.runNumber === 0 &&
          event.type === "ready" &&
          event.deliveredAt !== null,
      );
      if (delivered.length > 1) {
        throw new Error("Event delivered more than once");
      }

      const steps = await queryEngine.find("workflow_step", (b) => b.whereIndex("primary"));
      const waitSteps = steps.filter(
        (step) =>
          step.workflowName === "event-workflow" &&
          step.instanceId === "evt-1" &&
          step.runNumber === 0 &&
          step.stepKey === "wait-ready",
      );
      if (waitSteps.length > 1) {
        throw new Error("Wait step recorded more than once");
      }

      const instance = await queryEngine.findFirst("workflow_instance", (b) =>
        b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
          eb.and(eb("workflowName", "=", "event-workflow"), eb("instanceId", "=", "evt-1")),
        ),
      );
      if (instance?.status === "complete") {
        const output = instance.output as { received?: { payload?: { ok?: boolean } } } | null;
        if (!output?.received?.payload?.ok) {
          throw new Error("Completed event workflow missing payload");
        }
      }
    };

    const result = await runModelCheckerWithActors<
      typeof workflowsSchema,
      UnitOfWorkConfig,
      WorkflowsTestHarness
    >({
      schema: workflowsSchema,
      mode: "random",
      seed: 11,
      maxSchedules: 20,
      history: false,
      createContext: createContextFactory(workflows, "event-model-checker"),
      setup: async (harness) => {
        await harness.createInstance("EVENT", { id: "evt-1" });
      },
      buildActors: (harness) => [
        {
          name: "send-event",
          run: async () => {
            await harness.sendEvent("EVENT", "evt-1", {
              type: "ready",
              payload: { ok: true },
            });
          },
        },
        {
          name: "runner-a",
          run: async () => {
            await harness.tick({ maxInstances: 1, maxSteps: 5 });
          },
        },
        {
          name: "runner-b",
          run: async () => {
            await harness.tick({ maxInstances: 1, maxSteps: 5 });
          },
        },
      ],
      invariants: [invariant],
    });

    expect(result.schedules.length).toBeGreaterThan(0);
  });

  it("checks retry steps across interleavings", async () => {
    let retryCalls = 0;

    const RetryWorkflow = defineWorkflow(
      { name: "retry-workflow" },
      async (_event: WorkflowEvent<unknown>, step: WorkflowStep) => {
        return await step.do(
          "retry-step",
          { retries: { limit: 1, delay: "0 ms", backoff: "constant" } },
          () => {
            retryCalls += 1;
            if (retryCalls === 1) {
              throw new Error("RETRY_ME");
            }
            return { ok: true };
          },
        );
      },
    );

    const workflows: WorkflowsRegistry = {
      RETRY: RetryWorkflow,
    };

    const invariant: ModelCheckerInvariant<
      typeof workflowsSchema,
      UnitOfWorkConfig,
      WorkflowsTestHarness
    > = async ({ queryEngine }) => {
      const steps = await queryEngine.find("workflow_step", (b) => b.whereIndex("primary"));
      const retrySteps = steps.filter(
        (step) =>
          step.workflowName === "retry-workflow" &&
          step.instanceId === "retry-1" &&
          step.runNumber === 0 &&
          step.stepKey === "retry-step",
      );
      for (const step of retrySteps) {
        if (step.attempts > step.maxAttempts) {
          throw new Error("Retry attempts exceeded maxAttempts");
        }
      }
    };

    const result = await runModelCheckerWithActors<
      typeof workflowsSchema,
      UnitOfWorkConfig,
      WorkflowsTestHarness
    >({
      schema: workflowsSchema,
      mode: "random",
      seed: 9,
      maxSchedules: 20,
      history: false,
      createContext: async () => {
        retryCalls = 0;
        return createContextFactory(workflows, "retry-model-checker")();
      },
      setup: async (harness) => {
        await harness.createInstance("RETRY", { id: "retry-1" });
      },
      buildActors: (harness) => [
        {
          name: "runner-a",
          run: async () => {
            await harness.tick({ maxInstances: 1, maxSteps: 5 });
          },
        },
        {
          name: "runner-b",
          run: async () => {
            await harness.tick({ maxInstances: 1, maxSteps: 5 });
          },
        },
      ],
      invariants: [invariant],
    });

    expect(result.schedules.length).toBeGreaterThan(0);
  });

  it("checks timeout + error interleavings", async () => {
    const TimeoutWorkflow = defineWorkflow(
      { name: "timeout-workflow" },
      async (_event: WorkflowEvent<unknown>, step: WorkflowStep) => {
        return await step.waitForEvent("wait-timeout", { type: "timeout", timeout: "1 s" });
      },
    );

    const workflows: WorkflowsRegistry = {
      TIMEOUT: TimeoutWorkflow,
    };

    const invariant: ModelCheckerInvariant<
      typeof workflowsSchema,
      UnitOfWorkConfig,
      WorkflowsTestHarness
    > = async ({ queryEngine }) => {
      const instance = await queryEngine.findFirst("workflow_instance", (b) =>
        b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
          eb.and(eb("workflowName", "=", "timeout-workflow"), eb("instanceId", "=", "timeout-1")),
        ),
      );

      if (instance?.status === "errored") {
        if (!instance.errorName || !instance.errorMessage) {
          throw new Error("Timeout error missing details");
        }
      }
    };

    const result = await runModelCheckerWithActors<
      typeof workflowsSchema,
      UnitOfWorkConfig,
      WorkflowsTestHarness
    >({
      schema: workflowsSchema,
      mode: "random",
      seed: 3,
      maxSchedules: 20,
      history: false,
      createContext: createContextFactory(workflows, "timeout-model-checker"),
      setup: async (harness) => {
        await harness.createInstance("TIMEOUT", { id: "timeout-1" });
      },
      buildActors: (harness) => [
        {
          name: "runner-a",
          run: async () => {
            await harness.tick({ maxInstances: 1, maxSteps: 5 });
          },
        },
        {
          name: "advance-time",
          run: () => {
            harness.clock.advanceBy("2 s");
          },
        },
        {
          name: "runner-b",
          run: async () => {
            await harness.tick({ maxInstances: 1, maxSteps: 5 });
          },
        },
      ],
      invariants: [invariant],
    });

    expect(result.schedules.length).toBeGreaterThan(0);
  });

  it("checks child workflow creation interleavings", async () => {
    const ChildWorkflow = defineWorkflow(
      { name: "child-workflow" },
      async (event: WorkflowEvent<{ parentId: string }>, step: WorkflowStep) => {
        return await step.do("child-run", () => ({ parentId: event.payload.parentId }));
      },
    );

    const ParentWorkflow = defineWorkflow(
      { name: "parent-workflow" },
      async (event: WorkflowEvent<{ label: string }>, step: WorkflowStep, context) => {
        return await step.do("spawn-child", async () => {
          const child = await context.workflows["child"].create({
            id: `child-${event.instanceId}`,
            params: { parentId: event.instanceId },
          });
          return { childId: child.id, label: event.payload.label };
        });
      },
    );

    const workflows: WorkflowsRegistry = {
      child: ChildWorkflow,
      parent: ParentWorkflow,
    };

    const invariant: ModelCheckerInvariant<
      typeof workflowsSchema,
      UnitOfWorkConfig,
      WorkflowsTestHarness
    > = async ({ queryEngine }) => {
      const instances = await queryEngine.find("workflow_instance", (b) => b.whereIndex("primary"));
      const childInstances = instances.filter(
        (instance) =>
          instance.workflowName === "child-workflow" &&
          instance.instanceId === "child-parent-1" &&
          instance.runNumber === 0,
      );
      if (childInstances.length > 1) {
        throw new Error("Child workflow created more than once");
      }
    };

    const result = await runModelCheckerWithActors<
      typeof workflowsSchema,
      UnitOfWorkConfig,
      WorkflowsTestHarness
    >({
      schema: workflowsSchema,
      mode: "random",
      seed: 5,
      maxSchedules: 20,
      history: false,
      createContext: createContextFactory(workflows, "child-model-checker"),
      setup: async (harness) => {
        await harness.createInstance("parent", { id: "parent-1", params: { label: "root" } });
      },
      buildActors: (harness) => [
        {
          name: "runner-a",
          run: async () => {
            await harness.tick({ maxInstances: 1, maxSteps: 5 });
          },
        },
        {
          name: "runner-b",
          run: async () => {
            await harness.tick({ maxInstances: 1, maxSteps: 5 });
          },
        },
      ],
      invariants: [invariant],
    });

    expect(result.schedules.length).toBeGreaterThan(0);
  });
});
