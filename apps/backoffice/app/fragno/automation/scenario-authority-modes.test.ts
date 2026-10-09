import { describe, expect, test, vi, assert } from "vitest";

import { automationActorsSchema } from "@fragno-dev/backoffice-api/v0/automation";
import type { AutomationEvent } from "@fragno-dev/backoffice-api/v0/events";
import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";

import {
  createBackofficeSystemExecution,
  createBackofficeUserExecution,
} from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";

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

import { CODEMODE_WORKFLOW, codemodeWorkflowParamsSchema } from "./engine/codemode-invocation";
import { createAutomationsRouteCaller, createWorkflowsRouteCaller } from "./route-callers";
import { backofficeFiles, defineBackofficeScenario, runBackofficeScenario } from "./scenario";

const authorityEvent = ({
  id,
  principal = null,
}: {
  id: string;
  principal?: AutomationEvent["actors"]["principal"];
}): AutomationEvent => ({
  id,
  scopeRestriction: null,
  scope: { kind: "org", orgId: "org-1" },
  source: "authority-test",
  eventType: "authority.requested",
  occurredAt: "2026-08-07T00:00:00.000Z",
  payload: { id },
  actors: {
    initiator: {
      scope: "external",
      source: "authority-test",
      type: "request",
      id: `request:${id}`,
      role: "initiator",
    },
    principal,
    delegation: [],
  },
  subject: { orgId: "org-1" },
});

const workflowSource = `defineWorkflow(
  { name: "authority-mode" },
  async (event, step) => {
    const eventId = event.id;
    await step.do("write protected store entry", async () => {
      await store.set({
        key: "authority/" + eventId,
        value: "written",
        category: ["test", "authority"],
      });
    });
    return { eventId };
  },
);
`;

const liveGrantWorkflowSource = `defineWorkflow(
  { name: "live-automation-grant" },
  async (_event, step) => {
    await step.do("write before grant revocation", async () => {
      await store.set({ key: "authority/before-revocation", value: "written" });
    });
    await step.waitForEvent("continue after grant revocation", {
      type: "continue-after-revocation",
      timeout: "15 minutes",
    });
    await step.do("write after grant revocation", async () => {
      await store.set({ key: "authority/after-revocation", value: "written" });
    });
  },
);
`;

