import { assert, expect, test } from "vitest";

import { defineScenario, runScenario } from "@fragno-dev/workflows/scenario";
import { defineRemoteWorkflow } from "@fragno-dev/workflows/workflow";
import { env } from "cloudflare:workers";

import { buildDatabaseFragmentsTest } from "@fragno-dev/test";

import { parseBackofficeUiResult } from "@/backoffice-ui/result";
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
      modules: {},
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
          modules: {},
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
        modules: {},
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

test("a ui.form step collects workflow input that the paired waitForEvent consumes", async () => {
  const workflowName = "codemode-ui-form";
  const instanceId = `${workflowName}-1`;
  const Workflow = defineRemoteWorkflow(
    { name: workflowName },
    defineCodemodeWorkflowRun(
      `async (_event, step) => {
        const approval = ui.form("approval", { decision: "approve", reason: "" });
        await step.do("request approval", async () => ({
          $ui: ui.render(
            ui.stack({ gap: "md" }, [
              ui.select({
                label: "Decision",
                value: approval.bind("decision"),
                options: [
                  { label: "Approve", value: "approve" },
                  { label: "Reject", value: "reject" },
                ],
              }),
              ui.when(
                approval.is("decision", { eq: "reject" }),
                ui.textArea({ label: "Reason", value: approval.bind("reason") }),
              ),
              approval.submit({ label: "Submit decision" }),
            ]),
          ),
        }));
        const { payload } = await step.waitForEvent("approval", { type: approval.eventType });
        return payload;
      }`,
      env,
      {
        allowedHooks: [],
        families: [],
        modules: {},
        toolContext: createTrustedSystemBackofficeToolContext({ runtimes: {} }),
      },
    ),
  );
  await runScenario(
    defineScenario({
      name: "ui.form interface pairs with its waitForEvent",
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
          read: (ctx) => ctx.state.getSteps("WORKFLOW", instanceId),
          assert: (steps) => {
            const uiStep = steps.find((step) => step.stepKey === "do:request approval");
            const generatedUi = parseBackofficeUiResult(uiStep?.result);
            assert(generatedUi.kind === "valid");
            expect(generatedUi.value.$ui).toEqual({
              version: 1,
              state: { response: { decision: "approve", reason: "" } },
              spec: {
                root: "root",
                elements: {
                  root: {
                    type: "Stack",
                    props: { gap: "md" },
                    children: ["root.0", "root.1", "root.2"],
                  },
                  "root.0": {
                    type: "Select",
                    props: {
                      label: "Decision",
                      value: { $bindState: "/response/decision" },
                      options: [
                        { label: "Approve", value: "approve" },
                        { label: "Reject", value: "reject" },
                      ],
                    },
                    children: [],
                  },
                  "root.1": {
                    type: "TextArea",
                    props: { label: "Reason", value: { $bindState: "/response/reason" } },
                    children: [],
                    visible: { $state: "/response/decision", eq: "reject" },
                  },
                  "root.2": {
                    type: "WorkflowEventButton",
                    props: {
                      label: "Submit decision",
                      eventType: "approval",
                      payload: { $state: "/response" },
                    },
                    children: [],
                  },
                },
              },
            });
            expect(steps).toContainEqual(
              expect.objectContaining({
                stepKey: "waitForEvent:approval",
                status: "waiting",
                waitEventType: "approval",
              }),
            );
          },
        }),
        runner.eventAndRunUntilIdle({
          workflow: "WORKFLOW",
          instanceId,
          event: { type: "approval", payload: { decision: "reject", reason: "Over budget" } },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("WORKFLOW", instanceId),
          assert: (status) => {
            expect(status).toMatchObject({
              status: "complete",
              output: { decision: "reject", reason: "Over budget" },
            });
          },
        }),
      ],
    }),
  );
});

test("a step returning an invalid generated UI fails without spending its retries", async () => {
  const workflowName = "codemode-invalid-ui";
  const instanceId = `${workflowName}-1`;
  const Workflow = defineRemoteWorkflow(
    { name: workflowName },
    defineCodemodeWorkflowRun(
      `async (_event, step) => {
        await step.do("show report", { retries: { limit: 3, delay: "1 second" } }, async () => ({
          $ui: {
            version: 1,
            state: {},
            spec: {
              root: "metric",
              elements: {
                metric: { type: "Metric", props: { label: "Orders", value: 24 }, children: [] },
              },
            },
          },
        }));
      }`,
      env,
      {
        allowedHooks: [],
        families: [],
        modules: {},
        toolContext: createTrustedSystemBackofficeToolContext({ runtimes: {} }),
      },
    ),
  );
  const message =
    'Step "show report" returned an invalid generated UI: Element "metric" has invalid props for Metric: value: Invalid input: expected string, received number.';
  await runScenario(
    defineScenario({
      name: "invalid step UI is a terminal step error",
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
            expect(status).toMatchObject({ status: "errored", error: { message } });
          },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getSteps("WORKFLOW", instanceId),
          assert: (steps) => {
            expect(steps).toMatchObject([
              {
                stepKey: "do:show report",
                status: "errored",
                attempts: 1,
                errorName: "NonRetryableError",
                errorMessage: message,
              },
            ]);
          },
        }),
      ],
    }),
  );
});
