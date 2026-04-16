import { describe, expect, expectTypeOf, test } from "vitest";

import { buildDatabaseFragmentsTest } from "@fragno-dev/test";

import { restoreWorkflowState } from "./runner/restore-state";
import { workflowsSchema } from "./schema";
import { createWorkflowsTestHarness } from "./test";
import {
  defineWorkflow,
  type WorkflowEnqueuedHookPayload,
  type WorkflowStateFromEntry,
} from "./workflow";

describe("restoreWorkflowState", () => {
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

  test("infers the initialState shape for setState and restored state", () => {
    const TypedWorkflow = defineWorkflow(
      {
        name: "typed-state-workflow",
        initialState: { phase: "idle", seeded: false, attemptCount: 0 },
      },
      async function (_event, step) {
        this?.setState({ phase: "running", attemptCount: 1 });
        await step.do("seed", () => "ok");
        return { ok: true };
      },
    );

    type TypedWorkflowState = WorkflowStateFromEntry<typeof TypedWorkflow>;
    type CurrentState = ReturnType<
      NonNullable<ThisParameterType<typeof TypedWorkflow.run>>["getState"]
    >;
    type StatePatch = Parameters<
      NonNullable<ThisParameterType<typeof TypedWorkflow.run>>["setState"]
    >[0];

    expectTypeOf<TypedWorkflowState>().toMatchObjectType<{
      phase: string;
      seeded: boolean;
      attemptCount: number;
    }>();
    expectTypeOf<CurrentState>().toEqualTypeOf<TypedWorkflowState>();
    expectTypeOf<StatePatch>().toMatchObjectType<{
      phase?: string;
      seeded?: boolean;
      attemptCount?: number;
    }>();
  });

  test("restores state derived from cached completed do-step results without re-running the callback", async () => {
    let doRuns = 0;
    const StatefulWorkflow = defineWorkflow(
      {
        name: "stateful-replay-workflow",
        initialState: { phase: "idle", seeded: false, approved: false },
      },
      async function (_event, step) {
        this?.setState({ phase: "starting" });

        const seed = await step.do("seed", () => {
          doRuns += 1;
          return { seed: doRuns };
        });

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

    const instanceId = await harness.createInstance("STATEFUL");
    const [createdInstance] = (
      await harness.db
        .createUnitOfWork("read")
        .forSchema(workflowsSchema)
        .find("workflow_instance", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];
    expect(createdInstance).toBeTruthy();

    await harness.tick(buildPayload(createdInstance!, "create"));

    const [waitingInstance] = (
      await harness.db
        .createUnitOfWork("read")
        .forSchema(workflowsSchema)
        .find("workflow_instance", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];
    const stepRows = (
      await harness.db
        .createUnitOfWork("read")
        .forSchema(workflowsSchema)
        .find("workflow_step", (b) =>
          b
            .whereIndex("idx_workflow_step_instanceRef_runNumber_createdAt", (eb) =>
              eb.and(
                eb("instanceRef", "=", waitingInstance!.id),
                eb("runNumber", "=", waitingInstance!.runNumber),
              ),
            )
            .orderByIndex("idx_workflow_step_instanceRef_runNumber_createdAt", "asc"),
        )
        .executeRetrieve()
    )[0];

    const restored = await restoreWorkflowState({
      workflow: StatefulWorkflow,
      instance: waitingInstance!,
      steps: stepRows,
    });

    expect(restored).toEqual({ phase: "waiting", seeded: true, approved: false });
    expect(doRuns).toBe(1);
    expect(await harness.getStatus("STATEFUL", instanceId)).toMatchObject({ status: "waiting" });
  });

  test("does not restore state emitted only inside a completed do callback", async () => {
    let doRuns = 0;
    const StatefulWorkflow = defineWorkflow(
      {
        name: "in-memory-only-state-workflow",
        initialState: { seeded: false },
      },
      async function (_event, step) {
        await step.do("seed", () => {
          doRuns += 1;
          this?.setState({ seeded: true });
          return { seed: doRuns };
        });

        await step.waitForEvent("ready", { type: "ready" });
        return { ok: true };
      },
    );

    const harness = await createWorkflowsTestHarness({
      workflows: { STATEFUL: StatefulWorkflow },
      adapter: { type: "in-memory" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
    });

    await harness.createInstance("STATEFUL");
    const [createdInstance] = (
      await harness.db
        .createUnitOfWork("read")
        .forSchema(workflowsSchema)
        .find("workflow_instance", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];
    expect(createdInstance).toBeTruthy();

    await harness.tick(buildPayload(createdInstance!, "create"));

    const [waitingInstance] = (
      await harness.db
        .createUnitOfWork("read")
        .forSchema(workflowsSchema)
        .find("workflow_instance", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];
    const stepRows = (
      await harness.db
        .createUnitOfWork("read")
        .forSchema(workflowsSchema)
        .find("workflow_step", (b) =>
          b
            .whereIndex("idx_workflow_step_instanceRef_runNumber_createdAt", (eb) =>
              eb.and(
                eb("instanceRef", "=", waitingInstance!.id),
                eb("runNumber", "=", waitingInstance!.runNumber),
              ),
            )
            .orderByIndex("idx_workflow_step_instanceRef_runNumber_createdAt", "asc"),
        )
        .executeRetrieve()
    )[0];

    const restored = await restoreWorkflowState({
      workflow: StatefulWorkflow,
      instance: waitingInstance!,
      steps: stepRows,
    });

    expect(restored).toEqual({ seeded: false });
    expect(doRuns).toBe(1);
  });

  test("does not consume pending events while restoring state", async () => {
    const EventWorkflow = defineWorkflow(
      {
        name: "stateful-inspect-workflow",
        initialState: { phase: "idle", received: false },
      },
      async function (_event, step) {
        this?.setState({ phase: "waiting" });
        await step.waitForEvent<{ ok: boolean }>("ready", { type: "ready" });
        this?.setState({ phase: "complete", received: true });
        return { ok: true };
      },
    );

    const harness = await createWorkflowsTestHarness({
      workflows: { EVENTFUL: EventWorkflow },
      adapter: { type: "in-memory" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
    });

    await harness.createInstance("EVENTFUL", { id: "eventful-1" });
    const [createdInstance] = (
      await harness.db
        .createUnitOfWork("read")
        .forSchema(workflowsSchema)
        .find("workflow_instance", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];
    expect(createdInstance).toBeTruthy();

    await harness.tick(buildPayload(createdInstance!, "create"));
    await harness.sendEvent("EVENTFUL", "eventful-1", {
      type: "ready",
      payload: { ok: true },
    });

    const [waitingInstance] = (
      await harness.db
        .createUnitOfWork("read")
        .forSchema(workflowsSchema)
        .find("workflow_instance", (b) => b.whereIndex("primary"))
        .executeRetrieve()
    )[0];
    const stepRows = (
      await harness.db
        .createUnitOfWork("read")
        .forSchema(workflowsSchema)
        .find("workflow_step", (b) =>
          b
            .whereIndex("idx_workflow_step_instanceRef_runNumber_createdAt", (eb) =>
              eb.and(
                eb("instanceRef", "=", waitingInstance!.id),
                eb("runNumber", "=", waitingInstance!.runNumber),
              ),
            )
            .orderByIndex("idx_workflow_step_instanceRef_runNumber_createdAt", "asc"),
        )
        .executeRetrieve()
    )[0];
    const [pendingEventBefore] = (
      await harness.db
        .createUnitOfWork("read")
        .forSchema(workflowsSchema)
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

    const restored = await restoreWorkflowState({
      workflow: EventWorkflow,
      instance: waitingInstance!,
      steps: stepRows,
    });

    const [pendingEventAfter] = (
      await harness.db
        .createUnitOfWork("read")
        .forSchema(workflowsSchema)
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

    expect(restored).toEqual({ phase: "waiting", received: false });
    expect(pendingEventBefore?.consumedByStepKey).toBeNull();
    expect(pendingEventAfter?.consumedByStepKey).toBeNull();
    expect(await harness.getStatus("EVENTFUL", "eventful-1")).toMatchObject({ status: "waiting" });
  });
});
