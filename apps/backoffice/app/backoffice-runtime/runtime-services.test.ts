import { describe, expect, it, vi } from "vitest";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class MockDurableObject {},
  RpcTarget: class MockRpcTarget {},
  WorkerEntrypoint: class MockWorkerEntrypoint {},
}));

vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import { createInMemoryBackofficeRuntime } from "./in-memory-runtime";
import {
  BackofficeKernel,
  type BackofficeKernelAction,
  type BackofficeKernelObserver,
} from "./kernel";
import {
  createCloudflareBackofficeRuntimeServices,
  parseAuthEmailVerificationRuntimeConfig,
} from "./runtime-services";

describe("Backoffice authority runtime wiring", () => {
  it("does not let an observer authorize when the Cloudflare authority source is unavailable", async () => {
    let observedActionCount = 0;
    const observer: BackofficeKernelObserver = {
      async runAction<T>(
        _action: BackofficeKernelAction,
        execute: () => Promise<T>,
      ): Promise<void> {
        observedActionCount += 1;
        await execute();
      },
    };
    const runtime = createCloudflareBackofficeRuntimeServices({} as CloudflareEnv, {
      kernelObserver: observer,
    });
    const execute = vi.fn(async () => "sent");

    await expect(
      new BackofficeKernel(runtime).invoke({
        execution: {
          scope: { kind: "org", orgId: "org-1" },
          actors: {
            initiator: {
              scope: "external",
              source: "telegram",
              type: "chat",
              id: "chat-1",
              role: "initiator",
            },
            principal: {
              scope: "internal",
              type: "user",
              id: "user-1",
              role: "principal",
            },
            delegation: [],
          },
        },
        operation: { namespace: "telegram", permission: "send" },
        execute,
      }),
    ).rejects.toMatchObject({ reason: "authority-unavailable" });

    expect(observedActionCount).toBe(0);
    expect(execute).not.toHaveBeenCalled();
  });

  it("denies the next action after membership is revoked in the Auth object", async () => {
    const runtime = await createInMemoryBackofficeRuntime();

    try {
      const auth = runtime.objects.auth.singleton();
      const organizationId = "authority-org";
      const memberUserId = "authority-member";
      await auth.applyScenarioFixture({
        users: [
          {
            id: "authority-owner",
            email: "authority-owner@example.com",
            role: "user",
            status: "active",
          },
          {
            id: memberUserId,
            email: "authority-member@example.com",
            role: "user",
            status: "active",
          },
        ],
        organizations: [
          {
            id: organizationId,
            name: "Authority Org",
            slug: "authority-org",
            ownerUserId: "authority-owner",
            ownerRoles: ["owner"],
          },
        ],
        members: [{ organizationId, userId: memberUserId, roles: ["member"] }],
      });

      const kernel = new BackofficeKernel(runtime.services);
      const execution = {
        scope: { kind: "org", orgId: organizationId } as const,
        actors: {
          initiator: {
            scope: "external" as const,
            source: "telegram",
            type: "chat",
            id: "chat-1",
            role: "initiator" as const,
          },
          principal: {
            scope: "internal" as const,
            type: "user",
            id: memberUserId,
            role: "principal" as const,
          },
          delegation: [],
        },
      };

      await expect(
        kernel.invoke({
          execution,
          operation: { namespace: "telegram", permission: "send" },
          execute: async () => "sent",
        }),
      ).resolves.toBe("sent");

      await auth.applyScenarioFixture({
        removedMembers: [{ organizationId, userId: memberUserId }],
      });

      const executeAfterRevocation = vi.fn(async () => "sent");
      await expect(
        kernel.invoke({
          execution,
          operation: { namespace: "telegram", permission: "send" },
          execute: executeAfterRevocation,
        }),
      ).rejects.toMatchObject({ reason: "principal-permission-denied" });
      expect(executeAfterRevocation).not.toHaveBeenCalled();
    } finally {
      await runtime.cleanup();
    }
  });
});

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
