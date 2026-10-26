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

import { McpObject } from "./mcp-object";

const localObjects = {
  MCP: (input) => new McpObject(input),
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

describe("MCP system capability", () => {
  test("initializes for its object scope without capability configuration", async () => {
    const runtime = await createRuntime();
    const mcp = runtime.objects.mcp.for({ kind: "org", orgId: "org-1", jurisdiction: null });

    const response = await mcp.http.fetchAuthorized(new Request("https://mcp.do/api/mcp/servers"), {
      execution: createBackofficeSystemExecution({
        kind: "org",
        orgId: "org-1",
        jurisdiction: null,
      }),
    });
    assert(response.ok);
    await expect(response.json()).resolves.toEqual({ servers: [] });
  });
});
