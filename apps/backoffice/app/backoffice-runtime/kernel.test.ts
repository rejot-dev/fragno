import { describe, expect, test, vi } from "vitest";

import type { BackofficeAuthorityResolver } from "./authority-resolver";
import {
  unavailableBackofficeAuthorityResolver,
  unrestrictedBackofficeAuthorityResolver,
} from "./authority-resolver";
import {
  BackofficeForbiddenError,
  BackofficeKernel,
  noopBackofficeKernelObserver,
  type BackofficeKernelAction,
  type BackofficeKernelObserver,
} from "./kernel";

const scopeKernel = new BackofficeKernel({
  authorityResolver: unavailableBackofficeAuthorityResolver,
  kernelObserver: noopBackofficeKernelObserver,
});

const linkedExecution = {
  scope: { kind: "org", orgId: "org-1" } as const,
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
      id: "user-1",
      role: "principal" as const,
    },
    delegation: [
      {
        scope: "internal" as const,
        type: "automation",
        id: "automation-1",
        role: "delegate" as const,
      },
      {
        scope: "internal" as const,
        type: "agent",
        id: "agent-1",
        role: "assistant" as const,
      },
    ],
  },
};

const operation = { namespace: "telegram", permission: "send" } as const;

class RecordingKernelObserver implements BackofficeKernelObserver {
  readonly authorizations: BackofficeKernelAction[] = [];
  readonly actions: BackofficeKernelAction[] = [];

  async observeAuthorization(action: BackofficeKernelAction): Promise<void> {
    this.authorizations.push(action);
  }

  async runAction<T>(action: BackofficeKernelAction, execute: () => Promise<T>): Promise<void> {
    this.actions.push(action);
    await execute();
  }
}

describe("BackofficeKernel.assertAuthorized", () => {
  test("observes authorization without running the action execution observer", async () => {
    const resolvePrincipalPermissions = vi.fn(async () => [operation]);
    const resolveActorCapabilityGrants = vi.fn(async () => [operation]);
    const observer = new RecordingKernelObserver();
    const kernel = new BackofficeKernel({
      authorityResolver: {
        resolvePrincipalPermissions,
        resolveActorCapabilityGrants,
      },
      kernelObserver: observer,
    });

    await expect(
      kernel.assertAuthorized({ execution: linkedExecution, operation }),
    ).resolves.toBeUndefined();

    expect(resolvePrincipalPermissions).toHaveBeenCalledOnce();
    expect(resolveActorCapabilityGrants).toHaveBeenCalledTimes(2);
    expect(observer.authorizations).toEqual([
      { execution: linkedExecution, operation, resource: undefined },
    ]);
    expect(observer.actions).toEqual([]);
  });

  test("fails closed when current authority does not grant the operation", async () => {
    const kernel = new BackofficeKernel({
      authorityResolver: {
        async resolvePrincipalPermissions() {
          return [];
        },
        async resolveActorCapabilityGrants() {
          return [operation];
        },
      },
      kernelObserver: noopBackofficeKernelObserver,
    });

    await expect(
      kernel.assertAuthorized({ execution: linkedExecution, operation }),
    ).rejects.toMatchObject({ reason: "principal-permission-denied" });
  });
});

