import { beforeEach, describe, expect, test, vi } from "vitest";

import { InMemoryAdapter } from "@fragno-dev/db";

import type { AutomationWorkflowsService } from "./definition";
import {
  bindAutomationIdentityActor,
  createAutomationFragment,
  createDefaultAutomationFileSystem,
} from "./index";

const createAutomation = (options?: {
  automationFileSystem?: Awaited<ReturnType<typeof createDefaultAutomationFileSystem>>;
}) => {
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
      automationFileSystem: options?.automationFileSystem,
    },
    {
      databaseAdapter: new InMemoryAdapter({
        idSeed: "automation-routes-bindings-test",
      }),
      dbRoundtripGuard: true,
      mountRoute: "/api/automations/bindings",
    },
    services,
  );
};

const readRecordId = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  const record = value as { externalId?: unknown; id?: unknown };
  if (typeof record.externalId === "string") {
    return record.externalId;
  }

  if (typeof record.id === "string") {
    return record.id;
  }

  return "";
};

describe("automation routes /bindings", () => {
  let fragment: ReturnType<typeof createAutomation>;

  beforeEach(async () => {
    fragment = createAutomation({
      automationFileSystem: await createDefaultAutomationFileSystem("org_123"),
    });
  });

  test("returns filesystem-backed starter bindings", async () => {
    const response = await fragment.callRoute("GET", "/bindings");

    expect(response.type).toBe("json");
    if (response.type === "json") {
      expect(response.data).toHaveLength(3);
      expect(response.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "telegram-claim-linking-start",
            source: "telegram",
            eventType: "message.received",
            scriptKey: "telegram-claim-linking.start",
            scriptPath: "scripts/telegram-claim-linking.start.sh",
          }),
          expect.objectContaining({
            id: "telegram-claim-linking-complete",
            source: "otp",
            eventType: "identity.claim.completed",
            scriptKey: "telegram-claim-linking.complete",
          }),
        ]),
      );
    }
  });

  test("returns empty identity bindings list initially", async () => {
    const response = await fragment.callRoute("GET", "/identity-bindings");

    expect(response.type).toBe("json");
    if (response.type === "json") {
      expect(response.data).toEqual([]);
    }
  });

  test("binds an identity actor and reuses the same record on rebind", async () => {
    const firstBindResponse = await fragment.callRoute("POST", "/identity-bindings/bind", {
      body: {
        source: "telegram",
        key: "chat-bind-1",
        value: "user-1",
      },
    });

    expect(firstBindResponse.type).toBe("json");
    if (firstBindResponse.type !== "json") {
      throw new Error("Expected first bind response");
    }

    const secondBindResponse = await fragment.callRoute("POST", "/identity-bindings/bind", {
      body: {
        source: "telegram",
        key: "chat-bind-1",
        value: "user-2",
      },
    });

    expect(secondBindResponse.type).toBe("json");
    if (secondBindResponse.type !== "json") {
      throw new Error("Expected second bind response");
    }

    expect(readRecordId(secondBindResponse.data.id)).toBe(readRecordId(firstBindResponse.data.id));
    expect(secondBindResponse.data).toMatchObject({
      source: "telegram",
      key: "chat-bind-1",
      value: "user-2",
      status: "linked",
    });

    const identityBindingsResponse = await fragment.callRoute("GET", "/identity-bindings");

    expect(identityBindingsResponse.type).toBe("json");
    if (identityBindingsResponse.type === "json") {
      expect(identityBindingsResponse.data).toHaveLength(1);
      expect(readRecordId(identityBindingsResponse.data[0]?.id)).toBe(
        readRecordId(firstBindResponse.data.id),
      );
      expect(identityBindingsResponse.data[0]).toMatchObject({
        source: "telegram",
        key: "chat-bind-1",
        value: "user-2",
        status: "linked",
      });
    }
  });

  test("retries duplicate insert errors from concurrent identity binds", async () => {
    const binding = {
      id: "binding-concurrent-1",
      source: "telegram",
      key: "chat-concurrent-1",
      value: "user-b",
      status: "linked",
      linkedAt: new Date("2026-01-01T00:00:00.000Z"),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    };

    const execute = vi
      .fn<() => Promise<typeof binding>>()
      .mockRejectedValueOnce({
        name: "UniqueConstraintError",
        message: "Unique constraint violation for key [telegram, chat-concurrent-1].",
      })
      .mockResolvedValueOnce(binding);

    const txBuilder = {
      retrieve: vi.fn(() => txBuilder),
      mutate: vi.fn(() => txBuilder),
      transform: vi.fn(() => txBuilder),
      execute,
    };
    const handlerTx = vi.fn(() => txBuilder);

    const result = await bindAutomationIdentityActor(
      {
        handlerTx,
      } as never,
      {
        source: "telegram",
        key: "chat-concurrent-1",
        value: "user-b",
      },
    );

    expect(result).toBe(binding);
    expect(handlerTx).toHaveBeenCalledTimes(2);
    expect(txBuilder.retrieve).toHaveBeenCalledTimes(2);
    expect(txBuilder.mutate).toHaveBeenCalledTimes(2);
    expect(txBuilder.transform).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  test("revokes an existing identity binding", async () => {
    const bindResponse = await fragment.callRoute("POST", "/identity-bindings/bind", {
      body: {
        source: "telegram",
        key: "chat-1",
        value: "user-1",
      },
    });

    expect(bindResponse.type).toBe("json");
    if (bindResponse.type !== "json") {
      throw new Error("Expected bind response");
    }

    const bindingId = readRecordId(bindResponse.data.id);

    const revokeResponse = await fragment.callRoute(
      "POST",
      "/identity-bindings/:bindingId/revoke",
      {
        pathParams: { bindingId },
      },
    );

    expect(revokeResponse.type).toBe("json");
    if (revokeResponse.type !== "json") {
      throw new Error("Expected revoke response");
    }

    expect(revokeResponse.data).toEqual({ ok: true, id: bindingId });

    const updatedIdentityBindingsResponse = await fragment.callRoute("GET", "/identity-bindings");

    expect(updatedIdentityBindingsResponse.type).toBe("json");
    if (updatedIdentityBindingsResponse.type === "json") {
      expect(updatedIdentityBindingsResponse.data).toHaveLength(1);
      const updatedBindingId = readRecordId(updatedIdentityBindingsResponse.data[0]?.id);

      expect(updatedBindingId).toBe(bindingId);
      expect(updatedIdentityBindingsResponse.data[0]).toMatchObject({
        status: "revoked",
      });
    }
  });

  test("lookup does not return revoked identity bindings", async () => {
    const bindResponse = await fragment.callRoute("POST", "/identity-bindings/bind", {
      body: {
        source: "telegram",
        key: "chat-revoked-lookup",
        value: "user-revoked",
      },
    });

    expect(bindResponse.type).toBe("json");
    if (bindResponse.type !== "json") {
      throw new Error("Expected bind response");
    }

    const bindingId = readRecordId(bindResponse.data.id);

    const revokeResponse = await fragment.callRoute(
      "POST",
      "/identity-bindings/:bindingId/revoke",
      {
        pathParams: { bindingId },
      },
    );

    expect(revokeResponse.type).toBe("json");
    if (revokeResponse.type !== "json") {
      throw new Error("Expected revoke response");
    }

    const lookupResponse = await fragment.callRoute("GET", "/identity-bindings/lookup", {
      query: {
        source: "telegram",
        key: "chat-revoked-lookup",
      },
    });

    expect(lookupResponse.type).toBe("error");
    if (lookupResponse.type === "error") {
      expect(lookupResponse.status).toBe(404);
      expect(lookupResponse.error.code).toBe("IDENTITY_BINDING_NOT_FOUND");
    }
  });

  test("returns an error when revoking a missing identity binding", async () => {
    const revokeResponse = await fragment.callRoute(
      "POST",
      "/identity-bindings/:bindingId/revoke",
      {
        pathParams: { bindingId: "missing-binding" },
      },
    );

    expect(revokeResponse.type).toBe("error");
    if (revokeResponse.type === "error") {
      expect(revokeResponse.status).toBe(404);
      expect(revokeResponse.error.message).toContain("missing-binding");
    }
  });
});
