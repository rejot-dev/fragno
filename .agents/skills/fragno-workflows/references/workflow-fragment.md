# Workflow Fragment

The Workflows Fragment lets you define long-running processes with durable steps, retries, and
waits. It stores workflow state in your database and exposes HTTP endpoints to create, control, and
observe workflow instances.

## Install

```bash
npm install @fragno-dev/workflows @fragno-dev/db
npm install --save-dev @fragno-dev/test
```

## Define a Workflow

```ts title="lib/workflows.ts"
import {
  defineWorkflow,
  type WorkflowEvent,
  type WorkflowStep,
} from "@fragno-dev/workflows/workflow";

type ApprovalParams = {
  requestId: string;
  amount: number;
};

type ApprovalEvent = { approved: boolean };

type FulfillmentEvent = { confirmationId: string };

export const ApprovalWorkflow = defineWorkflow(
  { name: "approval-workflow" },
  async (event: WorkflowEvent<ApprovalParams>, step: WorkflowStep) => {
    const approval = await step.waitForEvent<ApprovalEvent>("approval", {
      type: "approval",
      timeout: "15 min",
    });

    await step.sleep("cooldown", "2 s");

    const fulfillment = await step.waitForEvent<FulfillmentEvent>("fulfillment", {
      type: "fulfillment",
      timeout: "15 min",
    });

    return { request: event.payload, approval, fulfillment };
  },
);

export const workflows = {
  approval: ApprovalWorkflow,
} as const;
```

## Retry behavior and permanent failures

`step.do` runs once unless you configure `retries`. The retry `limit` is the number of retries after
the initial attempt, so `limit: 2` permits at most three attempts.

Throw `NonRetryableError` when the current failure is permanent and another attempt should not be
scheduled, even when the step has a retry policy:

```ts
import { NonRetryableError } from "@fragno-dev/workflows/workflow";

await step.do(
  "validate account",
  { retries: { limit: 3, delay: "5 s", backoff: "exponential" } },
  async () => {
    const account = await accounts.get(event.payload.accountId);

    if (!account) {
      throw new NonRetryableError("ACCOUNT_NOT_FOUND");
    }

    return account.id;
  },
);
```

The runner records the step as terminally `errored` on the current attempt and rethrows the error.
If the workflow does not catch it, the instance becomes `errored`. Permanent failures also run
`tx.onTerminalError.mutate` work; retryable failures run that work only after their retry limit is
exhausted.

Use ordinary errors for transient failures that the configured retry policy may resolve.
`WaitForEventTimeoutError`, thrown when a durable event wait reaches its timeout, is a
`NonRetryableError` subclass.

## Step-scoped mutations

Use step-scoped mutations to register database work that should commit with the step record. These
mutations run after the step callback returns and are skipped on replay, so they cannot influence
the step return value.

Step-scoped mutations commit in the same transaction that persists the step boundary. Buffered
mutations and mutate-only service calls are applied atomically with the step state update; do not
rely on ordering between those operations.

```ts
await step.do("persist-user", async (tx) => {
  const profile = await buildUserProfile();

  tx.serviceCalls(() => [usersService.createUser(profile), auditService.logUserCreate(profile)]);

  return profile.id;
});
```

If you need reads that affect the step output, perform them explicitly in the step body instead of
relying on the step-scoped buffer. `tx.serviceCalls` only accepts mutate-only service transactions.

### Terminal-error mutations

Use `tx.onTerminalError.mutate(...)` when you want to persist a final failure-side effect only if a
step ends in a terminal error. This is useful for projections like marking a job failed, recording a
compensation marker, or storing a domain-visible failure row next to the workflow step.

These callbacks do **not** run on success, and they do **not** run for retryable failures that only
suspend the step for another attempt.

```ts
await step.do("charge-card", { retries: { limit: 3, delay: "30 s" } }, async (tx) => {
  tx.onTerminalError.mutate((ctx) => {
    ctx.forSchema(paymentsSchema).create("payment_failure", {
      paymentId: event.payload.paymentId,
      phase: "charge-card",
    });
  });

  const receipt = await chargeCard();

  tx.mutate((ctx) => {
    ctx
      .forSchema(paymentsSchema)
      .update("payment", event.payload.paymentId, (b) =>
        b.set({ status: "paid", receiptId: receipt.id }).check(),
      );
  });

  return receipt.id;
});
```

## Schema validation + output typing

If you provide a Standard Schema, params are validated on create/createBatch. If you provide an
`outputSchema`, the workflow output is typed end-to-end.

```ts
import { z } from "zod";

const paramsSchema = z.object({ requestId: z.string(), amount: z.number() });
const outputSchema = z.object({ confirmationId: z.string() });

export const ApprovalWorkflow = defineWorkflow(
  { name: "approval-workflow", schema: paramsSchema, outputSchema },
  async (event, step) => {
    // ...
    return { confirmationId: "conf_123" };
  },
);
```

## Create the Fragment Server

