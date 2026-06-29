import { describe, expect, test, vi, assert } from "vitest";

import { createCloudflareSandboxProvider } from "./cloudflare-sandbox-provider";
import { CLOUDFLARE_SANDBOX_PROVIDER } from "./contracts";

const createCloudflareRuntimeHandleMock = () => ({
  exec: vi.fn(),
  destroy: vi.fn(async () => undefined),
  mountBucket: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined),
  exists: vi.fn(async () => ({ exists: false })),
  getRuntimeStatus: vi.fn(async () => ({ status: "running" as const })),
});

describe("createCloudflareSandboxProvider", () => {
  test("adapts the Cloudflare SDK behind the sandbox runtime provider interface", async () => {
    const sandbox = createCloudflareRuntimeHandleMock();
    const getSandbox = vi.fn(async () => sandbox);
    const provider = createCloudflareSandboxProvider({
      sandboxNamespace: {} as never,
      sdk: { getSandbox: getSandbox as never },
    });

    const handle = await provider.getHandle("org_123::dev", {
      keepAlive: true,
      sleepAfter: "15m",
    });
    const status = await provider.getStatus("org_123::dev", handle);

    expect(provider.provider).toBe(CLOUDFLARE_SANDBOX_PROVIDER);
    assert(handle.id === "org_123::dev");
    expect(getSandbox).toHaveBeenCalledWith(expect.anything(), "org_123::dev", {
      keepAlive: true,
      sleepAfter: "15m",
    });
    expect(status).toBe("running");
  });

  test("returns error status when the Cloudflare runtime status call fails", async () => {
    const sandbox = createCloudflareRuntimeHandleMock();
    sandbox.getRuntimeStatus.mockRejectedValueOnce(new Error("status failed"));
    const provider = createCloudflareSandboxProvider({
      sandboxNamespace: {} as never,
      sdk: { getSandbox: vi.fn(async () => sandbox) as never },
    });
    const handle = await provider.getHandle("org_123::dev");

    await expect(provider.getStatus("org_123::dev", handle)).resolves.toBe("error");
  });

  test("returns sandbox_terminated when sandbox dies during command execution", async () => {
    const sandbox = createCloudflareRuntimeHandleMock();
    sandbox.exec.mockRejectedValue(new Error("container exited unexpectedly"));
    const provider = createCloudflareSandboxProvider({
      sandboxNamespace: {} as never,
      sdk: { getSandbox: vi.fn(async () => sandbox) as never },
    });

    const handle = await provider.getHandle("cf-dead");
    const result = await handle.executeCommand("npm test");

    assert(!result.ok);
    assert(result.reason === "sandbox_terminated");
    assert(result.retryable);
  });

  test("surfaces command_failed for non-zero command exit", async () => {
    const sandbox = createCloudflareRuntimeHandleMock();
    sandbox.exec.mockResolvedValue({
      success: false,
      stdout: "",
      stderr: "missing build script",
      exitCode: 1,
    });
    const provider = createCloudflareSandboxProvider({
      sandboxNamespace: {} as never,
      sdk: { getSandbox: vi.fn(async () => sandbox) as never },
    });

    const handle = await provider.getHandle("cf-fail");
    const result = await handle.executeCommand("npm run build");

    assert(!result.ok);
    assert(result.reason === "command_failed");
    assert(!result.retryable);
  });

  test("handles undefined thrown values during command execution", async () => {
    const sandbox = createCloudflareRuntimeHandleMock();
    sandbox.exec.mockRejectedValue(undefined);
    const provider = createCloudflareSandboxProvider({
      sandboxNamespace: {} as never,
      sdk: { getSandbox: vi.fn(async () => sandbox) as never },
    });

    const handle = await provider.getHandle("cf-undefined");
    const result = await handle.executeCommand("echo hi");

    assert(!result.ok);
    assert(result.reason === "internal_error");
    assert(result.message === "Unknown sandbox execution error.");
  });

  test("proxies mountBucket to the Cloudflare sandbox handle", async () => {
    const sandbox = createCloudflareRuntimeHandleMock();
    const provider = createCloudflareSandboxProvider({
      sandboxNamespace: {} as never,
      sdk: { getSandbox: vi.fn(async () => sandbox) as never },
    });

    const handle = await provider.getHandle("cf-mount");
    await handle.mountBucket("uploads", "/uploads", {
      endpoint: "https://example.r2.cloudflarestorage.com",
    });

    expect(sandbox.mountBucket).toHaveBeenCalledWith("uploads", "/uploads", {
      endpoint: "https://example.r2.cloudflarestorage.com",
    });
  });

  test("rejects Cloudflare bucket mount options that the SDK would ignore", async () => {
    const sandbox = createCloudflareRuntimeHandleMock();
    const provider = createCloudflareSandboxProvider({
      sandboxNamespace: {} as never,
      sdk: { getSandbox: vi.fn(async () => sandbox) as never },
    });

    const handle = await provider.getHandle("cf-mount");
    await expect(
      handle.mountBucket("uploads", "/uploads", {
        endpoint: "https://example.r2.cloudflarestorage.com",
        region: "auto",
        credentials: {
          accessKeyId: "key",
          secretAccessKey: "secret",
          sessionToken: "token",
        },
      }),
    ).rejects.toThrow(
      "Cloudflare sandbox bucket mounts do not support region, credentials.sessionToken",
    );

    expect(sandbox.mountBucket).not.toHaveBeenCalled();
  });
});
