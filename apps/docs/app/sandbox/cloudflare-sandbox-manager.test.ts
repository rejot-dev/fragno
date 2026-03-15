import { describe, expect, test, vi } from "vitest";

import { createCloudflareSandboxManager } from "./cloudflare-sandbox-manager";
import type { SandboxInstanceStatus, SandboxInstanceSummary } from "./contracts";

type RegistryClient = Parameters<typeof createCloudflareSandboxManager>[0]["registry"];
type RegistryMock = RegistryClient & {
  getInstances: ReturnType<typeof vi.fn>;
  getInstance: ReturnType<typeof vi.fn>;
  trackInstance: ReturnType<typeof vi.fn>;
  untrackInstance: ReturnType<typeof vi.fn>;
};

function makeInstance(id: string, status: SandboxInstanceStatus): SandboxInstanceSummary {
  return {
    id,
    status,
  };
}

function createRegistryMock(overrides: Partial<RegistryClient> = {}): RegistryMock {
  const trackedIds = new Set<string>();

  const registry: RegistryMock = {
    getInstances: vi
      .fn()
      .mockImplementation(async () => Array.from(trackedIds, (id) => makeInstance(id, "running"))),
    getInstance: vi
      .fn()
      .mockImplementation(async (id: string) =>
        trackedIds.has(id) ? makeInstance(id, "running") : null,
      ),
    trackInstance: vi.fn().mockImplementation(async (id: string) => {
      trackedIds.add(id);
    }),
    untrackInstance: vi.fn().mockImplementation(async (id: string) => {
      trackedIds.delete(id);
    }),
  };

  Object.assign(registry, overrides);
  return registry;
}

function createSandboxMock() {
  return {
    exec: vi.fn(),
    destroy: vi.fn().mockResolvedValue(undefined),
  };
}

function createManager(
  registry: RegistryClient,
  sandbox: ReturnType<typeof createSandboxMock>,
  options?: { sandboxIdScope?: string },
) {
  const getSandboxMock = vi.fn().mockReturnValue(sandbox);
  const manager = createCloudflareSandboxManager({
    sandboxNamespace: {} as never,
    sandboxIdScope: options?.sandboxIdScope,
    registry,
    sdk: {
      getSandbox: getSandboxMock as never,
    },
  });

  return { manager, getSandboxMock };
}

