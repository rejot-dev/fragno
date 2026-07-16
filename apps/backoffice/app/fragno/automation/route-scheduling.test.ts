import { assert, beforeEach, describe, expect, test, vi } from "vitest";

import { getDurableHooksService, InMemoryAdapter } from "@fragno-dev/db";
import { drainDurableHooks } from "@fragno-dev/test";

import { createMasterFileSystem, createSystemFilesContext } from "@/files";

import type { AutomationWorkflowsService } from "./definition";
import { createAutomationFragment } from "./index";
import { automationFragmentSchema } from "./schema";

const scheduledAction = {
  kind: "start_workflow" as const,
  workflowName: "automation-codemode-script",
  remoteWorkflowName: "scheduled-route",
  workflowScriptPath: "/workspace/automations/scheduled-route.workflow.js",
  instanceIdTemplate: "scheduled-${event.id}",
};

const createAutomation = async ({
  now,
  createInstance,
}: {
  now: () => Date;
  createInstance?: ReturnType<typeof vi.fn>;
}) => {
  const workflows = {
    createInstance: createInstance ?? vi.fn(async () => ({})),
    getInstanceStatus: async () => [],
    sendEvent: async () => ({}),
  } as unknown as AutomationWorkflowsService;

  return createAutomationFragment(
    {
      ownerScope: { kind: "org", orgId: "org_123" },
      automationFileSystem: await createMasterFileSystem(
        createSystemFilesContext({
          execution: {
            actor: { type: "system", id: "system" },
            scope: { kind: "org", orgId: "org_123" },
          },
          staticFileArtifacts: () => ({}),
        }),
      ),
    },
    {
      databaseAdapter: new InMemoryAdapter({
        idSeed: "scheduled-routes-test",
        clock: { now },
      }),
      dbRoundtripGuard: true,
      mountRoute: "/api/automations",
      outbox: { enabled: true },
    },
    { workflows },
  );
};

let databaseTime: Date;
let createInstance: ReturnType<typeof vi.fn>;
let fragment: Awaited<ReturnType<typeof createAutomation>>;

beforeEach(async () => {
  databaseTime = new Date("2040-01-01T00:00:00.000Z");
  createInstance = vi.fn(async () => ({}));
  fragment = await createAutomation({ now: () => databaseTime, createInstance });
});

