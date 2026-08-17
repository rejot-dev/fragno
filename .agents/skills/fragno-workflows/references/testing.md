# Workflow Testing

## Overview

Workflow tests should exercise the durable behavior that ordinary function tests cannot cover:
replay, retries, sleeps, event delivery, database commits, runner restarts, and concurrent ticks.
Fragno provides two related testing APIs:

- `createWorkflowsTestHarness` for focused tests with direct control over the fragment, database,
  services, routes, clock, and runner.
- The Scenario DSL for readable end-to-end tests expressed as a sequence of workflow, runner, hook,
  client, and store actions.

Both use a real Fragno database adapter and execute the actual workflow runner. The Scenario DSL
uses an in-memory SQLite database by default and always cleans up after success or failure.

## Choose a testing style

Use the test harness when a test needs precise imperative control or low-level assertions:

- Run one tick at a time.
- Inspect status, history, database rows, services, or route responses.
- Create multiple runner runtimes and coordinate concurrent work.
- Reuse normal Vitest setup and assertion patterns.

Use the Scenario DSL when the test describes a longer observable flow:

- Create an instance, deliver events, advance time, and assert the final state.
- Exercise pause, resume, failed-step retry, and termination behavior.
- Restart the runner between actions to verify replay behavior.
- Configure additional fragments, typed clients, reactive stores, hooks, or concurrent runners.

These APIs use the same underlying test harness, so choose the form that makes each test easiest to
read.

## Focused tests with the harness

Install the test package alongside Workflows:

```bash
npm install --save-dev @fragno-dev/test
```

Create a harness with a database adapter, the Fragno database test builder, and an optional
deterministic runtime:

```ts title="lib/workflows.test.ts"
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";
import { createWorkflowsTestHarness, createWorkflowsTestRuntime } from "@fragno-dev/workflows/test";
import { expect, test } from "vitest";
import { workflows } from "./workflows";

test("completes after approval", async () => {
  const runtime = createWorkflowsTestRuntime({ startAt: 0, seed: 42 });
  const harness = await createWorkflowsTestHarness({
    workflows,
    adapter: { type: "in-memory" },
    testBuilder: buildDatabaseFragmentsTest(),
    runtime,
    autoTickHooks: false,
  });

  try {
    const instanceId = await harness.createInstance("approval", {
      id: "approval-1",
      params: { requestId: "req_1", amount: 125 },
    });

    await harness.runUntilIdle({
      workflowName: "approval-workflow",
      instanceId,
      reason: "create",
    });

    expect(await harness.getStatus("approval", instanceId)).toMatchObject({
      status: "waiting",
    });

    await harness.sendEvent("approval", instanceId, {
      type: "approval",
      payload: { approved: true },
    });
    await harness.runUntilIdle({
      workflowName: "approval-workflow",
      instanceId,
      reason: "event",
    });

    expect(await harness.getStatus("approval", instanceId)).toMatchObject({
      status: "complete",
    });
  } finally {
    await harness.test.cleanup();
  }
});
```

The harness also exposes:

- `createBatch`, `pauseInstance`, `resumeInstance`, `retryFailedStep`, and `terminateInstance`
- `getStatus` and `getHistory`
- `fragment`, `services`, `db`, `deps`, and `callRoute`
- `tick` and `runUntilIdle`
- `clock` and the deterministic runtime controls
- `createRunner()` for an independent runner runtime
- `restart()` for recreating the default runner's fragment runtime

Set `autoTickHooks: false` when the test should decide exactly when queued workflow work executes.

## Test retry classification

Test permanent failures separately from exhausted retries. `NonRetryableError` must stop a step on
its first failed attempt even when retries are configured:

```ts
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";
import { createWorkflowsTestHarness } from "@fragno-dev/workflows/test";
import { defineWorkflow, NonRetryableError } from "@fragno-dev/workflows/workflow";
import { expect, test } from "vitest";

test("does not retry a permanent failure", async () => {
  let attempts = 0;
  const workflow = defineWorkflow({ name: "permanent-failure" }, async (_event, step) => {
    await step.do(
      "validate account",
      { retries: { limit: 3, delay: 0, backoff: "constant" } },
      async () => {
        attempts += 1;
        throw new NonRetryableError("ACCOUNT_NOT_FOUND");
      },
    );
  });

  const harness = await createWorkflowsTestHarness({
    workflows: { permanentFailure: workflow },
    adapter: { type: "in-memory" },
    testBuilder: buildDatabaseFragmentsTest(),
    autoTickHooks: false,
  });

  try {
    const instanceId = await harness.createInstance("permanentFailure");
    await harness.runUntilIdle({
      workflowName: "permanent-failure",
      instanceId,
      reason: "create",
    });

    expect(attempts).toBe(1);
    expect(await harness.getStatus("permanentFailure", instanceId)).toMatchObject({
      status: "errored",
      error: { name: "NonRetryableError", message: "ACCOUNT_NOT_FOUND" },
    });
  } finally {
    await harness.test.cleanup();
  }
});
```

When the step registers `tx.onTerminalError.mutate`, assert that the mutation commits for both a
`NonRetryableError` and an ordinary error whose retries are exhausted. Also assert that the terminal
mutation does not run while an ordinary error is still waiting for another attempt.

## End-to-end tests with scenarios

Import the Scenario DSL from `@fragno-dev/workflows/scenario`. Scenario steps run sequentially
unless you explicitly use a concurrent step.

