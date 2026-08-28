import { describe, expect, test, vi } from "vitest";

import {
  createBackofficeServiceExecution,
  createBackofficeSystemExecution,
} from "@/backoffice-runtime/context";
import { createInMemoryBackofficeRuntime } from "@/backoffice-runtime/in-memory-runtime";
import type { BackofficeKernelAction, BackofficeKernelObserver } from "@/backoffice-runtime/kernel";
import { BACKOFFICE_PERMISSION } from "@/backoffice-runtime/permissions";
import { buildExternalIdentityBindingId } from "@/fragno/automation/external-identities";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => {
  class MockDurableObject {
    constructor(_state: unknown, _env: unknown) {}
  }

  class MockRpcTarget {}
  class MockWorkerEntrypoint {}

  return {
    DurableObject: MockDurableObject,
    RpcTarget: MockRpcTarget,
    WorkerEntrypoint: MockWorkerEntrypoint,
  };
});

vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

class RecordingKernelObserver implements BackofficeKernelObserver {
  readonly actions: BackofficeKernelAction[] = [];

  async runAction<T>(action: BackofficeKernelAction, execute: () => Promise<T>): Promise<void> {
    this.actions.push(action);
    await execute();
  }
}

const scope = { kind: "org" as const, orgId: "org-1" };
const identity = {
  scope: "external" as const,
  source: "telegram",
  type: "chat",
  id: "chat-1",
};
const objectExecution = createBackofficeServiceExecution({
  scope,
  service: { type: "object", id: "otp" },
});

const actionContext = (execution = objectExecution) => ({ execution });

describe("Automations identity binding RPCs", () => {
  test("observes one authorized action around each binding mutation", async () => {
    const observer = new RecordingKernelObserver();
    const runtime = await createInMemoryBackofficeRuntime({ kernelObserver: observer });

    try {
      const automations = runtime.objects.automations.for(scope);
      const bindingId = buildExternalIdentityBindingId(identity);

      await expect(
        automations.commands.bindExternalIdentity(
          {
            identity,
            userId: "user-1",
            verifiedByClaimId: "claim-1",
          },
          actionContext(),
        ),
      ).resolves.toEqual({
        status: "active",
        outcome: "created",
        bindingId,
        userId: "user-1",
        version: 0,
      });
      expect(observer.actions).toEqual([
        {
          execution: objectExecution,
          operation: BACKOFFICE_PERMISSION.identity.bind,
          resource: {
            kind: "external-identity-binding",
            source: "telegram",
            externalType: "chat",
            externalId: "chat-1",
            userId: "user-1",
          },
        },
      ]);

      observer.actions.length = 0;
      await expect(
        automations.commands.resolveExternalIdentity({ identity }, actionContext()),
      ).resolves.toEqual({ userId: "user-1" });
      expect(observer.actions).toEqual([
        {
          execution: objectExecution,
          operation: BACKOFFICE_PERMISSION.identity.resolve,
          resource: {
            kind: "external-identity-binding",
            source: "telegram",
            externalType: "chat",
            externalId: "chat-1",
          },
        },
      ]);

      observer.actions.length = 0;
      await expect(
        automations.commands.revokeExternalIdentity(
          { identity, expectedUserId: "user-1", expectedVersion: 0 },
          actionContext(),
        ),
      ).resolves.toEqual({
        status: "revoked",
        outcome: "revoked",
        bindingId,
        userId: "user-1",
        version: 1,
      });
      expect(observer.actions).toEqual([
        {
          execution: objectExecution,
          operation: BACKOFFICE_PERMISSION.identity.revoke,
          resource: {
            kind: "external-identity-binding",
            source: "telegram",
            externalType: "chat",
            externalId: "chat-1",
            expectedUserId: "user-1",
            expectedVersion: 0,
          },
        },
      ]);
    } finally {
      await runtime.cleanup();
    }
  });

  test("denies bind and revoke before entering persistence", async () => {
    const observer = new RecordingKernelObserver();
    const runtime = await createInMemoryBackofficeRuntime({
      kernelObserver: observer,
      authorityResolver: {
        async resolvePrincipalPermissions() {
          return [];
        },
        async resolveActorCapabilityGrants() {
          return [];
        },
      },
    });

    try {
      const automations = runtime.objects.automations.for(scope);
      const bindInput = {
        identity,
        userId: "user-1",
        verifiedByClaimId: "claim-1",
      };

      await expect(
        automations.commands.bindExternalIdentity(bindInput, actionContext()),
      ).rejects.toMatchObject({ reason: "principal-permission-denied" });
      await expect(
        automations.commands.resolveExternalIdentity({ identity }, actionContext()),
      ).rejects.toMatchObject({ reason: "principal-permission-denied" });
      expect(observer.actions).toEqual([]);

      const systemContext = actionContext(createBackofficeSystemExecution(scope));
      await expect(
        automations.commands.bindExternalIdentity(bindInput, systemContext),
      ).resolves.toMatchObject({ outcome: "created" });

      observer.actions.length = 0;
      await expect(
        automations.commands.revokeExternalIdentity(
          { identity, expectedUserId: "user-1", expectedVersion: 0 },
          actionContext(),
        ),
      ).rejects.toMatchObject({ reason: "principal-permission-denied" });
      expect(observer.actions).toEqual([]);

      await expect(
        automations.commands.revokeExternalIdentity(
          { identity, expectedUserId: "user-1", expectedVersion: 0 },
          systemContext,
        ),
      ).resolves.toMatchObject({ outcome: "revoked" });
    } finally {
      await runtime.cleanup();
    }
  });

  test("rejects a mutation when execution scope differs from the object scope", async () => {
    const observer = new RecordingKernelObserver();
    const runtime = await createInMemoryBackofficeRuntime({ kernelObserver: observer });

    try {
      const automations = runtime.objects.automations.for(scope);
      const mismatchedContext = actionContext(
        createBackofficeServiceExecution({
          scope: { kind: "org", orgId: "org-2" },
          service: { type: "object", id: "otp" },
        }),
      );

      await expect(
        automations.commands.bindExternalIdentity(
          {
            identity,
            userId: "user-1",
            verifiedByClaimId: "claim-1",
          },
          mismatchedContext,
        ),
      ).rejects.toThrow("Backoffice object method scope does not match object address scope.");
      expect(observer.actions).toEqual([]);
    } finally {
      await runtime.cleanup();
    }
  });
});
