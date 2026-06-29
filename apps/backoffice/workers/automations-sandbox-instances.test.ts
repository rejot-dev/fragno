import { afterEach, describe, expect, test, vi, assert } from "vitest";

import { getSandbox } from "@cloudflare/sandbox";

import {
  createInMemoryBackofficeRuntime,
  type InMemoryBackofficeRuntime,
} from "@/backoffice-runtime/in-memory-runtime";
import { CLOUDFLARE_SANDBOX_PROVIDER } from "@/fragno/automation";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => {
  class MockDurableObject {
    constructor(_state: unknown, _env: unknown) {}
  }

  class MockRpcTarget {}
  class MockWorkerEntrypoint {}

  return {
    DurableObject: MockDurableObject,
    RpcTarget: MockRpcTarget,
    WorkerEntrypoint: MockWorkerEntrypoint,
  };
});

vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));
vi.mock("@cloudflare/sandbox", () => ({ getSandbox: vi.fn() }));

let runtime: InMemoryBackofficeRuntime | null = null;

afterEach(async () => {
  await runtime?.cleanup();
  runtime = null;
  vi.clearAllMocks();
});

describe("Automations sandbox instance object methods", () => {
  test("persist requested sandbox instances through org-scoped Automations objects", async () => {
    runtime = await createInMemoryBackofficeRuntime();
    const automations = runtime.objects.automations.forOrg("org_123");

    const created = await automations.requestSandboxInstance({
      id: "org_123::dev",
      provider: CLOUDFLARE_SANDBOX_PROVIDER,
    });
    const listed = await automations.listSandboxInstances({
      provider: CLOUDFLARE_SANDBOX_PROVIDER,
    });
    const found = await automations.getSandboxInstance({ id: "org_123::dev" });

    expect(created).toMatchObject({
      id: "org_123::dev",
      provider: CLOUDFLARE_SANDBOX_PROVIDER,
      status: "requested",
    });
    expect(listed.map((instance) => instance.id)).toEqual(["org_123::dev"]);
    expect(found).toMatchObject({
      id: "org_123::dev",
      provider: CLOUDFLARE_SANDBOX_PROVIDER,
      status: "requested",
    });
  });

  test("stops physical sandboxes when lifecycle workflows terminate", async () => {
    const rawHandle = {
      exec: vi.fn(async () => ({ success: true, stdout: "ready", stderr: "", exitCode: 0 })),
      destroy: vi.fn(async () => undefined),
      mountBucket: vi.fn(async () => undefined),
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn(async () => undefined),
      exists: vi.fn(async () => ({ exists: true })),
      getRuntimeStatus: vi.fn(async () => ({ status: "running" as const })),
    };
    vi.mocked(getSandbox).mockResolvedValue(rawHandle as never);

    runtime = await createInMemoryBackofficeRuntime({ env: { SANDBOX: {} } as never });
    const automations = runtime.objects.automations.forOrg("org_123");

    const created = await automations.requestSandboxInstance({
      id: "org_123::dev",
      provider: CLOUDFLARE_SANDBOX_PROVIDER,
      keepAlive: true,
    });
    await runtime.drain();

    const terminateResponse = await automations.fetch(
      new Request(
        `http://fragno.test/api/automations-workflows/sandbox-lifecycle/instances/${created.workflowInstanceId}/terminate`,
        { method: "POST" },
      ),
    );
    assert(terminateResponse.status === 200);
    await runtime.drain();

    await expect(automations.getSandboxInstance({ id: "org_123::dev" })).resolves.toMatchObject({
      status: "stopped",
    });
    expect(rawHandle.destroy).toHaveBeenCalledTimes(1);
  });

  test("returns active sandbox instance requests idempotently", async () => {
    runtime = await createInMemoryBackofficeRuntime();
    const automations = runtime.objects.automations.forOrg("org_123");

    const first = await automations.requestSandboxInstance({
      id: "org_123::dev",
      provider: CLOUDFLARE_SANDBOX_PROVIDER,
      startupCommand: "echo first",
    });
    const second = await automations.requestSandboxInstance({
      id: "org_123::dev",
      provider: CLOUDFLARE_SANDBOX_PROVIDER,
      startupCommand: "echo ignored",
    });

    expect(second).toMatchObject({
      id: first.id,
      provider: first.provider,
      status: first.status,
      workflowInstanceId: first.workflowInstanceId,
      startupCommand: "echo first",
    });
  });
});
