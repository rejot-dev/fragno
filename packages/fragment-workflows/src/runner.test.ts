// Tests for the new runner using the workflows test harness.
import { describe, expect, test } from "vitest";

// TODO: Missing coverage areas for the runner test suite:
// 1. Instance status fields beyond status/output (error shape, currentStep, pauseRequested)
// 2. Concurrency conflict handling / idempotency of duplicate ticks
import { buildDatabaseFragmentsTest, drainDurableHooks } from "@fragno-dev/test";
import {
  defineFragment,
  instantiate,
  type AnyFragnoInstantiatedFragment,
  type InstantiatedFragmentFromDefinition,
} from "@fragno-dev/core";
import { withDatabase } from "@fragno-dev/db";
import { column, idColumn, schema } from "@fragno-dev/db/schema";
import { defineWorkflow, NonRetryableError } from "./workflow";
import { createWorkflowsTestHarness } from "./test";

describe("Workflows Runner", () => {
  test("runs a simple workflow to completion", async () => {
    const SimpleWorkflow = defineWorkflow({ name: "simple-workflow" }, async () => {
      return { ok: true };
    });

    const harness = await createWorkflowsTestHarness({
      workflows: { SIMPLE: SimpleWorkflow },
      adapter: { type: "kysely-sqlite" },
      testBuilder: buildDatabaseFragmentsTest(),
    });

    const instanceId = await harness.createInstance("SIMPLE");
    await drainDurableHooks(harness.fragment);

    const status = await harness.getStatus("SIMPLE", instanceId);
    expect(status.status).toBe("complete");
    expect(status.output).toEqual({ ok: true });
  });

  test("records a completed step", async () => {
    const StepWorkflow = defineWorkflow({ name: "step-workflow" }, async (_event, step) => {
      const value = await step.do("compute", () => 42);
      return { value };
    });

    const harness = await createWorkflowsTestHarness({
      workflows: { STEP: StepWorkflow },
      adapter: { type: "kysely-sqlite" },
      testBuilder: buildDatabaseFragmentsTest(),
    });

    const instanceId = await harness.createInstance("STEP");
    await drainDurableHooks(harness.fragment);

    const status = await harness.getStatus("STEP", instanceId);
    expect(status.status).toBe("complete");
    expect(status.output).toEqual({ value: 42 });

    const steps = await harness.db.find("workflow_step", (b) => b.whereIndex("primary"));
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      name: "compute",
      type: "do",
      status: "completed",
      stepKey: "do:compute",
    });
  });

  test("runs multiple steps and consumes a queued event", async () => {
    const EventWorkflow = defineWorkflow({ name: "eventful-workflow" }, async (_event, step) => {
      const seed = await step.do("seed", () => 3);
      const ready = await step.waitForEvent<{ value: number }>("ready", { type: "ready" });
      const sum = await step.do("sum", () => seed + ready.payload.value);
      return { seed, sum, eventValue: ready.payload.value };
    });

    const harness = await createWorkflowsTestHarness({
      workflows: { EVENTFUL: EventWorkflow },
      adapter: { type: "kysely-sqlite" },
      testBuilder: buildDatabaseFragmentsTest(),
    });

    const instanceId = await harness.createInstance("EVENTFUL");
    await harness.sendEvent("EVENTFUL", instanceId, { type: "ready", payload: { value: 9 } });
    await drainDurableHooks(harness.fragment);

    const status = await harness.getStatus("EVENTFUL", instanceId);
    expect(status.status).toBe("complete");
    expect(status.output).toEqual({ seed: 3, sum: 12, eventValue: 9 });

    const steps = await harness.db.find("workflow_step", (b) => b.whereIndex("primary"));
    expect(steps).toHaveLength(3);
    expect(steps.map((step) => step.stepKey).sort()).toEqual([
      "do:seed",
      "do:sum",
      "waitForEvent:ready",
    ]);

    const events = await harness.db.find("workflow_event", (b) => b.whereIndex("primary"));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "ready",
      consumedByStepKey: "waitForEvent:ready",
    });
    expect(events[0].deliveredAt).toBeInstanceOf(Date);
  });

  test("runs parallel steps and records both results", async () => {
    const ParallelWorkflow = defineWorkflow({ name: "parallel-workflow" }, async (_event, step) => {
      const [alpha, beta] = await Promise.all([
        step.do("alpha", async () => "A"),
        step.do("beta", async () => "B"),
      ]);
      return { alpha, beta };
    });

    const harness = await createWorkflowsTestHarness({
      workflows: { PARALLEL: ParallelWorkflow },
      adapter: { type: "kysely-sqlite" },
      testBuilder: buildDatabaseFragmentsTest(),
    });

    const instanceId = await harness.createInstance("PARALLEL");
    await drainDurableHooks(harness.fragment);

    const status = await harness.getStatus("PARALLEL", instanceId);
    expect(status.status).toBe("complete");
    expect(status.output).toEqual({ alpha: "A", beta: "B" });

    const steps = await harness.db.find("workflow_step", (b) => b.whereIndex("primary"));
    expect(steps).toHaveLength(2);
    expect(steps.map((step) => step.stepKey).sort()).toEqual(["do:alpha", "do:beta"]);
  });

  test("simulates a fetch inside a step", async () => {
    const FetchWorkflow = defineWorkflow({ name: "fetch-workflow" }, async (_event, step) => {
      const response = await step.do("fetch", async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return { status: 200, json: { ok: true, source: "fake" } };
      });
      return response;
    });

    const harness = await createWorkflowsTestHarness({
      workflows: { FETCH: FetchWorkflow },
      adapter: { type: "kysely-sqlite" },
      testBuilder: buildDatabaseFragmentsTest(),
    });

    const instanceId = await harness.createInstance("FETCH");
    await drainDurableHooks(harness.fragment);

    const status = await harness.getStatus("FETCH", instanceId);
    expect(status.status).toBe("complete");
    expect(status.output).toEqual({
      status: 200,
      json: { ok: true, source: "fake" },
    });

    const steps = await harness.db.find("workflow_step", (b) => b.whereIndex("primary"));
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      name: "fetch",
      type: "do",
      status: "completed",
      stepKey: "do:fetch",
    });
  });

  test("waits for an event before completing", async () => {
    // Theory: initial "create" tick may be treated as a wake run, so waitForEvent
    // goes down the wake path and errors immediately. If so, we should only use
    // taskKind="wake" for actual wake/retry hooks, not create/event/resume.
    const WaitWorkflow = defineWorkflow({ name: "wait-workflow" }, async (_event, step) => {
      const ready = await step.waitForEvent<{ ok: boolean }>("ready", { type: "ready" });
      return { ok: ready.payload.ok };
    });

    const harness = await createWorkflowsTestHarness({
      workflows: { WAIT: WaitWorkflow },
      adapter: { type: "kysely-sqlite" },
      testBuilder: buildDatabaseFragmentsTest(),
    });

    const instanceId = await harness.createInstance("WAIT");
    await drainDurableHooks(harness.fragment);

    const waitingStatus = await harness.getStatus("WAIT", instanceId);
    expect(waitingStatus.status).toBe("waiting");

    const [waitingStep] = await harness.db.find("workflow_step", (b) => b.whereIndex("primary"));
    expect(waitingStep).toMatchObject({
      stepKey: "waitForEvent:ready",
      status: "waiting",
    });

    await harness.sendEvent("WAIT", instanceId, { type: "ready", payload: { ok: true } });
    await drainDurableHooks(harness.fragment);

    const finalStatus = await harness.getStatus("WAIT", instanceId);
    expect(finalStatus.status).toBe("complete");
    expect(finalStatus.output).toEqual({ ok: true });
  });

  test("suspends on sleep and marks wake time", async () => {
    // Theory: sleep is completing immediately because the runner treats the first tick as
    // a wake attempt. That would bypass suspension and mark the sleep as completed.
    const SleepWorkflow = defineWorkflow({ name: "sleep-workflow" }, async (_event, step) => {
      await step.sleep("nap", "10 minutes");
      return { done: true };
    });

    const harness = await createWorkflowsTestHarness({
      workflows: { SLEEP: SleepWorkflow },
      adapter: { type: "kysely-sqlite" },
      testBuilder: buildDatabaseFragmentsTest(),
    });

    const instanceId = await harness.createInstance("SLEEP");
    await drainDurableHooks(harness.fragment);

    const status = await harness.getStatus("SLEEP", instanceId);
    expect(status.status).toBe("waiting");

    const [stepRecord] = await harness.db.find("workflow_step", (b) => b.whereIndex("primary"));
    expect(stepRecord).toMatchObject({
      stepKey: "sleep:nap",
      status: "waiting",
    });
    expect(stepRecord?.wakeAt).toBeInstanceOf(Date);
  });

  test("completes sleep on explicit wake tick", async () => {
    const SleepWorkflow = defineWorkflow({ name: "sleep-wake-workflow" }, async (_event, step) => {
      await step.sleep("nap", "10 minutes");
      return { done: true };
    });

    const harness = await createWorkflowsTestHarness({
      workflows: { SLEEP_WAKE: SleepWorkflow },
      adapter: { type: "kysely-sqlite" },
      testBuilder: buildDatabaseFragmentsTest(),
    });

    const instanceId = await harness.createInstance("SLEEP_WAKE");
    await drainDurableHooks(harness.fragment);

    const waitingStatus = await harness.getStatus("SLEEP_WAKE", instanceId);
    expect(waitingStatus.status).toBe("waiting");

    const [instance] = await harness.db.find("workflow_instance", (b) => b.whereIndex("primary"));
    expect(instance).toBeTruthy();

    harness.clock.advanceBy("10 minutes");
    await harness.tick({
      workflowName: instance!.workflowName,
      instanceId: instance!.instanceId,
      instanceRef: String(instance!.id),
      runNumber: instance!.runNumber,
      reason: "wake",
    });

    const finalStatus = await harness.getStatus("SLEEP_WAKE", instanceId);
    expect(finalStatus.status).toBe("complete");
    expect(finalStatus.output).toEqual({ done: true });
  });

  test("suspends on sleepUntil and completes on wake", async () => {
    let wakeAt: Date | null = null;

    const SleepUntilWorkflow = defineWorkflow(
      { name: "sleep-until-workflow" },
      async (_event, step) => {
        if (!wakeAt) {
          throw new Error("MISSING_WAKE_AT");
        }
        await step.sleepUntil("alarm", wakeAt);
        return { done: true };
      },
    );

    const harness = await createWorkflowsTestHarness({
      workflows: { SLEEP_UNTIL: SleepUntilWorkflow },
      adapter: { type: "kysely-sqlite" },
      testBuilder: buildDatabaseFragmentsTest(),
    });

    const instanceId = await harness.createInstance("SLEEP_UNTIL");
    wakeAt = new Date(harness.clock.now().getTime() + 5 * 60 * 1000);
    await drainDurableHooks(harness.fragment);

    const waitingStatus = await harness.getStatus("SLEEP_UNTIL", instanceId);
    expect(waitingStatus.status).toBe("waiting");

    const [stepRecord] = await harness.db.find("workflow_step", (b) => b.whereIndex("primary"));
    expect(stepRecord).toMatchObject({
      stepKey: "sleep:alarm",
      status: "waiting",
    });
    expect(stepRecord.wakeAt?.getTime()).toBe(wakeAt.getTime());

    const [instance] = await harness.db.find("workflow_instance", (b) => b.whereIndex("primary"));
    expect(instance).toBeTruthy();

    harness.clock.set(wakeAt);
    await harness.tick({
      workflowName: instance!.workflowName,
      instanceId: instance!.instanceId,
      instanceRef: String(instance!.id),
      runNumber: instance!.runNumber,
      reason: "wake",
    });

    const finalStatus = await harness.getStatus("SLEEP_UNTIL", instanceId);
    expect(finalStatus.status).toBe("complete");
    expect(finalStatus.output).toEqual({ done: true });
  });

  test("waitForEvent times out on wake tick", async () => {
    const TimeoutWorkflow = defineWorkflow(
      { name: "event-timeout-workflow" },
      async (_event, step) => {
        await step.waitForEvent("ready", { type: "ready", timeout: "5 minutes" });
        return { ok: true };
      },
    );

    const harness = await createWorkflowsTestHarness({
      workflows: { TIMEOUT: TimeoutWorkflow },
      adapter: { type: "kysely-sqlite" },
      testBuilder: buildDatabaseFragmentsTest(),
    });

    const instanceId = await harness.createInstance("TIMEOUT");
    await drainDurableHooks(harness.fragment);

    const waitingStatus = await harness.getStatus("TIMEOUT", instanceId);
    expect(waitingStatus.status).toBe("waiting");

    const [stepRecord] = await harness.db.find("workflow_step", (b) => b.whereIndex("primary"));
    expect(stepRecord).toMatchObject({
      stepKey: "waitForEvent:ready",
      status: "waiting",
      waitEventType: "ready",
    });
    expect(stepRecord.wakeAt).toBeInstanceOf(Date);

    const [instance] = await harness.db.find("workflow_instance", (b) => b.whereIndex("primary"));
    expect(instance).toBeTruthy();

    const wakeAt = stepRecord.wakeAt ?? harness.clock.now();
    harness.clock.set(new Date(wakeAt.getTime() + 1));
    await harness.tick({
      workflowName: instance!.workflowName,
      instanceId: instance!.instanceId,
      instanceRef: String(instance!.id),
      runNumber: instance!.runNumber,
      reason: "wake",
    });

    const finalStatus = await harness.getStatus("TIMEOUT", instanceId);
    expect(finalStatus.status).toBe("errored");
    expect(finalStatus.error?.message).toBe("WAIT_FOR_EVENT_TIMEOUT");

    const [erroredStep] = await harness.db.find("workflow_step", (b) => b.whereIndex("primary"));
    expect(erroredStep).toMatchObject({
      stepKey: "waitForEvent:ready",
      status: "errored",
      errorMessage: "WAIT_FOR_EVENT_TIMEOUT",
    });
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

    await harness.tick({
      workflowName: instance!.workflowName,
      instanceId: instance!.instanceId,
      instanceRef: String(instance!.id),
      runNumber: instance!.runNumber,
      reason: "wake",
    });

    const finalStatus = await harness.getStatus("TIMEOUT", instanceId);
    expect(finalStatus.status).toBe("errored");
    expect(finalStatus.error?.message).toBe("WAIT_FOR_EVENT_TIMEOUT");
  });

  test("getHistory returns ordered step and event data", async () => {
    const HistoryWorkflow = defineWorkflow({ name: "history-workflow" }, async (_event, step) => {
      const seed = await step.do("seed", () => 3);
      const ready = await step.waitForEvent<{ ok: boolean }>("ready", { type: "ready" });
      const result = await step.do("result", () => (ready.payload.ok ? seed + 1 : seed));
      return { result };
    });

    const harness = await createWorkflowsTestHarness({
      workflows: { HISTORY: HistoryWorkflow },
      adapter: { type: "kysely-sqlite" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
    });

    const instanceId = await harness.createInstance("HISTORY");
    const [instance] = await harness.db.find("workflow_instance", (b) => b.whereIndex("primary"));
    expect(instance).toBeTruthy();

    await harness.tick({
      workflowName: instance!.workflowName,
      instanceId: instance!.instanceId,
      instanceRef: String(instance!.id),
      runNumber: instance!.runNumber,
      reason: "create",
    });

    let status = await harness.getStatus("HISTORY", instanceId);
    expect(status.status).toBe("waiting");

    await harness.sendEvent("HISTORY", instanceId, { type: "ready", payload: { ok: true } });
    await harness.tick({
      workflowName: instance!.workflowName,
      instanceId: instance!.instanceId,
      instanceRef: String(instance!.id),
      runNumber: instance!.runNumber,
      reason: "event",
    });

    status = await harness.getStatus("HISTORY", instanceId);
    expect(status.status).toBe("complete");

    const history = await harness.getHistory("HISTORY", instanceId);
    expect(history.runNumber).toBe(0);

    const stepKeys = history.steps.map((step) => step.stepKey).sort();
    expect(stepKeys).toEqual(["do:result", "do:seed", "waitForEvent:ready"]);

    const stepTimestamps = history.steps.map((step) =>
      new Date(step.createdAt as Date | string).getTime(),
    );
    expect([...stepTimestamps].sort((a, b) => b - a)).toEqual(stepTimestamps);

    expect(history.events).toHaveLength(1);
    expect(history.events[0]).toMatchObject({
      type: "ready",
      payload: { ok: true },
      consumedByStepKey: "waitForEvent:ready",
    });
    const deliveredAt = history.events[0].deliveredAt;
    expect(deliveredAt).toBeTruthy();
    expect(new Date(deliveredAt as Date | string).toString()).not.toBe("Invalid Date");

    const historyByRun = await harness.getHistory("HISTORY", instanceId, { runNumber: 0 });
    expect(historyByRun.runNumber).toBe(0);
    expect(historyByRun.steps).toHaveLength(3);
    expect(historyByRun.events).toHaveLength(1);
  });

  test("consumes multiple events of the same type in order", async () => {
    const EventOrderWorkflow = defineWorkflow(
      { name: "event-order-workflow" },
      async (_event, step) => {
        const first = await step.waitForEvent<{ value: number }>("first", {
          type: "ready",
        });
        const second = await step.waitForEvent<{ value: number }>("second", {
          type: "ready",
        });
        return { first: first.payload.value, second: second.payload.value };
      },
    );

    const harness = await createWorkflowsTestHarness({
      workflows: { EVENT_ORDER: EventOrderWorkflow },
      adapter: { type: "kysely-sqlite" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
    });

    const instanceId = await harness.createInstance("EVENT_ORDER");
    const [instance] = await harness.db.find("workflow_instance", (b) => b.whereIndex("primary"));
    expect(instance).toBeTruthy();

    await harness.tick({
      workflowName: instance!.workflowName,
      instanceId: instance!.instanceId,
      instanceRef: String(instance!.id),
      runNumber: instance!.runNumber,
      reason: "create",
    });

    await harness.sendEvent("EVENT_ORDER", instanceId, {
      type: "ready",
      payload: { value: 1 },
    });
    await harness.sendEvent("EVENT_ORDER", instanceId, {
      type: "ready",
      payload: { value: 2 },
    });

    await harness.tick({
      workflowName: instance!.workflowName,
      instanceId: instance!.instanceId,
      instanceRef: String(instance!.id),
      runNumber: instance!.runNumber,
      reason: "event",
    });

    const finalStatus = await harness.getStatus("EVENT_ORDER", instanceId);
    expect(finalStatus.status).toBe("complete");

    const events = await harness.db.find("workflow_event", (b) => b.whereIndex("primary"));
    expect(events).toHaveLength(2);

    const [firstEvent, secondEvent] = [...events].sort((a, b) =>
      String(a.id).localeCompare(String(b.id)),
    );

    expect(finalStatus.output).toEqual({
      first: (firstEvent.payload as { value: number }).value,
      second: (secondEvent.payload as { value: number }).value,
    });
    expect(firstEvent).toMatchObject({
      type: "ready",
      consumedByStepKey: "waitForEvent:first",
    });
    expect(secondEvent).toMatchObject({
      type: "ready",
      consumedByStepKey: "waitForEvent:second",
    });
  });

  test("treats event hooks as run ticks", async () => {
    const EventReasonWorkflow = defineWorkflow(
      { name: "event-reason-workflow" },
      async (_event, step) => {
        const ready = await step.waitForEvent<{ ok: boolean }>("ready", { type: "ready" });
        return { ok: ready.payload.ok };
      },
    );

    const harness = await createWorkflowsTestHarness({
      workflows: { EVENT_REASON: EventReasonWorkflow },
      adapter: { type: "kysely-sqlite" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
    });

    const instanceId = await harness.createInstance("EVENT_REASON");
    const [instance] = await harness.db.find("workflow_instance", (b) => b.whereIndex("primary"));
    expect(instance).toBeTruthy();

    await harness.tick({
      workflowName: instance!.workflowName,
      instanceId: instance!.instanceId,
      instanceRef: String(instance!.id),
      runNumber: instance!.runNumber,
      reason: "create",
    });

    let status = await harness.getStatus("EVENT_REASON", instanceId);
    expect(status.status).toBe("waiting");

    await harness.tick({
      workflowName: instance!.workflowName,
      instanceId: instance!.instanceId,
      instanceRef: String(instance!.id),
      runNumber: instance!.runNumber,
      reason: "event",
    });

    status = await harness.getStatus("EVENT_REASON", instanceId);
    expect(status.status).toBe("waiting");

    const [stepRecord] = await harness.db.find("workflow_step", (b) => b.whereIndex("primary"));
    expect(stepRecord).toMatchObject({
      stepKey: "waitForEvent:ready",
      status: "waiting",
      waitEventType: "ready",
    });
  });

  test("treats resume hooks as run ticks", async () => {
    const ResumeReasonWorkflow = defineWorkflow(
      { name: "resume-reason-workflow" },
      async (_event, step) => {
        const ready = await step.waitForEvent<{ ok: boolean }>("ready", { type: "ready" });
        return { ok: ready.payload.ok };
      },
    );

    const harness = await createWorkflowsTestHarness({
      workflows: { RESUME_REASON: ResumeReasonWorkflow },
      adapter: { type: "kysely-sqlite" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
    });

    const instanceId = await harness.createInstance("RESUME_REASON");
    const [instance] = await harness.db.find("workflow_instance", (b) => b.whereIndex("primary"));
    expect(instance).toBeTruthy();

    await harness.tick({
      workflowName: instance!.workflowName,
      instanceId: instance!.instanceId,
      instanceRef: String(instance!.id),
      runNumber: instance!.runNumber,
      reason: "create",
    });

    let status = await harness.getStatus("RESUME_REASON", instanceId);
    expect(status.status).toBe("waiting");

    const pauseResponse = await (harness.fragment as AnyFragnoInstantiatedFragment).callRoute(
      "POST",
      "/:workflowName/instances/:instanceId/pause",
      {
        pathParams: { workflowName: "resume-reason-workflow", instanceId },
      },
    );
    expect(pauseResponse.type).toBe("json");
    if (pauseResponse.type !== "json") {
      throw new Error(`Unexpected response: ${pauseResponse.type}`);
    }
    expect((pauseResponse.data as { ok: true }).ok).toBe(true);

    const pausedStatus = await harness.getStatus("RESUME_REASON", instanceId);
    expect(pausedStatus.status).toBe("paused");

    const resumeResponse = await (harness.fragment as AnyFragnoInstantiatedFragment).callRoute(
      "POST",
      "/:workflowName/instances/:instanceId/resume",
      {
        pathParams: { workflowName: "resume-reason-workflow", instanceId },
      },
    );
    expect(resumeResponse.type).toBe("json");
    if (resumeResponse.type !== "json") {
      throw new Error(`Unexpected response: ${resumeResponse.type}`);
    }
    expect((resumeResponse.data as { ok: true }).ok).toBe(true);

    const queuedStatus = await harness.getStatus("RESUME_REASON", instanceId);
    expect(queuedStatus.status).toBe("queued");

    await harness.tick({
      workflowName: instance!.workflowName,
      instanceId: instance!.instanceId,
      instanceRef: String(instance!.id),
      runNumber: instance!.runNumber,
      reason: "resume",
    });

    status = await harness.getStatus("RESUME_REASON", instanceId);
    expect(status.status).toBe("waiting");

    const [stepRecord] = await harness.db.find("workflow_step", (b) => b.whereIndex("primary"));
    expect(stepRecord).toMatchObject({
      stepKey: "waitForEvent:ready",
      status: "waiting",
      waitEventType: "ready",
    });
  });

  test("keeps paused workflows from consuming events until resume", async () => {
    const PauseEventWorkflow = defineWorkflow(
      { name: "pause-event-workflow" },
      async (_event, step) => {
        const ready = await step.waitForEvent<{ ok: boolean }>("ready", { type: "ready" });
        return { ok: ready.payload.ok };
      },
    );

    const harness = await createWorkflowsTestHarness({
      workflows: { PAUSE_EVENT: PauseEventWorkflow },
      adapter: { type: "kysely-sqlite" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
    });

    const instanceId = await harness.createInstance("PAUSE_EVENT");
    const [instance] = await harness.db.find("workflow_instance", (b) => b.whereIndex("primary"));
    expect(instance).toBeTruthy();

    await harness.tick({
      workflowName: instance!.workflowName,
      instanceId: instance!.instanceId,
      instanceRef: String(instance!.id),
      runNumber: instance!.runNumber,
      reason: "create",
    });

    let status = await harness.getStatus("PAUSE_EVENT", instanceId);
    expect(status.status).toBe("waiting");

    const pauseResponse = await (harness.fragment as AnyFragnoInstantiatedFragment).callRoute(
      "POST",
      "/:workflowName/instances/:instanceId/pause",
      {
        pathParams: { workflowName: "pause-event-workflow", instanceId },
      },
    );
    expect(pauseResponse.type).toBe("json");
    if (pauseResponse.type !== "json") {
      throw new Error(`Unexpected response: ${pauseResponse.type}`);
    }
    expect((pauseResponse.data as { ok: true }).ok).toBe(true);

    status = await harness.getStatus("PAUSE_EVENT", instanceId);
    expect(status.status).toBe("paused");

    await harness.sendEvent("PAUSE_EVENT", instanceId, {
      type: "ready",
      payload: { ok: true },
    });

    status = await harness.getStatus("PAUSE_EVENT", instanceId);
    expect(status.status).toBe("paused");

    const [eventRecord] = await harness.db.find("workflow_event", (b) => b.whereIndex("primary"));
    expect(eventRecord).toMatchObject({
      type: "ready",
      consumedByStepKey: null,
      deliveredAt: null,
    });

    const resumeResponse = await (harness.fragment as AnyFragnoInstantiatedFragment).callRoute(
      "POST",
      "/:workflowName/instances/:instanceId/resume",
      {
        pathParams: { workflowName: "pause-event-workflow", instanceId },
      },
    );
    expect(resumeResponse.type).toBe("json");
    if (resumeResponse.type !== "json") {
      throw new Error(`Unexpected response: ${resumeResponse.type}`);
    }
    expect((resumeResponse.data as { ok: true }).ok).toBe(true);

    const queuedStatus = await harness.getStatus("PAUSE_EVENT", instanceId);
    expect(queuedStatus.status).toBe("queued");

    await harness.tick({
      workflowName: instance!.workflowName,
      instanceId: instance!.instanceId,
      instanceRef: String(instance!.id),
      runNumber: instance!.runNumber,
      reason: "resume",
    });

    const finalStatus = await harness.getStatus("PAUSE_EVENT", instanceId);
    expect(finalStatus.status).toBe("complete");
    expect(finalStatus.output).toEqual({ ok: true });

    const [consumedEvent] = await harness.db.find("workflow_event", (b) => b.whereIndex("primary"));
    expect(consumedEvent).toMatchObject({
      type: "ready",
      consumedByStepKey: "waitForEvent:ready",
    });
    expect(consumedEvent.deliveredAt).toBeInstanceOf(Date);
  });

  test("applies WorkflowStepTx mutations", async () => {
    const mutationsSchema = schema("mutations_test", (s) =>
      s.addTable("mutation_record", (t) =>
        t
          .addColumn("id", idColumn())
          .addColumn("note", column("string"))
          .addColumn(
            "createdAt",
            column("timestamp").defaultTo((b) => b.now()),
          )
          .createIndex("idx_note", ["note"]),
      ),
    );

    const mutationsFragmentDefinition = defineFragment("mutations-fragment")
      .extend(withDatabase(mutationsSchema))
      .build();

    const MutateWorkflow = defineWorkflow({ name: "mutate-workflow" }, async (event, step) => {
      const note = `fromTx-${event.instanceId}`;
      const result = await step.do("mutate", (tx) => {
        tx.mutate((ctx) => {
          ctx.forSchema(mutationsSchema).create("mutation_record", { note });
        });
        return "mutated";
      });
      return { result };
    });

    const harness = await createWorkflowsTestHarness({
      workflows: { MUTATE: MutateWorkflow },
      adapter: { type: "kysely-sqlite" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
      configureBuilder: (builder) =>
        builder.withFragment("mutations", instantiate(mutationsFragmentDefinition)),
    });

    const instanceId = await harness.createInstance("MUTATE");
    const [createdInstance] = await harness.db.find("workflow_instance", (b) =>
      b.whereIndex("primary"),
    );
    const note = `fromTx-${instanceId}`;

    await harness.tick({
      workflowName: createdInstance.workflowName,
      instanceId: createdInstance.instanceId,
      instanceRef: String(createdInstance.id),
      runNumber: createdInstance.runNumber,
      reason: "create",
    });

    const status = await harness.getStatus("MUTATE", instanceId);
    expect(status.status).toBe("complete");
    expect(status.output).toEqual({ result: "mutated" });

    const mutationRows = await harness.fragments["mutations"].db.find("mutation_record", (b) =>
      b.whereIndex("primary"),
    );
    expect(mutationRows).toHaveLength(1);
    expect(mutationRows[0]).toMatchObject({ note });
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

    await harness.tick({
      workflowName: instance!.workflowName,
      instanceId: instance!.instanceId,
      instanceRef: String(instance!.id),
      runNumber: instance!.runNumber,
      reason: "create",
    });

    const status = await harness.getStatus("MUTATION_ERROR", instanceId);
    expect(status.status).toBe("errored");
    expect(status.error?.message).toBeTruthy();

    const mutationRows = await harness.fragments["mutationError"].db.find("mutation_record", (b) =>
      b.whereIndex("primary"),
    );
    expect(mutationRows).toHaveLength(0);
  });

  test("rejects non-mutate serviceCalls in WorkflowStepTx", async () => {
    const serviceCallsSchema = schema("service_calls_test", (s) =>
      s.addTable("service_record", (t) =>
        t
          .addColumn("id", idColumn())
          .addColumn("note", column("string"))
          .addColumn(
            "createdAt",
            column("timestamp").defaultTo((b) => b.now()),
          )
          .createIndex("idx_note", ["note"]),
      ),
    );

    const serviceCallsFragmentDefinition = defineFragment("service-calls-fragment")
      .extend(withDatabase(serviceCallsSchema))
      .providesBaseService(({ defineService }) =>
        defineService({
          listRecords: function () {
            return this.serviceTx(serviceCallsSchema)
              .retrieve((uow) => uow.find("service_record", (b) => b.whereIndex("primary")))
              .build();
          },
        }),
      )
      .build();

    let serviceCallFragment: InstantiatedFragmentFromDefinition<
      typeof serviceCallsFragmentDefinition
    >;

    const ServiceCallWorkflow = defineWorkflow(
      { name: "service-call-workflow" },
      async (_event, step) => {
        await step.do("call", (tx) => {
          tx.serviceCalls(() => [serviceCallFragment.services.listRecords()]);
          return "queued";
        });
        return { ok: true };
      },
    );

    const harness = await createWorkflowsTestHarness({
      workflows: { SERVICE_CALL: ServiceCallWorkflow },
      adapter: { type: "kysely-sqlite" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
      configureBuilder: (builder) =>
        builder.withFragmentFactory(
          "serviceCalls",
          serviceCallsFragmentDefinition,
          ({ adapter }) => {
            const fragment = instantiate(serviceCallsFragmentDefinition)
              .withOptions({ databaseAdapter: adapter })
              .build();
            serviceCallFragment = fragment;
            return fragment;
          },
        ),
    });

    const instanceId = await harness.createInstance("SERVICE_CALL");

    const [instance] = await harness.db.find("workflow_instance", (b) => b.whereIndex("primary"));
    expect(instance).toBeTruthy();

    await harness.tick({
      workflowName: instance!.workflowName,
      instanceId: instance!.instanceId,
      instanceRef: String(instance!.id),
      runNumber: instance!.runNumber,
      reason: "create",
    });

    const status = await harness.getStatus("SERVICE_CALL", instanceId);
    expect(status.status).toBe("errored");
    expect(status.error?.message).toBe("WORKFLOW_STEP_TX_RETRIEVE_NOT_SUPPORTED");
  });

  test("retries a failed step and succeeds", async () => {
    let attempts = 0;
    const RetryWorkflow = defineWorkflow({ name: "retry-workflow" }, async (_event, step) => {
      const result = await step.do(
        "unstable",
        { retries: { limit: 1, delay: 0, backoff: "constant" } },
        () => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("RETRY_ME");
          }
          return "ok";
        },
      );
      return { result };
    });

    const harness = await createWorkflowsTestHarness({
      workflows: { RETRY: RetryWorkflow },
      adapter: { type: "kysely-sqlite" },
      testBuilder: buildDatabaseFragmentsTest(),
    });

    const instanceId = await harness.createInstance("RETRY");
    await drainDurableHooks(harness.fragment);

    const status = await harness.getStatus("RETRY", instanceId);
    expect(status.status).toBe("complete");
    expect(status.output).toEqual({ result: "ok" });

    const [stepRecord] = await harness.db.find("workflow_step", (b) => b.whereIndex("primary"));
    expect(stepRecord).toMatchObject({
      stepKey: "do:unstable",
      status: "completed",
      attempts: 2,
    });
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

  test("marks workflow errored when step throws", async () => {
    const ErrorWorkflow = defineWorkflow({ name: "error-workflow" }, async (_event, step) => {
      await step.do("boom", () => {
        throw new Error("BOOM");
      });
      return { ok: true };
    });

    const harness = await createWorkflowsTestHarness({
      workflows: { ERROR: ErrorWorkflow },
      adapter: { type: "kysely-sqlite" },
      testBuilder: buildDatabaseFragmentsTest(),
    });

    const instanceId = await harness.createInstance("ERROR");
    await drainDurableHooks(harness.fragment);

    const status = await harness.getStatus("ERROR", instanceId);
    expect(status.status).toBe("errored");

    const [stepRecord] = await harness.db.find("workflow_step", (b) => b.whereIndex("primary"));
    expect(stepRecord).toMatchObject({
      stepKey: "do:boom",
      status: "errored",
    });
  });

  test("pauses a queued instance and resumes to completion", async () => {
    let runs = 0;
    const PauseWorkflow = defineWorkflow(
      { name: "pause-management-workflow" },
      async (_event, step) => {
        const value = await step.do("count", () => {
          runs += 1;
          return runs;
        });
        return { value };
      },
    );

    const harness = await createWorkflowsTestHarness({
      workflows: { PAUSE: PauseWorkflow },
      adapter: { type: "kysely-sqlite" },
      testBuilder: buildDatabaseFragmentsTest(),
    });

    const instanceId = await harness.createInstance("PAUSE");

    const pauseResponse = await (harness.fragment as AnyFragnoInstantiatedFragment).callRoute(
      "POST",
      "/:workflowName/instances/:instanceId/pause",
      {
        pathParams: { workflowName: "pause-management-workflow", instanceId },
      },
    );
    expect(pauseResponse.type).toBe("json");
    if (pauseResponse.type !== "json") {
      throw new Error(`Unexpected response: ${pauseResponse.type}`);
    }
    expect((pauseResponse.data as { ok: true }).ok).toBe(true);

    const pausedStatus = await harness.getStatus("PAUSE", instanceId);
    expect(pausedStatus.status).toBe("paused");

    await drainDurableHooks(harness.fragment);

    const stillPaused = await harness.getStatus("PAUSE", instanceId);
    expect(stillPaused.status).toBe("paused");
    expect(runs).toBe(0);

    const resumeResponse = await (harness.fragment as AnyFragnoInstantiatedFragment).callRoute(
      "POST",
      "/:workflowName/instances/:instanceId/resume",
      {
        pathParams: { workflowName: "pause-management-workflow", instanceId },
      },
    );
    expect(resumeResponse.type).toBe("json");
    if (resumeResponse.type !== "json") {
      throw new Error(`Unexpected response: ${resumeResponse.type}`);
    }
    expect((resumeResponse.data as { ok: true }).ok).toBe(true);

    await drainDurableHooks(harness.fragment);

    const finalStatus = await harness.getStatus("PAUSE", instanceId);
    expect(finalStatus.status).toBe("complete");
    expect(finalStatus.output).toEqual({ value: 1 });

    const [instance] = await harness.db.find("workflow_instance", (b) => b.whereIndex("primary"));
    expect(instance).toMatchObject({
      status: "complete",
      pauseRequested: false,
    });
  });

  test("terminates a queued instance and ignores pending ticks", async () => {
    let runs = 0;
    const TerminateWorkflow = defineWorkflow(
      { name: "terminate-management-workflow" },
      async (_event, step) => {
        const value = await step.do("count", () => {
          runs += 1;
          return runs;
        });
        return { value };
      },
    );

    const harness = await createWorkflowsTestHarness({
      workflows: { TERM: TerminateWorkflow },
      adapter: { type: "kysely-sqlite" },
      testBuilder: buildDatabaseFragmentsTest(),
    });

    const instanceId = await harness.createInstance("TERM");

    const terminateResponse = await (harness.fragment as AnyFragnoInstantiatedFragment).callRoute(
      "POST",
      "/:workflowName/instances/:instanceId/terminate",
      {
        pathParams: { workflowName: "terminate-management-workflow", instanceId },
      },
    );
    expect(terminateResponse.type).toBe("json");
    if (terminateResponse.type !== "json") {
      throw new Error(`Unexpected response: ${terminateResponse.type}`);
    }
    expect((terminateResponse.data as { ok: true }).ok).toBe(true);

    await drainDurableHooks(harness.fragment);

    const status = await harness.getStatus("TERM", instanceId);
    expect(status.status).toBe("terminated");
    expect(runs).toBe(0);

    const steps = await harness.db.find("workflow_step", (b) => b.whereIndex("primary"));
    expect(steps).toHaveLength(0);

    const [instance] = await harness.db.find("workflow_instance", (b) => b.whereIndex("primary"));
    expect(instance).toMatchObject({
      status: "terminated",
      pauseRequested: false,
    });
    expect(instance.completedAt).toBeInstanceOf(Date);
  });

  test("restarts a completed instance with a new run", async () => {
    let runs = 0;
    const RestartWorkflow = defineWorkflow(
      { name: "restart-management-workflow" },
      async (_event, step) => {
        const value = await step.do("count", () => {
          runs += 1;
          return runs;
        });
        return { value };
      },
    );

    const harness = await createWorkflowsTestHarness({
      workflows: { RESTART: RestartWorkflow },
      adapter: { type: "kysely-sqlite" },
      testBuilder: buildDatabaseFragmentsTest(),
    });

    const instanceId = await harness.createInstance("RESTART");
    await drainDurableHooks(harness.fragment);

    const firstStatus = await harness.getStatus("RESTART", instanceId);
    expect(firstStatus.status).toBe("complete");
    expect(firstStatus.output).toEqual({ value: 1 });

    const restartResponse = await (harness.fragment as AnyFragnoInstantiatedFragment).callRoute(
      "POST",
      "/:workflowName/instances/:instanceId/restart",
      {
        pathParams: { workflowName: "restart-management-workflow", instanceId },
      },
    );
    expect(restartResponse.type).toBe("json");
    if (restartResponse.type !== "json") {
      throw new Error(`Unexpected response: ${restartResponse.type}`);
    }
    expect((restartResponse.data as { ok: true }).ok).toBe(true);

    const queuedStatus = await harness.getStatus("RESTART", instanceId);
    expect(queuedStatus.status).toBe("queued");
    expect(queuedStatus.output).toBeUndefined();

    await drainDurableHooks(harness.fragment);

    const finalStatus = await harness.getStatus("RESTART", instanceId);
    expect(finalStatus.status).toBe("complete");
    expect(finalStatus.output).toEqual({ value: 2 });

    const [instance] = await harness.db.find("workflow_instance", (b) => b.whereIndex("primary"));
    expect(instance.runNumber).toBe(1);

    const steps = await harness.db.find("workflow_step", (b) => b.whereIndex("primary"));
    expect(steps).toHaveLength(2);
    expect(steps.map((step) => step.runNumber).sort((a, b) => a - b)).toEqual([0, 1]);
  });

  test("createBatch creates multiple instances and runs them", async () => {
    const BatchWorkflow = defineWorkflow({ name: "batch-workflow" }, async (event, step) => {
      const result = await step.do("result", () => ({
        instanceId: event.instanceId,
      }));
      return result;
    });

    const harness = await createWorkflowsTestHarness({
      workflows: { BATCH: BatchWorkflow },
      adapter: { type: "kysely-sqlite" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
    });

    const response = await (harness.fragment as AnyFragnoInstantiatedFragment).callRoute(
      "POST",
      "/:workflowName/instances/batch",
      {
        pathParams: { workflowName: "batch-workflow" },
        body: { instances: [{ id: "batch-1" }, { id: "batch-2" }, { id: "batch-3" }] },
      },
    );

    expect(response.type).toBe("json");
    if (response.type !== "json") {
      throw new Error(`Unexpected response: ${response.type}`);
    }
    const created = (
      response.data as {
        instances: Array<{ id: string; details: { status: string } }>;
      }
    ).instances;

    expect(created).toHaveLength(3);
    expect(created.map((entry) => entry.id)).toEqual(["batch-1", "batch-2", "batch-3"]);
    expect(created.map((entry) => entry.details.status)).toEqual(["queued", "queued", "queued"]);

    const instances = await harness.db.find("workflow_instance", (b) => b.whereIndex("primary"));
    for (const instance of instances) {
      await harness.runUntilIdle({
        workflowName: instance.workflowName,
        instanceId: instance.instanceId,
        instanceRef: String(instance.id),
        runNumber: instance.runNumber,
        reason: "create",
      });
    }

    const statuses = await Promise.all(
      ["batch-1", "batch-2", "batch-3"].map((id) => harness.getStatus("BATCH", id)),
    );
    expect(statuses.map((status) => status.status)).toEqual(["complete", "complete", "complete"]);
    expect(statuses.map((status) => status.output)).toEqual([
      { instanceId: "batch-1" },
      { instanceId: "batch-2" },
      { instanceId: "batch-3" },
    ]);

    expect(instances).toHaveLength(3);
  });

  test("createBatch skips existing and duplicate instance ids", async () => {
    const BatchWorkflow = defineWorkflow({ name: "batch-skip-workflow" }, async (event, step) => {
      const value = await step.do("result", () => event.instanceId);
      return { value };
    });

    const harness = await createWorkflowsTestHarness({
      workflows: { BATCH_SKIP: BatchWorkflow },
      adapter: { type: "kysely-sqlite" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
    });

    await harness.createInstance("BATCH_SKIP", { id: "existing-1" });

    const response = await (harness.fragment as AnyFragnoInstantiatedFragment).callRoute(
      "POST",
      "/:workflowName/instances/batch",
      {
        pathParams: { workflowName: "batch-skip-workflow" },
        body: {
          instances: [{ id: "existing-1" }, { id: "dup-1" }, { id: "dup-1" }, { id: "fresh-1" }],
        },
      },
    );

    expect(response.type).toBe("json");
    if (response.type !== "json") {
      throw new Error(`Unexpected response: ${response.type}`);
    }
    const created = (
      response.data as {
        instances: Array<{ id: string; details: { status: string } }>;
      }
    ).instances;

    expect(created.map((entry) => entry.id)).toEqual(["dup-1", "fresh-1"]);

    const instances = await harness.db.find("workflow_instance", (b) => b.whereIndex("primary"));
    expect(instances).toHaveLength(3);

    for (const instance of instances.filter((entry) => entry.instanceId !== "existing-1")) {
      await harness.runUntilIdle({
        workflowName: instance.workflowName,
        instanceId: instance.instanceId,
        instanceRef: String(instance.id),
        runNumber: instance.runNumber,
        reason: "create",
      });
    }

    const status = await harness.getStatus("BATCH_SKIP", "fresh-1");
    expect(status.status).toBe("complete");
    expect(status.output).toEqual({ value: "fresh-1" });
  });

  test("createBatch route returns created instances", async () => {
    const RouteBatchWorkflow = defineWorkflow(
      { name: "batch-route-workflow" },
      async (_event, step) => {
        const value = await step.do("result", () => "ok");
        return { value };
      },
    );

    const harness = await createWorkflowsTestHarness({
      workflows: { BATCH_ROUTE: RouteBatchWorkflow },
      adapter: { type: "kysely-sqlite" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
    });

    const previousDebug = process.env["FRAGNO_DEBUG_BATCH_ROUTE"];
    process.env["FRAGNO_DEBUG_BATCH_ROUTE"] = "1";
    try {
      const response = await (harness.fragment as AnyFragnoInstantiatedFragment).callRoute(
        "POST",
        "/:workflowName/instances/batch",
        {
          pathParams: { workflowName: "batch-route-workflow" },
          body: { instances: [{ id: "route-1" }, { id: "route-2" }] },
        },
      );

      expect(response.type).toBe("json");
      if (response.type !== "json") {
        throw new Error(`Unexpected response: ${response.type}`);
      }
      const instances = (
        response.data as {
          instances: Array<{ id: string; details: { status: string } }>;
        }
      ).instances;
      expect(instances.map((entry) => entry.id)).toEqual(["route-1", "route-2"]);
      expect(instances.map((entry) => entry.details.status)).toEqual(["queued", "queued"]);
    } finally {
      if (previousDebug === undefined) {
        delete process.env["FRAGNO_DEBUG_BATCH_ROUTE"];
      } else {
        process.env["FRAGNO_DEBUG_BATCH_ROUTE"] = previousDebug;
      }
    }
  });
});
