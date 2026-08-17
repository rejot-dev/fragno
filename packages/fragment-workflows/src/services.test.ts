// Tests for workflow service APIs such as instance control, history, and events.
import { beforeAll, beforeEach, describe, expect, test, assert } from "vitest";

import { defaultFragnoRuntime, instantiate } from "@fragno-dev/core";
import { getDurableHooksService, type Cursor, type TxResult } from "@fragno-dev/db";
import { buildDatabaseFragmentsTest, drainDurableHooks } from "@fragno-dev/test";

import { workflowsFragmentDefinition } from "./definition";
import { buildScopedInstanceRowId } from "./instance-ref";
import { workflowsSchema } from "./schema";
import { defineRemoteWorkflow, defineWorkflow } from "./workflow";
import type { WorkflowInstanceCurrentStep, WorkflowInstanceMetadata } from "./workflow";

const demoWorkflow = defineWorkflow({ name: "demo-workflow" }, async (_event, step) => {
  await step.do("noop", () => ({}));
});

const remoteDemoWorkflow = defineRemoteWorkflow(
  { name: "remote-demo-workflow" },
  async (_event, step) => {
    await step.do(null, "noop", undefined, () => ({}));
  },
);

describe("Workflows Fragment Services", () => {
  const setup = async () => {
    const { fragments, test: testContext } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "drizzle-pglite" })
      .withFragment(
        "workflows",
        instantiate(workflowsFragmentDefinition).withConfig({
          autoTickHooks: false,
          runtime: defaultFragnoRuntime,
          workflows: { demo: demoWorkflow, remoteDemo: remoteDemoWorkflow },
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

  const createErroredRetryFixture = async (
    instanceId: string,
    steps: Array<{
      stepKey: string;
      parentStepKey: string | null;
      type?: "do" | "waitForEvent";
      status?: "completed" | "errored";
      createdAt?: Date;
    }>,
  ) => {
    const instanceRef = await (async () => {
      const uow = db.createUnitOfWork("create-errored-retry-fixture").forSchema(workflowsSchema);
      uow.create("workflow_instance", {
        id: buildScopedInstanceRowId("demo-workflow", instanceId),
        instanceId,
        workflowName: "demo-workflow",
        status: "errored",
        params: {},
        startedAt: new Date("2026-01-01T00:00:00.000Z"),
        completedAt: new Date("2026-01-01T00:00:01.000Z"),
        output: null,
        errorName: "Error",
        errorMessage: "boom",
      });
      const { success } = await uow.executeMutations();
      if (!success) {
        throw new Error("Failed to create errored retry fixture instance");
      }
      const id = uow.getCreatedIds()[0];
      if (!id) {
        throw new Error("Missing errored retry fixture instance id");
      }
      return id;
    })();

    const uow = db
      .createUnitOfWork("create-errored-retry-fixture-steps")
      .forSchema(workflowsSchema);
    for (const step of steps) {
      uow.create("workflow_step", {
        instanceRef,
        stepKey: step.stepKey,
        parentStepKey: step.parentStepKey,
        committedByExecutionId: "fixture-execution",
        name: step.stepKey,
        type: step.type ?? "do",
        status: step.status ?? "errored",
        attempts: 1,
        maxAttempts: 1,
        timeoutMs: null,
        nextRetryAt: null,
        wakeAt: null,
        waitEventType: null,
        result: null,
        errorName: "Error",
        errorMessage: "boom",
        createdAt: step.createdAt,
      });
    }
    const { success } = await uow.executeMutations();
    if (!success) {
      throw new Error("Failed to create errored retry fixture steps");
    }
  };

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
    assert(result.details.status === "active");

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
    expect(instance.instanceId).toBe(result.id);
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
    assert(created[0].id === "fresh-1");

    const instances = (
      await db
        .createUnitOfWork("read")
        .forSchema(workflowsSchema)
        .find("workflow_instance", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];
    expect(instances).toHaveLength(2);
  });

  test("listInstances paginates equal creation times across orders and optional filters", async () => {
    const records = [
      { id: "page-0", remoteWorkflowName: "remote-a", status: "complete" },
      { id: "page-1", remoteWorkflowName: "remote-a", status: "active" },
      { id: "page-2", remoteWorkflowName: "remote-a", status: "complete" },
      { id: "page-3", remoteWorkflowName: "remote-b", status: "complete" },
      { id: "page-4", remoteWorkflowName: "remote-a", status: "complete" },
      { id: "page-5", remoteWorkflowName: "remote-b", status: "active" },
    ] as const;
    const sharedCreatedAt = new Date("2026-01-01T00:00:00.123Z");
    const uow = db.createUnitOfWork("equal-creation-time-pagination").forSchema(workflowsSchema);
    for (const record of records) {
      uow.create("workflow_instance", {
        id: buildScopedInstanceRowId("demo-workflow", record.id),
        workflowName: "demo-workflow",
        remoteWorkflowName: record.remoteWorkflowName,
        instanceId: record.id,
        status: record.status,
        params: {},
        createdAt: sharedCreatedAt,
        updatedAt: sharedCreatedAt,
        startedAt: null,
        completedAt: record.status === "complete" ? sharedCreatedAt : null,
        output: null,
        errorName: null,
        errorMessage: null,
      });
    }
    assert((await uow.executeMutations()).success);

    const collectInstanceIds = async (filters: {
      remoteWorkflowName?: string;
      status?: "active" | "complete";
      order?: "asc" | "desc";
    }) => {
      const seen: string[] = [];
      let cursor: Cursor | undefined;

      for (;;) {
        const page = await runService<{
          instances: { id: string }[];
          cursor?: Cursor;
          hasNextPage: boolean;
        }>(() =>
          fragment.services.listInstances({
            workflowName: "demo-workflow",
            ...filters,
            pageSize: 2,
            cursor,
          }),
        );
        seen.push(...page.instances.map((instance) => instance.id));

        if (!page.hasNextPage) {
          return seen;
        }
        assert(page.cursor);
        cursor = page.cursor;
      }
    };

    expect(await collectInstanceIds({ order: "asc" })).toEqual([
      "page-0",
      "page-1",
      "page-2",
      "page-3",
      "page-4",
      "page-5",
    ]);
    expect(await collectInstanceIds({ status: "complete" })).toEqual([
      "page-4",
      "page-3",
      "page-2",
      "page-0",
    ]);
    expect(await collectInstanceIds({ remoteWorkflowName: "remote-a" })).toEqual([
      "page-4",
      "page-2",
      "page-1",
      "page-0",
    ]);
    expect(
      await collectInstanceIds({ remoteWorkflowName: "remote-a", status: "complete" }),
    ).toEqual(["page-4", "page-2", "page-0"]);
  });

  test("listInstances uses creation-time order with optional filters", async () => {
    const records = [
      {
        id: "created-first",
        remoteWorkflowName: "remote-a",
        status: "complete",
        createdAt: new Date("2026-08-01T09:00:00.000Z"),
      },
      {
        id: "created-last",
        remoteWorkflowName: "remote-b",
        status: "active",
        createdAt: new Date("2026-08-01T11:00:00.000Z"),
      },
      {
        id: "created-middle",
        remoteWorkflowName: "remote-a",
        status: "complete",
        createdAt: new Date("2026-08-01T10:00:00.000Z"),
      },
    ];
    const uow = db.createUnitOfWork("creation-order-fixtures").forSchema(workflowsSchema);
    for (const { id, remoteWorkflowName, status, createdAt } of records) {
      uow.create("workflow_instance", {
        id: buildScopedInstanceRowId("demo-workflow", id),
        workflowName: "demo-workflow",
        remoteWorkflowName,
        instanceId: id,
        status,
        params: { source: id },
        createdAt,
        updatedAt: createdAt,
        startedAt: null,
        completedAt: null,
        output: null,
        errorName: null,
        errorMessage: null,
      });
    }
    assert((await uow.executeMutations()).success);

    const page = await runService<{
      instances: Array<{ id: string; params: unknown; updatedAt: Date }>;
    }>(() =>
      fragment.services.listInstances({
        workflowName: "demo-workflow",
        pageSize: 2,
      }),
    );

    expect(page.instances).toEqual([
      expect.objectContaining({
        id: "created-last",
        params: { source: "created-last" },
        updatedAt: new Date("2026-08-01T11:00:00.000Z"),
      }),
      expect.objectContaining({
        id: "created-middle",
        params: { source: "created-middle" },
        updatedAt: new Date("2026-08-01T10:00:00.000Z"),
      }),
    ]);

    const filteredPage = await runService<{ instances: Array<{ id: string }> }>(() =>
      fragment.services.listInstances({
        workflowName: "demo-workflow",
        remoteWorkflowName: "remote-a",
        status: "complete",
      }),
    );
    expect(filteredPage.instances.map((instance) => instance.id)).toEqual([
      "created-middle",
      "created-first",
    ]);
  });

  test("listInstances filters by remote workflow name and status together", async () => {
    const records = [
      { id: "remote-a-complete", remoteWorkflowName: "remote-a", status: "complete" },
      { id: "remote-a-active", remoteWorkflowName: "remote-a", status: "active" },
      { id: "remote-b-complete", remoteWorkflowName: "remote-b", status: "complete" },
    ] as const;

    const uow = db.createUnitOfWork("remote-status-filter").forSchema(workflowsSchema);
    for (const record of records) {
      uow.create("workflow_instance", {
        id: buildScopedInstanceRowId("demo-workflow", record.id),
        instanceId: record.id,
        workflowName: "demo-workflow",
        remoteWorkflowName: record.remoteWorkflowName,
        status: record.status,
        params: {},
        startedAt: null,
        completedAt: record.status === "complete" ? new Date("2026-01-01T00:00:00.000Z") : null,
        output: null,
        errorName: null,
        errorMessage: null,
      });
    }
    assert((await uow.executeMutations()).success);

    const page = await runService<{ instances: { id: string }[] }>(() =>
      fragment.services.listInstances({
        workflowName: "demo-workflow",
        remoteWorkflowName: "remote-a",
        status: "complete",
      }),
    );

    expect(page.instances.map((instance) => instance.id)).toEqual(["remote-a-complete"]);
  });

  test("pause and resume should update status", async () => {
    const created = await runService<{ id: string }>(() =>
      fragment.services.createInstance("demo-workflow", { id: "pause-1" }),
    );

    await drainDurableHooks(fragment);

    const paused = await runService<{ status: string }>(() =>
      fragment.services.pauseInstance("demo-workflow", created.id),
    );
    assert(paused.status === "active");

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
    assert(resumed.status === "active");

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
    assert(paused.status === "waiting");

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
        id: buildScopedInstanceRowId("demo-workflow", "terminate-1"),
        instanceId: "terminate-1",
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

    assert(terminated.status === "terminated");

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
    assert(instance.instanceId === "terminate-1");
    expect(instance.completedAt).toBeInstanceOf(Date);
    await drainDurableHooks(fragment);
  });

  test("restartInstance should clear all execution state and events", async () => {
    const instanceRef = await (async () => {
      const uow = db.createUnitOfWork("create-restart-instance").forSchema(workflowsSchema);
      uow.create("workflow_instance", {
        id: buildScopedInstanceRowId("demo-workflow", "restart-1"),
        instanceId: "restart-1",
        workflowName: "demo-workflow",
        status: "complete",
        params: { source: "restart-test" },
        startedAt: new Date("2026-01-01T00:00:00.000Z"),
        completedAt: new Date("2026-01-01T00:00:01.000Z"),
        output: { old: true },
        errorName: "OldError",
        errorMessage: "old failure",
      });
      const { success } = await uow.executeMutations();
      if (!success) {
        throw new Error("Failed to create restart instance");
      }
      const id = uow.getCreatedIds()[0];
      if (!id) {
        throw new Error("Missing restart instance id");
      }
      return id;
    })();

    await (async () => {
      const uow = db.createUnitOfWork("create-restart-state").forSchema(workflowsSchema);
      uow.create("workflow_step", {
        instanceRef,
        stepKey: "do:old",
        committedByExecutionId: "old-execution",
        name: "old",
        type: "do",
        status: "completed",
        attempts: 1,
        maxAttempts: 1,
        timeoutMs: null,
        nextRetryAt: null,
        wakeAt: null,
        waitEventType: null,
        result: { old: true },
        errorName: null,
        errorMessage: null,
      });
      uow.create("workflow_event", {
        instanceRef,
        actor: "user",
        type: "approval",
        payload: { approved: true },
        deliveredAt: null,
        consumedByStepKey: null,
      });
      uow.create("workflow_event", {
        instanceRef,
        actor: "user",
        type: "already-consumed",
        payload: { value: 1 },
        deliveredAt: new Date("2026-01-01T00:00:00.500Z"),
        consumedByStepKey: "do:old",
      });
      uow.create("workflow_step_emission", {
        instanceRef,
        stepKey: "do:old",
        executionId: "old-execution",
        epoch: "old-epoch",
        sequence: 0,
        actor: "user",
        payload: { progress: 1 },
      });
      const { success } = await uow.executeMutations();
      if (!success) {
        throw new Error("Failed to create restart state");
      }
    })();

    const status = await runService<{ status: string }>(() =>
      fragment.services.restartInstance("demo-workflow", "restart-1"),
    );
    expect(status).toMatchObject({ status: "active" });

    const [instances, steps, events, emissions] = await db
      .createUnitOfWork("read-restarted-state")
      .forSchema(workflowsSchema)
      .find("workflow_instance", (b) => b.whereIndex("primary"))
      .find("workflow_step", (b) => b.whereIndex("primary"))
      .find("workflow_event", (b) => b.whereIndex("primary"))
      .find("workflow_step_emission", (b) => b.whereIndex("primary"))
      .executeRetrieve();

    expect(instances[0]).toMatchObject({
      status: "active",
      runGeneration: 2,
      params: { source: "restart-test" },
      startedAt: null,
      completedAt: null,
      output: null,
      errorName: null,
      errorMessage: null,
    });
    expect(steps).toEqual([]);
    expect(emissions).toEqual([]);
    expect(events).toEqual([]);
  });

  test("restartOrCreateInstance should create a missing instance with create params", async () => {
    const result = await runService<{
      action: string;
      id: string;
      details: { status: string };
    }>(() =>
      fragment.services.restartOrCreateInstance("demo-workflow", {
        id: "restart-or-create-missing",
        create: { params: { source: "create-branch" } },
        restart: { precondition: { status: { in: ["errored", "complete"] } } },
      }),
    );

    expect(result).toMatchObject({
      action: "created",
      id: "restart-or-create-missing",
      details: { status: "active", runGeneration: 1 },
    });

    const [[instance]] = await db
      .createUnitOfWork("read-restart-or-create-created")
      .forSchema(workflowsSchema)
      .find("workflow_instance", (b) => b.whereIndex("primary"))
      .executeRetrieve();
    expect(instance).toMatchObject({
      instanceId: "restart-or-create-missing",
      params: { source: "create-branch" },
      runGeneration: 1,
    });
  });

  test("restartOrCreateInstance should leave an existing instance unchanged when its status does not match", async () => {
    await runService(() =>
      fragment.services.createInstance("demo-workflow", {
        id: "restart-or-create-active",
        params: { source: "original" },
      }),
    );

    const result = await runService<{
      action: string;
      observedStatus: string;
      details: { status: string };
    }>(() =>
      fragment.services.restartOrCreateInstance("demo-workflow", {
        id: "restart-or-create-active",
        create: { params: { source: "ignored" } },
        restart: { precondition: { status: { in: ["errored", "complete"] } } },
      }),
    );

    expect(result).toMatchObject({
      action: "unchanged",
      observedStatus: "active",
      details: { status: "active", runGeneration: 1 },
    });

    const [[instance]] = await db
      .createUnitOfWork("read-restart-or-create-unchanged")
      .forSchema(workflowsSchema)
      .find("workflow_instance", (b) => b.whereIndex("primary"))
      .executeRetrieve();
    expect(instance).toMatchObject({
      params: { source: "original" },
      runGeneration: 1,
    });
  });

  test("restartOrCreateInstance should leave a matching status unchanged when runGeneration does not match", async () => {
    const instanceRef = buildScopedInstanceRowId(
      "demo-workflow",
      "restart-or-create-stale-generation",
    );
    const uow = db.createUnitOfWork("create-stale-generation-instance").forSchema(workflowsSchema);
    uow.create("workflow_instance", {
      id: instanceRef,
      instanceId: "restart-or-create-stale-generation",
      workflowName: "demo-workflow",
      status: "complete",
      runGeneration: 2,
      params: { source: "original" },
      startedAt: new Date("2026-01-01T00:00:00.000Z"),
      completedAt: new Date("2026-01-01T00:00:01.000Z"),
      output: { old: true },
      errorName: null,
      errorMessage: null,
    });
    const mutationResult = await uow.executeMutations();
    assert(mutationResult.success);

    const result = await runService<{
      action: string;
      observedStatus: string;
      details: { status: string; runGeneration: number };
    }>(() =>
      fragment.services.restartOrCreateInstance("demo-workflow", {
        id: "restart-or-create-stale-generation",
        create: { params: { source: "ignored" } },
        restart: {
          precondition: {
            status: { in: ["complete"] },
            runGeneration: { equals: 1 },
          },
        },
      }),
    );

    expect(result).toMatchObject({
      action: "unchanged",
      observedStatus: "complete",
      details: { status: "complete", runGeneration: 2 },
    });
  });

  test.each(["active", "waiting", "paused", "errored", "complete", "terminated"] as const)(
    "restartOrCreateInstance should restart an existing %s instance and preserve its params",
    async (status) => {
      const instanceId = `restart-or-create-${status}`;
      const instanceRef = buildScopedInstanceRowId("demo-workflow", instanceId);
      const uow = db
        .createUnitOfWork("create-restart-or-create-existing")
        .forSchema(workflowsSchema);
      uow.create("workflow_instance", {
        id: instanceRef,
        instanceId,
        workflowName: "demo-workflow",
        status,
        params: { source: "original" },
        startedAt: new Date("2026-01-01T00:00:00.000Z"),
        completedAt: new Date("2026-01-01T00:00:01.000Z"),
        output: { old: true },
        errorName: status === "errored" ? "Error" : null,
        errorMessage: status === "errored" ? "boom" : null,
      });
      uow.create("workflow_step", {
        instanceRef,
        stepKey: "do:old",
        committedByExecutionId: "old-execution",
        name: "old",
        type: "do",
        status: "completed",
        attempts: 1,
        maxAttempts: 1,
        timeoutMs: null,
        nextRetryAt: null,
        wakeAt: null,
        waitEventType: null,
        result: { old: true },
        errorName: null,
        errorMessage: null,
      });
      const mutationResult = await uow.executeMutations();
      assert(mutationResult.success);

      const result = await runService<{
        action: string;
        previousStatus: string;
        details: { status: string };
      }>(() =>
        fragment.services.restartOrCreateInstance("demo-workflow", {
          id: instanceId,
          create: { params: { source: "ignored" } },
          restart: {
            precondition: {
              status: { in: [status] },
              runGeneration: { equals: 1 },
            },
          },
        }),
      );

      expect(result).toMatchObject({
        action: "restarted",
        previousStatus: status,
        details: { status: "active", runGeneration: 2 },
      });

      const [[instance], steps] = await db
        .createUnitOfWork("read-restart-or-create-restarted")
        .forSchema(workflowsSchema)
        .find("workflow_instance", (b) => b.whereIndex("primary"))
        .find("workflow_step", (b) => b.whereIndex("primary"))
        .executeRetrieve();
      expect(instance).toMatchObject({
        status: "active",
        params: { source: "original" },
        runGeneration: 2,
        output: null,
        errorName: null,
        errorMessage: null,
      });
      expect(steps).toEqual([]);
    },
  );

  test("restartInstance should reject missing instances", async () => {
    await expect(
      runService(() => fragment.services.restartInstance("demo-workflow", "missing")),
    ).rejects.toThrow("INSTANCE_NOT_FOUND");
  });

  test("retryFailedStep should reopen the only errored top-level do step", async () => {
    const instanceRef = await (async () => {
      const uow = db.createUnitOfWork("create-retry-instance").forSchema(workflowsSchema);
      uow.create("workflow_instance", {
        id: buildScopedInstanceRowId("demo-workflow", "retry-1"),
        instanceId: "retry-1",
        workflowName: "demo-workflow",
        status: "errored",
        params: {},
        startedAt: new Date("2026-01-01T00:00:00.000Z"),
        completedAt: new Date("2026-01-01T00:00:01.000Z"),
        output: null,
        errorName: "Error",
        errorMessage: "boom",
      });
      const { success } = await uow.executeMutations();
      if (!success) {
        throw new Error("Failed to create retry instance");
      }
      const id = uow.getCreatedIds()[0];
      if (!id) {
        throw new Error("Missing retry instance id");
      }
      return id;
    })();

    await (async () => {
      const uow = db.createUnitOfWork("create-retry-step").forSchema(workflowsSchema);
      uow.create("workflow_step", {
        instanceRef,
        stepKey: "do:flaky",
        committedByExecutionId: "fixture-execution",
        name: "flaky",
        type: "do",
        status: "errored",
        attempts: 1,
        maxAttempts: 1,
        timeoutMs: null,
        nextRetryAt: null,
        wakeAt: null,
        waitEventType: null,
        result: null,
        errorName: "Error",
        errorMessage: "boom",
      });
      const { success } = await uow.executeMutations();
      if (!success) {
        throw new Error("Failed to create retry step");
      }
    })();

    const result = await runService<{
      accepted: true;
      instance: { id: string; details: { status: string } };
      retry: { stepKey: string; attempts: number; maxAttempts: number; scheduledAt: Date };
    }>(() =>
      fragment.services.retryFailedStep("demo-workflow", "retry-1", {
        delayMs: 1_000,
      }),
    );

    expect(result).toMatchObject({
      accepted: true,
      instance: { id: "retry-1", details: { status: "waiting" } },
      retry: { stepKey: "do:flaky", attempts: 1, maxAttempts: 2 },
    });
    expect(result.retry.scheduledAt).toBeInstanceOf(Date);

    const [instance] = (
      await db
        .createUnitOfWork("read-retry-instance")
        .forSchema(workflowsSchema)
        .find("workflow_instance", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];
    expect(instance).toMatchObject({
      status: "waiting",
      runGeneration: 1,
      output: null,
      errorName: null,
      errorMessage: null,
      completedAt: null,
    });

    const [step] = (
      await db
        .createUnitOfWork("read-retry-step")
        .forSchema(workflowsSchema)
        .find("workflow_step", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];
    expect(step).toMatchObject({
      stepKey: "do:flaky",
      status: "waiting",
      attempts: 1,
      maxAttempts: 2,
      waitEventType: null,
      wakeAt: null,
    });
    expect(step.nextRetryAt).toBeInstanceOf(Date);
  });

  test("retryFailedStep should restart a failed waitForEvent with fresh state", async () => {
    const instanceRef = await (async () => {
      const uow = db.createUnitOfWork("create-wait-retry-instance").forSchema(workflowsSchema);
      uow.create("workflow_instance", {
        id: buildScopedInstanceRowId("demo-workflow", "retry-wait"),
        instanceId: "retry-wait",
        workflowName: "demo-workflow",
        status: "errored",
        params: {},
        startedAt: null,
        completedAt: new Date("2026-01-01T00:00:01.000Z"),
        output: null,
        errorName: "WaitForEventTimeoutError",
        errorMessage: "WAIT_FOR_EVENT_TIMEOUT",
      });
      const { success } = await uow.executeMutations();
      if (!success) {
        throw new Error("Failed to create wait retry instance");
      }
      const id = uow.getCreatedIds()[0];
      if (!id) {
        throw new Error("Missing wait retry instance id");
      }
      return id;
    })();

    await (async () => {
      const uow = db.createUnitOfWork("create-wait-retry-step").forSchema(workflowsSchema);
      uow.create("workflow_step", {
        instanceRef,
        stepKey: "waitForEvent:approval",
        committedByExecutionId: "fixture-execution",
        name: "approval",
        type: "waitForEvent",
        status: "errored",
        attempts: 0,
        maxAttempts: 1,
        timeoutMs: null,
        nextRetryAt: null,
        wakeAt: null,
        waitEventType: "approval",
        result: null,
        errorName: "WaitForEventTimeoutError",
        errorMessage: "WAIT_FOR_EVENT_TIMEOUT",
      });
      uow.create("workflow_step_emission", {
        instanceRef,
        stepKey: "waitForEvent:approval",
        executionId: "fixture-execution",
        epoch: "fixture-epoch",
        sequence: 1,
        actor: "user",
        payload: { state: "waiting" },
      });
      const { success } = await uow.executeMutations();
      if (!success) {
        throw new Error("Failed to create wait retry step");
      }
    })();

    const result = await runService<{
      accepted: true;
      instance: { id: string; details: { status: string } };
      retry: { stepKey: string; attempts: number; maxAttempts: number; scheduledAt: Date };
    }>(() => fragment.services.retryFailedStep("demo-workflow", "retry-wait"));

    expect(result).toMatchObject({
      accepted: true,
      instance: { id: "retry-wait", details: { status: "waiting" } },
      retry: { stepKey: "waitForEvent:approval", attempts: 0, maxAttempts: 1 },
    });

    const [steps, emissions] = await db
      .createUnitOfWork("read-restarted-wait-step")
      .forSchema(workflowsSchema)
      .find("workflow_step", (b) => b.whereIndex("primary"))
      .find("workflow_step_emission", (b) => b.whereIndex("primary"))
      .executeRetrieve();
    expect(steps).toEqual([]);
    expect(emissions).toEqual([]);
  });

  test("retryFailedStep should reject an instance that is not errored", async () => {
    const created = await runService<{ id: string }>(() =>
      fragment.services.createInstance("demo-workflow", { id: "retry-active" }),
    );

    await expect(
      runService(() => fragment.services.retryFailedStep("demo-workflow", created.id)),
    ).rejects.toThrow("INSTANCE_NOT_ERRORED");
  });

  test("retryFailedStep should discard nested state and emissions and release events", async () => {
    await createErroredRetryFixture("retry-nested", [
      {
        stepKey: "do:earlier",
        parentStepKey: null,
        status: "completed",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      {
        stepKey: "do:parent",
        parentStepKey: null,
        createdAt: new Date("2026-01-01T00:00:01.000Z"),
      },
      {
        stepKey: "do:parent>do:completed-child",
        parentStepKey: "do:parent",
        status: "completed",
      },
      { stepKey: "do:parent>do:failed-child", parentStepKey: "do:parent" },
    ]);

    const [instance] = (
      await db
        .createUnitOfWork("read-nested-retry-instance")
        .forSchema(workflowsSchema)
        .find("workflow_instance", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];
    const retryStateUow = db
      .createUnitOfWork("create-nested-retry-state")
      .forSchema(workflowsSchema);
    retryStateUow.create("workflow_event", {
      instanceRef: instance.id,
      actor: "user",
      type: "approval",
      payload: { approved: true },
      deliveredAt: new Date("2026-01-01T00:00:00.500Z"),
      consumedByStepKey: "do:parent>do:completed-child",
    });
    const emissionStepKeys = [
      "do:earlier",
      "do:parent",
      "do:parent>do:completed-child",
      "do:parent>do:failed-child",
    ];
    for (const [sequence, stepKey] of emissionStepKeys.entries()) {
      retryStateUow.create("workflow_step_emission", {
        instanceRef: instance.id,
        stepKey,
        executionId: "fixture-execution",
        epoch: `fixture-epoch-${sequence}`,
        sequence,
        actor: "user",
        payload: { stepKey },
      });
    }
    assert((await retryStateUow.executeMutations()).success);

    await runService(() => fragment.services.retryFailedStep("demo-workflow", "retry-nested"));

    const [steps, events, emissions] = await Promise.all([
      db
        .createUnitOfWork("read-nested-retry-steps")
        .forSchema(workflowsSchema)
        .find("workflow_step", (b) => b.whereIndex("primary"))
        .executeRetrieve()
        .then(([rows]) => rows),
      db
        .createUnitOfWork("read-nested-retry-events")
        .forSchema(workflowsSchema)
        .find("workflow_event", (b) => b.whereIndex("primary"))
        .executeRetrieve()
        .then(([rows]) => rows),
      db
        .createUnitOfWork("read-nested-retry-emissions")
        .forSchema(workflowsSchema)
        .find("workflow_step_emission", (b) => b.whereIndex("primary"))
        .executeRetrieve()
        .then(([rows]) => rows),
    ]);

    expect(steps).toHaveLength(2);
    expect(steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stepKey: "do:earlier",
          status: "completed",
        }),
        expect.objectContaining({
          stepKey: "do:parent",
          status: "waiting",
          attempts: 1,
          maxAttempts: 2,
        }),
      ]),
    );
    expect(events).toEqual([
      expect.objectContaining({
        consumedByStepKey: null,
        deliveredAt: null,
      }),
    ]);
    expect(emissions).toEqual([
      expect.objectContaining({
        stepKey: "do:earlier",
        payload: { stepKey: "do:earlier" },
      }),
    ]);
  });

  test.each([
    {
      name: "multiple failed top-level steps",
      instanceId: "retry-multiple",
      steps: [
        { stepKey: "do:first", parentStepKey: null },
        { stepKey: "do:second", parentStepKey: null },
      ],
    },
    {
      name: "a failed step before a later completed top-level step",
      instanceId: "retry-not-latest",
      steps: [
        {
          stepKey: "do:failed",
          parentStepKey: null,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        },
        {
          stepKey: "do:later",
          parentStepKey: null,
          status: "completed" as const,
          createdAt: new Date("2026-01-01T00:00:01.000Z"),
        },
      ],
    },
  ])("retryFailedStep should reject $name", async ({ instanceId, steps }) => {
    await createErroredRetryFixture(instanceId, steps);

    await expect(
      runService(() => fragment.services.retryFailedStep("demo-workflow", instanceId)),
    ).rejects.toThrow("FAILED_STEP_NOT_RETRYABLE");
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
        committedByExecutionId: "fixture-execution",
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

    assert(status.status === "waiting");

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

  test("sendEvent accepts the expected remote workflow and enqueues delivery", async () => {
    const created = await runService<{ id: string }>(() =>
      fragment.services.createInstance("remote-demo-workflow", {
        id: "expected-remote-event-1",
        remoteWorkflowName: "saved-demo",
      }),
    );
    await drainDurableHooks(fragment);

    const status = await runService<{ status: string }>(() =>
      fragment.services.sendEvent("remote-demo-workflow", created.id, {
        id: "expected-remote-event-id-1",
        type: "approval",
        payload: { approved: true },
        expectedRemoteWorkflowName: "saved-demo",
      }),
    );

    assert(status.status === "active");
    const [events] = await db
      .createUnitOfWork("read-expected-remote-event")
      .forSchema(workflowsSchema)
      .find("workflow_event", (b) => b.whereIndex("primary"))
      .executeRetrieve();
    expect(events).toEqual([
      expect.objectContaining({
        id: expect.objectContaining({ externalId: "expected-remote-event-id-1" }),
        type: "approval",
        payload: { approved: true },
      }),
    ]);

    const { hookService, namespace } = getDurableHooksService(fragment);
    const hooks = await fragment.inContext(async function () {
      return await this.handlerTx()
        .withServiceCalls(() => [hookService.getHooksByNamespace(namespace)] as const)
        .transform(({ serviceResult: [records] }) => records)
        .execute();
    });
    expect(hooks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hookName: "onWorkflowEnqueued",
          payload: expect.objectContaining({
            workflowName: "remote-demo-workflow",
            instanceId: created.id,
            reason: "event",
          }),
        }),
      ]),
    );
  });

  test("sendEvent rejects a remote workflow mismatch without creating work", async () => {
    const created = await runService<{ id: string }>(() =>
      fragment.services.createInstance("remote-demo-workflow", {
        id: "mismatched-remote-event-1",
        remoteWorkflowName: "saved-demo",
      }),
    );
    await drainDurableHooks(fragment);

    await expect(
      runService(() =>
        fragment.services.sendEvent("remote-demo-workflow", created.id, {
          id: "mismatched-remote-event-id-1",
          type: "approval",
          expectedRemoteWorkflowName: "different-saved-workflow",
        }),
      ),
    ).rejects.toThrow("INSTANCE_REMOTE_WORKFLOW_MISMATCH");

    const [events] = await db
      .createUnitOfWork("read-mismatched-remote-event")
      .forSchema(workflowsSchema)
      .find("workflow_event", (b) => b.whereIndex("primary"))
      .executeRetrieve();
    expect(events).toHaveLength(0);

    const { hookService, namespace } = getDurableHooksService(fragment);
    const hooks = await fragment.inContext(async function () {
      return await this.handlerTx()
        .withServiceCalls(() => [hookService.getHooksByNamespace(namespace)] as const)
        .transform(({ serviceResult: [records] }) => records)
        .execute();
    });
    expect(
      hooks.filter(
        (hook) =>
          hook.hookName === "onWorkflowEnqueued" &&
          (hook.payload as { reason?: string }).reason === "event",
      ),
    ).toHaveLength(0);
  });

  test("sendEvent should be idempotent when an event id is provided", async () => {
    const created = await runService<{ id: string }>(() =>
      fragment.services.createInstance("demo-workflow", { id: "event-idempotent-1" }),
    );
    await drainDurableHooks(fragment);

    const first = await runService<{ status: string }>(() =>
      fragment.services.sendEvent("demo-workflow", created.id, {
        id: "evt-idempotent-1",
        type: "approval",
        payload: { approved: true },
      }),
    );
    const second = await runService<{ status: string }>(() =>
      fragment.services.sendEvent("demo-workflow", created.id, {
        id: "evt-idempotent-1",
        type: "approval",
        payload: { approved: true },
      }),
    );

    assert(first.status === "active");
    assert(second.status === "active");

    const [events] = await db
      .createUnitOfWork("read")
      .forSchema(workflowsSchema)
      .find("workflow_event", (b) => b.whereIndex("primary"))
      .executeRetrieve();
    expect(events).toHaveLength(1);
    assert(events[0]?.id.toString() === "evt-idempotent-1");
  });

  test("sendEvent should reject a reused event id for another instance", async () => {
    const first = await runService<{ id: string }>(() =>
      fragment.services.createInstance("demo-workflow", { id: "event-conflict-1" }),
    );
    const second = await runService<{ id: string }>(() =>
      fragment.services.createInstance("demo-workflow", { id: "event-conflict-2" }),
    );

    await runService<{ status: string }>(() =>
      fragment.services.sendEvent("demo-workflow", first.id, {
        id: "evt-conflict-1",
        type: "approval",
        payload: { approved: true },
      }),
    );

    await expect(
      runService<{ status: string }>(() =>
        fragment.services.sendEvent("demo-workflow", second.id, {
          id: "evt-conflict-1",
          type: "approval",
          payload: { approved: true },
        }),
      ),
    ).rejects.toThrow("EVENT_ID_CONFLICT");
  });

  test("sendEvent idempotent retry should work after the instance becomes terminal", async () => {
    const created = await runService<{ id: string }>(() =>
      fragment.services.createInstance("demo-workflow", { id: "event-terminal-retry-1" }),
    );
    await drainDurableHooks(fragment);

    await runService<{ status: string }>(() =>
      fragment.services.sendEvent("demo-workflow", created.id, {
        id: "evt-terminal-retry-1",
        type: "approval",
        payload: { approved: true },
      }),
    );
    await runService<{ status: string }>(() =>
      fragment.services.terminateInstance("demo-workflow", created.id),
    );

    const retry = await runService<{ status: string }>(() =>
      fragment.services.sendEvent("demo-workflow", created.id, {
        id: "evt-terminal-retry-1",
        type: "approval",
        payload: { approved: true },
      }),
    );

    assert(retry.status === "terminated");
  });

  test("sendEvent should not wake when waitForEvent has timed out", async () => {
    const instanceId = "event-timeout";
    const instanceRef = await (async () => {
      const uow = db.createUnitOfWork("wf").forSchema(workflowsSchema);
      uow.create("workflow_instance", {
        id: buildScopedInstanceRowId("demo-workflow", instanceId),
        instanceId: instanceId,
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
        committedByExecutionId: "fixture-execution",
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
        committedByExecutionId: "fixture-execution",
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
        committedByExecutionId: "fixture-execution",
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
      runGeneration: 1,
      params: { source: "meta-test" },
      completedAt: null,
    });
    expect(meta.createdAt).toBeInstanceOf(Date);
    expect(meta.updatedAt).toBeInstanceOf(Date);
    expect(meta.startedAt).toBeInstanceOf(Date);

    const currentStep = await runService<WorkflowInstanceCurrentStep | undefined>(() =>
      fragment.services.getInstanceCurrentStep("demo-workflow", created.id),
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
        id: buildScopedInstanceRowId("demo-workflow", "history-2"),
        instanceId: "history-2",
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
        committedByExecutionId: "fixture-execution",
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
        committedByExecutionId: "fixture-execution",
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
        executionId: "fixture-execution",
        epoch: "epoch-1",
        sequence: 1,
        actor: "user",
        payload: { frame: "canonical" },
      });
      uow.create("workflow_step_emission", {
        instanceRef,
        stepKey: "do:step-1",
        executionId: "losing-execution",
        epoch: "epoch-losing-step-1",
        sequence: 2,
        actor: "user",
        payload: { frame: "losing-contested" },
      });
      uow.create("workflow_step_emission", {
        instanceRef,
        stepKey: "do:speculative-downstream",
        executionId: "losing-execution",
        epoch: "epoch-losing-downstream",
        sequence: 3,
        actor: "user",
        payload: { frame: "losing-downstream" },
      });
      uow.create("workflow_step_emission", {
        instanceRef,
        stepKey: "sleep:step-2",
        executionId: "unresolved-execution",
        epoch: "epoch-unresolved",
        sequence: 4,
        actor: "user",
        payload: { frame: "unresolved" },
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
    expect(history.emissions).toHaveLength(2);
    expect(history.emissions.map((emission) => emission.stepKey)).toEqual([
      "do:step-1",
      "sleep:step-2",
    ]);
    expect(history.steps[0]?.stepKey).toBeTruthy();
    expect(history.events[0]?.type).toBeTruthy();
    expect(history.emissions[0]).toMatchObject({ stepKey: "do:step-1", actor: "user" });
  });
});
