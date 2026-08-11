import { assert, describe, expect, test } from "vitest";

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
          uow.triggerHook("internalIngestEvent", { event, route }, { id: "start-replay-1" });
          uow.triggerHook("internalIngestEvent", { event, route }, { id: "start-replay-2" });
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
          uow.triggerHook("internalIngestEvent", { event, route }, { id: "send-replay-1" });
          uow.triggerHook("internalIngestEvent", { event, route }, { id: "send-replay-2" });
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

  test("replaying forward_event persists one target automation event", async () => {
    const target = createAutomationFragment(
      {
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
          uow.triggerHook("internalIngestEvent", { event, route }, { id: "forward-replay-1" });
          uow.triggerHook("internalIngestEvent", { event, route }, { id: "forward-replay-2" });
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
