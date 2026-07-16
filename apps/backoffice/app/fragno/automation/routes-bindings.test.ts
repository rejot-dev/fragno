import { beforeEach, describe, expect, test, assert } from "vitest";

import { getDurableHooksService } from "@fragno-dev/db/durable-hooks";

import { InMemoryAdapter } from "@fragno-dev/db";
import { drainDurableHooks } from "@fragno-dev/test";

import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import { createMasterFileSystem, createSystemFilesContext } from "@/files";

import {
  STARTER_AUTOMATION_ROUTES,
  SYSTEM_STARTER_AUTOMATION_ROUTES,
} from "./content/starter-routing";
import type { AutomationEvent } from "./contracts";
import type { AutomationWorkflowsService } from "./definition";
import { createAutomationFragment } from "./index";

const createAutomation = async (
  options: {
    ownerScope?:
      | { kind: "system" }
      | { kind: "org"; orgId: string }
      | { kind: "project"; orgId: string; projectId: string };
    workflows?: AutomationWorkflowsService;
    runtime?: BackofficeRuntimeServices;
  } = {},
) => {
  const services = {
    workflows:
      options.workflows ??
      ({
        createInstance: async () => ({}),
        getInstanceStatus: async () => [],
        getLiveInstanceState: async () => ({}),
        restoreInstanceState: async () => ({}),
        sendEvent: async () => ({}),
      } as unknown as AutomationWorkflowsService),
  };
  const ownerScope = options.ownerScope ?? { kind: "org", orgId: "org_123" };

  return createAutomationFragment(
    {
      ownerScope,
      automationFileSystem: await createMasterFileSystem(
        createSystemFilesContext({
          execution: {
            actor: { type: "system", id: "system" },
            scope: ownerScope,
          },

          staticFileArtifacts: () => ({}),
        }),
      ),
      runtime: options.runtime,
    },
    {
      databaseAdapter: new InMemoryAdapter({ idSeed: "automation-routes-store-test" }),
      dbRoundtripGuard: true,
      mountRoute: "/api/automations",
      outbox: { enabled: true },
    },
    services,
  );
};

const projectIdValue = (id: unknown): string =>
  typeof id === "object" && id && "externalId" in id
    ? String((id as { externalId: unknown }).externalId)
    : String((id as { valueOf(): unknown }).valueOf());

const actor = {
  scope: "external",
  source: "telegram",
  type: "chat",
  id: "chat-123",
} as const;

let fragment: Awaited<ReturnType<typeof createAutomation>>;

beforeEach(async () => {
  fragment = await createAutomation();
});