describe("createCloudflareSandboxManager", () => {
  test("starts a sandbox and tracks it", async () => {
    const registry = createRegistryMock({
      getInstance: vi.fn().mockImplementation(async (id: string) => makeInstance(id, "running")),
    });
    const sandbox = createSandboxMock();
    sandbox.exec.mockResolvedValue({
      success: true,
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
    const { manager } = createManager(registry, sandbox);

    const started = await manager.startInstance({ id: "cf-demo" });

    expect(started.id).toBe("cf-demo");
    expect(started.status).toBe("running");
    expect(registry.trackInstance).toHaveBeenCalledWith("cf-demo");
  });

  test("normalizes and scopes sandbox ids per organization", async () => {
    const registry = createRegistryMock({
      getInstance: vi.fn().mockImplementation(async (id: string) => makeInstance(id, "running")),
    });
    const sandbox = createSandboxMock();
    sandbox.exec.mockResolvedValue({
      success: true,
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
    const { manager, getSandboxMock } = createManager(registry, sandbox, {
      sandboxIdScope: "org_123",
    });

    const started = await manager.startInstance({ id: "CF-Demo" });

    expect(started.id).toBe("cf-demo");
    expect(getSandboxMock).toHaveBeenCalledWith(
      expect.anything(),
      "org_123::cf-demo",
      expect.anything(),
    );
    expect(registry.trackInstance).toHaveBeenCalledWith("org_123::cf-demo");
  });

  test("normalizes sandbox id for getHandle and kill operations", async () => {
    const registry = createRegistryMock({
      getInstance: vi.fn().mockResolvedValue(makeInstance("org_123::cf-demo", "running")),
    });
    const sandbox = createSandboxMock();
    const { manager } = createManager(registry, sandbox, {
      sandboxIdScope: "org_123",
    });

    const handle = await manager.getHandle("CF-Demo");
    await manager.killInstance("CF-Demo");

    expect(handle?.id).toBe("cf-demo");
    expect(registry.getInstance).toHaveBeenCalledWith("org_123::cf-demo");
    expect(registry.untrackInstance).toHaveBeenCalledWith("org_123::cf-demo");
  });

  test("filters and unwraps scoped ids in listInstances", async () => {
    const registry = createRegistryMock({
      getInstances: vi
        .fn()
        .mockResolvedValue([
          makeInstance("org_123::one", "running"),
          makeInstance("org_999::other", "running"),
        ]),
    });
    const sandbox = createSandboxMock();
    const { manager } = createManager(registry, sandbox, { sandboxIdScope: "org_123" });

    const instances = await manager.listInstances();

    expect(instances).toEqual([makeInstance("one", "running")]);
  });

  test("rejects invalid sleepAfter values before provisioning", async () => {
    const registry = createRegistryMock();
    const sandbox = createSandboxMock();
    const { manager, getSandboxMock } = createManager(registry, sandbox);

    await expect(manager.startInstance({ id: "cf-demo", sleepAfter: "adsfafds" })).rejects.toThrow(
      'Invalid "sleep after" value',
    );

    expect(getSandboxMock).not.toHaveBeenCalled();
    expect(sandbox.exec).not.toHaveBeenCalled();
    expect(registry.trackInstance).not.toHaveBeenCalled();
  });

  test("returns null handle for unknown sandbox id", async () => {
    const registry = createRegistryMock({
      getInstance: vi.fn().mockResolvedValue(null),
    });
    const sandbox = createSandboxMock();
    const { manager } = createManager(registry, sandbox);

    const handle = await manager.getHandle("missing-sandbox");

    expect(handle).toBeNull();
  });

  test("untracks sandbox on kill", async () => {
    const registry = createRegistryMock();
    const sandbox = createSandboxMock();
    const { manager } = createManager(registry, sandbox);

    await manager.killInstance("cf-kill");

    expect(sandbox.destroy).toHaveBeenCalledTimes(1);
    expect(registry.untrackInstance).toHaveBeenCalledWith("cf-kill");
  });

  test("does not untrack sandbox when kill fails with sandbox_unavailable", async () => {
    const registry = createRegistryMock();
    const sandbox = createSandboxMock();
    sandbox.destroy.mockRejectedValue(new Error("network error"));
    const { manager } = createManager(registry, sandbox);

    await manager.killInstance("cf-kill");

    expect(registry.untrackInstance).not.toHaveBeenCalled();
  });

  test("untracks sandbox when kill reports sandbox already terminated", async () => {
    const registry = createRegistryMock();
    const sandbox = createSandboxMock();
    sandbox.destroy.mockRejectedValue(new Error("sandbox destroyed"));
    const { manager } = createManager(registry, sandbox);

    await manager.killInstance("cf-kill");

    expect(registry.untrackInstance).toHaveBeenCalledWith("cf-kill");
  });

  test("destroys provisioned sandbox when startup command fails", async () => {
    const registry = createRegistryMock();
    const sandbox = createSandboxMock();
    sandbox.exec.mockResolvedValue({
      success: false,
      stdout: "",
      stderr: "startup failed",
      exitCode: 1,
    });
    const { manager } = createManager(registry, sandbox);

    await expect(manager.startInstance({ id: "cf-start-fail" })).rejects.toThrow(
      'Sandbox "cf-start-fail" failed startup command',
    );

    expect(sandbox.destroy).toHaveBeenCalledTimes(1);
    expect(registry.trackInstance).not.toHaveBeenCalled();
    expect(registry.untrackInstance).not.toHaveBeenCalled();
  });

  test("destroys and untracks sandbox when tracking readback fails", async () => {
    const registry = createRegistryMock({
      getInstance: vi.fn().mockResolvedValue(null),
    });
    const sandbox = createSandboxMock();
    sandbox.exec.mockResolvedValue({
      success: true,
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
    const { manager } = createManager(registry, sandbox);

    await expect(manager.startInstance({ id: "cf-track-fail" })).rejects.toThrow(
      'Sandbox "cf-track-fail" started but could not be tracked',
    );

    expect(sandbox.destroy).toHaveBeenCalledTimes(1);
    expect(registry.trackInstance).toHaveBeenCalledWith("cf-track-fail");
    expect(registry.untrackInstance).toHaveBeenCalledWith("cf-track-fail");
  });

  test("returns sandbox_terminated when sandbox dies during command execution", async () => {
    const registry = createRegistryMock({
      getInstance: vi.fn().mockResolvedValue(makeInstance("cf-dead", "running")),
    });
    const sandbox = createSandboxMock();
    sandbox.exec.mockRejectedValue(new Error("container exited unexpectedly"));
    const { manager } = createManager(registry, sandbox);

    const handle = await manager.getHandle("cf-dead");
    const result = await handle!.executeCommand("npm test");

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected command failure result");
    }
    expect(result.reason).toBe("sandbox_terminated");
    expect(result.retryable).toBe(true);
  });

  test("surfaces command_failed for non-zero command exit", async () => {
    const registry = createRegistryMock({
      getInstance: vi.fn().mockResolvedValue(makeInstance("cf-fail", "running")),
    });
    const sandbox = createSandboxMock();
    sandbox.exec.mockResolvedValue({
      success: false,
      stdout: "",
      stderr: "missing build script",
      exitCode: 1,
    });
    const { manager } = createManager(registry, sandbox);

    const handle = await manager.getHandle("cf-fail");
    const result = await handle!.executeCommand("npm run build");

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected command failure result");
    }
    expect(result.reason).toBe("command_failed");
    expect(result.retryable).toBe(false);
  });

  test("handles undefined thrown values during command execution", async () => {
    const registry = createRegistryMock({
      getInstance: vi.fn().mockResolvedValue(makeInstance("cf-undefined", "running")),
    });
    const sandbox = createSandboxMock();
    sandbox.exec.mockRejectedValue(undefined);
    const { manager } = createManager(registry, sandbox);

    const handle = await manager.getHandle("cf-undefined");
    const result = await handle!.executeCommand("echo hi");

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected command failure result");
    }
    expect(result.reason).toBe("internal_error");
    expect(result.message).toBe("Unknown sandbox execution error.");
  });
});