```ts title="lib/workflows-fragment.ts"
import { defaultFragnoRuntime } from "@fragno-dev/core";
import { type DatabaseAdapter } from "@fragno-dev/db";
import { createDurableHooksProcessor } from "@fragno-dev/db/dispatchers/node";
import { createWorkflowsFragment } from "@fragno-dev/workflows";
import { workflows } from "./workflows";

export function createWorkflowsFragmentServer(adapter: DatabaseAdapter<any>) {
  const fragment = createWorkflowsFragment(
    {
      workflows,
      runtime: defaultFragnoRuntime,
    },
    { databaseAdapter: adapter },
  );

  const dispatcher = createDurableHooksProcessor([fragment], {
    pollIntervalMs: 2000,
  });

  return { fragment, dispatcher };
}
```

`createWorkflowsFragment(config, fragnoConfig)` instantiates the definition, routes, and database
integration in one call. The first argument is the `WorkflowsFragmentConfig`, including the workflow
registry and required runtime. The second is Fragno's database-backed public config, where you pass
the database adapter and any shared fragment options. The registry type is preserved on the returned
fragment.

Use the lower-level `workflowsFragmentDefinition` and `workflowsRoutesFactory` exports only when you
need to customize the normal instantiation pipeline.

## Workflow lifecycle callbacks

Pass `onWorkflowRestarted` and `onWorkflowTerminal` in the fragment config to observe instance
lifecycle transitions:

```ts
const fragment = createWorkflowsFragment(
  {
    workflows,
    runtime: defaultFragnoRuntime,
    onWorkflowRestarted: async ({ instanceId, previousRunGeneration, runGeneration }) => {
      await markWorkflowActive({ instanceId, previousRunGeneration, runGeneration });
    },
    onWorkflowTerminal: async ({ instanceId, runGeneration, status }) => {
      await recordWorkflowTerminalState({ instanceId, runGeneration, status });
    },
  },
  { databaseAdapter: adapter },
);
```

A full restart increments `runGeneration`; failed-step retry leaves it unchanged. Terminal callbacks
within one generation are transition notifications rather than an ordered current-state projection.
Read the instance when current state matters. Run a durable hooks dispatcher for both callbacks, and
make their effects idempotent because delivery can be retried.

## Runtime Injection

Workflows require a `FragnoRuntime` for time and randomness. Use `defaultFragnoRuntime` for
production, or inject a deterministic runtime for tests and model checking.

## Testing Workflows

Use the test harness to drive workflow ticks and control time:

```ts title="lib/workflows.test.ts"
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";
import { createWorkflowsTestHarness, createWorkflowsTestRuntime } from "@fragno-dev/workflows/test";
import { workflows } from "./workflows";

const runtime = createWorkflowsTestRuntime({ startAt: 0, seed: 42 });
const harness = await createWorkflowsTestHarness({
  workflows,
  adapter: { type: "in-memory" },
  testBuilder: buildDatabaseFragmentsTest(),
  runtime,
  autoTickHooks: false,
});

const instanceId = await harness.createInstance("approval", {
  params: { requestId: "req_1", amount: 125 },
});

await harness.runUntilIdle({
  workflowName: "approval-workflow",
  instanceId,
  reason: "create",
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

harness.clock.advanceBy("2 s");
await harness.runUntilIdle({
  workflowName: "approval-workflow",
  instanceId,
  reason: "wake",
});

const status = await harness.getStatus("approval", instanceId);

await harness.test.cleanup();
```

## End-to-End Testing

The Scenario DSL describes multi-step workflow tests using a deterministic clock with minimal setup.
It uses the Workflows test harness under the hood and cleans up automatically.

```ts title="lib/workflows.scenario.test.ts"
import { defineScenario, runScenario } from "@fragno-dev/workflows/scenario";
import { workflows } from "./workflows";

const scenario = defineScenario({
  name: "approval-flow",
  workflows,
  steps: ({ runner }) => [
    runner.initializeAndRunUntilIdle({
      workflow: "approval",
      id: "approval-1",
      params: { requestId: "req_1", amount: 125 },
    }),
    runner.eventAndRunUntilIdle({
      workflow: "approval",
      instanceId: "approval-1",
      event: { type: "approval", payload: { approved: true } },
    }),
  ],
});

await runScenario(scenario);
```

For focused harness tests, replay checks, concurrency, and end-to-end scenarios, see
[Workflow Testing](testing.md).

## External Scheduling

For external schedulers, run a durable hooks dispatcher (Node or Cloudflare DO) so hooks are
processed when work is enqueued.

## Next Steps

- Review the replay and idempotency guidance in [Rules of Workflows](rules-of-workflows.md).
- Publish and receive live data with [Step Events & Emissions](step-events-emissions.md).
- Explore the HTTP surface in the [API routes reference](routes.md).

## Full documentation

For the full, up-to-date documentation, retrieve the hosted Markdown:

```sh
curl -fL "https://fragno.dev/docs/workflows/fragment" -H "accept: text/markdown"
```
