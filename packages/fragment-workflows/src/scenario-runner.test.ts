import { describe, expect, test } from "vitest";
import {
  defineFragment,
  instantiate,
  type AnyFragnoInstantiatedFragment,
  type InstantiatedFragmentFromDefinition,
} from "@fragno-dev/core";
import { withDatabase } from "@fragno-dev/db";
import { column, idColumn, schema } from "@fragno-dev/db/schema";
import { defineWorkflow } from "./workflow";
import {
  createScenarioSteps,
  defineScenario,
  runScenario,
  type WorkflowScenarioEventRow,
  type WorkflowScenarioInstanceRow,
  type WorkflowScenarioStepRow,
} from "./scenario";

type RouteResponse = {
  type: string;
  data?: unknown;
  error?: { message: string; code: string };
};

const assertJsonResponse = <T>(response: RouteResponse) => {
  expect(response.type).toBe("json");
  if (response.type !== "json") {
    const errorDetails =
      response.type === "error"
        ? ` (${response.error?.code ?? "UNKNOWN"}: ${response.error?.message ?? "Unknown error"})`
        : "";
    throw new Error(`Expected json response, received ${response.type}${errorDetails}`);
  }
  return response.data as T;
};

const assertOkResponse = (response: RouteResponse) => {
  const data = assertJsonResponse<{ ok: true }>(response);
  expect(data.ok).toBe(true);
};

