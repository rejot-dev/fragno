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

import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";
import { createInMemoryBackofficeRuntime } from "@/backoffice-runtime/in-memory-runtime";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import { createBackofficeCapabilitiesRuntime } from "@/fragno/runtime-tools/families/backoffice-capabilities";

import { ApiObject } from "./api-object";
import { AutomationsObject } from "./automations-object";

const localObjects = {
  API: (input) => new ApiObject(input),
  AUTOMATIONS: (input) => new AutomationsObject(input),
} satisfies LocalBackofficeObjects;

const runtimes: Array<Awaited<ReturnType<typeof createInMemoryBackofficeRuntime>>> = [];

async function createRuntime() {
  const runtime = await createInMemoryBackofficeRuntime({ objects: localObjects });
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

    const response = await api.http.fetchAuthorized(
      new Request("https://api.do/api/api/connections"),
      {
        execution: createBackofficeSystemExecution({ kind: "org", orgId: "org-1" }),
      },
    );
    assert(response.ok);
    await expect(response.json()).resolves.toEqual({ connections: [], cursor: null });
  });

  test("does not advertise API or MCP in system scope", async () => {
    const runtime = await createRuntime();
    const backoffice = createBackofficeCapabilitiesRuntime({
      objects: runtime.objects,
      config: runtime.config,
      scope: { kind: "system" },
    });

    const hookScopes = await backoffice.listHookScopes();
    expect(hookScopes.map(({ id }) => id)).not.toContain("api");
    expect(hookScopes.map(({ id }) => id)).not.toContain("mcp");
  });
});
