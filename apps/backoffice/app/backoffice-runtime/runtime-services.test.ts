import { assert, describe, expect, it, vi } from "vitest";

import { z } from "zod";

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

const authoritySignUpResponseSchema = z.object({
  status: z.literal("authenticated"),
  userId: z.string(),
  auth: z.object({
    token: z.string(),
    activeOrganizationId: z.string().nullable(),
  }),
});

const addedOrganizationMemberResponseSchema = z.object({
  member: z.object({ id: z.string() }),
});

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
      const signUp = async (email: string) => {
        const response = await auth.fetch(
          new Request("https://backoffice.example/api/auth/sign-up", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email, password: "password123" }),
          }),
        );
        if (!response.ok) {
          throw new Error(await response.text());
        }
        return authoritySignUpResponseSchema.parse(await response.json());
      };

      const owner = await signUp("authority-owner@example.com");
      const member = await signUp("authority-member@example.com");
      assert(owner.auth.activeOrganizationId);
      const organizationId = owner.auth.activeOrganizationId;
      const authorization = `Bearer ${owner.auth.token}`;

      const addResponse = await auth.fetch(
        new Request(`https://backoffice.example/api/auth/organizations/${organizationId}/members`, {
          method: "POST",
          headers: { authorization, "content-type": "application/json" },
          body: JSON.stringify({ userId: member.userId, roles: ["member"] }),
        }),
      );
      if (!addResponse.ok) {
        throw new Error(await addResponse.text());
      }
      const added = addedOrganizationMemberResponseSchema.parse(await addResponse.json());

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
            id: member.userId,
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

      const removeResponse = await auth.fetch(
        new Request(
          `https://backoffice.example/api/auth/organizations/${organizationId}/members/${added.member.id}`,
          { method: "DELETE", headers: { authorization } },
        ),
      );
      if (!removeResponse.ok) {
        throw new Error(await removeResponse.text());
      }

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
