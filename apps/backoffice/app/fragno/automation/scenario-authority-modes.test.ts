import { describe, expect, test, vi, assert } from "vitest";

import {
  createBackofficeSystemExecution,
  createBackofficeUserExecution,
} from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import { BACKOFFICE_PERMISSION } from "@/backoffice-runtime/permissions";
import { BACKOFFICE_PI_WORKFLOW_NAME } from "@/fragno/pi/pi-shared";
import { createPiRouteRuntime } from "@/fragno/runtime-tools/families/pi-runtime";

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

import { automationActorsSchema, BACKOFFICE_WORKFLOW_ACTORS_METADATA_KEY } from "./actors";
import type { AutomationEvent } from "./contracts";
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

const piCreatingWorkflowSource = `defineWorkflow(
  { name: "authority-mode-pi-session" },
  async (_event, step) => {
    return await step.do("create pi session", async () => {
      return await pi.createSession({ name: "Organization automation session" });
    });
  },
);
`;

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
                  authority: { kind: "organization-automation" },
                  workflowScriptPath: "/workspace/automations/authority-mode.workflow.js",
                  instanceIdTemplate: "organization-${event.id}",
                },
              },
            });
            assert(response.type === "json");
          }),
          when.automation.ingestEvent(
            authorityEvent({
              id: "event-1",
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

  test("organization automation persists its resolved authority in created Pi sessions", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "organization automation owns its created Pi session authority",
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
          given.pi.configured({ scope: { kind: "org", orgId: "org-1" } }),
          given.direct.file({
            orgId: "org-1",
            path: "/workspace/automations/authority-mode-pi-session.workflow.js",
            content: piCreatingWorkflowSource,
          }),
          given.router.route({
            orgId: "org-1",
            id: "organization-pi-authority",
            name: "Organization Pi authority",
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
              authority: { kind: "organization-automation" },
              workflowScriptPath: "/workspace/automations/authority-mode-pi-session.workflow.js",
              instanceIdTemplate: "organization-pi-${event.id}",
            },
          }),
        ],
        steps: ({ when, then }) => [
          when.automation.ingestEvent(
            authorityEvent({
              id: "event-pi",
              principal: {
                scope: "internal",
                type: "user",
                id: "creator-1",
                role: "principal",
              },
            }),
          ),
          then.workflow.instance({
            remoteWorkflowName: "authority-mode-pi-session",
            instanceId: "organization-pi-event-pi",
            status: "complete",
          }),
          then.assert(
            "the Pi session retains the organization automation principal",
            async (ctx) => {
              const scope = { kind: "org" as const, orgId: "org-1" };
              const execution = createBackofficeSystemExecution(scope);
              const object = ctx.runtime.objects.automations.forOrg("org-1");
              const pi = createPiRouteRuntime({ object, scope, execution });
              const sessions = await pi.listSessions({});
              expect(sessions).toHaveLength(1);
              const sessionId = sessions[0]?.id;
              if (!sessionId) {
                throw new Error("The organization automation did not create a Pi session.");
              }

              const workflows = createWorkflowsRouteCaller({
                object,
                context: { execution, propagationContext: null },
              });
              const response = await workflows("GET", "/:workflowName/instances/:instanceId", {
                pathParams: { workflowName: BACKOFFICE_PI_WORKFLOW_NAME, instanceId: sessionId },
              });
              assert(response.type === "json");
              const params = response.data.meta.params as { metadata?: Record<string, unknown> };
              const actors = automationActorsSchema.parse(
                params.metadata?.[BACKOFFICE_WORKFLOW_ACTORS_METADATA_KEY],
              );

              expect(actors).toEqual({
                initiator: {
                  scope: "external",
                  source: "authority-test",
                  type: "request",
                  id: "request:event-pi",
                  role: "initiator",
                },
                principal: {
                  scope: "internal",
                  type: "automation",
                  id: "automation-route:organization-pi-authority",
                  role: "principal",
                },
                delegation: [],
              });
            },
          ),
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
              authority: { kind: "delegated-user" },
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
              authority: { kind: "delegated-user" },
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
                  execution: { scope, actors },
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