describe("automation routes /routes", () => {
  test("lists and seeds starter automation routes", async () => {
    await fragment.inContext(async function () {
      await this.handlerTx()
        .withServiceCalls(() => [fragment.services.seedStarterAutomationRoutes()] as const)
        .execute();
    });

    const response = await fragment.callRoute("GET", "/routes");

    assert(response.type === "json");
    if (response.type === "json") {
      expect(response.data.map((route) => route.id)).toEqual(
        [...STARTER_AUTOMATION_ROUTES]
          .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id))
          .map((route) => route.id),
      );
      expect(response.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "telegram-identity-claim-completed",
            action: expect.objectContaining({ kind: "send_workflow_event" }),
          }),
          expect.objectContaining({
            id: "telegram-test-command",
            action: expect.objectContaining({
              kind: "start_workflow",
              remoteWorkflowName: "telegram-test-command",
            }),
          }),
        ]),
      );
    }
  });

  test("seeds hidden system automation routes in system scope", async () => {
    const systemFragment = await createAutomation({ ownerScope: { kind: "system" } });
    await systemFragment.inContext(async function () {
      await this.handlerTx()
        .withServiceCalls(() => [systemFragment.services.seedStarterAutomationRoutes()] as const)
        .execute();
    });

    const response = await systemFragment.callRoute("GET", "/routes");

    assert(response.type === "json");
    if (response.type === "json") {
      expect(response.data.map((route) => route.id)).toEqual(
        [...SYSTEM_STARTER_AUTOMATION_ROUTES]
          .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id))
          .map((route) => route.id),
      );
    }
  });

  test("creates and updates automation routes", async () => {
    const createResponse = await fragment.callRoute("POST", "/routes", {
      body: {
        id: "telegram-hello",
        name: "Telegram hello",
        enabled: true,
        source: "telegram",
        eventType: "message.received",
        matcher: { path: "$.payload.text", op: "startsWith", value: "/hello" },
        priority: 1000,
        action: {
          kind: "start_workflow",
          workflowName: "automation-codemode-script",
          remoteWorkflowName: "telegram-hello",
          workflowScriptPath: "/workspace/automations/telegram-hello.workflow.js",
          instanceIdTemplate: "telegram-hello-${event}",
        },
      },
    });

    assert(createResponse.type === "json");
    if (createResponse.type !== "json") {
      return;
    }
    expect(createResponse.data).toMatchObject({
      id: "telegram-hello",
      enabled: true,
      priority: 1000,
      action: expect.objectContaining({ workflowName: "automation-codemode-script" }),
    });

    const updateResponse = await fragment.callRoute("PATCH", "/routes/:routeId", {
      pathParams: { routeId: "telegram-hello" },
      body: {
        enabled: false,
        priority: 900,
        description: "Disabled while testing.",
      },
    });

    assert(updateResponse.type === "json");
    if (updateResponse.type === "json") {
      expect(updateResponse.data).toMatchObject({
        id: "telegram-hello",
        enabled: false,
        priority: 900,
        description: "Disabled while testing.",
        matcher: { path: "$.payload.text", op: "startsWith", value: "/hello" },
      });
    }
  });

  test("system routes can forward events to an organization scope", async () => {
    const forwardedEvents: AutomationEvent[] = [];
    const runtime = {
      objects: {
        automations: {
          for: (scope: AutomationEvent["scope"]) => ({
            ingestEvent: async (event: AutomationEvent) => {
              forwardedEvents.push(event);
              expect(scope).toEqual({ kind: "org", orgId: "org_123" });
              return {
                accepted: true,
                eventId: event.id,
                scope: event.scope,
                source: event.source,
                eventType: event.eventType,
              };
            },
          }),
        },
      },
    } as unknown as BackofficeRuntimeServices;
    const systemFragment = await createAutomation({ ownerScope: { kind: "system" }, runtime });

    await systemFragment.callRoute("POST", "/routes", {
      body: {
        id: "custom-forwarder",
        name: "Custom forwarder",
        enabled: true,
        source: "custom",
        eventType: "ready",
        matcher: { path: "$.subject.orgId", op: "exists" },
        priority: 20,
        action: {
          kind: "forward_event",
          targetScope: { kind: "org", orgIdTemplate: "${event.subject.orgId}" },
          idTemplate: "${event.id}",
        },
      },
    });

    const event: AutomationEvent = {
      id: "custom:ready:org_123",
      scope: { kind: "system" },
      source: "custom",
      eventType: "ready",
      occurredAt: "2026-01-01T00:00:00.000Z",
      payload: { organization: { id: "org_123" } },
      actor,
      actors: [actor],
      subject: { orgId: "org_123" },
    };

    await systemFragment.callServices(() => systemFragment.services.ingestEvent(event));
    await drainDurableHooks(systemFragment);

    expect(forwardedEvents).toEqual([
      expect.objectContaining({
        id: "custom:ready:org_123",
        scope: { kind: "org", orgId: "org_123" },
        source: "custom",
        eventType: "ready",
      }),
    ]);
  });

  test("org-owned forward event routes cannot target another organization", async () => {
    const ingestEvent = async () => ({
      accepted: true,
      eventId: "unexpected",
      scope: { kind: "org", orgId: "org_999" } as const,
      source: "custom",
      eventType: "ready",
    });
    const runtime = {
      objects: {
        automations: {
          for: () => ({ ingestEvent }),
        },
      },
    } as unknown as BackofficeRuntimeServices;
    fragment = await createAutomation({ runtime });

    await fragment.callRoute("POST", "/routes", {
      body: {
        id: "custom-cross-org-forwarder",
        name: "Custom cross-org forwarder",
        enabled: true,
        source: "custom",
        eventType: "ready",
        matcher: null,
        priority: 20,
        action: {
          kind: "forward_event",
          targetScope: { kind: "org", orgIdTemplate: "org_999" },
        },
      },
    });

    await fragment.callServices(() =>
      fragment.services.ingestEvent({
        id: "custom:ready:org_123",
        scope: { kind: "org", orgId: "org_123" },
        source: "custom",
        eventType: "ready",
        occurredAt: "2026-01-01T00:00:00.000Z",
        payload: {},
        actor,
        actors: [actor],
        subject: { orgId: "org_123" },
      }),
    );
    await drainDurableHooks(fragment);

    const { hookService, namespace } = getDurableHooksService(fragment);
    const hooks = await fragment.inContext(async function () {
      return await this.handlerTx()
        .withServiceCalls(() => [hookService.getHooksByNamespacePage(namespace)] as const)
        .transform(({ serviceResult: [result] }) => result.items)
        .execute();
    });
    expect(hooks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hookName: "internalIngestEvent",
          error: "automation.forward-event cannot use org:org_999 within org:org_123.",
        }),
      ]),
    );
  });

  test("forward event routes fail when the target scope template is empty", async () => {
    const runtime = {
      objects: {
        automations: {
          for: () => ({
            ingestEvent: async () => ({
              accepted: true,
              eventId: "unexpected",
              scope: { kind: "org", orgId: "unexpected" },
              source: "custom",
              eventType: "ready",
            }),
          }),
        },
      },
    } as unknown as BackofficeRuntimeServices;
    const systemFragment = await createAutomation({ ownerScope: { kind: "system" }, runtime });

    await systemFragment.callRoute("POST", "/routes", {
      body: {
        id: "custom-forwarder-empty-target",
        name: "Custom forwarder with empty target",
        enabled: true,
        source: "custom",
        eventType: "ready",
        matcher: null,
        priority: 20,
        action: {
          kind: "forward_event",
          targetScope: { kind: "org", orgIdTemplate: "${event.subject.orgId}" },
        },
      },
    });

    await systemFragment.callServices(() =>
      systemFragment.services.ingestEvent({
        id: "custom:ready:missing-org",
        scope: { kind: "system" },
        source: "custom",
        eventType: "ready",
        occurredAt: "2026-01-01T00:00:00.000Z",
        payload: {},
        actor,
        actors: [actor],
        subject: null,
      }),
    );

    await drainDurableHooks(systemFragment);

    const { hookService, namespace } = getDurableHooksService(systemFragment);
    const hooks = await systemFragment.inContext(async function () {
      return await this.handlerTx()
        .withServiceCalls(() => [hookService.getHooksByNamespacePage(namespace)] as const)
        .transform(({ serviceResult: [result] }) => result.items)
        .execute();
    });
    expect(hooks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hookName: "internalIngestEvent",
          error: "Automation route custom-forwarder-empty-target resolved an empty target org id.",
        }),
      ]),
    );
  });

  test("send workflow event routes use deterministic event ids", async () => {
    const sendEvents: Array<{ workflowName: string; instanceId: string; event: { id?: string } }> =
      [];
    fragment = await createAutomation({
      workflows: {
        createInstance: async () => ({}),
        getInstanceStatus: async () => [],
        sendEvent: async (workflowName: string, instanceId: string, event: { id?: string }) => {
          sendEvents.push({ workflowName, instanceId, event });
          return {};
        },
      } as unknown as AutomationWorkflowsService,
    });

    await fragment.callRoute("POST", "/store/set", {
      body: {
        key: "waiter/alpha",
        value: "waiter-1",
        actor,
      },
    });
    await fragment.callRoute("POST", "/routes", {
      body: {
        id: "custom-signal-forwarder",
        name: "Custom signal forwarder",
        enabled: true,
        source: "custom",
        eventType: "signal.received",
        matcher: null,
        priority: 50,
        action: {
          kind: "send_workflow_event",
          workflowName: "automation-codemode-script",
          target: { kind: "stored_instance_id", keyTemplate: "waiter/${event.payload.key}" },
          eventType: "custom-signal",
          payload: "$event",
        },
      },
    });

    const event: AutomationEvent = {
      id: "signal-1",
      scope: { kind: "org", orgId: "org_123" },
      source: "custom",
      eventType: "signal.received",
      occurredAt: "2026-01-01T00:00:00.000Z",
      payload: { key: "alpha" },
      actor,
      actors: [actor],
      subject: { orgId: "org_123" },
    };

    await fragment.callServices(() => fragment.services.ingestEvent(event));
    await drainDurableHooks(fragment);

    expect(sendEvents).toEqual([
      {
        workflowName: "automation-codemode-script",
        instanceId: "waiter-1",
        event: expect.objectContaining({ id: "custom-signal-forwarder:signal-1" }),
      },
    ]);
  });
});