```ts title="lib/workflows.scenario.test.ts"
import { defineScenario, runScenario } from "@fragno-dev/workflows/scenario";
import { expect, test } from "vitest";
import { workflows } from "./workflows";

test("approval flow", async () => {
  await runScenario(
    defineScenario({
      name: "approval-flow",
      workflows,
      steps: ({ workflow, runner }) => [
        runner.initializeAndRunUntilIdle({
          workflow: "approval",
          id: "approval-1",
          params: { requestId: "req_1", amount: 125 },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("approval", "approval-1"),
          assert: (status) => {
            expect(status).toMatchObject({ status: "waiting" });
          },
        }),
        runner.eventAndRunUntilIdle({
          workflow: "approval",
          instanceId: "approval-1",
          event: { type: "approval", payload: { approved: true } },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("approval", "approval-1"),
          assert: (status) => {
            expect(status).toMatchObject({ status: "complete" });
          },
        }),
      ],
    }),
  );
});
```

Workflow management and state reads are available from `workflow`. Actions that execute workflow
ticks are available from `runner`. A `workflow.read` step can assert immediately or save a value
with `storeAs` for a later `workflow.assert` step.

## Assert durable state

Prefer assertions against persisted state rather than only checking in-memory callback counters. The
scenario state helpers expose the instance, status, steps, events, and emissions:

```ts
workflow.read({
  read: (ctx) => ctx.state.getSteps("approval", "approval-1"),
  assert: (steps) => {
    expect(steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stepKey: "waitForEvent:approval",
          status: "completed",
        }),
      ]),
    );
  },
});
```

Use `harness.getHistory(...)`, `harness.db`, or `harness.callRoute(...)` when a focused test needs
the same checks without the Scenario DSL.

## Control time

Advance the deterministic clock to test sleeps, retry delays, and event timeouts without waiting in
real time:

```ts
steps: ({ runner }) => [
  runner.advanceTimeAndRunUntilIdle({
    workflow: "approval",
    instanceId: "approval-1",
    advanceBy: "1 hour",
  }),

  runner.advanceTimeAndRunUntilIdle({
    workflow: "approval",
    instanceId: "approval-1",
    setTo: new Date("2030-01-01T00:00:00Z"),
  }),
];
```

With the direct harness, call `harness.clock.advanceBy(...)` or `harness.clock.set(...)`, then run a
`wake` tick.

## Test replay and runner restarts

Use `runner.restart()` to recreate that scenario runner's fragment runtime while preserving the test
database. This verifies that workflow behavior comes from persisted step state rather than process
memory:

```ts
steps: ({ workflow, runner }) => [
  runner.initializeAndRunUntilIdle({
    workflow: "approval",
    id: "approval-1",
  }),
  runner.restart(),
  runner.eventAndRunUntilIdle({
    workflow: "approval",
    instanceId: "approval-1",
    event: { type: "approval", payload: { approved: true } },
  }),
  workflow.read({
    read: (ctx) => ctx.state.getStatus("approval", "approval-1"),
    assert: (status) => {
      expect(status).toMatchObject({ status: "complete" });
    },
  }),
];
```

Restarting a runner does not restart or retry a workflow instance. It only recreates the runtime
that processes the next tick.

## Test management actions

Use built-in scenario actions to exercise pause and resume without manually calling routes:

```ts title="lib/workflows.management.test.ts"
await runScenario(
  defineScenario({
    name: "pause-resume",
    workflows,
    steps: ({ workflow, runner }) => [
      runner.initializeAndRunUntilIdle({ workflow: "approval", id: "approval-1" }),
      workflow.pause({ workflow: "approval", instanceId: "approval-1" }),
      workflow.read({
        read: (ctx) => ctx.state.getStatus("approval", "approval-1"),
        assert: (status) => {
          expect(status).toMatchObject({ status: "paused" });
        },
      }),
      runner.resumeAndRunUntilIdle({ workflow: "approval", instanceId: "approval-1" }),
    ],
  }),
);
```

The DSL also provides `workflow.retryFailedStep` and `workflow.terminate`. Use separate tests for
meaningful lifecycle paths instead of combining management actions when a terminal state changes
what later actions are allowed to do.

## Customize the test environment

Scenario definitions accept harness options for the database adapter, runtime, fragment config, and
additional fragments:

```ts
import { createWorkflowsTestRuntime } from "@fragno-dev/workflows/test";
import { defineScenario, runScenario } from "@fragno-dev/workflows/scenario";

const runtime = createWorkflowsTestRuntime({ startAt: 0, seed: 42 });

await runScenario(
  defineScenario({
    name: "deterministic",
    workflows,
    harness: {
      runtime,
      adapter: { type: "kysely-sqlite" },
      autoTickHooks: false,
    },
    steps: ({ workflow }) => [workflow.create({ workflow: "approval", id: "approval-1" })],
  }),
);
```

Use `harness.configureFragments` when the workflow calls or mutates another Fragno fragment. For
full-stack tests, scenarios can also define typed clients, mount reactive stores, wait for store
updates, and create additional client runtimes against the same test database.

## Test concurrency deliberately

The direct harness can create independent runners with `harness.createRunner()`. Scenarios can name
multiple runners and coordinate them with the `concurrent` step. Use these APIs for races between
create, event, retry, wake, or management ticks; keep ordinary behavior tests sequential.

Concurrency tests should assert persisted status, step attempts, events, and database rows after all
runners settle. Callback counters are useful diagnostics, but they are not the durable outcome.

## Full documentation

For the full, up-to-date documentation, retrieve the hosted Markdown:

```sh
curl -fL "https://fragno.dev/docs/workflows/testing" -H "accept: text/markdown"
```
