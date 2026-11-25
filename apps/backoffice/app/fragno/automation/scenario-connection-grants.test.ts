import { assert, describe, expect, test } from "vitest";

import type {
  AutomationGrantedConnection,
  AutomationRouteGrant,
} from "@fragno-dev/backoffice-api/v0/automation";
import type { AutomationEvent } from "@fragno-dev/backoffice-api/v0/events";
import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";

import {
  createBackofficeRequestExecution,
  createBackofficeSystemExecution,
} from "@/backoffice-runtime/context";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";

import { ApiObject } from "../../../workers/api-object";
import { AppInstallationsObject } from "../../../workers/app-installations-object";
import { AppsObject } from "../../../workers/apps-object";
import { AuthObject } from "../../../workers/auth-object";
import { AutomationsObject } from "../../../workers/automations-object";
import { BillingObject } from "../../../workers/billing-object";
import { CodemodeObject } from "../../../workers/codemode-object";
import { GitHubObject } from "../../../workers/github-object";
import { GitHubWebhookRouterObject } from "../../../workers/github-webhook-router-object";
import { McpObject } from "../../../workers/mcp-object";
import { OtpObject } from "../../../workers/otp-object";
import { ProjectConnectorObject } from "../../../workers/project-connector-object";
import { ResendObject } from "../../../workers/resend-object";
import { TelegramObject } from "../../../workers/telegram-object";
import { UploadObject } from "../../../workers/upload-object";
import { createAutomationsRouteCaller, createWorkflowsRouteCaller } from "./route-callers";
import {
  backofficeFiles,
  type BackofficeScenarioContext,
  type BackofficeScenarioDefinitionInput,
  defineBackofficeScenario,
  runBackofficeScenario,
} from "./scenario";

const providerOrigin = "https://provider.test";
const providerRequests: string[] = [];

const scenarioObjects = {
  API: (input) =>
    new ApiObject({
      ...input,
      fetch: async (request, init) => {
        const url = new URL(new Request(request, init).url);
        providerRequests.push(`${url.host}${url.pathname}`);
        return Response.json({ ok: true });
      },
    }),
  APPS: (input) => new AppsObject(input),
  APP_INSTALLATIONS: (input) => new AppInstallationsObject(input),
  AUTH: (input) => new AuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new AutomationsObject(input),
  BILLING: (input) => new BillingObject(input),
  CODEMODE: (input) => new CodemodeObject(input),
  MCP: (input) => new McpObject(input),
  OTP: (input) => new OtpObject(input),
  RESEND: (input) => new ResendObject(input),
  TELEGRAM: (input) => new TelegramObject(input),
  UPLOAD: (input) => new UploadObject(input),
  GITHUB: (input) => new GitHubObject(input),
  GITHUB_WEBHOOK_ROUTER: (input) => new GitHubWebhookRouterObject(input),
  PROJECT_CONNECTOR: (input) => new ProjectConnectorObject(input),
} satisfies LocalBackofficeObjects;

const organizations = ["org-1", "org-2"] as const;

function organizationScope(orgId: string) {
  return { kind: "org" as const, orgId, jurisdiction: null };
}

/** `integrations.execute` on the named connections. */
function executeOn(...connections: AutomationGrantedConnection[]): AutomationRouteGrant {
  return { ...BACKOFFICE_PERMISSION.integrations.execute, connections };
}

/**
 * Executes each call the event names, `orgId` null for the route's own scope, and returns what
 * happened to each: `allowed`, or the denial's message.
 */
const callsWorkflowSource = `export default defineWorkflow({ name: "calls" }, async (event, step) => {
  return await step.do("call connections", async () => {
    const outcomes = [];
    for (const { orgId, connectionId } of event.payload.calls) {
      const scoped = orgId === null ? integrations : context.org(orgId).integrations;
      try {
        await scoped.execute({
          connectionId,
          actionId: "request",
          input: { method: "GET", path: "/" + connectionId.slice(4), body: { type: "empty" } },
        });
        outcomes.push("allowed");
      } catch (error) {
        outcomes.push(String(error && error.message || error));
      }
    }
    return outcomes;
  });
});
`;

/**
 * Creates a route whose authority and grants are the event's, and returns whether saving it was
 * allowed.
 */
const createRouteWorkflowSource = `export default defineWorkflow({ name: "create-route" }, async (event, step) => {
  return await step.do("create route", async () => {
    try {
      await router.create({
        id: event.payload.routeId,
        name: "Created by a route",
        enabled: false,
        trigger: { kind: "event", source: "elsewhere", eventType: "noop", matcher: null },
        action: {
          kind: "start_workflow",
          authority: { kind: event.payload.authority, grants: event.payload.grants },
          workflowScriptPath: "/workspace/automations/calls.workflow.js",
          instanceIdTemplate: "created-\${event.id}",
        },
      });
      return "allowed";
    } catch (error) {
      return String(error && error.message || error);
    }
  });
});
`;

