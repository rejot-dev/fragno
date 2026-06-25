import { describe, expect, test, vi } from "vitest";

import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import { CLOUDFLARE_SANDBOX_PROVIDER } from "@/fragno/automation";

import { createSandboxRouteRuntime } from "./sandbox-route-runtime";

describe("createSandboxRouteRuntime", () => {
  test("requests sandbox lifecycle startup through org-scoped Automations", async () => {
    const automations = {
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
    };
    const sandbox = {
      configure: vi.fn(async () => undefined),
      exec: vi.fn(async () => ({ success: true, stdout: "", stderr: "", exitCode: 0 })),
      destroy: vi.fn(async () => undefined),
      getRuntimeStatus: vi.fn(async () => ({ status: "running" as const })),
    };
    const runtime = createSandboxRouteRuntime({
      objects: {
        automations: { forOrg: vi.fn(() => automations) },
        sandbox: { forName: vi.fn(() => sandbox) },
      } as unknown as BackofficeObjectRegistry,
      orgId: " org-1 ",
    });

    await expect(
      runtime.startSandbox({ id: "Dev", keepAlive: true, sleepAfter: "15m" }),
    ).resolves.toEqual({ id: "dev", status: "requested" });
    expect(sandbox.configure).not.toHaveBeenCalled();
    expect(sandbox.exec).not.toHaveBeenCalled();
    expect(automations.requestSandboxInstance).toHaveBeenCalledWith({
      id: "org-1::dev",
      provider: CLOUDFLARE_SANDBOX_PROVIDER,
      keepAlive: true,
      sleepAfter: "15m",
      startupCommand: "true",
      startupTimeoutMs: undefined,
      ownerScope: { kind: "org", orgId: "org-1" },
    });
  });
});
