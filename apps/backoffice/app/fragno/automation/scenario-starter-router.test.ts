import { assert, describe, expect, test, vi } from "vitest";

import type { AutomationEvent } from "@fragno-dev/backoffice-api/v0/events";
import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";

import { and, eq, queryOnce } from "@tanstack/react-db";

import { getStaticMarketplaceEntry } from "@/fragno/marketplace/static-entries";

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

vi.mock("cloudflare:workers", () => ({
  DurableObject,
  RpcTarget,
  WorkerEntrypoint,
}));

import { allLocalObjects } from "@/backoffice-runtime/all-local-objects";
import { createBackofficeServiceExecution } from "@/backoffice-runtime/context";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";

import { InMemoryApiObject } from "../../../workers/api.do";
import { InMemoryAppInstallationsObject } from "../../../workers/app-installations.do";
import { InMemoryAppsObject } from "../../../workers/apps.do";
import { InMemoryAuthObject } from "../../../workers/auth.do";
import { InMemoryAutomationsObject } from "../../../workers/automations.do";
import { InMemoryBillingObject } from "../../../workers/billing.do";
import { InMemoryCodemodeObject } from "../../../workers/codemode.do";
import { InMemoryFormsObject } from "../../../workers/forms.do";
import { InMemoryMarketplaceObject } from "../../../workers/marketplace.do";
import { InMemoryMcpObject } from "../../../workers/mcp.do";
import { InMemoryResendObject } from "../../../workers/resend.do";
import { InMemoryTelegramObject } from "../../../workers/telegram.do";
import { InMemoryUploadObject } from "../../../workers/upload.do";
import type { AutomationRouteDispatchPayload } from "./internal-hooks";
import { readRouteDispatchState } from "./route-dispatches-storage-runtime";
import {
  backofficeFiles,
  type BackofficeScenarioContext,
  defineBackofficeScenario,
  runBackofficeScenario,
} from "./scenario";

const scenarioObjects = {
  API: (input) => new InMemoryApiObject(input),
  APPS: (input) => new InMemoryAppsObject(input),
  APP_INSTALLATIONS: (input) => new InMemoryAppInstallationsObject(input),
  AUTH: (input) => new InMemoryAuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new InMemoryAutomationsObject(input),
  BILLING: (input) => new InMemoryBillingObject(input),
  CODEMODE: (input) => new InMemoryCodemodeObject(input),
  FORMS: (input) => new InMemoryFormsObject(input),
  MARKETPLACE: (input) => new InMemoryMarketplaceObject(input),
  MCP: (input) => new InMemoryMcpObject(input),
  PI_MANAGER: allLocalObjects.PI_MANAGER,
  RESEND: (input) => new InMemoryResendObject(input),
  TELEGRAM: (input) => new InMemoryTelegramObject(input),
  UPLOAD: (input) => new InMemoryUploadObject(input),
} satisfies LocalBackofficeObjects;

const fanoutRetryProjectScope = {
  kind: "project",
  owner: { kind: "org", orgId: "org-1" },
  projectId: "fanout-retry-project",
} as const;

/** What each route matched to an event did, as the dashboard reads it. */
async function routeDispatchStates(ctx: BackofficeScenarioContext, eventId: string) {
  const database = ctx.tanstack.automations.forOrg("org-1");
  await database.drain();
  const dispatches = await queryOnce((query) =>
    query
      .from({ dispatch: database.collections.routeDispatches })
      .where(({ dispatch }) => eq(dispatch.eventId, eventId)),
  );
  return Object.fromEntries(
    dispatches.map((dispatch) => [dispatch.routeId, readRouteDispatchState(dispatch)]),
  );
}

const telegramTestCommandEntry = getStaticMarketplaceEntry({
  slug: "telegram-test-command",
  version: "1.4.0",
});
if (!telegramTestCommandEntry) {
  throw new Error("Expected the built-in Telegram test command Marketplace entry.");
}

const TELEGRAM_CHANNEL_MARKETPLACE_INSTALLATION = {
  targetScope: { kind: "org", orgId: "org-1" },
  slug: "telegram-channel",
  version: "1.2.0",
  // The Marketplace page's suggested folder, so nothing depends on where a package lands.
  installationRoot: "/workspace/telegram-channel",
} as const;

const marketplaceTelegramTestWorkspace = () =>
  backofficeFiles.workspaceStarter({
    "automations/telegram-test-command.workflow.js":
      telegramTestCommandEntry.files["automations/telegram-test-command.workflow.js"],
  });

const telegramTestCommandRoute = {
  id: "telegram-test-command",
  name: "Telegram /test command",
  enabled: true,
  trigger: {
    kind: "event" as const,
    source: "telegram",
    eventType: "message.received",
    matcher: { path: "$.payload.text", op: "eq" as const, value: "/test" },
  },
  priority: 110,
  action: {
    kind: "start_workflow" as const,
    authority: {
      kind: "organization-automation" as const,
      grants: [BACKOFFICE_PERMISSION.integrations.execute, BACKOFFICE_PERMISSION.store.read],
    },
    workflowScriptPath: "/workspace/automations/telegram-test-command.workflow.js",
    instanceIdTemplate: "telegram-test-${event.id}",
  },
};

const customAutomationEvent = ({
  id,
  source = "custom",
  eventType = "thing.happened",
  payload = {},
}: {
  id: string;
  source?: string;
  eventType?: string;
  payload?: Record<string, unknown>;
}): AutomationEvent => ({
  id,
  scopeRestriction: null,
  scope: { kind: "org", orgId: "org-1" },
  source,
  eventType,
  occurredAt: "2026-01-01T00:00:00.000Z",
  payload,
  actors: {
    initiator: {
      scope: "internal",
      type: "system",
      id: "scenario",
      role: "initiator",
    },
    principal: null,
    delegation: [],
  },
  subject: { orgId: "org-1" },
  causation: { kind: "origin" },
});

