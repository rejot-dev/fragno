import { describe, expect, test, vi, assert } from "vitest";

import { automationActorsSchema } from "@fragno-dev/backoffice-api/v0/automation";
import type { AutomationEvent } from "@fragno-dev/backoffice-api/v0/events";
import {
  BACKOFFICE_PERMISSION,
  type BackofficePermissionRequirement,
} from "@fragno-dev/backoffice-api/v0/shared/permissions";

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

import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";

import { ApiObject } from "../../../workers/api-object";
import { AppInstallationsObject } from "../../../workers/app-installations-object";
import { AppsObject } from "../../../workers/apps-object";
import { AuthObject } from "../../../workers/auth-object";
import { AutomationsObject } from "../../../workers/automations-object";
import { BillingObject } from "../../../workers/billing-object";
import { CodemodeObject } from "../../../workers/codemode-object";
import { FormsObject } from "../../../workers/forms-object";
import { GitHubObject } from "../../../workers/github-object";
import { GitHubWebhookRouterObject } from "../../../workers/github-webhook-router-object";
import { McpObject } from "../../../workers/mcp-object";
import { OtpObject } from "../../../workers/otp-object";
import { ProjectConnectorObject } from "../../../workers/project-connector-object";
import { ResendObject } from "../../../workers/resend-object";
import { TelegramObject } from "../../../workers/telegram-object";
import { UploadObject } from "../../../workers/upload-object";
import { CODEMODE_WORKFLOW, codemodeWorkflowParamsSchema } from "./engine/codemode-invocation";
import { createAutomationsRouteCaller, createWorkflowsRouteCaller } from "./route-callers";
import {
  backofficeFiles,
  type BackofficeScenarioDefinitionInput,
  defineBackofficeScenario,
  runBackofficeScenario,
} from "./scenario";

const scenarioObjects = {
  API: (input) => new ApiObject(input),
  APPS: (input) => new AppsObject(input),
  APP_INSTALLATIONS: (input) => new AppInstallationsObject(input),
  AUTH: (input) => new AuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new AutomationsObject(input),
  BILLING: (input) => new BillingObject(input),
  CODEMODE: (input) => new CodemodeObject(input),
  FORMS: (input) => new FormsObject(input),
  MCP: (input) => new McpObject(input),
  OTP: (input) => new OtpObject(input),
  RESEND: (input) => new ResendObject(input),
  TELEGRAM: (input) => new TelegramObject(input),
  UPLOAD: (input) => new UploadObject(input),
  GITHUB: (input) => new GitHubObject(input),
  GITHUB_WEBHOOK_ROUTER: (input) => new GitHubWebhookRouterObject(input),
  PROJECT_CONNECTOR: (input) => new ProjectConnectorObject(input),
} satisfies LocalBackofficeObjects;

const authorityEvent = ({
  id,
  principal = null,
}: {
  id: string;
  principal?: AutomationEvent["actors"]["principal"];
}): AutomationEvent => ({
  id,
  scopeRestriction: null,
  scope: { kind: "org", orgId: "org-1", jurisdiction: null },
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
  subject: { scope: { kind: "org", orgId: "org-1", jurisdiction: null } },
  causation: { kind: "origin" },
});

