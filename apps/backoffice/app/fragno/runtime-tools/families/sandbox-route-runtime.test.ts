import { describe, expect, test, vi } from "vitest";

import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import { CLOUDFLARE_SANDBOX_PROVIDER } from "@/fragno/sandbox-manager/contracts";

import { createSandboxRouteRuntime } from "./sandbox-route-runtime";

describe("createSandboxRouteRuntime", () => {
  test("requests sandbox lifecycle startup through org-scoped sandbox manager", async () => {
    const sandboxManager = {
      listSandboxInstances: vi.fn(async () => []),
      getSandboxInstance: vi.fn(async () => null),
      requestSandboxInstance: vi.fn(async ({ id, provider }) => ({
        id,
        provider,
        status: "requested" as const,
        workflowInstanceId: "workflow-1",
        keepAlive: true,
        sleepAfter: "15m",
        startupCommand: "true",
        startupTimeoutMs: 15_000,
        startedAt: null,
        expectedStopAt: null,
        stoppedAt: null,
        lastError: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
      requestSandboxInstanceStop: vi.fn(async () => null),
      executeSandboxCommand: vi.fn(async () => ({
        ok: true as const,
        stdout: "sandbox-ok\n",
        stderr: "",
        exitCode: 0,
      })),
    };
    const runtime = createSandboxRouteRuntime({
      objects: {
        sandboxManager: { forOrg: vi.fn(() => ({ commands: sandboxManager })) },
      } as unknown as BackofficeObjectRegistry,
      orgId: " org-1 ",
    });

    await expect(
      runtime.startSandbox({ id: "Dev", keepAlive: true, sleepAfter: "15m" }),
    ).resolves.toEqual({ id: "dev", status: "requested" });
    expect(sandboxManager.requestSandboxInstance).toHaveBeenCalledWith({
      id: "dev",
      provider: CLOUDFLARE_SANDBOX_PROVIDER,
      keepAlive: true,
      sleepAfter: "15m",
      startupCommand: "true",
      startupTimeoutMs: undefined,
    });

    await expect(
      runtime.executeCommand({ sandboxId: "Dev", command: "echo sandbox-ok" }),
    ).resolves.toEqual({
      ok: true,
      stdout: "sandbox-ok\n",
      stderr: "",
      exitCode: 0,
    });
    expect(sandboxManager.executeSandboxCommand).toHaveBeenCalledWith({
      sandboxId: "dev",
      command: "echo sandbox-ok",
      timeoutMs: undefined,
    });
  });
});
