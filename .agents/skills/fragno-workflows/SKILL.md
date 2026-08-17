---
name: fragno-workflows
description: >
  Build replay-safe Fragno Workflows: define or modify durable steps, retries, sleeps, event waits,
  emissions, step-scoped mutations, fragment and dispatcher setup, instance management, and
  deterministic tests. Use when working with @fragno-dev/workflows, defineWorkflow, WorkflowStep,
  workflow instances, runner ticks, or replay behavior.
---

# Fragno Workflows

Fragno Workflows are database-backed, replayable programs. Every runner tick can invoke the workflow
function again from the beginning; completed steps normally return persisted results instead of
rerunning their callbacks. A full restart discards every checkpoint, and retrying a failed top-level
step discards and reruns all nested checkpoints beneath that step.

## Replay gate

Apply this gate before designing, changing, or reviewing any workflow. The
[full rules reference](references/rules-of-workflows.md) provides the rationale and examples.

A workflow change passes only when every applicable rule has been checked:

- External calls use stable idempotency keys. A successful `step.do` prevents normal replay while
  its checkpoint exists, but failed or concurrent attempts can repeat, and management restart or
  failed-step retry can intentionally discard completed checkpoints.
- Steps are granular retry boundaries; unrelated external systems have separate steps.
- Failure classification is explicit: transient failures follow the retry policy, while permanent
  failures throw `NonRetryableError` and bypass further attempts.
- State after suspension is rebuilt from original input or persisted step results. Mutating local
  variables inside callbacks does not rebuild state on replay.
- Side effects, time reads, and random choices live inside steps.
- `event.payload` remains immutable; instance params stay the original creation input.
- Step names and repeated-step order are deterministic. Names cannot contain `>`, `#`, or a null
  character.
- `Promise.race` and `Promise.any` decisions are persisted by an enclosing step. Losing branches are
  not cancelled and remain idempotent.
- Instance IDs uniquely identify one invocation within a workflow name. Plain create with an
  existing ID returns that instance and ignores new params. `restartOrCreate` restarts it only when
  the explicit terminal-status precondition matches, while still preserving its original params.
- Every `step.do`, `step.sleep`, `step.sleepUntil`, and `step.waitForEvent` promise is awaited,
  returned, or included in an awaited combinator.
- Branches and loops depend only on immutable input or persisted step results. `event.timestamp`,
  `Date.now()`, randomness, and mutable module state are not durable branch inputs.
- Bulk creation uses `createBatch` or the batch route in chunks of at most 100 instances.

Treat every external step callback and `onWorkflowTerminal` callback as repeatable.

## 1. Map the durable behavior

Inspect the existing workflow registry, definitions, fragment setup, dispatcher, callers, and tests.
For new work, identify:

- Original immutable input and typed output.
- Each external effect and its idempotency key.
- Each durable checkpoint and the value it must return.
- Sleeps, event waits, retry policies, and terminal states.
- Which failures are transient, permanent, or intentionally handled by the workflow.
- Branches, loops, parallel work, and their durable decision inputs.
- Database mutations that must commit with step success or terminal failure.
- How instances are created, awakened, observed, and authorized.

This step is complete when every effect and control-flow decision has an explicit replay-safe home.

## 2. Implement the durable shape

### Write the workflow as dataflow

Arrange the workflow body so durable values and their consumers appear in dependency order:

- Construct replay-safe runtime collaborators, route callers, factories, and static configuration
  before the first step when they do not depend on step results.
- Give each distinct domain operation its own step and retry boundary.
- Return a complete serializable snapshot from each step. Pure derivations of values produced inside
  a step—normalization, identifiers, paths, ordering, checksums, and deterministic step names—belong
  in that step when later work consumes them.
- Immediately after a step returns, destructure its result and construct any replay-safe
  collaborators that depend on it. Keep derived values beside their durable source.
- Use anonymous arrow functions for step callbacks; the step name describes the operation.

This shape is complete when every downstream value can be traced directly to immutable input or the
nearest preceding persisted step result, without searching across unrelated workflow code.

Use the public workflow entrypoint and export a stable registry:

```ts
import { defineWorkflow } from "@fragno-dev/workflows/workflow";

export const ProcessOrderWorkflow = defineWorkflow<
  "process-order",
  { orderId: string },
  { processed: true }
>({ name: "process-order" }, async (event, step) => {
  const order = await step.do("load order", async () => {
    return await orders.get(event.payload.orderId);
  });

  await step.do(
    "charge order",
    { retries: { limit: 3, delay: "5 s", backoff: "exponential" } },
    async () => {
      await payments.charge({
        orderId: order.id,
        idempotencyKey: `${event.instanceId}:charge-order`,
      });
    },
  );

  return { processed: true };
});

export const workflows = { processOrder: ProcessOrderWorkflow } as const;
```

Core authoring contract:

- Use `step.do` for retryable work, `step.sleep` or `step.sleepUntil` for durable time, and
  `step.waitForEvent` when receiving an event is itself a durable boundary.
- A retry `limit` counts retries after the initial attempt. Throw `NonRetryableError` from
  `@fragno-dev/workflows/workflow` when another attempt cannot succeed without different input or
  external state. The runner marks the step terminally errored, bypasses its retry schedule, and
  rethrows; `WaitForEventTimeoutError` is a `NonRetryableError` subclass.
- Add a Standard Schema as `schema` to validate create and batch params. Add `outputSchema` for
  end-to-end output typing.
