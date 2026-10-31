import { describe, expect, test } from "vitest";

import { defineScenario, runScenario, type WorkflowScenarioRouteResponse } from "./scenario";
import { defineWorkflow } from "./workflow";

function expectWaitingFor(waitingFor: string[]) {
  return (response: WorkflowScenarioRouteResponse) => {
    expect(response).toMatchObject({ type: "json", data: { waitingFor } });
  };
}

describe("pending waits", () => {
  test("a run waiting for two events at once waits for the one not yet sent", async () => {
    const ParallelWaits = defineWorkflow({ name: "parallel-waits" }, async (_event, step) => {
      await Promise.all([
        step.waitForEvent("wait for a", { type: "a" }),
        step.waitForEvent("wait for b", { type: "b" }),
      ]);
      return { done: true };
    });
    const workflows = { PARALLEL: ParallelWaits };
    const readInstance = (assert: (response: WorkflowScenarioRouteResponse) => void) => ({
      method: "GET" as const,
      path: "/:workflowName/instances/:instanceId",
      options: { pathParams: { workflowName: ParallelWaits.name, instanceId: "run-1" } },
      assert,
    });

    await runScenario(
      defineScenario<typeof workflows, Record<string, never>>({
        name: "parallel-waits",
        workflows,
        steps: ({ workflow, runner }) => [
          workflow.create({ workflow: "PARALLEL", id: "run-1" }),
          runner.runCreateUntilIdle({ workflow: "PARALLEL", instanceId: "run-1" }),
          runner.callRoute(readInstance(expectWaitingFor(["a", "b"]))),
          workflow.event({
            workflow: "PARALLEL",
            instanceId: "run-1",
            event: { type: "b", payload: {} },
          }),
          runner.runUntilIdle({ workflow: "PARALLEL", instanceId: "run-1", reason: "event" }),
          runner.callRoute(readInstance(expectWaitingFor(["a"]))),
          workflow.event({
            workflow: "PARALLEL",
            instanceId: "run-1",
            event: { type: "a", payload: {} },
          }),
          runner.runUntilIdle({ workflow: "PARALLEL", instanceId: "run-1", reason: "event" }),
          runner.callRoute(
            readInstance((response) => {
              expect(response).toMatchObject({
                type: "json",
                data: { details: { status: "complete" }, waitingFor: [] },
              });
            }),
          ),
        ],
      }),
    );
  });

  test("a wait a finished step left behind is abandoned with it", async () => {
    const LeftBehind = defineWorkflow({ name: "left-behind-wait" }, async (_event, step) => {
      await step.do("start", async () => {
        // Never awaited, so the step finishes while this wait still waits.
        void step.waitForEvent("ignored", { type: "ignored" }).catch(() => {});
        return "started";
      });
      await step.waitForEvent("approval", { type: "approved" });
    });
    const workflows = { LEFT_BEHIND: LeftBehind };

    await runScenario(
      defineScenario<typeof workflows, Record<string, never>>({
        name: "left-behind-wait",
        workflows,
        steps: ({ workflow, runner }) => [
          workflow.create({ workflow: "LEFT_BEHIND", id: "run-1" }),
          runner.runCreateUntilIdle({ workflow: "LEFT_BEHIND", instanceId: "run-1" }),
          runner.callRoute({
            method: "GET",
            path: "/:workflowName/instances/:instanceId",
            options: { pathParams: { workflowName: LeftBehind.name, instanceId: "run-1" } },
            assert: expectWaitingFor(["approved"]),
          }),
        ],
      }),
    );
  });
});