describe("automation route authority modes", () => {
  test("organization-automation performs protected work after its creator leaves", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "organization automation survives creator departure",
        files: backofficeFiles.workspaceStarter(),
        setup: ({ given }) => [
          given.auth.user({ id: "owner-1", role: "admin" }),
          given.auth.user({ id: "creator-1", role: "user" }),
          given.auth.organization({
            id: "org-1",
            name: "Ada Labs",
            ownerUserId: "owner-1",
            ownerRoles: ["owner"],
          }),
          given.auth.member({ orgId: "org-1", userId: "creator-1", roles: ["member"] }),
          given.organization.exists({
            id: "org-1",
            name: "Ada Labs",
            ownerUserId: "owner-1",
          }),
          given.direct.file({
            orgId: "org-1",
            path: "/workspace/automations/authority-mode.workflow.js",
            content: workflowSource,
          }),
        ],
        steps: ({ when, then }) => [
          then.assert("the member creates an organization-owned route", async (ctx) => {
            const scope = { kind: "org" as const, orgId: "org-1" };
            const routes = createAutomationsRouteCaller({
              object: ctx.runtime.objects.automations.forOrg("org-1"),
              context: {
                execution: createBackofficeUserExecution({ scope, userId: "creator-1" }),
                propagationContext: null,
              },
            });
            const response = await routes("POST", "/routes", {
              body: {
                id: "organization-authority",
                name: "Organization authority",
                enabled: true,
                priority: 100,
                trigger: {
                  kind: "event",
                  source: "authority-test",
                  eventType: "authority.requested",
                  matcher: { path: "$.payload.id", op: "exists" },
                },
                action: {
                  kind: "start_workflow",
                  authority: {
                    kind: "organization-automation",
                    grants: [BACKOFFICE_PERMISSION.store.modify],
                  },
                  workflowScriptPath: "/workspace/automations/authority-mode.workflow.js",
                  instanceIdTemplate: "organization-${event.id}",
                },
              },
            });
            assert(response.type === "json");
          }),
          when.automation.ingestEvent({
            ...authorityEvent({
              id: "event-1",
              principal: {
                scope: "internal",
                type: "user",
                id: "creator-1",
                role: "principal",
              },
            }),
            scopeRestriction: { kind: "org", orgId: "org-1" },
          }),
          then.workflow.instance({
            remoteWorkflowName: "authority-mode",
            instanceId: "organization-event-1",
            status: "complete",
            actors: {
              initiator: { id: "request:event-1", role: "initiator" },
              principal: {
                scope: "internal",
                type: "automation",
                id: "automation-route:organization-authority",
                role: "principal",
              },
              delegation: [],
            },
          }),
          then.assert(
            "organization authority persists an explicit transition from the caller ceiling",
            async (ctx) => {
              const response = await ctx.runtime.objects.automations
                .forOrg("org-1")
                .http.fetchAuthorized(
                  new Request(
                    `https://automations.test/api/workflows/${CODEMODE_WORKFLOW}/instances/organization-event-1`,
                  ),
                  { execution: createBackofficeSystemExecution({ kind: "org", orgId: "org-1" }) },
                );
              assert(response.ok, await response.clone().text());
              const record = (await response.json()) as { meta: { params: unknown } };
              const params = codemodeWorkflowParamsSchema.parse(record.meta.params);
              expect(params.execution.scopeRestriction).toBeNull();
              expect(params.execution.actors.principal).toMatchObject({
                type: "automation",
                id: "automation-route:organization-authority",
              });
            },
          ),
          then.store.entry({ orgId: "org-1", key: "authority/event-1", value: "written" }),
          when.auth.removeMember({ orgId: "org-1", userId: "creator-1" }),
          when.automation.ingestEvent(
            authorityEvent({
              id: "event-2",
              principal: {
                scope: "internal",
                type: "user",
                id: "creator-1",
                role: "principal",
              },
            }),
          ),
          then.workflow.instance({
            remoteWorkflowName: "authority-mode",
            instanceId: "organization-event-2",
            status: "complete",
            actors: {
              initiator: { id: "request:event-2", role: "initiator" },
              principal: {
                scope: "internal",
                type: "automation",
                id: "automation-route:organization-authority",
                role: "principal",
              },
              delegation: [],
            },
          }),
          then.store.entry({ orgId: "org-1", key: "authority/event-2", value: "written" }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("delegated-user performs protected work only while the user remains authorized", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "delegated user route follows current membership",
        files: backofficeFiles.workspaceStarter(),
        setup: ({ given }) => [
          given.auth.user({ id: "owner-1", role: "admin" }),
          given.auth.user({ id: "user-1", role: "user" }),
          given.auth.organization({
            id: "org-1",
            name: "Ada Labs",
            ownerUserId: "owner-1",
            ownerRoles: ["owner"],
          }),
          given.auth.member({ orgId: "org-1", userId: "user-1", roles: ["member"] }),
          given.organization.exists({
            id: "org-1",
            name: "Ada Labs",
            ownerUserId: "owner-1",
          }),
          given.direct.file({
            orgId: "org-1",
            path: "/workspace/automations/authority-mode.workflow.js",
            content: workflowSource,
          }),
          given.router.route({
            orgId: "org-1",
            id: "delegated-authority",
            name: "Delegated authority",
            enabled: true,
            priority: 100,
            trigger: {
              kind: "event",
              source: "authority-test",
              eventType: "authority.requested",
              matcher: { path: "$.payload.id", op: "exists" },
            },
            action: {
              kind: "start_workflow",
              authority: {
                kind: "delegated-user",
                grants: [BACKOFFICE_PERMISSION.store.modify],
              },
              workflowScriptPath: "/workspace/automations/authority-mode.workflow.js",
              instanceIdTemplate: "delegated-${event.id}",
            },
          }),
        ],
        steps: ({ when, then }) => [
          when.automation.ingestEvent(
            authorityEvent({
              id: "event-1",
              principal: {
                scope: "internal",
                type: "user",
                id: "user-1",
                role: "principal",
              },
            }),
          ),
          then.workflow.instance({
            remoteWorkflowName: "authority-mode",
            instanceId: "delegated-event-1",
            status: "complete",
            actors: {
              initiator: { id: "request:event-1", role: "initiator" },
              principal: {
                scope: "internal",
                type: "user",
                id: "user-1",
                role: "principal",
              },
              delegation: [
                {
                  scope: "internal",
                  type: "automation",
                  id: "automation-route:delegated-authority",
                  role: "delegate",
                },
              ],
            },
          }),
          then.store.entry({ orgId: "org-1", key: "authority/event-1", value: "written" }),
          when.auth.removeMember({ orgId: "org-1", userId: "user-1" }),
          when.automation.ingestEvent(
            authorityEvent({
              id: "event-2",
              principal: {
                scope: "internal",
                type: "user",
                id: "user-1",
                role: "principal",
              },
            }),
          ),
          then.workflow.instance({
            remoteWorkflowName: "authority-mode",
            instanceId: "delegated-event-2",
            status: "errored",
            actors: {
              principal: { type: "user", id: "user-1", role: "principal" },
              delegation: [
                {
                  type: "automation",
                  id: "automation-route:delegated-authority",
                  role: "delegate",
                },
              ],
            },
          }),
          then.store.missing({ orgId: "org-1", key: "authority/event-2" }),
        ],
        options: { allowErroredWorkflows: true },
      }),
    );
  });

  test("linked-user resolves the external initiator before starting the workflow", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "linked user route derives its principal",
        files: backofficeFiles.workspaceStarter(),
        setup: ({ given }) => [
          given.auth.user({ id: "owner-1", role: "admin" }),
          given.auth.user({ id: "user-1", role: "user" }),
          given.auth.organization({
            id: "org-1",
            name: "Ada Labs",
            ownerUserId: "owner-1",
            ownerRoles: ["owner"],
          }),
          given.auth.member({ orgId: "org-1", userId: "user-1", roles: ["member"] }),
          given.organization.exists({
            id: "org-1",
            name: "Ada Labs",
            ownerUserId: "owner-1",
          }),
          given.identity.binding({
            orgId: "org-1",
            source: "authority-test",
            externalType: "request",
            externalId: "request:event-1",
            userId: "user-1",
          }),
          given.direct.file({
            orgId: "org-1",
            path: "/workspace/automations/authority-mode.workflow.js",
            content: workflowSource,
          }),
          given.router.route({
            orgId: "org-1",
            id: "linked-authority",
            name: "Linked authority",
            enabled: true,
            priority: 100,
            trigger: {
              kind: "event",
              source: "authority-test",
              eventType: "authority.requested",
              matcher: { path: "$.payload.id", op: "exists" },
            },
            action: {
              kind: "start_workflow",
              authority: {
                kind: "linked-user",
                grants: [BACKOFFICE_PERMISSION.store.modify],
              },
              workflowScriptPath: "/workspace/automations/authority-mode.workflow.js",
              instanceIdTemplate: "linked-${event.id}",
            },
          }),
        ],
        steps: ({ when, then }) => [
          when.automation.ingestEvent(authorityEvent({ id: "event-1" })),
          then.workflow.instance({
            remoteWorkflowName: "authority-mode",
            instanceId: "linked-event-1",
            status: "complete",
            actors: {
              initiator: {
                scope: "external",
                source: "authority-test",
                type: "request",
                id: "request:event-1",
                role: "initiator",
              },
              principal: {
                scope: "internal",
                type: "user",
                id: "user-1",
                role: "principal",
              },
              delegation: [
                {
                  scope: "internal",
                  type: "automation",
                  id: "automation-route:linked-authority",
                  role: "delegate",
                },
              ],
            },
          }),
          then.store.entry({ orgId: "org-1", key: "authority/event-1", value: "written" }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("a running organization automation resolves its route grants again after revocation", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "running automation observes current route grants",
        files: backofficeFiles.workspaceStarter(),
        setup: ({ given }) => [
          given.auth.user({ id: "owner-1", role: "admin" }),
          given.auth.organization({
            id: "org-1",
            name: "Ada Labs",
            ownerUserId: "owner-1",
            ownerRoles: ["owner"],
          }),
          given.organization.exists({
            id: "org-1",
            name: "Ada Labs",
            ownerUserId: "owner-1",
          }),
          given.direct.file({
            orgId: "org-1",
            path: "/workspace/automations/live-automation-grant.workflow.js",
            content: liveGrantWorkflowSource,
          }),
          given.router.route({
            orgId: "org-1",
            id: "live-grant",
            name: "Live automation grant",
            enabled: true,
            priority: 100,
            trigger: {
              kind: "event",
              source: "authority-test",
              eventType: "authority.requested",
              matcher: { path: "$.payload.id", op: "exists" },
            },
            action: {
              kind: "start_workflow",
              authority: {
                kind: "organization-automation",
                grants: [BACKOFFICE_PERMISSION.store.modify],
              },
              workflowScriptPath: "/workspace/automations/live-automation-grant.workflow.js",
              instanceIdTemplate: "live-grant-${event.id}",
            },
          }),
        ],
        steps: ({ when, then }) => [
          when.automation.ingestEvent(authorityEvent({ id: "event-1" })),
          then.store.entry({
            orgId: "org-1",
            key: "authority/before-revocation",
            value: "written",
          }),
          then.workflow.instance({
            remoteWorkflowName: "live-automation-grant",
            instanceId: "live-grant-event-1",
            status: "waiting",
            waitingFor: "continue-after-revocation",
          }),
          when.router.updateRoute({
            orgId: "org-1",
            id: "live-grant",
            action: {
              kind: "start_workflow",
              authority: { kind: "organization-automation", grants: [] },
              workflowScriptPath: "/workspace/automations/live-automation-grant.workflow.js",
              instanceIdTemplate: "live-grant-${event.id}",
            },
          }),
          when.workflow.sendEvent({
            orgId: "org-1",
            instanceId: "live-grant-event-1",
            type: "continue-after-revocation",
            payload: {},
          }),
          then.workflow.instance({
            remoteWorkflowName: "live-automation-grant",
            instanceId: "live-grant-event-1",
            status: "errored",
          }),
          then.store.missing({ orgId: "org-1", key: "authority/after-revocation" }),
        ],
        options: { allowErroredWorkflows: true },
      }),
    );
  });

  test("delegated-user cannot exceed the route automation capability grant", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "delegated user authority is an intersection",
        files: backofficeFiles.workspaceStarter(),
        setup: ({ given }) => [
          given.auth.user({ id: "owner-1", role: "admin" }),
          given.auth.user({ id: "user-1", role: "user" }),
          given.auth.organization({
            id: "org-1",
            name: "Ada Labs",
            ownerUserId: "owner-1",
            ownerRoles: ["owner"],
          }),
          given.auth.member({ orgId: "org-1", userId: "user-1", roles: ["member"] }),
          given.organization.exists({
            id: "org-1",
            name: "Ada Labs",
            ownerUserId: "owner-1",
          }),
          given.direct.file({
            orgId: "org-1",
            path: "/workspace/automations/authority-mode.workflow.js",
            content: workflowSource,
          }),
          given.router.route({
            orgId: "org-1",
            id: "delegated-intersection",
            name: "Delegated intersection",
            enabled: true,
            priority: 100,
            trigger: {
              kind: "event",
              source: "authority-test",
              eventType: "authority.requested",
              matcher: { path: "$.payload.id", op: "exists" },
            },
            action: {
              kind: "start_workflow",
              authority: {
                kind: "delegated-user",
                grants: [BACKOFFICE_PERMISSION.store.modify],
              },
              workflowScriptPath: "/workspace/automations/authority-mode.workflow.js",
              instanceIdTemplate: "intersection-${event.id}",
            },
          }),
        ],
        steps: ({ when, then }) => [
          when.automation.ingestEvent(
            authorityEvent({
              id: "event-1",
              principal: {
                scope: "internal",
                type: "user",
                id: "user-1",
                role: "principal",
              },
            }),
          ),
          then.workflow.instance({
            remoteWorkflowName: "authority-mode",
            instanceId: "intersection-event-1",
            status: "complete",
          }),
          then.assert(
            "the automation delegate restricts otherwise valid user authority",
            async (ctx) => {
              const scope = { kind: "org" as const, orgId: "org-1" };
              const workflows = createWorkflowsRouteCaller({
                object: ctx.runtime.objects.automations.forOrg("org-1"),
                context: {
                  execution: createBackofficeSystemExecution(scope),
                  propagationContext: null,
                },
              });
              const response = await workflows("GET", "/:workflowName/instances/:instanceId", {
                pathParams: {
                  workflowName: "codemode-script",
                  instanceId: "intersection-event-1",
                },
              });
              assert(response.type === "json");
              if (response.type !== "json") {
                throw new Error("Delegated workflow instance was not available.");
              }

              const params = response.data.meta.params as { execution?: { actors?: unknown } };
              const actors = automationActorsSchema.parse(params.execution?.actors);
              const kernel = new BackofficeKernel(ctx.runtime.services);

              await expect(
                kernel.assertAuthorized({
                  execution: createBackofficeUserExecution({ scope, userId: "user-1" }),
                  operation: BACKOFFICE_PERMISSION.events.emit,
                }),
              ).resolves.toBeUndefined();
              await expect(
                kernel.assertAuthorized({
                  execution: { kind: "deferred" as const, scopeRestriction: null, scope, actors },
                  operation: BACKOFFICE_PERMISSION.events.emit,
                }),
              ).rejects.toMatchObject({ reason: "actor-capability-denied" });
            },
          ),
        ],
      }),
    );
  });
});
