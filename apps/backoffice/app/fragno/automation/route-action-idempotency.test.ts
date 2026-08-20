import { assert, describe, expect, test } from "vitest";

import { getDurableHooksService } from "@fragno-dev/db/durable-hooks";
import { defineRemoteWorkflow } from "@fragno-dev/workflows/workflow";

import { defaultFragnoRuntime } from "@fragno-dev/core";
import { InMemoryAdapter } from "@fragno-dev/db";
import { drainDurableHooks } from "@fragno-dev/test";
import { createWorkflowsFragment, workflowsSchema } from "@fragno-dev/workflows";

import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";

import type { AutomationEvent } from "./contracts";
import type { AutomationWorkflowsService } from "./definition";
import { CODEMODE_WORKFLOW } from "./engine/codemode-invocation";
import { createTestMasterFileSystem } from "./engine/test-master-file-system.test-utils";
import { createAutomationFragment } from "./index";
import type { AutomationRouteDefinition } from "./routing";
import { automationFragmentSchema } from "./schema";

const actors = {
  initiator: {
    scope: "external",
    source: "test",
    type: "test",
    id: "route-action-idempotency",
    role: "initiator",
  },
  principal: null,
  delegation: [],
} as const;

const event: AutomationEvent = {
  id: "route-event-1",
  scope: { kind: "org", orgId: "org_123" },
  source: "custom",
  eventType: "ready",
  occurredAt: "2026-08-11T00:00:00.000Z",
  payload: { value: "ready" },
  actors,
  subject: { orgId: "org_123" },
};

function reclassificationRoute({
  id,
  source,
  eventType,
  targetSource,
  targetEventType,
}: {
  id: string;
  source: string;
  eventType: string;
  targetSource: string;
  targetEventType: string;
}): AutomationRouteDefinition {
  return {
    id,
    name: id,
    enabled: true,
    priority: 1,
    trigger: { kind: "event", source, eventType, matcher: null },
    action: {
      kind: "reclassify_event",
      source: targetSource,
      eventType: targetEventType,
      payload: { kind: "projection", fields: { value: "$.payload.value" } },
    },
    nextOccurrenceAt: null,
  };
}

const workflowDefinition = defineRemoteWorkflow({ name: CODEMODE_WORKFLOW }, async () => ({
  ok: true,
}));

const noOpWorkflows = {
  createInstance: async () => ({}),
  getInstanceStatus: async () => [],
  sendEvent: async () => ({}),
} as unknown as AutomationWorkflowsService;