- Return values needed after suspension from completed steps. Persist larger or independently
  queried state in an application table and return a stable identifier.
- Inside `step.do`, use `tx.mutate`, mutate-only `tx.serviceCalls`, or `tx.workflowServiceCalls` for
  work that commits atomically with the successful step boundary. Buffered mutations run after the
  callback returns and cannot determine its return value.
- Use `tx.onTerminalError.mutate` for mutations that belong only to a terminal step failure. It does
  not run for successful or retryable attempts.
- Use `tx.workflowServiceCalls` to queue another workflow instance atomically with step completion.

Consult [`workflow-fragment.md`](references/workflow-fragment.md) for schemas, step mutation
examples, and terminal callback details.

This step is complete when the implementation passes the replay gate and every database operation is
attached to the intended durable boundary.

## 3. Wire execution

Instantiate the fragment with the workflow registry, runtime, and database adapter:

```ts
import { defaultFragnoRuntime } from "@fragno-dev/core";
import { createDurableHooksProcessor } from "@fragno-dev/db/dispatchers/node";
import { createWorkflowsFragment } from "@fragno-dev/workflows";

const fragment = createWorkflowsFragment(
  { workflows, runtime: defaultFragnoRuntime },
  { databaseAdapter },
);

const dispatcher = createDurableHooksProcessor([fragment], {
  pollIntervalMs: 2000,
});
dispatcher.startPolling();
```

Execution contract:

- A durable-hooks dispatcher must process enqueued workflow ticks, emission cleanup, and terminal
  callbacks. Stop an in-process dispatcher during application shutdown.
- Use the Cloudflare Fragment Durable Object host when deployment requires a Durable Object
  dispatcher.
- Mount the fragment with the application's framework adapter and apply database migrations.
- Protect mounted routes with application authentication and authorization middleware.
- `onWorkflowTerminal` runs after `complete`, `errored`, or `terminated` commits. Its delivery can
  retry, so its side effects are idempotent.

Consult [`runner-dispatcher.md`](references/runner-dispatcher.md) for Node and Cloudflare setup.

This step is complete when every enqueue source reaches a running dispatcher and mounted routes have
an authorization boundary.

## 4. Handle events, emissions, and management

Choose the event primitive by durability boundary:

- `step.waitForEvent` persists waiting and completes as a durable step when the event is consumed.
- `tx.onEvent` delivers exact-type events to a currently active `step.do`. Calling `event.consume()`
  commits consumption only when that surrounding step succeeds, so retries can deliver it again.
- Supplying an event ID makes repeated HTTP delivery idempotent for that workflow instance.

Treat step emissions as live output:

- `tx.emit(payload)` publishes progress associated with the current step key and attempt epoch.
- System emissions coexist with workflow-authored emissions.
- `tx.previousEmissions()` sees emissions loaded before the current attempt, not emits from the same
  attempt.
- Cleanup removes completed attempt emissions asynchronously. Persist durable domain history in step
  results or application tables.

The public management surface supports creating single or batched instances, atomic
restart-or-create with an explicit terminal-status precondition, status and history reads,
current-step emission streams, events, pause, resume, failed-step retry, and termination. Batch
creation requires IDs and accepts at most 100 entries. History contains persisted steps and events
plus any emissions still present at read time.

Consult [`step-events-emissions.md`](references/step-events-emissions.md) for active-step patterns
and [`routes.md`](references/routes.md) for request shapes and route behavior.

This step is complete when event consumption matches the intended durable boundary and emissions are
used only for live, step-scoped output.

## 5. Prove durable behavior

Use `createWorkflowsTestHarness` for focused runner, route, service, history, and database tests.
Use the Scenario DSL for longer flows involving events, time, restarts, hooks, clients, stores, or
multiple runners.

Testing contract:

- Use `createWorkflowsTestRuntime` for deterministic time and randomness.
- Set `autoTickHooks: false` when the test must decide exactly when work executes.
- Advance the harness clock rather than real time for sleeps, retry delays, and event timeouts.
- Use `restart()` to recreate runner fragments while preserving database state.
- Use `createRunner()` or named scenario runners for deliberate concurrency tests.
- Assert persisted status, step attempts, events, emissions, and domain rows—not only callback
  counters.
- Clean up direct harnesses in `finally`; Scenario DSL execution cleans up automatically.

Test every affected failure boundary:

- A normal successful run.
- Retryable failure through its configured attempt limit.
- `NonRetryableError` bypassing retries on the first failed attempt.
- Terminal-error mutations for both exhausted retries and non-retryable failures.
- Suspension and wake-up for sleeps or events.
- Runner restart after a completed step and after a waiting step.
- Duplicate instance or event delivery when idempotency matters.
- Concurrent ticks or promise combinators when the workflow permits races.

Consult [`testing.md`](references/testing.md) for harness and Scenario DSL examples.

This step is complete when persisted outcomes remain correct across every replay, retry, restart,
and concurrency boundary affected by the change.

## 6. Verify

Run the narrow workflow tests first, then the owning package's build, type-check, lint, and format
commands. Inspect a failed or waiting instance through status, history, event delivery fields,
`nextRetryAt`, `wakeAt`, current-step emissions, and runtime diagnostics. An error derived from
`NonRetryableError` intentionally has no next retry. The dispatcher must still be running for queued
work to progress.

Consult [`debugging.md`](references/debugging.md) for the diagnostic checklist.

Verification is complete when focused tests, affected builds, type checks, formatting, and the full
replay gate all pass.
