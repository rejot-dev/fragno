import { describe, expect, it, vi } from "vitest";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class MockDurableObject {},
  RpcTarget: class MockRpcTarget {},
  WorkerEntrypoint: class MockWorkerEntrypoint {},
}));

vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import { createInMemoryBackofficeRuntime } from "./in-memory-runtime";
import { parseAuthEmailVerificationRuntimeConfig } from "./runtime-services";

describe("parseAuthEmailVerificationRuntimeConfig", () => {
  it("does not require a public URL when email verification is disabled", () => {
    expect(
      parseAuthEmailVerificationRuntimeConfig({ enabled: "false", publicBaseUrl: undefined }),
    ).toEqual({ enabled: false });
  });

  it("requires a public URL when email verification is enabled", () => {
    expect(() =>
      parseAuthEmailVerificationRuntimeConfig({ enabled: "true", publicBaseUrl: undefined }),
    ).toThrow("DOCS_PUBLIC_BASE_URL must be configured as an absolute http or https URL");
  });

  it("fails in-memory runtime construction before creating services", async () => {
    await expect(
      createInMemoryBackofficeRuntime({
        env: {
          AUTH_EMAIL_VERIFICATION_ENABLED: "true",
          DOCS_PUBLIC_BASE_URL: undefined,
        },
      }),
    ).rejects.toThrow("DOCS_PUBLIC_BASE_URL must be configured as an absolute http or https URL");
  });

  it.each(["ftp://example.com", "not-a-url"])("rejects invalid public URL %s", (publicBaseUrl) => {
    expect(() =>
      parseAuthEmailVerificationRuntimeConfig({ enabled: "true", publicBaseUrl }),
    ).toThrow("DOCS_PUBLIC_BASE_URL must be configured as an absolute http or https URL");
  });

  it("returns a validated public URL when enabled", () => {
    expect(
      parseAuthEmailVerificationRuntimeConfig({
        enabled: "true",
        publicBaseUrl: "https://example.com/backoffice",
      }),
    ).toEqual({
      enabled: true,
      publicBaseUrl: "https://example.com/backoffice",
    });
  });
});
