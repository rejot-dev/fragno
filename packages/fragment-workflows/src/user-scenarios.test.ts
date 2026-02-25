import { describe, expect, test } from "vitest";
import {
  defineFragment,
  instantiate,
  type InstantiatedFragmentFromDefinition,
} from "@fragno-dev/core";
import { withDatabase } from "@fragno-dev/db";
import { column, idColumn, schema } from "@fragno-dev/db/schema";
import { defineWorkflow, type AnyTxResult } from "./workflow";
import {
  createScenarioSteps,
  defineScenario,
  runScenario,
  type WorkflowScenarioEventRow,
  type WorkflowScenarioStepRow,
} from "./scenario";

describe("Workflows Runner (User Scenarios)", () => {
  test("loop consumes events until done", async () => {
    // report: loops with unique step names should consume each buffered event exactly once.
    const LoopWorkflow = defineWorkflow({ name: "loop-workflow" }, async (_event, step) => {
      let total = 0;
      for (let i = 0; i < 3; i += 1) {
        const ready = await step.waitForEvent<{ value: number }>(`ready-${i}`, {
          type: "ready",
        });
        total += ready.payload.value;
      }
      return { total };
    });

    const workflows = { LOOP: LoopWorkflow };

    type ScenarioVars = {
      status?: { status: string; output?: { total: number } };
      steps?: WorkflowScenarioStepRow[];
      events?: WorkflowScenarioEventRow[];
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "loop-consumes-events",
      workflows,
      steps: [
        scenarioSteps.create({ workflow: "LOOP", id: "loop-1" }),
        scenarioSteps.event({
          workflow: "LOOP",
          instanceId: "loop-1",
          event: { type: "ready", payload: { value: 1 } },
        }),
        scenarioSteps.event({
          workflow: "LOOP",
          instanceId: "loop-1",
          event: { type: "ready", payload: { value: 2 } },
        }),
        scenarioSteps.event({
          workflow: "LOOP",
          instanceId: "loop-1",
          event: { type: "ready", payload: { value: 3 } },
        }),
        scenarioSteps.runUntilIdle({
          workflow: "LOOP",
          instanceId: "loop-1",
          reason: "create",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("LOOP", "loop-1"),
          storeAs: "status",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("LOOP", "loop-1"),
          storeAs: "steps",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getEvents("LOOP", "loop-1"),
          storeAs: "events",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.status?.status).toBe("complete");
          expect(ctx.vars.status?.output).toEqual({ total: 6 });

          const stepKeys = (ctx.vars.steps ?? []).map((step) => step.stepKey).sort();
          expect(stepKeys).toEqual([
            "waitForEvent:ready-0",
            "waitForEvent:ready-1",
            "waitForEvent:ready-2",
          ]);

          const consumedKeys = (ctx.vars.events ?? [])
            .map((event) => event.consumedByStepKey)
            .sort();
          expect(consumedKeys).toEqual([
            "waitForEvent:ready-0",
            "waitForEvent:ready-1",
            "waitForEvent:ready-2",
          ]);
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("buffered event before wait step is consumed", async () => {
    // report: events queued before a wait step should be delivered once the wait begins.
    const BufferedWorkflow = defineWorkflow(
      { name: "buffered-event-workflow" },
      async (_event, step) => {
        const seed = await step.do("seed", () => 10);
        const ready = await step.waitForEvent<{ value: number }>("ready", { type: "ready" });
        return { sum: seed + ready.payload.value };
      },
    );

    const workflows = { BUFFERED: BufferedWorkflow };

    type ScenarioVars = {
      status?: { status: string; output?: { sum: number } };
      steps?: WorkflowScenarioStepRow[];
      events?: WorkflowScenarioEventRow[];
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "buffered-event-before-wait",
      workflows,
      steps: [
        scenarioSteps.create({ workflow: "BUFFERED", id: "buffered-1" }),
        scenarioSteps.event({
          workflow: "BUFFERED",
          instanceId: "buffered-1",
          event: { type: "ready", payload: { value: 9 } },
        }),
        scenarioSteps.runUntilIdle({
          workflow: "BUFFERED",
          instanceId: "buffered-1",
          reason: "create",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("BUFFERED", "buffered-1"),
          storeAs: "status",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("BUFFERED", "buffered-1"),
          storeAs: "steps",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getEvents("BUFFERED", "buffered-1"),
          storeAs: "events",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.status?.status).toBe("complete");
          expect(ctx.vars.status?.output).toEqual({ sum: 19 });

          const stepKeys = (ctx.vars.steps ?? []).map((step) => step.stepKey).sort();
          expect(stepKeys).toEqual(["do:seed", "waitForEvent:ready"]);

          expect(ctx.vars.events).toHaveLength(1);
          expect(ctx.vars.events?.[0]).toMatchObject({
            type: "ready",
            consumedByStepKey: "waitForEvent:ready",
          });
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("mutate-only service calls can run inside step tx", async () => {
    // report: mutate-only service calls are allowed via tx.serviceCalls.
    const recordSchema = schema("scenario_record", (s) =>
      s.addTable("records", (t) =>
        t.addColumn("id", idColumn()).addColumn("note", column("string")),
      ),
    );

    const recordDefinition = defineFragment("scenario-records")
      .extend(withDatabase(recordSchema))
      .providesService("records", ({ defineService }) =>
        defineService({
          record: function (note: string) {
            return this.serviceTx(recordSchema)
              .mutate(({ uow }) => {
                uow.create("records", { note });
              })
              .build();
          },
          countRecords: function () {
            return this.serviceTx(recordSchema)
              .retrieve((uow) => uow.find("records", (b) => b.whereIndex("primary")))
              .transformRetrieve(([rows]) => rows.length)
              .build();
          },
        }),
      )
      .build();

    let recordFragment: InstantiatedFragmentFromDefinition<typeof recordDefinition>;

    const DirectServiceWorkflow = defineWorkflow(
      { name: "direct-service-workflow" },
      async (event, step) => {
        await step.do("record", (tx) => {
          if (!recordFragment) {
            throw new Error("MISSING_SERVICE");
          }
          tx.serviceCalls(() => [
            recordFragment.services.records.record(`note-${event.instanceId}`) as AnyTxResult,
          ]);
        });
        return { ok: true };
      },
    );

    const workflows = { DIRECT: DirectServiceWorkflow };

    type ScenarioVars = {
      status?: { status: string; output?: { ok: boolean } };
      recordCount?: number;
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "direct-service-call-mutate-only",
      workflows,
      harness: {
        configureBuilder: (builder) =>
          builder.withFragmentFactory("records", recordDefinition, ({ adapter }) => {
            const fragment = instantiate(recordDefinition)
              .withOptions({ databaseAdapter: adapter })
              .build();
            recordFragment = fragment;
            return fragment;
          }),
      },
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({ workflow: "DIRECT", id: "direct-1" }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("DIRECT", "direct-1"),
          storeAs: "status",
        }),
        scenarioSteps.read({
          read: async () => {
            return await recordFragment.inContext(async function () {
              return await this.handlerTx()
                .withServiceCalls(() => [recordFragment.services.records.countRecords()] as const)
                .transform(({ serviceResult: [count] }) => count)
                .execute();
            });
          },
          storeAs: "recordCount",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.status?.status).toBe("complete");
          expect(ctx.vars.status?.output).toEqual({ ok: true });
          expect(ctx.vars.recordCount).toBe(1);
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("retries exhaust and workflow errors", async () => {
    // report: retry limits should stop after the configured attempts and surface an error.
    let attempts = 0;
    const RetryWorkflow = defineWorkflow(
      { name: "retry-exhaust-workflow" },
      async (_event, step) => {
        await step.do(
          "flaky",
          { retries: { limit: 2, delay: "1 minute", backoff: "constant" } },
          () => {
            attempts += 1;
            throw new Error("RETRY_EXHAUSTED");
          },
        );
        return { ok: true };
      },
    );

    const workflows = { RETRY_EXHAUST: RetryWorkflow };

    type ScenarioVars = {
      status?: { status: string; error?: { message?: string } };
      steps?: WorkflowScenarioStepRow[];
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "retry-exhausts",
      workflows,
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({ workflow: "RETRY_EXHAUST", id: "retry-1" }),
        scenarioSteps.retryAndRunUntilIdle({
          workflow: "RETRY_EXHAUST",
          instanceId: "retry-1",
        }),
        scenarioSteps.retryAndRunUntilIdle({
          workflow: "RETRY_EXHAUST",
          instanceId: "retry-1",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("RETRY_EXHAUST", "retry-1"),
          storeAs: "status",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("RETRY_EXHAUST", "retry-1"),
          storeAs: "steps",
        }),
        scenarioSteps.assert((ctx) => {
          expect(attempts).toBe(3);
          expect(ctx.vars.status?.status).toBe("errored");
          expect(ctx.vars.status?.error?.message).toBe("RETRY_EXHAUSTED");

          const step = ctx.vars.steps?.[0];
          expect(step).toMatchObject({
            stepKey: "do:flaky",
            status: "errored",
            attempts: 3,
          });
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("pause during sleep does not freeze the wake timer", async () => {
    // report: sleeping workflows should still complete once resumed if wakeAt already passed.
    const SleepWorkflow = defineWorkflow({ name: "pause-sleep-workflow" }, async (_event, step) => {
      await step.sleep("nap", "10 minutes");
      return { done: true };
    });

    const workflows = { PAUSE_SLEEP: SleepWorkflow };

    type ScenarioVars = {
      waitingSteps?: WorkflowScenarioStepRow[];
      wakeAt?: Date;
      pausedStatus?: { status: string };
      afterResumeSteps?: WorkflowScenarioStepRow[];
      finalStatus?: { status: string; output?: { done: boolean } };
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "pause-sleep-timer",
      workflows,
      steps: [
        scenarioSteps.create({ workflow: "PAUSE_SLEEP", id: "sleep-1" }),
        scenarioSteps.tick({
          workflow: "PAUSE_SLEEP",
          instanceId: "sleep-1",
          reason: "create",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("PAUSE_SLEEP", "sleep-1"),
          storeAs: "waitingSteps",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.vars.waitingSteps?.[0].wakeAt ?? null,
          storeAs: "wakeAt",
        }),
        scenarioSteps.pause({ workflow: "PAUSE_SLEEP", instanceId: "sleep-1" }),
        scenarioSteps.tick({
          workflow: "PAUSE_SLEEP",
          instanceId: "sleep-1",
          reason: "event",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("PAUSE_SLEEP", "sleep-1"),
          storeAs: "pausedStatus",
        }),
        scenarioSteps.read({
          read: (ctx) => {
            const wakeAt = ctx.vars.wakeAt;
            if (!wakeAt) {
              throw new Error("MISSING_WAKE_AT");
            }
            return ctx.clock.set(new Date(wakeAt.getTime() + 5 * 60 * 1000));
          },
        }),
        scenarioSteps.resume({ workflow: "PAUSE_SLEEP", instanceId: "sleep-1" }),
        scenarioSteps.tick({
          workflow: "PAUSE_SLEEP",
          instanceId: "sleep-1",
          reason: "resume",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("PAUSE_SLEEP", "sleep-1"),
          storeAs: "afterResumeSteps",
        }),
        scenarioSteps.tick({
          workflow: "PAUSE_SLEEP",
          instanceId: "sleep-1",
          reason: "wake",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("PAUSE_SLEEP", "sleep-1"),
          storeAs: "finalStatus",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.wakeAt).toBeInstanceOf(Date);
          expect(ctx.vars.pausedStatus?.status).toBe("paused");
          expect(ctx.vars.afterResumeSteps?.[0].wakeAt?.getTime()).toBe(
            (ctx.vars.wakeAt as Date).getTime(),
          );
          expect(ctx.vars.finalStatus?.status).toBe("complete");
          expect(ctx.vars.finalStatus?.output).toEqual({ done: true });
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("completed step is not re-run across ticks", async () => {
    // report: completed steps should replay cached results instead of re-running work.
    let runs = 0;
    const ReplayWorkflow = defineWorkflow(
      { name: "replay-step-workflow" },
      async (_event, step) => {
        const first = await step.do("once", () => {
          runs += 1;
          return runs;
        });
        await step.waitForEvent("ready", { type: "ready" });
        return { first };
      },
    );

    const workflows = { REPLAY: ReplayWorkflow };

    type ScenarioVars = {
      waiting?: { status: string };
      final?: { status: string; output?: { first: number } };
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "step-replay",
      workflows,
      steps: [
        scenarioSteps.create({ workflow: "REPLAY", id: "replay-1" }),
        scenarioSteps.tick({
          workflow: "REPLAY",
          instanceId: "replay-1",
          reason: "create",
        }),
        scenarioSteps.tick({
          workflow: "REPLAY",
          instanceId: "replay-1",
          reason: "event",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("REPLAY", "replay-1"),
          storeAs: "waiting",
        }),
        scenarioSteps.eventAndRunUntilIdle({
          workflow: "REPLAY",
          instanceId: "replay-1",
          event: { type: "ready", payload: { ok: true } },
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("REPLAY", "replay-1"),
          storeAs: "final",
        }),
        scenarioSteps.assert((ctx) => {
          expect(runs).toBe(1);
          expect(ctx.vars.waiting?.status).toBe("waiting");
          expect(ctx.vars.final?.status).toBe("complete");
          expect(ctx.vars.final?.output).toEqual({ first: 1 });
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("constant step name consumes events in order in a loop", async () => {
    // report: reusing a step name should create distinct occurrences and consume events in order.
    const ConstantNameWorkflow = defineWorkflow(
      { name: "constant-name-loop-workflow" },
      async (_event, step) => {
        let total = 0;
        for (let i = 0; i < 2; i += 1) {
          const ready = await step.waitForEvent<{ value: number }>("ready", { type: "ready" });
          total += ready.payload.value;
        }
        return { total };
      },
    );

    const workflows = { CONSTANT: ConstantNameWorkflow };

    type ScenarioVars = {
      status?: { status: string; output?: { total: number } };
      steps?: WorkflowScenarioStepRow[];
      events?: WorkflowScenarioEventRow[];
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "constant-step-name-loop",
      workflows,
      steps: [
        scenarioSteps.create({ workflow: "CONSTANT", id: "constant-1" }),
        scenarioSteps.event({
          workflow: "CONSTANT",
          instanceId: "constant-1",
          event: { type: "ready", payload: { value: 4 } },
          timestamp: new Date(1000),
        }),
        scenarioSteps.event({
          workflow: "CONSTANT",
          instanceId: "constant-1",
          event: { type: "ready", payload: { value: 7 } },
          timestamp: new Date(1001),
        }),
        scenarioSteps.runUntilIdle({
          workflow: "CONSTANT",
          instanceId: "constant-1",
          reason: "create",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("CONSTANT", "constant-1"),
          storeAs: "status",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("CONSTANT", "constant-1"),
          storeAs: "steps",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getEvents("CONSTANT", "constant-1"),
          storeAs: "events",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.status?.status).toBe("complete");
          expect(ctx.vars.status?.output).toEqual({ total: 11 });

          const stepKeys = (ctx.vars.steps ?? []).map((step) => step.stepKey).sort();
          expect(stepKeys).toEqual(["waitForEvent:ready", "waitForEvent:ready#1"]);

          expect(ctx.vars.events).toHaveLength(2);
          const events = [...(ctx.vars.events ?? [])].sort(
            (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
          );
          expect(events[0]?.consumedByStepKey).toBe("waitForEvent:ready");
          expect(events[1]?.consumedByStepKey).toBe("waitForEvent:ready#1");
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("duplicate events with same type are consumed only once per wait step", async () => {
    // report: at-least-once webhook delivery may send the same event multiple times;
    // only one should be consumed by the matching waitForEvent step.
    let completions = 0;
    const WebhookWorkflow = defineWorkflow(
      { name: "webhook-dedup-workflow" },
      async (_event, step) => {
        const approval = await step.waitForEvent<{ approved: boolean }>("approval", {
          type: "approval",
        });
        completions += 1;
        return { approved: approval.payload.approved };
      },
    );

    const workflows = { WEBHOOK: WebhookWorkflow };

    type ScenarioVars = {
      status?: { status: string; output?: { approved: boolean } };
      events?: WorkflowScenarioEventRow[];
      steps?: WorkflowScenarioStepRow[];
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "duplicate-event-idempotency",
      workflows,
      steps: [
        scenarioSteps.create({ workflow: "WEBHOOK", id: "dedup-1" }),
        scenarioSteps.event({
          workflow: "WEBHOOK",
          instanceId: "dedup-1",
          event: { type: "approval", payload: { approved: true } },
          timestamp: new Date(1000),
        }),
        scenarioSteps.event({
          workflow: "WEBHOOK",
          instanceId: "dedup-1",
          event: { type: "approval", payload: { approved: true } },
          timestamp: new Date(1001),
        }),
        scenarioSteps.event({
          workflow: "WEBHOOK",
          instanceId: "dedup-1",
          event: { type: "approval", payload: { approved: true } },
          timestamp: new Date(1002),
        }),
        scenarioSteps.runUntilIdle({
          workflow: "WEBHOOK",
          instanceId: "dedup-1",
          reason: "create",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("WEBHOOK", "dedup-1"),
          storeAs: "status",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("WEBHOOK", "dedup-1"),
          storeAs: "steps",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getEvents("WEBHOOK", "dedup-1"),
          storeAs: "events",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.status?.status).toBe("complete");
          expect(ctx.vars.status?.output).toEqual({ approved: true });

          expect(ctx.vars.steps).toHaveLength(1);
          expect(ctx.vars.steps?.[0]).toMatchObject({
            stepKey: "waitForEvent:approval",
            status: "completed",
          });

          const consumed = (ctx.vars.events ?? []).filter((e) => e.consumedByStepKey !== null);
          expect(consumed).toHaveLength(1);
          expect(consumed[0]?.consumedByStepKey).toBe("waitForEvent:approval");

          const unconsumed = (ctx.vars.events ?? []).filter((e) => e.consumedByStepKey === null);
          expect(unconsumed).toHaveLength(2);

          expect(completions).toBe(1);
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("duplicate events across two sequential wait steps each consume exactly one", async () => {
    // report: with two sequential waitForEvent steps and duplicates of each event type,
    // each step should consume exactly one event.
    const TwoStepWorkflow = defineWorkflow(
      { name: "two-step-dedup-workflow" },
      async (_event, step) => {
        const first = await step.waitForEvent<{ value: number }>("first", { type: "first" });
        const second = await step.waitForEvent<{ value: number }>("second", { type: "second" });
        return { sum: first.payload.value + second.payload.value };
      },
    );

    const workflows = { TWO_STEP: TwoStepWorkflow };

    type ScenarioVars = {
      status?: { status: string; output?: { sum: number } };
      events?: WorkflowScenarioEventRow[];
      steps?: WorkflowScenarioStepRow[];
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "two-step-duplicate-events",
      workflows,
      steps: [
        scenarioSteps.create({ workflow: "TWO_STEP", id: "two-step-1" }),
        scenarioSteps.event({
          workflow: "TWO_STEP",
          instanceId: "two-step-1",
          event: { type: "first", payload: { value: 10 } },
          timestamp: new Date(1000),
        }),
        scenarioSteps.event({
          workflow: "TWO_STEP",
          instanceId: "two-step-1",
          event: { type: "first", payload: { value: 10 } },
          timestamp: new Date(1001),
        }),
        scenarioSteps.runUntilIdle({
          workflow: "TWO_STEP",
          instanceId: "two-step-1",
          reason: "create",
        }),
        scenarioSteps.event({
          workflow: "TWO_STEP",
          instanceId: "two-step-1",
          event: { type: "second", payload: { value: 20 } },
          timestamp: new Date(2000),
        }),
        scenarioSteps.event({
          workflow: "TWO_STEP",
          instanceId: "two-step-1",
          event: { type: "second", payload: { value: 20 } },
          timestamp: new Date(2001),
        }),
        scenarioSteps.runUntilIdle({
          workflow: "TWO_STEP",
          instanceId: "two-step-1",
          reason: "event",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("TWO_STEP", "two-step-1"),
          storeAs: "status",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("TWO_STEP", "two-step-1"),
          storeAs: "steps",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getEvents("TWO_STEP", "two-step-1"),
          storeAs: "events",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.status?.status).toBe("complete");
          expect(ctx.vars.status?.output).toEqual({ sum: 30 });

          const stepKeys = (ctx.vars.steps ?? []).map((s) => s.stepKey).sort();
          expect(stepKeys).toEqual(["waitForEvent:first", "waitForEvent:second"]);

          const firstConsumed = (ctx.vars.events ?? []).filter(
            (e) => e.consumedByStepKey === "waitForEvent:first",
          );
          expect(firstConsumed).toHaveLength(1);

          const secondConsumed = (ctx.vars.events ?? []).filter(
            (e) => e.consumedByStepKey === "waitForEvent:second",
          );
          expect(secondConsumed).toHaveLength(1);

          const unconsumed = (ctx.vars.events ?? []).filter((e) => e.consumedByStepKey === null);
          expect(unconsumed).toHaveLength(2);
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("event created before wakeAt is still accepted", async () => {
    // report: events created before timeout should be consumed even if processed after wakeAt.
    const TimeoutWorkflow = defineWorkflow(
      { name: "event-before-timeout-workflow" },
      async (_event, step) => {
        const ready = await step.waitForEvent<{ ok: boolean }>("ready", {
          type: "ready",
          timeout: "5 minutes",
        });
        return { ok: ready.payload.ok };
      },
    );

    const workflows = { TIMEOUT: TimeoutWorkflow };

    type ScenarioVars = {
      waitingSteps?: WorkflowScenarioStepRow[];
      wakeAt?: Date;
      status?: { status: string; output?: { ok: boolean } };
      steps?: WorkflowScenarioStepRow[];
      events?: WorkflowScenarioEventRow[];
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "event-before-wakeAt",
      workflows,
      steps: [
        scenarioSteps.create({ workflow: "TIMEOUT", id: "timeout-1" }),
        scenarioSteps.tick({
          workflow: "TIMEOUT",
          instanceId: "timeout-1",
          reason: "create",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("TIMEOUT", "timeout-1"),
          storeAs: "waitingSteps",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.vars.waitingSteps?.[0].wakeAt ?? null,
          storeAs: "wakeAt",
        }),
        scenarioSteps.event({
          workflow: "TIMEOUT",
          instanceId: "timeout-1",
          event: { type: "ready", payload: { ok: true } },
        }),
        scenarioSteps.read({
          read: (ctx) => {
            const wakeAt = ctx.vars.wakeAt;
            if (!wakeAt) {
              throw new Error("MISSING_WAKE_AT");
            }
            return ctx.clock.set(new Date(wakeAt.getTime() + 60 * 1000));
          },
        }),
        scenarioSteps.tick({
          workflow: "TIMEOUT",
          instanceId: "timeout-1",
          reason: "wake",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("TIMEOUT", "timeout-1"),
          storeAs: "status",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("TIMEOUT", "timeout-1"),
          storeAs: "steps",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getEvents("TIMEOUT", "timeout-1"),
          storeAs: "events",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.status?.status).toBe("complete");
          expect(ctx.vars.status?.output).toEqual({ ok: true });

          expect(ctx.vars.steps?.[0]).toMatchObject({
            stepKey: "waitForEvent:ready",
            status: "completed",
          });

          expect(ctx.vars.events).toHaveLength(1);
          expect(ctx.vars.events?.[0]).toMatchObject({
            type: "ready",
            consumedByStepKey: "waitForEvent:ready",
          });
        }),
      ],
    });

    await runScenario(scenario);
  });
});
