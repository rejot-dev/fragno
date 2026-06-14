import { describe, expect, test, vi } from "vitest";

import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";

import { createSandboxRouteRuntime } from "./sandbox-route-runtime";

describe("createSandboxRouteRuntime", () => {
  test("applies route sandbox configuration before starting a sandbox", async () => {
    const registry = {
      getInstances: vi.fn(async () => []),
      getInstance: vi.fn(async () => ({ id: "org-1::dev", status: "running" as const })),
      trackInstance: vi.fn(async () => undefined),
      untrackInstance: vi.fn(async () => undefined),
    };
    const sandbox = {
      configure: vi.fn(async () => undefined),
      exec: vi.fn(async () => ({ success: true, stdout: "", stderr: "", exitCode: 0 })),
      destroy: vi.fn(async () => undefined),
    };
    const runtime = createSandboxRouteRuntime({
      objects: {
        sandbox: { forName: vi.fn(() => sandbox) },
        sandboxRegistry: { forOrg: vi.fn(() => registry) },
      } as unknown as BackofficeObjectRegistry,
      orgId: " org-1 ",
    });

    await expect(
      runtime.startSandbox({ id: "Dev", keepAlive: true, sleepAfter: "15m" }),
    ).resolves.toEqual({ id: "dev", status: "running" });
    expect(sandbox.configure).toHaveBeenCalledWith({
      sandboxName: { name: "org-1::dev" },
      keepAlive: true,
      sleepAfter: "15m",
    });
    expect(sandbox.exec).toHaveBeenCalledWith("true", { timeout: 15_000 });
  });
});
