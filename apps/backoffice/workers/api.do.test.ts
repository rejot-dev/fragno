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
