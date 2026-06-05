// Tests for the new runner using the workflows test harness.
import { afterEach, describe, expect, test } from "vitest";

import { BufferedPumpRegistry } from "@fragno-dev/db/buffered-pump";
import { column, idColumn, schema } from "@fragno-dev/db/schema";
import { z } from "zod";

import { defineFragment, instantiate, type AnyFragnoInstantiatedFragment } from "@fragno-dev/core";
import { withDatabase, type DatabaseRequestContext } from "@fragno-dev/db";
import { buildDatabaseFragmentsTest, drainDurableHooks } from "@fragno-dev/test";

import { createWorkflowStepLivePump, workflowStepLivePumpKey } from "./runner/step-live-pump";
import type { WorkflowStepLivePump, WorkflowStepLivePumpRegistry } from "./runner/step-live-pump";
import { workflowsSchema } from "./schema";
import { createWorkflowsTestHarness } from "./test";
import { defineWorkflow, NonRetryableError, type WorkflowEnqueuedHookPayload } from "./workflow";

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

describe("Workflows Runner", () => {
  const registries: WorkflowStepLivePumpRegistry[] = [];
  const createStepEmissions = () => {
    const registry = new BufferedPumpRegistry<WorkflowStepLivePump>();
    registries.push(registry);
    return registry;
  };

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
  test("step emission bus can flush while a step callback is still running", async () => {
    const stepEntered = deferred();
    const releaseStep = deferred();

    const EmissionBusWorkflow = defineWorkflow<
      "step-emission-bus-workflow",
      undefined,
      { ok: true }
    >({ name: "step-emission-bus-workflow" }, async (_event, step) => {
      await step.do("interactive", async (tx) => {
        tx.emit({ type: "started" });
        stepEntered.resolve();
        await releaseStep.promise;
      });
      return { ok: true };
    });

    const stepEmissions = createStepEmissions();
    const harness = await createWorkflowsTestHarness({
      workflows: { EMISSION_BUS: EmissionBusWorkflow },
      adapter: { type: "in-memory" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
      fragmentConfig: { stepEmissions },
    });

    const instanceId = await harness.createInstance("EMISSION_BUS");
    const [instance] = (
      await harness.db
        .createUnitOfWork("read")
        .forSchema(workflowsSchema)
        .find("workflow_instance", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];
    expect(instance).toBeTruthy();

    const emissionBus = await harness.fragment.inContext(function () {
      return openBus<{ type: string }>(stepEmissions, {
        handlerTx: this.handlerTx,
        workflowName: "step-emission-bus-workflow",
        instanceId,
      });
    });

    const tick = harness.tick(buildPayload(instance!, "create"));
    try {
      await stepEntered.promise;
      await flushBus(harness, emissionBus);

      const rowsWhileRunning = await readStepEmissionRows(
        harness,
        "step-emission-bus-workflow",
        instanceId,
      );
      expect(rowsWhileRunning.map((row) => row.actor).sort()).toEqual(["system", "user"]);
    } finally {
      releaseStep.resolve();
      await tick;
      emissionBus.stop();
      await drainDurableHooks(harness.fragment);
    }

    expect(
      await readStepEmissionRows(harness, "step-emission-bus-workflow", instanceId),
    ).toHaveLength(0);
  });

  test("WorkflowStepTx previousEmissions returns rows loaded before the current attempt", async () => {
    const observedPayloads: unknown[][] = [];

    const PreviousEmissionsWorkflow = defineWorkflow<
      "previous-emissions-workflow",
      undefined,
      { ok: true }
    >({ name: "previous-emissions-workflow" }, async (_event, step) => {
      await step.do("recoverable", async (tx) => {
        tx.emit({ type: "current-attempt" });
        observedPayloads.push((await tx.previousEmissions()).map((emission) => emission.payload));
      });
      return { ok: true };
    });

    const harness = await createWorkflowsTestHarness({
      workflows: { PREVIOUS_EMISSIONS: PreviousEmissionsWorkflow },
      adapter: { type: "in-memory" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
    });

    await harness.createInstance("PREVIOUS_EMISSIONS");
    const [instance] = (
      await harness.db
        .createUnitOfWork("read")
        .forSchema(workflowsSchema)
        .find("workflow_instance", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];
    expect(instance).toBeTruthy();

    const seedUow = harness.db
      .createUnitOfWork("seed-previous-emission")
      .forSchema(workflowsSchema);
    seedUow.create("workflow_step_emission", {
      instanceRef: instance!.id,
      stepKey: "do:recoverable",
      epoch: "previous-epoch",
      sequence: 0,
      actor: "user",
      payload: { type: "checkpoint" },
    });
    const { success } = await seedUow.executeMutations();
    expect(success).toBe(true);

    await harness.tick(buildPayload(instance!, "create"));

    expect(observedPayloads).toEqual([[{ type: "checkpoint" }]]);
  });

  test("central step emission bus observes outbound events from the active in-process step", async () => {
    const stepEntered = deferred();
    const releaseStep = deferred();
    const observed = createAsyncQueue<unknown>();
    const stepEmissions = createStepEmissions();

    const EmissionBusWorkflow = defineWorkflow<
      "central-message-bus-outbound-workflow",
      undefined,
      { ok: true }
    >({ name: "central-message-bus-outbound-workflow" }, async (_event, step) => {
      await step.do("interactive", async (tx) => {
        tx.emit({ type: "started" });
        stepEntered.resolve();
        await releaseStep.promise;
      });
      return { ok: true };
    });

    const harness = await createWorkflowsTestHarness({
      workflows: { EMISSION_BUS: EmissionBusWorkflow },
      adapter: { type: "in-memory" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
      fragmentConfig: { stepEmissions },
    });

    const instanceId = await harness.createInstance("EMISSION_BUS");
    const [instance] = (
      await harness.db
        .createUnitOfWork("read")
        .forSchema(workflowsSchema)
        .find("workflow_instance", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];
    expect(instance).toBeTruthy();

    const emissionBus = await harness.fragment.inContext(function () {
      return openBus<{ type: string }>(stepEmissions, {
        handlerTx: this.handlerTx,
        workflowName: "central-message-bus-outbound-workflow",
        instanceId,
      });
    });
    const unsubscribe = emissionBus.observe((message) => {
      if (message.actor === "user") {
        observed.push(message.payload);
      }
    });

    const tick = harness.tick(buildPayload(instance!, "create"));
    try {
      await stepEntered.promise;
      await flushBus(harness, emissionBus);

      expect(
        (
          await readStepEmissionRows(harness, "central-message-bus-outbound-workflow", instanceId)
        ).map((row) => row.actor),
      ).toContain("user");
      expect(await observed.next()).toEqual({ type: "started" });
      expect(observed.pendingCount()).toBe(0);
    } finally {
      unsubscribe();
      emissionBus.stop();
      releaseStep.resolve();
      await tick;
    }
  });

  test("central step emission bus observes step commit marker before the tick resolves", async () => {
    const observed: unknown[] = [];
    const stepEmissions = createStepEmissions();

    const CommitFlushWorkflow = defineWorkflow<
      "central-message-bus-commit-flush-workflow",
      undefined,
      { ok: true }
    >({ name: "central-message-bus-commit-flush-workflow" }, async (_event, step) => {
      await step.do("commit marker", async (tx) => {
        tx.emit({ type: "started" });
      });
      return { ok: true };
    });

    const harness = await createWorkflowsTestHarness({
      workflows: { COMMIT_FLUSH: CommitFlushWorkflow },
      adapter: { type: "in-memory" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
      fragmentConfig: { stepEmissions },
    });

    const instanceId = await harness.createInstance("COMMIT_FLUSH");
    const [instance] = (
      await harness.db
        .createUnitOfWork("read")
        .forSchema(workflowsSchema)
        .find("workflow_instance", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];
    expect(instance).toBeTruthy();

    const emissionBus = await harness.fragment.inContext(function () {
      return openBus(stepEmissions, {
        handlerTx: this.handlerTx,
        workflowName: "central-message-bus-commit-flush-workflow",
        instanceId,
      });
    });
    const unsubscribe = emissionBus.observe((message) => {
      observed.push(message.payload);
    });
    let flushCount = 0;
    const originalFlushNow = emissionBus.flushNow.bind(emissionBus);
    emissionBus.flushNow = async () => {
      flushCount += 1;
      await originalFlushNow();
    };

    try {
      await harness.tick(buildPayload(instance!, "create"));
      emissionBus.stop();

      expect(observed).toEqual(
        expect.arrayContaining([expect.objectContaining({ control: "step-committed" })]),
      );
      expect(flushCount).toBe(1);
    } finally {
      unsubscribe();
      emissionBus.stop();
    }
  });

  test("central step emission bus snapshot dedupes a commit marker already observed by a flush", async () => {
    const stepEmissions = createStepEmissions();

    const CommitSnapshotWorkflow = defineWorkflow<
      "central-message-bus-commit-snapshot-workflow",
      undefined,
      { ok: true }
    >({ name: "central-message-bus-commit-snapshot-workflow" }, async (_event, step) => {
      await step.do("commit marker", async (tx) => {
        tx.emit({ type: "started" });
      });
      return { ok: true };
    });

    const harness = await createWorkflowsTestHarness({
      workflows: { COMMIT_SNAPSHOT: CommitSnapshotWorkflow },
      adapter: { type: "in-memory" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
      fragmentConfig: { stepEmissions },
    });

    const instanceId = await harness.createInstance("COMMIT_SNAPSHOT");
    const [instance] = (
      await harness.db
        .createUnitOfWork("read")
        .forSchema(workflowsSchema)
        .find("workflow_instance", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];
    expect(instance).toBeTruthy();

    const emissionBus = await harness.fragment.inContext(function () {
      return openBus(stepEmissions, {
        handlerTx: this.handlerTx,
        workflowName: "central-message-bus-commit-snapshot-workflow",
        instanceId,
      });
    });
    const flushNow = emissionBus.flushNow.bind(emissionBus);
    const publishObserved = emissionBus.publishObserved.bind(emissionBus);
    emissionBus.publishObserved = async (messages) => {
      await flushNow();
      await publishObserved(messages);
    };

    try {
      await harness.tick(buildPayload(instance!, "create"));

      const snapshot = await emissionBus.snapshot();
      const commitMarkers = snapshot.filter(
        (message) =>
          typeof message.payload === "object" &&
          message.payload !== null &&
          "control" in message.payload &&
          message.payload.control === "step-committed",
      );
      expect(commitMarkers).toHaveLength(1);
    } finally {
      emissionBus.stop();
    }
  });

  test("central step emission bus drains emissions queued behind an in-flight flush before step close", async () => {
    const observed = createAsyncQueue<unknown>();
    const stepEmissions = createStepEmissions();

    const EmissionBusWorkflow = defineWorkflow<
      "central-message-bus-drain-before-close-workflow",
      undefined,
      { ok: true }
    >({ name: "central-message-bus-drain-before-close-workflow" }, async (_event, step) => {
      await step.do("interactive", async (tx) => {
        tx.emit({ type: "message_start", text: "poem" });
        tx.emit({ type: "message_update", text: "In fields" });
        tx.emit({ type: "message_update", text: "In fields where silent shadows creep" });
        tx.emit({ type: "message_end", text: "In fields where silent shadows creep" });
      });
      return { ok: true };
    });

    const harness = await createWorkflowsTestHarness({
      workflows: { EMISSION_BUS: EmissionBusWorkflow },
      adapter: { type: "in-memory" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
      fragmentConfig: { stepEmissions },
    });

    const instanceId = await harness.createInstance("EMISSION_BUS");
    const [instance] = (
      await harness.db
        .createUnitOfWork("read")
        .forSchema(workflowsSchema)
        .find("workflow_instance", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];
    expect(instance).toBeTruthy();

    const emissionBus = await harness.fragment.inContext(function () {
      return openBus<{ type: string; text?: string }>(stepEmissions, {
        handlerTx: this.handlerTx,
        workflowName: "central-message-bus-drain-before-close-workflow",
        instanceId,
      });
    });
    const unsubscribe = emissionBus.observe((message) => {
      if (message.actor === "user") {
        observed.push(message.payload);
      }
    });

    try {
      await harness.tick(buildPayload(instance!, "create"));
      await flushBus(harness, emissionBus);

      expect(await observed.next()).toEqual({ type: "message_start", text: "poem" });
      expect(await observed.next()).toEqual({ type: "message_update", text: "In fields" });
      expect(await observed.next()).toEqual({
        type: "message_update",
        text: "In fields where silent shadows creep",
      });
      expect(await observed.next()).toEqual({
        type: "message_end",
        text: "In fields where silent shadows creep",
      });
      expect(observed.pendingCount()).toBe(0);
    } finally {
      unsubscribe();
      emissionBus.stop();
    }
  });

  test("central step emission bus exposes final outbound rows flushed during step close to remote observers", async () => {
    const observed = createAsyncQueue<unknown>();

    const EmissionBusWorkflow = defineWorkflow<
      "central-message-bus-close-remote-outbound-workflow",
      undefined,
      { ok: true }
    >({ name: "central-message-bus-close-remote-outbound-workflow" }, async (_event, step) => {
      await step.do("interactive", async (tx) => {
        tx.emit({ type: "message_update", text: "final text" });
        tx.emit({ type: "message_end", text: "final text" });
        tx.emit({ type: "turn_end" });
        tx.emit({ type: "agent_end" });
      });
      return { ok: true };
    });

    const stepEmissions = createStepEmissions();
    const harness = await createWorkflowsTestHarness({
      workflows: { EMISSION_BUS: EmissionBusWorkflow },
      adapter: { type: "in-memory" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
      fragmentConfig: { stepEmissions },
    });

    const instanceId = await harness.createInstance("EMISSION_BUS");
    const [instance] = (
      await harness.db
        .createUnitOfWork("read")
        .forSchema(workflowsSchema)
        .find("workflow_instance", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];
    expect(instance).toBeTruthy();

    const remoteRegistry = createStepEmissions();
    const remoteBus = await harness.fragment.inContext(function () {
      return openBus<{ type: string; text?: string }>(remoteRegistry, {
        handlerTx: this.handlerTx,
        workflowName: "central-message-bus-close-remote-outbound-workflow",
        instanceId,
      });
    });
    const unsubscribe = remoteBus.observe((message) => {
      if (message.actor === "user") {
        observed.push(message.payload);
      }
    });

    try {
      await harness.tick(buildPayload(instance!, "create"));
      await flushBus(harness, remoteBus);

      expect(await observed.next()).toEqual({ type: "message_update", text: "final text" });
      expect(await observed.next()).toEqual({ type: "message_end", text: "final text" });
      expect(await observed.next()).toEqual({ type: "turn_end" });
      expect(await observed.next()).toEqual({ type: "agent_end" });
      expect(observed.pendingCount()).toBe(0);
    } finally {
      unsubscribe();
      remoteBus.stop();
    }
  });

  test("central step emission bus observes outbound rows written by another process", async () => {
    const stepEntered = deferred();
    const releaseStep = deferred();
    const observed = createAsyncQueue<unknown>();

    const EmissionBusWorkflow = defineWorkflow<
      "central-message-bus-remote-outbound-workflow",
      undefined,
      { ok: true }
    >({ name: "central-message-bus-remote-outbound-workflow" }, async (_event, step) => {
      await step.do("interactive", async (tx) => {
        tx.emit({ type: "remote-started" });
        stepEntered.resolve();
        await releaseStep.promise;
      });
      return { ok: true };
    });

    const localRegistry = createStepEmissions();
    const harness = await createWorkflowsTestHarness({
      workflows: { EMISSION_BUS: EmissionBusWorkflow },
      adapter: { type: "in-memory" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
      fragmentConfig: { stepEmissions: localRegistry },
    });

    const instanceId = await harness.createInstance("EMISSION_BUS");
    const [instance] = (
      await harness.db
        .createUnitOfWork("read")
        .forSchema(workflowsSchema)
        .find("workflow_instance", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];
    expect(instance).toBeTruthy();

    const localBus = await harness.fragment.inContext(function () {
      return openBus<{ type: string }>(localRegistry, {
        handlerTx: this.handlerTx,
        workflowName: "central-message-bus-remote-outbound-workflow",
        instanceId,
      });
    });

    const tick = harness.tick(buildPayload(instance!, "create"));
    const remoteRegistry = createStepEmissions();
    const remoteBus = await harness.fragment.inContext(function () {
      return openBus<{ type: string }>(remoteRegistry, {
        handlerTx: this.handlerTx,
        workflowName: "central-message-bus-remote-outbound-workflow",
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
      expect(
        (
          await readStepEmissionRows(
            harness,
            "central-message-bus-remote-outbound-workflow",
            instanceId,
          )
        ).map((row) => row.actor),
      ).toContain("user");

      await flushBus(harness, remoteBus);
      expect(await observed.next()).toEqual({ type: "remote-started" });
      expect(observed.pendingCount()).toBe(0);
    } finally {
      unsubscribe();
      remoteBus.stop();
      localBus.stop();
      releaseStep.resolve();
      await tick;
    }
  });

  test("sendEvent broadcasts durable events to an active step bus", async () => {
    const stepEntered = deferred();
    const releaseStep = deferred();
    const received = createAsyncQueue<unknown>();

    const EmissionBusWorkflow = defineWorkflow<
      "step-message-inbound-workflow",
      undefined,
      { ok: true }
    >({ name: "step-message-inbound-workflow" }, async (_event, step) => {
      await step.do("interactive", async (tx) => {
        tx.onEvent("command", (event) => {
          received.push(event.payload);
          event.consume();
        });
        stepEntered.resolve();
        await releaseStep.promise;
      });
      return { ok: true };
    });

    const stepEmissions = createStepEmissions();
    const harness = await createWorkflowsTestHarness({
      workflows: { EMISSION_BUS: EmissionBusWorkflow },
      adapter: { type: "in-memory" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
      fragmentConfig: { stepEmissions },
    });

    const instanceId = await harness.createInstance("EMISSION_BUS");
    const [instance] = (
      await harness.db
        .createUnitOfWork("read")
        .forSchema(workflowsSchema)
        .find("workflow_instance", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];
    expect(instance).toBeTruthy();

    const tick = harness.tick(buildPayload(instance!, "create"));
    try {
      await stepEntered.promise;

      await sendEventAndFlush(harness, {
        workflowName: "step-message-inbound-workflow",
        instanceId,
        event: { type: "command", payload: { command: "continue" } },
      });

      expect(await received.next()).toEqual({ command: "continue" });
      expect(received.pendingCount()).toBe(0);
    } finally {
      releaseStep.resolve();
      await tick;
    }
  });

  const readStepEmissionRows = async (
    harness: { db: WorkflowsTestHarnessDatabase },
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
          b.whereIndex("idx_workflow_step_emission_instance_actor_createdAt_sequence_id", (eb) =>
            eb("instanceRef", "=", instance.id),
          ),
        )
        .executeRetrieve()
    )[0];
  };

  type WorkflowsTestHarnessDatabase = Awaited<ReturnType<typeof createWorkflowsTestHarness>>["db"];
  type WorkflowsTestHarness = Awaited<ReturnType<typeof createWorkflowsTestHarness>>;

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

  test("marks workflow errored when completed output violates outputSchema", async () => {
    const InvalidOutputWorkflow = defineWorkflow(
      { name: "invalid-output-workflow", outputSchema: z.object({ ok: z.boolean() }) },
      async () => ({ ok: "not-a-boolean" }) as unknown as { ok: boolean },
    );

    const harness = await createWorkflowsTestHarness({
      workflows: { INVALID_OUTPUT: InvalidOutputWorkflow },
      adapter: { type: "in-memory" },
      testBuilder: buildDatabaseFragmentsTest(),
    });

    const instanceId = await harness.createInstance("INVALID_OUTPUT");
    const [instance] = (
      await harness.db
        .createUnitOfWork("read")
        .forSchema(workflowsSchema)
        .find("workflow_instance", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];
    expect(instance).toBeTruthy();

    await harness.tick(buildPayload(instance!, "create"));

    const finalStatus = await harness.getStatus("INVALID_OUTPUT", instanceId);
    expect(finalStatus).toMatchObject({
      status: "errored",
      error: {
        name: "WorkflowOutputValidationError",
        message: "WORKFLOW_OUTPUT_INVALID",
      },
    });
    expect(finalStatus.output).toBeUndefined();
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

    const [stepRecord] = (
      await harness.db
        .createUnitOfWork("read")
        .forSchema(workflowsSchema)
        .find("workflow_step", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];
    expect(stepRecord?.wakeAt).toBeInstanceOf(Date);

    const [instance] = (
      await harness.db
        .createUnitOfWork("read")
        .forSchema(workflowsSchema)
        .find("workflow_instance", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];
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
    const [instance] = (
      await harness.db
        .createUnitOfWork("read")
        .forSchema(workflowsSchema)
        .find("workflow_instance", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];
    expect(instance).toBeTruthy();

    await harness.tick(buildPayload(instance!, "create"));

    const status = await harness.getStatus("MUTATION_ERROR", instanceId);
    expect(status.status).toBe("errored");
    expect(status.error?.message).toBeTruthy();

    const mutationRows = (
      await harness.fragments["mutationError"].db
        .createUnitOfWork("read")
        .forSchema(mutationErrorSchema)
        .find("mutation_record", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];
    expect(mutationRows).toHaveLength(0);
  });

  test("does not commit onTerminalError mutations for retryable failures", async () => {
    const terminalErrorSchema = schema("terminal_error_test", (s) =>
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

    const terminalErrorFragmentDefinition = defineFragment("terminal-error-fragment")
      .extend(withDatabase(terminalErrorSchema))
      .build();

    const TerminalErrorWorkflow = defineWorkflow(
      { name: "terminal-error-workflow" },
      async (event, step) => {
        await step.do(
          "unstable",
          { retries: { limit: 1, delay: 0, backoff: "constant" } },
          (tx) => {
            tx.onTerminalError.mutate((ctx) => {
              ctx.forSchema(terminalErrorSchema).create("mutation_record", {
                note: `terminal-${event.instanceId}`,
              });
            });
            throw new Error("RETRY_ME");
          },
        );
        return { ok: true };
      },
    );

    const harness = await createWorkflowsTestHarness({
      workflows: { TERMINAL_ERROR: TerminalErrorWorkflow },
      adapter: { type: "kysely-sqlite" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
      configureBuilder: (builder) =>
        builder.withFragment("terminalError", instantiate(terminalErrorFragmentDefinition)),
    });

    const instanceId = await harness.createInstance("TERMINAL_ERROR");
    const [instance] = (
      await harness.db
        .createUnitOfWork("read")
        .forSchema(workflowsSchema)
        .find("workflow_instance", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];
    expect(instance).toBeTruthy();

    await harness.tick(buildPayload(instance!, "create"));

    const waitingStatus = await harness.getStatus("TERMINAL_ERROR", instanceId);
    expect(waitingStatus.status).toBe("waiting");

    const rows = await (async () => {
      return (
        await harness.fragments["terminalError"].db
          .createUnitOfWork("read")
          .forSchema(terminalErrorSchema)
          .find("mutation_record", (b) => b.whereIndex("primary"))
          .executeRetrieve()
      )[0];
    })();
    expect(rows).toHaveLength(0);
  });

  test("commits onTerminalError mutations for terminal failures", async () => {
    const terminalErrorSchema = schema("terminal_error_commit_test", (s) =>
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

    const terminalErrorFragmentDefinition = defineFragment("terminal-error-commit-fragment")
      .extend(withDatabase(terminalErrorSchema))
      .build();

    const TerminalErrorWorkflow = defineWorkflow(
      { name: "terminal-error-commit-workflow" },
      async (event, step) => {
        await step.do(
          "unstable",
          { retries: { limit: 1, delay: 0, backoff: "constant" } },
          (tx) => {
            tx.onTerminalError.mutate((ctx) => {
              ctx.forSchema(terminalErrorSchema).create("mutation_record", {
                note: `terminal-${event.instanceId}`,
              });
            });
            throw new NonRetryableError("NO_RETRY");
          },
        );
        return { ok: true };
      },
    );

    const harness = await createWorkflowsTestHarness({
      workflows: { TERMINAL_ERROR_COMMIT: TerminalErrorWorkflow },
      adapter: { type: "kysely-sqlite" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
      configureBuilder: (builder) =>
        builder.withFragment("terminalErrorCommit", instantiate(terminalErrorFragmentDefinition)),
    });

    const instanceId = await harness.createInstance("TERMINAL_ERROR_COMMIT");
    const [instance] = (
      await harness.db
        .createUnitOfWork("read")
        .forSchema(workflowsSchema)
        .find("workflow_instance", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];
    expect(instance).toBeTruthy();

    await harness.tick(buildPayload(instance!, "create"));

    const finalStatus = await harness.getStatus("TERMINAL_ERROR_COMMIT", instanceId);
    expect(finalStatus.status).toBe("errored");
    expect(finalStatus.error?.message).toBe("NO_RETRY");

    const rows = await (async () => {
      return (
        await harness.fragments["terminalErrorCommit"].db
          .createUnitOfWork("read")
          .forSchema(terminalErrorSchema)
          .find("mutation_record", (b) => b.whereIndex("primary"))
          .executeRetrieve()
      )[0];
    })();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ note: `terminal-${instanceId}` });
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

    const [stepRecord] = (
      await harness.db
        .createUnitOfWork("read")
        .forSchema(workflowsSchema)
        .find("workflow_step", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];
    expect(stepRecord).toMatchObject({
      stepKey: "do:boom",
      status: "errored",
      attempts: 1,
    });
  });

  test("does not execute a retry tick when persisted attempts already reached maxAttempts", async () => {
    let attempts = 0;
    const RetryCapWorkflow = defineWorkflow(
      { name: "retry-cap-workflow" },
      async (_event, step) => {
        await step.do("flaky", { retries: { limit: 2, delay: 0, backoff: "constant" } }, () => {
          attempts += 1;
          throw new Error("SHOULD_NOT_RUN");
        });
        return { ok: true };
      },
    );

    const harness = await createWorkflowsTestHarness({
      workflows: { RETRY_CAP: RetryCapWorkflow },
      adapter: { type: "in-memory" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
    });

    const instanceId = await harness.createInstance("RETRY_CAP", { id: "retry-cap-1" });
    const [instance] = (
      await harness.db
        .createUnitOfWork("read")
        .forSchema(workflowsSchema)
        .find("workflow_instance", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];
    expect(instance).toBeTruthy();

    {
      const uow = harness.db.createUnitOfWork("seed-retry-cap").forSchema(workflowsSchema);
      uow.update("workflow_instance", instance!.id, (b) =>
        b.set({ status: "waiting", updatedAt: new Date() }),
      );
      uow.create("workflow_step", {
        instanceRef: instance!.id,
        stepKey: "do:flaky",
        name: "flaky",
        type: "do",
        status: "waiting",
        attempts: 3,
        maxAttempts: 3,
        timeoutMs: null,
        nextRetryAt: new Date(Date.now() - 1_000),
        wakeAt: null,
        waitEventType: null,
        result: null,
        errorName: "Error",
        errorMessage: "RETRY_EXHAUSTED",
      });
      const { success } = await uow.executeMutations();
      expect(success).toBe(true);
    }

    const processed = await harness.tick({
      workflowName: "retry-cap-workflow",
      instanceId,
      instanceRef: String(instance!.id),
      reason: "retry",
    });
    expect(processed).toBe(1);
    expect(attempts).toBe(0);

    const status = await harness.getStatus("RETRY_CAP", instanceId);
    expect(status.status).toBe("errored");
    expect(status.error?.message).toBe("RETRY_EXHAUSTED");

    const [stepRecord] = (
      await harness.db
        .createUnitOfWork("read")
        .forSchema(workflowsSchema)
        .find("workflow_step", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];
    expect(stepRecord).toMatchObject({
      stepKey: "do:flaky",
      status: "errored",
      attempts: 3,
      maxAttempts: 3,
      errorMessage: "RETRY_EXHAUSTED",
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
    const [instance] = (
      await harness.db
        .createUnitOfWork("read")
        .forSchema(workflowsSchema)
        .find("workflow_instance", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];
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

    const steps = await (async () => {
      return (
        await harness.db
          .createUnitOfWork("read")
          .forSchema(workflowsSchema)
          .find("workflow_step", (b) => b.whereIndex("primary"))
          .executeRetrieve()
      )[0];
    })();
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
    const [instance] = (
      await harness.db
        .createUnitOfWork("read")
        .forSchema(workflowsSchema)
        .find("workflow_instance", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];
    expect(instance).toBeTruthy();

    await harness.tick(buildPayload(instance!, "create"));

    const status = await harness.getStatus("MUTATION_ORDER", instanceId);
    expect(status.status).toBe("errored");
    expect(status.error?.message).toBe("CALLBACK_FAILED");

    const rows = (
      await harness.fragments["mutationOrder"].db
        .createUnitOfWork("read")
        .forSchema(mutationOrderSchema)
        .find("mutation_record", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];
    expect(rows).toHaveLength(0);
  });

  test("can create a new workflow instance from a step using serviceCalls", async () => {
    const ChildWorkflow = defineWorkflow({ name: "service-call-child-workflow" }, async () => {
      return { createdByParent: true };
    });

    let services: WorkflowsTestHarness["services"] | undefined;
    const ParentWorkflow = defineWorkflow(
      { name: "service-call-parent-workflow" },
      async (event, step) => {
        const childId = `child-${event.instanceId}`;
        await step.do("create child", (tx) => {
          const workflowServices = services;
          if (!workflowServices) {
            throw new Error("MISSING_WORKFLOW_SERVICES");
          }
          tx.serviceCalls(() => [
            workflowServices.createInstance("service-call-child-workflow", {
              id: childId,
            }),
          ]);
          return childId;
        });
        return { childId };
      },
    );

    const harness = await createWorkflowsTestHarness({
      workflows: { PARENT: ParentWorkflow, CHILD: ChildWorkflow },
      adapter: { type: "in-memory" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
    });
    services = harness.services;

    const parentId = await harness.createInstance("PARENT");
    const [parentInstance] = (
      await harness.db
        .createUnitOfWork("read")
        .forSchema(workflowsSchema)
        .find("workflow_instance", (b) =>
          b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
            eb.and(
              eb("workflowName", "=", "service-call-parent-workflow"),
              eb("instanceId", "=", parentId),
            ),
          ),
        )
        .executeRetrieve()
    )[0];
    expect(parentInstance).toBeTruthy();

    await harness.tick(buildPayload(parentInstance!, "create"));

    const childId = `child-${parentId}`;
    expect(await harness.getStatus("PARENT", parentId)).toMatchObject({
      status: "complete",
      output: { childId },
    });
    expect(await harness.getStatus("CHILD", childId)).toMatchObject({ status: "active" });

    const [childInstance] = (
      await harness.db
        .createUnitOfWork("read")
        .forSchema(workflowsSchema)
        .find("workflow_instance", (b) =>
          b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
            eb.and(
              eb("workflowName", "=", "service-call-child-workflow"),
              eb("instanceId", "=", childId),
            ),
          ),
        )
        .executeRetrieve()
    )[0];
    expect(childInstance).toBeTruthy();

    await harness.tick(buildPayload(childInstance!, "create"));

    expect(await harness.getStatus("CHILD", childId)).toMatchObject({
      status: "complete",
      output: { createdByParent: true },
    });
  });

  test("can apply nested mutate-only serviceCalls from a workflow step", async () => {
    const nestedServiceCallsSchema = schema("nested_service_calls_test", (s) =>
      s.addTable("record", (t) =>
        t.addColumn("id", idColumn()).addColumn("note", column("string")),
      ),
    );

    const nestedServiceCallsFragmentDefinition = defineFragment("nested-service-calls-fragment")
      .extend(withDatabase(nestedServiceCallsSchema))
      .providesBaseService(({ defineService }) =>
        defineService({
          createRecord: function (values: { id: string; note: string }) {
            return this.serviceTx(nestedServiceCallsSchema)
              .mutate(({ uow }) => {
                uow.create("record", values);
              })
              .build();
          },
          createRecordThroughNestedServiceCall: function (values: { id: string; note: string }) {
            const createRecord = this.serviceTx(nestedServiceCallsSchema)
              .mutate(({ uow }) => {
                uow.create("record", values);
              })
              .build();
            return this.serviceTx(nestedServiceCallsSchema)
              .withServiceCalls(() => [createRecord] as const)
              .mutate(() => {})
              .build();
          },
        }),
      )
      .build();

    type NestedServiceCallsFragment = AnyFragnoInstantiatedFragment & {
      services: {
        createRecordThroughNestedServiceCall(values: { id: string; note: string }): never;
      };
      db: { createUnitOfWork(mode: "read"): ReturnType<typeof harness.db.createUnitOfWork> };
    };
    let fragment: NestedServiceCallsFragment | undefined;

    const ParentWorkflow = defineWorkflow(
      { name: "nested-service-call-parent-workflow" },
      async (event, step) => {
        await step.do("create nested record", (tx) => {
          const currentFragment = fragment;
          if (!currentFragment) {
            throw new Error("MISSING_FRAGMENT");
          }
          tx.serviceCalls(() => [
            currentFragment.services.createRecordThroughNestedServiceCall({
              id: `record-${event.instanceId}`,
              note: "created",
            }),
          ]);
        });
        return { ok: true };
      },
    );

    const harness = await createWorkflowsTestHarness({
      workflows: { PARENT: ParentWorkflow },
      adapter: { type: "in-memory" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
      configureBuilder: (builder) =>
        builder.withFragment(
          "nestedServiceCalls",
          instantiate(nestedServiceCallsFragmentDefinition),
        ),
    });
    fragment = harness.fragments.nestedServiceCalls as unknown as NestedServiceCallsFragment;

    const parentId = await harness.createInstance("PARENT");
    const [parentInstance] = (
      await harness.db
        .createUnitOfWork("read")
        .forSchema(workflowsSchema)
        .find("workflow_instance", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];
    expect(parentInstance).toBeTruthy();

    await harness.tick(buildPayload(parentInstance!, "create"));

    const status = await harness.getStatus("PARENT", parentId);
    expect(status.error?.message).toBeUndefined();
    expect(status).toMatchObject({ status: "complete" });

    const records = (
      await harness.fragments["nestedServiceCalls"].db
        .createUnitOfWork("read")
        .forSchema(nestedServiceCallsSchema)
        .find("record", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];
    expect(records).toEqual([expect.objectContaining({ id: expect.anything(), note: "created" })]);
  });

  test("marks workflow errored when a step throws a falsy value", async () => {
    const FalsyThrowWorkflow = defineWorkflow(
      { name: "falsy-throw-workflow" },
      async (_event, step) => {
        await step.do("throws-false", () => {
          throw false;
        });
        return { ok: true };
      },
    );

    const harness = await createWorkflowsTestHarness({
      workflows: { FALSY_THROW: FalsyThrowWorkflow },
      adapter: { type: "in-memory" },
      testBuilder: buildDatabaseFragmentsTest(),
    });

    const instanceId = await harness.createInstance("FALSY_THROW");
    const [instance] = (
      await harness.db
        .createUnitOfWork("read")
        .forSchema(workflowsSchema)
        .find("workflow_instance", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];
    expect(instance).toBeTruthy();

    await harness.tick(buildPayload(instance!, "create"));

    const status = await harness.getStatus("FALSY_THROW", instanceId);
    expect(status).toMatchObject({
      status: "errored",
      error: { message: "UNKNOWN_ERROR" },
    });
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
    const [instance] = (
      await harness.db
        .createUnitOfWork("read")
        .forSchema(workflowsSchema)
        .find("workflow_instance", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];
    expect(instance).toBeTruthy();

    await harness.tick(buildPayload(instance!, "create"));

    const initialRows = (
      await harness.fragments["mutationReplay"].db
        .createUnitOfWork("read")
        .forSchema(mutationReplaySchema)
        .find("mutation_log", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];
    expect(initialRows).toHaveLength(1);
    expect(runs).toBe(1);

    await harness.tick(buildPayload(instance!, "event"));

    const replayRows = await (async () => {
      return (
        await harness.fragments["mutationReplay"].db
          .createUnitOfWork("read")
          .forSchema(mutationReplaySchema)
          .find("mutation_log", (b) => b.whereIndex("primary"))
          .executeRetrieve()
      )[0];
    })();
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
    const [instance] = (
      await harness.db
        .createUnitOfWork("read")
        .forSchema(workflowsSchema)
        .find("workflow_instance", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];
    expect(instance).toBeTruthy();

    const tickOne = harness.tick(buildPayload(instance!, "create"));
    await started.promise;
    const tickTwo = harness.tick(buildPayload(instance!, "create"));

    await new Promise((resolve) => setTimeout(resolve, 0));
    blocker.resolve();

    const [firstResult, secondResult] = await Promise.all([tickOne, tickTwo]);
    const processed = [firstResult, secondResult].filter((value) => value > 0);
    expect(processed).toHaveLength(1);

    const steps = await (async () => {
      return (
        await harness.db
          .createUnitOfWork("read")
          .forSchema(workflowsSchema)
          .find("workflow_step", (b) => b.whereIndex("primary"))
          .executeRetrieve()
      )[0];
    })();
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
    const [instance] = (
      await harness.db
        .createUnitOfWork("read")
        .forSchema(workflowsSchema)
        .find("workflow_instance", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];
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

  test("cached parent subtree skip does not renumber later sibling steps", async () => {
    const NestedKeyWorkflow = defineWorkflow(
      { name: "nested-key-workflow" },
      async (_event, step) => {
        await step.do("parent", async () => {
          await step.do("shared", async () => "nested-value");
          return "parent-value";
        });

        await step.waitForEvent("ready", { type: "ready" });
        const shared = await step.do("shared", async () => "top-level-value");
        return { shared };
      },
    );

    const harness = await createWorkflowsTestHarness({
      workflows: { NESTED: NestedKeyWorkflow },
      adapter: { type: "kysely-sqlite" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
    });

    const instanceId = await harness.createInstance("NESTED");
    const [instance] = (
      await harness.db
        .createUnitOfWork("read")
        .forSchema(workflowsSchema)
        .find("workflow_instance", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];
    expect(instance).toBeTruthy();

    await harness.tick(buildPayload(instance!, "create"));
    await harness.sendEvent("NESTED", instanceId, { type: "ready" });
    await harness.tick(buildPayload(instance!, "event"));

    const status = await harness.getStatus("NESTED", instanceId);
    expect(status).toMatchObject({
      status: "complete",
      output: { shared: "top-level-value" },
    });

    const steps = (
      await harness.db
        .createUnitOfWork("read")
        .forSchema(workflowsSchema)
        .find("workflow_step", (b) =>
          b
            .whereIndex("idx_workflow_step_instanceRef_createdAt", (eb) =>
              eb("instanceRef", "=", instance!.id),
            )
            .orderByIndex("idx_workflow_step_instanceRef_createdAt", "asc"),
        )
        .executeRetrieve()
    )[0];

    expect(steps.map((step) => step.stepKey)).toEqual([
      "do:parent",
      "do:parent>do:shared",
      "waitForEvent:ready",
      "do:shared",
    ]);
    expect(steps[1]).toMatchObject({
      parentStepKey: "do:parent",
      depth: 1,
      result: "nested-value",
    });
    expect(steps[3]).toMatchObject({
      parentStepKey: null,
      depth: 0,
      result: "top-level-value",
    });
  });

  test("late descendant failure does not override an observed race winner", async () => {
    const LateFailureWorkflow = defineWorkflow(
      { name: "late-descendant-failure-workflow" },
      async (_event, step) => {
        const raceReturn = await step.do("race", async () => {
          return await Promise.race([
            step.do("slow failure", async () => {
              await step.sleep("slow failure delay", 1000);
              throw new Error("LATE_DESCENDANT_FAILURE");
            }),
            step.do("fast success", async () => "fast"),
          ]);
        });
        return { raceReturn };
      },
    );

    const harness = await createWorkflowsTestHarness({
      workflows: { LATE_FAILURE: LateFailureWorkflow },
      adapter: { type: "in-memory" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
    });

    const instanceId = await harness.createInstance("LATE_FAILURE");
    const [instance] = (
      await harness.db
        .createUnitOfWork("read")
        .forSchema(workflowsSchema)
        .find("workflow_instance", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];
    expect(instance).toBeTruthy();

    await harness.tick(buildPayload(instance!, "create"));
    harness.clock.advanceBy(1000);
    await harness.runUntilIdle(buildPayload(instance!, "wake"));

    const status = await harness.getStatus("LATE_FAILURE", instanceId);
    expect(status.status).toBe("complete");
    expect(status.output).toEqual({ raceReturn: "fast" });
  });
});
