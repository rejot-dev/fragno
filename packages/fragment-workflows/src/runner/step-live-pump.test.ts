import { afterEach, describe, expect, test, assert } from "vitest";

import { BufferedPumpRegistry } from "@fragno-dev/db/buffered-pump";

import type { DatabaseRequestContext } from "@fragno-dev/db";
import { buildDatabaseFragmentsTest, drainDurableHooks } from "@fragno-dev/test";

import { workflowsSchema } from "../schema";
import { createWorkflowsTestHarness, type WorkflowsTestHarness } from "../test";
import { defineWorkflow, type WorkflowEnqueuedHookPayload } from "../workflow";
import { createWorkflowStepLivePump, workflowStepLivePumpKey } from "./step-live-pump";
import type { WorkflowStepLivePump, WorkflowStepLivePumpRegistry } from "./step-live-pump";

function openBus<TOutEmission = unknown, TInEmission = unknown>(
  registry: WorkflowStepLivePumpRegistry,
  options: {
    handlerTx: DatabaseRequestContext["handlerTx"];
    workflowName: string;
    instanceId: string;
  },
) {
  const handle = registry.getOrCreate(
    workflowStepLivePumpKey(options.workflowName, options.instanceId),
    () => createWorkflowStepLivePump(options),
  );
  handle.pump.setHandlerTx(options.handlerTx);
  return handle.pump as WorkflowStepLivePump<TOutEmission, TInEmission>;
}

