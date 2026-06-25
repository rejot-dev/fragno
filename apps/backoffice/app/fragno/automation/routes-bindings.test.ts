import { beforeEach, describe, expect, test, assert } from "vitest";

import { InMemoryAdapter } from "@fragno-dev/db";
import { drainDurableHooks } from "@fragno-dev/test";

import { createMasterFileSystem, createSystemFilesContext } from "@/files";

import { STARTER_AUTOMATION_ROUTES } from "./content/starter-routing";
import type { AutomationEvent } from "./contracts";
import type { AutomationWorkflowsService } from "./definition";
import { createAutomationFragment } from "./index";

const createAutomation = async (
  options: {
    ownerScope?:
      | { kind: "org"; orgId: string }
      | { kind: "project"; orgId: string; projectId: string };
    workflows?: AutomationWorkflowsService;
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

  return createAutomationFragment(
    {
      ownerScope: options.ownerScope ?? { kind: "org", orgId: "org_123" },
      automationFileSystem: await createMasterFileSystem(
        createSystemFilesContext({ orgId: "org_123" }),
      ),
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
            id: "system-project-files-configure",
            action: expect.objectContaining({
              kind: "start_workflow",
              remoteWorkflowName: "project-files-configure",
            }),
          }),
        ]),
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