const user1 = { scope: "internal", type: "user", id: "user-1", role: "principal" } as const;

function callsEvent(
  id: string,
  calls: { orgId: string | null; connectionId: string }[],
  principal: AutomationEvent["actors"]["principal"] = null,
): AutomationEvent {
  const scope = organizationScope("org-1");
  return {
    id,
    scopeRestriction: null,
    scope,
    source: "connection-test",
    eventType: "calls.requested",
    occurredAt: "2026-11-16T00:00:00.000Z",
    sequence: null,
    payload: { calls },
    actors: { ...createBackofficeSystemExecution(scope).actors, principal },
    subject: { scope },
    causation: { kind: "origin" },
  };
}

async function workflowOutput(ctx: BackofficeScenarioContext, instanceId: string) {
  const scope = organizationScope("org-1");
  const workflows = createWorkflowsRouteCaller({
    object: ctx.runtime.objects.automations.for(scope),
    context: { execution: createBackofficeSystemExecution(scope), propagationContext: null },
  });
  const response = await workflows("GET", "/:workflowName/instances/:instanceId", {
    pathParams: { workflowName: "codemode-script", instanceId },
  });
  assert(response.type === "json");
  return response.data.details.output;
}

/**
 * Two organizations, each with the API connections `api#billing` and `api#crm`, and a member of
 * both, `user-1`, who is not a member of a third, `org-3`. org-1 has a route on `connection-test`
 * events that starts `workflow` with `authority`.
 */
function connectionsScenario({
  name,
  authority,
  workflow,
  steps,
}: {
  name: string;
  authority:
    | { kind: "organization-automation"; grants: AutomationRouteGrant[] }
    | { kind: "delegated-user"; grants: AutomationRouteGrant[] };
  workflow: "calls" | "create-route";
  steps: BackofficeScenarioDefinitionInput["steps"];
}) {
  providerRequests.length = 0;
  return defineBackofficeScenario({
    objects: scenarioObjects,
    name,
    files: backofficeFiles.workspaceStarter(),
    setup: ({ given }) => [
      given.auth.user({ id: "owner-1", role: "admin" }),
      given.auth.user({ id: "user-1", role: "user" }),
      ...organizations.flatMap((orgId) => [
        given.auth.organization({
          id: orgId,
          name: orgId,
          ownerUserId: "owner-1",
          ownerRoles: ["owner"],
        }),
        given.auth.member({ orgId, userId: "user-1", roles: ["member"] }),
        given.organization.exists({ id: orgId, name: orgId, ownerUserId: "owner-1" }),
      ]),
      given.auth.organization({
        id: "org-3",
        name: "org-3",
        ownerUserId: "owner-1",
        ownerRoles: ["owner"],
      }),
      given.organization.exists({ id: "org-3", name: "org-3", ownerUserId: "owner-1" }),
      given.direct.file({
        orgId: "org-1",
        path: "/workspace/automations/calls.workflow.js",
        content: callsWorkflowSource,
      }),
      given.direct.file({
        orgId: "org-1",
        path: "/workspace/automations/create-route.workflow.js",
        content: createRouteWorkflowSource,
      }),
      given.router.route({
        orgId: "org-1",
        id: "connections",
        name: "Connections",
        enabled: true,
        priority: 100,
        trigger: {
          kind: "event",
          source: "connection-test",
          eventType: "calls.requested",
          matcher: null,
        },
        action: {
          kind: "start_workflow",
          authority,
          workflowScriptPath: `/workspace/automations/${workflow}.workflow.js`,
          instanceIdTemplate: "connections-${event.id}",
        },
      }),
    ],
    steps: (builders) => [
      builders.then.assert("each organization connects its billing and CRM APIs", async (ctx) => {
        for (const orgId of organizations) {
          for (const slug of ["billing", "crm"]) {
            await ctx.runCodemode({
              scope: organizationScope(orgId),
              code: `async () => await integrations.setup({ kind: "input", connectionId: "api#${slug}", input: {
                type: "none", baseUrl: "${providerOrigin}/${orgId}",
              } })`,
            });
          }
        }
      }),
      ...steps(builders),
    ],
  });
}

