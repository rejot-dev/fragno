import { describe, expect, it } from "vitest";
import {
  ModelCheckerAdapter,
  runModelCheckerWithActors,
  type ModelCheckerInvariant,
} from "@fragno-dev/test";
import type { SimpleQueryInterface } from "@fragno-dev/db/query";
import type { UnitOfWorkConfig } from "@fragno-dev/db/unit-of-work";
import { workflowsSchema } from "./schema";
import { defineWorkflow, type WorkflowEvent, type WorkflowStep } from "./workflow";
import { createWorkflowsTestHarness, createWorkflowsTestRuntime } from "./test";
import type { WorkflowsRegistry } from "./workflow";

const DemoWorkflow = defineWorkflow(
  { name: "demo-workflow" },
  async (_event: WorkflowEvent<unknown>, step: WorkflowStep) => {
    step.log.info("run", null, { category: "run" });
    return await step.do("noop", () => "ok");
  },
);

const workflows: WorkflowsRegistry = {
  DEMO: DemoWorkflow,
};

describe("workflows model checker (runner)", () => {
  it("runs runner ticks across interleavings without double-executing", async () => {
    const runtime = createWorkflowsTestRuntime({
      startAt: new Date("2025-01-01T00:00:00.000Z"),
    });
    type Harness = Awaited<ReturnType<typeof createWorkflowsTestHarness>>;

    const invariant: ModelCheckerInvariant<
      typeof workflowsSchema,
      UnitOfWorkConfig,
      Harness
    > = async ({ queryEngine }) => {
      const logs = await queryEngine.find("workflow_log", (b) =>
        b.whereIndex("idx_workflow_log_category_createdAt", (eb) =>
          eb.and(
            eb("workflowName", "=", "demo-workflow"),
            eb("instanceId", "=", "inst-1"),
            eb("runNumber", "=", 0),
            eb("category", "=", "run"),
          ),
        ),
      );

      if (logs.length > 1) {
        throw new Error("Workflow executed more than once");
      }
    };

    const result = await runModelCheckerWithActors<
      typeof workflowsSchema,
      UnitOfWorkConfig,
      Harness
    >({
      schema: workflowsSchema,
      mode: "random",
      seed: 7,
      maxSchedules: 10,
      history: false,
      createContext: async () => {
        const harness = await createWorkflowsTestHarness({
          workflows,
          adapter: { type: "model-checker", options: { idSeed: "workflows-model-checker" } },
          runtime,
          autoTickHooks: false,
        });

        return {
          adapter: harness.test.adapter as ModelCheckerAdapter<UnitOfWorkConfig>,
          ctx: harness,
          queryEngine: harness.db as SimpleQueryInterface<typeof workflowsSchema, UnitOfWorkConfig>,
          cleanup: harness.test.cleanup,
        };
      },
      setup: async (harness) => {
        await harness.createInstance("DEMO", { id: "inst-1", params: { ok: true } });
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