describe("automation routes /events", () => {
  test("lists ingested automation events from the fragment database", async () => {
    await fragment.callServices(() =>
      fragment.services.ingestEvent({
        id: "event-list-1",
        scope: { kind: "org", orgId: "org_123" },
        source: "custom",
        eventType: "ready",
        occurredAt: "2026-01-01T00:00:00.000Z",
        payload: { ok: true },
        actor,
        actors: [actor],
        subject: { orgId: "org_123" },
      }),
    );

    const response = await fragment.callRoute("GET", "/events");

    assert(response.type === "json");
    if (response.type === "json") {
      expect(response.data).toEqual({
        events: [
          expect.objectContaining({
            id: "event-list-1",
            source: "custom",
            eventType: "ready",
            occurredAt: "2026-01-01T00:00:00.000Z",
            payload: { ok: true },
            actor,
            actors: [actor],
            scope: { kind: "org", orgId: "org_123" },
            subject: { orgId: "org_123" },
          }),
        ],
        hasNextPage: false,
      });
    }
  });

  test("paginates ingested automation events with a cursor", async () => {
    for (const id of ["event-page-1", "event-page-2", "event-page-3"]) {
      await fragment.callServices(() =>
        fragment.services.ingestEvent({
          id,
          scope: { kind: "org", orgId: "org_123" },
          source: "custom",
          eventType: "ready",
          occurredAt: `2026-01-01T00:00:0${id.slice(-1)}.000Z`,
          payload: { id },
          actor,
          actors: [actor],
          subject: { orgId: "org_123" },
        }),
      );
    }

    const firstPage = await fragment.callRoute("GET", "/events", { query: { limit: "2" } });
    assert(firstPage.type === "json");
    expect(firstPage.data.events.map((event) => event.id)).toEqual([
      "event-page-3",
      "event-page-2",
    ]);
    assert(firstPage.data.hasNextPage);
    expect(firstPage.data.nextCursor).toEqual(expect.any(String));
    assert(typeof firstPage.data.nextCursor === "string");

    const secondPage = await fragment.callRoute("GET", "/events", {
      query: { cursor: firstPage.data.nextCursor },
    });
    assert(secondPage.type === "json");
    expect(secondPage.data.events.map((event) => event.id)).toEqual(["event-page-1"]);
    assert(!secondPage.data.hasNextPage);
  });

  test("rejects invalid events cursors", async () => {
    const response = await fragment.callRoute("GET", "/events", {
      query: { cursor: "not-a-cursor" },
    });

    assert(response.type === "error");
    assert(response.error.code === "EVENTS_LIST_CURSOR_INVALID");
  });

  test("rejects automation events with invalid occurredAt timestamps", async () => {
    await expect(
      fragment.callServices(() =>
        fragment.services.ingestEvent({
          id: "event-invalid-timestamp",
          scope: { kind: "org", orgId: "org_123" },
          source: "custom",
          eventType: "ready",
          occurredAt: "not-a-timestamp",
          payload: {},
          actor,
          actors: [actor],
          subject: { orgId: "org_123" },
        }),
      ),
    ).rejects.toThrow(/invalid occurredAt timestamp/);
  });
});