describe("automation route action idempotency", () => {
  test("replaying start_workflow creates one workflow instance", async () => {
    const databaseAdapter = new InMemoryAdapter({ idSeed: "route-start-idempotency" });
    const workflows = createWorkflowsFragment(
      {
        workflows: { [CODEMODE_WORKFLOW]: workflowDefinition },
        runtime: defaultFragnoRuntime,
      },
      { databaseAdapter },
    );
    const automations = createAutomationFragment(
      {
        builtInEventDefinitions: [],
        ownerScope: { kind: "org", orgId: "org_123" },
        automationFileSystem: createTestMasterFileSystem({
          "/workspace/automations/idempotent.workflow.js":
            'defineWorkflow({ name: "idempotent" }, async () => ({ ok: true }));',
        }),
      },
      {
        databaseAdapter,
        dbRoundtripGuard: true,
        outbox: { enabled: true },
      },
      { workflows: workflows.services },
    );
    const route: AutomationRouteDefinition = {
      id: "idempotent-start",
      name: "Idempotent start",
      enabled: true,
      priority: 1,
      trigger: { kind: "event", source: "custom", eventType: "ready", matcher: null },
      action: {
        kind: "start_workflow",
        authority: { kind: "organization-automation" },
        workflowScriptPath: "/workspace/automations/idempotent.workflow.js",
        instanceIdTemplate: "instance-${event.id}",
      },
      nextOccurrenceAt: null,
    };

    await automations.inContext(async function () {
      await this.handlerTx()
        .mutate(({ forSchema }) => {
          const uow = forSchema(automationFragmentSchema);
          uow.triggerHook(
            "internalIngestEvent",
            {
              event,
              reclassificationChain: [{ source: event.source, eventType: event.eventType }],
              route,
            },
            { id: "start-replay-1" },
          );
          uow.triggerHook(
            "internalIngestEvent",
            {
              event,
              reclassificationChain: [{ source: event.source, eventType: event.eventType }],
              route,
            },
            { id: "start-replay-2" },
          );
        })
        .execute();
    });
    await drainDurableHooks(automations);

    const instances = await workflows.callServices(() =>
      workflows.services.listInstances({ workflowName: CODEMODE_WORKFLOW }),
    );
    expect(instances.instances).toHaveLength(1);
    expect(instances.instances[0]).toMatchObject({ id: "instance-route-event-1" });
  });

  test("replaying send_workflow_event persists one workflow event", async () => {
    const databaseAdapter = new InMemoryAdapter({ idSeed: "route-send-event-idempotency" });
    const workflows = createWorkflowsFragment(
      {
        workflows: { [CODEMODE_WORKFLOW]: workflowDefinition },
        runtime: defaultFragnoRuntime,
      },
      { databaseAdapter },
    );
    await workflows.callServices(() =>
      workflows.services.createInstance(CODEMODE_WORKFLOW, {
        id: "waiting-instance",
        params: {},
        remoteWorkflowName: "waiting-workflow",
      }),
    );
    const automations = createAutomationFragment(
      {
        builtInEventDefinitions: [],
        ownerScope: { kind: "org", orgId: "org_123" },
        automationFileSystem: createTestMasterFileSystem({}),
      },
      {
        databaseAdapter,
        dbRoundtripGuard: true,
        outbox: { enabled: true },
      },
      { workflows: workflows.services },
    );
    const route: AutomationRouteDefinition = {
      id: "idempotent-send",
      name: "Idempotent send",
      enabled: true,
      priority: 1,
      trigger: { kind: "event", source: "custom", eventType: "ready", matcher: null },
      action: {
        kind: "send_workflow_event",
        target: { kind: "instance_id", template: "waiting-instance" },
        eventType: "ready",
        payload: "$event",
      },
      nextOccurrenceAt: null,
    };

    await automations.inContext(async function () {
      await this.handlerTx()
        .mutate(({ forSchema }) => {
          const uow = forSchema(automationFragmentSchema);
          uow.triggerHook(
            "internalIngestEvent",
            {
              event,
              reclassificationChain: [{ source: event.source, eventType: event.eventType }],
              route,
            },
            { id: "send-replay-1" },
          );
          uow.triggerHook(
            "internalIngestEvent",
            {
              event,
              reclassificationChain: [{ source: event.source, eventType: event.eventType }],
              route,
            },
            { id: "send-replay-2" },
          );
        })
        .execute();
    });
    await drainDurableHooks(automations);

    const [events] = await workflows.inContext(async function () {
      return await this.handlerTx()
        .retrieve(({ forSchema }) =>
          forSchema(workflowsSchema).find("workflow_event", (builder) =>
            builder.whereIndex("primary"),
          ),
        )
        .execute();
    });
    expect(events).toHaveLength(1);
    assert(events[0]?.id.toString() === "idempotent-send:route-event-1");
  });

  test("replaying reclassify_event persists one derived automation event", async () => {
    const source = createAutomationFragment(
      {
        builtInEventDefinitions: [
          {
            source: "github",
            eventType: "issues.opened",
            enabled: true,
            payloadSchema: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
              additionalProperties: false,
            },
          },
        ],
        ownerScope: { kind: "org", orgId: "org_123" },
        automationFileSystem: createTestMasterFileSystem({}),
      },
      {
        databaseAdapter: new InMemoryAdapter({ idSeed: "route-reclassify-source" }),
        dbRoundtripGuard: true,
        outbox: { enabled: true },
      },
      { workflows: noOpWorkflows },
    );
    const route: AutomationRouteDefinition = {
      id: "github-issues-opened",
      name: "GitHub issues opened",
      enabled: true,
      priority: 1,
      trigger: { kind: "event", source: "github", eventType: "webhook.received", matcher: null },
      action: {
        kind: "reclassify_event",
        source: "github",
        eventType: "issues.opened",
        payload: { kind: "projection", fields: { value: "$.payload.value" } },
      },
      nextOccurrenceAt: null,
    };

    await source.inContext(async function () {
      await this.handlerTx()
        .mutate(({ forSchema }) => {
          const uow = forSchema(automationFragmentSchema);
          uow.triggerHook(
            "internalIngestEvent",
            {
              event,
              reclassificationChain: [{ source: event.source, eventType: event.eventType }],
              route,
            },
            { id: "reclassify-replay-1" },
          );
          uow.triggerHook(
            "internalIngestEvent",
            {
              event,
              reclassificationChain: [{ source: event.source, eventType: event.eventType }],
              route,
            },
            { id: "reclassify-replay-2" },
          );
        })
        .execute();
    });
    await drainDurableHooks(source);

    const response = await source.callRoute("GET", "/events");
    assert(response.type === "json");
    expect(response.data.events).toHaveLength(1);
    expect(response.data.events[0]).toMatchObject({
      id: "reclassified:github-issues-opened:route-event-1",
      scope: event.scope,
      source: "github",
      eventType: "issues.opened",
      payload: { value: "ready" },
      actors: event.actors,
      subject: event.subject,
    });
  });

  test("rejects events that violate a built-in event definition", async () => {
    const automations = createAutomationFragment(
      {
        builtInEventDefinitions: [
          {
            source: "github",
            eventType: "push",
            enabled: true,
            payloadSchema: {
              type: "object",
              properties: { ref: { type: "string" } },
              required: ["ref"],
              additionalProperties: false,
            },
          },
        ],
        ownerScope: { kind: "org", orgId: "org_123" },
        automationFileSystem: createTestMasterFileSystem({}),
      },
      {
        databaseAdapter: new InMemoryAdapter({ idSeed: "built-in-event-validation" }),
        dbRoundtripGuard: true,
        outbox: { enabled: true },
      },
      { workflows: noOpWorkflows },
    );

    await expect(
      automations.callServices(() =>
        automations.services.ingestEvent({
          ...event,
          source: "github",
          eventType: "push",
          payload: { nonsense: true },
        }),
      ),
    ).rejects.toThrow(/github\/push payload failed schema validation/);
  });

  test("rejects a direct reclassification cycle at execution", async () => {
    const automations = createAutomationFragment(
      {
        builtInEventDefinitions: [],
        ownerScope: { kind: "org", orgId: "org_123" },
        automationFileSystem: createTestMasterFileSystem({}),
      },
      {
        databaseAdapter: new InMemoryAdapter({ idSeed: "direct-reclassification-cycle" }),
        dbRoundtripGuard: true,
        outbox: { enabled: true },
      },
      { workflows: noOpWorkflows },
    );
    const route = reclassificationRoute({
      id: "custom-ready-loop",
      source: "custom",
      eventType: "ready",
      targetSource: "custom",
      targetEventType: "ready",
    });

    await automations.inContext(async function () {
      await this.handlerTx()
        .mutate(({ forSchema }) => {
          forSchema(automationFragmentSchema).triggerHook(
            "internalIngestEvent",
            {
              event,
              reclassificationChain: [{ source: event.source, eventType: event.eventType }],
              route,
            },
            { id: "direct-cycle" },
          );
        })
        .execute();
    });

    await drainDurableHooks(automations);

    const { hookService, namespace } = getDurableHooksService(automations);
    const hooks = await automations.inContext(async function () {
      return await this.handlerTx()
        .withServiceCalls(() => [hookService.getHooksByNamespacePage(namespace)] as const)
        .transform(({ serviceResult: [result] }) => result.items)
        .execute();
    });
    expect(hooks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          error: "AUTOMATION_EVENT_RECLASSIFICATION_CYCLE: custom/ready",
        }),
      ]),
    );
  });

  test("rejects a multi-route reclassification cycle", async () => {
    const automations = createAutomationFragment(
      {
        builtInEventDefinitions: [],
        ownerScope: { kind: "org", orgId: "org_123" },
        automationFileSystem: createTestMasterFileSystem({}),
      },
      {
        databaseAdapter: new InMemoryAdapter({ idSeed: "multi-reclassification-cycle" }),
        dbRoundtripGuard: true,
        outbox: { enabled: true },
      },
      { workflows: noOpWorkflows },
    );
    const firstRoute = reclassificationRoute({
      id: "custom-ready-to-next",
      source: "custom",
      eventType: "ready",
      targetSource: "custom",
      targetEventType: "next",
    });
    const secondRoute = reclassificationRoute({
      id: "custom-next-to-ready",
      source: "custom",
      eventType: "next",
      targetSource: "custom",
      targetEventType: "ready",
    });

    await automations.inContext(async function () {
      await this.handlerTx()
        .mutate(({ forSchema }) => {
          const uow = forSchema(automationFragmentSchema);
          uow.create("automation_route", {
            id: secondRoute.id,
            name: secondRoute.name,
            enabled: secondRoute.enabled,
            priority: secondRoute.priority,
            trigger: secondRoute.trigger,
            action: secondRoute.action,
            description: null,
            metadata: null,
            createdAt: uow.now(),
            updatedAt: uow.now(),
          });
          uow.triggerHook(
            "internalIngestEvent",
            {
              event,
              reclassificationChain: [{ source: event.source, eventType: event.eventType }],
              route: firstRoute,
            },
            { id: "multi-cycle" },
          );
        })
        .execute();
    });

    await drainDurableHooks(automations);

    const { hookService, namespace } = getDurableHooksService(automations);
    const hooks = await automations.inContext(async function () {
      return await this.handlerTx()
        .withServiceCalls(() => [hookService.getHooksByNamespacePage(namespace)] as const)
        .transform(({ serviceResult: [result] }) => result.items)
        .execute();
    });
    expect(hooks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          error: "AUTOMATION_EVENT_RECLASSIFICATION_CYCLE: custom/ready",
        }),
      ]),
    );
  });

  test("allows a reclassification chain with distinct event identities", async () => {
    const automations = createAutomationFragment(
      {
        builtInEventDefinitions: [],
        ownerScope: { kind: "org", orgId: "org_123" },
        automationFileSystem: createTestMasterFileSystem({}),
      },
      {
        databaseAdapter: new InMemoryAdapter({ idSeed: "valid-reclassification-chain" }),
        dbRoundtripGuard: true,
        outbox: { enabled: true },
      },
      { workflows: noOpWorkflows },
    );
    const firstRoute = reclassificationRoute({
      id: "custom-ready-to-next",
      source: "custom",
      eventType: "ready",
      targetSource: "custom",
      targetEventType: "next",
    });
    const secondRoute = reclassificationRoute({
      id: "custom-next-to-complete",
      source: "custom",
      eventType: "next",
      targetSource: "custom",
      targetEventType: "complete",
    });

    await automations.inContext(async function () {
      await this.handlerTx()
        .mutate(({ forSchema }) => {
          const uow = forSchema(automationFragmentSchema);
          uow.create("automation_route", {
            id: secondRoute.id,
            name: secondRoute.name,
            enabled: secondRoute.enabled,
            priority: secondRoute.priority,
            trigger: secondRoute.trigger,
            action: secondRoute.action,
            description: null,
            metadata: null,
            createdAt: uow.now(),
            updatedAt: uow.now(),
          });
          uow.triggerHook(
            "internalIngestEvent",
            {
              event,
              reclassificationChain: [{ source: event.source, eventType: event.eventType }],
              route: firstRoute,
            },
            { id: "valid-chain" },
          );
        })
        .execute();
    });
    await drainDurableHooks(automations);

    const response = await automations.callRoute("GET", "/events");
    assert(response.type === "json");
    expect(response.data.events.map((storedEvent) => storedEvent.eventType).sort()).toEqual([
      "complete",
      "next",
    ]);
  });

  test("replaying forward_event persists one target automation event", async () => {
    const target = createAutomationFragment(
      {
        builtInEventDefinitions: [],
        ownerScope: { kind: "org", orgId: "org_456" },
        automationFileSystem: createTestMasterFileSystem({}),
      },
      {
        databaseAdapter: new InMemoryAdapter({ idSeed: "route-forward-target" }),
        dbRoundtripGuard: true,
        outbox: { enabled: true },
      },
      { workflows: noOpWorkflows },
    );
    const runtime = {
      objects: {
        automations: {
          for: () => ({
            seedStarterAutomationRoutes: async () => ({ created: [], skipped: [] }),
            ingestEvent: async (forwardedEvent: AutomationEvent) =>
              await target.callServices(() => target.services.ingestEvent(forwardedEvent)),
          }),
        },
      },
    } as unknown as BackofficeRuntimeServices;
    const source = createAutomationFragment(
      {
        builtInEventDefinitions: [],
        ownerScope: { kind: "system" },
        automationFileSystem: createTestMasterFileSystem({}),
        runtime,
      },
      {
        databaseAdapter: new InMemoryAdapter({ idSeed: "route-forward-source" }),
        dbRoundtripGuard: true,
        outbox: { enabled: true },
      },
      { workflows: noOpWorkflows },
    );
    const route: AutomationRouteDefinition = {
      id: "idempotent-forward",
      name: "Idempotent forward",
      enabled: true,
      priority: 1,
      trigger: { kind: "event", source: "custom", eventType: "ready", matcher: null },
      action: {
        kind: "forward_event",
        targetScope: { kind: "org", orgIdTemplate: "org_456" },
        idTemplate: "forwarded-${event.id}",
      },
      nextOccurrenceAt: null,
    };

    await source.inContext(async function () {
      await this.handlerTx()
        .mutate(({ forSchema }) => {
          const uow = forSchema(automationFragmentSchema);
          uow.triggerHook(
            "internalIngestEvent",
            {
              event,
              reclassificationChain: [{ source: event.source, eventType: event.eventType }],
              route,
            },
            { id: "forward-replay-1" },
          );
          uow.triggerHook(
            "internalIngestEvent",
            {
              event,
              reclassificationChain: [{ source: event.source, eventType: event.eventType }],
              route,
            },
            { id: "forward-replay-2" },
          );
        })
        .execute();
    });
    await drainDurableHooks(source);

    const response = await target.callRoute("GET", "/events");
    assert(response.type === "json");
    expect(response.data.events).toHaveLength(1);
    expect(response.data.events[0]).toMatchObject({
      id: "forwarded-route-event-1",
      scope: { kind: "org", orgId: "org_456" },
    });
  });
});
