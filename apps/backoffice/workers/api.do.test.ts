import { afterEach, assert, describe, expect, test, vi } from "vitest";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => {
  class MockDurableObject {
    constructor(_state: unknown, _env: unknown) {}
  }

  return {
    DurableObject: MockDurableObject,
    RpcTarget: class {},
    WorkerEntrypoint: class {},
  };
});

vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import { createInMemoryBackofficeRuntime } from "@/backoffice-runtime/in-memory-runtime";
import { createBackofficeCapabilitiesRuntime } from "@/fragno/runtime-tools/families/backoffice-capabilities";

const runtimes: Array<Awaited<ReturnType<typeof createInMemoryBackofficeRuntime>>> = [];

async function createRuntime() {
  const runtime = await createInMemoryBackofficeRuntime();
  runtimes.push(runtime);
  return runtime;
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(async (runtime) => await runtime.cleanup()));
});

describe("API system capability", () => {
  test("initializes for its object scope without capability configuration", async () => {
    const runtime = await createRuntime();
    const api = runtime.objects.api.forOrg("org-1");

    await expect(api.getPublicBaseUrl()).resolves.toContain("org-1");

    const response = await api.fetch(new Request("https://api.do/api/api/connections"));
    assert(response.ok);
    await expect(response.json()).resolves.toEqual({ connections: [] });
  });

  test("creates an automation event source for a new webhook endpoint", async () => {
    const runtime = await createRuntime();
    const scope = { kind: "org" as const, orgId: "org-1" };
    const api = runtime.objects.api.for(scope);

    const response = await api.fetch(
      new Request("https://api.do/api/api/webhooks/endpoints/slack", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Slack",
          status: "active",
          verification: { type: "none" },
          deliveryIdentity: { type: "header", name: "x-slack-event-id" },
          auth: { type: "none" },
        }),
      }),
    );
    assert.equal(response.status, 201);

    await api.alarm?.();
    await runtime.drainWaitUntil();

    const automations = runtime.objects.automations.for(scope);
    await expect(automations.listEventSources()).resolves.toEqual([
      expect.objectContaining({
        source: "slack",
        label: "Slack",
        description: "Slack webhook events received through the API.",
        category: "custom",
      }),
    ]);

    const eventsResponse = await automations.fetch(
      new Request("https://automations.test/api/automations/events?limit=10"),
    );
    assert.equal(eventsResponse.status, 200);
    await expect(eventsResponse.json()).resolves.toMatchObject({
      events: [
        {
          source: "api",
          eventType: "webhook_endpoint.created",
          payload: {
            endpointId: "slack",
            name: "Slack",
            status: "active",
            authConfig: { type: "none" },
            verification: { type: "none" },
            deliveryIdentity: { type: "header", name: "x-slack-event-id" },
            secretRefs: [],
          },
          subject: expect.objectContaining({ endpointId: "slack", orgId: "org-1" }),
        },
      ],
    });
  });

  test("does not advertise API or MCP in system scope", async () => {
    const runtime = await createRuntime();
    const capabilities = createBackofficeCapabilitiesRuntime({
      objects: runtime.objects,
      config: runtime.config,
      scope: { kind: "system" },
    });

    const listed = await capabilities.listCapabilities();
    expect(listed.find(({ id }) => id === "api")).toMatchObject({ available: false });
    expect(listed.find(({ id }) => id === "mcp")).toMatchObject({ available: false });

    const hookScopes = await capabilities.listHookScopes();
    expect(hookScopes.map(({ id }) => id)).not.toContain("api");
    expect(hookScopes.map(({ id }) => id)).not.toContain("mcp");
  });
});