describe("BackofficeKernel.invoke", () => {
  test("denies sensitive actions when the configured authority source is unavailable", async () => {
    const execute = vi.fn(async () => "sent");

    await expect(
      new BackofficeKernel({
        authorityResolver: unavailableBackofficeAuthorityResolver,
        kernelObserver: noopBackofficeKernelObserver,
      }).invoke({ execution: linkedExecution, operation, execute }),
    ).rejects.toMatchObject({ reason: "authority-unavailable" });
    expect(execute).not.toHaveBeenCalled();
  });

  test("rejects malformed execution context before authority resolution", async () => {
    const resolvePrincipalPermissions = vi.fn(async () => [operation]);
    const execute = vi.fn(async () => "sent");
    const malformedExecution = {
      ...linkedExecution,
      actors: {
        ...linkedExecution.actors,
        principal: { ...linkedExecution.actors.principal, role: "assistant" },
      },
    } as unknown as typeof linkedExecution;

    await expect(
      new BackofficeKernel({
        authorityResolver: {
          resolvePrincipalPermissions,
          async resolveActorCapabilityGrants() {
            return [operation];
          },
        },
        kernelObserver: noopBackofficeKernelObserver,
      }).invoke({ execution: malformedExecution, operation, execute }),
    ).rejects.toMatchObject({ reason: "context-access-denied" });

    expect(resolvePrincipalPermissions).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  test("rejects access-token authority for a different execution principal", async () => {
    const resolvePrincipalPermissions = vi.fn(async () => [operation]);
    const execute = vi.fn(async () => "sent");

    await expect(
      new BackofficeKernel({
        authorityResolver: {
          resolvePrincipalPermissions,
          async resolveActorCapabilityGrants() {
            return [operation];
          },
        },
        kernelObserver: noopBackofficeKernelObserver,
      }).invoke({
        execution: {
          ...linkedExecution,
          userAuthority: {
            kind: "verified-request-authority",
            userId: "user-2",
            role: "user",
            scope: { kind: "org", orgId: "org-1" },
            expiresAtEpochMs: Date.now() + 60_000,
          },
        },
        operation,
        execute,
      }),
    ).rejects.toMatchObject({ reason: "context-access-denied" });

    expect(resolvePrincipalPermissions).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  test("denies when authority resolution throws", async () => {
    const resolver: BackofficeAuthorityResolver = {
      async resolvePrincipalPermissions() {
        throw new Error("Auth object unavailable");
      },
      async resolveActorCapabilityGrants() {
        return [operation];
      },
    };
    const execute = vi.fn(async () => "sent");

    await expect(
      new BackofficeKernel({
        authorityResolver: resolver,
        kernelObserver: noopBackofficeKernelObserver,
      }).invoke({
        execution: linkedExecution,
        operation,
        execute,
      }),
    ).rejects.toMatchObject({ reason: "authority-unavailable" });
    expect(execute).not.toHaveBeenCalled();
  });

  test("resolves every participant and executes the authorized action exactly once", async () => {
    const resolvePrincipalPermissions = vi.fn(async () => [operation]);
    const resolvedDelegationRoles: string[] = [];
    const resolveActorCapabilityGrants: BackofficeAuthorityResolver["resolveActorCapabilityGrants"] =
      vi.fn(async ({ actor }) => {
        resolvedDelegationRoles.push(actor.role);
        return [operation];
      });
    const observer = new RecordingKernelObserver();
    const execute = vi.fn(async () => "sent");
    const kernel = new BackofficeKernel({
      authorityResolver: {
        resolvePrincipalPermissions,
        resolveActorCapabilityGrants,
      },
      kernelObserver: observer,
    });

    await expect(kernel.invoke({ execution: linkedExecution, operation, execute })).resolves.toBe(
      "sent",
    );

    expect(resolvePrincipalPermissions).toHaveBeenCalledOnce();
    expect(resolveActorCapabilityGrants).toHaveBeenCalledTimes(2);
    expect(resolvedDelegationRoles).toEqual(["delegate", "assistant"]);
    expect(observer.actions).toHaveLength(1);
    expect(execute).toHaveBeenCalledOnce();
  });

  test("executes an authorized action exactly once through the no-op observer", async () => {
    const execute = vi.fn(async () => "sent");
    const kernel = new BackofficeKernel({
      authorityResolver: unrestrictedBackofficeAuthorityResolver,
      kernelObserver: noopBackofficeKernelObserver,
    });

    await expect(kernel.invoke({ execution: linkedExecution, operation, execute })).resolves.toBe(
      "sent",
    );
    expect(execute).toHaveBeenCalledOnce();
  });

  test("lets a system-scoped user reach current authority resolution", async () => {
    const resolvePrincipalPermissions = vi.fn(async () => [operation]);
    const execute = vi.fn(async () => "sent");
    const kernel = new BackofficeKernel({
      authorityResolver: {
        resolvePrincipalPermissions,
        async resolveActorCapabilityGrants() {
          return [];
        },
      },
      kernelObserver: noopBackofficeKernelObserver,
    });

    await expect(
      kernel.invoke({
        execution: {
          scope: { kind: "system" },
          actors: {
            initiator: {
              scope: "internal",
              type: "backoffice",
              id: "interactive",
              role: "initiator",
            },
            principal: {
              scope: "internal",
              type: "user",
              id: "admin-1",
              role: "principal",
            },
            delegation: [],
          },
        },
        operation,
        execute,
      }),
    ).resolves.toBe("sent");

    expect(resolvePrincipalPermissions).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
  });

  test("waits for an action that the observer starts without awaiting", async () => {
    let finishAction: ((result: string) => void) | undefined;
    const execute = vi.fn(
      async () =>
        await new Promise<string>((resolve) => {
          finishAction = resolve;
        }),
    );
    const observer: BackofficeKernelObserver = {
      async runAction<T>(_action: BackofficeKernelAction, run: () => Promise<T>): Promise<void> {
        run().catch(() => undefined);
      },
    };
    const kernel = new BackofficeKernel({
      authorityResolver: unrestrictedBackofficeAuthorityResolver,
      kernelObserver: observer,
    });

    const invocation = kernel.invoke({ execution: linkedExecution, operation, execute });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(finishAction).toBeTypeOf("function");
    finishAction?.("sent");

    await expect(invocation).resolves.toBe("sent");
  });

  test("preserves an action error that the observer catches", async () => {
    const actionError = new Error("Telegram request failed");
    const observer: BackofficeKernelObserver = {
      async runAction<T>(_action: BackofficeKernelAction, run: () => Promise<T>): Promise<void> {
        await run().catch(() => undefined);
      },
    };
    const kernel = new BackofficeKernel({
      authorityResolver: unrestrictedBackofficeAuthorityResolver,
      kernelObserver: observer,
    });

    await expect(
      kernel.invoke({
        execution: linkedExecution,
        operation,
        execute: async () => {
          throw actionError;
        },
      }),
    ).rejects.toBe(actionError);
  });

  test("does not let an observer execute the action after observation completes", async () => {
    let runAfterObservation: (() => Promise<unknown>) | undefined;
    const execute = vi.fn(async () => "sent");
    const observer: BackofficeKernelObserver = {
      async runAction<T>(_action: BackofficeKernelAction, run: () => Promise<T>): Promise<void> {
        runAfterObservation = run;
      },
    };
    const kernel = new BackofficeKernel({
      authorityResolver: unrestrictedBackofficeAuthorityResolver,
      kernelObserver: observer,
    });

    await expect(kernel.invoke({ execution: linkedExecution, operation, execute })).rejects.toThrow(
      "completed without executing",
    );
    expect(runAfterObservation).toBeTypeOf("function");
    await expect(runAfterObservation?.()).rejects.toThrow("after observation completed");
    expect(execute).not.toHaveBeenCalled();
  });

  test("denies when a delegated actor lacks the current capability grant", async () => {
    const resolver: BackofficeAuthorityResolver = {
      async resolvePrincipalPermissions() {
        return [operation];
      },
      async resolveActorCapabilityGrants({ actor }) {
        return actor.role === "delegate" ? [operation] : [];
      },
    };
    const execute = vi.fn(async () => "sent");

    await expect(
      new BackofficeKernel({
        authorityResolver: resolver,
        kernelObserver: noopBackofficeKernelObserver,
      }).invoke({
        execution: linkedExecution,
        operation,
        execute,
      }),
    ).rejects.toMatchObject({ reason: "actor-capability-denied" });
    expect(execute).not.toHaveBeenCalled();
  });

  test("does not let an observer substitute for authority resolution", async () => {
    const observer = new RecordingKernelObserver();
    const execute = vi.fn(async () => "sent");

    await expect(
      new BackofficeKernel({
        authorityResolver: unavailableBackofficeAuthorityResolver,
        kernelObserver: observer,
      }).invoke({
        execution: linkedExecution,
        operation,
        execute,
      }),
    ).rejects.toMatchObject({ reason: "authority-unavailable" });

    expect(observer.actions).toHaveLength(0);
    expect(execute).not.toHaveBeenCalled();
  });

  test("keeps unlinked bootstrap authority narrow and tied to the initiating identity", async () => {
    const execution = {
      scope: { kind: "org", orgId: "org-1" } as const,
      actors: {
        initiator: {
          scope: "external" as const,
          source: "telegram",
          type: "chat",
          id: "chat-1",
          role: "initiator" as const,
        },
        principal: null,
        delegation: [],
      },
    };
    const kernel = new BackofficeKernel({
      authorityResolver: unrestrictedBackofficeAuthorityResolver,
      kernelObserver: noopBackofficeKernelObserver,
    });

    await expect(
      kernel.invoke({
        execution,
        operation: operation,
        resource: { kind: "telegram-chat", chatId: "chat-1" },
        execute: async () => "sent",
      }),
    ).resolves.toBe("sent");

    await expect(
      kernel.invoke({
        execution,
        operation: operation,
        resource: { kind: "telegram-chat", chatId: "chat-2" },
        execute: async () => "sent",
      }),
    ).rejects.toMatchObject({ reason: "principal-permission-denied" });
  });
});

describe("BackofficeKernel.resolveFilePrincipal", () => {
  test("rejects principal-free execution with external delegation", () => {
    expect(() =>
      scopeKernel.resolveFilePrincipal({
        scope: { kind: "org", orgId: "org-1" },
        actors: {
          initiator: {
            scope: "internal",
            type: "system",
            id: "backoffice",
            role: "initiator",
          },
          principal: null,
          delegation: [
            {
              scope: "external",
              source: "telegram",
              type: "chat",
              id: "chat-1",
              role: "delegate",
            },
          ],
        },
      }),
    ).toThrow(BackofficeForbiddenError);
  });
});

describe("BackofficeKernel.assertScopedContextAccess", () => {
  test("limits a user execution to its organization and own user scope", () => {
    expect(() =>
      scopeKernel.assertScopedContextAccess(linkedExecution, {
        kind: "project",
        orgId: "org-1",
        projectId: "project-1",
      }),
    ).not.toThrow();
    expect(() =>
      scopeKernel.assertScopedContextAccess(linkedExecution, {
        kind: "user",
        userId: "user-1",
      }),
    ).not.toThrow();

    expect(() =>
      scopeKernel.assertScopedContextAccess(linkedExecution, {
        kind: "user",
        userId: "user-2",
      }),
    ).toThrow(BackofficeForbiddenError);
    expect(() =>
      scopeKernel.assertScopedContextAccess(linkedExecution, {
        kind: "org",
        orgId: "org-2",
      }),
    ).toThrow(BackofficeForbiddenError);
  });

  test("does not turn a system-initiated service principal into unrestricted system access", () => {
    const serviceExecution = {
      scope: { kind: "org", orgId: "org-1" } as const,
      actors: {
        initiator: {
          scope: "internal" as const,
          type: "system",
          id: "backoffice",
          role: "initiator" as const,
        },
        principal: {
          scope: "internal" as const,
          type: "automation",
          id: "automation-1",
          role: "principal" as const,
        },
        delegation: [],
      },
    };

    expect(() =>
      scopeKernel.assertScopedContextAccess(serviceExecution, {
        kind: "org",
        orgId: "org-2",
      }),
    ).toThrow(BackofficeForbiddenError);
  });

  test("does not treat a system initiator with external delegation as trusted system execution", () => {
    expect(() =>
      scopeKernel.assertScopedContextAccess(
        {
          scope: { kind: "system" },
          actors: {
            initiator: {
              scope: "internal",
              type: "system",
              id: "backoffice",
              role: "initiator",
            },
            principal: null,
            delegation: [
              {
                scope: "external",
                source: "telegram",
                type: "chat",
                id: "chat-1",
                role: "delegate",
              },
            ],
          },
        },
        { kind: "org", orgId: "org-1" },
      ),
    ).toThrow(BackofficeForbiddenError);
  });

  test("allows a system-scoped service principal to enter a concrete scope", () => {
    expect(() =>
      scopeKernel.assertScopedContextAccess(
        {
          scope: { kind: "system" },
          actors: {
            initiator: {
              scope: "internal",
              type: "user",
              id: "user-1",
              role: "initiator",
            },
            principal: {
              scope: "internal",
              type: "automation",
              id: "automation-1",
              role: "principal",
            },
            delegation: [],
          },
        },
        { kind: "org", orgId: "org-1" },
      ),
    ).not.toThrow();
  });

  test("allows principal-free trusted system execution to enter any scope", () => {
    expect(() =>
      scopeKernel.assertScopedContextAccess(
        {
          scope: { kind: "system" },
          actors: {
            initiator: {
              scope: "internal",
              type: "system",
              id: "backoffice",
              role: "initiator",
            },
            principal: null,
            delegation: [],
          },
        },
        { kind: "org", orgId: "org-1" },
      ),
    ).not.toThrow();
  });
});

describe("BackofficeKernel.assertScopeAllowedByOwner", () => {
  test("allows organization and project scopes owned by the organization", async () => {
    await expect(
      scopeKernel.assertScopeAllowedByOwner({
        ownerScope: { kind: "org", orgId: "org-1" },
        targetScope: { kind: "org", orgId: "org-1" },
        operation: "billing.record-event",
      }),
    ).resolves.toBeUndefined();
    await expect(
      scopeKernel.assertScopeAllowedByOwner({
        ownerScope: { kind: "org", orgId: "org-1" },
        targetScope: { kind: "project", orgId: "org-1", projectId: "project-1" },
        operation: "billing.record-event",
      }),
    ).resolves.toBeUndefined();
  });

  test("allows user scopes pending organization membership enforcement", async () => {
    await expect(
      scopeKernel.assertScopeAllowedByOwner({
        ownerScope: { kind: "org", orgId: "org-1" },
        targetScope: { kind: "user", userId: "user-1" },
        operation: "billing.record-event",
      }),
    ).resolves.toBeUndefined();
  });

  test.each([
    { kind: "system" as const },
    { kind: "org" as const, orgId: "org-2" },
    { kind: "project" as const, orgId: "org-2", projectId: "project-1" },
  ])("rejects $kind scopes outside the owning organization", async (targetScope) => {
    await expect(
      scopeKernel.assertScopeAllowedByOwner({
        ownerScope: { kind: "org", orgId: "org-1" },
        targetScope,
        operation: "billing.record-event",
      }),
    ).rejects.toThrow(BackofficeForbiddenError);
  });
});
