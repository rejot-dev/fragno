import { beforeEach, describe, expect, test, assert } from "vitest";

import { InMemoryAdapter } from "@fragno-dev/db";

import { createMasterFileSystem, createSystemFilesContext } from "@/files";

import type { AutomationWorkflowsService } from "./definition";
import { createAutomationFragment } from "./index";

const createAutomation = async () => {
  const services = {
    workflows: {
      createInstance: async () => ({}),
      getInstanceStatus: async () => [],
      getLiveInstanceState: async () => ({}),
      restoreInstanceState: async () => ({}),
      sendEvent: async () => ({}),
    } as unknown as AutomationWorkflowsService,
  };

  return createAutomationFragment(
    {
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
