// Tests for workflow service APIs such as instance control, history, and events.
import { beforeAll, beforeEach, describe, expect, test } from "vitest";

import {
  defaultFragnoRuntime,
  instantiate,
  type InstantiatedFragmentFromDefinition,
} from "@fragno-dev/core";
import type { TxResult } from "@fragno-dev/db";
import { buildDatabaseFragmentsTest, drainDurableHooks } from "@fragno-dev/test";

import { workflowsFragmentDefinition } from "./definition";
import type { WorkflowsFragmentServices } from "./index";
import { createWorkflowLiveStateStore } from "./live-state";
import { createWorkflowsTestHarness } from "./test";
import { defineWorkflow } from "./workflow";
import type {
  WorkflowEnqueuedHookPayload,
  WorkflowInstanceCurrentStep,
  WorkflowInstanceMetadata,
} from "./workflow";

const demoWorkflow = defineWorkflow({ name: "demo-workflow" }, async (_event, step) => {
  await step.do("noop", () => ({}));
});

describe("Workflows Fragment Services", () => {
  const setup = async () => {
    const { fragments, test: testContext } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "drizzle-pglite" })
      .withFragment(
        "workflows",
        instantiate(workflowsFragmentDefinition).withConfig({
          autoTickHooks: false,
          runtime: defaultFragnoRuntime,
          workflows: { demo: demoWorkflow },
        }),
      )
      .build();

    const { fragment, db } = fragments.workflows;
    return { fragments, testContext, fragment, db };
  };

  type Setup = Awaited<ReturnType<typeof setup>>;

  let testContext: Setup["testContext"];
  let fragment: Setup["fragment"];
  let db: Setup["db"];

  beforeAll(async () => {
    ({ testContext, fragment, db } = await setup());
  });

  const runService = <T>(call: () => unknown) =>
    fragment.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [call() as TxResult<unknown, unknown>] as const)
        .transform(({ serviceResult: [result] }) => result)
        .execute();
    }) as Promise<T>;

  beforeEach(async () => {
    await drainDurableHooks(fragment);
    await testContext.resetDatabase();
  });

  test("restoreInstanceState infers the workflow state from the workflow argument", () => {
    const StatefulWorkflow = defineWorkflow(
      {
        name: "typed-service-restore",
        initialState: { phase: "idle", seeded: false, approved: false },
      },
      async function (_event, step) {
        this?.setState({ phase: "waiting", seeded: true });
        await step.waitForEvent("ready", { type: "ready" });
        this?.setState({ phase: "complete", approved: true });
        return { ok: true };
      },
    );

    type WorkflowsServices = InstantiatedFragmentFromDefinition<
      typeof workflowsFragmentDefinition
    >["services"];

    const typecheck = <T>(_getValue: () => T): void => {};

    typecheck(() => {
      const services = null as unknown as WorkflowsServices;
      const restored = services.restoreInstanceState(StatefulWorkflow, "typed-service-1");
      type RestoredState =
        typeof restored extends TxResult<infer TResult, infer _> ? TResult : never;
      const typed: RestoredState = { phase: "waiting", seeded: true, approved: false };

      return typed;
    });

    expect(StatefulWorkflow.initialState).toBeTruthy();
  });

  test("restoreInstanceState infers the workflow state from the workflow name when the registry is known", () => {
    const StatefulWorkflow = defineWorkflow(
      {
        name: "typed-service-restore-by-name",
        initialState: { phase: "idle", seeded: false, approved: false },
      },
      async function (_event, step) {
        this?.setState({ phase: "waiting", seeded: true });
        await step.waitForEvent("ready", { type: "ready" });
        this?.setState({ phase: "complete", approved: true });
        return { ok: true };
      },
    );

    type StatefulRegistry = {
      stateful: typeof StatefulWorkflow;
    };

    const typecheck = <T>(_getValue: () => T): void => {};

    typecheck(() => {
      const services = null as unknown as WorkflowsFragmentServices<StatefulRegistry>;
      const restored = services.restoreInstanceState("typed-service-restore-by-name", "stateful-1");
      type RestoredState =
        typeof restored extends TxResult<infer TResult, infer _> ? TResult : never;
      const typed: RestoredState = { phase: "waiting", seeded: true, approved: false };

      return typed;
    });

    expect(StatefulWorkflow.name).toBe("typed-service-restore-by-name");
  });

  test("getLiveInstanceState publishes snapshots from this.setState and clears them on restart", async () => {
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

    const LiveWorkflow = defineWorkflow(
      {
        name: "live-stateful-service",
        initialState: { phase: "idle", approved: false },
      },
      async function (_event, step) {
        this?.setState({ phase: "waiting" });
        await step.waitForEvent("ready", { type: "ready" });
        this?.setState({ phase: "complete", approved: true });
        return { ok: true };
      },
    );

    const liveState = createWorkflowLiveStateStore();

    const harness = await createWorkflowsTestHarness({
      workflows: { LIVE: LiveWorkflow },
      adapter: { type: "in-memory" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
      fragmentConfig: { liveState },
    });

    try {
      await harness.createInstance("LIVE", { id: "live-stateful-1" });
      const [createdInstance] = (
        await harness.db
          .createUnitOfWork("read")
          .find("workflow_instance", (b) => b.whereIndex("primary"))
          .executeRetrieve()
      )[0];
      expect(createdInstance).toBeTruthy();

      await harness.tick(buildPayload(createdInstance!, "create"));

      expect(
        harness.fragment.services.getLiveInstanceState("live-stateful-service", "live-stateful-1"),
      ).toMatchObject({
        workflowName: "live-stateful-service",
        instanceId: "live-stateful-1",
        runNumber: 0,
        status: "waiting",
        state: { phase: "waiting", approved: false },
      });

      await harness.sendEvent("LIVE", "live-stateful-1", {
        type: "ready",
        payload: { ok: true },
      });
      const [waitingInstance] = (
        await harness.db
          .createUnitOfWork("read")
          .find("workflow_instance", (b) => b.whereIndex("primary"))
          .executeRetrieve()
      )[0];
      expect(waitingInstance).toBeTruthy();

      await harness.tick(buildPayload(waitingInstance!, "event"));

      expect(
        harness.fragment.services.getLiveInstanceState("live-stateful-service", "live-stateful-1"),
      ).toMatchObject({
        workflowName: "live-stateful-service",
        instanceId: "live-stateful-1",
        runNumber: 0,
        status: "complete",
        state: { phase: "complete", approved: true },
      });

      await harness.fragment.inContext(function () {
        return this.handlerTx()
          .withServiceCalls(() => [
            harness.fragment.services.restartInstance("live-stateful-service", "live-stateful-1"),
          ])
          .transform(({ serviceResult: [result] }) => result)
          .execute();
      });

      expect(
        harness.fragment.services.getLiveInstanceState("live-stateful-service", "live-stateful-1"),
      ).toBeNull();
    } finally {
      await harness.test.cleanup();
    }
  });

  test("getLiveInstanceState reuses the same live state object across ticks", async () => {
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

    const ReusedLiveWorkflow = defineWorkflow(
      {
        name: "reused-live-state-service",
        initialState: {
          phase: "idle",
          members: null as Set<string> | null,
        },
      },
      async function (_event, step) {
        const liveState = this?.getState();
        const currentMembers =
          liveState?.members instanceof Set ? liveState.members : new Set<string>();
        currentMembers.add(currentMembers.size === 0 ? "created" : "reused");
        this?.setState({
          phase: "waiting",
          members: currentMembers,
        });

        await step.waitForEvent("ready", { type: "ready" });

        const refreshedState = this?.getState();
        const finalMembers = refreshedState?.members;
        if (finalMembers instanceof Set) {
          finalMembers.add("ready");
        }

        this?.setState({
          phase: "complete",
        });
        return { ok: true };
      },
    );

    const liveState = createWorkflowLiveStateStore();

    const harness = await createWorkflowsTestHarness({
      workflows: { REUSED: ReusedLiveWorkflow },
      adapter: { type: "in-memory" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
      fragmentConfig: { liveState },
    });

    try {
      await harness.createInstance("REUSED", { id: "reused-live-state-1" });
      const [createdInstance] = (
        await harness.db
          .createUnitOfWork("read")
          .find("workflow_instance", (b) => b.whereIndex("primary"))
          .executeRetrieve()
      )[0];
      expect(createdInstance).toBeTruthy();

      await harness.tick(buildPayload(createdInstance!, "create"));

      const firstSnapshot = harness.fragment.services.getLiveInstanceState(
        "reused-live-state-service",
        "reused-live-state-1",
      );
      expect(firstSnapshot?.state["members"]).toBeInstanceOf(Set);

      await harness.sendEvent("REUSED", "reused-live-state-1", {
        type: "ready",
        payload: { ok: true },
      });
      const [waitingInstance] = (
        await harness.db
          .createUnitOfWork("read")
          .find("workflow_instance", (b) => b.whereIndex("primary"))
          .executeRetrieve()
      )[0];
      expect(waitingInstance).toBeTruthy();

      await harness.tick(buildPayload(waitingInstance!, "event"));

      const secondSnapshot = harness.fragment.services.getLiveInstanceState(
        "reused-live-state-service",
        "reused-live-state-1",
      );

      expect(firstSnapshot?.state).toBe(secondSnapshot?.state);
      expect(firstSnapshot?.state["members"]).toBe(secondSnapshot?.state["members"]);
      expect(Array.from((secondSnapshot?.state["members"] as Set<string>) ?? [])).toEqual([
        "created",
        "reused",
        "ready",
      ]);
    } finally {
      await harness.test.cleanup();
    }
  });

  test("createInstance should create instance records", async () => {
    const result = await runService<{ id: string; details: { status: string } }>(() =>
      fragment.services.createInstance("demo-workflow", {
        params: { source: "service-test" },
      }),
    );

    expect(result.id).toBeTruthy();
    expect(result.details.status).toBe("active");

    const [instance] = (
      await db
        .createUnitOfWork("read")
        .find("workflow_instance", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];
    expect(instance).toMatchObject({
      workflowName: "demo-workflow",
      status: "active",
      runNumber: 0,
    });
    expect(instance.id.toString()).toBe(result.id);
  });

  test("createBatch should skip existing instance IDs", async () => {
    const existing = await runService<{ id: string }>(() =>
      fragment.services.createInstance("demo-workflow", {
        id: "existing-1",
      }),
    );

    const created = await runService<{ id: string }[]>(() =>
      fragment.services.createBatch("demo-workflow", [
        { id: existing.id },
        { id: "fresh-1", params: { source: "batch" } },
      ]),
    );

    expect(created).toHaveLength(1);
    expect(created[0].id).toBe("fresh-1");

    const instances = (
      await db
        .createUnitOfWork("read")
        .find("workflow_instance", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];
    expect(instances).toHaveLength(2);
  });

  test("pause and resume should update status", async () => {
    const created = await runService<{ id: string }>(() =>
      fragment.services.createInstance("demo-workflow", { id: "pause-1" }),
    );

    await drainDurableHooks(fragment);

    const paused = await runService<{ status: string }>(() =>
      fragment.services.pauseInstance("demo-workflow", created.id),
    );
    expect(paused.status).toBe("active");

    const [instance] = (
      await db
        .createUnitOfWork("read")
        .find("workflow_instance", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];
    expect(instance).toMatchObject({
      status: "active",
    });

    const [pauseEvent] = (
      await db
        .createUnitOfWork("read")
        .find("workflow_event", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];
    expect(pauseEvent).toMatchObject({
      actor: "system",
      type: "pause",
      deliveredAt: null,
      consumedByStepKey: null,
    });

    {
      const uow = db.createUnitOfWork("set-workflow-instance-paused");
      uow.update("workflow_instance", instance.id, (b) =>
        b.set({ status: "paused", updatedAt: new Date() }),
      );
      const { success } = await uow.executeMutations();
      if (!success) {
        throw new Error("Failed to update workflow_instance");
      }
    }

    const resumed = await runService<{ status: string }>(() =>
      fragment.services.resumeInstance("demo-workflow", created.id),
    );
    expect(resumed.status).toBe("active");

    const [resumedInstance] = (
      await db
        .createUnitOfWork("read")
        .find("workflow_instance", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];
    expect(resumedInstance).toMatchObject({
      status: "active",
    });

    await drainDurableHooks(fragment);
  });

  test("pauseInstance does not change waiting instances immediately", async () => {
    const created = await runService<{ id: string }>(() =>
      fragment.services.createInstance("demo-workflow", { id: "pause-waiting" }),
    );
    const [instance] = (
      await db
        .createUnitOfWork("read")
        .find("workflow_instance", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];

    {
      const uow = db.createUnitOfWork("set-workflow-instance-waiting");
      uow.update("workflow_instance", instance.id, (b) =>
        b.set({ status: "waiting", updatedAt: new Date() }),
      );
      const { success } = await uow.executeMutations();
      if (!success) {
        throw new Error("Failed to update workflow_instance");
      }
    }

    const paused = await runService<{ status: string }>(() =>
      fragment.services.pauseInstance("demo-workflow", created.id),
    );
    expect(paused.status).toBe("waiting");

    const [pausedInstance] = (
      await db
        .createUnitOfWork("read")
        .find("workflow_instance", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];
    expect(pausedInstance).toMatchObject({
      status: "waiting",
    });
  });

  test("terminate should mark instance as terminated", async () => {
    await (async () => {
      const uow = db.createUnitOfWork("wf");
      uow.create("workflow_instance", {
        id: "terminate-1",
        workflowName: "demo-workflow",
        status: "active",
        params: {},
        runNumber: 0,
        startedAt: null,
        completedAt: null,
        output: null,
        errorName: null,
        errorMessage: null,
      });
      const { success } = await uow.executeMutations();
      if (!success) {
        throw new Error("Failed to create record");
      }
      const id = uow.getCreatedIds()[0];
      if (!id) {
        throw new Error("Missing created id");
      }
      return id;
    })();
    await drainDurableHooks(fragment);

    const terminated = await runService<{ status: string }>(() =>
      fragment.services.terminateInstance("demo-workflow", "terminate-1"),
    );

    expect(terminated.status).toBe("terminated");

    const [instance] = (
      await db
        .createUnitOfWork("read")
        .find("workflow_instance", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];
    expect(instance).toMatchObject({
      workflowName: "demo-workflow",
      status: "terminated",
    });
    expect(instance.id.toString()).toBe("terminate-1");
    expect(instance.completedAt).toBeInstanceOf(Date);
    await drainDurableHooks(fragment);
  });

  test("restart should enqueue new run and reset instance state", async () => {
    const created = await runService<{ id: string }>(() =>
      fragment.services.createInstance("demo-workflow", { id: "restart-1" }),
    );

    const [instance] = (
      await db
        .createUnitOfWork("read")
        .find("workflow_instance", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];
    {
      const uow = db.createUnitOfWork("complete-workflow-instance");
      uow.update("workflow_instance", instance.id, (b) =>
        b.set({
          status: "complete",
          output: { ok: true },
          errorName: "SomethingWrong",
          errorMessage: "bad",
          completedAt: new Date(),
        }),
      );
      const { success } = await uow.executeMutations();
      if (!success) {
        throw new Error("Failed to update workflow_instance");
      }
    }

    const restarted = await runService<{ status: string }>(() =>
      fragment.services.restartInstance("demo-workflow", created.id),
    );

    expect(restarted.status).toBe("active");

    const [restartedInstance] = (
      await db
        .createUnitOfWork("read")
        .find("workflow_instance", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];
    expect(restartedInstance).toMatchObject({
      workflowName: "demo-workflow",
      status: "active",
      runNumber: 1,
      output: null,
      errorName: null,
      errorMessage: null,
      startedAt: null,
      completedAt: null,
    });
    expect(restartedInstance.id.toString()).toBe(created.id);
  });

  test("sendEvent should buffer and wake waiting instance", async () => {
    const created = await runService<{ id: string }>(() =>
      fragment.services.createInstance("demo-workflow", { id: "event-1" }),
    );
    const [instance] = (
      await db
        .createUnitOfWork("read")
        .find("workflow_instance", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];

    {
      const uow = db.createUnitOfWork("set-workflow-instance-waiting");
      uow.update("workflow_instance", instance.id, (b) =>
        b.set({ status: "waiting", updatedAt: new Date() }),
      );
      const { success } = await uow.executeMutations();
      if (!success) {
        throw new Error("Failed to update workflow_instance");
      }
    }
    await drainDurableHooks(fragment);

    await (async () => {
      const uow = db.createUnitOfWork("wf");
      uow.create("workflow_step", {
        instanceRef: instance.id,
        runNumber: 0,
        stepKey: "waitForEvent:wait-1",
        name: "Wait for approval",
        type: "waitForEvent",
        status: "waiting",
        attempts: 0,
        maxAttempts: 1,
        timeoutMs: null,
        nextRetryAt: null,
        wakeAt: null,
        waitEventType: "approval",
        result: null,
        errorName: null,
        errorMessage: null,
      });
      const { success } = await uow.executeMutations();
      if (!success) {
        throw new Error("Failed to create record");
      }
      const id = uow.getCreatedIds()[0];
      if (!id) {
        throw new Error("Missing created id");
      }
      return id;
    })();

    const status = await runService<{ status: string }>(() =>
      fragment.services.sendEvent("demo-workflow", created.id, {
        type: "approval",
        payload: { approved: true },
      }),
    );

    expect(status.status).toBe("waiting");

    const [event] = (
      await db
        .createUnitOfWork("read")
        .find("workflow_event", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];
    expect(event).toMatchObject({
      type: "approval",
      payload: { approved: true },
    });

    await drainDurableHooks(fragment);
  });

  test("sendEvent should not wake when waitForEvent has timed out", async () => {
    const instanceId = "event-timeout";
    const instanceRef = await (async () => {
      const uow = db.createUnitOfWork("wf");
      uow.create("workflow_instance", {
        id: instanceId,
        workflowName: "demo-workflow",
        status: "waiting",
        params: {},
        runNumber: 0,
        startedAt: null,
        completedAt: null,
        output: null,
        errorName: null,
        errorMessage: null,
      });
      const { success } = await uow.executeMutations();
      if (!success) {
        throw new Error("Failed to create record");
      }
      const id = uow.getCreatedIds()[0];
      if (!id) {
        throw new Error("Missing created id");
      }
      return id;
    })();

    await (async () => {
      const uow = db.createUnitOfWork("wf");
      uow.create("workflow_step", {
        instanceRef,
        runNumber: 0,
        stepKey: "waitForEvent:wait-timeout",
        name: "Wait for approval",
        type: "waitForEvent",
        status: "waiting",
        attempts: 0,
        maxAttempts: 1,
        timeoutMs: null,
        nextRetryAt: null,
        wakeAt: new Date("2000-01-01T00:00:00.000Z"),
        waitEventType: "approval",
        result: null,
        errorName: null,
        errorMessage: null,
      });
      const { success } = await uow.executeMutations();
      if (!success) {
        throw new Error("Failed to create record");
      }
      const id = uow.getCreatedIds()[0];
      if (!id) {
        throw new Error("Missing created id");
      }
      return id;
    })();

    await runService(() =>
      fragment.services.sendEvent("demo-workflow", instanceId, {
        type: "approval",
        payload: { approved: true },
      }),
    );

    await drainDurableHooks(fragment);
    const [event] = (
      await db
        .createUnitOfWork("read")
        .find("workflow_event", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];
    expect(event).toMatchObject({
      type: "approval",
    });
  });

  test("sendEvent should reject terminal instances", async () => {
    const created = await runService<{ id: string }>(() =>
      fragment.services.createInstance("demo-workflow", { id: "event-2" }),
    );
    const [instance] = (
      await db
        .createUnitOfWork("read")
        .find("workflow_instance", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];

    {
      const uow = db.createUnitOfWork("complete-workflow-instance");
      uow.update("workflow_instance", instance.id, (b) =>
        b.set({ status: "complete", updatedAt: new Date() }),
      );
      const { success } = await uow.executeMutations();
      if (!success) {
        throw new Error("Failed to update workflow_instance");
      }
    }

    await expect(
      runService(() => fragment.services.sendEvent("demo-workflow", created.id, { type: "noop" })),
    ).rejects.toThrow("INSTANCE_TERMINAL");
  });

  test("getInstanceMetadata and getInstanceCurrentStep should return operator metadata", async () => {
    const created = await runService<{ id: string }>(() =>
      fragment.services.createInstance("demo-workflow", {
        id: "meta-1",
        params: { source: "meta-test" },
      }),
    );

    const [instance] = (
      await db
        .createUnitOfWork("read")
        .find("workflow_instance", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];

    const startedAt = new Date("2024-01-02T00:00:00.000Z");
    const updatedAt = new Date("2024-01-02T00:00:10.000Z");

    {
      const uow = db.createUnitOfWork("set-workflow-instance-metadata");
      uow.update("workflow_instance", instance.id, (b) =>
        b.set({
          status: "waiting",
          startedAt,
          updatedAt,
        }),
      );
      const { success } = await uow.executeMutations();
      if (!success) {
        throw new Error("Failed to update workflow_instance");
      }
    }

    const firstStepAt = new Date("2024-01-02T00:00:20.000Z");
    const currentStepAt = new Date("2024-01-02T00:00:30.000Z");

    await (async () => {
      const uow = db.createUnitOfWork("wf");
      uow.create("workflow_step", {
        instanceRef: instance.id,
        runNumber: 0,
        stepKey: "do:step-1",
        name: "first",
        type: "do",
        status: "complete",
        attempts: 1,
        maxAttempts: 3,
        timeoutMs: null,
        nextRetryAt: null,
        wakeAt: null,
        waitEventType: null,
        result: null,
        errorName: null,
        errorMessage: null,
        createdAt: firstStepAt,
        updatedAt: firstStepAt,
      });
      const { success } = await uow.executeMutations();
      if (!success) {
        throw new Error("Failed to create record");
      }
      const id = uow.getCreatedIds()[0];
      if (!id) {
        throw new Error("Missing created id");
      }
      return id;
    })();

    await (async () => {
      const uow = db.createUnitOfWork("wf");
      uow.create("workflow_step", {
        instanceRef: instance.id,
        runNumber: 0,
        stepKey: "waitForEvent:step-2",
        name: "await-approval",
        type: "waitForEvent",
        status: "waiting",
        attempts: 0,
        maxAttempts: 1,
        timeoutMs: null,
        nextRetryAt: null,
        wakeAt: null,
        waitEventType: "approved",
        result: null,
        errorName: null,
        errorMessage: null,
        createdAt: currentStepAt,
        updatedAt: currentStepAt,
      });
      const { success } = await uow.executeMutations();
      if (!success) {
        throw new Error("Failed to create record");
      }
      const id = uow.getCreatedIds()[0];
      if (!id) {
        throw new Error("Missing created id");
      }
      return id;
    })();

    const meta = await runService<WorkflowInstanceMetadata>(() =>
      fragment.services.getInstanceMetadata("demo-workflow", created.id),
    );

    expect(meta).toMatchObject({
      workflowName: "demo-workflow",
      runNumber: 0,
      params: { source: "meta-test" },
      completedAt: null,
    });
    expect(meta.createdAt).toBeInstanceOf(Date);
    expect(meta.updatedAt).toBeInstanceOf(Date);
    expect(meta.startedAt).toBeInstanceOf(Date);

    const currentStep = await runService<WorkflowInstanceCurrentStep | undefined>(() =>
      fragment.services.getInstanceCurrentStep({
        instanceId: created.id,
        runNumber: meta.runNumber,
      }),
    );

    expect(currentStep).toMatchObject({
      stepKey: "waitForEvent:step-2",
      name: "await-approval",
      type: "waitForEvent",
      status: "waiting",
      attempts: 0,
      maxAttempts: 1,
      waitEventType: "approved",
    });
  });

  test("getInstanceRunNumber should return current run", async () => {
    await (async () => {
      const uow = db.createUnitOfWork("wf");
      uow.create("workflow_instance", {
        id: "history-1",
        workflowName: "demo-workflow",
        status: "active",
        params: {},
        runNumber: 3,
        startedAt: null,
        completedAt: null,
        output: null,
        errorName: null,
        errorMessage: null,
      });
      const { success } = await uow.executeMutations();
      if (!success) {
        throw new Error("Failed to create record");
      }
      const id = uow.getCreatedIds()[0];
      if (!id) {
        throw new Error("Missing created id");
      }
      return id;
    })();

    const runNumber = await runService<number>(() =>
      fragment.services.getInstanceRunNumber("demo-workflow", "history-1"),
    );

    expect(runNumber).toBe(3);
  });

  test("restoreInstanceState should replay current state without consuming pending events", async () => {
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

    const StatefulWorkflow = defineWorkflow(
      {
        name: "stateful-service-restore",
        initialState: { phase: "idle", seeded: false, approved: false },
      },
      async function (_event, step) {
        this?.setState({ phase: "starting" });

        const seed = await step.do("seed", () => ({ seed: 1 }));

        this?.setState({ phase: "waiting", seeded: seed.seed > 0 });
        await step.waitForEvent("ready", { type: "ready" });
        this?.setState({ phase: "complete", approved: true });

        return { ok: true };
      },
    );

    const harness = await createWorkflowsTestHarness({
      workflows: { STATEFUL: StatefulWorkflow },
      adapter: { type: "in-memory" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
    });

    await harness.createInstance("STATEFUL", { id: "stateful-1" });
    const [createdInstance] = (
      await harness.db
        .createUnitOfWork("read")
        .find("workflow_instance", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];
    expect(createdInstance).toBeTruthy();

    await harness.tick(buildPayload(createdInstance!, "create"));
    await harness.sendEvent("STATEFUL", "stateful-1", {
      type: "ready",
      payload: { ok: true },
    });

    const [waitingInstance] = (
      await harness.db
        .createUnitOfWork("read")
        .find("workflow_instance", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];
    const [pendingEventBefore] = (
      await harness.db
        .createUnitOfWork("read")
        .find("workflow_event", (b) =>
          b
            .whereIndex("idx_workflow_event_instanceRef_runNumber_createdAt", (eb) =>
              eb.and(
                eb("instanceRef", "=", waitingInstance!.id),
                eb("runNumber", "=", waitingInstance!.runNumber),
              ),
            )
            .orderByIndex("idx_workflow_event_instanceRef_runNumber_createdAt", "asc"),
        )
        .executeRetrieve()
    )[0];

    const restored = await harness.fragment.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          harness.fragment.services.restoreInstanceState("stateful-service-restore", "stateful-1"),
        ])
        .transform(({ serviceResult: [result] }) => result)
        .execute();
    });

    const [pendingEventAfter] = (
      await harness.db
        .createUnitOfWork("read")
        .find("workflow_event", (b) =>
          b
            .whereIndex("idx_workflow_event_instanceRef_runNumber_createdAt", (eb) =>
              eb.and(
                eb("instanceRef", "=", waitingInstance!.id),
                eb("runNumber", "=", waitingInstance!.runNumber),
              ),
            )
            .orderByIndex("idx_workflow_event_instanceRef_runNumber_createdAt", "asc"),
        )
        .executeRetrieve()
    )[0];

    expect(restored).toEqual({ phase: "waiting", seeded: true, approved: false });
    expect(pendingEventBefore?.consumedByStepKey).toBeNull();
    expect(pendingEventAfter?.consumedByStepKey).toBeNull();
  });

  test("listHistory should return steps and events for a run", async () => {
    const instanceRef = await (async () => {
      const uow = db.createUnitOfWork("wf");
      uow.create("workflow_instance", {
        id: "history-2",
        workflowName: "demo-workflow",
        status: "active",
        params: {},
        runNumber: 1,
        startedAt: null,
        completedAt: null,
        output: null,
        errorName: null,
        errorMessage: null,
      });
      const { success } = await uow.executeMutations();
      if (!success) {
        throw new Error("Failed to create record");
      }
      const id = uow.getCreatedIds()[0];
      if (!id) {
        throw new Error("Missing created id");
      }
      return id;
    })();

    await (async () => {
      const uow = db.createUnitOfWork("wf");
      uow.create("workflow_step", {
        instanceRef,
        runNumber: 1,
        stepKey: "do:step-1",
        name: "Step One",
        type: "do",
        status: "completed",
        attempts: 1,
        maxAttempts: 1,
        timeoutMs: null,
        nextRetryAt: null,
        wakeAt: null,
        waitEventType: null,
        result: { ok: true },
        errorName: null,
        errorMessage: null,
      });
      const { success } = await uow.executeMutations();
      if (!success) {
        throw new Error("Failed to create record");
      }
      const id = uow.getCreatedIds()[0];
      if (!id) {
        throw new Error("Missing created id");
      }
      return id;
    })();

    await (async () => {
      const uow = db.createUnitOfWork("wf");
      uow.create("workflow_step", {
        instanceRef,
        runNumber: 1,
        stepKey: "sleep:step-2",
        name: "Step Two",
        type: "sleep",
        status: "waiting",
        attempts: 0,
        maxAttempts: 1,
        timeoutMs: null,
        nextRetryAt: null,
        wakeAt: new Date(Date.now() + 60_000),
        waitEventType: null,
        result: null,
        errorName: null,
        errorMessage: null,
      });
      const { success } = await uow.executeMutations();
      if (!success) {
        throw new Error("Failed to create record");
      }
      const id = uow.getCreatedIds()[0];
      if (!id) {
        throw new Error("Missing created id");
      }
      return id;
    })();

    await (async () => {
      const uow = db.createUnitOfWork("wf");
      uow.create("workflow_event", {
        instanceRef,
        runNumber: 1,
        actor: "user",
        type: "approval",
        payload: { approved: true },
        deliveredAt: null,
        consumedByStepKey: null,
      });
      const { success } = await uow.executeMutations();
      if (!success) {
        throw new Error("Failed to create record");
      }
      const id = uow.getCreatedIds()[0];
      if (!id) {
        throw new Error("Missing created id");
      }
      return id;
    })();

    await (async () => {
      const uow = db.createUnitOfWork("wf");
      uow.create("workflow_event", {
        instanceRef,
        runNumber: 1,
        actor: "user",
        type: "note",
        payload: { note: "extra" },
        deliveredAt: null,
        consumedByStepKey: null,
      });
      const { success } = await uow.executeMutations();
      if (!success) {
        throw new Error("Failed to create record");
      }
      const id = uow.getCreatedIds()[0];
      if (!id) {
        throw new Error("Missing created id");
      }
      return id;
    })();

    const history = await runService<{
      runNumber: number;
      steps: Array<{ stepKey: string }>;
      events: Array<{ type: string }>;
    }>(() =>
      fragment.services.listHistory({
        workflowName: "demo-workflow",
        instanceId: "history-2",
        runNumber: 1,
      }),
    );

    expect(history.runNumber).toBe(1);
    expect(history.steps).toHaveLength(2);
    expect(history.events).toHaveLength(2);
    expect(history.steps[0]?.stepKey).toBeTruthy();
    expect(history.events[0]?.type).toBeTruthy();
  });
});