describe("Workflows Runner (Scenario DSL)", () => {
  test("runs a simple workflow to completion", async () => {
    const SimpleWorkflow = defineWorkflow({ name: "simple-workflow" }, async () => {
      return { ok: true };
    });

    const workflows = { SIMPLE: SimpleWorkflow };

    type ScenarioVars = {
      status?: { status: string; output?: unknown };
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "simple-workflow-complete",
      workflows,
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({ workflow: "SIMPLE", id: "simple-1" }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("SIMPLE", "simple-1"),
          storeAs: "status",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.status?.status).toBe("complete");
          expect(ctx.vars.status?.output).toEqual({ ok: true });
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("records a completed step", async () => {
    const StepWorkflow = defineWorkflow({ name: "step-workflow" }, async (_event, step) => {
      const value = await step.do("compute", () => 42);
      return { value };
    });

    const workflows = { STEP: StepWorkflow };

    type ScenarioVars = {
      status?: { status: string; output?: { value: number } };
      steps?: WorkflowScenarioStepRow[];
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "completed-step",
      workflows,
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({ workflow: "STEP", id: "step-1" }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("STEP", "step-1"),
          storeAs: "status",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("STEP", "step-1"),
          storeAs: "steps",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.status?.status).toBe("complete");
          expect(ctx.vars.status?.output).toEqual({ value: 42 });
          expect(ctx.vars.steps).toHaveLength(1);
          expect(ctx.vars.steps?.[0]).toMatchObject({
            name: "compute",
            type: "do",
            status: "completed",
            stepKey: "do:compute",
          });
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("runs multiple steps and consumes a buffered event", async () => {
    const EventWorkflow = defineWorkflow({ name: "eventful-workflow" }, async (_event, step) => {
      const seed = await step.do("seed", () => 3);
      const ready = await step.waitForEvent<{ value: number }>("ready", { type: "ready" });
      const sum = await step.do("sum", () => seed + ready.payload.value);
      return { seed, sum, eventValue: ready.payload.value };
    });

    const workflows = { EVENTFUL: EventWorkflow };

    type ScenarioVars = {
      status?: { status: string; output?: unknown };
      steps?: WorkflowScenarioStepRow[];
      events?: WorkflowScenarioEventRow[];
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "eventful-workflow",
      workflows,
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({ workflow: "EVENTFUL", id: "eventful-1" }),
        scenarioSteps.eventAndRunUntilIdle({
          workflow: "EVENTFUL",
          instanceId: "eventful-1",
          event: { type: "ready", payload: { value: 9 } },
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("EVENTFUL", "eventful-1"),
          storeAs: "status",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("EVENTFUL", "eventful-1"),
          storeAs: "steps",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getEvents("EVENTFUL", "eventful-1"),
          storeAs: "events",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.status?.status).toBe("complete");
          expect(ctx.vars.status?.output).toEqual({ seed: 3, sum: 12, eventValue: 9 });
          expect(ctx.vars.steps).toHaveLength(3);
          expect(ctx.vars.steps?.map((step) => step.stepKey).sort()).toEqual([
            "do:seed",
            "do:sum",
            "waitForEvent:ready",
          ]);
          expect(ctx.vars.events).toHaveLength(1);
          expect(ctx.vars.events?.[0]).toMatchObject({
            type: "ready",
            consumedByStepKey: "waitForEvent:ready",
          });
          expect(ctx.vars.events?.[0].deliveredAt).toBeInstanceOf(Date);
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("runs parallel steps and records both results", async () => {
    const ParallelWorkflow = defineWorkflow({ name: "parallel-workflow" }, async (_event, step) => {
      const [alpha, beta] = await Promise.all([
        step.do("alpha", async () => "A"),
        step.do("beta", async () => "B"),
      ]);
      return { alpha, beta };
    });

    const workflows = { PARALLEL: ParallelWorkflow };

    type ScenarioVars = {
      status?: { status: string; output?: { alpha: string; beta: string } };
      steps?: WorkflowScenarioStepRow[];
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "parallel-steps",
      workflows,
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({ workflow: "PARALLEL", id: "parallel-1" }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("PARALLEL", "parallel-1"),
          storeAs: "status",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("PARALLEL", "parallel-1"),
          storeAs: "steps",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.status?.status).toBe("complete");
          expect(ctx.vars.status?.output).toEqual({ alpha: "A", beta: "B" });
          expect(ctx.vars.steps).toHaveLength(2);
          expect(ctx.vars.steps?.map((step) => step.stepKey).sort()).toEqual([
            "do:alpha",
            "do:beta",
          ]);
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("simulates a fetch inside a step", async () => {
    const FetchWorkflow = defineWorkflow({ name: "fetch-workflow" }, async (_event, step) => {
      const response = await step.do("fetch", async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return { status: 200, json: { ok: true, source: "fake" } };
      });
      return response;
    });

    const workflows = { FETCH: FetchWorkflow };

    type ScenarioVars = {
      status?: {
        status: string;
        output?: { status: number; json: { ok: boolean; source: string } };
      };
      steps?: WorkflowScenarioStepRow[];
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "fetch-step",
      workflows,
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({ workflow: "FETCH", id: "fetch-1" }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("FETCH", "fetch-1"),
          storeAs: "status",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("FETCH", "fetch-1"),
          storeAs: "steps",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.status?.status).toBe("complete");
          expect(ctx.vars.status?.output).toEqual({
            status: 200,
            json: { ok: true, source: "fake" },
          });
          expect(ctx.vars.steps).toHaveLength(1);
          expect(ctx.vars.steps?.[0]).toMatchObject({
            name: "fetch",
            type: "do",
            status: "completed",
            stepKey: "do:fetch",
          });
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("waits for an event before completing", async () => {
    const WaitWorkflow = defineWorkflow({ name: "wait-workflow" }, async (_event, step) => {
      const ready = await step.waitForEvent<{ ok: boolean }>("ready", { type: "ready" });
      return { ok: ready.payload.ok };
    });

    const workflows = { WAIT: WaitWorkflow };

    type ScenarioVars = {
      waitingStatus?: { status: string };
      finalStatus?: { status: string; output?: { ok: boolean } };
      steps?: WorkflowScenarioStepRow[];
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "wait-for-event",
      workflows,
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({ workflow: "WAIT", id: "wait-1" }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("WAIT", "wait-1"),
          storeAs: "waitingStatus",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("WAIT", "wait-1"),
          storeAs: "steps",
        }),
        scenarioSteps.eventAndRunUntilIdle({
          workflow: "WAIT",
          instanceId: "wait-1",
          event: { type: "ready", payload: { ok: true } },
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("WAIT", "wait-1"),
          storeAs: "finalStatus",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.waitingStatus?.status).toBe("waiting");
          expect(ctx.vars.steps?.[0]).toMatchObject({
            stepKey: "waitForEvent:ready",
            status: "waiting",
          });
          expect(ctx.vars.finalStatus?.status).toBe("complete");
          expect(ctx.vars.finalStatus?.output).toEqual({ ok: true });
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("suspends on sleep and marks wake time", async () => {
    const SleepWorkflow = defineWorkflow({ name: "sleep-workflow" }, async (_event, step) => {
      await step.sleep("nap", "10 minutes");
      return { done: true };
    });

    const workflows = { SLEEP: SleepWorkflow };

    type ScenarioVars = {
      status?: { status: string };
      steps?: WorkflowScenarioStepRow[];
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "sleep-waiting",
      workflows,
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({ workflow: "SLEEP", id: "sleep-1" }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("SLEEP", "sleep-1"),
          storeAs: "status",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("SLEEP", "sleep-1"),
          storeAs: "steps",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.status?.status).toBe("waiting");
          expect(ctx.vars.steps?.[0]).toMatchObject({
            stepKey: "sleep:nap",
            status: "waiting",
          });
          expect(ctx.vars.steps?.[0].wakeAt).toBeInstanceOf(Date);
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("completes sleep on explicit wake tick", async () => {
    const SleepWorkflow = defineWorkflow({ name: "sleep-wake-workflow" }, async (_event, step) => {
      await step.sleep("nap", "10 minutes");
      return { done: true };
    });

    const workflows = { SLEEP_WAKE: SleepWorkflow };

    type ScenarioVars = {
      waiting?: { status: string };
      final?: { status: string; output?: { done: boolean } };
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "sleep-wake",
      workflows,
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({ workflow: "SLEEP_WAKE", id: "sleep-wake-1" }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("SLEEP_WAKE", "sleep-wake-1"),
          storeAs: "waiting",
        }),
        scenarioSteps.advanceTimeAndRunUntilIdle({
          workflow: "SLEEP_WAKE",
          instanceId: "sleep-wake-1",
          advanceBy: "10 minutes",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("SLEEP_WAKE", "sleep-wake-1"),
          storeAs: "final",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.waiting?.status).toBe("waiting");
          expect(ctx.vars.final?.status).toBe("complete");
          expect(ctx.vars.final?.output).toEqual({ done: true });
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("suspends on sleepUntil and completes on wake", async () => {
    let wakeAt: Date | null = null;

    const SleepUntilWorkflow = defineWorkflow(
      { name: "sleep-until-workflow" },
      async (_event, step) => {
        if (!wakeAt) {
          throw new Error("MISSING_WAKE_AT");
        }
        await step.sleepUntil("alarm", wakeAt);
        return { done: true };
      },
    );

    const workflows = { SLEEP_UNTIL: SleepUntilWorkflow };

    type ScenarioVars = {
      wakeAt?: Date;
      waiting?: { status: string };
      final?: { status: string; output?: { done: boolean } };
      steps?: WorkflowScenarioStepRow[];
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "sleep-until",
      workflows,
      steps: [
        scenarioSteps.read({
          read: (ctx) => {
            wakeAt = new Date(ctx.clock.now().getTime() + 5 * 60 * 1000);
            return wakeAt;
          },
          storeAs: "wakeAt",
        }),
        scenarioSteps.initializeAndRunUntilIdle({ workflow: "SLEEP_UNTIL", id: "sleep-until-1" }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("SLEEP_UNTIL", "sleep-until-1"),
          storeAs: "waiting",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("SLEEP_UNTIL", "sleep-until-1"),
          storeAs: "steps",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.waiting?.status).toBe("waiting");
          expect(ctx.vars.steps?.[0]).toMatchObject({
            stepKey: "sleep:alarm",
            status: "waiting",
          });
          expect(ctx.vars.steps?.[0].wakeAt?.getTime()).toBe(ctx.vars.wakeAt?.getTime());
        }),
        scenarioSteps.advanceTimeAndRunUntilIdle({
          workflow: "SLEEP_UNTIL",
          instanceId: "sleep-until-1",
          setTo: (ctx) => ctx.vars.wakeAt as Date,
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("SLEEP_UNTIL", "sleep-until-1"),
          storeAs: "final",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.final?.status).toBe("complete");
          expect(ctx.vars.final?.output).toEqual({ done: true });
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("waitForEvent times out on wake tick", async () => {
    const TimeoutWorkflow = defineWorkflow(
      { name: "event-timeout-workflow" },
      async (_event, step) => {
        await step.waitForEvent("ready", { type: "ready", timeout: "5 minutes" });
        return { ok: true };
      },
    );

    const workflows = { TIMEOUT: TimeoutWorkflow };

    type ScenarioVars = {
      waiting?: { status: string };
      final?: { status: string; error?: { message?: string } };
      waitingSteps?: WorkflowScenarioStepRow[];
      finalSteps?: WorkflowScenarioStepRow[];
      wakeAt?: Date;
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "wait-timeout",
      workflows,
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({ workflow: "TIMEOUT", id: "timeout-1" }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("TIMEOUT", "timeout-1"),
          storeAs: "waiting",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("TIMEOUT", "timeout-1"),
          storeAs: "waitingSteps",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.vars.waitingSteps?.[0].wakeAt ?? null,
          storeAs: "wakeAt",
        }),
        scenarioSteps.advanceTimeAndRunUntilIdle({
          workflow: "TIMEOUT",
          instanceId: "timeout-1",
          setTo: (ctx) => new Date((ctx.vars.wakeAt as Date).getTime() + 1),
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("TIMEOUT", "timeout-1"),
          storeAs: "final",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("TIMEOUT", "timeout-1"),
          storeAs: "finalSteps",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.waiting?.status).toBe("waiting");
          expect(ctx.vars.waitingSteps?.[0]).toMatchObject({
            stepKey: "waitForEvent:ready",
            status: "waiting",
            waitEventType: "ready",
          });
          expect(ctx.vars.waitingSteps?.[0].wakeAt).toBeInstanceOf(Date);
          expect(ctx.vars.final?.status).toBe("errored");
          expect(ctx.vars.final?.error?.message).toBe("WAIT_FOR_EVENT_TIMEOUT");
          expect(ctx.vars.finalSteps?.[0]).toMatchObject({
            stepKey: "waitForEvent:ready",
            status: "errored",
            errorMessage: "WAIT_FOR_EVENT_TIMEOUT",
          });
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("getHistory returns ordered step and event data", async () => {
    const HistoryWorkflow = defineWorkflow({ name: "history-workflow" }, async (_event, step) => {
      const seed = await step.do("seed", () => 3);
      const ready = await step.waitForEvent<{ ok: boolean }>("ready", { type: "ready" });
      const result = await step.do("result", () => (ready.payload.ok ? seed + 1 : seed));
      return { result };
    });

    const workflows = { HISTORY: HistoryWorkflow };

    type ScenarioVars = {
      status?: { status: string };
      history?: {
        runNumber: number;
        steps: Array<{ stepKey: string; createdAt: Date | string }>;
        events: WorkflowScenarioEventRow[];
      };
      historyByRun?: { runNumber: number; steps: unknown[]; events: unknown[] };
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "history-ordering",
      workflows,
      steps: [
        scenarioSteps.create({ workflow: "HISTORY", id: "history-1" }),
        scenarioSteps.tick({ workflow: "HISTORY", instanceId: "history-1", reason: "create" }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("HISTORY", "history-1"),
          storeAs: "status",
        }),
        scenarioSteps.event({
          workflow: "HISTORY",
          instanceId: "history-1",
          event: { type: "ready", payload: { ok: true } },
        }),
        scenarioSteps.tick({ workflow: "HISTORY", instanceId: "history-1", reason: "event" }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("HISTORY", "history-1"),
          storeAs: "status",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getHistory("HISTORY", "history-1", { order: "desc" }),
          storeAs: "history",
        }),
        scenarioSteps.read({
          read: (ctx) =>
            ctx.state.getHistory("HISTORY", "history-1", { runNumber: 0, order: "desc" }),
          storeAs: "historyByRun",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.status?.status).toBe("complete");

          const history = ctx.vars.history;
          expect(history?.runNumber).toBe(0);

          const stepKeys = history?.steps.map((step) => step.stepKey).sort() ?? [];
          expect(stepKeys).toEqual(["do:result", "do:seed", "waitForEvent:ready"]);

          const stepTimestamps =
            history?.steps.map((step) => new Date(step.createdAt as Date | string).getTime()) ?? [];
          expect([...stepTimestamps].sort((a, b) => b - a)).toEqual(stepTimestamps);

          expect(history?.events).toHaveLength(1);
          expect(history?.events[0]).toMatchObject({
            type: "ready",
            payload: { ok: true },
            consumedByStepKey: "waitForEvent:ready",
          });
          const deliveredAt = history?.events[0].deliveredAt;
          expect(deliveredAt).toBeTruthy();
          expect(new Date(deliveredAt as Date | string).toString()).not.toBe("Invalid Date");

          expect(ctx.vars.historyByRun?.runNumber).toBe(0);
          expect(ctx.vars.historyByRun?.steps).toHaveLength(3);
          expect(ctx.vars.historyByRun?.events).toHaveLength(1);
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("consumes multiple events of the same type in order", async () => {
    const EventOrderWorkflow = defineWorkflow(
      { name: "event-order-workflow" },
      async (_event, step) => {
        const first = await step.waitForEvent<{ value: number }>("first", { type: "ready" });
        const second = await step.waitForEvent<{ value: number }>("second", { type: "ready" });
        return { first: first.payload.value, second: second.payload.value };
      },
    );

    const workflows = { EVENT_ORDER: EventOrderWorkflow };

    type ScenarioVars = {
      status?: { status: string; output?: { first: number; second: number } };
      events?: Array<{ id: unknown; payload: unknown; consumedByStepKey: string | null }>;
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "event-order",
      workflows,
      steps: [
        scenarioSteps.create({ workflow: "EVENT_ORDER", id: "event-order-1" }),
        scenarioSteps.tick({
          workflow: "EVENT_ORDER",
          instanceId: "event-order-1",
          reason: "create",
        }),
        scenarioSteps.event({
          workflow: "EVENT_ORDER",
          instanceId: "event-order-1",
          event: { type: "ready", payload: { value: 1 } },
        }),
        scenarioSteps.event({
          workflow: "EVENT_ORDER",
          instanceId: "event-order-1",
          event: { type: "ready", payload: { value: 2 } },
        }),
        scenarioSteps.tick({
          workflow: "EVENT_ORDER",
          instanceId: "event-order-1",
          reason: "event",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("EVENT_ORDER", "event-order-1"),
          storeAs: "status",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.harness.db.find("workflow_event", (b) => b.whereIndex("primary")),
          storeAs: "events",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.status?.status).toBe("complete");
          const events = ctx.vars.events ?? [];
          expect(events).toHaveLength(2);

          const [firstEvent, secondEvent] = [...events].sort((a, b) =>
            String(a.id).localeCompare(String(b.id)),
          );

          expect(ctx.vars.status?.output).toEqual({
            first: (firstEvent.payload as { value: number }).value,
            second: (secondEvent.payload as { value: number }).value,
          });
          expect(firstEvent).toMatchObject({
            consumedByStepKey: "waitForEvent:first",
          });
          expect(secondEvent).toMatchObject({
            consumedByStepKey: "waitForEvent:second",
          });
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("treats event hooks as run ticks", async () => {
    const EventReasonWorkflow = defineWorkflow(
      { name: "event-reason-workflow" },
      async (_event, step) => {
        const ready = await step.waitForEvent<{ ok: boolean }>("ready", { type: "ready" });
        return { ok: ready.payload.ok };
      },
    );

    const workflows = { EVENT_REASON: EventReasonWorkflow };

    type ScenarioVars = {
      statusAfterCreate?: { status: string };
      statusAfterEventTick?: { status: string };
      steps?: WorkflowScenarioStepRow[];
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "event-reason-ticks",
      workflows,
      steps: [
        scenarioSteps.create({ workflow: "EVENT_REASON", id: "event-reason-1" }),
        scenarioSteps.tick({
          workflow: "EVENT_REASON",
          instanceId: "event-reason-1",
          reason: "create",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("EVENT_REASON", "event-reason-1"),
          storeAs: "statusAfterCreate",
        }),
        scenarioSteps.tick({
          workflow: "EVENT_REASON",
          instanceId: "event-reason-1",
          reason: "event",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("EVENT_REASON", "event-reason-1"),
          storeAs: "statusAfterEventTick",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("EVENT_REASON", "event-reason-1"),
          storeAs: "steps",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.statusAfterCreate?.status).toBe("waiting");
          expect(ctx.vars.statusAfterEventTick?.status).toBe("waiting");
          expect(ctx.vars.steps?.[0]).toMatchObject({
            stepKey: "waitForEvent:ready",
            status: "waiting",
            waitEventType: "ready",
          });
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("treats resume hooks as run ticks", async () => {
    const ResumeReasonWorkflow = defineWorkflow(
      { name: "resume-reason-workflow" },
      async (_event, step) => {
        const ready = await step.waitForEvent<{ ok: boolean }>("ready", { type: "ready" });
        return { ok: ready.payload.ok };
      },
    );

    const workflows = { RESUME_REASON: ResumeReasonWorkflow };

    type ScenarioVars = {
      pauseResponse?: RouteResponse;
      resumeResponse?: RouteResponse;
      pausedStatus?: { status: string };
      activeStatus?: { status: string };
      finalStatus?: { status: string };
      steps?: WorkflowScenarioStepRow[];
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "resume-reason-ticks",
      workflows,
      steps: [
        scenarioSteps.create({ workflow: "RESUME_REASON", id: "resume-reason-1" }),
        scenarioSteps.tick({
          workflow: "RESUME_REASON",
          instanceId: "resume-reason-1",
          reason: "create",
        }),
        scenarioSteps.pause({
          workflow: "RESUME_REASON",
          instanceId: "resume-reason-1",
          storeAs: "pauseResponse",
        }),
        scenarioSteps.tick({
          workflow: "RESUME_REASON",
          instanceId: "resume-reason-1",
          reason: "event",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("RESUME_REASON", "resume-reason-1"),
          storeAs: "pausedStatus",
        }),
        scenarioSteps.resume({
          workflow: "RESUME_REASON",
          instanceId: "resume-reason-1",
          storeAs: "resumeResponse",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("RESUME_REASON", "resume-reason-1"),
          storeAs: "activeStatus",
        }),
        scenarioSteps.tick({
          workflow: "RESUME_REASON",
          instanceId: "resume-reason-1",
          reason: "resume",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("RESUME_REASON", "resume-reason-1"),
          storeAs: "finalStatus",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("RESUME_REASON", "resume-reason-1"),
          storeAs: "steps",
        }),
        scenarioSteps.assert((ctx) => {
          assertOkResponse(ctx.vars.pauseResponse as RouteResponse);
          assertOkResponse(ctx.vars.resumeResponse as RouteResponse);

          expect(ctx.vars.pausedStatus?.status).toBe("paused");
          expect(ctx.vars.activeStatus?.status).toBe("active");
          expect(ctx.vars.finalStatus?.status).toBe("waiting");
          expect(ctx.vars.steps?.[0]).toMatchObject({
            stepKey: "waitForEvent:ready",
            status: "waiting",
            waitEventType: "ready",
          });
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("keeps paused workflows from consuming events until resume", async () => {
    const PauseEventWorkflow = defineWorkflow(
      { name: "pause-event-workflow" },
      async (_event, step) => {
        const ready = await step.waitForEvent<{ ok: boolean }>("ready", { type: "ready" });
        return { ok: ready.payload.ok };
      },
    );

    const workflows = { PAUSE_EVENT: PauseEventWorkflow };

    type ScenarioVars = {
      pauseResponse?: RouteResponse;
      resumeResponse?: RouteResponse;
      pausedStatus?: { status: string };
      activeStatus?: { status: string };
      finalStatus?: { status: string; output?: { ok: boolean } };
      eventsBefore?: WorkflowScenarioEventRow[];
      eventsAfter?: WorkflowScenarioEventRow[];
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "pause-event-consumption",
      workflows,
      steps: [
        scenarioSteps.create({ workflow: "PAUSE_EVENT", id: "pause-event-1" }),
        scenarioSteps.tick({
          workflow: "PAUSE_EVENT",
          instanceId: "pause-event-1",
          reason: "create",
        }),
        scenarioSteps.pause({
          workflow: "PAUSE_EVENT",
          instanceId: "pause-event-1",
          storeAs: "pauseResponse",
        }),
        scenarioSteps.tick({
          workflow: "PAUSE_EVENT",
          instanceId: "pause-event-1",
          reason: "event",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("PAUSE_EVENT", "pause-event-1"),
          storeAs: "pausedStatus",
        }),
        scenarioSteps.event({
          workflow: "PAUSE_EVENT",
          instanceId: "pause-event-1",
          event: { type: "ready", payload: { ok: true } },
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("PAUSE_EVENT", "pause-event-1"),
          storeAs: "pausedStatus",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getEvents("PAUSE_EVENT", "pause-event-1"),
          storeAs: "eventsBefore",
        }),
        scenarioSteps.resume({
          workflow: "PAUSE_EVENT",
          instanceId: "pause-event-1",
          storeAs: "resumeResponse",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("PAUSE_EVENT", "pause-event-1"),
          storeAs: "activeStatus",
        }),
        scenarioSteps.tick({
          workflow: "PAUSE_EVENT",
          instanceId: "pause-event-1",
          reason: "resume",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("PAUSE_EVENT", "pause-event-1"),
          storeAs: "finalStatus",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getEvents("PAUSE_EVENT", "pause-event-1"),
          storeAs: "eventsAfter",
        }),
        scenarioSteps.assert((ctx) => {
          assertOkResponse(ctx.vars.pauseResponse as RouteResponse);
          assertOkResponse(ctx.vars.resumeResponse as RouteResponse);
          expect(ctx.vars.pausedStatus?.status).toBe("paused");
          expect(ctx.vars.activeStatus?.status).toBe("active");
          expect(ctx.vars.finalStatus?.status).toBe("complete");
          expect(ctx.vars.finalStatus?.output).toEqual({ ok: true });

          const readyBefore = (ctx.vars.eventsBefore ?? []).find((event) => event.type === "ready");
          expect(readyBefore).toMatchObject({
            type: "ready",
            consumedByStepKey: null,
            deliveredAt: null,
          });

          const readyAfter = (ctx.vars.eventsAfter ?? []).find((event) => event.type === "ready");
          expect(readyAfter).toMatchObject({
            type: "ready",
            consumedByStepKey: "waitForEvent:ready",
          });
          expect(readyAfter?.deliveredAt).toBeInstanceOf(Date);
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("applies WorkflowStepTx mutations", async () => {
    const mutationsSchema = schema("mutations_test", (s) =>
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

    const mutationsFragmentDefinition = defineFragment("mutations-fragment")
      .extend(withDatabase(mutationsSchema))
      .build();

    const MutateWorkflow = defineWorkflow({ name: "mutate-workflow" }, async (event, step) => {
      const note = `fromTx-${event.instanceId}`;
      const result = await step.do("mutate", (tx) => {
        tx.mutate((ctx) => {
          ctx.forSchema(mutationsSchema).create("mutation_record", { note });
        });
        return "mutated";
      });
      return { result };
    });

    const workflows = { MUTATE: MutateWorkflow };

    type ScenarioVars = {
      status?: { status: string; output?: { result: string } };
      mutationRows?: Array<{ note: string }>;
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "step-tx-mutations",
      workflows,
      harness: {
        configureBuilder: (builder) =>
          builder.withFragment("mutations", instantiate(mutationsFragmentDefinition)),
      },
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({ workflow: "MUTATE", id: "mutate-1" }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("MUTATE", "mutate-1"),
          storeAs: "status",
        }),
        scenarioSteps.read({
          read: (ctx) =>
            ctx.harness.fragments["mutations"].db.find("mutation_record", (b) =>
              b.whereIndex("primary"),
            ),
          storeAs: "mutationRows",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.status?.status).toBe("complete");
          expect(ctx.vars.status?.output).toEqual({ result: "mutated" });
          expect(ctx.vars.mutationRows).toHaveLength(1);
          expect(ctx.vars.mutationRows?.[0]).toMatchObject({ note: "fromTx-mutate-1" });
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("rejects non-mutate serviceCalls in WorkflowStepTx", async () => {
    const serviceCallsSchema = schema("service_calls_test", (s) =>
      s.addTable("service_record", (t) =>
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

    const serviceCallsFragmentDefinition = defineFragment("service-calls-fragment")
      .extend(withDatabase(serviceCallsSchema))
      .providesBaseService(({ defineService }) =>
        defineService({
          listRecords: function () {
            return this.serviceTx(serviceCallsSchema)
              .retrieve((uow) => uow.find("service_record", (b) => b.whereIndex("primary")))
              .build();
          },
        }),
      )
      .build();

    let serviceCallFragment: InstantiatedFragmentFromDefinition<
      typeof serviceCallsFragmentDefinition
    >;

    const ServiceCallWorkflow = defineWorkflow(
      { name: "service-call-workflow" },
      async (_event, step) => {
        await step.do("call", (tx) => {
          tx.serviceCalls(() => [serviceCallFragment.services.listRecords()]);
          return "active";
        });
        return { ok: true };
      },
    );

    const workflows = { SERVICE_CALL: ServiceCallWorkflow };

    type ScenarioVars = {
      status?: { status: string; error?: { message?: string } };
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "step-tx-service-calls",
      workflows,
      harness: {
        configureBuilder: (builder) =>
          builder.withFragmentFactory(
            "serviceCalls",
            serviceCallsFragmentDefinition,
            ({ adapter }) => {
              const fragment = instantiate(serviceCallsFragmentDefinition)
                .withOptions({ databaseAdapter: adapter })
                .build();
              serviceCallFragment = fragment;
              return fragment;
            },
          ),
      },
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({ workflow: "SERVICE_CALL", id: "service-call-1" }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("SERVICE_CALL", "service-call-1"),
          storeAs: "status",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.status?.status).toBe("errored");
          expect(ctx.vars.status?.error?.message).toBe("WORKFLOW_STEP_TX_RETRIEVE_NOT_SUPPORTED");
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("retries a failed step and succeeds", async () => {
    let attempts = 0;
    const RetryWorkflow = defineWorkflow({ name: "retry-workflow" }, async (_event, step) => {
      const result = await step.do(
        "unstable",
        { retries: { limit: 1, delay: 0, backoff: "constant" } },
        () => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("RETRY_ME");
          }
          return "ok";
        },
      );
      return { result };
    });

    const workflows = { RETRY: RetryWorkflow };

    type ScenarioVars = {
      status?: { status: string; output?: { result: string } };
      steps?: WorkflowScenarioStepRow[];
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "retry-success",
      workflows,
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({ workflow: "RETRY", id: "retry-1" }),
        scenarioSteps.retryAndRunUntilIdle({ workflow: "RETRY", instanceId: "retry-1" }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("RETRY", "retry-1"),
          storeAs: "status",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("RETRY", "retry-1"),
          storeAs: "steps",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.status?.status).toBe("complete");
          expect(ctx.vars.status?.output).toEqual({ result: "ok" });
          expect(ctx.vars.steps?.[0]).toMatchObject({
            stepKey: "do:unstable",
            status: "completed",
            attempts: 2,
          });
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("marks workflow errored when step throws", async () => {
    const ErrorWorkflow = defineWorkflow({ name: "error-workflow" }, async (_event, step) => {
      await step.do("boom", () => {
        throw new Error("BOOM");
      });
      return { ok: true };
    });

    const workflows = { ERROR: ErrorWorkflow };

    type ScenarioVars = {
      status?: { status: string };
      steps?: WorkflowScenarioStepRow[];
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "errored-step",
      workflows,
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({ workflow: "ERROR", id: "error-1" }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("ERROR", "error-1"),
          storeAs: "status",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("ERROR", "error-1"),
          storeAs: "steps",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.status?.status).toBe("errored");
          expect(ctx.vars.steps?.[0]).toMatchObject({
            stepKey: "do:boom",
            status: "errored",
          });
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("pauses an active instance and resumes to completion", async () => {
    let runs = 0;
    const PauseWorkflow = defineWorkflow(
      { name: "pause-management-workflow" },
      async (_event, step) => {
        const value = await step.do("count", () => {
          runs += 1;
          return runs;
        });
        return { value };
      },
    );

    const workflows = { PAUSE: PauseWorkflow };

    type ScenarioVars = {
      pauseResponse?: RouteResponse;
      resumeResponse?: RouteResponse;
      pausedStatus?: { status: string };
      activeStatus?: { status: string };
      finalStatus?: { status: string; output?: { value: number } };
      instance?: WorkflowScenarioInstanceRow | null;
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "pause-resume",
      workflows,
      steps: [
        scenarioSteps.create({ workflow: "PAUSE", id: "pause-1" }),
        scenarioSteps.pause({
          workflow: "PAUSE",
          instanceId: "pause-1",
          storeAs: "pauseResponse",
        }),
        scenarioSteps.runCreateUntilIdle({ workflow: "PAUSE", instanceId: "pause-1" }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("PAUSE", "pause-1"),
          storeAs: "pausedStatus",
        }),
        scenarioSteps.resume({
          workflow: "PAUSE",
          instanceId: "pause-1",
          storeAs: "resumeResponse",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("PAUSE", "pause-1"),
          storeAs: "activeStatus",
        }),
        scenarioSteps.runResumeUntilIdle({ workflow: "PAUSE", instanceId: "pause-1" }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("PAUSE", "pause-1"),
          storeAs: "finalStatus",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getInstance("PAUSE", "pause-1"),
          storeAs: "instance",
        }),
        scenarioSteps.assert((ctx) => {
          assertOkResponse(ctx.vars.pauseResponse as RouteResponse);
          assertOkResponse(ctx.vars.resumeResponse as RouteResponse);
          expect(ctx.vars.pausedStatus?.status).toBe("paused");
          expect(ctx.vars.activeStatus?.status).toBe("active");
          expect(ctx.vars.finalStatus?.status).toBe("complete");
          expect(ctx.vars.finalStatus?.output).toEqual({ value: 1 });
          expect(ctx.vars.instance).toMatchObject({
            status: "complete",
          });
          expect(runs).toBe(1);
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("terminates an active instance and ignores pending ticks", async () => {
    let runs = 0;
    const TerminateWorkflow = defineWorkflow(
      { name: "terminate-management-workflow" },
      async (_event, step) => {
        const value = await step.do("count", () => {
          runs += 1;
          return runs;
        });
        return { value };
      },
    );

    const workflows = { TERM: TerminateWorkflow };

    type ScenarioVars = {
      terminateResponse?: RouteResponse;
      status?: { status: string };
      steps?: WorkflowScenarioStepRow[];
      instance?: WorkflowScenarioInstanceRow | null;
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "terminate-active",
      workflows,
      steps: [
        scenarioSteps.create({ workflow: "TERM", id: "term-1" }),
        scenarioSteps.terminate({
          workflow: "TERM",
          instanceId: "term-1",
          storeAs: "terminateResponse",
        }),
        scenarioSteps.runCreateUntilIdle({ workflow: "TERM", instanceId: "term-1" }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("TERM", "term-1"),
          storeAs: "status",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("TERM", "term-1"),
          storeAs: "steps",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getInstance("TERM", "term-1"),
          storeAs: "instance",
        }),
        scenarioSteps.assert((ctx) => {
          assertOkResponse(ctx.vars.terminateResponse as RouteResponse);
          expect(ctx.vars.status?.status).toBe("terminated");
          expect(ctx.vars.steps).toHaveLength(0);
          expect(ctx.vars.instance).toMatchObject({
            status: "terminated",
          });
          expect(ctx.vars.instance?.completedAt).toBeInstanceOf(Date);
          expect(runs).toBe(0);
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("restarts a completed instance with a new run", async () => {
    let runs = 0;
    const RestartWorkflow = defineWorkflow(
      { name: "restart-management-workflow" },
      async (_event, step) => {
        const value = await step.do("count", () => {
          runs += 1;
          return runs;
        });
        return { value };
      },
    );

    const workflows = { RESTART: RestartWorkflow };

    type ScenarioVars = {
      restartResponse?: RouteResponse;
      firstStatus?: { status: string; output?: { value: number } };
      activeStatus?: { status: string };
      finalStatus?: { status: string; output?: { value: number } };
      instance?: WorkflowScenarioInstanceRow | null;
      run0Steps?: WorkflowScenarioStepRow[];
      run1Steps?: WorkflowScenarioStepRow[];
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "restart-instance",
      workflows,
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({ workflow: "RESTART", id: "restart-1" }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("RESTART", "restart-1"),
          storeAs: "firstStatus",
        }),
        scenarioSteps.restart({
          workflow: "RESTART",
          instanceId: "restart-1",
          storeAs: "restartResponse",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("RESTART", "restart-1"),
          storeAs: "activeStatus",
        }),
        scenarioSteps.runCreateUntilIdle({ workflow: "RESTART", instanceId: "restart-1" }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("RESTART", "restart-1"),
          storeAs: "finalStatus",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getInstance("RESTART", "restart-1"),
          storeAs: "instance",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("RESTART", "restart-1", { runNumber: 0 }),
          storeAs: "run0Steps",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("RESTART", "restart-1", { runNumber: 1 }),
          storeAs: "run1Steps",
        }),
        scenarioSteps.assert((ctx) => {
          assertOkResponse(ctx.vars.restartResponse as RouteResponse);
          expect(ctx.vars.firstStatus?.status).toBe("complete");
          expect(ctx.vars.firstStatus?.output).toEqual({ value: 1 });
          expect(ctx.vars.activeStatus?.status).toBe("active");
          expect(ctx.vars.finalStatus?.status).toBe("complete");
          expect(ctx.vars.finalStatus?.output).toEqual({ value: 2 });
          expect(ctx.vars.instance?.runNumber).toBe(1);
          expect(ctx.vars.run0Steps).toHaveLength(1);
          expect(ctx.vars.run1Steps).toHaveLength(1);
          expect(runs).toBe(2);
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("createBatch creates multiple instances and runs them", async () => {
    const BatchWorkflow = defineWorkflow({ name: "batch-workflow" }, async (event, step) => {
      const result = await step.do("result", () => ({
        instanceId: event.instanceId,
      }));
      return result;
    });

    const workflows = { BATCH: BatchWorkflow };

    type ScenarioVars = {
      created?: Array<{ id: string; details: { status: string } }>;
      status1?: { status: string; output?: { instanceId: string } };
      status2?: { status: string; output?: { instanceId: string } };
      status3?: { status: string; output?: { instanceId: string } };
      instances?: WorkflowScenarioInstanceRow[];
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "batch-create",
      workflows,
      steps: [
        scenarioSteps.createBatch({
          workflow: "BATCH",
          instances: [{ id: "batch-1" }, { id: "batch-2" }, { id: "batch-3" }],
          storeAs: "created",
        }),
        scenarioSteps.runCreateUntilIdle({ workflow: "BATCH", instanceId: "batch-1" }),
        scenarioSteps.runCreateUntilIdle({ workflow: "BATCH", instanceId: "batch-2" }),
        scenarioSteps.runCreateUntilIdle({ workflow: "BATCH", instanceId: "batch-3" }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("BATCH", "batch-1"),
          storeAs: "status1",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("BATCH", "batch-2"),
          storeAs: "status2",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("BATCH", "batch-3"),
          storeAs: "status3",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.harness.db.find("workflow_instance", (b) => b.whereIndex("primary")),
          storeAs: "instances",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.created).toHaveLength(3);
          expect(ctx.vars.created?.map((entry) => entry.id)).toEqual([
            "batch-1",
            "batch-2",
            "batch-3",
          ]);
          expect(ctx.vars.created?.map((entry) => entry.details.status)).toEqual([
            "active",
            "active",
            "active",
          ]);

          expect(ctx.vars.status1?.status).toBe("complete");
          expect(ctx.vars.status2?.status).toBe("complete");
          expect(ctx.vars.status3?.status).toBe("complete");
          expect(ctx.vars.status1?.output).toEqual({ instanceId: "batch-1" });
          expect(ctx.vars.status2?.output).toEqual({ instanceId: "batch-2" });
          expect(ctx.vars.status3?.output).toEqual({ instanceId: "batch-3" });
          expect(ctx.vars.instances).toHaveLength(3);
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("createBatch skips existing and duplicate instance ids", async () => {
    const BatchWorkflow = defineWorkflow({ name: "batch-skip-workflow" }, async (event, step) => {
      const value = await step.do("result", () => event.instanceId);
      return { value };
    });

    const workflows = { BATCH_SKIP: BatchWorkflow };

    type ScenarioVars = {
      created?: Array<{ id: string; details: { status: string } }>;
      instances?: WorkflowScenarioInstanceRow[];
      freshStatus?: { status: string; output?: { value: string } };
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "batch-skip",
      workflows,
      steps: [
        scenarioSteps.create({ workflow: "BATCH_SKIP", id: "existing-1" }),
        scenarioSteps.createBatch({
          workflow: "BATCH_SKIP",
          instances: [{ id: "existing-1" }, { id: "dup-1" }, { id: "dup-1" }, { id: "fresh-1" }],
          storeAs: "created",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.harness.db.find("workflow_instance", (b) => b.whereIndex("primary")),
          storeAs: "instances",
        }),
        scenarioSteps.runCreateUntilIdle({ workflow: "BATCH_SKIP", instanceId: "dup-1" }),
        scenarioSteps.runCreateUntilIdle({ workflow: "BATCH_SKIP", instanceId: "fresh-1" }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("BATCH_SKIP", "fresh-1"),
          storeAs: "freshStatus",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.created?.map((entry) => entry.id)).toEqual(["dup-1", "fresh-1"]);
          expect(ctx.vars.instances).toHaveLength(3);
          expect(ctx.vars.freshStatus?.status).toBe("complete");
          expect(ctx.vars.freshStatus?.output).toEqual({ value: "fresh-1" });
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("createBatch route returns created instances", async () => {
    const RouteBatchWorkflow = defineWorkflow(
      { name: "batch-route-workflow" },
      async (_event, step) => {
        const value = await step.do("result", () => "ok");
        return { value };
      },
    );

    const workflows = { BATCH_ROUTE: RouteBatchWorkflow };

    type ScenarioVars = {
      response?: RouteResponse;
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "batch-route-response",
      workflows,
      steps: [
        scenarioSteps.read({
          read: (ctx) =>
            (ctx.harness.fragment as AnyFragnoInstantiatedFragment).callRoute(
              "POST",
              "/:workflowName/instances/batch",
              {
                pathParams: { workflowName: RouteBatchWorkflow.name },
                body: { instances: [{ id: "route-1" }, { id: "route-2" }] },
              },
            ),
          storeAs: "response",
        }),
        scenarioSteps.assert((ctx) => {
          const response = assertJsonResponse<{
            instances: Array<{ id: string; details: { status: string } }>;
          }>(ctx.vars.response as RouteResponse);

          expect(response.instances.map((entry) => entry.id)).toEqual(["route-1", "route-2"]);
          expect(response.instances.map((entry) => entry.details.status)).toEqual([
            "active",
            "active",
          ]);
        }),
      ],
    });

    const previousDebug = process.env["FRAGNO_DEBUG_BATCH_ROUTE"];
    process.env["FRAGNO_DEBUG_BATCH_ROUTE"] = "1";
    try {
      await runScenario(scenario);
    } finally {
      if (previousDebug === undefined) {
        delete process.env["FRAGNO_DEBUG_BATCH_ROUTE"];
      } else {
        process.env["FRAGNO_DEBUG_BATCH_ROUTE"] = previousDebug;
      }
    }
  });
});
