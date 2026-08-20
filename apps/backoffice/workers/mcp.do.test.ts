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

const runtimes: Array<Awaited<ReturnType<typeof createInMemoryBackofficeRuntime>>> = [];

async function createRuntime() {
  const runtime = await createInMemoryBackofficeRuntime();
  runtimes.push(runtime);
  return runtime;
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(async (runtime) => await runtime.cleanup()));
});

describe("MCP system capability", () => {
  test("initializes for its object scope without capability configuration", async () => {
    const runtime = await createRuntime();
    const mcp = runtime.objects.mcp.forOrg("org-1");

    await expect(mcp.getPublicBaseUrl()).resolves.toContain("org-1");

    const response = await mcp.fetch(new Request("https://mcp.do/api/mcp/servers"));
    assert(response.ok);
    await expect(response.json()).resolves.toEqual({ servers: [] });
  });
});
