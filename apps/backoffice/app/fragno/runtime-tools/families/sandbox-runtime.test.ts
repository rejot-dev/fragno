import { describe, expect, test, vi } from "vitest";

import type { SandboxManager } from "@/sandbox/contracts";

import { createSandboxRuntime } from "./sandbox-runtime";

const createManager = (): SandboxManager => ({
  listInstances: vi.fn(async () => [{ id: "dev", status: "running" as const }]),
  startInstance: vi.fn(async ({ id }) => ({ id, status: "running" as const })),
  killInstance: vi.fn(async () => undefined),
  getHandle: vi.fn(async () => ({
    id: "dev",
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
});

describe("createSandboxRuntime", () => {
  test("delegates list, start, kill, and exec to the sandbox manager", async () => {
    const manager = createManager();
    const runtime = createSandboxRuntime(manager);

    await expect(runtime.listSandboxes()).resolves.toEqual([{ id: "dev", status: "running" }]);
    await expect(runtime.startSandbox({ id: "dev" })).resolves.toEqual({
      id: "dev",
      status: "running",
    });
    await expect(runtime.killSandbox({ sandboxId: "dev" })).resolves.toEqual({
      sandboxId: "dev",
      killed: true,
    });
    await expect(runtime.executeCommand({ sandboxId: "dev", command: "pwd" })).resolves.toEqual({
      ok: true,
      stdout: "pwd",
      stderr: "",
      exitCode: 0,
    });

    expect(manager.listInstances).toHaveBeenCalledTimes(1);
    expect(manager.startInstance).toHaveBeenCalledWith({ id: "dev" });
    expect(manager.killInstance).toHaveBeenCalledWith("dev");
    expect(manager.getHandle).toHaveBeenCalledWith("dev");
  });

  test("returns sandbox_unavailable when execute cannot resolve a handle", async () => {
    const manager = createManager();
    vi.mocked(manager.getHandle).mockResolvedValueOnce(null);
    const runtime = createSandboxRuntime(manager);

    await expect(runtime.executeCommand({ sandboxId: "missing", command: "pwd" })).resolves.toEqual(
      {
        ok: false,
        reason: "sandbox_unavailable",
        message: 'Sandbox "missing" is unavailable.',
        retryable: true,
      },
    );
  });
});
