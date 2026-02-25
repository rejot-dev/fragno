// Tests for workflow fragment persistence and routes.
import { assert, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";
import { defaultFragnoRuntime, instantiate } from "@fragno-dev/core";
import { workflowsFragmentDefinition } from "./definition";
import { workflowsRoutesFactory } from "./routes";
import { workflowsSchema } from "./schema";
import {
  NonRetryableError,
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

    const instanceRef = await db.create("workflow_instance", {
      id: instanceId,
      workflowName,
      status: "pending",
      params: { source: "tests" },
      runNumber: 0,
    });

    await db.create("workflow_step", {
      instanceRef,
      runNumber: 0,
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

    await db.create("workflow_event", {
      instanceRef,
      runNumber: 0,
      actor: "user",
      type: "approval",
      payload: { approved: true },
      deliveredAt: null,
      consumedByStepKey: null,
    });

    const [instance] = await db.find("workflow_instance", (b) => b.whereIndex("primary"));
    const [step] = await db.find("workflow_step", (b) => b.whereIndex("primary"));
    const [event] = await db.find("workflow_event", (b) => b.whereIndex("primary"));

    expect(instance).toMatchObject({
      workflowName,
      status: "pending",
      params: { source: "tests" },
      runNumber: 0,
    });
    expect(instance.id.toString()).toBe(instanceId);
    expect(instance.createdAt).toBeInstanceOf(Date);
    expect(instance.updatedAt).toBeInstanceOf(Date);

    expect(step).toMatchObject({
      runNumber: 0,
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
      runNumber: 0,
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

      const [instance] = await db.find("workflow_instance", (b) => b.whereIndex("primary"));
      expect(instance).toMatchObject({
        workflowName: "demo-workflow",
      });
      expect(instance?.id.toString()).toBe("route-1");
    });

    test("GET /:workflowName/instances/:instanceId/history should return history", async () => {
      const instanceRef = await db.create("workflow_instance", {
        id: "history-route",
        workflowName: "demo-workflow",
        status: "active",
        params: {},
        runNumber: 2,
        startedAt: null,
        completedAt: null,
        output: null,
        errorName: null,
        errorMessage: null,
      });

      await db.create("workflow_step", {
        instanceRef,
        runNumber: 2,
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

      await db.create("workflow_event", {
        instanceRef,
        runNumber: 2,
        actor: "user",
        type: "approval",
        payload: { approved: true },
        deliveredAt: null,
        consumedByStepKey: null,
      });

      const response = await fragment.callRoute(
        "GET",
        "/:workflowName/instances/:instanceId/history",
        {
          pathParams: { workflowName: "demo-workflow", instanceId: "history-route" },
        },
      );

      assert(response.type === "json");
      expect(response.data.runNumber).toBe(2);
      expect(response.data.steps).toHaveLength(1);
      expect(response.data.events).toHaveLength(1);
    });

    test("GET /:workflowName/instances/:instanceId/history should default to latest run", async () => {
      const instanceRef = await db.create("workflow_instance", {
        id: "history-latest",
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

      await db.create("workflow_step", {
        instanceRef,
        runNumber: 2,
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

      await db.create("workflow_step", {
        instanceRef,
        runNumber: 3,
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

      await db.create("workflow_event", {
        instanceRef,
        runNumber: 3,
        actor: "user",
        type: "latest",
        payload: { latest: true },
        deliveredAt: null,
        consumedByStepKey: null,
      });

      const response = await fragment.callRoute(
        "GET",
        "/:workflowName/instances/:instanceId/history",
        {
          pathParams: { workflowName: "demo-workflow", instanceId: "history-latest" },
        },
      );

      assert(response.type === "json");
      expect(response.data.runNumber).toBe(3);
      expect(response.data.steps).toHaveLength(1);
      expect(response.data.steps[0].stepKey).toBe("do:step-new");
      expect(response.data.events).toHaveLength(1);
      expect(response.data.events[0].type).toBe("latest");
    });

    test("GET /:workflowName/instances/:instanceId/history/:run should return requested run", async () => {
      const instanceRef = await db.create("workflow_instance", {
        id: "history-run",
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

      await db.create("workflow_step", {
        instanceRef,
        runNumber: 2,
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

      await db.create("workflow_step", {
        instanceRef,
        runNumber: 3,
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

      await db.create("workflow_event", {
        instanceRef,
        runNumber: 2,
        actor: "user",
        type: "prior",
        payload: { prior: true },
        deliveredAt: null,
        consumedByStepKey: null,
      });

      const response = await fragment.callRoute(
        "GET",
        "/:workflowName/instances/:instanceId/history/:run",
        {
          pathParams: { workflowName: "demo-workflow", instanceId: "history-run", run: "2" },
        },
      );

      assert(response.type === "json");
      expect(response.data.runNumber).toBe(2);
      expect(response.data.steps).toHaveLength(1);
      expect(response.data.steps[0].stepKey).toBe("do:step-old");
      expect(response.data.events).toHaveLength(1);
      expect(response.data.events[0].type).toBe("prior");
    });

    test("GET /:workflowName/instances/:instanceId/history/:run should reject invalid run", async () => {
      await db.create("workflow_instance", {
        id: "history-invalid-run",
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

      const response = await fragment.callRoute(
        "GET",
        "/:workflowName/instances/:instanceId/history/:run",
        {
          pathParams: {
            workflowName: "demo-workflow",
            instanceId: "history-invalid-run",
            run: "nope",
          },
        },
      );

      expect(response.type).toBe("error");
      if (response.type === "error") {
        expect(response.error.code).toBe("INVALID_RUN_NUMBER");
        expect(response.status).toBe(400);
      }
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