describe("routes grant integrations.execute on named connections", () => {
  test("a route executes on the connections it grants and is denied any other", async () => {
    await runBackofficeScenario(
      connectionsScenario({
        name: "route executes only on its granted connections",
        authority: {
          kind: "organization-automation",
          grants: [
            executeOn({ scope: { kind: "current" }, connectionId: "api#billing" }),
            BACKOFFICE_PERMISSION.connections.read,
          ],
        },
        workflow: "calls",
        steps: ({ when, then }) => [
          when.automation.ingestEvent(
            callsEvent("event-1", [
              { orgId: null, connectionId: "api#billing" },
              { orgId: null, connectionId: "api#crm" },
            ]),
          ),
          then.workflow.instance({ instanceId: "connections-event-1", status: "complete" }),
          then.assert(
            "billing answers and CRM is denied, naming what the route grants",
            async (ctx) => {
              const [billing, crm] = (await workflowOutput(ctx, "connections-event-1")) as string[];
              expect(billing).toBe("allowed");
              expect(crm).toContain(
                "The current principal 'automation-route/org:org-1/connections' is not granted this connection: it may execute on org:org-1 api#billing, not on org:org-1 api#crm.",
              );
              expect(providerRequests).toEqual(["provider.test/org-1/billing"]);
            },
          ),
        ],
      }),
    );
  });

  test("a granted connection is the one in its scope, also when another scope has its address", async () => {
    await runBackofficeScenario(
      connectionsScenario({
        name: "delegated route executes on another organization's connection it names",
        authority: {
          kind: "delegated-user",
          grants: [
            executeOn(
              { scope: { kind: "current" }, connectionId: "api#crm" },
              { scope: { kind: "org", orgId: "org-2" }, connectionId: "api#billing" },
            ),
            BACKOFFICE_PERMISSION.connections.read,
          ],
        },
        workflow: "calls",
        steps: ({ when, then }) => [
          when.automation.ingestEvent(
            callsEvent(
              "event-1",
              [
                { orgId: "org-2", connectionId: "api#billing" },
                { orgId: null, connectionId: "api#billing" },
                { orgId: "org-2", connectionId: "api#crm" },
                { orgId: null, connectionId: "api#crm" },
              ],
              user1,
            ),
          ),
          then.workflow.instance({ instanceId: "connections-event-1", status: "complete" }),
          then.assert("each address is allowed only in the scope the route names", async (ctx) => {
            const outcomes = (await workflowOutput(ctx, "connections-event-1")) as string[];
            assert(outcomes[0] === "allowed");
            expect(outcomes[1]).toContain("not on org:org-1 api#billing");
            expect(outcomes[2]).toContain("not on org:org-2 api#crm");
            assert(outcomes[3] === "allowed");
            expect(providerRequests).toEqual([
              "provider.test/org-2/billing",
              "provider.test/org-1/crm",
            ]);
          }),
        ],
      }),
    );
  });

  test("only a user-backed route grants connections beyond its organization", async () => {
    const saveRoute = (
      ctx: BackofficeScenarioContext,
      routeId: string,
      authority: "organization-automation" | "delegated-user",
      orgId: string,
    ) => {
      const scope = organizationScope("org-1");
      // A request from the Backoffice UI, whose verified authority covers org-1 only.
      const routes = createAutomationsRouteCaller({
        object: ctx.runtime.objects.automations.for(scope),
        context: {
          execution: createBackofficeRequestExecution({
            scope,
            verifiedRequestAuthority: {
              userId: "user-1",
              personalScope: null,
              role: "user",
              organization: scope,
              administeredMember: null,
              expiresAt: new Date(Date.now() + 60_000),
              scopeRestriction: null,
            },
          }),
          propagationContext: null,
        },
      });
      return routes("POST", "/routes", {
        body: {
          id: routeId,
          name: routeId,
          enabled: false,
          priority: 100,
          trigger: { kind: "event", source: "elsewhere", eventType: "noop", matcher: null },
          action: {
            kind: "start_workflow",
            authority: {
              kind: authority,
              grants: [executeOn({ scope: { kind: "org", orgId }, connectionId: "api#billing" })],
            },
            workflowScriptPath: "/workspace/automations/calls.workflow.js",
            instanceIdTemplate: `${routeId}-\${event.id}`,
          },
        },
      });
    };
    await runBackofficeScenario(
      connectionsScenario({
        name: "user-backed routes name other organizations' connections",
        authority: { kind: "organization-automation", grants: [] },
        workflow: "calls",
        steps: ({ then }) => [
          then.assert(
            "a delegated route saves, also naming an organization its author is not in",
            async (ctx) => {
              for (const orgId of ["org-2", "org-3"]) {
                expect(
                  await saveRoute(ctx, `delegated-${orgId}`, "delegated-user", orgId),
                ).toMatchObject({ type: "json" });
              }
            },
          ),
          then.assert(
            "an organization automation, which never reaches org-2, is refused",
            async (ctx) => {
              expect(
                await saveRoute(ctx, "automation-org-2", "organization-automation", "org-2"),
              ).toMatchObject({
                type: "error",
                status: 403,
                error: {
                  code: "context-access-denied",
                  message:
                    "An organization automation acts only in its route's scope and the projects it owns, so it cannot be granted api#billing in org:org-2.",
                },
              });
            },
          ),
        ],
      }),
    );
  });

  test("a route grants only connections whoever saves it may execute on", async () => {
    const grantsOf = (connectionId: string) => [
      executeOn({ scope: { kind: "current" }, connectionId }),
    ];
    await runBackofficeScenario(
      connectionsScenario({
        name: "a route's workflow saves routes within its own connections",
        authority: {
          kind: "organization-automation",
          grants: [
            BACKOFFICE_PERMISSION.router.modify,
            executeOn({ scope: { kind: "current" }, connectionId: "api#billing" }),
          ],
        },
        workflow: "create-route",
        steps: ({ when, then }) => [
          when.automation.ingestEvent({
            ...callsEvent("within", []),
            payload: {
              routeId: "billing-only",
              authority: "organization-automation",
              grants: grantsOf("api#billing"),
            },
          }),
          when.automation.ingestEvent({
            ...callsEvent("beyond", []),
            payload: {
              routeId: "crm-too",
              authority: "organization-automation",
              grants: grantsOf("api#crm"),
            },
          }),
          then.assert("the route it may execute on saves, the other is refused", async (ctx) => {
            assert((await workflowOutput(ctx, "connections-within")) === "allowed");
            expect(await workflowOutput(ctx, "connections-beyond")).toContain(
              "it may execute on org:org-1 api#billing, not on org:org-1 api#crm",
            );
          }),
          then.router.route({ orgId: "org-1", id: "billing-only", enabled: false }),
        ],
      }),
    );
  });

  test("an organization automation that may change routes cannot save one inheriting a person's permissions", async () => {
    await runBackofficeScenario(
      connectionsScenario({
        name: "an organization automation saves a route with inherited grants",
        authority: {
          kind: "organization-automation",
          grants: [BACKOFFICE_PERMISSION.router.modify],
        },
        workflow: "create-route",
        steps: ({ when, then }) => [
          when.automation.ingestEvent({
            ...callsEvent("inherit", []),
            payload: { routeId: "inherits", authority: "delegated-user", grants: "inherit" },
          }),
          then.assert("saving it is refused", async (ctx) => {
            expect(await workflowOutput(ctx, "connections-inherit")).toContain(
              "The current principal 'automation-route/org:org-1/connections' is not granted",
            );
          }),
        ],
      }),
    );
  });

  test("a user-backed route grants connections elsewhere only if whoever saves it may execute on them", async () => {
    await runBackofficeScenario(
      connectionsScenario({
        name: "a user's route saves user-backed routes naming org-2's connections",
        authority: {
          kind: "delegated-user",
          grants: [
            BACKOFFICE_PERMISSION.router.modify,
            executeOn(
              { scope: { kind: "current" }, connectionId: "api#billing" },
              { scope: { kind: "org", orgId: "org-2" }, connectionId: "api#crm" },
            ),
          ],
        },
        workflow: "create-route",
        steps: ({ when, then }) => [
          // A user-backed route acts as whoever sets it off, such as a personal schedule as its
          // scope's owner, with only its own grants narrowing them, so they are its saver's to give:
          // here user-1's, as this route narrows them.
          when.automation.ingestEvent({
            ...callsEvent("within", [], user1),
            payload: {
              routeId: "org-2-crm",
              authority: "delegated-user",
              grants: [
                executeOn({ scope: { kind: "org", orgId: "org-2" }, connectionId: "api#crm" }),
              ],
            },
          }),
          when.automation.ingestEvent({
            ...callsEvent("beyond", [], user1),
            payload: {
              routeId: "org-2-billing",
              authority: "delegated-user",
              grants: [
                executeOn({ scope: { kind: "org", orgId: "org-2" }, connectionId: "api#billing" }),
              ],
            },
          }),
          then.assert(
            "the connection it may execute on saves, the other is refused",
            async (ctx) => {
              assert((await workflowOutput(ctx, "connections-within")) === "allowed");
              expect(await workflowOutput(ctx, "connections-beyond")).toContain(
                "not on org:org-2 api#billing",
              );
            },
          ),
          then.router.route({ orgId: "org-1", id: "org-2-crm", enabled: false }),
        ],
      }),
    );
  });
});
