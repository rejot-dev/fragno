// Tests for workflow fragment persistence and routes.
import { assert, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { defaultFragnoRuntime, instantiate } from "@fragno-dev/core";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";

import { workflowsFragmentDefinition } from "./definition";
import { workflowsRoutesFactory } from "./routes";
import { workflowsSchema } from "./schema";
import {
  NonRetryableError,
  WaitForEventTimeoutError,
  defineWorkflow,
  type WorkflowEvent,
  type WorkflowStep,
} from "./workflow";

describe("Workflows Fragment", () => {
  const DemoWorkflow = defineWorkflow(
    { name: "demo-workflow" },
    (_event: WorkflowEvent<unknown>, _step: WorkflowStep) => {
      return undefined;
    },
  );

  const workflows = {
    DEMO: DemoWorkflow,
  } as const;
  const setup = async () => {
    const { fragments, test: testContext } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "drizzle-pglite" })
      .withFragment(
        "workflows",
        instantiate(workflowsFragmentDefinition)
          .withConfig({ workflows, autoTickHooks: false, runtime: defaultFragnoRuntime })
          .withRoutes([workflowsRoutesFactory]),
      )
      .build();

    const { fragment, db } = fragments.workflows;
    return { fragments, testContext, fragment, db };
  };

  type Setup = Awaited<ReturnType<typeof setup>>;

  let _fragments: Setup["fragments"];
  let testContext: Setup["testContext"];
  let fragment: Setup["fragment"];
  let db: Setup["db"];

  beforeAll(async () => {
    ({ fragments: _fragments, testContext, fragment, db } = await setup());
  });

  beforeEach(async () => {
    await testContext.resetDatabase();
  });

  test("should expose workflows schema", () => {
    expect(fragment.$internal.deps.schema).toBe(workflowsSchema);
    expect(fragment.$internal.deps.namespace).toBe("workflows");
  });

  test("should generate migrations for workflows schema", () => {
    const { adapter } = testContext;
    if (!adapter.prepareMigrations) {
      throw new Error("Test adapter does not support migrations");
    }

    const migrations = adapter.prepareMigrations(workflowsSchema, "workflows");
    const sql = migrations.getSQL(0, workflowsSchema.version);

    expect(sql.length).toBeGreaterThan(0);
  });

  test("should persist workflow records", async () => {
    const workflowName = "demo-workflow";
    const instanceId = "instance-1";

    const instanceRef = await (async () => {
      const uow = db.createUnitOfWork("wf").forSchema(workflowsSchema);
      uow.create("workflow_instance", {
        id: instanceId,
        workflowName,
        status: "pending",
        params: { source: "tests" },
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
        name: "Start",
        type: "do",
        status: "completed",
        attempts: 1,
        maxAttempts: 3,
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

    const [instance] = (
      await db
        .createUnitOfWork("read")
        .forSchema(workflowsSchema)
        .find("workflow_instance", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];
    const [step] = (
      await db
        .createUnitOfWork("read")
        .forSchema(workflowsSchema)
        .find("workflow_step", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];
    const [event] = (
      await db
        .createUnitOfWork("read")
        .forSchema(workflowsSchema)
        .find("workflow_event", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];

    expect(instance).toMatchObject({
      workflowName,
      status: "pending",
      params: { source: "tests" },
    });
    expect(instance.id.toString()).toBe(instanceId);
    expect(instance.createdAt).toBeInstanceOf(Date);
    expect(instance.updatedAt).toBeInstanceOf(Date);

    expect(step).toMatchObject({
      stepKey: "do:step-1",
      name: "Start",
      type: "do",
      status: "completed",
      attempts: 1,
      maxAttempts: 3,
      timeoutMs: null,
      nextRetryAt: null,
      wakeAt: null,
      waitEventType: null,
      result: { ok: true },
      errorName: null,
      errorMessage: null,
    });
    expect(step.createdAt).toBeInstanceOf(Date);
    expect(step.updatedAt).toBeInstanceOf(Date);

    expect(event).toMatchObject({
      type: "approval",
      payload: { approved: true },
      deliveredAt: null,
      consumedByStepKey: null,
    });
    expect(event.createdAt).toBeInstanceOf(Date);
  });

  test("should expose NonRetryableError defaults", () => {
    const error = new NonRetryableError("no retry");

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("no retry");
    expect(error.name).toBe("NonRetryableError");
  });

  test("WaitForEventTimeoutError extends NonRetryableError", () => {
    const error = new WaitForEventTimeoutError();

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(NonRetryableError);
    expect(error).toBeInstanceOf(WaitForEventTimeoutError);
    expect(error.message).toBe("WAIT_FOR_EVENT_TIMEOUT");
    expect(error.name).toBe("WaitForEventTimeoutError");
  });

  describe("Routes", () => {
    test("GET / should list registered workflows", async () => {
      const response = await fragment.callRoute("GET", "/");
      assert(response.type === "json");

      expect(response.data).toMatchObject({
        workflows: [{ name: "demo-workflow" }],
      });
    });

    test("GET /:workflowName/instances should return 404 for unknown workflows", async () => {
      const response = await fragment.callRoute("GET", "/:workflowName/instances", {
        pathParams: { workflowName: "missing-workflow" },
      });

      expect(response.type).toBe("error");
      if (response.type === "error") {
        expect(response.error.code).toBe("WORKFLOW_NOT_FOUND");
        expect(response.status).toBe(404);
      }
    });

    test("GET /:workflowName/instances should filter by status", async () => {
      const uow = db.createUnitOfWork("wf").forSchema(workflowsSchema);
      uow.create("workflow_instance", {
        id: "active-route",
        workflowName: "demo-workflow",
        status: "active",
        params: {},
        startedAt: null,
        completedAt: null,
        output: null,
        errorName: null,
        errorMessage: null,
      });
      uow.create("workflow_instance", {
        id: "complete-route",
        workflowName: "demo-workflow",
        status: "complete",
        params: {},
        startedAt: null,
        completedAt: null,
        output: { ok: true },
        errorName: null,
        errorMessage: null,
      });
      const { success } = await uow.executeMutations();
      expect(success).toBe(true);

      const response = await fragment.callRoute("GET", "/:workflowName/instances", {
        pathParams: { workflowName: "demo-workflow" },
        query: { status: "complete" },
      });

      assert(response.type === "json");
      expect(response.data.instances).toHaveLength(1);
      expect(response.data.instances[0]).toMatchObject({
        id: "complete-route",
        details: { status: "complete", output: { ok: true } },
      });
    });

    test("GET /:workflowName/instances should reject invalid cursors", async () => {
      const response = await fragment.callRoute("GET", "/:workflowName/instances", {
        pathParams: { workflowName: "demo-workflow" },
        query: { cursor: "not-valid-base64!!!" },
      });

      expect(response.type).toBe("error");
      if (response.type === "error") {
        expect(response.error.code).toBe("INVALID_CURSOR");
        expect(response.status).toBe(400);
      }
    });

    test("POST /:workflowName/instances should create a workflow instance", async () => {
      const response = await fragment.callRoute("POST", "/:workflowName/instances", {
        pathParams: { workflowName: "demo-workflow" },
        body: { id: "route-1", params: { source: "route-test" } },
      });
      assert(response.type === "json");

      expect(response.data).toMatchObject({
        id: "route-1",
        details: { status: "active" },
      });

      const [instance] = (
        await db
          .createUnitOfWork("read")
          .forSchema(workflowsSchema)
          .find("workflow_instance", (b) => b.whereIndex("primary"))
          .executeRetrieve()
      )[0];
      expect(instance).toMatchObject({
        workflowName: "demo-workflow",
      });
      expect(instance?.id.toString()).toBe("route-1");
    });

    test("POST /:workflowName/instances should be idempotent for duplicate instance id", async () => {
      const first = await fragment.callRoute("POST", "/:workflowName/instances", {
        pathParams: { workflowName: "demo-workflow" },
        body: { id: "route-duplicate", params: { source: "first" } },
      });
      assert(first.type === "json");

      const second = await fragment.callRoute("POST", "/:workflowName/instances", {
        pathParams: { workflowName: "demo-workflow" },
        body: { id: "route-duplicate", params: { source: "second" } },
      });

      expect(second.type).toBe("json");
      if (second.type === "json") {
        expect(second.data).toEqual(first.data);
      }

      const instances = (
        await db
          .createUnitOfWork("read-route-idempotent-create")
          .forSchema(workflowsSchema)
          .find("workflow_instance", (b) => b.whereIndex("primary"))
          .executeRetrieve()
      )[0];
      expect(instances).toHaveLength(1);
      expect(instances[0]?.params).toEqual({ source: "first" });
    });

    test("POST /:workflowName/instances should return existing terminal status for duplicate instance id", async () => {
      const first = await fragment.callRoute("POST", "/:workflowName/instances", {
        pathParams: { workflowName: "demo-workflow" },
        body: { id: "route-duplicate-terminal" },
      });
      assert(first.type === "json");

      const [instance] = (
        await db
          .createUnitOfWork("read-route-duplicate-terminal")
          .forSchema(workflowsSchema)
          .find("workflow_instance", (b) => b.whereIndex("primary"))
          .executeRetrieve()
      )[0];

      const completedAt = new Date("2026-01-01T00:00:00.000Z");
      const uow = db
        .createUnitOfWork("complete-route-duplicate-terminal")
        .forSchema(workflowsSchema);
      uow.update("workflow_instance", instance.id, (b) =>
        b.set({
          status: "complete",
          output: { ok: true },
          updatedAt: completedAt,
          completedAt,
        }),
      );
      expect((await uow.executeMutations()).success).toBe(true);

      const second = await fragment.callRoute("POST", "/:workflowName/instances", {
        pathParams: { workflowName: "demo-workflow" },
        body: { id: "route-duplicate-terminal", params: { ignored: true } },
      });

      expect(second.type).toBe("json");
      if (second.type === "json") {
        expect(second.data).toEqual({
          id: "route-duplicate-terminal",
          details: { status: "complete", output: { ok: true } },
        });
      }
    });

    test("GET /:workflowName/instances/:instanceId/history should return history", async () => {
      const instanceRef = await (async () => {
        const uow = db.createUnitOfWork("wf").forSchema(workflowsSchema);
        uow.create("workflow_instance", {
          id: "history-route",
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
          name: "Example",
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

      const response = await fragment.callRoute(
        "GET",
        "/:workflowName/instances/:instanceId/history",
        {
          pathParams: { workflowName: "demo-workflow", instanceId: "history-route" },
        },
      );

      assert(response.type === "json");
      expect(response.data.steps).toHaveLength(1);
      expect(response.data.events).toHaveLength(1);
      expect(response.data.emissions).toHaveLength(1);
      expect(response.data.emissions[0]).toMatchObject({
        stepKey: "do:step-1",
        epoch: "epoch-1",
        sequence: 1,
        actor: "user",
        payload: { frame: "partial" },
      });
    });

    test("GET /:workflowName/instances/:instanceId/history should return full instance history", async () => {
      const instanceRef = await (async () => {
        const uow = db.createUnitOfWork("wf").forSchema(workflowsSchema);
        uow.create("workflow_instance", {
          id: "history-latest",
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
          stepKey: "do:step-old",
          name: "Old",
          type: "do",
          status: "completed",
          attempts: 1,
          maxAttempts: 1,
          timeoutMs: null,
          nextRetryAt: null,
          wakeAt: null,
          waitEventType: null,
          result: { ok: false },
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
          stepKey: "do:step-new",
          name: "New",
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
        uow.create("workflow_event", {
          instanceRef,
          actor: "user",
          type: "latest",
          payload: { latest: true },
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

      const response = await fragment.callRoute(
        "GET",
        "/:workflowName/instances/:instanceId/history",
        {
          pathParams: { workflowName: "demo-workflow", instanceId: "history-latest" },
        },
      );

      assert(response.type === "json");
      expect(response.data.steps).toHaveLength(2);
      expect(response.data.steps.map((step) => step.stepKey)).toEqual([
        "do:step-old",
        "do:step-new",
      ]);
      expect(response.data.events).toHaveLength(1);
      expect(response.data.events[0].type).toBe("latest");
    });

    test("GET /:workflowName/instances/:instanceId/history should return 404 for missing instance", async () => {
      const response = await fragment.callRoute(
        "GET",
        "/:workflowName/instances/:instanceId/history",
        {
          pathParams: { workflowName: "demo-workflow", instanceId: "missing-history" },
        },
      );

      expect(response.type).toBe("error");
      if (response.type === "error") {
        expect(response.error.code).toBe("INSTANCE_NOT_FOUND");
        expect(response.status).toBe(404);
      }
    });
  });
});