describe("automation routes /event-definitions", () => {
  test("rejects event definition validation failures as a client error", async () => {
    const response = await fragment.callRoute("POST", "/event-definitions", {
      body: {
        source: "custom",
        eventType: "invalid.example",
        label: "Invalid example",
        enabled: true,
        payloadSchema: {
          type: "object",
          required: ["thingId"],
          properties: { thingId: { type: "string" } },
        },
        example: { thingId: 123 },
      },
    });

    assert(response.type === "error");
    assert(response.status === 400);
    assert(response.error.code === "EVENT_DEFINITION_INVALID");
  });

  test("rejects dynamic definitions that shadow built-in catalog events", async () => {
    const response = await fragment.callRoute("POST", "/event-definitions", {
      body: {
        source: "auth",
        eventType: "organization.created",
        label: "Shadowed event",
        enabled: true,
      },
    });

    assert(response.type === "error");
    assert(response.status === 400);
    assert(response.error.code === "EVENT_DEFINITION_INVALID");
  });

  test("rejects patch validation failures as a client error", async () => {
    await fragment.callRoute("POST", "/event-definitions", {
      body: {
        source: "custom",
        eventType: "invalid.patch",
        label: "Invalid patch",
        enabled: true,
      },
    });

    const response = await fragment.callRoute("PATCH", "/event-definitions/:source/:eventType", {
      pathParams: { source: "custom", eventType: "invalid.patch" },
      body: {
        payloadSchema: {
          type: "object",
          required: ["thingId"],
          properties: { thingId: { type: "string" } },
        },
        example: { thingId: 123 },
      },
    });

    assert(response.type === "error");
    assert(response.status === 400);
    assert(response.error.code === "EVENT_DEFINITION_INVALID");
  });

  test("returns the new updatedAt timestamp after patching a definition", async () => {
    await fragment.callRoute("POST", "/event-definitions", {
      body: {
        source: "custom",
        eventType: "patched.definition",
        label: "Patched definition",
        enabled: true,
      },
    });

    const before = await fragment.callRoute("GET", "/event-definitions/:source/:eventType", {
      pathParams: { source: "custom", eventType: "patched.definition" },
    });
    assert(before.type === "json");
    assert(typeof before.data.updatedAt === "string");

    await new Promise((resolve) => setTimeout(resolve, 5));

    const patched = await fragment.callRoute("PATCH", "/event-definitions/:source/:eventType", {
      pathParams: { source: "custom", eventType: "patched.definition" },
      body: { label: "Patched definition v2" },
    });

    assert(patched.type === "json");
    expect(patched.data.updatedAt).not.toBe(before.data.updatedAt);
  });
});

