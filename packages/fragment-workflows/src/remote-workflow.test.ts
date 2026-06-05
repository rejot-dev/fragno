import { describe, expect, test } from "vitest";

import { getRemoteWorkflowStepHost } from "./remote-workflow";
import { defineScenario, runScenario } from "./scenario";
import { defineWorkflow } from "./workflow";

describe("remote workflow step host", () => {
  test("preserves nested step identity with explicit parent scopes", async () => {
    const RemoteScopeWorkflow = defineWorkflow(
      { name: "remote-scope-workflow" },
      async (_event, step) => {
        const host = getRemoteWorkflowStepHost(step);

        const nested = await host.do(null, "outer", undefined, async (_tx, outerScope) => {
          return await host.do(outerScope, "shared", undefined, async () => "nested-value");
        });
        const topLevel = await host.do(null, "shared", undefined, async () => "top-level-value");

        return { nested, topLevel };
      },
    );

    const workflows = { REMOTE_SCOPE: RemoteScopeWorkflow };

    await runScenario(
      defineScenario({
        name: "remote-scope-workflow",
        workflows,
        steps: ({ runner, workflow }) => [
          runner.initializeAndRunUntilIdle({ workflow: "REMOTE_SCOPE", id: "remote-scope-1" }),
          workflow.read({
            read: (ctx) => ctx.state.getStatus("REMOTE_SCOPE", "remote-scope-1"),
            assert: (status) => {
              expect(status).toMatchObject({
                status: "complete",
                output: { nested: "nested-value", topLevel: "top-level-value" },
              });
            },
          }),
          workflow.read({
            read: (ctx) => ctx.state.getSteps("REMOTE_SCOPE", "remote-scope-1"),
            assert: (steps) => {
              expect(steps.map((step) => step.stepKey)).toEqual([
                "do:outer",
                "do:outer>do:shared",
                "do:shared",
              ]);
              expect(steps.find((step) => step.stepKey === "do:outer>do:shared")).toMatchObject({
                parentStepKey: "do:outer",
                depth: 1,
              });
            },
          }),
        ],
      }),
    );
  });
});
