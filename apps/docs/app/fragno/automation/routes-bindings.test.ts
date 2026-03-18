import { beforeEach, describe, expect, test, vi } from "vitest";

import { InMemoryAdapter } from "@fragno-dev/db";
import { drainDurableHooks } from "@fragno-dev/test";

import type { AutomationWorkflowsService } from "./definition";
import { bindAutomationIdentityActor, createAutomationFragment } from "./index";

const createAutomation = () => {
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
    {},
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

const createScript = async (
  fragment: ReturnType<typeof createAutomation>,
  key = "welcome-script",
) => {
  const response = await fragment.callRoute("POST", "/scripts", {
    body: {
      key,
      name: "Welcome Message",
      engine: "bash",
      script: "echo hi",
      version: 1,
      enabled: true,
    },
  });

  expect(response.type).toBe("json");
  if (response.type !== "json") {
    throw new Error("Expected script creation response");
  }
  return response.data.id;
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

  beforeEach(() => {
    fragment = createAutomation();
  });

  test("returns empty list when no bindings exist", async () => {
    const response = await fragment.callRoute("GET", "/bindings");

    expect(response.type).toBe("json");
    if (response.type === "json") {
      expect(response.data).toEqual([]);
    }
  });

  test("returns empty identity bindings list initially", async () => {
    const response = await fragment.callRoute("GET", "/identity-bindings");

    expect(response.type).toBe("json");
    if (response.type === "json") {
      expect(response.data).toEqual([]);
    }
  });

  test("creates and reads a binding with source", async () => {
    const scriptId = await createScript(fragment, "binding-script");

    const bindingResponse = await fragment.callRoute("POST", "/bindings", {
      body: {
        eventType: "message.received",
        source: "any-source",
        scriptId,
        enabled: true,
      },
    });

    expect(bindingResponse.type).toBe("json");
    if (bindingResponse.type === "json") {
      expect(typeof bindingResponse.data.id).toBe("string");
    }

    const listResponse = await fragment.callRoute("GET", "/bindings", {
      query: {},
    });

    expect(listResponse.type).toBe("json");
    if (listResponse.type === "json") {
      expect(listResponse.data).toHaveLength(1);
      expect(listResponse.data[0]).toMatchObject({
        source: "any-source",
        eventType: "message.received",
      });
    }
  });

  test("returns an error when creating a binding for a missing script", async () => {
    const response = await fragment.callRoute("POST", "/bindings", {
      body: {
        eventType: "message.received",
        source: "telegram",
        scriptId: "missing-script",
        enabled: true,
      },
    } as never);

    expect(response.type).toBe("error");
    if (response.type === "error") {
      expect(response.status).toBe(404);
      expect(response.error.code).toBe("SCRIPT_NOT_FOUND");
      expect(response.error.message).toContain("missing-script");
    }
  });

  test("updates existing binding instead of creating duplicates", async () => {
    const scriptId = await createScript(fragment, "binding-script-v2");

    const firstBinding = await fragment.callRoute("POST", "/bindings", {
      body: {
        eventType: "message.received",
        source: "telegram",
        scriptId,
        enabled: true,
      },
    });
    expect(firstBinding.type).toBe("json");
    if (firstBinding.type !== "json") {
      throw new Error("Expected first binding creation response");
    }

    const secondBinding = await fragment.callRoute("POST", "/bindings", {
      body: {
        eventType: "message.received",
        source: "telegram",
        scriptId,
        enabled: false,
      },
    });
    expect(secondBinding.type).toBe("json");
    if (secondBinding.type !== "json") {
      throw new Error("Expected second binding update response");
    }

    expect(secondBinding.data.id).toBe(firstBinding.data.id);

    const listResponse = await fragment.callRoute("GET", "/bindings");

    expect(listResponse.type).toBe("json");
    if (listResponse.type === "json") {
      expect(listResponse.data).toHaveLength(1);
      expect(listResponse.data[0]).toMatchObject({
        eventType: "message.received",
        source: "telegram",
        enabled: false,
      });
    }
  });

  test("binds an identity actor and reuses the same record on rebind", async () => {
    const firstBindResponse = await fragment.callRoute("POST", "/identity-bindings/bind", {
      body: {
        source: "telegram",
        externalActorId: "chat-bind-1",
        userId: "user-1",
      },
    });

    expect(firstBindResponse.type).toBe("json");
    if (firstBindResponse.type !== "json") {
      throw new Error("Expected first bind response");
    }

    const secondBindResponse = await fragment.callRoute("POST", "/identity-bindings/bind", {
      body: {
        source: "telegram",
        externalActorId: "chat-bind-1",
        userId: "user-2",
      },
    });

    expect(secondBindResponse.type).toBe("json");
    if (secondBindResponse.type !== "json") {
      throw new Error("Expected second bind response");
    }

    expect(readRecordId(secondBindResponse.data.id)).toBe(readRecordId(firstBindResponse.data.id));
    expect(secondBindResponse.data).toMatchObject({
      source: "telegram",
      externalActorId: "chat-bind-1",
      userId: "user-2",
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
        externalActorId: "chat-bind-1",
        userId: "user-2",
        status: "linked",
      });
    }
  });

  test("retries duplicate insert errors from concurrent identity binds", async () => {
    const binding = {
      id: "binding-concurrent-1",
      source: "telegram",
      externalActorId: "chat-concurrent-1",
      userId: "user-b",
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
        externalActorId: "chat-concurrent-1",
        userId: "user-b",
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
    const linkingScript = await fragment.callRoute("POST", "/scripts", {
      body: {
        key: "identity-bind-script",
        name: "Identity Bind Script",
        engine: "bash",
        script:
          'automations.identity.bind-actor --source "$AUTOMATION_SOURCE" --external-actor-id "$AUTOMATION_EXTERNAL_ACTOR_ID" --user-id "$AUTOMATION_SUBJECT_USER_ID" >/dev/null',
        version: 1,
        enabled: true,
      },
    });

    expect(linkingScript.type).toBe("json");
    if (linkingScript.type !== "json") {
      throw new Error("Expected identity bind script creation response");
    }

    await fragment.callRoute("POST", "/bindings", {
      body: {
        eventType: "message.received",
        source: "telegram",
        scriptId: linkingScript.data.id,
        enabled: true,
      },
    });

    await fragment.callServices(() =>
      fragment.services.ingestEvent({
        id: "event-bind-1",
        source: "telegram",
        eventType: "message.received",
        occurredAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
        payload: {},
        actor: {
          type: "external",
          externalId: "chat-1",
        },
        subject: {
          userId: "user-1",
        },
      }),
    );
    await drainDurableHooks(fragment);

    const identityBindingsResponse = await fragment.callRoute("GET", "/identity-bindings");

    expect(identityBindingsResponse.type).toBe("json");
    if (identityBindingsResponse.type !== "json") {
      throw new Error("Expected identity bindings response");
    }

    expect(identityBindingsResponse.data).toHaveLength(1);
    const bindingId = readRecordId(identityBindingsResponse.data[0]?.id);
    expect(identityBindingsResponse.data[0]).toMatchObject({
      source: "telegram",
      externalActorId: "chat-1",
      userId: "user-1",
      status: "linked",
    });

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
        externalActorId: "chat-revoked-lookup",
        userId: "user-revoked",
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
        externalActorId: "chat-revoked-lookup",
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