describe("automation routes /projects", () => {
  test("creates, lists, looks up, updates, and archives projects", async () => {
    const createResponse = await fragment.callRoute("POST", "/projects", {
      body: {
        name: "Launch Plan",
        createdByUserId: "user_1",
      },
    });

    assert(createResponse.type === "json");
    if (createResponse.type !== "json") {
      return;
    }
    expect(createResponse.data).toMatchObject({
      slug: "launch-plan",
      name: "Launch Plan",
      description: null,
      archivedAt: null,
      createdByUserId: "user_1",
    });

    const listResponse = await fragment.callRoute("GET", "/projects");
    assert(listResponse.type === "json");
    if (listResponse.type === "json") {
      expect(listResponse.data.map((project) => project.slug)).toEqual(["launch-plan"]);
    }

    const projectId = projectIdValue(createResponse.data.id);
    const getResponse = await fragment.callRoute("GET", "/projects/:projectId", {
      pathParams: { projectId },
    });
    assert(getResponse.type === "json");
    if (getResponse.type === "json") {
      expect(projectIdValue(getResponse.data.id)).toBe(projectId);
    }

    const updateResponse = await fragment.callRoute("PATCH", "/projects/:projectId", {
      pathParams: { projectId },
      body: {
        slug: "launch-v2",
        description: "Ready to ship.",
      },
    });
    assert(updateResponse.type === "json");
    if (updateResponse.type === "json") {
      expect(updateResponse.data).toMatchObject({
        id: createResponse.data.id,
        slug: "launch-v2",
        description: "Ready to ship.",
      });
    }

    const archiveResponse = await fragment.callRoute("DELETE", "/projects/:projectId", {
      pathParams: { projectId },
    });
    assert(archiveResponse.type === "json");
    if (archiveResponse.type === "json") {
      expect(archiveResponse.data.archivedAt).toBeTruthy();
    }

    const listAfterArchiveResponse = await fragment.callRoute("GET", "/projects");
    assert(listAfterArchiveResponse.type === "json");
    if (listAfterArchiveResponse.type === "json") {
      expect(listAfterArchiveResponse.data).toHaveLength(1);
      expect(listAfterArchiveResponse.data[0]?.archivedAt).toBeTruthy();
    }
  });

  test("keeps project slugs unique within the Automations object", async () => {
    const body = {
      slug: "shared",
      name: "Shared",
      createdByUserId: "user_1",
    };
    await fragment.callRoute("POST", "/projects", { body });

    const conflictResponse = await fragment.callRoute("POST", "/projects", { body });
    assert(conflictResponse.type === "error");
    if (conflictResponse.type === "error") {
      assert(conflictResponse.status === 409);
      assert(conflictResponse.error.code === "PROJECT_SLUG_CONFLICT");
    }
  });

  test("requires org ownership to create projects", async () => {
    const projectOwnedFragment = await createAutomation({
      ownerScope: { kind: "project", orgId: "org_123", projectId: "project_123" },
    });

    const response = await projectOwnedFragment.callRoute("POST", "/projects", {
      body: {
        name: "No Owner",
        createdByUserId: "user_1",
      },
    });

    assert(response.type === "error");
    if (response.type === "error") {
      expect(response.error.message).toContain(
        "Projects can only be created in org-scoped Automations.",
      );
    }
  });
});

