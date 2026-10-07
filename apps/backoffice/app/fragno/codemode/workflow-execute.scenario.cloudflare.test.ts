import { expect, test } from "vitest";

import { defineScenario, runScenario } from "@fragno-dev/workflows/scenario";
import { defineRemoteWorkflow } from "@fragno-dev/workflows/workflow";
import { env } from "cloudflare:workers";

import { buildDatabaseFragmentsTest } from "@fragno-dev/test";

import { createTrustedSystemBackofficeToolContext } from "@/fragno/runtime-tools/runtime-tools";

import { defineCodemodeWorkflowRun, runBackofficeCodemodeWorkflow } from "./workflow-execute";

for (const caller of ["runner", "wrapper"] as const) {
  test(`native ${caller} preserves the host retry after the guest RPC throws`, async () => {
    const workflowName = `native-rpc-retry-${caller}`;
    const instanceId = `${workflowName}-1`;
    const code = `async (_event, step) => {
      try {
        return await step.do("recover", { retries: { limit: 1, delay: "3 seconds" } }, async (tx) => {
          const previous = await tx.previousEmissions();
          if (previous.length === 0) throw new Error("Retryable step failure");
          return "recovered";
        });
      } catch {
        throw new Error("NATIVE_WORKFLOW_RPC_FAILURE_AFTER_RETRY");
      }
    }`;
    const options = {
      allowedHooks: [],
      families: [],
      toolContext: createTrustedSystemBackofficeToolContext({ runtimes: {} }),
    };
    const Workflow = defineRemoteWorkflow(
      { name: workflowName },
      caller === "runner"
        ? defineCodemodeWorkflowRun(code, env, options)
        : async (event, remote) => {
            const output = await runBackofficeCodemodeWorkflow({
              code,
              event,
              remote,
              env,
              ...options,
            });
            if (output.error) {
              throw new Error(output.error);
            }
            return output.result;
          },
    );
    await runScenario(
      defineScenario({
        name: `native RPC failure does not override the ${caller} retry`,
        workflows: { WORKFLOW: Workflow },
        harness: {
          adapter: { type: "in-memory" },
          testBuilder: buildDatabaseFragmentsTest(),
          autoTickHooks: false,
        },
        steps: ({ workflow, runner }) => [
          runner.initializeAndRunUntilIdle({
            workflow: "WORKFLOW",
            id: instanceId,
            remoteWorkflowName: workflowName,
          }),
          workflow.read({
            read: (ctx) => ctx.state.getStatus("WORKFLOW", instanceId),
            assert: (status) => {
              expect(status).toMatchObject({ status: "waiting" });
            },
          }),
          workflow.read({
            read: (ctx) => ctx.state.getSteps("WORKFLOW", instanceId),
            assert: (steps) => {
              expect(steps).toMatchObject([
                {
                  stepKey: "do:recover",
                  status: "waiting",
                  attempts: 1,
                  maxAttempts: 2,
                  nextRetryAt: expect.any(Date),
                },
              ]);
            },
          }),
          runner.restart(),
          runner.advanceTimeAndRunUntilIdle({
            workflow: "WORKFLOW",
            instanceId,
            advanceBy: "3 seconds",
            maxTicks: 1,
          }),
          runner.runUntilIdle({ workflow: "WORKFLOW", instanceId, reason: "retry" }),
          workflow.read({
            read: (ctx) => ctx.state.getStatus("WORKFLOW", instanceId),
            assert: (status) => {
              expect(status).toMatchObject({ status: "complete", output: "recovered" });
            },
          }),
          workflow.read({
            read: (ctx) => ctx.state.getSteps("WORKFLOW", instanceId),
            assert: (steps) => {
              expect(steps).toMatchObject([
                {
                  stepKey: "do:recover",
                  status: "completed",
                  attempts: 2,
                  result: "recovered",
                  nextRetryAt: null,
                },
              ]);
            },
          }),
        ],
      }),
    );
  });
}

