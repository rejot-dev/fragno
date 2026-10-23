import { assert, expect, expectTypeOf, test } from "vitest";

import { defineScenario, runScenario } from "@fragno-dev/workflows/scenario";
import { createWorkflowsTestRuntime } from "@fragno-dev/workflows/test";
import { defineRemoteWorkflow } from "@fragno-dev/workflows/workflow";
import { parseBackofficeUiResult } from "@fragno-private/backoffice-ui/result";
import { env } from "cloudflare:workers";

import { buildDatabaseFragmentsTest } from "@fragno-dev/test";

import { createCloudflareBackofficeObjectRegistry } from "@/backoffice-runtime/cloudflare-durable-object-factory";
import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";
import type {
  CodemodeExecution,
  CodemodeRunFinishedHookPayload,
} from "@/fragno/codemode/codemode-fragment";
import { codemodeRunnerFor, type CodemodeRunner } from "@/fragno/codemode/codemode-object-execute";
import { createTrustedSystemBackofficeToolContext } from "@/fragno/runtime-tools/runtime-tools";

import { defineCodemodeWorkflowRun, runBackofficeCodemodeWorkflow } from "./workflow-execute";
import { testWorkflowProgram } from "./workflow-program.test-utils";

const codemode = codemodeRunnerFor(
  createCloudflareBackofficeObjectRegistry(env as CloudflareEnv).codemode.singleton().commands,
  createBackofficeSystemExecution({ kind: "system" }),
);

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
      origin: { kind: "inline" } as const,
      families: [],
      toolContext: createTrustedSystemBackofficeToolContext({ runtimes: {} }),
    };
    const Workflow = defineRemoteWorkflow(
      { name: workflowName },
      caller === "runner"
        ? defineCodemodeWorkflowRun(testWorkflowProgram(code), codemode, options)
        : async (event, remote) => {
            const output = await runBackofficeCodemodeWorkflow({
              program: testWorkflowProgram(code),
              event,
              remote,
              codemode,
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
        testWorkflowProgram(`async (_event, step) => {
      try { await step.sleep("pause", "3 seconds"); }
      catch {
        ${terminal === "throw" ? 'throw new Error("NATIVE_WORKFLOW_RPC_FAILURE_AFTER_SLEEP");' : 'return "must not complete before waking";'}
      }
      return "awake";
    }`),
        codemode,
        {
          allowedHooks: [],
          origin: { kind: "inline" } as const,
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

test("suspension history uses ISO timestamps while the live runner sleeps and resumes", async () => {
  const scope = { kind: "user", userId: "suspension-history" } as const;
  const object = createCloudflareBackofficeObjectRegistry(env as CloudflareEnv).codemode.for(
    scope,
  ).commands;
  const executor = codemodeRunnerFor(object, createBackofficeSystemExecution(scope));
  const executions: CodemodeExecution[] = [];
  const recordingRunner: CodemodeRunner = {
    async run(activation, origin, host) {
      const execution = await executor.run(activation, origin, host);
      executions.push(execution);
      return execution;
    },
  };
  const startAt = new Date("2030-01-01T00:00:00.000Z");
  const wakeAt = new Date("2030-01-01T00:00:03.000Z");
  const workflowName = "suspension-history";
  const instanceId = `${workflowName}-1`;
  const Workflow = defineRemoteWorkflow(
    { name: workflowName },
    defineCodemodeWorkflowRun(
      testWorkflowProgram(`async (event, step) => {
        await step.sleepUntil("scheduled", new Date(event.payload.wakeAt));
        const approval = await step.waitForEvent("approval", { type: "approved", timeout: "1 hour" });
        return approval.payload;
      }`),
      recordingRunner,
      {
        allowedHooks: [],
        origin: { kind: "inline" },
        families: [],
        toolContext: createTrustedSystemBackofficeToolContext({ runtimes: {} }),
      },
    ),
  );
  await runScenario(
    defineScenario({
      name: "sleepUntil history survives a runner restart and event resumption",
      workflows: { WORKFLOW: Workflow },
      harness: {
        adapter: { type: "in-memory" },
        testBuilder: buildDatabaseFragmentsTest(),
        runtime: createWorkflowsTestRuntime({ startAt, seed: 42 }),
        autoTickHooks: false,
      },
      steps: ({ workflow, runner }) => [
        workflow.create({
          workflow: "WORKFLOW",
          id: instanceId,
          params: { wakeAt: wakeAt.toISOString() },
          remoteWorkflowName: workflowName,
        }),
        runner.tick({ workflow: "WORKFLOW", instanceId, reason: "create" }),
        workflow.read({
          read: async () => {
            expect(executions).toHaveLength(1);
            const { runId, completion } = executions[0];
            assert(completion.status === "suspended" && completion.reason.type === "sleep");
            expect(completion.reason.runAt).toBeInstanceOf(Date);
            expect(completion.reason.runAt?.toISOString()).toBe(wakeAt.toISOString());
            const run = await object.getRun(runId);
            assert(run?.status === "suspended" && run.reason.type === "sleep");
            expectTypeOf(run.reason.runAt).toEqualTypeOf<string | undefined>();
            expect(run.reason).toEqual({
              type: "sleep",
              stepKey: "sleep:scheduled",
              runAt: wakeAt.toISOString(),
            });
            const page = await object.listRuns({ page: "first", pageSize: 10 });
            // A listed run omits the tool calls that getRun reads with it.
            const { toolCalls: _toolCalls, toolCallsTruncated: _truncated, ...listedRun } = run;
            expect(page.runs).toEqual([listedRun]);
            const hooks = await object.getDurableHookQueue();
            const finishedHook = hooks.items.find((hook) => hook.hookName === "onRunFinished");
            assert(finishedHook);
            const finished = finishedHook.payload as CodemodeRunFinishedHookPayload;
            assert(finished.status === "suspended" && finished.reason.type === "sleep");
            expectTypeOf(finished.reason.runAt).toEqualTypeOf<string | undefined>();
            expect(finished.reason).toEqual(run.reason);
          },
        }),
        runner.restart(),
        runner.advanceTimeAndRunUntilIdle({
          workflow: "WORKFLOW",
          instanceId,
          setTo: wakeAt,
          maxTicks: 1,
        }),
        workflow.read({
          read: async () => {
            expect(executions).toHaveLength(2);
            const run = await object.getRun(executions[1].runId);
            assert(run?.status === "suspended" && run.reason.type === "waitForEvent");
            expectTypeOf(run.reason.runAt).toEqualTypeOf<string | undefined>();
            expect(run.reason).toEqual({
              type: "waitForEvent",
              stepKey: "waitForEvent:approval",
              eventType: "approved",
              delayMs: 3_600_000,
            });
            expect(run.reason).not.toHaveProperty("runAt");
          },
        }),
        runner.eventAndRunUntilIdle({
          workflow: "WORKFLOW",
          instanceId,
          event: { type: "approved", payload: { approved: true } },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("WORKFLOW", instanceId),
          assert: (status) => {
            expect(status).toMatchObject({ status: "complete", output: { approved: true } });
          },
        }),
        workflow.read({
          read: async () => {
            const page = await object.listRuns({ page: "first", pageSize: 10 });
            expect(page.runs).toHaveLength(3);
            expect(page.runs.find((run) => run.id === executions[0].runId)).toMatchObject({
              status: "suspended",
              reason: { type: "sleep", runAt: wakeAt.toISOString() },
            });
            expect(page.runs.find((run) => run.id === executions[2].runId)).toMatchObject({
              status: "completed",
            });
          },
        }),
      ],
    }),
  );
});

test("native RPC errors without host suspension still reach the runner", async () => {
  const workflowName = "native-rpc-error-without-suspension";
  const instanceId = `${workflowName}-1`;
  const Workflow = defineRemoteWorkflow(
    { name: workflowName },
    defineCodemodeWorkflowRun(
      testWorkflowProgram(
        `async (_event, _step) => { throw new Error("NATIVE_WORKFLOW_RPC_FAILURE_WITHOUT_SUSPENSION"); }`,
      ),
      codemode,
      {
        allowedHooks: [],
        origin: { kind: "inline" } as const,
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
      testWorkflowProgram(`async (_event, step) => {
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
      }`),
      codemode,
      {
        allowedHooks: [],
        origin: { kind: "inline" } as const,
        families: [],
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
      testWorkflowProgram(`async (_event, step) => {
        await step.do("show report", { retries: { limit: 3, delay: "1 second" } }, async () => ({
          $ui: {
            version: 1,
            state: {},
            spec: {
              root: "metric",
              elements: {
                metric: { type: "Metric", props: { label: 2, value: "Orders" }, children: [] },
              },
            },
          },
        }));
      }`),
      codemode,
      {
        allowedHooks: [],
        origin: { kind: "inline" } as const,
        families: [],
        toolContext: createTrustedSystemBackofficeToolContext({ runtimes: {} }),
      },
    ),
  );
  const message =
    'Step "show report" returned an invalid generated UI: Element "metric" has invalid props for Metric: label: Invalid input: expected string, received number.';
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
