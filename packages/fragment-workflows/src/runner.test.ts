import { beforeEach, describe, expect, test } from "vitest";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";
import { instantiate } from "@fragno-dev/core";
import { workflowsFragmentDefinition } from "./definition";
import { createWorkflowsRunner } from "./runner";
import type { WorkflowEvent, WorkflowStep } from "./workflow";
import { WorkflowEntrypoint } from "./workflow";
import { workflowsRoutesFactory } from "./routes";

describe("Workflows Runner", async () => {
  let doCallCount = 0;

  class DemoWorkflow extends WorkflowEntrypoint<unknown, { count: number }> {
    async run(event: WorkflowEvent<{ count: number }>, step: WorkflowStep) {
      const first = await step.do("calc", () => {
        doCallCount += 1;
        return { count: event.payload.count + 1 };
      });
      const second = await step.do("calc", () => {
        doCallCount += 1;
        return { count: 999 };
      });
      return { first, second };
    }
  }

  class EventWorkflow extends WorkflowEntrypoint {
    async run(_event: WorkflowEvent<unknown>, step: WorkflowStep) {
      return await step.waitForEvent("wait-ready", { type: "ready", timeout: "1 hour" });
    }
  }

  const workflows = {
    demo: { name: "demo-workflow", workflow: DemoWorkflow },
    events: { name: "event-workflow", workflow: EventWorkflow },
  };

  const { fragments, test: testContext } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "drizzle-pglite" })
    .withFragment(
      "workflows",
      instantiate(workflowsFragmentDefinition)
        .withConfig({
          workflows,
        })
        .withRoutes([workflowsRoutesFactory]),
    )
    .build();

  const { fragment, db } = fragments.workflows;
  const runner = createWorkflowsRunner({ db, workflows });

  const createInstance = async (workflowName: string, params: unknown) => {
    const response = await fragment.callRoute("POST", "/workflows/:workflowName/instances", {
      pathParams: { workflowName },
      body: { params },
    });
    if (response.type !== "json") {
      throw new Error("Expected json response");
    }
    return response.data.id as string;
  };

  beforeEach(async () => {
    await testContext.resetDatabase();
    doCallCount = 0;
  });

  test("tick should execute workflow and reuse cached steps", async () => {
    const id = await createInstance("demo-workflow", { count: 1 });

    const processed = await runner.tick({ maxInstances: 1, maxSteps: 10 });
    expect(processed).toBe(1);

    const instance = await db.findFirst("workflow_instance", (b) =>
      b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
        eb.and(eb("workflowName", "=", "demo-workflow"), eb("instanceId", "=", id)),
      ),
    );

    expect(instance?.status).toBe("complete");
    expect(instance?.output).toEqual({
      first: { count: 2 },
      second: { count: 2 },
    });
    expect(doCallCount).toBe(1);

    const steps = await db.find("workflow_step", (b) => b.whereIndex("primary"));
    expect(steps).toHaveLength(1);
    expect(steps[0].status).toBe("completed");
  });

  test("tick should consume buffered events for waitForEvent", async () => {
    const id = await createInstance("event-workflow", {});

    await db.create("workflow_event", {
      workflowName: "event-workflow",
      instanceId: id,
      runNumber: 0,
      type: "ready",
      payload: { ok: true },
      deliveredAt: null,
      consumedByStepKey: null,
    });

    const processed = await runner.tick({ maxInstances: 1, maxSteps: 5 });
    expect(processed).toBe(1);

    const instance = await db.findFirst("workflow_instance", (b) =>
      b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
        eb.and(eb("workflowName", "=", "event-workflow"), eb("instanceId", "=", id)),
      ),
    );

    expect(instance?.status).toBe("complete");
    expect(instance?.output).toEqual({
      type: "ready",
      payload: { ok: true },
      timestamp: expect.any(String),
    });

    const [event] = await db.find("workflow_event", (b) => b.whereIndex("primary"));
    expect(event.deliveredAt).toBeInstanceOf(Date);
    expect(event.consumedByStepKey).toBe("wait-ready");
  });
});
