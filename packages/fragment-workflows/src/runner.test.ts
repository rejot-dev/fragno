import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";
import { defaultFragnoRuntime, instantiate } from "@fragno-dev/core";
import { workflowsFragmentDefinition } from "./definition";
import { createWorkflowsRunner } from "./runner";
import type { WorkflowEvent, WorkflowStep } from "./workflow";
import { WorkflowEntrypoint } from "./workflow";
import { workflowsRoutesFactory } from "./routes";

describe("Workflows Runner", () => {
  let doCallCount = 0;
  let concurrentCallCount = 0;
  let retryCallCount = 0;
  let priorityOrder: string[] = [];
  let replayCallCount = 0;
  let distinctCallCount = 0;
  let pauseBoundaryCount = 0;
  let pauseResumeCount = 0;
  let retryLogCount = 0;
  let pauseBoundaryStarted: Promise<void>;
  let pauseBoundaryStartedResolve: (() => void) | null = null;
  let pauseBoundaryContinue: (() => void) | null = null;
  let terminateBoundaryCount = 0;
  let terminateBoundaryStarted: Promise<void>;
  let terminateBoundaryStartedResolve: (() => void) | null = null;
  let terminateBoundaryContinue: (() => void) | null = null;
  let restartBoundaryCount = 0;
  let restartBoundaryStarted: Promise<void>;
  let restartBoundaryStartedResolve: (() => void) | null = null;
  let restartBoundaryContinue: (() => void) | null = null;

  class DemoWorkflow extends WorkflowEntrypoint<unknown, { count: number }> {
    async run(event: WorkflowEvent<{ count: number }>, step: WorkflowStep) {
      const first = await step.do("calc", () => {
        doCallCount += 1;
        return { count: event.payload.count + 1 };
      });
      const second = await step.do("calc", () => {
        doCallCount += 1;
        return { count: 999 };
      });
      return { first, second };
    }
  }

  class EventWorkflow extends WorkflowEntrypoint {
    async run(_event: WorkflowEvent<unknown>, step: WorkflowStep) {
      return await step.waitForEvent("wait-ready", { type: "ready", timeout: "1 hour" });
    }
  }

  class TimeoutWorkflow extends WorkflowEntrypoint {
    async run(_event: WorkflowEvent<unknown>, step: WorkflowStep) {
      return await step.waitForEvent("wait-timeout", { type: "timeout", timeout: "1 s" });
    }
  }

  class TimeoutCleanupWorkflow extends WorkflowEntrypoint {
    async run(_event: WorkflowEvent<unknown>, step: WorkflowStep) {
      return await step.do("cleanup-timeout", { timeout: "1 s" }, () => ({ ok: true }));
    }
  }

  class SlowWorkflow extends WorkflowEntrypoint {
    async run(_event: WorkflowEvent<unknown>, step: WorkflowStep) {
      return await step.do("slow-step", async () => {
        await new Promise((resolve) => setTimeout(resolve, 250));
        return { ok: true };
      });
    }
  }

  class RetryWorkflow extends WorkflowEntrypoint {
    async run(_event: WorkflowEvent<unknown>, step: WorkflowStep) {
      return await step.do(
        "retry-step",
        { retries: { limit: 1, delay: "40 ms", backoff: "constant" } },
        () => {
          retryCallCount += 1;
          if (retryCallCount === 1) {
            throw new Error("RETRY_ME");
          }
          return { ok: true };
        },
      );
    }
  }

  class RetryLogWorkflow extends WorkflowEntrypoint {
    async run(_event: WorkflowEvent<unknown>, step: WorkflowStep) {
      return await step.do(
        "retry-log-step",
        { retries: { limit: 1, delay: "25 ms", backoff: "constant" } },
        async () => {
          await step.log.info("attempt");
          retryLogCount += 1;
          if (retryLogCount === 1) {
            throw new Error("RETRY_LOG");
          }
          return { ok: true };
        },
      );
    }
  }

  class ConcurrentWorkflow extends WorkflowEntrypoint {
    async run(_event: WorkflowEvent<unknown>, step: WorkflowStep) {
      return await step.do("single-run", async () => {
        concurrentCallCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { ok: true };
      });
    }
  }

  class PauseSleepWorkflow extends WorkflowEntrypoint {
    async run(_event: WorkflowEvent<unknown>, step: WorkflowStep) {
      await step.sleep("pause-sleep", "50 ms");
      return { ok: true };
    }
  }

  class PauseBoundaryWorkflow extends WorkflowEntrypoint {
    async run(_event: WorkflowEvent<unknown>, step: WorkflowStep) {
      await step.do("pause-boundary", () => {
        pauseBoundaryCount += 1;
        return new Promise<{ ok: boolean }>((resolve) => {
          pauseBoundaryContinue = () => resolve({ ok: true });
          if (pauseBoundaryStartedResolve) {
            pauseBoundaryStartedResolve();
          }
        });
      });

      const resumed = await step.do("after-pause", () => {
        pauseResumeCount += 1;
        return { ok: true };
      });

      return resumed;
    }
  }

  class TerminateBoundaryWorkflow extends WorkflowEntrypoint {
    async run(_event: WorkflowEvent<unknown>, step: WorkflowStep) {
      await step.do("terminate-boundary", () => {
        terminateBoundaryCount += 1;
        return new Promise<{ ok: boolean }>((resolve) => {
          terminateBoundaryContinue = () => resolve({ ok: true });
          if (terminateBoundaryStartedResolve) {
            terminateBoundaryStartedResolve();
          }
        });
      });

      return { ok: true };
    }
  }

  class RestartBoundaryWorkflow extends WorkflowEntrypoint {
    async run(_event: WorkflowEvent<unknown>, step: WorkflowStep) {
      return await step.do("restart-boundary", () => {
        restartBoundaryCount += 1;
        if (restartBoundaryCount > 1) {
          return { ok: true };
        }
        return new Promise<{ ok: boolean }>((resolve) => {
          restartBoundaryContinue = () => resolve({ ok: true });
          if (restartBoundaryStartedResolve) {
            restartBoundaryStartedResolve();
          }
        });
      });
    }
  }

  class PriorityWorkflow extends WorkflowEntrypoint {
    async run(event: WorkflowEvent<unknown>, step: WorkflowStep) {
      return await step.do("record-order", () => {
        priorityOrder.push(event.instanceId);
        return { ok: true };
      });
    }
  }

  class ReplayWorkflow extends WorkflowEntrypoint {
    async run(_event: WorkflowEvent<unknown>, step: WorkflowStep) {
      const first = await step.do("replay-first", () => {
        replayCallCount += 1;
        return { ok: true };
      });
      const waited = await step.waitForEvent("replay-wait", { type: "go", timeout: "1 hour" });
      return { first, waited };
    }
  }

  class LoggingWorkflow extends WorkflowEntrypoint<unknown, { note: string }> {
    async run(event: WorkflowEvent<{ note: string }>, step: WorkflowStep) {
      await step.log.info("starting", { note: event.payload.note }, { category: "workflow" });
      return await step.do("logged-step", async () => {
        await step.log.warn("inside", { note: event.payload.note });
        return { ok: true };
      });
    }
  }

  class ReplayLogWorkflow extends WorkflowEntrypoint {
    async run(_event: WorkflowEvent<unknown>, step: WorkflowStep) {
      await step.log.info("start");
      await step.waitForEvent("replay-log-wait", { type: "go", timeout: "1 hour" });
      await step.log.info("after");
      return { ok: true };
    }
  }

  class DistinctStepWorkflow extends WorkflowEntrypoint {
    async run(_event: WorkflowEvent<unknown>, step: WorkflowStep) {
      const first = await step.do("step-one", () => {
        distinctCallCount += 1;
        return { id: 1 };
      });
      const second = await step.do("step-two", () => {
        distinctCallCount += 1;
        return { id: 2 };
      });
      return { first, second };
    }
  }

  class ChildWorkflow extends WorkflowEntrypoint<unknown, { parentId: string }> {
    async run(event: WorkflowEvent<{ parentId: string }>, step: WorkflowStep) {
      return await step.do("child-run", () => ({
        parentId: event.payload.parentId,
      }));
    }
  }

  class ParentWorkflow extends WorkflowEntrypoint<unknown, { label: string }> {
    async run(event: WorkflowEvent<{ label: string }>, step: WorkflowStep) {
      return await step.do("spawn-child", async () => {
        const child = await this.workflows["child"].create({
          id: `child-${event.instanceId}`,
          params: { parentId: event.instanceId },
        });

        return { childId: child.id, label: event.payload.label };
      });
    }
  }

  const workflows = {
    demo: { name: "demo-workflow", workflow: DemoWorkflow },
    events: { name: "event-workflow", workflow: EventWorkflow },
    timeout: { name: "timeout-workflow", workflow: TimeoutWorkflow },
    timeoutCleanup: { name: "timeout-cleanup-workflow", workflow: TimeoutCleanupWorkflow },
    slow: { name: "slow-workflow", workflow: SlowWorkflow },
    retry: { name: "retry-workflow", workflow: RetryWorkflow },
    retryLogs: { name: "retry-logs-workflow", workflow: RetryLogWorkflow },
    concurrent: { name: "concurrent-workflow", workflow: ConcurrentWorkflow },
    pauseSleep: { name: "pause-sleep-workflow", workflow: PauseSleepWorkflow },
    pauseBoundary: { name: "pause-boundary-workflow", workflow: PauseBoundaryWorkflow },
    terminateBoundary: { name: "terminate-boundary-workflow", workflow: TerminateBoundaryWorkflow },
    restartBoundary: { name: "restart-boundary-workflow", workflow: RestartBoundaryWorkflow },
    priority: { name: "priority-workflow", workflow: PriorityWorkflow },
    replay: { name: "replay-workflow", workflow: ReplayWorkflow },
    logging: { name: "logging-workflow", workflow: LoggingWorkflow },
    replayLogs: { name: "replay-logs-workflow", workflow: ReplayLogWorkflow },
    distinct: { name: "distinct-step-workflow", workflow: DistinctStepWorkflow },
    child: { name: "child-workflow", workflow: ChildWorkflow },
    parent: { name: "parent-workflow", workflow: ParentWorkflow },
  };

  const setup = async () => {
    const runtime = defaultFragnoRuntime;
    const { fragments, test: testContext } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "drizzle-pglite" })
      .withFragment(
        "workflows",
        instantiate(workflowsFragmentDefinition)
          .withConfig({
            workflows,
            runtime,
          })
          .withRoutes([workflowsRoutesFactory]),
      )
      .build();

    const { fragment, db } = fragments.workflows;
    const runner = createWorkflowsRunner({ fragment, workflows, runtime });
    return { fragments, testContext, fragment, db, runner, runtime };
  };

  type Setup = Awaited<ReturnType<typeof setup>>;

  let _fragments: Setup["fragments"];
  let testContext: Setup["testContext"];
  let fragment: Setup["fragment"];
  let db: Setup["db"];
  let runner: Setup["runner"];
  let runtime: Setup["runtime"];

  beforeAll(async () => {
    ({ fragments: _fragments, testContext, fragment, db, runner, runtime } = await setup());
  });

  const createInstance = async (workflowName: string, params: unknown) => {
    const response = await fragment.callRoute("POST", "/:workflowName/instances", {
      pathParams: { workflowName },
      body: { params },
    });
    if (response.type !== "json") {
      throw new Error("Expected json response");
    }
    return response.data.id as string;
  };

  beforeEach(async () => {
    await testContext.resetDatabase();
    doCallCount = 0;
    concurrentCallCount = 0;
    retryCallCount = 0;
    priorityOrder = [];
    replayCallCount = 0;
    distinctCallCount = 0;
    pauseBoundaryCount = 0;
    pauseResumeCount = 0;
    retryLogCount = 0;
    pauseBoundaryContinue = null;
    pauseBoundaryStartedResolve = null;
    pauseBoundaryStarted = new Promise((resolve) => {
      pauseBoundaryStartedResolve = resolve;
    });
    terminateBoundaryCount = 0;
    terminateBoundaryContinue = null;
    terminateBoundaryStartedResolve = null;
    terminateBoundaryStarted = new Promise((resolve) => {
      terminateBoundaryStartedResolve = resolve;
    });
    restartBoundaryCount = 0;
    restartBoundaryContinue = null;
    restartBoundaryStartedResolve = null;
    restartBoundaryStarted = new Promise((resolve) => {
      restartBoundaryStartedResolve = resolve;
    });
  });

  test("tick should execute workflow and reuse cached steps", async () => {
    const id = await createInstance("demo-workflow", { count: 1 });

    const processed = await runner.tick({ maxInstances: 1, maxSteps: 10 });
    expect(processed).toBe(1);

    const instance = await db.findFirst("workflow_instance", (b) =>
      b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
        eb.and(eb("workflowName", "=", "demo-workflow"), eb("instanceId", "=", id)),
      ),
    );

    expect(instance?.status).toBe("complete");
    expect(instance?.output).toEqual({
      first: { count: 2 },
      second: { count: 2 },
    });
    expect(doCallCount).toBe(1);

    const steps = await db.find("workflow_step", (b) => b.whereIndex("primary"));
    expect(steps).toHaveLength(1);
    expect(steps[0].status).toBe("completed");
  });

  test("tick should cache steps by name", async () => {
    const id = await createInstance("distinct-step-workflow", {});

    const processed = await runner.tick({ maxInstances: 1, maxSteps: 10 });
    expect(processed).toBe(1);
    expect(distinctCallCount).toBe(2);

    const instance = await db.findFirst("workflow_instance", (b) =>
      b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
        eb.and(eb("workflowName", "=", "distinct-step-workflow"), eb("instanceId", "=", id)),
      ),
    );

    expect(instance?.status).toBe("complete");
    expect(instance?.output).toEqual({
      first: { id: 1 },
      second: { id: 2 },
    });

    const steps = await db.find("workflow_step", (b) => b.whereIndex("primary"));
    expect(steps).toHaveLength(2);
  });

  test("tick should expose workflow bindings for child workflows", async () => {
    const parentId = await createInstance("parent-workflow", { label: "primary" });

    const processed = await runner.tick({ maxInstances: 1, maxSteps: 10 });
    expect(processed).toBe(1);

    const parentInstance = await db.findFirst("workflow_instance", (b) =>
      b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
        eb.and(eb("workflowName", "=", "parent-workflow"), eb("instanceId", "=", parentId)),
      ),
    );

    expect(parentInstance?.status).toBe("complete");
    expect(parentInstance?.output).toEqual({
      childId: `child-${parentId}`,
      label: "primary",
    });

    const childInstance = await db.findFirst("workflow_instance", (b) =>
      b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
        eb.and(
          eb("workflowName", "=", "child-workflow"),
          eb("instanceId", "=", `child-${parentId}`),
        ),
      ),
    );

    expect(childInstance?.status).toBe("queued");

    const childTask = await db.findFirst("workflow_task", (b) =>
      b.whereIndex("idx_workflow_task_workflowName_instanceId_runNumber", (eb) =>
        eb.and(
          eb("workflowName", "=", "child-workflow"),
          eb("instanceId", "=", `child-${parentId}`),
          eb("runNumber", "=", 0),
        ),
      ),
    );

    expect(childTask?.status).toBe("pending");
  });

  test("tick should replay cached steps across ticks", async () => {
    const id = await createInstance("replay-workflow", {});

    const firstTick = await runner.tick({ maxInstances: 1, maxSteps: 10 });
    expect(firstTick).toBe(1);
    expect(replayCallCount).toBe(1);

    const waiting = await db.findFirst("workflow_instance", (b) =>
      b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
        eb.and(eb("workflowName", "=", "replay-workflow"), eb("instanceId", "=", id)),
      ),
    );
    expect(waiting?.status).toBe("waiting");

    await fragment.callRoute("POST", "/:workflowName/instances/:instanceId/events", {
      pathParams: { workflowName: "replay-workflow", instanceId: id },
      body: { type: "go", payload: { ok: true } },
    });

    const secondTick = await runner.tick({ maxInstances: 1, maxSteps: 10 });
    expect(secondTick).toBe(1);
    expect(replayCallCount).toBe(1);

    const completed = await db.findFirst("workflow_instance", (b) =>
      b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
        eb.and(eb("workflowName", "=", "replay-workflow"), eb("instanceId", "=", id)),
      ),
    );
    expect(completed?.status).toBe("complete");
    expect(completed?.output).toMatchObject({
      first: { ok: true },
      waited: { type: "go", payload: { ok: true } },
    });
  });

  test("tick should consume buffered events for waitForEvent", async () => {
    const id = await createInstance("event-workflow", {});

    await db.create("workflow_event", {
      workflowName: "event-workflow",
      instanceId: id,
      runNumber: 0,
      type: "ready",
      payload: { ok: true },
      deliveredAt: null,
      consumedByStepKey: null,
    });

    const processed = await runner.tick({ maxInstances: 1, maxSteps: 5 });
    expect(processed).toBe(1);

    const instance = await db.findFirst("workflow_instance", (b) =>
      b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
        eb.and(eb("workflowName", "=", "event-workflow"), eb("instanceId", "=", id)),
      ),
    );

    expect(instance?.status).toBe("complete");
    expect(instance?.output).toEqual({
      type: "ready",
      payload: { ok: true },
      timestamp: expect.any(String),
    });

    const [event] = await db.find("workflow_event", (b) => b.whereIndex("primary"));
    expect(event.deliveredAt).toBeInstanceOf(Date);
    expect(event.consumedByStepKey).toBe("wait-ready");
  });

  test("tick should error when waitForEvent times out", async () => {
    vi.useFakeTimers();
    try {
      const id = await createInstance("timeout-workflow", {});

      const processed = await runner.tick({ maxInstances: 1, maxSteps: 5 });
      expect(processed).toBe(1);

      const waiting = await db.findFirst("workflow_instance", (b) =>
        b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
          eb.and(eb("workflowName", "=", "timeout-workflow"), eb("instanceId", "=", id)),
        ),
      );

      expect(waiting?.status).toBe("waiting");

      await vi.advanceTimersByTimeAsync(1100);

      const processedTimeout = await runner.tick({ maxInstances: 1, maxSteps: 5 });
      expect(processedTimeout).toBe(1);

      const errored = await db.findFirst("workflow_instance", (b) =>
        b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
          eb.and(eb("workflowName", "=", "timeout-workflow"), eb("instanceId", "=", id)),
        ),
      );

      expect(errored?.status).toBe("errored");
      expect(errored?.errorName).toBe("WaitForEventTimeoutError");

      const [step] = await db.find("workflow_step", (b) => b.whereIndex("primary"));
      expect(step).toMatchObject({ stepKey: "wait-timeout", status: "errored" });
    } finally {
      vi.useRealTimers();
    }
  });

  test("do should clear timeout timers after success", async () => {
    vi.useFakeTimers();
    try {
      const before = vi.getTimerCount();
      const id = await createInstance("timeout-cleanup-workflow", {});

      const processed = await runner.tick({ maxInstances: 1, maxSteps: 5 });
      expect(processed).toBe(1);

      const instance = await db.findFirst("workflow_instance", (b) =>
        b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
          eb.and(eb("workflowName", "=", "timeout-cleanup-workflow"), eb("instanceId", "=", id)),
        ),
      );
      expect(instance?.status).toBe("complete");
      expect(vi.getTimerCount()).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  test("tick should schedule retries before completing a step", async () => {
    vi.useFakeTimers();
    try {
      const id = await createInstance("retry-workflow", {});

      const firstTick = await runner.tick({ maxInstances: 1, maxSteps: 5 });
      expect(firstTick).toBe(1);
      expect(retryCallCount).toBe(1);

      const waiting = await db.findFirst("workflow_instance", (b) =>
        b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
          eb.and(eb("workflowName", "=", "retry-workflow"), eb("instanceId", "=", id)),
        ),
      );

      expect(waiting?.status).toBe("waiting");

      const [waitingStep] = await db.find("workflow_step", (b) => b.whereIndex("primary"));
      expect(waitingStep).toMatchObject({ stepKey: "retry-step", status: "waiting" });
      expect(waitingStep?.nextRetryAt).toBeInstanceOf(Date);

      await vi.advanceTimersByTimeAsync(60);

      const secondTick = await runner.tick({ maxInstances: 1, maxSteps: 5 });
      expect(secondTick).toBe(1);
      expect(retryCallCount).toBe(2);

      const completed = await db.findFirst("workflow_instance", (b) =>
        b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
          eb.and(eb("workflowName", "=", "retry-workflow"), eb("instanceId", "=", id)),
        ),
      );

      expect(completed?.status).toBe("complete");
      expect(completed?.output).toEqual({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });

  test("tick should persist step logs with context", async () => {
    const id = await createInstance("logging-workflow", { note: "alpha" });

    const processed = await runner.tick({ maxInstances: 1, maxSteps: 10 });
    expect(processed).toBe(1);

    const logs = await db.find("workflow_log", (b) =>
      b.whereIndex("idx_workflow_log_history_createdAt", (eb) =>
        eb.and(
          eb("workflowName", "=", "logging-workflow"),
          eb("instanceId", "=", id),
          eb("runNumber", "=", 0),
        ),
      ),
    );

    expect(logs).toHaveLength(2);

    const startLog = logs.find((entry) => entry.message === "starting");
    const insideLog = logs.find((entry) => entry.message === "inside");

    expect(startLog).toMatchObject({
      stepKey: null,
      attempt: null,
      level: "info",
      category: "workflow",
    });
    expect(insideLog).toMatchObject({
      stepKey: "logged-step",
      attempt: 1,
      level: "warn",
      category: "workflow",
    });
  });

  test("tick should persist retry logs and mark replay entries", async () => {
    vi.useFakeTimers();
    try {
      const id = await createInstance("retry-logs-workflow", {});

      const firstTick = await runner.tick({ maxInstances: 1, maxSteps: 5 });
      expect(firstTick).toBe(1);

      const waiting = await db.findFirst("workflow_instance", (b) =>
        b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
          eb.and(eb("workflowName", "=", "retry-logs-workflow"), eb("instanceId", "=", id)),
        ),
      );
      expect(waiting?.status).toBe("waiting");

      await vi.advanceTimersByTimeAsync(40);

      const secondTick = await runner.tick({ maxInstances: 1, maxSteps: 5 });
      expect(secondTick).toBe(1);

      const logs = await db.find("workflow_log", (b) =>
        b.whereIndex("idx_workflow_log_history_createdAt", (eb) =>
          eb.and(
            eb("workflowName", "=", "retry-logs-workflow"),
            eb("instanceId", "=", id),
            eb("runNumber", "=", 0),
          ),
        ),
      );

      const attemptNumbers = logs
        .map((entry) => entry.attempt)
        .filter((value): value is number => value !== null)
        .sort((a, b) => a - b);
      expect(attemptNumbers).toEqual([1, 2]);
      expect(logs).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("tick should mark replay logs after waiting for events", async () => {
    const id = await createInstance("replay-logs-workflow", {});

    const firstTick = await runner.tick({ maxInstances: 1, maxSteps: 10 });
    expect(firstTick).toBe(1);

    await fragment.callRoute("POST", "/:workflowName/instances/:instanceId/events", {
      pathParams: { workflowName: "replay-logs-workflow", instanceId: id },
      body: { type: "go", payload: { ok: true } },
    });

    const secondTick = await runner.tick({ maxInstances: 1, maxSteps: 10 });
    expect(secondTick).toBe(1);

    const logs = await db.find("workflow_log", (b) =>
      b.whereIndex("idx_workflow_log_history_createdAt", (eb) =>
        eb.and(
          eb("workflowName", "=", "replay-logs-workflow"),
          eb("instanceId", "=", id),
          eb("runNumber", "=", 0),
        ),
      ),
    );

    const startLogs = logs.filter((entry) => entry.message === "start");
    expect(startLogs).toHaveLength(2);
  });

  test("tick should renew task lease while executing", async () => {
    const leaseMs = 100;
    const leaseRunner = createWorkflowsRunner({
      fragment,
      workflows,
      runtime,
      leaseMs,
      runnerId: "lease-runner",
    });

    const id = await createInstance("slow-workflow", {});

    const tickPromise = leaseRunner.tick({ maxInstances: 1, maxSteps: 5 });

    const fetchTask = () =>
      db.findFirst("workflow_task", (b) =>
        b.whereIndex("idx_workflow_task_workflowName_instanceId_runNumber", (eb) =>
          eb.and(
            eb("workflowName", "=", "slow-workflow"),
            eb("instanceId", "=", id),
            eb("runNumber", "=", 0),
          ),
        ),
      );

    let initialTask: Awaited<ReturnType<typeof fetchTask>> = null;
    const startWait = Date.now();
    while (!initialTask && Date.now() - startWait < 500) {
      const candidate = await fetchTask();
      if (candidate?.lockOwner === "lease-runner") {
        initialTask = candidate;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(initialTask).not.toBeNull();
    expect(initialTask?.lockOwner).toBe("lease-runner");
    expect(initialTask?.lockedUntil).toBeInstanceOf(Date);

    await new Promise((resolve) => setTimeout(resolve, leaseMs + 60));

    const renewedTask = await fetchTask();
    expect(renewedTask).not.toBeNull();
    expect(renewedTask?.lockOwner).toBe("lease-runner");
    expect(renewedTask?.lockedUntil?.getTime()).toBeGreaterThan(
      initialTask?.lockedUntil?.getTime() ?? 0,
    );

    await tickPromise;
  });

  test("concurrent ticks should only process a task once", async () => {
    const id = await createInstance("concurrent-workflow", {});

    const runnerA = createWorkflowsRunner({
      fragment,
      workflows,
      runtime,
      runnerId: "runner-a",
    });
    const runnerB = createWorkflowsRunner({
      fragment,
      workflows,
      runtime,
      runnerId: "runner-b",
    });

    const [processedA, processedB] = await Promise.all([
      runnerA.tick({ maxInstances: 1, maxSteps: 5 }),
      runnerB.tick({ maxInstances: 1, maxSteps: 5 }),
    ]);

    expect(processedA + processedB).toBe(1);
    expect(concurrentCallCount).toBe(1);

    const instance = await db.findFirst("workflow_instance", (b) =>
      b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
        eb.and(eb("workflowName", "=", "concurrent-workflow"), eb("instanceId", "=", id)),
      ),
    );

    expect(instance?.status).toBe("complete");
  });

  test("expired processing lease should allow takeover", async () => {
    const id = await createInstance("concurrent-workflow", {});

    const task = await db.findFirst("workflow_task", (b) =>
      b.whereIndex("idx_workflow_task_workflowName_instanceId_runNumber", (eb) =>
        eb.and(
          eb("workflowName", "=", "concurrent-workflow"),
          eb("instanceId", "=", id),
          eb("runNumber", "=", 0),
        ),
      ),
    );

    if (!task) {
      throw new Error("Expected workflow task");
    }

    await db.update("workflow_task", task.id, (b) =>
      b.set({
        status: "processing",
        lockOwner: "stale-runner",
        lockedUntil: new Date(Date.now() - 1000),
        updatedAt: new Date(),
      }),
    );

    const runner = createWorkflowsRunner({
      fragment,
      workflows,
      runtime,
      runnerId: "fresh-runner",
    });

    const processed = await runner.tick({ maxInstances: 1, maxSteps: 5 });
    expect(processed).toBe(1);
    expect(concurrentCallCount).toBe(1);

    const instance = await db.findFirst("workflow_instance", (b) =>
      b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
        eb.and(eb("workflowName", "=", "concurrent-workflow"), eb("instanceId", "=", id)),
      ),
    );

    expect(instance?.status).toBe("complete");
  });

  test("tick should prioritize wake/retry/resume before run tasks", async () => {
    const now = new Date();
    const createInstanceRecord = (instanceId: string) =>
      db.create("workflow_instance", {
        workflowName: "priority-workflow",
        instanceId,
        status: "queued",
        params: {},
        pauseRequested: false,
        retentionUntil: null,
        runNumber: 0,
        startedAt: null,
        completedAt: null,
        output: null,
        errorName: null,
        errorMessage: null,
      });

    await Promise.all([
      createInstanceRecord("run-1"),
      createInstanceRecord("wake-1"),
      createInstanceRecord("retry-1"),
      createInstanceRecord("resume-1"),
    ]);

    const createTask = (instanceId: string, kind: "run" | "wake" | "retry" | "resume") =>
      db.create("workflow_task", {
        workflowName: "priority-workflow",
        instanceId,
        runNumber: 0,
        kind,
        runAt: now,
        status: "pending",
        attempts: 0,
        maxAttempts: 1,
        lastError: null,
        lockedUntil: null,
        lockOwner: null,
      });

    await Promise.all([
      createTask("run-1", "run"),
      createTask("wake-1", "wake"),
      createTask("retry-1", "retry"),
      createTask("resume-1", "resume"),
    ]);

    for (let i = 0; i < 4; i += 1) {
      const processed = await runner.tick({ maxInstances: 1, maxSteps: 5 });
      expect(processed).toBe(1);
    }

    expect(priorityOrder).toEqual(["wake-1", "retry-1", "resume-1", "run-1"]);
  });

  test("tick should clean up tasks for terminated instances", async () => {
    const now = new Date();
    await db.create("workflow_instance", {
      workflowName: "demo-workflow",
      instanceId: "terminated-1",
      status: "terminated",
      params: {},
      pauseRequested: false,
      retentionUntil: null,
      runNumber: 0,
      startedAt: null,
      completedAt: now,
      output: null,
      errorName: null,
      errorMessage: null,
    });

    await db.create("workflow_task", {
      workflowName: "demo-workflow",
      instanceId: "terminated-1",
      runNumber: 0,
      kind: "run",
      runAt: now,
      status: "pending",
      attempts: 0,
      maxAttempts: 1,
      lastError: null,
      lockedUntil: null,
      lockOwner: null,
    });

    const processed = await runner.tick({ maxInstances: 1, maxSteps: 5 });
    expect(processed).toBe(0);

    const tasks = await db.find("workflow_task", (b) => b.whereIndex("primary"));
    expect(tasks).toHaveLength(0);
  });

  test("pause requested during run should stop at step boundary", async () => {
    const id = await createInstance("pause-boundary-workflow", {});

    const tickPromise = runner.tick({ maxInstances: 1, maxSteps: 10 });

    await pauseBoundaryStarted;
    await fragment.callRoute("POST", "/:workflowName/instances/:instanceId/pause", {
      pathParams: { workflowName: "pause-boundary-workflow", instanceId: id },
    });

    if (!pauseBoundaryContinue) {
      throw new Error("pause boundary continuation missing");
    }
    pauseBoundaryContinue();

    const processed = await tickPromise;
    expect(processed).toBe(1);
    expect(pauseBoundaryCount).toBe(1);
    expect(pauseResumeCount).toBe(0);

    const paused = await db.findFirst("workflow_instance", (b) =>
      b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
        eb.and(eb("workflowName", "=", "pause-boundary-workflow"), eb("instanceId", "=", id)),
      ),
    );

    expect(paused?.status).toBe("paused");

    const tasks = await db.find("workflow_task", (b) => b.whereIndex("primary"));
    expect(tasks).toHaveLength(0);

    await fragment.callRoute("POST", "/:workflowName/instances/:instanceId/resume", {
      pathParams: { workflowName: "pause-boundary-workflow", instanceId: id },
    });

    const resumedProcessed = await runner.tick({ maxInstances: 1, maxSteps: 10 });
    expect(resumedProcessed).toBe(1);
    expect(pauseResumeCount).toBe(1);

    const completed = await db.findFirst("workflow_instance", (b) =>
      b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
        eb.and(eb("workflowName", "=", "pause-boundary-workflow"), eb("instanceId", "=", id)),
      ),
    );

    expect(completed?.status).toBe("complete");
  });

  test("terminate requested during run should stop without overwriting status", async () => {
    const id = await createInstance("terminate-boundary-workflow", {});

    const tickPromise = runner.tick({ maxInstances: 1, maxSteps: 10 });

    await terminateBoundaryStarted;
    await fragment.callRoute("POST", "/:workflowName/instances/:instanceId/terminate", {
      pathParams: { workflowName: "terminate-boundary-workflow", instanceId: id },
    });

    if (!terminateBoundaryContinue) {
      throw new Error("terminate boundary continuation missing");
    }
    terminateBoundaryContinue();

    const processed = await tickPromise;
    expect(processed).toBe(0);
    expect(terminateBoundaryCount).toBe(1);

    const terminated = await db.findFirst("workflow_instance", (b) =>
      b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
        eb.and(eb("workflowName", "=", "terminate-boundary-workflow"), eb("instanceId", "=", id)),
      ),
    );

    expect(terminated?.status).toBe("terminated");

    const tasks = await db.find("workflow_task", (b) => b.whereIndex("primary"));
    expect(tasks).toHaveLength(0);
  });

  test("restart during run should prevent stale run updates", async () => {
    const id = await createInstance("restart-boundary-workflow", {});

    const tickPromise = runner.tick({ maxInstances: 1, maxSteps: 10 });

    await restartBoundaryStarted;
    await fragment.callRoute("POST", "/:workflowName/instances/:instanceId/restart", {
      pathParams: { workflowName: "restart-boundary-workflow", instanceId: id },
    });

    if (!restartBoundaryContinue) {
      throw new Error("restart boundary continuation missing");
    }
    restartBoundaryContinue();

    const processed = await tickPromise;
    expect(processed).toBe(0);
    expect(restartBoundaryCount).toBe(1);

    const queued = await db.findFirst("workflow_instance", (b) =>
      b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
        eb.and(eb("workflowName", "=", "restart-boundary-workflow"), eb("instanceId", "=", id)),
      ),
    );

    expect(queued?.status).toBe("queued");
    expect(queued?.runNumber).toBe(1);

    const processedRestart = await runner.tick({ maxInstances: 1, maxSteps: 10 });
    expect(processedRestart).toBe(1);
    expect(restartBoundaryCount).toBe(2);

    const completed = await db.findFirst("workflow_instance", (b) =>
      b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
        eb.and(eb("workflowName", "=", "restart-boundary-workflow"), eb("instanceId", "=", id)),
      ),
    );

    expect(completed?.status).toBe("complete");
    expect(completed?.runNumber).toBe(1);
  });

  test("pause should not freeze sleep timers", async () => {
    const id = await createInstance("pause-sleep-workflow", {});

    const processed = await runner.tick({ maxInstances: 1, maxSteps: 5 });
    expect(processed).toBe(1);

    const waiting = await db.findFirst("workflow_instance", (b) =>
      b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
        eb.and(eb("workflowName", "=", "pause-sleep-workflow"), eb("instanceId", "=", id)),
      ),
    );

    expect(waiting?.status).toBe("waiting");

    await fragment.callRoute("POST", "/:workflowName/instances/:instanceId/pause", {
      pathParams: { workflowName: "pause-sleep-workflow", instanceId: id },
    });

    await new Promise((resolve) => setTimeout(resolve, 80));

    await fragment.callRoute("POST", "/:workflowName/instances/:instanceId/resume", {
      pathParams: { workflowName: "pause-sleep-workflow", instanceId: id },
    });

    const resumedProcessed = await runner.tick({ maxInstances: 1, maxSteps: 5 });
    expect(resumedProcessed).toBe(1);

    const completed = await db.findFirst("workflow_instance", (b) =>
      b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
        eb.and(eb("workflowName", "=", "pause-sleep-workflow"), eb("instanceId", "=", id)),
      ),
    );

    expect(completed?.status).toBe("complete");
    expect(completed?.output).toEqual({ ok: true });

    const [step] = await db.find("workflow_step", (b) => b.whereIndex("primary"));
    expect(step).toMatchObject({ stepKey: "pause-sleep", status: "completed" });
  });

  test("sleep should reschedule the task as pending", async () => {
    const id = await createInstance("pause-sleep-workflow", {});

    const processed = await runner.tick({ maxInstances: 1, maxSteps: 5 });
    expect(processed).toBe(1);

    const task = await db.findFirst("workflow_task", (b) =>
      b.whereIndex("idx_workflow_task_workflowName_instanceId_runNumber", (eb) =>
        eb.and(
          eb("workflowName", "=", "pause-sleep-workflow"),
          eb("instanceId", "=", id),
          eb("runNumber", "=", 0),
        ),
      ),
    );

    expect(task?.kind).toBe("wake");
    expect(task?.status).toBe("pending");
    expect(task?.lockOwner).toBeNull();
    expect(task?.lockedUntil).toBeNull();
  });
});
