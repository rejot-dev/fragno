import { describe, expect, test, vi } from "vitest";

import type { BackofficeAuthorityResolver } from "@/backoffice-runtime/authority-resolver";
import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import {
  allBackofficePermissionRequirements,
  BACKOFFICE_PERMISSION,
} from "@/backoffice-runtime/permissions";

import { createAutomationRouteAuthorityResolver } from "./authority";

const organizationAutomationExecution = {
  scope: { kind: "org", orgId: "org-1" },
  actors: {
    initiator: {
      scope: "external",
      source: "test",
      type: "request",
      id: "request-1",
      role: "initiator",
    },
    principal: {
      scope: "internal",
      type: "automation",
      id: "automation-route:daily-digest",
      role: "principal",
    },
    delegation: [],
  },
} as const satisfies BackofficeExecutionContext;

function createFallbackResolver(): BackofficeAuthorityResolver {
  return {
    resolvePrincipalPermissions: vi.fn(async () => [BACKOFFICE_PERMISSION.events.read]),
    resolveActorCapabilityGrants: vi.fn(async () => [BACKOFFICE_PERMISSION.events.read]),
  };
}

describe("createAutomationRouteAuthorityResolver", () => {
  test("resolves an organization automation principal from its current enabled route", async () => {
    const fallbackResolver = createFallbackResolver();
    const lookupRoute = vi.fn(async () => ({
      enabled: true,
      action: {
        kind: "start_workflow" as const,
        authority: {
          kind: "organization-automation" as const,
          grants: [BACKOFFICE_PERMISSION.store.modify],
        },
        workflowScriptPath: "/workspace/automations/daily-digest.workflow.js",
        instanceIdTemplate: "daily-${event.id}",
      },
    }));
    const resolver = createAutomationRouteAuthorityResolver({ fallbackResolver, lookupRoute });

    await expect(
      resolver.resolvePrincipalPermissions({
        principal: organizationAutomationExecution.actors.principal,
        execution: organizationAutomationExecution,
      }),
    ).resolves.toEqual([BACKOFFICE_PERMISSION.store.modify]);
    expect(lookupRoute).toHaveBeenCalledWith({
      scope: organizationAutomationExecution.scope,
      routeId: "daily-digest",
    });
    expect(fallbackResolver.resolvePrincipalPermissions).not.toHaveBeenCalled();
  });

  test.each([
    { label: "missing", route: null },
    {
      label: "disabled",
      route: {
        enabled: false,
        action: {
          kind: "start_workflow" as const,
          authority: {
            kind: "organization-automation" as const,
            grants: [BACKOFFICE_PERMISSION.store.modify],
          },
          workflowScriptPath: "/workspace/automations/daily-digest.workflow.js",
          instanceIdTemplate: "daily-${event.id}",
        },
      },
    },
    {
      label: "changed to delegated-user authority",
      route: {
        enabled: true,
        action: {
          kind: "start_workflow" as const,
          authority: {
            kind: "delegated-user" as const,
            grants: [BACKOFFICE_PERMISSION.store.modify],
          },
          workflowScriptPath: "/workspace/automations/daily-digest.workflow.js",
          instanceIdTemplate: "daily-${event.id}",
        },
      },
    },
  ])("denies a $label organization automation route", async ({ route }) => {
    const fallbackResolver = createFallbackResolver();
    const resolver = createAutomationRouteAuthorityResolver({
      fallbackResolver,
      lookupRoute: async () => route,
    });

    await expect(
      resolver.resolvePrincipalPermissions({
        principal: organizationAutomationExecution.actors.principal,
        execution: organizationAutomationExecution,
      }),
    ).resolves.toEqual([]);
    expect(fallbackResolver.resolvePrincipalPermissions).not.toHaveBeenCalled();
  });

  test.each(["delegated-user", "linked-user"] as const)(
    "resolves inherited %s grants without removing the route delegate",
    async (authorityKind) => {
      const fallbackResolver = createFallbackResolver();
      const automationDelegate = {
        scope: "internal",
        type: "automation",
        id: "automation-route:user-workflow",
        role: "delegate",
      } as const;
      const execution = {
        ...organizationAutomationExecution,
        actors: {
          ...organizationAutomationExecution.actors,
          principal: {
            scope: "internal",
            type: "user",
            id: "user-1",
            role: "principal",
          },
          delegation: [automationDelegate],
        },
      } as const satisfies BackofficeExecutionContext;
      const resolver = createAutomationRouteAuthorityResolver({
        fallbackResolver,
        lookupRoute: async () => ({
          enabled: true,
          action: {
            kind: "start_workflow",
            authority: { kind: authorityKind, grants: "inherit" },
            workflowScriptPath: "/workspace/automations/user.workflow.js",
            instanceIdTemplate: "user-${event.id}",
          },
        }),
      });

      await expect(
        resolver.resolveActorCapabilityGrants({ actor: automationDelegate, execution }),
      ).resolves.toEqual(allBackofficePermissionRequirements);
      expect(execution.actors.delegation).toEqual([automationDelegate]);
      expect(fallbackResolver.resolveActorCapabilityGrants).not.toHaveBeenCalled();
    },
  );

  test.each(["delegated-user", "linked-user"] as const)(
    "resolves a %s automation from current delegated route grants",
    async (authorityKind) => {
      const fallbackResolver = createFallbackResolver();
      const automationDelegate = {
        scope: "internal",
        type: "automation",
        id: "automation-route:daily-digest",
        role: "delegate",
      } as const;
      const execution = {
        ...organizationAutomationExecution,
        actors: {
          ...organizationAutomationExecution.actors,
          principal: {
            scope: "internal",
            type: "user",
            id: "user-1",
            role: "principal",
          },
          delegation: [automationDelegate],
        },
      } as const satisfies BackofficeExecutionContext;
      const resolver = createAutomationRouteAuthorityResolver({
        fallbackResolver,
        lookupRoute: async () => ({
          enabled: true,
          action: {
            kind: "start_workflow",
            authority: {
              kind: authorityKind,
              grants: [BACKOFFICE_PERMISSION.store.modify],
            },
            workflowScriptPath: "/workspace/automations/daily-digest.workflow.js",
            instanceIdTemplate: "daily-${event.id}",
          },
        }),
      });

      await expect(
        resolver.resolveActorCapabilityGrants({ actor: automationDelegate, execution }),
      ).resolves.toEqual([BACKOFFICE_PERMISSION.store.modify]);
      expect(fallbackResolver.resolveActorCapabilityGrants).not.toHaveBeenCalled();
    },
  );
});