const workflowSource = `export default defineWorkflow(
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

const otherOrganizationWorkflowSource = `export default defineWorkflow(
  { name: "other-organization" },
  async (event, step) => {
    const eventId = event.id;
    await step.do("write in the other organization", async () => {
      await context.org("org-2").store.set({ key: "authority/" + eventId, value: "written" });
    });
    return { eventId };
  },
);
`;

/** A delegated-user route in org-1 whose workflow writes to org-2, where its user is a member. */
const otherOrganizationScenario = ({
  name,
  grants,
  outcome,
  allowErroredWorkflows = false,
}: {
  name: string;
  grants: BackofficePermissionRequirement[];
  outcome: BackofficeScenarioDefinitionInput["steps"];
  allowErroredWorkflows?: boolean;
}) =>
  defineBackofficeScenario({
    objects: scenarioObjects,
    name,
    options: { allowErroredWorkflows },
    files: backofficeFiles.workspaceStarter(),
    setup: ({ given }) => [
      given.auth.user({ id: "owner-1", role: "admin" }),
      given.auth.user({ id: "user-1", role: "user" }),
      ...["org-1", "org-2"].flatMap((orgId) => [
        given.auth.organization({
          id: orgId,
          name: orgId,
          ownerUserId: "owner-1",
          ownerRoles: ["owner"],
        }),
        given.auth.member({ orgId, userId: "user-1", roles: ["member"] }),
        given.organization.exists({ id: orgId, name: orgId, ownerUserId: "owner-1" }),
      ]),
      given.direct.file({
        orgId: "org-1",
        path: "/workspace/automations/other-organization.workflow.js",
        content: otherOrganizationWorkflowSource,
      }),
      given.router.route({
        orgId: "org-1",
        id: "delegated-elsewhere",
        name: "Delegated elsewhere",
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
          authority: { kind: "delegated-user", grants },
          workflowScriptPath: "/workspace/automations/other-organization.workflow.js",
          instanceIdTemplate: "elsewhere-${event.id}",
        },
      }),
    ],
    steps: (builders) => [
      builders.when.automation.ingestEvent(
        authorityEvent({
          id: "event-1",
          principal: { scope: "internal", type: "user", id: "user-1", role: "principal" },
        }),
      ),
      ...outcome(builders),
    ],
  });

const liveGrantWorkflowSource = `export default defineWorkflow(
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
        objects: scenarioObjects,
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
            const scope = { kind: "org" as const, orgId: "org-1", jurisdiction: null };
            const routes = createAutomationsRouteCaller({
              object: ctx.runtime.objects.automations.for({
                kind: "org",
                orgId: "org-1",
                jurisdiction: null,
              }),
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
            scopeRestriction: { kind: "org", orgId: "org-1", jurisdiction: null },
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
                .for({ kind: "org", orgId: "org-1", jurisdiction: null })
                .http.fetchAuthorized(
                  new Request(
                    `https://automations.test/api/workflows/${CODEMODE_WORKFLOW}/instances/organization-event-1`,
                  ),
                  {
                    execution: createBackofficeSystemExecution({
                      kind: "org",
                      orgId: "org-1",
                      jurisdiction: null,
                    }),
                  },
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
        objects: scenarioObjects,
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
                  id: "automation-route/org:org-1/delegated-authority",
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
                  id: "automation-route/org:org-1/delegated-authority",
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

  test("delegated-user route grants follow its workflow into another scope", async () => {
    await runBackofficeScenario(
      otherOrganizationScenario({
        name: "delegated user route acts in another organization",
        grants: [BACKOFFICE_PERMISSION.store.modify],
        outcome: ({ then }) => [
          then.workflow.instance({
            remoteWorkflowName: "other-organization",
            instanceId: "elsewhere-event-1",
            status: "complete",
            actors: {
              principal: { type: "user", id: "user-1", role: "principal" },
              delegation: [
                {
                  type: "automation",
                  id: "automation-route/org:org-1/delegated-elsewhere",
                  role: "delegate",
                },
              ],
            },
          }),
          then.store.entry({ orgId: "org-2", key: "authority/event-1", value: "written" }),
        ],
      }),
    );
  });

  test("delegated-user route grants still narrow the user in another scope", async () => {
    await runBackofficeScenario(
      otherOrganizationScenario({
        name: "delegated user route is narrowed in another organization",
        grants: [BACKOFFICE_PERMISSION.store.read],
        outcome: ({ then }) => [
          then.workflow.instance({
            remoteWorkflowName: "other-organization",
            instanceId: "elsewhere-event-1",
            status: "errored",
          }),
          then.assert("the route's own grants deny the write", async (ctx) => {
            const workflows = createWorkflowsRouteCaller({
              object: ctx.runtime.objects.automations.for({
                kind: "org",
                orgId: "org-1",
                jurisdiction: null,
              }),
              context: {
                execution: createBackofficeSystemExecution({
                  kind: "org",
                  orgId: "org-1",
                  jurisdiction: null,
                }),
                propagationContext: null,
              },
            });
            const response = await workflows("GET", "/:workflowName/instances/:instanceId", {
              pathParams: { workflowName: "codemode-script", instanceId: "elsewhere-event-1" },
            });
            assert(response.type === "json");
            expect(response.data.details.error?.message).toContain(
              "Delegated automation 'automation-route/org:org-1/delegated-elsewhere' is not granted store.modify",
            );
          }),
          then.store.missing({ orgId: "org-2", key: "authority/event-1" }),
        ],
        allowErroredWorkflows: true,
      }),
    );
  });

  test("linked-user resolves the external initiator before starting the workflow", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
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
                  id: "automation-route/org:org-1/linked-authority",
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
        objects: scenarioObjects,
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
        objects: scenarioObjects,
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
              const scope = { kind: "org" as const, orgId: "org-1", jurisdiction: null };
              const workflows = createWorkflowsRouteCaller({
                object: ctx.runtime.objects.automations.for({
                  kind: "org",
                  orgId: "org-1",
                  jurisdiction: null,
                }),
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
