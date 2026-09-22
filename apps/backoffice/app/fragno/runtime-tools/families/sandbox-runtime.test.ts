import { describe, expect, test, vi } from "vitest";

import {
  CLOUDFLARE_SANDBOX_PROVIDER,
  type SandboxInstanceRecord,
} from "@/fragno/sandbox-manager/contracts";
import type { SandboxCommandResult } from "@/sandbox/contracts";

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

const createLifecycle = () => ({
  listSandboxInstances: vi.fn(async () => [makeRecord("dev", "running")]),
  getSandboxInstance: vi.fn(async () => makeRecord("dev", "running")),
  requestSandboxInstance: vi.fn(async ({ id }: { id: string }) => makeRecord(id, "requested")),
  requestSandboxInstanceStop: vi.fn(async () => makeRecord("dev", "stopping")),
  executeSandboxCommand: vi.fn(
    async ({ command }: { command: string }): Promise<SandboxCommandResult> => ({
      ok: true,
      stdout: command,
      stderr: "",
      exitCode: 0,
    }),
  ),
});

describe("createSandboxRuntime", () => {
  test("uses the manager for lifecycle operations and command execution", async () => {
    const lifecycle = createLifecycle();
    const runtime = createSandboxRuntime({ lifecycle });

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
      id: "dev",
      provider: CLOUDFLARE_SANDBOX_PROVIDER,
      keepAlive: undefined,
      sleepAfter: undefined,
      startupCommand: "true",
      startupTimeoutMs: undefined,
    });
    expect(lifecycle.requestSandboxInstanceStop).toHaveBeenCalledWith({
      id: "dev",
    });
    expect(lifecycle.executeSandboxCommand).toHaveBeenCalledWith({
      sandboxId: "dev",
      command: "pwd",
      timeoutMs: undefined,
    });
  });

  test("returns the manager command result", async () => {
    const lifecycle = createLifecycle();
    lifecycle.executeSandboxCommand.mockResolvedValueOnce({
      ok: false,
      reason: "sandbox_unavailable",
      message: 'Sandbox "missing" is unavailable.',
      retryable: true,
    });
    const runtime = createSandboxRuntime({ lifecycle });

    await expect(runtime.executeCommand({ sandboxId: "Missing", command: "pwd" })).resolves.toEqual(
      {
        ok: false,
        reason: "sandbox_unavailable",
        message: 'Sandbox "missing" is unavailable.',
        retryable: true,
      },
    );
    expect(lifecycle.executeSandboxCommand).toHaveBeenCalledWith({
      sandboxId: "missing",
      command: "pwd",
      timeoutMs: undefined,
    });
  });
});