describe("scheduled automation route triggers", () => {
  test("materializes database time in state keyed by the route id", async () => {
    const response = await fragment.callRoute("POST", "/routes", {
      body: {
        id: "daily-digest",
        name: "Daily digest",
        enabled: true,
        priority: 1000,
        trigger: {
          kind: "schedule",
          cadence: { kind: "once", at: "2040-01-01T00:01:00.000Z" },
        },
        action: scheduledAction,
      },
    });
    assert(response.type === "json");
    expect(response.data.nextOccurrenceAt).toBeNull();

    const [route, state] = await fragment.inContext(async function () {
      return await this.handlerTx()
        .retrieve(({ forSchema }) => {
          const uow = forSchema(automationFragmentSchema);
          return uow
            .findFirst("automation_route", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", "daily-digest")),
            )
            .findFirst("automation_route_schedule_state", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", "daily-digest")),
            );
        })
        .execute();
    });
    assert(route && state);
    expect(state.id.externalId).toBe(route.id.externalId);
    expect(state.initializationAt).toEqual(databaseTime);

    await drainDurableHooks(fragment);
    const initialized = await fragment.callRoute("GET", "/routes/:routeId", {
      pathParams: { routeId: "daily-digest" },
    });
    assert(initialized.type === "json");
    assert(initialized.data.nextOccurrenceAt === "2040-01-01T00:01:00.000Z");
  });

  test("executes only the owning route and advances from scheduledFor", async () => {
    await fragment.callRoute("POST", "/routes", {
      body: {
        id: "heartbeat",
        name: "Heartbeat",
        enabled: true,
        priority: 1000,
        trigger: {
          kind: "schedule",
          cadence: { kind: "cron", expression: "* * * * *", timeZone: "UTC" },
        },
        action: scheduledAction,
      },
    });
    await drainDurableHooks(fragment);

    databaseTime = new Date("2040-01-01T00:01:30.000Z");
    await drainDurableHooks(fragment);

    expect(createInstance).toHaveBeenCalledTimes(1);
    const route = await fragment.callRoute("GET", "/routes/:routeId", {
      pathParams: { routeId: "heartbeat" },
    });
    assert(route.type === "json");
    assert(route.data.nextOccurrenceAt === "2040-01-01T00:02:00.000Z");

    const events = await fragment.callRoute("GET", "/events");
    assert(events.type === "json");
    expect(events.data.events).toHaveLength(1);
    expect(events.data.events[0]).toMatchObject({
      source: "scheduler",
      eventType: "schedule.triggered",
      occurredAt: "2040-01-01T00:01:00.000Z",
      payload: { id: "heartbeat", name: "Heartbeat" },
    });
  });

  test("coalesces missed cron occurrences after an hour-long processing gap", async () => {
    await fragment.callRoute("POST", "/routes", {
      body: {
        id: "catch-up-heartbeat",
        name: "Catch-up heartbeat",
        enabled: true,
        priority: 1000,
        trigger: {
          kind: "schedule",
          cadence: { kind: "cron", expression: "* * * * *", timeZone: "UTC" },
        },
        action: {
          kind: "send_workflow_event",
          workflowName: "automation-codemode-script",
          target: { kind: "stored_instance_id", keyTemplate: "missing-instance" },
          eventType: "scheduled",
        },
      },
    });
    await drainDurableHooks(fragment);

    databaseTime = new Date("2040-01-01T01:00:30.000Z");
    await drainDurableHooks(fragment);

    const events = await fragment.callRoute("GET", "/events", { query: { limit: "100" } });
    assert(events.type === "json");
    expect(events.data.events).toHaveLength(1);
    assert(events.data.events[0]?.occurredAt === "2040-01-01T00:01:00.000Z");

    const route = await fragment.callRoute("GET", "/routes/:routeId", {
      pathParams: { routeId: "catch-up-heartbeat" },
    });
    assert(route.type === "json");
    assert(route.data.nextOccurrenceAt === "2040-01-01T01:01:00.000Z");
  });

  test("does not replay a completed one-time occurrence when re-enabled", async () => {
    await fragment.callRoute("POST", "/routes", {
      body: {
        id: "one-time-reminder",
        name: "One-time reminder",
        enabled: true,
        priority: 1000,
        trigger: {
          kind: "schedule",
          cadence: { kind: "once", at: "2040-01-01T00:01:00.000Z" },
        },
        action: scheduledAction,
      },
    });
    await drainDurableHooks(fragment);

    databaseTime = new Date("2040-01-01T00:02:00.000Z");
    await drainDurableHooks(fragment);
    expect(createInstance).toHaveBeenCalledTimes(1);

    await fragment.callRoute("PATCH", "/routes/:routeId", {
      pathParams: { routeId: "one-time-reminder" },
      body: { enabled: false },
    });
    await fragment.callRoute("PATCH", "/routes/:routeId", {
      pathParams: { routeId: "one-time-reminder" },
      body: { enabled: true },
    });
    await drainDurableHooks(fragment);

    const route = await fragment.callRoute("GET", "/routes/:routeId", {
      pathParams: { routeId: "one-time-reminder" },
    });
    assert(route.type === "json");
    expect(route.data.nextOccurrenceAt).toBeNull();
    expect(createInstance).toHaveBeenCalledTimes(1);
  });

  test("rejects cron cadences without a possible occurrence", async () => {
    const response = await fragment.callRoute("POST", "/routes", {
      body: {
        id: "impossible-schedule",
        name: "Impossible schedule",
        enabled: true,
        priority: 1000,
        trigger: {
          kind: "schedule",
          cadence: { kind: "cron", expression: "0 0 31 2 *", timeZone: "UTC" },
        },
        action: scheduledAction,
      },
    });

    assert(response.type === "error");
    assert(response.status === 400);
    assert(response.error.code === "SCHEDULE_CADENCE_INVALID");
  });

  test("changing cadence invalidates the previously queued occurrence", async () => {
    await fragment.callRoute("POST", "/routes", {
      body: {
        id: "reminder",
        name: "Reminder",
        enabled: true,
        priority: 1000,
        trigger: {
          kind: "schedule",
          cadence: { kind: "once", at: "2040-01-01T00:01:00.000Z" },
        },
        action: scheduledAction,
      },
    });
    await drainDurableHooks(fragment);

    await fragment.callRoute("PATCH", "/routes/:routeId", {
      pathParams: { routeId: "reminder" },
      body: {
        trigger: {
          kind: "schedule",
          cadence: { kind: "once", at: "2040-01-01T00:05:00.000Z" },
        },
      },
    });
    await drainDurableHooks(fragment);

    databaseTime = new Date("2040-01-01T00:02:00.000Z");
    await drainDurableHooks(fragment);
    expect(createInstance).not.toHaveBeenCalled();

    databaseTime = new Date("2040-01-01T00:06:00.000Z");
    await drainDurableHooks(fragment);
    expect(createInstance).toHaveBeenCalledTimes(1);
  });

  test("a retried manual dispatch does not ingest the event twice", async () => {
    await fragment.callRoute("POST", "/routes", {
      body: {
        id: "manual-retry",
        name: "Manual retry",
        enabled: false,
        priority: 1000,
        trigger: {
          kind: "schedule",
          cadence: { kind: "once", at: "2041-01-01T00:00:00.000Z" },
        },
        action: {
          kind: "send_workflow_event",
          workflowName: "automation-codemode-script",
          target: { kind: "stored_instance_id", keyTemplate: "missing-instance" },
          eventType: "scheduled",
        },
      },
    });
    const trigger = await fragment.callRoute("POST", "/routes/:routeId/trigger-now", {
      pathParams: { routeId: "manual-retry" },
    });
    assert(trigger.type === "json");
    await drainDurableHooks(fragment);

    const { hookService, namespace } = getDurableHooksService(fragment);
    const manualHook = await fragment.inContext(async function () {
      return await this.handlerTx()
        .withServiceCalls(() => [hookService.getHooksByNamespacePage(namespace)] as const)
        .transform(({ serviceResult: [result] }) =>
          result.items.find(
            (hook) =>
              hook.hookName === "internalDispatchRouteSchedule" &&
              (hook.payload as { kind?: string }).kind === "manual",
          ),
        )
        .execute();
    });
    assert(manualHook);
    expect(manualHook.id.externalId).toBe(`manual-dispatch:${trigger.data.eventId}`);

    await fragment.inContext(async function () {
      await this.handlerTx()
        .withServiceCalls(() => [hookService.markHookProcessing(manualHook.id)] as const)
        .execute();
    });
    databaseTime = new Date(databaseTime.getTime() + 11 * 60_000);
    await drainDurableHooks(fragment);

    const events = await fragment.callRoute("GET", "/events");
    assert(events.type === "json");
    expect(events.data.events).toHaveLength(1);

    const hooks = await fragment.inContext(async function () {
      return await this.handlerTx()
        .withServiceCalls(() => [hookService.getHooksByNamespacePage(namespace)] as const)
        .transform(({ serviceResult: [result] }) => result.items)
        .execute();
    });
    expect(hooks.filter((hook) => hook.hookName === "internalIngestEvent")).toHaveLength(1);
  });

  test("an accepted manual trigger survives route deletion", async () => {
    await fragment.callRoute("POST", "/routes", {
      body: {
        id: "manual",
        name: "Manual",
        enabled: false,
        priority: 1000,
        trigger: {
          kind: "schedule",
          cadence: { kind: "once", at: "2041-01-01T00:00:00.000Z" },
        },
        action: scheduledAction,
      },
    });
    const trigger = await fragment.callRoute("POST", "/routes/:routeId/trigger-now", {
      pathParams: { routeId: "manual" },
    });
    assert(trigger.type === "json");

    await fragment.callRoute("DELETE", "/routes/:routeId", {
      pathParams: { routeId: "manual" },
    });
    await drainDurableHooks(fragment);

    expect(createInstance).toHaveBeenCalledTimes(1);
    const events = await fragment.callRoute("GET", "/events");
    assert(events.type === "json");
    expect(events.data.events).toHaveLength(1);
    expect(events.data.events[0]?.id).toBe(trigger.data.eventId);
  });
});