describe("automation routes /store", () => {
  test("exposes store mutations through the internal outbox", async () => {
    await fragment.callRoute("POST", "/store/set", {
      body: {
        key: "telegram/chat-123",
        value: "user-55",
        actor,
        description: "Telegram chat binding",
        category: ["telegram"],
      },
    });

    const outboxResponse = await fragment.callRouteRaw("GET", "/_internal/outbox" as never);
    const entries = (await outboxResponse.json()) as Array<{ payload: unknown }>;

    assert(outboxResponse.status === 200);
    expect(entries.length).toBeGreaterThan(0);
    expect(JSON.stringify(entries)).toContain("telegram/chat-123");
  });

  test("sets and gets a store entry", async () => {
    const setResponse = await fragment.callRoute("POST", "/store/set", {
      body: {
        key: "telegram/chat-123",
        value: "user-55",
        actor,
        description: "Telegram chat binding",
        category: ["telegram"],
      },
    });

    assert(setResponse.type === "json");
    if (setResponse.type !== "json") {
      return;
    }
    expect(setResponse.data).toMatchObject({
      key: "telegram/chat-123",
      value: "user-55",
      actor,
      description: "Telegram chat binding",
      category: ["telegram"],
    });

    const getResponse = await fragment.callRoute("GET", "/store/get", {
      query: { key: "telegram/chat-123" },
    });

    assert(getResponse.type === "json");
    if (getResponse.type === "json") {
      expect(getResponse.data).toMatchObject({ key: "telegram/chat-123", value: "user-55", actor });
    }
  });

  test("rejects set without actor", async () => {
    const response = await fragment.callRoute("POST", "/store/set", {
      body: { key: "telegram/chat-123", value: "user-55" } as never,
    });

    assert(response.type === "error");
  });

  test("rejects non-array categories", async () => {
    const response = await fragment.callRoute("POST", "/store/set", {
      body: { key: "system/default", value: "locked", actor, category: "system" } as never,
    });

    assert(response.type === "error");
  });

  test("reuses the same record on update and tracks the latest actor", async () => {
    const first = await fragment.callRoute("POST", "/store/set", {
      body: { key: "telegram/chat-123", value: "user-55", actor },
    });
    const secondActor = { scope: "internal", type: "user", id: "user-99" } as const;
    const second = await fragment.callRoute("POST", "/store/set", {
      body: { key: "telegram/chat-123", value: "user-99", actor: secondActor },
    });

    assert(first.type === "json");
    assert(second.type === "json");
    if (first.type === "json" && second.type === "json") {
      expect(second.data.id).toBe(first.data.id);
      assert(second.data.value === "user-99");
      expect(second.data.actor).toEqual(secondActor);
    }
  });

  test("validates json-schema verification without storing verification", async () => {
    const response = await fragment.callRoute("POST", "/store/set", {
      body: {
        key: "pi/default-agent",
        value: JSON.stringify({ harness: "h1", model: "m1" }),
        actor,
        verification: [
          {
            type: "json-schema",
            schema: {
              type: "object",
              properties: {
                harness: { type: "string" },
                model: { type: "string" },
              },
              required: ["harness", "model"],
            },
          },
        ],
      },
    });

    assert(response.type === "json");
    if (response.type === "json") {
      expect(response.data).not.toHaveProperty("verification");
    }
  });

  test("rejects values that fail json-schema verification", async () => {
    const response = await fragment.callRoute("POST", "/store/set", {
      body: {
        key: "pi/default-agent",
        value: JSON.stringify({ harness: "h1" }),
        actor,
        verification: [
          {
            type: "json-schema",
            schema: {
              type: "object",
              properties: { model: { type: "string" } },
              required: ["model"],
            },
          },
        ],
      },
    });

    assert(response.type === "error");
  });

  test("rejects invalid json-schema verification schemas", async () => {
    const response = await fragment.callRoute("POST", "/store/set", {
      body: {
        key: "pi/default-agent",
        value: JSON.stringify({ harness: "h1" }),
        actor,
        verification: [{ type: "json-schema", schema: [] }],
      },
    });

    assert(response.type === "error");
  });

  test("scans entries by prefix", async () => {
    await fragment.callRoute("POST", "/store/set", {
      body: { key: "telegram/chat-123", value: "user-55", actor },
    });
    await fragment.callRoute("POST", "/store/set", {
      body: { key: "telegram/chat-456", value: "user-66", actor },
    });
    await fragment.callRoute("POST", "/store/set", {
      body: { key: "pi/default-agent", value: "agent-1", actor },
    });

    const response = await fragment.callRoute("GET", "/store", {
      query: { prefix: "telegram/" },
    });

    assert(response.type === "json");
    if (response.type === "json") {
      expect(response.data.map((entry) => entry.key).sort()).toEqual([
        "telegram/chat-123",
        "telegram/chat-456",
      ]);
      assert(response.data.every((entry) => entry.actor?.id === actor.id));
    }
  });

  test("deletes a store entry", async () => {
    await fragment.callRoute("POST", "/store/set", {
      body: { key: "telegram/chat-123", value: "user-55", actor },
    });

    const deleteResponse = await fragment.callRoute("POST", "/store/delete", {
      body: { key: "telegram/chat-123" },
    });

    assert(deleteResponse.type === "json");
    if (deleteResponse.type === "json") {
      expect(deleteResponse.data).toEqual({ ok: true, key: "telegram/chat-123" });
    }

    const getResponse = await fragment.callRoute("GET", "/store/get", {
      query: { key: "telegram/chat-123" },
    });
    assert(getResponse.type === "error");
  });

  test("returns 403 when deleting a system store entry", async () => {
    await fragment.callRoute("POST", "/store/set", {
      body: { key: "system/default", value: "locked", actor, category: ["system"] },
    });

    const deleteResponse = await fragment.callRoute("POST", "/store/delete", {
      body: { key: "system/default" },
    });

    assert(deleteResponse.type === "error");
    if (deleteResponse.type === "error") {
      assert(deleteResponse.status === 403);
      assert(deleteResponse.error.code === "STORE_ENTRY_PROTECTED");
    }
  });

  test("keeps system category on update", async () => {
    await fragment.callRoute("POST", "/store/set", {
      body: { key: "system/default", value: "locked", actor, category: ["system"] },
    });

    const updateResponse = await fragment.callRoute("POST", "/store/set", {
      body: { key: "system/default", value: "updated", actor, category: ["visible"] },
    });

    assert(updateResponse.type === "json");
    if (updateResponse.type === "json") {
      expect(updateResponse.data.category.sort()).toEqual(["system", "visible"]);
    }
  });

  test("returns 404 for a missing store entry", async () => {
    const response = await fragment.callRoute("GET", "/store/get", {
      query: { key: "missing" },
    });

    assert(response.type === "error");
    if (response.type === "error") {
      assert(response.status === 404);
      assert(response.error.code === "STORE_ENTRY_NOT_FOUND");
    }
  });

  test("returns 404 when deleting a missing store entry", async () => {
    const response = await fragment.callRoute("POST", "/store/delete", {
      body: { key: "missing" },
    });

    assert(response.type === "error");
    if (response.type === "error") {
      assert(response.status === 404);
      assert(response.error.code === "STORE_ENTRY_NOT_FOUND");
    }
  });
});
