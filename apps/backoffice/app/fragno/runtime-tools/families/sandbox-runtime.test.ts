import { describe, expect, test, vi } from "vitest";

import { CLOUDFLARE_SANDBOX_PROVIDER, type SandboxInstanceRecord } from "@/fragno/automation";
import type { SandboxRuntimeProvider } from "@/sandbox/contracts";

import { createSandboxRuntime } from "./sandbox-runtime";

const makeRecord = (
  id: string,
  status: SandboxInstanceRecord["status"],
): SandboxInstanceRecord => ({
  id,
  provider: CLOUDFLARE_SANDBOX_PROVIDER,
  status,
  workflowInstanceId: `workflow-${id}`,
  keepAlive: false,
  sleepAfter: null,
  startupCommand: "true",
  startupTimeoutMs: 15_000,
  startedAt: status === "running" ? new Date("2024-01-01T00:00:00.000Z") : null,
  expectedStopAt: null,
  stoppedAt: status === "stopped" ? new Date("2024-01-01T00:00:00.000Z") : null,
  lastError: null,
  createdAt: new Date("2024-01-01T00:00:00.000Z"),
  updatedAt: new Date("2024-01-01T00:00:00.000Z"),
});

const createProvider = (): SandboxRuntimeProvider => ({
  provider: CLOUDFLARE_SANDBOX_PROVIDER,
  getHandle: vi.fn(async (id: string) => ({
    id,
    exec: vi.fn(),
    destroy: vi.fn(async () => undefined),
    getRuntimeStatus: vi.fn(async () => ({ status: "running" as const })),
    executeCommand: vi.fn(async (command) => ({
      ok: true as const,
      stdout: command,
      stderr: "",
      exitCode: 0,
    })),
    mountBucket: vi.fn(async () => undefined),
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
    exists: vi.fn(async () => ({ exists: true })),
  })),
  getStatus: vi.fn(async () => "running" as const),
});

const createLifecycle = () => ({
  listSandboxInstances: vi.fn(async () => [makeRecord("org-1::dev", "running")]),
  getSandboxInstance: vi.fn(async () => makeRecord("org-1::dev", "running")),
  requestSandboxInstance: vi.fn(async ({ id }: { id: string }) => makeRecord(id, "requested")),
  requestSandboxInstanceStop: vi.fn(async () => makeRecord("org-1::dev", "stopping")),
});

describe("createSandboxRuntime", () => {
  test("uses automations for lifecycle operations and provider for command execution", async () => {
    const provider = createProvider();
    const lifecycle = createLifecycle();
    const runtime = createSandboxRuntime({
      lifecycle,
      provider,
      sandboxIdScope: "org-1",
      ownerScope: { kind: "org", orgId: "org-1" },
    });

    await expect(runtime.listSandboxes()).resolves.toEqual([{ id: "dev", status: "running" }]);
    await expect(runtime.startSandbox({ id: "Dev" })).resolves.toEqual({
      id: "dev",
      status: "requested",
    });
    await expect(runtime.killSandbox({ sandboxId: "Dev" })).resolves.toEqual({
      sandboxId: "dev",
      killed: true,
    });
    await expect(runtime.executeCommand({ sandboxId: "Dev", command: "pwd" })).resolves.toEqual({
      ok: true,
      stdout: "pwd",
      stderr: "",
      exitCode: 0,
    });

    expect(lifecycle.listSandboxInstances).toHaveBeenCalledWith({
      provider: CLOUDFLARE_SANDBOX_PROVIDER,
    });
    expect(lifecycle.requestSandboxInstance).toHaveBeenCalledWith({
      id: "org-1::dev",
      provider: CLOUDFLARE_SANDBOX_PROVIDER,
      keepAlive: undefined,
      sleepAfter: undefined,
      startupCommand: "true",
      startupTimeoutMs: undefined,
      ownerScope: { kind: "org", orgId: "org-1" },
    });
    expect(lifecycle.requestSandboxInstanceStop).toHaveBeenCalledWith({
      id: "org-1::dev",
      ownerScope: { kind: "org", orgId: "org-1" },
    });
    expect(lifecycle.getSandboxInstance).toHaveBeenCalledWith({ id: "org-1::dev" });
    expect(provider.getHandle).toHaveBeenCalledWith("org-1::dev");
  });

  test("returns sandbox_unavailable when the lifecycle record is not running", async () => {
    const provider = createProvider();
    const lifecycle = createLifecycle();
    lifecycle.getSandboxInstance.mockResolvedValueOnce(makeRecord("org-1::missing", "starting"));
    const runtime = createSandboxRuntime({ lifecycle, provider, sandboxIdScope: "org-1" });

    await expect(runtime.executeCommand({ sandboxId: "missing", command: "pwd" })).resolves.toEqual(
      {
        ok: false,
        reason: "sandbox_unavailable",
        message: 'Sandbox "missing" is unavailable.',
        retryable: true,
      },
    );
    expect(provider.getHandle).not.toHaveBeenCalled();
  });
});
