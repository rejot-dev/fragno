import { assert, describe, test, vi } from "vitest";

import type { AutomationEvent } from "@fragno-dev/backoffice-api/v0/events";

import { queryOnce } from "@tanstack/react-db";

import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import {
  backofficeFiles,
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";
import {
  automationRoutesFromRecords,
  automationRoutesQuery,
} from "@/fragno/automation/tanstack/use-automation-routes";

import { InMemoryApiObject } from "../../../../workers/api.do";
import { InMemoryAppInstallationsObject } from "../../../../workers/app-installations.do";
import { InMemoryAppsObject } from "../../../../workers/apps.do";
import { InMemoryAuthObject } from "../../../../workers/auth.do";
import { InMemoryAutomationsObject } from "../../../../workers/automations.do";
import { InMemoryCodemodeObject } from "../../../../workers/codemode.do";
import { InMemoryFormsObject } from "../../../../workers/forms.do";
import { InMemoryGitHubWebhookRouterObject } from "../../../../workers/github-webhook-router.do";
import { InMemoryGitHubObject } from "../../../../workers/github.do";
import { InMemoryMcpObject } from "../../../../workers/mcp.do";
import { InMemoryOtpObject } from "../../../../workers/otp.do";
import { InMemoryProjectConnectorObject } from "../../../../workers/project-connector.do";
import { InMemoryResendObject } from "../../../../workers/resend.do";
import { InMemoryReson8Object } from "../../../../workers/reson8.do";
import { InMemoryTelegramObject } from "../../../../workers/telegram.do";
import { InMemoryUploadObject } from "../../../../workers/upload.do";
import {
  automationWorkflowRunsFromRecords,
  workflowRunRecordsQuery,
} from "../automations/script-view/use-script-workflow-runs";
import {
  orchestrationActiveWorkflowsQuery,
  projectOrchestrationGraph,
} from "./orchestration-graph";
import {
  dashboardBucketStarts,
  dashboardConnectionEventsQuery,
  dashboardEventsQuery,
  dashboardRunsQuery,
  projectBackofficeDashboard,
} from "./overview";

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

const scenarioObjects = {
  API: (input) => new InMemoryApiObject(input),
  APPS: (input) => new InMemoryAppsObject(input),
  APP_INSTALLATIONS: (input) => new InMemoryAppInstallationsObject(input),
  AUTH: (input) => new InMemoryAuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new InMemoryAutomationsObject(input),
  CODEMODE: (input) => new InMemoryCodemodeObject(input),
  FORMS: (input) => new InMemoryFormsObject(input),
  GITHUB: (input) => new InMemoryGitHubObject(input),
  GITHUB_WEBHOOK_ROUTER: (input) => new InMemoryGitHubWebhookRouterObject(input),
  MCP: (input) => new InMemoryMcpObject(input),
  OTP: (input) => new InMemoryOtpObject(input),
  PROJECT_CONNECTOR: (input) => new InMemoryProjectConnectorObject(input),
  RESEND: (input) => new InMemoryResendObject(input),
  RESON8: (input) => new InMemoryReson8Object(input),
  TELEGRAM: (input) => new InMemoryTelegramObject(input),
  UPLOAD: (input) => new InMemoryUploadObject(input),
} satisfies LocalBackofficeObjects;

const orgId = "org-1";
const scope = { kind: "org" as const, orgId };
const DAY_MS = 24 * 60 * 60 * 1000;
const SCHEDULED_AT = "2030-01-01T00:00:00.000Z";

const workflows = {
  "automations/ship-order.workflow.js": `defineWorkflow({ name: "ship-order" }, async (event, step) => {
  await step.do("ship", async () => "shipped");
  return "shipped";
});`,
  "automations/charge-card.workflow.js": `defineWorkflow({ name: "charge-card" }, async (event, step) => {
  await step.do("charge", { retries: { limit: 0, delay: 0 } }, async () => {
    throw new Error("card declined");
  });
});`,
  "automations/approve-refund.workflow.js": `defineWorkflow({ name: "approve-refund" }, async (event, step) => {
  await step.do("ask for approval", async () => ({
    $ui: {
      version: 1,
      state: {},
      spec: {
        root: "question",
        elements: { question: { type: "Text", props: { text: "Approve the refund?" }, children: [] } },
      },
    },
  }));
  await step.waitForEvent("approval", { type: "refund-approved", timeout: "7 days" });
});`,
  "automations/await-shipment.workflow.js": `defineWorkflow({ name: "await-shipment" }, async (event, step) => {
  await step.waitForEvent("shipment", { type: "shipped", timeout: "7 days" });
});`,
};

/** Events carry the time they happened, so the scenario stamps them against its own clock. */
function event(
  id: string,
  source: string,
  eventType: string,
  occurredAt: number,
  { payload, subject }: Pick<AutomationEvent, "payload" | "subject"> = {
    payload: { id },
    subject: { orgId },
  },
): AutomationEvent {
  return {
    id,
    scopeRestriction: null,
    scope,
    source,
    eventType,
    occurredAt: new Date(occurredAt).toISOString(),
    payload,
    actors: createBackofficeSystemExecution(scope).actors,
    subject,
    causation: { kind: "origin" },
  };
}

function connectionEvent(
  id: string,
  state: "ready" | "unavailable",
  connectionId: string,
  at: number,
) {
  return event(id, "integrations", `connection.${state}`, at, {
    payload: { name: connectionId, authMethod: null },
    subject: { scope, orgId, service: connectionId.split("#", 1)[0], connectionId },
  });
}

/** Reads the dashboard the way the page does: the same live queries, run once. */
async function readDashboard(ctx: BackofficeScenarioContext) {
  const database = ctx.tanstack.automations.forOrg(orgId);
  await database.drain();
  const { collections } = database;
  const now = ctx.runtime.now();
  const since = new Date(dashboardBucketStarts(now)[0] ?? now);
  const [runs, waitingRuns, events, connectionEvents, routeRecords, activeWorkflows] =
    await Promise.all([
      queryOnce((query) => dashboardRunsQuery(query, collections)),
      queryOnce((query) => workflowRunRecordsQuery(query, collections, { type: "waiting" })),
      queryOnce((query) => dashboardEventsQuery(query, collections, since)),
      queryOnce((query) => dashboardConnectionEventsQuery(query, collections)),
      queryOnce((query) => automationRoutesQuery(query, collections)),
      queryOnce((query) => orchestrationActiveWorkflowsQuery(query, collections)),
    ]);
  const routes = automationRoutesFromRecords(routeRecords);
  const dashboard = projectBackofficeDashboard({
    now,
    runs,
    waitingRuns: automationWorkflowRunsFromRecords(waitingRuns),
    events,
    connectionEvents,
    routes,
  });
  // Catalogs are left out so the graph holds only what this scope's data puts there.
  const graph = projectOrchestrationGraph({
    scopeLabel: "Ada Labs",
    sources: [],
    eventDefinitions: [],
    routes,
    activeWorkflows,
    recentEvents: events,
  });

  return {
    attention: dashboard.attention.map((item) => {
      switch (item.kind) {
        case "awaiting-input":
          return `input: ${item.workflow} (${item.generatedUi.step.name})`;
        case "failing-workflow":
          return `failing: ${item.workflow} ×${item.erroredRuns} (${item.error})`;
        case "connection-unavailable":
          return `unavailable: ${item.connection.connectionId}`;
      }
      throw new Error("Unsupported dashboard attention item.");
    }),
    // Runs created within one millisecond tie on recency, so workflows are compared by name.
    workflows: dashboard.workflows
      .map(
        (workflow) =>
          `${workflow.workflow}: ${workflow.startedRuns} started, ${workflow.completedRuns} complete, ${workflow.erroredRuns} errored, last ${workflow.latestRun.status}`,
      )
      .sort(),
    sources: dashboard.eventVolume.sources.map(({ source, count }) => `${source} ×${count}`),
    orchestration: {
      routes: graph.routes.map(
        ({ eventId, priority, label, action }) =>
          `${eventId} → P${priority} ${label} → ${action.kind === "reclassify_event" ? action.eventId : action.targetId}`,
      ),
      targets: graph.targets.map(({ label, activeCount }) => `${label}: ${activeCount} running`),
      recent: graph.events
        .filter(({ recentCount }) => recentCount > 0)
        .map(({ id, recentCount }) => `${id} ×${recentCount}`)
        .sort(),
    },
    connections: dashboard.connections.map(
      ({ connectionId, state }) => `${connectionId}: ${state}`,
    ),
    upcoming: dashboard.upcoming.map((entry) =>
      entry.kind === "schedule"
        ? `schedule: ${entry.name} at ${entry.at.toISOString()}`
        : `waiting: ${entry.workflow} for ${entry.waitingFor.join(", ")}`,
    ),
  };
}

describe("dashboard", () => {
  test("separates what needs a person from how automations and events are doing", async () => {
    const start = Date.now();
    const twoDaysLater = start + 2 * DAY_MS;
    const createRun = (name: string, instanceId: string, at: number) =>
      ({
        orgId,
        instanceId,
        path: `/workspace/automations/${name}.workflow.js`,
        event: event(`trigger-${instanceId}`, "shop", "order.manual", at),
      }) as const;

    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "a dashboard over two days of automation activity",
        files: backofficeFiles.custom({ workspace: workflows }),
        // Failing card charges are part of what the dashboard reports.
        options: { allowErroredWorkflows: true },
        setup: ({ given }) => [
          given.organization.exists({ id: orgId, name: "Ada Labs" }),
          given.router.route({
            orgId,
            id: "ship-placed-orders",
            name: "Ship placed orders",
            enabled: true,
            priority: 100,
            trigger: { kind: "event", source: "shop", eventType: "order.placed", matcher: null },
            action: {
              kind: "start_workflow",
              authority: { kind: "organization-automation", grants: [] },
              workflowScriptPath: "/workspace/automations/ship-order.workflow.js",
              instanceIdTemplate: "ship-${event.id}",
            },
          }),
          given.router.route({
            orgId,
            id: "new-year-digest",
            name: "New year digest",
            enabled: true,
            priority: 200,
            trigger: { kind: "schedule", cadence: { kind: "once", at: SCHEDULED_AT } },
            action: {
              kind: "start_workflow",
              authority: { kind: "organization-automation", grants: [] },
              workflowScriptPath: "/workspace/automations/ship-order.workflow.js",
              instanceIdTemplate: "digest-${event.id}",
            },
          }),
        ],
        steps: ({ when, then }) => [
          when.workflow.createInstance(createRun("charge-card", "charge-1", start)),
          when.automation.ingestEvent(event("hook-1", "acme", "webhook.received", start)),
          when.time.advance("2 days"),
          when.workflow.createInstance(createRun("charge-card", "charge-2", twoDaysLater)),
          when.workflow.createInstance(createRun("approve-refund", "refund-1", twoDaysLater)),
          when.workflow.createInstance(createRun("await-shipment", "shipment-1", twoDaysLater)),
          when.automation.ingestEvent(event("order-1", "shop", "order.placed", twoDaysLater)),
          when.automation.ingestEvent(event("hook-2", "acme", "webhook.received", twoDaysLater)),
          when.automation.ingestEvent(event("hook-3", "acme", "webhook.received", twoDaysLater)),
          when.automation.ingestEvent(
            connectionEvent("billing-ready", "ready", "api#billing", twoDaysLater),
          ),
          when.automation.ingestEvent(
            connectionEvent("agensi-ready", "ready", "mcp#agensi", start),
          ),
          when.automation.ingestEvent(
            connectionEvent("agensi-unavailable", "unavailable", "mcp#agensi", twoDaysLater),
          ),
          then.assert(
            "the last day surfaces today's failure but not the older one, the open form, and the outage",
            async (ctx) => {
              assert.deepEqual(await readDashboard(ctx), {
                attention: [
                  "input: approve-refund (ask for approval)",
                  "failing: charge-card ×1 (Error: card declined)",
                  "unavailable: mcp#agensi",
                ],
                workflows: [
                  "approve-refund: 1 started, 0 complete, 0 errored, last waiting",
                  "await-shipment: 1 started, 0 complete, 0 errored, last waiting",
                  "charge-card: 1 started, 0 complete, 1 errored, last errored",
                  "ship-order: 1 started, 1 complete, 0 errored, last complete",
                ],
                sources: ["acme ×2", "integrations ×2", "shop ×1"],
                // Both routes start the same workflow, so they meet at one target.
                orchestration: {
                  routes: [
                    "shop:order.placed → P100 Ship placed orders → workflow:/workspace/automations/ship-order.workflow.js",
                    "scheduler:schedule:new-year-digest → P200 New year digest → workflow:/workspace/automations/ship-order.workflow.js",
                  ],
                  targets: ["ship-order: 0 running"],
                  recent: [
                    "acme:webhook.received ×2",
                    "integrations:connection.ready ×1",
                    "integrations:connection.unavailable ×1",
                    "shop:order.placed ×1",
                  ],
                },
                connections: ["api#billing: ready", "mcp#agensi: unavailable"],
                upcoming: [
                  "waiting: await-shipment for shipped",
                  `schedule: New year digest at ${SCHEDULED_AT}`,
                ],
              });
            },
          ),
        ],
      }),
    );
  });
});
