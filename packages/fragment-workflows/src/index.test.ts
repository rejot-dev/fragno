// Tests for workflow fragment persistence, routes, and bindings.
import { assert, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";
import { defaultFragnoRuntime, instantiate } from "@fragno-dev/core";
import { workflowsFragmentDefinition } from "./definition";
import { workflowsRoutesFactory } from "./routes";
import { workflowsSchema } from "./schema";
import { attachWorkflowsBindings } from "./bindings";
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
  const runner = {
    tick: vi.fn(),
  };

  const setup = async () => {
    const { fragments, test: testContext } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "drizzle-pglite" })
      .withFragment(
        "workflows",
        instantiate(workflowsFragmentDefinition)
          .withConfig({ workflows, runner, runtime: defaultFragnoRuntime })
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
    runner.tick.mockReset();
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
      instanceId,
      workflowName,
      status: "pending",
      params: { source: "tests" },
      pauseRequested: false,
      runNumber: 0,
    });

    await db.create("workflow_step", {
      instanceRef,
      workflowName,
      instanceId,
      runNumber: 0,
      stepKey: "step-1",
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
      workflowName,
      instanceId,
      runNumber: 0,
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
      instanceId,
      status: "pending",
      params: { source: "tests" },
      pauseRequested: false,
      runNumber: 0,
    });
    expect(instance.createdAt).toBeInstanceOf(Date);
    expect(instance.updatedAt).toBeInstanceOf(Date);

    expect(step).toMatchObject({
      workflowName,
      instanceId,
      runNumber: 0,
      stepKey: "step-1",
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
      workflowName,
      instanceId,
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

  test("should expose programmatic workflow bindings", async () => {
    const boundFragment = attachWorkflowsBindings(fragment, workflows);

    const instance = await boundFragment.workflows["DEMO"].create({
      id: "binding-1",
      params: { source: "bindings" },
    });

    const status = await instance.status();
    expect(status.status).toBe("queued");

    const stored = await db.findFirst("workflow_instance", (b) =>
      b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
        eb.and(eb("workflowName", "=", "demo-workflow"), eb("instanceId", "=", "binding-1")),
      ),
    );

    expect(stored?.instanceId).toBe("binding-1");
  });

  describe("Routes", () => {
    test("GET / should list registered workflows", async () => {
      const response = await fragment.callRoute("GET", "/");
      assert(response.type === "json");

      expect(response.data).toMatchObject({
        workflows: [{ name: "demo-workflow" }],
      });
    });

    test("POST /:workflowName/instances should create a workflow instance", async () => {
      const response = await fragment.callRoute("POST", "/:workflowName/instances", {
        pathParams: { workflowName: "demo-workflow" },
        body: { id: "route-1", params: { source: "route-test" } },
      });
      assert(response.type === "json");

      expect(response.data).toMatchObject({
        id: "route-1",
        details: { status: "queued" },
      });

      const [instance] = await db.find("workflow_instance", (b) => b.whereIndex("primary"));
      expect(instance).toMatchObject({
        workflowName: "demo-workflow",
        instanceId: "route-1",
      });
    });

    test("GET /:workflowName/instances/:instanceId/history should return history", async () => {
      const instanceRef = await db.create("workflow_instance", {
        workflowName: "demo-workflow",
        instanceId: "history-route",
        status: "queued",
        params: {},
        pauseRequested: false,
        runNumber: 2,
        startedAt: null,
        completedAt: null,
        output: null,
        errorName: null,
        errorMessage: null,
      });

      await db.create("workflow_step", {
        instanceRef,
        workflowName: "demo-workflow",
        instanceId: "history-route",
        runNumber: 2,
        stepKey: "step-1",
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
        workflowName: "demo-workflow",
        instanceId: "history-route",
        runNumber: 2,
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
        workflowName: "demo-workflow",
        instanceId: "history-latest",
        status: "queued",
        params: {},
        pauseRequested: false,
        runNumber: 3,
        startedAt: null,
        completedAt: null,
        output: null,
        errorName: null,
        errorMessage: null,
      });

      await db.create("workflow_step", {
        instanceRef,
        workflowName: "demo-workflow",
        instanceId: "history-latest",
        runNumber: 2,
        stepKey: "step-old",
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
        workflowName: "demo-workflow",
        instanceId: "history-latest",
        runNumber: 3,
        stepKey: "step-new",
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
        workflowName: "demo-workflow",
        instanceId: "history-latest",
        runNumber: 3,
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
      expect(response.data.steps[0].stepKey).toBe("step-new");
      expect(response.data.events).toHaveLength(1);
      expect(response.data.events[0].type).toBe("latest");
    });

    test("GET /:workflowName/instances/:instanceId/history/:run should return requested run", async () => {
      const instanceRef = await db.create("workflow_instance", {
        workflowName: "demo-workflow",
        instanceId: "history-run",
        status: "queued",
        params: {},
        pauseRequested: false,
        runNumber: 3,
        startedAt: null,
        completedAt: null,
        output: null,
        errorName: null,
        errorMessage: null,
      });

      await db.create("workflow_step", {
        instanceRef,
        workflowName: "demo-workflow",
        instanceId: "history-run",
        runNumber: 2,
        stepKey: "step-old",
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
        workflowName: "demo-workflow",
        instanceId: "history-run",
        runNumber: 3,
        stepKey: "step-new",
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
        workflowName: "demo-workflow",
        instanceId: "history-run",
        runNumber: 2,
        type: "legacy",
        payload: { legacy: true },
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
      expect(response.data.steps[0].stepKey).toBe("step-old");
      expect(response.data.events).toHaveLength(1);
      expect(response.data.events[0].type).toBe("legacy");
    });

    test("GET /:workflowName/instances/:instanceId/history/:run should reject invalid run", async () => {
      await db.create("workflow_instance", {
        workflowName: "demo-workflow",
        instanceId: "history-invalid-run",
        status: "queued",
        params: {},
        pauseRequested: false,
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
