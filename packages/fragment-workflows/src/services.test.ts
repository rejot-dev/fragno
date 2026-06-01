// Tests for workflow service APIs such as instance control, history, and events.
import { beforeAll, beforeEach, describe, expect, test } from "vitest";

import { defaultFragnoRuntime, instantiate } from "@fragno-dev/core";
import type { Cursor, TxResult } from "@fragno-dev/db";
import { buildDatabaseFragmentsTest, drainDurableHooks } from "@fragno-dev/test";

import { workflowsFragmentDefinition } from "./definition";
import { workflowsSchema } from "./schema";
import { defineWorkflow } from "./workflow";
import type { WorkflowInstanceCurrentStep, WorkflowInstanceMetadata } from "./workflow";

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
        .forSchema(workflowsSchema)
        .find("workflow_instance", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];
    expect(instance).toMatchObject({
      workflowName: "demo-workflow",
      status: "active",
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
        .forSchema(workflowsSchema)
        .find("workflow_instance", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];
    expect(instances).toHaveLength(2);
  });

  test("status-filtered list pagination does not skip rows sharing updatedAt", async () => {
    const ids = ["page-0", "page-1", "page-2", "page-3", "page-4"];
    await runService<{ id: string }[]>(() =>
      fragment.services.createBatch(
        "demo-workflow",
        ids.map((id) => ({ id })),
      ),
    );

    const sameUpdatedAt = new Date("2026-01-01T00:00:00.123Z");
    {
      const uow = db.createUnitOfWork("complete-for-pagination").forSchema(workflowsSchema);
      const instances = (
        await db
          .createUnitOfWork("read-created-for-pagination")
          .forSchema(workflowsSchema)
          .find("workflow_instance", (b) => b.whereIndex("primary"))
          .executeRetrieve()
      )[0];
      for (const instance of instances) {
        uow.update("workflow_instance", instance.id, (b) =>
          b.set({ status: "complete", updatedAt: sameUpdatedAt, completedAt: sameUpdatedAt }),
        );
      }
      const { success } = await uow.executeMutations();
      expect(success).toBe(true);
    }

    const seen: string[] = [];
    let cursor: Cursor | undefined;
    do {
      const page = await runService<{
        instances: { id: string }[];
        cursor?: Cursor;
        hasNextPage: boolean;
      }>(() =>
        fragment.services.listInstances({
          workflowName: "demo-workflow",
          status: "complete",
          pageSize: 2,
          cursor,
        }),
      );
      seen.push(...page.instances.map((instance) => instance.id));
      cursor = page.cursor;
      if (!page.hasNextPage) {
        break;
      }
    } while (cursor);

    expect(new Set(seen)).toEqual(new Set(ids));
    expect(seen).toHaveLength(ids.length);
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
        .forSchema(workflowsSchema)
        .find("workflow_instance", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];
    expect(instance).toMatchObject({
      status: "active",
    });

    const [pauseEvent] = (
      await db
        .createUnitOfWork("read")
        .forSchema(workflowsSchema)
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
      const uow = db.createUnitOfWork("set-workflow-instance-paused").forSchema(workflowsSchema);
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
        .forSchema(workflowsSchema)
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
        .forSchema(workflowsSchema)
        .find("workflow_instance", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];

    {
      const uow = db.createUnitOfWork("set-workflow-instance-waiting").forSchema(workflowsSchema);
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
        .forSchema(workflowsSchema)
        .find("workflow_instance", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];
    expect(pausedInstance).toMatchObject({
      status: "waiting",
    });
  });

  test("terminate should mark instance as terminated", async () => {
    await (async () => {
      const uow = db.createUnitOfWork("wf").forSchema(workflowsSchema);
      uow.create("workflow_instance", {
        id: "terminate-1",
        workflowName: "demo-workflow",
        status: "active",
        params: {},
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
        .forSchema(workflowsSchema)
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

  test("sendEvent should buffer and wake waiting instance", async () => {
    const created = await runService<{ id: string }>(() =>
      fragment.services.createInstance("demo-workflow", { id: "event-1" }),
    );
    const [instance] = (
      await db
        .createUnitOfWork("read")
        .forSchema(workflowsSchema)
        .find("workflow_instance", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];

    {
      const uow = db.createUnitOfWork("set-workflow-instance-waiting").forSchema(workflowsSchema);
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
      const uow = db.createUnitOfWork("wf").forSchema(workflowsSchema);
      uow.create("workflow_step", {
        instanceRef: instance.id,
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
        .forSchema(workflowsSchema)
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
      const uow = db.createUnitOfWork("wf").forSchema(workflowsSchema);
      uow.create("workflow_instance", {
        id: instanceId,
        workflowName: "demo-workflow",
        status: "waiting",
        params: {},
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
      const uow = db.createUnitOfWork("wf").forSchema(workflowsSchema);
      uow.create("workflow_step", {
        instanceRef,
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
        .forSchema(workflowsSchema)
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
        .forSchema(workflowsSchema)
        .find("workflow_instance", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];

    {
      const uow = db.createUnitOfWork("complete-workflow-instance").forSchema(workflowsSchema);
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
        .forSchema(workflowsSchema)
        .find("workflow_instance", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];

    const startedAt = new Date("2024-01-02T00:00:00.000Z");
    const updatedAt = new Date("2024-01-02T00:00:10.000Z");

    {
      const uow = db.createUnitOfWork("set-workflow-instance-metadata").forSchema(workflowsSchema);
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
      const uow = db.createUnitOfWork("wf").forSchema(workflowsSchema);
      uow.create("workflow_step", {
        instanceRef: instance.id,
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
      const uow = db.createUnitOfWork("wf").forSchema(workflowsSchema);
      uow.create("workflow_step", {
        instanceRef: instance.id,
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
      params: { source: "meta-test" },
      completedAt: null,
    });
    expect(meta.createdAt).toBeInstanceOf(Date);
    expect(meta.updatedAt).toBeInstanceOf(Date);
    expect(meta.startedAt).toBeInstanceOf(Date);

    const currentStep = await runService<WorkflowInstanceCurrentStep | undefined>(() =>
      fragment.services.getInstanceCurrentStep(created.id),
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

  test("listHistory should return steps and events for a run", async () => {
    const instanceRef = await (async () => {
      const uow = db.createUnitOfWork("wf").forSchema(workflowsSchema);
      uow.create("workflow_instance", {
        id: "history-2",
        workflowName: "demo-workflow",
        status: "active",
        params: {},
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
      const uow = db.createUnitOfWork("wf").forSchema(workflowsSchema);
      uow.create("workflow_step", {
        instanceRef,
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
      const uow = db.createUnitOfWork("wf").forSchema(workflowsSchema);
      uow.create("workflow_step", {
        instanceRef,
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
      const uow = db.createUnitOfWork("wf").forSchema(workflowsSchema);
      uow.create("workflow_event", {
        instanceRef,
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
      const uow = db.createUnitOfWork("wf").forSchema(workflowsSchema);
      uow.create("workflow_event", {
        instanceRef,
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

    await (async () => {
      const uow = db.createUnitOfWork("wf").forSchema(workflowsSchema);
      uow.create("workflow_step_emission", {
        instanceRef,
        stepKey: "do:step-1",
        epoch: "epoch-1",
        sequence: 1,
        actor: "user",
        payload: { frame: "partial" },
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
      steps: Array<{ stepKey: string }>;
      events: Array<{ type: string }>;
      emissions: Array<{ stepKey: string; actor: string }>;
    }>(() =>
      fragment.services.listHistory({
        workflowName: "demo-workflow",
        instanceId: "history-2",
      }),
    );
    expect(history.steps).toHaveLength(2);
    expect(history.events).toHaveLength(2);
    expect(history.emissions).toHaveLength(1);
    expect(history.steps[0]?.stepKey).toBeTruthy();
    expect(history.events[0]?.type).toBeTruthy();
    expect(history.emissions[0]).toMatchObject({ stepKey: "do:step-1", actor: "user" });
  });
});