describe("WorkflowStepLivePump", () => {
  const registries: WorkflowStepLivePumpRegistry[] = [];
  const createStepEmissions = () => {
    const registry = new BufferedPumpRegistry<WorkflowStepLivePump>();
    registries.push(registry);
    return registry;
  };

  test("registry scopes buses by workflow name and instance id", () => {
    const registry = createStepEmissions();
    const handlerTx = (() => {
      throw new Error("handlerTx should not be called");
    }) as DatabaseRequestContext["handlerTx"];

    const first = openBus(registry, {
      handlerTx,
      workflowName: "first-workflow",
      instanceId: "shared-instance",
    });
    const second = openBus(registry, {
      handlerTx,
      workflowName: "second-workflow",
      instanceId: "shared-instance",
    });
    const firstAgain = openBus(registry, {
      handlerTx,
      workflowName: "first-workflow",
      instanceId: "shared-instance",
    });

    expect(firstAgain).toBe(first);
    expect(second).not.toBe(first);
    expect(first.debugLabel()).toContain("first-workflow:shared-instance");
    expect(second.debugLabel()).toContain("second-workflow:shared-instance");
  });

  afterEach(() => {
    expect(
      registries.flatMap((registry) =>
        registry
          .values()
          .filter((bus) => bus.isRunning())
          .map((bus) => bus.debugLabel()),
      ),
    ).toEqual([]);
    registries.length = 0;
  });

  test("flushes step-start control and outbound rows while a step is still running", async () => {
    const stepEntered = deferred();
    const releaseStep = deferred();
    const workflow = defineWorkflow<
      "step-emission-bus-flush-running-workflow",
      undefined,
      { ok: true }
    >({ name: "step-emission-bus-flush-running-workflow" }, async (_event, step) => {
      await step.do("interactive", async (tx) => {
        tx.emit({ type: "started" });
        stepEntered.resolve();
        await releaseStep.promise;
      });
      return { ok: true };
    });

    const stepEmissions = createStepEmissions();
    const harness = await createWorkflowsTestHarness({
      workflows: { EMISSION_BUS: workflow },
      adapter: { type: "in-memory" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
      fragmentConfig: { stepEmissions },
    });

    const instanceId = await harness.createInstance("EMISSION_BUS");
    const instance = await readInstance(harness);
    const emissionBus = await harness.fragment.inContext(function () {
      return openBus<{ type: string }>(stepEmissions, {
        handlerTx: this.handlerTx,
        workflowName: "step-emission-bus-flush-running-workflow",
        instanceId,
      });
    });

    const tick = harness.tick(buildPayload(instance, "create"));
    try {
      await stepEntered.promise;
      await flushBus(harness, emissionBus);

      expect(
        (
          await readStepEmissionRows(
            harness,
            "step-emission-bus-flush-running-workflow",
            instanceId,
          )
        )
          .map((row) => row.actor)
          .sort(),
      ).toEqual(["system", "user"]);
    } finally {
      releaseStep.resolve();
      await tick;
      emissionBus.stop();
      await drainDurableHooks(harness.fragment);
    }
  });

  test("persists step-start control without delivering it as outbound output", async () => {
    const stepEntered = deferred();
    const releaseStep = deferred();
    const observed: unknown[] = [];
    const stepEmissions = createStepEmissions();

    const workflow = defineWorkflow<
      "step-emission-bus-control-output-workflow",
      undefined,
      { ok: true }
    >({ name: "step-emission-bus-control-output-workflow" }, async (_event, step) => {
      await step.do("interactive", async () => {
        stepEntered.resolve();
        await releaseStep.promise;
      });
      return { ok: true };
    });

    const harness = await createWorkflowsTestHarness({
      workflows: { EMISSION_BUS: workflow },
      adapter: { type: "in-memory" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
      fragmentConfig: { stepEmissions },
    });

    const instanceId = await harness.createInstance("EMISSION_BUS");
    const instance = await readInstance(harness);
    const emissionBus = await harness.fragment.inContext(function () {
      return openBus<{ type: string }>(stepEmissions, {
        handlerTx: this.handlerTx,
        workflowName: "step-emission-bus-control-output-workflow",
        instanceId,
      });
    });
    const unsubscribe = emissionBus.observe((message) => {
      observed.push(message.payload);
    });

    const tick = harness.tick(buildPayload(instance, "create"));
    try {
      await stepEntered.promise;
      await flushBus(harness, emissionBus);

      expect(
        await readStepEmissionRows(
          harness,
          "step-emission-bus-control-output-workflow",
          instanceId,
        ),
      ).toMatchObject([
        {
          actor: "system",
          payload: { control: "step-started" },
          sequence: 0,
        },
      ]);
      expect(observed).toEqual([{ control: "step-started" }]);
    } finally {
      unsubscribe();
      emissionBus.stop();
      releaseStep.resolve();
      await tick;
      await drainDurableHooks(harness.fragment);
    }
  });

  test("delivers outbound messages to observers in emission order", async () => {
    const observed = createAsyncQueue<unknown>();
    const stepEmissions = createStepEmissions();

    const workflow = defineWorkflow<
      "step-emission-bus-observe-outbound-workflow",
      undefined,
      { ok: true }
    >({ name: "step-emission-bus-observe-outbound-workflow" }, async (_event, step) => {
      await step.do("interactive", async (tx) => {
        tx.emit({ type: "message_start", text: "poem" });
        tx.emit({ type: "message_update", text: "In fields" });
        tx.emit({ type: "message_end", text: "In fields" });
      });
      return { ok: true };
    });

    const harness = await createWorkflowsTestHarness({
      workflows: { EMISSION_BUS: workflow },
      adapter: { type: "in-memory" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
      fragmentConfig: { stepEmissions },
    });

    const instanceId = await harness.createInstance("EMISSION_BUS");
    const instance = await readInstance(harness);
    const emissionBus = await harness.fragment.inContext(function () {
      return openBus<{ type: string; text?: string }>(stepEmissions, {
        handlerTx: this.handlerTx,
        workflowName: "step-emission-bus-observe-outbound-workflow",
        instanceId,
      });
    });
    const unsubscribe = emissionBus.observe((message) => {
      if (message.actor === "user") {
        observed.push(message.payload);
      }
    });

    try {
      await harness.tick(buildPayload(instance, "create"));
      await flushBus(harness, emissionBus);

      expect(await observed.next()).toEqual({ type: "message_start", text: "poem" });
      expect(await observed.next()).toEqual({ type: "message_update", text: "In fields" });
      expect(await observed.next()).toEqual({ type: "message_end", text: "In fields" });
      assert(observed.pendingCount() === 0);
    } finally {
      unsubscribe();
      emissionBus.stop();
    }
  });

  test("remote observers can read outbound rows written by another bus", async () => {
    const stepEntered = deferred();
    const releaseStep = deferred();
    const observed = createAsyncQueue<unknown>();

    const workflow = defineWorkflow<
      "step-emission-bus-remote-observer-workflow",
      undefined,
      { ok: true }
    >({ name: "step-emission-bus-remote-observer-workflow" }, async (_event, step) => {
      await step.do("interactive", async (tx) => {
        tx.emit({ type: "remote-started" });
        stepEntered.resolve();
        await releaseStep.promise;
      });
      return { ok: true };
    });

    const localRegistry = createStepEmissions();
    const harness = await createWorkflowsTestHarness({
      workflows: { EMISSION_BUS: workflow },
      adapter: { type: "in-memory" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
      fragmentConfig: { stepEmissions: localRegistry },
    });

    const instanceId = await harness.createInstance("EMISSION_BUS");
    const instance = await readInstance(harness);
    const localBus = await harness.fragment.inContext(function () {
      return openBus<{ type: string }>(localRegistry, {
        handlerTx: this.handlerTx,
        workflowName: "step-emission-bus-remote-observer-workflow",
        instanceId,
      });
    });

    const tick = harness.tick(buildPayload(instance, "create"));
    const remoteRegistry = createStepEmissions();
    const remoteBus = await harness.fragment.inContext(function () {
      return openBus<{ type: string }>(remoteRegistry, {
        handlerTx: this.handlerTx,
        workflowName: "step-emission-bus-remote-observer-workflow",
        instanceId,
      });
    });
    const unsubscribe = remoteBus.observe((message) => {
      if (message.actor === "user") {
        observed.push(message.payload);
      }
    });

    try {
      await stepEntered.promise;
      await flushBus(harness, localBus);
      await flushBus(harness, remoteBus);

      expect(await observed.next()).toEqual({ type: "remote-started" });
      assert(observed.pendingCount() === 0);
    } finally {
      unsubscribe();
      remoteBus.stop();
      localBus.stop();
      releaseStep.resolve();
      await tick;
    }
  });

  test("snapshot returns the cached emissions and cursor from the last flush", async () => {
    const stepEntered = deferred();
    const releaseStep = deferred();
    const stepEmissions = createStepEmissions();

    const workflow = defineWorkflow<
      "step-emission-bus-snapshot-outbound-workflow",
      undefined,
      { ok: true }
    >({ name: "step-emission-bus-snapshot-outbound-workflow" }, async (_event, step) => {
      await step.do("interactive", async (tx) => {
        tx.emit({ type: "first", tag: "a" });
        tx.emit({ type: "second", tag: "b" });
        stepEntered.resolve();
        await releaseStep.promise;
      });
      return { ok: true };
    });

    const harness = await createWorkflowsTestHarness({
      workflows: { EMISSION_BUS: workflow },
      adapter: { type: "in-memory" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
      fragmentConfig: { stepEmissions },
    });

    const instanceId = await harness.createInstance("EMISSION_BUS");
    const instance = await readInstance(harness);
    const emissionBus = await harness.fragment.inContext(function () {
      return openBus<{ type: string; tag?: string }>(stepEmissions, {
        handlerTx: this.handlerTx,
        workflowName: "step-emission-bus-snapshot-outbound-workflow",
        instanceId,
      });
    });

    const tick = harness.tick(buildPayload(instance, "create"));
    try {
      await stepEntered.promise;
      await flushBus(harness, emissionBus);

      const snapshot = await emissionBus.snapshot();
      const outboundOnly = snapshot.filter(
        (m) => m.actor === "user" && m.payload.type !== undefined,
      );
      const payloads = outboundOnly.map((m) => m.payload);
      expect(payloads).toEqual([
        { type: "first", tag: "a" },
        { type: "second", tag: "b" },
      ]);

      expect(outboundOnly.map((message) => message.sequence)).toEqual([1, 2]);
    } finally {
      emissionBus.stop();
      releaseStep.resolve();
      await tick;
      await drainDurableHooks(harness.fragment);
    }
  });

  test("snapshot accumulates emissions across multiple live flushes", async () => {
    const firstEmitted = deferred();
    const releaseSecondEmission = deferred();
    const secondEmitted = deferred();
    const releaseStep = deferred();
    const stepEmissions = createStepEmissions();

    const workflow = defineWorkflow<
      "step-emission-bus-cumulative-snapshot-workflow",
      undefined,
      { ok: true }
    >({ name: "step-emission-bus-cumulative-snapshot-workflow" }, async (_event, step) => {
      await step.do("interactive", async (tx) => {
        tx.emit({ type: "msg", tag: "first" });
        firstEmitted.resolve();
        await releaseSecondEmission.promise;
        tx.emit({ type: "msg", tag: "second" });
        secondEmitted.resolve();
        await releaseStep.promise;
      });
      return { ok: true };
    });

    const harness = await createWorkflowsTestHarness({
      workflows: { EMISSION_BUS: workflow },
      adapter: { type: "in-memory" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
      fragmentConfig: { stepEmissions },
    });

    const instanceId = await harness.createInstance("EMISSION_BUS");
    const instance = await readInstance(harness);
    const emissionBus = await harness.fragment.inContext(function () {
      return openBus<{ type: string; tag: string }>(stepEmissions, {
        handlerTx: this.handlerTx,
        workflowName: "step-emission-bus-cumulative-snapshot-workflow",
        instanceId,
      });
    });
    const tick = harness.tick(buildPayload(instance, "create"));

    try {
      await firstEmitted.promise;
      await flushBus(harness, emissionBus);
      const firstSnapshot = await emissionBus.snapshot();
      expect(
        firstSnapshot
          .filter((message) => message.actor === "user")
          .map((message) => message.payload.tag),
      ).toEqual(["first"]);
      expect(
        firstSnapshot
          .filter((message) => message.actor === "user")
          .map((message) => message.sequence),
      ).toEqual([1]);

      releaseSecondEmission.resolve();
      await secondEmitted.promise;
      await flushBus(harness, emissionBus);
      const secondSnapshot = await emissionBus.snapshot();
      const secondOutbound = secondSnapshot.filter((message) => message.actor === "user");
      expect(secondOutbound.map((message) => message.payload.tag)).toEqual(
        expect.arrayContaining(["first", "second"]),
      );
      expect(secondOutbound).toHaveLength(2);
      expect(
        new Map(secondOutbound.map((message) => [message.payload.tag, message.sequence])),
      ).toEqual(
        new Map([
          ["first", 1],
          ["second", 0],
        ]),
      );
    } finally {
      emissionBus.stop();
      releaseStep.resolve();
      await tick;
      await drainDurableHooks(harness.fragment);
    }
  });

  test("observe after snapshot skips snapshotted emissions per observer", async () => {
    const beforeThird = deferred();
    const releaseStep = deferred();
    const stepEmissions = createStepEmissions();

    const workflow = defineWorkflow<
      "step-emission-bus-from-cursors-workflow",
      undefined,
      { ok: true }
    >({ name: "step-emission-bus-from-cursors-workflow" }, async (_event, step) => {
      await step.do("interactive", async (tx) => {
        tx.emit({ type: "msg", tag: "first" });
        tx.emit({ type: "msg", tag: "second" });
        beforeThird.resolve();
        await releaseStep.promise;
        tx.emit({ type: "msg", tag: "third" });
      });
      return { ok: true };
    });

    const harness = await createWorkflowsTestHarness({
      workflows: { EMISSION_BUS: workflow },
      adapter: { type: "in-memory" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
      fragmentConfig: { stepEmissions },
    });

    const instanceId = await harness.createInstance("EMISSION_BUS");
    const instance = await readInstance(harness);
    const emissionBus = await harness.fragment.inContext(function () {
      return openBus<{ type: string; tag: string }>(stepEmissions, {
        handlerTx: this.handlerTx,
        workflowName: "step-emission-bus-from-cursors-workflow",
        instanceId,
      });
    });

    const tick = harness.tick(buildPayload(instance, "create"));
    const lateObserver = createAsyncQueue<{ tag: string; sequence: number | null }>();
    const earlyObserver = createAsyncQueue<{ tag: string; sequence: number | null }>();
    let unsubscribeLate = () => {};
    let unsubscribeEarly = () => {};

    try {
      await beforeThird.promise;
      await flushBus(harness, emissionBus);

      const snapshot = await emissionBus.snapshot();
      expect(snapshot.filter((m) => m.actor === "user").map((m) => m.payload.tag)).toEqual([
        "first",
        "second",
      ]);

      unsubscribeLate = emissionBus.observe(
        (message) => {
          if (message.actor === "user") {
            lateObserver.push({ tag: message.payload.tag, sequence: message.sequence });
          }
        },
        { after: snapshot },
      );
      unsubscribeEarly = emissionBus.observe((message) => {
        if (message.actor === "user") {
          earlyObserver.push({ tag: message.payload.tag, sequence: message.sequence });
        }
      });

      releaseStep.resolve();
      await tick;
      await flushBus(harness, emissionBus);

      expect(await lateObserver.next()).toEqual({ tag: "third", sequence: 0 });
      assert((await earlyObserver.next()).tag === "first");
      assert((await earlyObserver.next()).tag === "second");
      assert((await earlyObserver.next()).tag === "third");
      assert(lateObserver.pendingCount() === 0);
      assert(earlyObserver.pendingCount() === 0);
    } finally {
      unsubscribeLate();
      unsubscribeEarly();
      emissionBus.stop();
      releaseStep.resolve();
      await drainDurableHooks(harness.fragment);
    }
  });

  test("sendEvent broadcasts durable events to an active step", async () => {
    const stepEntered = deferred();
    const releaseStep = deferred();
    const received = createAsyncQueue<unknown>();

    const workflow = defineWorkflow<"step-live-pump-inbound-workflow", undefined, { ok: true }>(
      { name: "step-live-pump-inbound-workflow" },
      async (_event, step) => {
        await step.do("interactive", async (tx) => {
          tx.onEvent("command", (event) => {
            received.push(event.payload);
            event.consume();
          });
          stepEntered.resolve();
          await releaseStep.promise;
        });
        return { ok: true };
      },
    );

    const stepEmissions = createStepEmissions();
    const harness = await createWorkflowsTestHarness({
      workflows: { EMISSION_BUS: workflow },
      adapter: { type: "in-memory" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
      fragmentConfig: { stepEmissions },
    });

    const instanceId = await harness.createInstance("EMISSION_BUS");
    const instance = await readInstance(harness);

    const tick = harness.tick(buildPayload(instance, "create"));
    try {
      await stepEntered.promise;

      await Promise.all([
        sendEventAndFlush(harness, {
          workflowName: "step-live-pump-inbound-workflow",
          instanceId,
          event: { type: "command", payload: { command: "continue" } },
        }),
        sendEventAndFlush(harness, {
          workflowName: "step-live-pump-inbound-workflow",
          instanceId,
          event: { type: "command", payload: { command: "status" } },
        }),
      ]);

      expect([await received.next(), await received.next()]).toEqual(
        expect.arrayContaining([{ command: "continue" }, { command: "status" }]),
      );
      assert(received.pendingCount() === 0);
    } finally {
      releaseStep.resolve();
      await tick;
    }
  });

  test("tx.onEvent replays an unconsumed event on retry", async () => {
    const releaseAttempt = createAsyncQueue<() => void>();
    const received = createAsyncQueue<unknown>();
    let attempt = 0;

    const workflow = defineWorkflow<
      "step-live-pump-duplicate-event-workflow",
      undefined,
      { ok: true }
    >({ name: "step-live-pump-duplicate-event-workflow" }, async (_event, step) => {
      await step.do(
        "interactive",
        { retries: { limit: 1, delay: 0, backoff: "constant" } },
        async (tx) => {
          attempt += 1;
          tx.onEvent("command", (event) => {
            received.push(event.payload);
          });
          await new Promise<void>((resolve) => {
            releaseAttempt.push(resolve);
          });
          if (attempt === 1) {
            throw new Error("retry after event delivery");
          }
        },
      );
      return { ok: true };
    });

    const stepEmissions = createStepEmissions();
    const harness = await createWorkflowsTestHarness({
      workflows: { EMISSION_BUS: workflow },
      adapter: { type: "in-memory" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
      fragmentConfig: { stepEmissions },
    });

    const instanceId = await harness.createInstance("EMISSION_BUS");
    const instance = await readInstance(harness);

    const tick = harness.tick(buildPayload(instance, "create"));
    try {
      const releaseFirstAttempt = await releaseAttempt.next();

      await sendEventAndFlush(harness, {
        workflowName: "step-live-pump-duplicate-event-workflow",
        instanceId,
        event: { type: "command", payload: { command: "continue" } },
      });

      expect(await received.next()).toEqual({ command: "continue" });

      releaseFirstAttempt();
      await tick;

      const retryTick = harness.tick(buildPayload(instance, "retry"));
      const releaseSecondAttempt = await releaseAttempt.next();
      expect(await received.next()).toEqual({ command: "continue" });

      releaseSecondAttempt();
      await retryTick;
    } finally {
      for (const release of releaseAttempt.drain()) {
        release();
      }
    }
  });
});

const readInstance = async (harness: WorkflowsTestHarness) => {
  const [instance] = (
    await harness.db
      .createUnitOfWork("read")
      .forSchema(workflowsSchema)
      .find("workflow_instance", (b) => b.whereIndex("primary"))
      .executeRetrieve()
  )[0];
  expect(instance).toBeTruthy();
  return instance!;
};

const readStepEmissionRows = async (
  harness: WorkflowsTestHarness,
  workflowName: string,
  instanceId: string,
) => {
  const [instance] = (
    await harness.db
      .createUnitOfWork("read-instance")
      .forSchema(workflowsSchema)
      .find("workflow_instance", (b) =>
        b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
          eb.and(eb("workflowName", "=", workflowName), eb("instanceId", "=", instanceId)),
        ),
      )
      .executeRetrieve()
  )[0];

  if (!instance) {
    return [];
  }

  return (
    await harness.db
      .createUnitOfWork("read")
      .forSchema(workflowsSchema)
      .find("workflow_step_emission", (b) =>
        b
          .whereIndex("idx_workflow_step_emission_instance_actor_createdAt_sequence_id", (eb) =>
            eb("instanceRef", "=", instance.id),
          )
          .orderByIndex("idx_workflow_step_emission_instance_actor_createdAt_sequence_id", "asc"),
      )
      .executeRetrieve()
  )[0];
};

const sendEventAndFlush = async (
  harness: WorkflowsTestHarness,
  params: {
    workflowName: string;
    instanceId: string;
    event: { type: string; payload?: unknown };
  },
) => {
  await harness.fragment.inContext(async function () {
    await this.handlerTx()
      .withServiceCalls(() => [
        harness.services.sendEvent(params.workflowName, params.instanceId, params.event),
      ])
      .execute();

    const busHandle = harness.services.observeStepEmissions({
      handlerTx: this.handlerTx,
      workflowName: params.workflowName,
      instanceId: params.instanceId,
    });
    await busHandle.flushAndClose();
  });
};

const flushBus = async (harness: WorkflowsTestHarness, bus: { flushNow(): Promise<void> }) => {
  await harness.fragment.inContext(async function () {
    await bus.flushNow();
  });
};

const deferred = <T = void>() => Promise.withResolvers<T>();

const createAsyncQueue = <T>() => {
  const values: T[] = [];
  const waiters: Array<(value: T) => void> = [];

  return {
    push(value: T) {
      const waiter = waiters.shift();
      if (waiter) {
        waiter(value);
        return;
      }
      values.push(value);
    },
    next() {
      const value = values.shift();
      if (value !== undefined) {
        return Promise.resolve(value);
      }
      return new Promise<T>((resolve) => {
        waiters.push(resolve);
      });
    },
    pendingCount() {
      return values.length;
    },
    drain() {
      return values.splice(0);
    },
  };
};

const buildPayload = (
  instance: { id: { toString(): string }; instanceId: string; workflowName: string },
  reason: WorkflowEnqueuedHookPayload["reason"],
): WorkflowEnqueuedHookPayload => ({
  workflowName: instance.workflowName,
  instanceId: instance.instanceId,
  instanceRef: String(instance.id),
  reason,
});