test.each(["throw", "return"] as const)(
  "native host sleep takes precedence when the guest catches suspension and then %s",
  async (terminal) => {
    const workflowName = `native-rpc-sleep-${terminal}`;
    const instanceId = `${workflowName}-1`;
    const Workflow = defineRemoteWorkflow(
      { name: workflowName },
      defineCodemodeWorkflowRun(
        `async (_event, step) => {
      try { await step.sleep("pause", "3 seconds"); }
      catch {
        ${terminal === "throw" ? 'throw new Error("NATIVE_WORKFLOW_RPC_FAILURE_AFTER_SLEEP");' : 'return "must not complete before waking";'}
      }
      return "awake";
    }`,
        env,
        {
          allowedHooks: [],
          families: [],
          toolContext: createTrustedSystemBackofficeToolContext({ runtimes: {} }),
        },
      ),
    );
    await runScenario(
      defineScenario({
        name: `host sleep precedes guest ${terminal}`,
        workflows: { WORKFLOW: Workflow },
        harness: {
          adapter: { type: "in-memory" },
          testBuilder: buildDatabaseFragmentsTest(),
          autoTickHooks: false,
        },
        steps: ({ workflow, runner }) => [
          runner.initializeAndRunUntilIdle({
            workflow: "WORKFLOW",
            id: instanceId,
            remoteWorkflowName: workflowName,
          }),
          workflow.read({
            read: (ctx) => ctx.state.getStatus("WORKFLOW", instanceId),
            assert: (status) => {
              expect(status).toMatchObject({ status: "waiting" });
            },
          }),
          workflow.read({
            read: (ctx) => ctx.state.getSteps("WORKFLOW", instanceId),
            assert: (steps) => {
              expect(steps).toMatchObject([
                { stepKey: "sleep:pause", status: "waiting", wakeAt: expect.any(Date) },
              ]);
            },
          }),
          runner.restart(),
          runner.advanceTimeAndRunUntilIdle({
            workflow: "WORKFLOW",
            instanceId,
            advanceBy: "3 seconds",
          }),
          workflow.read({
            read: (ctx) => ctx.state.getStatus("WORKFLOW", instanceId),
            assert: (status) => {
              expect(status).toMatchObject({ status: "complete", output: "awake" });
            },
          }),
          workflow.read({
            read: (ctx) => ctx.state.getSteps("WORKFLOW", instanceId),
            assert: (steps) => {
              expect(steps).toMatchObject([{ stepKey: "sleep:pause", status: "completed" }]);
            },
          }),
        ],
      }),
    );
  },
);

test("native RPC errors without host suspension still reach the runner", async () => {
  const workflowName = "native-rpc-error-without-suspension";
  const instanceId = `${workflowName}-1`;
  const Workflow = defineRemoteWorkflow(
    { name: workflowName },
    defineCodemodeWorkflowRun(
      `async (_event, _step) => { throw new Error("NATIVE_WORKFLOW_RPC_FAILURE_WITHOUT_SUSPENSION"); }`,
      env,
      {
        allowedHooks: [],
        families: [],
        toolContext: createTrustedSystemBackofficeToolContext({ runtimes: {} }),
      },
    ),
  );
  await runScenario(
    defineScenario({
      name: "native RPC error remains authoritative without host suspension",
      workflows: { WORKFLOW: Workflow },
      harness: {
        adapter: { type: "in-memory" },
        testBuilder: buildDatabaseFragmentsTest(),
        autoTickHooks: false,
      },
      steps: ({ workflow, runner }) => [
        runner.initializeAndRunUntilIdle({
          workflow: "WORKFLOW",
          id: instanceId,
          remoteWorkflowName: workflowName,
        }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("WORKFLOW", instanceId),
          assert: (status) => {
            expect(status).toMatchObject({
              status: "errored",
              error: { message: "NATIVE_WORKFLOW_RPC_FAILURE_WITHOUT_SUSPENSION" },
            });
          },
        }),
      ],
    }),
  );
});
