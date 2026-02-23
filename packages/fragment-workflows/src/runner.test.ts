// Tests for the new runner using the workflows test harness.
import { describe, expect, test } from "vitest";

// TODO: Missing coverage areas for the runner test suite:
// 1. Instance status fields beyond status/output (error shape, currentStep)
// 2. Concurrency conflict handling / idempotency of duplicate ticks
import { buildDatabaseFragmentsTest, drainDurableHooks } from "@fragno-dev/test";
import { defineFragment, instantiate, type AnyFragnoInstantiatedFragment } from "@fragno-dev/core";
import { withDatabase } from "@fragno-dev/db";
import { column, idColumn, schema } from "@fragno-dev/db/schema";
import { defineWorkflow, NonRetryableError, type WorkflowEnqueuedHookPayload } from "./workflow";
import { createWorkflowsTestHarness } from "./test";

describe("Workflows Runner", () => {
  const buildPayload = (
    instance: { id: { toString(): string }; workflowName: string; runNumber: number },
    reason: WorkflowEnqueuedHookPayload["reason"],
  ): WorkflowEnqueuedHookPayload => ({
    workflowName: instance.workflowName,
    instanceId: instance.id.toString(),
    instanceRef: String(instance.id),
    runNumber: instance.runNumber,
    reason,
  });

  test("waitForEvent should reject events created after wakeAt", async () => {
    const TimeoutWorkflow = defineWorkflow(
      { name: "event-timeout-late-event-workflow" },
      async (_event, step) => {
        await step.waitForEvent("ready", { type: "ready", timeout: "5 minutes" });
        return { ok: true };
      },
    );

    const harness = await createWorkflowsTestHarness({
      workflows: { TIMEOUT: TimeoutWorkflow },
      adapter: { type: "in-memory" },
      testBuilder: buildDatabaseFragmentsTest(),
    });

    const instanceId = await harness.createInstance("TIMEOUT");
    await drainDurableHooks(harness.fragment);

    const [stepRecord] = await harness.db.find("workflow_step", (b) => b.whereIndex("primary"));
    expect(stepRecord?.wakeAt).toBeInstanceOf(Date);

    const [instance] = await harness.db.find("workflow_instance", (b) => b.whereIndex("primary"));
    expect(instance).toBeTruthy();

    const wakeAt = stepRecord!.wakeAt!;
    harness.clock.set(new Date(wakeAt.getTime() + 1));

    await harness.sendEvent("TIMEOUT", instanceId, { type: "ready", payload: { ok: true } });

    await harness.tick(buildPayload(instance!, "wake"));

    const finalStatus = await harness.getStatus("TIMEOUT", instanceId);
    expect(finalStatus.status).toBe("errored");
    expect(finalStatus.error?.message).toBe("WAIT_FOR_EVENT_TIMEOUT");
  });

  test("marks workflow errored when WorkflowStepTx mutation fails", async () => {
    const mutationErrorSchema = schema("mutation_error_test", (s) =>
      s.addTable("mutation_record", (t) =>
        t
          .addColumn("id", idColumn())
          .addColumn("note", column("string"))
          .addColumn(
            "createdAt",
            column("timestamp").defaultTo((b) => b.now()),
          )
          .createIndex("idx_note_unique", ["note"], { unique: true }),
      ),
    );

    const mutationErrorFragmentDefinition = defineFragment("mutation-error-fragment")
      .extend(withDatabase(mutationErrorSchema))
      .build();

    const MutationErrorWorkflow = defineWorkflow(
      { name: "mutation-error-workflow" },
      async (event, step) => {
        const note = `dup-${event.instanceId}`;
        await step.do("mutate", (tx) => {
          tx.mutate((ctx) => {
            const uow = ctx.forSchema(mutationErrorSchema);
            uow.create("mutation_record", { note });
            uow.create("mutation_record", { note });
          });
          return "done";
        });
        return { ok: true };
      },
    );

    const harness = await createWorkflowsTestHarness({
      workflows: { MUTATION_ERROR: MutationErrorWorkflow },
      adapter: { type: "kysely-sqlite" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
      configureBuilder: (builder) =>
        builder.withFragment("mutationError", instantiate(mutationErrorFragmentDefinition)),
    });

    const instanceId = await harness.createInstance("MUTATION_ERROR");
    const [instance] = await harness.db.find("workflow_instance", (b) => b.whereIndex("primary"));
    expect(instance).toBeTruthy();

    await harness.tick(buildPayload(instance!, "create"));

    const status = await harness.getStatus("MUTATION_ERROR", instanceId);
    expect(status.status).toBe("errored");
    expect(status.error?.message).toBeTruthy();

    const mutationRows = await harness.fragments["mutationError"].db.find("mutation_record", (b) =>
      b.whereIndex("primary"),
    );
    expect(mutationRows).toHaveLength(0);
  });

  test("does not retry NonRetryableError", async () => {
    let attempts = 0;
    const NonRetryWorkflow = defineWorkflow(
      { name: "non-retry-workflow" },
      async (_event, step) => {
        await step.do("boom", { retries: { limit: 2, delay: 0, backoff: "constant" } }, () => {
          attempts += 1;
          throw new NonRetryableError("NO_RETRY");
        });
        return { ok: true };
      },
    );

    const harness = await createWorkflowsTestHarness({
      workflows: { NO_RETRY: NonRetryWorkflow },
      adapter: { type: "kysely-sqlite" },
      testBuilder: buildDatabaseFragmentsTest(),
    });

    const instanceId = await harness.createInstance("NO_RETRY");
    await drainDurableHooks(harness.fragment);

    const status = await harness.getStatus("NO_RETRY", instanceId);
    expect(status.status).toBe("errored");
    expect(status.error?.message).toBe("NO_RETRY");
    expect(attempts).toBe(1);

    const [stepRecord] = await harness.db.find("workflow_step", (b) => b.whereIndex("primary"));
    expect(stepRecord).toMatchObject({
      stepKey: "do:boom",
      status: "errored",
      attempts: 1,
    });
  });

  test("pausing during an in-flight tick pauses on the next tick", async () => {
    // report: pausing mid-tick should not interrupt the current work but should take effect next tick.
    let runs = 0;
    const started = Promise.withResolvers<void>();
    const blocker = Promise.withResolvers<void>();
    const BlockingWorkflow = defineWorkflow(
      { name: "pause-during-execution-workflow" },
      async (_event, step) => {
        const value = await step.do("block", async () => {
          runs += 1;
          started.resolve();
          await blocker.promise;
          return runs;
        });
        await step.waitForEvent("continue", { type: "continue" });
        return { value };
      },
    );

    const harness = await createWorkflowsTestHarness({
      workflows: { PAUSE_DURING: BlockingWorkflow },
      adapter: { type: "kysely-sqlite" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
    });

    const instanceId = await harness.createInstance("PAUSE_DURING");
    const [instance] = await harness.db.find("workflow_instance", (b) => b.whereIndex("primary"));
    expect(instance).toBeTruthy();

    const tickPromise = harness.tick(buildPayload(instance!, "create"));

    await started.promise;

    const pauseResponse = await (harness.fragment as AnyFragnoInstantiatedFragment).callRoute(
      "POST",
      "/:workflowName/instances/:instanceId/pause",
      {
        pathParams: { workflowName: "pause-during-execution-workflow", instanceId },
      },
    );
    expect(pauseResponse.type).toBe("json");
    if (pauseResponse.type !== "json") {
      throw new Error(`Unexpected response: ${pauseResponse.type}`);
    }
    expect((pauseResponse.data as { ok: true }).ok).toBe(true);

    blocker.resolve();
    const processed = await tickPromise;
    expect(processed).toBe(1);

    const status = await harness.getStatus("PAUSE_DURING", instanceId);
    expect(status.status).toBe("waiting");
    expect(runs).toBe(1);

    const steps = await harness.db.find("workflow_step", (b) => b.whereIndex("primary"));
    expect(steps).toHaveLength(2);

    await harness.tick(buildPayload(instance!, "event"));

    const pausedStatus = await harness.getStatus("PAUSE_DURING", instanceId);
    expect(pausedStatus.status).toBe("paused");
    expect(runs).toBe(1);
  });

  test("does not apply step mutations when callback throws", async () => {
    // report: step tx mutations should only apply after a successful callback.
    const mutationOrderSchema = schema("mutation_order_test", (s) =>
      s.addTable("mutation_record", (t) =>
        t
          .addColumn("id", idColumn())
          .addColumn("note", column("string"))
          .createIndex("idx_note", ["note"]),
      ),
    );

    const mutationOrderFragmentDefinition = defineFragment("mutation-order-fragment")
      .extend(withDatabase(mutationOrderSchema))
      .build();

    const MutationOrderWorkflow = defineWorkflow(
      { name: "mutation-order-workflow" },
      async (_event, step) => {
        await step.do("mutate", (tx) => {
          tx.mutate((ctx) => {
            const uow = ctx.forSchema(mutationOrderSchema);
            uow.create("mutation_record", { note: "pending" });
          });
          throw new Error("CALLBACK_FAILED");
        });
        return { ok: true };
      },
    );

    const harness = await createWorkflowsTestHarness({
      workflows: { MUTATION_ORDER: MutationOrderWorkflow },
      adapter: { type: "kysely-sqlite" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
      configureBuilder: (builder) =>
        builder.withFragment("mutationOrder", instantiate(mutationOrderFragmentDefinition)),
    });

    const instanceId = await harness.createInstance("MUTATION_ORDER");
    const [instance] = await harness.db.find("workflow_instance", (b) => b.whereIndex("primary"));
    expect(instance).toBeTruthy();

    await harness.tick(buildPayload(instance!, "create"));

    const status = await harness.getStatus("MUTATION_ORDER", instanceId);
    expect(status.status).toBe("errored");
    expect(status.error?.message).toBe("CALLBACK_FAILED");

    const rows = await harness.fragments["mutationOrder"].db.find("mutation_record", (b) =>
      b.whereIndex("primary"),
    );
    expect(rows).toHaveLength(0);
  });

  test("step mutations do not re-run on replay", async () => {
    // report: completed steps should not re-apply tx mutations on duplicate ticks.
    const mutationReplaySchema = schema("mutation_replay_test", (s) =>
      s.addTable("mutation_log", (t) =>
        t
          .addColumn("id", idColumn())
          .addColumn("note", column("string"))
          .createIndex("idx_note", ["note"]),
      ),
    );

    const mutationReplayFragmentDefinition = defineFragment("mutation-replay-fragment")
      .extend(withDatabase(mutationReplaySchema))
      .build();

    let runs = 0;
    const MutationReplayWorkflow = defineWorkflow(
      { name: "mutation-replay-workflow" },
      async (_event, step) => {
        await step.do("seed", (tx) => {
          runs += 1;
          tx.mutate((ctx) => {
            const uow = ctx.forSchema(mutationReplaySchema);
            uow.create("mutation_log", { note: `run-${runs}` });
          });
          return runs;
        });
        await step.waitForEvent("ready", { type: "ready" });
        return { ok: true };
      },
    );

    const harness = await createWorkflowsTestHarness({
      workflows: { MUTATION_REPLAY: MutationReplayWorkflow },
      adapter: { type: "kysely-sqlite" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
      configureBuilder: (builder) =>
        builder.withFragment("mutationReplay", instantiate(mutationReplayFragmentDefinition)),
    });

    await harness.createInstance("MUTATION_REPLAY");
    const [instance] = await harness.db.find("workflow_instance", (b) => b.whereIndex("primary"));
    expect(instance).toBeTruthy();

    await harness.tick(buildPayload(instance!, "create"));

    const initialRows = await harness.fragments["mutationReplay"].db.find("mutation_log", (b) =>
      b.whereIndex("primary"),
    );
    expect(initialRows).toHaveLength(1);
    expect(runs).toBe(1);

    await harness.tick(buildPayload(instance!, "event"));

    const replayRows = await harness.fragments["mutationReplay"].db.find("mutation_log", (b) =>
      b.whereIndex("primary"),
    );
    expect(replayRows).toHaveLength(1);
    expect(runs).toBe(1);
  });

  test("concurrent ticks are idempotent", async () => {
    // report: duplicate in-flight ticks should not produce duplicate step records.
    const started = Promise.withResolvers<void>();
    const blocker = Promise.withResolvers<void>();

    const ConcurrencyWorkflow = defineWorkflow(
      { name: "concurrent-tick-workflow" },
      async (_event, step) => {
        await step.do("block", async () => {
          started.resolve();
          await blocker.promise;
          return "done";
        });
        return { ok: true };
      },
    );

    const harness = await createWorkflowsTestHarness({
      workflows: { CONCURRENCY: ConcurrencyWorkflow },
      adapter: { type: "kysely-sqlite" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
    });

    const instanceId = await harness.createInstance("CONCURRENCY");
    const [instance] = await harness.db.find("workflow_instance", (b) => b.whereIndex("primary"));
    expect(instance).toBeTruthy();

    const tickOne = harness.tick(buildPayload(instance!, "create"));
    await started.promise;
    const tickTwo = harness.tick(buildPayload(instance!, "create"));

    await new Promise((resolve) => setTimeout(resolve, 0));
    blocker.resolve();

    const [firstResult, secondResult] = await Promise.all([tickOne, tickTwo]);
    const processed = [firstResult, secondResult].filter((value) => value > 0);
    expect(processed).toHaveLength(1);

    const steps = await harness.db.find("workflow_step", (b) => b.whereIndex("primary"));
    expect(steps).toHaveLength(1);

    const status = await harness.getStatus("CONCURRENCY", instanceId);
    expect(status.status).toBe("complete");
  });

  test("terminate during in-flight tick does not get overwritten", async () => {
    // report: terminating while a tick is running should persist termination over completion.
    const started = Promise.withResolvers<void>();
    const blocker = Promise.withResolvers<void>();

    const TerminateWorkflow = defineWorkflow(
      { name: "terminate-in-flight-workflow" },
      async (_event, step) => {
        await step.do("block", async () => {
          started.resolve();
          await blocker.promise;
          return "done";
        });
        return { ok: true };
      },
    );

    const harness = await createWorkflowsTestHarness({
      workflows: { TERMINATE: TerminateWorkflow },
      adapter: { type: "kysely-sqlite" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
    });

    const instanceId = await harness.createInstance("TERMINATE");
    const [instance] = await harness.db.find("workflow_instance", (b) => b.whereIndex("primary"));
    expect(instance).toBeTruthy();

    const tickPromise = harness.tick(buildPayload(instance!, "create"));
    await started.promise;

    const terminateResponse = await (harness.fragment as AnyFragnoInstantiatedFragment).callRoute(
      "POST",
      "/:workflowName/instances/:instanceId/terminate",
      {
        pathParams: { workflowName: "terminate-in-flight-workflow", instanceId },
      },
    );
    expect(terminateResponse.type).toBe("json");

    blocker.resolve();
    await tickPromise;

    const status = await harness.getStatus("TERMINATE", instanceId);
    expect(status.status).toBe("terminated");
  });

  test("restart during in-flight tick avoids stale run updates", async () => {
    // report: restarting while a tick is in-flight should keep the new run number intact.
    const started = Promise.withResolvers<void>();
    const blocker = Promise.withResolvers<void>();

    const RestartWorkflow = defineWorkflow(
      { name: "restart-in-flight-workflow" },
      async (_event, step) => {
        await step.do("block", async () => {
          started.resolve();
          await blocker.promise;
          return "done";
        });
        return { ok: true };
      },
    );

    const harness = await createWorkflowsTestHarness({
      workflows: { RESTART: RestartWorkflow },
      adapter: { type: "kysely-sqlite" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
    });

    const instanceId = await harness.createInstance("RESTART");
    const [instance] = await harness.db.find("workflow_instance", (b) => b.whereIndex("primary"));
    expect(instance).toBeTruthy();

    const tickPromise = harness.tick(buildPayload(instance!, "create"));
    await started.promise;

    const restartResponse = await (harness.fragment as AnyFragnoInstantiatedFragment).callRoute(
      "POST",
      "/:workflowName/instances/:instanceId/restart",
      {
        pathParams: { workflowName: "restart-in-flight-workflow", instanceId },
      },
    );
    expect(restartResponse.type).toBe("json");

    blocker.resolve();
    await tickPromise;

    const status = await harness.getStatus("RESTART", instanceId);
    expect(status.status).toBe("active");

    const [updated] = await harness.db.find("workflow_instance", (b) =>
      b.whereIndex("primary", (eb) => eb("id", "=", instance!.id)),
    );
    expect(updated?.runNumber).toBe(instance!.runNumber + 1);
  });
});
