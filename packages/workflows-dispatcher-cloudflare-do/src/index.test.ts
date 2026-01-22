import { beforeEach, describe, expect, test, vi } from "vitest";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";
import { defaultFragnoRuntime, instantiate } from "@fragno-dev/core";
import {
  workflowsFragmentDefinition,
  workflowsRoutesFactory,
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "@fragno-dev/fragment-workflows";
import {
  createWorkflowsDispatcherDurableObject,
  type WorkflowsDispatcherDurableObjectState,
} from "./index";

describe("workflows durable object dispatcher", async () => {
  class CompleteWorkflow extends WorkflowEntrypoint<unknown, { value: number }> {
    async run(event: WorkflowEvent<{ value: number }>, _step: WorkflowStep) {
      return { value: event.payload.value + 1 };
    }
  }

  class SleepWorkflow extends WorkflowEntrypoint {
    async run(_event: WorkflowEvent<unknown>, step: WorkflowStep) {
      await step.sleep("wait", "50 ms");
    }
  }

  const workflows = {
    complete: { name: "complete-workflow", workflow: CompleteWorkflow },
    sleep: { name: "sleep-workflow", workflow: SleepWorkflow },
  } as const;

  const runner = { tick: vi.fn() };

  const { fragments, test: testContext } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withFragment(
      "workflows",
      instantiate(workflowsFragmentDefinition)
        .withConfig({ workflows, enableRunnerTick: true, runner, runtime: defaultFragnoRuntime })
        .withRoutes([workflowsRoutesFactory]),
    )
    .build();

  const { db } = fragments.workflows;

  beforeEach(async () => {
    await testContext.resetDatabase();
    runner.tick.mockReset();
  });

  const createHandler = (alarmCalls: number[]) => {
    class Cursor {
      next() {
        return { done: true as const };
      }
      toArray() {
        return [];
      }
      one() {
        return {};
      }
      raw() {
        return [][Symbol.iterator]();
      }
      columnNames: string[] = [];
      get rowsRead() {
        return 0;
      }
      get rowsWritten() {
        return 0;
      }
      [Symbol.iterator]() {
        return [][Symbol.iterator]();
      }
    }

    const state = {
      id: {
        toString: () => "do-test",
        equals: (other: { toString(): string }) => other.toString() === "do-test",
      },
      storage: {
        sql: {
          exec: () => new Cursor(),
          Cursor,
          Statement: class {},
        },
        transaction: async <T>(closure: (txn: { rollback(): void }) => Promise<T>) =>
          await closure({ rollback: () => {} }),
        setAlarm: async (timestamp: number | Date) => {
          const value = typeof timestamp === "number" ? timestamp : timestamp.getTime();
          alarmCalls.push(value);
        },
        deleteAlarm: async () => {
          alarmCalls.push(-1);
        },
      },
      blockConcurrencyWhile: (_callback: () => Promise<void>) => {},
    } as unknown as WorkflowsDispatcherDurableObjectState;

    return createWorkflowsDispatcherDurableObject({
      workflows,
      createAdapter: () => testContext.adapter,
      migrateOnStartup: false,
      tickOptions: { maxInstances: 5, maxSteps: 50 },
    })(state, {});
  };

  test("executes runner ticks via fetch", async () => {
    const alarmCalls: number[] = [];
    const handler = createHandler(alarmCalls);
    const workflowName = "complete-workflow";
    const instanceId = "instance-1";

    await db.create("workflow_instance", {
      workflowName,
      instanceId,
      status: "queued",
      params: { value: 3 },
      pauseRequested: false,
      retentionUntil: null,
      runNumber: 0,
    });

    await db.create("workflow_task", {
      workflowName,
      instanceId,
      runNumber: 0,
      kind: "run",
      runAt: new Date(),
      status: "pending",
      maxAttempts: 3,
      lastError: null,
      lockedUntil: null,
      lockOwner: null,
    });

    const tickResponse = await handler.fetch(
      new Request("https://example.com/api/workflows/_runner/tick", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ maxInstances: 5, maxSteps: 50 }),
      }),
    );

    expect(tickResponse.ok).toBe(true);

    const { processed } = (await tickResponse.json()) as { processed: number };
    expect(processed).toBeGreaterThan(0);

    const instance = await db.findFirst("workflow_instance", (b) =>
      b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
        eb.and(eb("workflowName", "=", workflowName), eb("instanceId", "=", instanceId)),
      ),
    );

    expect(instance?.status).toBe("complete");
  });

  test("schedules alarms for future wakeups", async () => {
    const alarmCalls: number[] = [];
    const handler = createHandler(alarmCalls);
    const workflowName = "sleep-workflow";
    const instanceId = "instance-2";

    await db.create("workflow_instance", {
      workflowName,
      instanceId,
      status: "queued",
      params: {},
      pauseRequested: false,
      retentionUntil: null,
      runNumber: 0,
    });

    const runAt = new Date(Date.now() + 50);
    await db.create("workflow_task", {
      workflowName,
      instanceId,
      runNumber: 0,
      kind: "run",
      runAt,
      status: "pending",
      maxAttempts: 3,
      lastError: null,
      lockedUntil: null,
      lockOwner: null,
    });

    const start = Date.now();

    const tickResponse = await handler.fetch(
      new Request("https://example.com/api/workflows/_runner/tick", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ maxInstances: 5, maxSteps: 50 }),
      }),
    );

    expect(tickResponse.ok).toBe(true);
    expect(alarmCalls.length).toBeGreaterThan(0);
    expect(alarmCalls[alarmCalls.length - 1]).toBeGreaterThanOrEqual(start);
  });
});