const telegramMessageEvent = ({
  id,
  text,
  chatId = "1001",
}: {
  id: string;
  text: string;
  chatId?: string;
}): AutomationEvent => {
  const actor = {
    scope: "external" as const,
    source: "telegram",
    type: "chat",
    id: chatId,
    role: "initiator" as const,
  };

  return {
    id,
    scopeRestriction: null,
    scope: { kind: "org", orgId: "org-1" },
    source: "telegram",
    eventType: "message.received",
    occurredAt: "2026-01-01T00:00:00.000Z",
    payload: {
      messageId: id,
      chatId,
      fromUserId: null,
      text,
    },
    actors: {
      initiator: actor,
      principal: null,
      delegation: [],
    },
    subject: { orgId: "org-1" },
    causation: { kind: "origin" },
  };
};

describe("starter automation router scenarios", () => {
  test("scenario TanStack DB helper drains and queries frontend-visible data", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "scenario TanStack DB helper drains and queries frontend-visible data",
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ then, when }) => [
          when.automation.ingestEvent(
            customAutomationEvent({
              id: "tanstack-event-1",
              payload: { ok: true },
            }),
          ),
          then.assert("assert event is visible through TanStack DB", async (ctx) => {
            const database = ctx.tanstack.automations.forOrg("org-1");
            await database.drain();
            const event = await queryOnce((query) =>
              query
                .from({ event: database.collections.events })
                .where(({ event }) => eq(event.id, "tanstack-event-1"))
                .findOne(),
            );
            assert.equal(event?.source, "custom");
            assert.equal(event?.eventType, "thing.happened");
          }),
          when.automation.ingestEvent(
            customAutomationEvent({
              id: "tanstack-event-2",
              payload: { updated: true },
            }),
          ),
          then.assert("assert a started TanStack DB scope catches up", async (ctx) => {
            const database = ctx.tanstack.automations.forOrg("org-1");
            await database.drain();
            const event = await queryOnce((query) =>
              query
                .from({ event: database.collections.events })
                .where(({ event }) => eq(event.id, "tanstack-event-2"))
                .findOne(),
            );
            assert.deepEqual(event?.payload, { updated: true });
          }),
        ],
      }),
    );
  });

  test("scenario TanStack DB exposes workflow state through the automation outbox", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "scenario TanStack DB exposes automation workflow state",
        files: marketplaceTelegramTestWorkspace(),
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ then, when }) => [
          when.workflow.createInstance({
            orgId: "org-1",
            instanceId: "tanstack-workflow-run",
            path: "/workspace/automations/telegram-test-command.workflow.js",
            event: telegramMessageEvent({
              id: "tanstack-workflow-event",
              text: "/test",
            }),
          }),
          then.assert("assert workflow instance and waiting step are visible", async (ctx) => {
            const database = ctx.tanstack.automations.forOrg("org-1");
            await database.drain();

            const instance = await queryOnce((query) =>
              query
                .from({ instance: database.collections.workflowInstances })
                .where(({ instance }) =>
                  and(
                    eq(instance.workflowName, "codemode-script"),
                    eq(instance.instanceId, "tanstack-workflow-run"),
                  ),
                )
                .findOne(),
            );
            assert(instance, "Expected the workflow instance to synchronize through TanStack DB.");
            assert.equal(instance.remoteWorkflowName, "telegram-test-command");
            assert.equal(instance.status, "waiting");

            const waitingStep = await queryOnce((query) =>
              query
                .from({ step: database.collections.workflowSteps })
                .where(({ step }) =>
                  and(eq(step.instanceRef, instance.id), eq(step.name, "wait 3 seconds")),
                )
                .findOne(),
            );
            assert(waitingStep, "Expected the workflow step to synchronize through TanStack DB.");
            assert.equal(waitingStep.type, "sleep");
            assert.equal(waitingStep.status, "waiting");
          }),
        ],
      }),
    );
  });

  test("scenario router helpers inspect Marketplace channel routes", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "scenario router helpers inspect Marketplace channel routes",

        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],

        steps: ({ when, then }) => [
          when.marketplace.install(TELEGRAM_CHANNEL_MARKETPLACE_INSTALLATION),
          when.router.seedStarter({ orgId: "org-1" }),

          then.router.routes({
            orgId: "org-1",
            include: [
              {
                id: "telegram-identity-claim-completed",
                action: {
                  kind: "send_workflow_event",
                  target: {
                    kind: "stored_instance_id",
                    keyTemplate: "telegram/claim-workflow/${event.payload.otpId}",
                  },
                  eventType: "identity-claim-completed",
                },
              },
            ],
          }),
          then.router.route({
            orgId: "org-1",
            id: "telegram-pi-linking",
            enabled: true,
            priority: 120,
            trigger: { kind: "event" },
          }),
          then.assert("the package defines the agent its routes prompt", async (ctx) => {
            const scope = { kind: "org", orgId: "org-1" } as const;
            const response = await ctx.runtime.objects.piManager
              .for(scope)
              .http.fetchAuthorized(
                new Request("https://pi-manager.test/api/pi-manager/agents/telegram"),
                {
                  execution: createBackofficeServiceExecution({
                    scope,
                    service: { type: "automation", id: "telegram-agent-check" },
                  }),
                },
              );
            assert.equal(response.status, 200, await response.clone().text());
            expect(await response.json()).toMatchObject({
              agentName: "telegram",
              instructions: expect.stringContaining("Messages arrive from Telegram chats"),
              managedBy: { kind: "marketplace", resourceKey: "telegram-agent", version: "1.2.0" },
            });
          }),
          then.assert("assert channel routes are visible through TanStack DB", async (ctx) => {
            const database = ctx.tanstack.automations.forOrg("org-1");
            await database.drain();
            const routes = await queryOnce((query) =>
              query.from({ route: database.collections.routes }),
            );
            const expectedIds = ["telegram-identity-claim-completed"];
            const missing = expectedIds.filter(
              (expectedId) => !routes.some((route) => route.id === expectedId),
            );
            assert.equal(missing.length, 0);
          }),
          then.router.missing({ orgId: "org-1", id: "no-such-route" }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("disabling a custom route stops it from starting workflows", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "scenario router disables custom route",

        files: backofficeFiles.workspaceStarter(),

        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],

        steps: ({ when, then }) => [
          when.router.seedStarter({ orgId: "org-1" }),
          when.router.createRoute({ orgId: "org-1", ...telegramTestCommandRoute }),
          when.router.updateRoute({ orgId: "org-1", id: "telegram-test-command", enabled: false }),
          then.router.route({ orgId: "org-1", id: "telegram-test-command", enabled: false }),

          when.automation.ingestEvent(telegramMessageEvent({ id: "disabled-test", text: "/test" })),

          then.workflow.missing({
            remoteWorkflowName: "telegram-test-command",
            instanceId: "telegram-test-disabled-test",
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("updating a custom route matcher changes which events start it", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "scenario router updates starter matcher",

        files: marketplaceTelegramTestWorkspace(),

        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],

        steps: ({ when, then }) => [
          when.router.seedStarter({ orgId: "org-1" }),
          when.router.createRoute({ orgId: "org-1", ...telegramTestCommandRoute }),
          when.router.updateRoute({
            orgId: "org-1",
            id: "telegram-test-command",
            trigger: {
              kind: "event",
              source: "telegram",
              eventType: "message.received",
              matcher: { path: "$.payload.text", op: "eq", value: "!test" },
            },
            priority: 110,
          }),
          then.router.route({
            orgId: "org-1",
            id: "telegram-test-command",
            trigger: {
              kind: "event",
              matcher: { path: "$.payload.text", op: "eq", value: "!test" },
            },
          }),

          when.automation.ingestEvent(telegramMessageEvent({ id: "old-test", text: "/test" })),
          when.automation.ingestEvent(telegramMessageEvent({ id: "bang-test", text: "!test" })),

          then.workflow.missing({
            remoteWorkflowName: "telegram-test-command",
            instanceId: "telegram-test-old-test",
          }),
          then.workflow.instance({
            remoteWorkflowName: "telegram-test-command",
            instanceId: "telegram-test-bang-test",
            status: "waiting",
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("creating a route starts a custom workflow for matching events", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "scenario router creates custom start route",

        files: backofficeFiles.workspaceStarter(),

        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs" }),
          given.direct.file({
            orgId: "org-1",
            path: "/workspace/automations/custom-alpha.workflow.js",
            content: `export default defineWorkflow(
  { name: "custom-alpha" },
  async (event, step) => {
    const automationEvent = event;
    await step.do("store custom route hit", async () => {
      await store.set({
        key: "custom/" + automationEvent.id,
        value: automationEvent.payload.kind,
        category: ["test", "router"],
      });
    });
    return { eventId: automationEvent.id, kind: automationEvent.payload.kind };
  },
);
`,
          }),
          given.router.route({
            orgId: "org-1",
            id: "custom-alpha",
            name: "Custom alpha",
            enabled: true,
            trigger: {
              kind: "event",
              source: "custom",
              eventType: "thing.happened",
              matcher: { path: "$.payload.kind", op: "eq", value: "alpha" },
            },
            priority: 50,
            action: {
              kind: "start_workflow",
              authority: {
                kind: "organization-automation",
                grants: [BACKOFFICE_PERMISSION.store.modify],
              },
              workflowScriptPath: "/workspace/automations/custom-alpha.workflow.js",
              instanceIdTemplate: "custom-alpha-${event.id}",
            },
          }),
        ],

        steps: ({ when, then }) => [
          then.router.route({
            orgId: "org-1",
            id: "custom-alpha",
            trigger: {
              kind: "event",
              source: "custom",
              eventType: "thing.happened",
            },
          }),

          when.automation.ingestEvent(
            customAutomationEvent({
              id: "alpha-1",
              payload: { kind: "alpha" },
            }),
          ),
          when.automation.ingestEvent(
            customAutomationEvent({ id: "beta-1", payload: { kind: "beta" } }),
          ),

          then.assert("assert automation events are visible through TanStack DB", async (ctx) => {
            const database = ctx.tanstack.automations.forOrg("org-1");
            await database.drain();
            const alphaEvent = await queryOnce((query) =>
              query
                .from({ event: database.collections.events })
                .where(({ event }) => eq(event.id, "alpha-1"))
                .findOne(),
            );
            const betaEvent = await queryOnce((query) =>
              query
                .from({ event: database.collections.events })
                .where(({ event }) => eq(event.id, "beta-1"))
                .findOne(),
            );
            assert.deepEqual(alphaEvent?.payload, { kind: "alpha" });
            assert.deepEqual(betaEvent?.payload, { kind: "beta" });
          }),

          then.workflow.instance({
            remoteWorkflowName: "custom-alpha",
            instanceId: "custom-alpha-alpha-1",
            status: "complete",
            actors: {
              initiator: {
                scope: "internal",
                type: "system",
                id: "scenario",
                role: "initiator",
              },
              principal: {
                scope: "internal",
                type: "automation",
                id: "automation-route:custom-alpha",
                role: "principal",
              },
              delegation: [],
            },
            output: { eventId: "alpha-1", kind: "alpha" },
          }),
          then.workflow.missing({
            remoteWorkflowName: "custom-alpha",
            instanceId: "custom-alpha-beta-1",
          }),
          then.store.entry({
            orgId: "org-1",
            key: "custom/alpha-1",
            value: "alpha",
          }),
          then.assert(
            "assert custom workflow store output is visible through TanStack DB",
            async (ctx) => {
              const database = ctx.tanstack.automations.forOrg("org-1");
              await database.drain();
              const entry = await queryOnce((query) =>
                query
                  .from({ entry: database.collections.kvStore })
                  .where(({ entry }) => eq(entry.key, "custom/alpha-1"))
                  .findOne(),
              );
              assert.equal(entry?.value, "alpha");
            },
          ),
          then.store.missing({ orgId: "org-1", key: "custom/beta-1" }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("a broken start_workflow route does not block another matched route", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "scenario router missing workflow file skips",

        files: backofficeFiles.workspaceStarter(),

        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs" }),
          given.direct.file({
            orgId: "org-1",
            path: "/workspace/automations/valid-matched-route.workflow.js",
            content: `export default defineWorkflow(
  { name: "valid-matched-route" },
  async (event) => ({ eventId: event.id }),
);`,
          }),
          given.router.route({
            orgId: "org-1",
            id: "missing-workflow-file",
            name: "Missing workflow file",
            enabled: true,
            trigger: {
              kind: "event",
              source: "custom",
              eventType: "thing.happened",
              matcher: {
                path: "$.payload.kind",
                op: "eq",
                value: "missing-file",
              },
            },
            priority: 50,
            action: {
              kind: "start_workflow",
              authority: { kind: "organization-automation", grants: [] },
              workflowScriptPath: "/workspace/automations/missing-workflow-file.workflow.js",
              instanceIdTemplate: "missing-workflow-file-${event.id}",
            },
          }),
          given.router.route({
            orgId: "org-1",
            id: "valid-matched-route",
            name: "Valid matched route",
            enabled: true,
            trigger: {
              kind: "event",
              source: "custom",
              eventType: "thing.happened",
              matcher: {
                path: "$.payload.kind",
                op: "eq",
                value: "missing-file",
              },
            },
            priority: 60,
            action: {
              kind: "start_workflow",
              authority: { kind: "organization-automation", grants: [] },
              workflowScriptPath: "/workspace/automations/valid-matched-route.workflow.js",
              instanceIdTemplate: "valid-matched-route-${event.id}",
            },
          }),
        ],

        steps: ({ when, then }) => [
          when.automation.ingestEvent(
            customAutomationEvent({
              id: "missing-file-1",
              payload: { kind: "missing-file" },
            }),
          ),

          then.workflow.missing({
            remoteWorkflowName: "missing-workflow-file",
            instanceId: "missing-workflow-file-missing-file-1",
          }),
          then.workflow.instance({
            remoteWorkflowName: "valid-matched-route",
            instanceId: "valid-matched-route-missing-file-1",
            status: "complete",
            output: { eventId: "missing-file-1" },
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("a failing route retries alone after its missing workflow is created", async () => {
    const event = customAutomationEvent({
      id: "fanout-retry-1",
      eventType: "fanout.retry",
      payload: { value: "ready" },
    });

    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "retry a failing route without its sibling",

        files: backofficeFiles.workspaceStarter(),

        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs" }),
          given.direct.file({
            orgId: "org-1",
            path: "/workspace/automations/fanout-retry-waiter.workflow.js",
            content: `export default defineWorkflow(
  { name: "fanout-retry-waiter" },
  async (_event, step) => {
    const signal = await step.waitForEvent("route signal", {
      type: "fanout-ready",
      timeout: "15 minutes",
    });
    return { received: signal.payload.payload.value };
  },
);`,
          }),
          given.router.route({
            orgId: "org-1",
            id: "fanout-send-to-late-workflow",
            name: "Send to a workflow created after the first attempt",
            enabled: true,
            trigger: {
              kind: "event",
              source: "custom",
              eventType: "fanout.retry",
              matcher: { path: "$.scope.kind", op: "eq", value: "org" },
            },
            priority: 50,
            action: {
              kind: "send_workflow_event",
              target: { kind: "instance_id", template: "fanout-retry-waiter-1" },
              eventType: "fanout-ready",
              payload: "$event",
            },
          }),
          given.router.route({
            orgId: "org-1",
            id: "fanout-forward-success",
            name: "Forward successfully before the sibling route is retried",
            enabled: true,
            trigger: {
              kind: "event",
              source: "custom",
              eventType: "fanout.retry",
              matcher: { path: "$.scope.kind", op: "eq", value: "org" },
            },
            priority: 60,
            action: {
              kind: "forward_event",
              targetScope: {
                kind: "project",
                owner: { kind: "org", orgIdTemplate: "org-1" },
                projectIdTemplate: "fanout-retry-project",
              },
              idTemplate: "forwarded-${event.id}",
            },
          }),
        ],

        steps: ({ when, then }) => [
          when.automation.ingestEvent(event),

          then.assert("only the route whose workflow is missing waits to retry", async (ctx) => {
            expect(await routeDispatchStates(ctx, event.id)).toEqual({
              "fanout-forward-success": {
                status: "completed",
                outcome: {
                  kind: "event_forwarded",
                  eventId: "forwarded-fanout-retry-1",
                  scope: fanoutRetryProjectScope,
                },
                failedAttempts: 0,
              },
              "fanout-send-to-late-workflow": {
                status: "retrying",
                failedAttempts: 1,
                error: "INSTANCE_NOT_FOUND",
              },
            });
          }),

          then.automation.event({
            scope: fanoutRetryProjectScope,
            where: { id: "forwarded-fanout-retry-1" },
            expected: {
              source: "custom",
              eventType: "fanout.retry",
              payload: { value: "ready" },
            },
          }),

          when.workflow.createInstance({
            orgId: "org-1",
            remoteWorkflowName: "fanout-retry-waiter",
            instanceId: "fanout-retry-waiter-1",
            path: "/workspace/automations/fanout-retry-waiter.workflow.js",
            event: customAutomationEvent({ id: "fanout-retry-waiter-bootstrap" }),
          }),
          then.workflow.instance({
            remoteWorkflowName: "fanout-retry-waiter",
            instanceId: "fanout-retry-waiter-1",
            status: "waiting",
            waitingFor: "fanout-ready",
          }),

          when.time.advance("1 second"),

          then.workflow.instance({
            remoteWorkflowName: "fanout-retry-waiter",
            instanceId: "fanout-retry-waiter-1",
            status: "complete",
            output: { received: "ready" },
          }),
          then.assert("the retry delivered the event and left the forward alone", async (ctx) => {
            expect(await routeDispatchStates(ctx, event.id)).toMatchObject({
              "fanout-forward-success": { status: "completed" },
              "fanout-send-to-late-workflow": {
                status: "completed",
                outcome: { kind: "workflow_event_sent", instanceId: "fanout-retry-waiter-1" },
                failedAttempts: 1,
              },
            });
            const queue = await ctx.runtime.objects.automations
              .forOrg("org-1")
              .commands.getDurableHookQueue("automation", { pageSize: 100 });
            const forwardHook = queue.items.find(
              (item) =>
                item.hookName === "internalDispatchRoute" &&
                (item.payload as AutomationRouteDispatchPayload).route.id ===
                  "fanout-forward-success",
            );
            // The sibling's retry did not forward the event again.
            expect(forwardHook).toMatchObject({ status: "completed", attempts: 0 });
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
          then.hooks.noPending({ orgId: "org-1", fragments: ["automations"] }),
          then.hooks.noFailed({ orgId: "org-1", fragments: ["automations"] }),
        ],
      }),
    );
  });

  test("a route whose workflow never appears gives up after its last attempt", async () => {
    const event = customAutomationEvent({
      id: "fanout-exhausted-1",
      eventType: "fanout.exhausted",
      payload: { value: "ready" },
    });

    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "give up on a route after its retries",
        options: { allowFailedDurableHooks: true },

        files: backofficeFiles.workspaceStarter(),

        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs" }),
          given.router.route({
            orgId: "org-1",
            id: "fanout-send-to-missing-workflow",
            name: "Send to a workflow that is never created",
            enabled: true,
            trigger: {
              kind: "event",
              source: "custom",
              eventType: "fanout.exhausted",
              matcher: null,
            },
            priority: 50,
            action: {
              kind: "send_workflow_event",
              target: { kind: "instance_id", template: "missing-waiter-1" },
              eventType: "fanout-ready",
              payload: "$event",
            },
          }),
        ],

        steps: ({ when, then }) => [
          when.automation.ingestEvent(event),
          // Each advance outlasts one backoff, which never exceeds 15 minutes.
          ...Array.from({ length: 9 }, () => when.time.advance("15 minutes")),

          then.assert("the route failed for good with its last error", async (ctx) => {
            expect(await routeDispatchStates(ctx, event.id)).toEqual({
              "fanout-send-to-missing-workflow": {
                status: "failed",
                failedAttempts: 10,
                error: "INSTANCE_NOT_FOUND",
              },
            });
            const queue = await ctx.runtime.objects.automations
              .forOrg("org-1")
              .commands.getDurableHookQueue("automation", { pageSize: 100 });
            const routeHooks = queue.items.filter(
              (item) => item.hookName === "internalDispatchRoute",
            );
            expect(routeHooks).toMatchObject([{ status: "failed", attempts: 10, maxAttempts: 10 }]);
          }),
        ],
      }),
    );
  });

  test("send_workflow_event routes wake a workflow from a stored instance id", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "scenario router sends workflow event",

        files: backofficeFiles.workspaceStarter(),

        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs" }),
          given.direct.file({
            orgId: "org-1",
            path: "/workspace/automations/custom-waiter.workflow.js",
            content: `export default defineWorkflow(
  { name: "custom-waiter" },
  async (_event, step) => {
    const signal = await step.waitForEvent("custom-signal", {
      type: "custom-signal",
      timeout: "15 minutes",
    });
    const signalEvent = signal.payload;
    await step.do("store custom signal", async () => {
      await store.set({
        key: "signal/" + signalEvent.payload.key,
        value: signalEvent.payload.value,
        category: ["test", "router"],
      });
    });
    return { received: signalEvent.payload.value };
  },
);
`,
          }),
          given.store.entry({
            orgId: "org-1",
            key: "waiter/alpha",
            value: "waiter-1",
          }),
          given.router.route({
            orgId: "org-1",
            id: "custom-signal-forwarder",
            name: "Custom signal forwarder",
            enabled: true,
            trigger: {
              kind: "event",
              source: "custom",
              eventType: "signal.received",
              matcher: { path: "$.payload.key", op: "eq", value: "alpha" },
            },
            priority: 40,
            action: {
              kind: "send_workflow_event",
              target: {
                kind: "stored_instance_id",
                keyTemplate: "waiter/${event.payload.key}",
              },
              eventType: "custom-signal",
              payload: "$event",
            },
          }),
        ],

        steps: ({ when, then }) => [
          when.workflow.createInstance({
            orgId: "org-1",
            remoteWorkflowName: "custom-waiter",
            instanceId: "waiter-1",
            path: "/workspace/automations/custom-waiter.workflow.js",
            event: customAutomationEvent({ id: "waiter-bootstrap" }),
          }),
          then.workflow.instance({
            remoteWorkflowName: "custom-waiter",
            instanceId: "waiter-1",
            status: "waiting",
            waitingFor: "custom-signal",
          }),

          when.automation.ingestEvent(
            customAutomationEvent({
              id: "signal-1",
              eventType: "signal.received",
              payload: { key: "alpha", value: "delivered" },
            }),
          ),

          then.workflow.instance({
            remoteWorkflowName: "custom-waiter",
            instanceId: "waiter-1",
            status: "complete",
            output: { received: "delivered" },
          }),
          then.store.entry({
            orgId: "org-1",
            key: "signal/alpha",
            value: "delivered",
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("Telegram /pi reports the telegram agent to an authorized linked chat", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "Telegram Channel /pi reports the telegram agent",

        fakes: ({ fake }) => ({
          telegram: fake.telegram(),
          pi: fake.pi(),
        }),

        setup: ({ given }) => [
          given.auth.user({
            id: "owner-1",
            email: "owner@example.com",
          }),
          given.auth.user({
            id: "user-1",
            email: "linked-user@example.com",
          }),
          given.auth.organization({
            id: "org-1",
            name: "Ada Labs",
            ownerUserId: "owner-1",
            ownerRoles: ["owner"],
          }),
          given.auth.member({
            orgId: "org-1",
            userId: "user-1",
            roles: ["member"],
          }),
          given.organization.exists({
            id: "org-1",
            name: "Ada Labs",
            ownerUserId: "owner-1",
          }),
          given.telegram.configured({
            orgId: "org-1",
            botUsername: "fragno_bot",
          }),
          given.identity.binding({
            orgId: "org-1",
            externalId: "1001",
            userId: "user-1",
          }),
        ],

        steps: ({ when, then }) => [
          when.marketplace.install(TELEGRAM_CHANNEL_MARKETPLACE_INSTALLATION),
          then.auth.authority({
            userId: "user-1",
            orgId: "org-1",
            expected: {
              active: true,
              role: "user",
              organizationMember: true,
            },
          }),
          then.auth.member({
            orgId: "org-1",
            userId: "user-1",
            roles: ["member"],
          }),
          then.auth.permissions({
            userId: "user-1",
            scope: { kind: "org", orgId: "org-1" },
            include: [
              BACKOFFICE_PERMISSION.integrations.execute,
              BACKOFFICE_PERMISSION.store.modify,
            ],
            exclude: [BACKOFFICE_PERMISSION.identity.bind],
          }),
          then.identity.resolves({
            scope: { kind: "org", orgId: "org-1" },
            identity: {
              scope: "external",
              source: "telegram",
              type: "chat",
              id: "1001",
            },
            userId: "user-1",
          }),

          when.telegram.receivesMessage({
            orgId: "org-1",
            updateId: 20_001,
            messageId: 601,
            chatId: "1001",
            text: "/pi",
            from: { id: 1_001, firstName: "Ada", username: "ada_lovelace" },
          }),

          then.automation.event({
            scope: { kind: "org", orgId: "org-1" },
            where: {
              source: "telegram",
              eventType: "message.received",
            },
            expected: {
              actors: {
                initiator: {
                  scope: "external",
                  source: "telegram",
                  type: "chat",
                  id: "1001",
                  role: "initiator",
                },
                principal: null,
                delegation: [],
              },
              subject: null,
            },
          }),
          then.assert("assert /pi runs no agent turn", (ctx) => {
            const calls = ctx.fakes.pi?.runPromptCalls ?? [];
            if (calls.length !== 0) {
              throw new Error(`Expected no Pi turn, got ${calls.length}.`);
            }
          }),
          then.kernel.action({
            operation: BACKOFFICE_PERMISSION.integrations.execute,
            scope: { kind: "org", orgId: "org-1" },
            actors: {
              initiator: {
                scope: "external",
                source: "telegram",
                type: "chat",
                id: "1001",
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
                  id: "automation-route:telegram-pi-linking",
                  role: "delegate",
                },
              ],
            },
          }),
          then.telegram.sentMessage({
            chatId: "1001",
            text: "Messages in this chat go to the Telegram agent.",
          }),
          then.workflow.instance({
            remoteWorkflowName: "telegram-user-pi-linking",
            status: "complete",
            params: {
              trigger: {
                type: "event",
                event: {
                  actors: {
                    initiator: {
                      scope: "external",
                      source: "telegram",
                      type: "chat",
                      id: "1001",
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
                        id: "automation-route:telegram-pi-linking",
                        role: "delegate",
                      },
                    ],
                  },
                },
              },
            },
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("Telegram identity revocation returns the Pi workflow to unlinked behavior", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "revoked Telegram identity is unlinked in the Pi workflow",
        fakes: ({ fake }) => ({
          telegram: fake.telegram(),
          pi: fake.pi(),
        }),
        setup: ({ given }) => [
          given.auth.user({
            id: "owner-1",
            email: "owner@example.com",
          }),
          given.auth.user({
            id: "user-1",
            email: "linked-user@example.com",
          }),
          given.auth.organization({
            id: "org-1",
            name: "Ada Labs",
            ownerUserId: "owner-1",
            ownerRoles: ["owner"],
          }),
          given.auth.member({
            orgId: "org-1",
            userId: "user-1",
            roles: ["member"],
          }),
          given.organization.exists({
            id: "org-1",
            name: "Ada Labs",
            ownerUserId: "owner-1",
          }),
          given.telegram.configured({
            orgId: "org-1",
            botUsername: "fragno_bot",
          }),
          given.identity.binding({
            orgId: "org-1",
            externalId: "1001",
            userId: "user-1",
          }),
        ],
        steps: ({ when, then }) => [
          when.marketplace.install(TELEGRAM_CHANNEL_MARKETPLACE_INSTALLATION),
          then.auth.authority({
            userId: "user-1",
            orgId: "org-1",
            expected: {
              active: true,
              role: "user",
              organizationMember: true,
            },
          }),
          then.auth.member({
            orgId: "org-1",
            userId: "user-1",
            roles: ["member"],
          }),
          then.auth.permissions({
            userId: "user-1",
            scope: { kind: "org", orgId: "org-1" },
            include: [
              BACKOFFICE_PERMISSION.integrations.execute,
              BACKOFFICE_PERMISSION.store.modify,
            ],
            exclude: [BACKOFFICE_PERMISSION.identity.bind],
          }),

          when.identity.revoke({
            orgId: "org-1",
            externalId: "1001",
            expectedUserId: "user-1",
          }),
          when.telegram.receivesMessage({
            orgId: "org-1",
            updateId: 20_005,
            messageId: 605,
            chatId: "1001",
            text: "/pi",
            from: { id: 1_001, firstName: "Ada", username: "ada_lovelace" },
          }),

          then.telegram.noMessages(),
          then.assert("assert Pi was not called after identity revocation", (ctx) => {
            const calls = ctx.fakes.pi?.runPromptCalls ?? [];
            if (calls.length !== 0) {
              throw new Error(`Expected no Pi turn, got ${calls.length}.`);
            }
          }),
          then.workflow.missing({
            remoteWorkflowName: "telegram-user-pi-linking",
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("Telegram inputs from an unlinked chat start no Pi turn or starter workflow", async () => {
    const unlinkedChatMessage = {
      orgId: "org-1",
      chatId: "1001",
      from: { id: 1_001, firstName: "Ada", username: "ada_lovelace" },
    };

    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "Telegram Channel ignores unlinked and unrelated inputs",

        fakes: ({ fake }) => ({
          telegram: fake.telegram(),
          pi: fake.pi(),
        }),

        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs" }),
          given.telegram.configured({
            orgId: "org-1",
            botUsername: "fragno_bot",
          }),
        ],

        steps: ({ when, then }) => {
          // Each input is asserted on its own, so an earlier input cannot hide a later regression.
          const thenNothingStarted = () => [
            then.telegram.noMessages(),
            then.assert("assert Pi was not called", (ctx) => {
              const calls = ctx.fakes.pi?.runPromptCalls ?? [];
              if (calls.length !== 0) {
                throw new Error(`Expected no Pi turn, got ${calls.length}.`);
              }
            }),
            then.workflow.missing({ remoteWorkflowName: "telegram-user-linking" }),
            then.workflow.missing({ remoteWorkflowName: "telegram-test-command" }),
            then.workflow.missing({ remoteWorkflowName: "telegram-user-pi-linking" }),
            then.workflow.noErrored({ orgId: "org-1" }),
          ];

          return [
            when.marketplace.install(TELEGRAM_CHANNEL_MARKETPLACE_INSTALLATION),

            when.telegram.receivesMessage({
              ...unlinkedChatMessage,
              updateId: 20_006,
              messageId: 606,
              text: "/pi",
            }),
            ...thenNothingStarted(),

            when.telegram.receivesMessage({
              ...unlinkedChatMessage,
              updateId: 20_007,
              messageId: 607,
              text: "Hello Pi",
            }),
            ...thenNothingStarted(),

            when.telegram.receivesMessage({
              ...unlinkedChatMessage,
              updateId: 20_008,
              messageId: 608,
              text: "/help",
            }),
            ...thenNothingStarted(),

            when.telegram.webhook({
              orgId: "org-1",
              label: "receive Telegram webhook without a message",
              update: {
                update_id: 21_001,
                my_chat_member: {
                  chat: { id: 1001, type: "private" },
                  from: { id: 2001, is_bot: false, first_name: "Ada" },
                  date: 1_780_000_000,
                  old_chat_member: {
                    status: "member",
                    user: { id: 123, is_bot: true },
                  },
                  new_chat_member: {
                    status: "kicked",
                    user: { id: 123, is_bot: true },
                  },
                },
              },
            }),
            ...thenNothingStarted(),
          ];
        },
      }),
    );
  });

  test("Telegram text runs a telegram agent turn as the linked user and forwards its answer", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "Telegram Channel text prompts the installed telegram agent",

        fakes: ({ fake }) => ({
          telegram: fake.telegram(),
          pi: fake.pi(),
        }),

        setup: ({ given }) => [
          given.auth.user({
            id: "owner-1",
            email: "owner@example.com",
          }),
          given.auth.user({
            id: "user-1",
            email: "linked-user@example.com",
          }),
          given.auth.organization({
            id: "org-1",
            name: "Ada Labs",
            ownerUserId: "owner-1",
            ownerRoles: ["owner"],
          }),
          given.auth.member({
            orgId: "org-1",
            userId: "user-1",
            roles: ["member"],
          }),
          given.organization.exists({
            id: "org-1",
            name: "Ada Labs",
            ownerUserId: "owner-1",
          }),
          given.telegram.configured({
            orgId: "org-1",
            botUsername: "fragno_bot",
          }),
          given.identity.binding({
            orgId: "org-1",
            externalId: "1001",
            userId: "user-1",
          }),
        ],

        steps: ({ when, then }) => [
          when.marketplace.install(TELEGRAM_CHANNEL_MARKETPLACE_INSTALLATION),
          then.auth.authority({
            userId: "user-1",
            orgId: "org-1",
            expected: {
              active: true,
              role: "user",
              organizationMember: true,
            },
          }),
          then.auth.member({
            orgId: "org-1",
            userId: "user-1",
            roles: ["member"],
          }),
          then.auth.permissions({
            userId: "user-1",
            scope: { kind: "org", orgId: "org-1" },
            include: [
              BACKOFFICE_PERMISSION.integrations.execute,
              BACKOFFICE_PERMISSION.store.modify,
            ],
            exclude: [BACKOFFICE_PERMISSION.identity.bind],
          }),

          when.telegram.receivesMessage({
            orgId: "org-1",
            updateId: 20_002,
            messageId: 602,
            chatId: "1001",
            text: "/pi",
            from: { id: 1_001, firstName: "Ada", username: "ada_lovelace" },
          }),

          when.telegram.receivesMessage({
            orgId: "org-1",
            updateId: 20_003,
            messageId: 603,
            chatId: "1001",
            text: "Hello Pi",
            from: { id: 1_001, firstName: "Ada", username: "ada_lovelace" },
          }),

          when.telegram.receivesMessage({
            orgId: "org-1",
            updateId: 20_004,
            messageId: 604,
            chatId: "1001",
            text: "Thanks",
            from: { id: 1_001, firstName: "Ada", username: "ada_lovelace" },
          }),

          then.pi.provisionedAgent({ agentName: "telegram" }),
          then.assert("assert every message continues one telegram agent conversation", (ctx) => {
            const provisioned = ctx.fakes.pi?.provisionedAgents ?? [];
            const turns = ctx.fakes.pi?.runPromptCalls ?? [];
            if (provisioned.length !== 1 || turns.length !== 2) {
              throw new Error(
                `Expected one provisioned agent and two turns, got ${provisioned.length} and ${turns.length}.`,
              );
            }
          }),
          then.assert(
            "assert the turn runs as the linked user with the installed definition",
            (ctx) => {
              const turn = ctx.fakes.pi?.runPromptCalls[0]?.turn;
              expect(turn?.actors.principal).toEqual({
                scope: "internal",
                type: "user",
                id: "user-1",
                role: "principal",
              });
              expect(turn?.agent.instructions).toContain("AUTOMATICALLY sent back to its chat");
              expect(turn?.agent.model).toEqual({ provider: "openai", modelId: "gpt-5.6-luna" });
            },
          ),
          then.telegram.sentChatAction({
            chatId: "1001",
            action: "typing",
          }),
          then.pi.ranPrompt({
            agentName: "telegram",
            content: "[Telegram chat 1001] Hello Pi",
            assistantText: "agent:[Telegram chat 1001] Hello Pi",
          }),
          then.telegram.sentMessage({
            chatId: "1001",
            text: "agent:[Telegram chat 1001] Hello Pi",
          }),
          then.workflow.instance({
            remoteWorkflowName: "telegram-user-pi-linking",
            status: "complete",
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("Telegram text with no Pi assistant text sends no response message", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "Telegram Channel text sends no message when Pi has no assistant text",

        fakes: ({ fake }) => ({
          telegram: fake.telegram(),
          pi: fake.pi({ assistantText: () => "" }),
        }),

        setup: ({ given }) => [
          given.auth.user({
            id: "owner-1",
            email: "owner@example.com",
          }),
          given.auth.user({
            id: "user-1",
            email: "linked-user@example.com",
          }),
          given.auth.organization({
            id: "org-1",
            name: "Ada Labs",
            ownerUserId: "owner-1",
            ownerRoles: ["owner"],
          }),
          given.auth.member({
            orgId: "org-1",
            userId: "user-1",
            roles: ["member"],
          }),
          given.organization.exists({
            id: "org-1",
            name: "Ada Labs",
            ownerUserId: "owner-1",
          }),
          given.telegram.configured({
            orgId: "org-1",
            botUsername: "fragno_bot",
          }),
          given.identity.binding({
            orgId: "org-1",
            externalId: "1001",
            userId: "user-1",
          }),
        ],

        steps: ({ when, then }) => [
          when.marketplace.install(TELEGRAM_CHANNEL_MARKETPLACE_INSTALLATION),
          then.auth.authority({
            userId: "user-1",
            orgId: "org-1",
            expected: {
              active: true,
              role: "user",
              organizationMember: true,
            },
          }),
          then.auth.member({
            orgId: "org-1",
            userId: "user-1",
            roles: ["member"],
          }),
          then.auth.permissions({
            userId: "user-1",
            scope: { kind: "org", orgId: "org-1" },
            include: [
              BACKOFFICE_PERMISSION.integrations.execute,
              BACKOFFICE_PERMISSION.store.modify,
            ],
            exclude: [BACKOFFICE_PERMISSION.identity.bind],
          }),

          when.telegram.receivesMessage({
            orgId: "org-1",
            updateId: 20_014,
            messageId: 614,
            chatId: "1001",
            text: "/pi",
            from: { id: 1_001, firstName: "Ada", username: "ada_lovelace" },
          }),

          when.telegram.receivesMessage({
            orgId: "org-1",
            updateId: 20_015,
            messageId: 615,
            chatId: "1001",
            text: "No response expected",
            from: { id: 1_001, firstName: "Ada", username: "ada_lovelace" },
          }),

          then.telegram.sentChatAction({
            chatId: "1001",
            action: "typing",
          }),
          then.pi.ranPrompt({
            agentName: "telegram",
            content: "[Telegram chat 1001] No response expected",
            assistantText: "",
          }),
          then.assert("assert only the /pi reply was sent", (ctx) => {
            const calls = ctx.fakes.telegram?.sendMessageCalls ?? [];
            if (calls.length !== 1) {
              throw new Error(`Expected one Telegram message, got ${calls.length}.`);
            }
          }),
          then.workflow.instance({
            remoteWorkflowName: "telegram-user-pi-linking",
            status: "complete",
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("Telegram /test sends the delayed reply after time advances", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "Telegram Channel /test waits before sending a reply",

        files: marketplaceTelegramTestWorkspace(),

        fakes: ({ fake }) => ({
          telegram: fake.telegram(),
        }),

        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs" }),
          given.telegram.configured({
            orgId: "org-1",
            botUsername: "fragno_bot",
          }),
        ],

        steps: ({ when, then }) => [
          when.router.createRoute({ orgId: "org-1", ...telegramTestCommandRoute }),
          when.telegram.receivesMessage({
            orgId: "org-1",
            updateId: 20_005,
            messageId: 605,
            chatId: "1001",
            text: "/test",
            from: { id: 1_001, firstName: "Ada", username: "ada_lovelace" },
          }),

          then.telegram.noMessages(),
          then.workflow.instance({
            remoteWorkflowName: "telegram-test-command",
            instanceId: "telegram-test-message-20005",
            status: "waiting",
            params: {
              trigger: {
                type: "event",
                event: {
                  source: "telegram",
                  eventType: "message.received",
                  payload: {
                    chatId: "1001",
                    text: "/test",
                  },
                  actors: {
                    initiator: {
                      scope: "external",
                      source: "telegram",
                      type: "chat",
                      id: "1001",
                      role: "initiator",
                    },
                    principal: null,
                    delegation: [],
                  },
                },
              },
              program: {
                workflowName: "telegram-test-command",
                filename: "/workspace/automations/telegram-test-command.workflow.js",
              },
            },
          }),
          then.workflow.steps({
            remoteWorkflowName: "telegram-test-command",
            include: ["wait 3 seconds"],
          }),

          when.time.advance("3 seconds"),

          then.telegram.sentMessage({
            chatId: "1001",
            text: "Telegram integration verified after a 3 second delay.",
          }),
          then.workflow.instance({
            remoteWorkflowName: "telegram-test-command",
            instanceId: "telegram-test-message-20005",
            status: "complete",
            output: { sent: true },
          }),
          then.workflow.steps({
            remoteWorkflowName: "telegram-test-command",
            include: ["wait 3 seconds", "send delayed test reply"],
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });
});
