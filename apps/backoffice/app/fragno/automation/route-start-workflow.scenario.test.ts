import { afterAll, assert, beforeAll, expect, test, vi } from "vitest";

import type { AutomationStartWorkflowExistingRun } from "@fragno-dev/backoffice-api/v0/automation";
import type { AutomationEvent } from "@fragno-dev/backoffice-api/v0/events";
import { createCodemodeNodeExecutor } from "@fragno-dev/codemode/remote/codemode-node-executor";
import { createCodemodeTestServer } from "@fragno-dev/codemode/testing/codemode-test-server";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import {
  backofficeFiles,
  type BackofficeScenarioContext,
  defineBackofficeScenario,
  runBackofficeScenario,
} from "@/fragno/automation/scenario";
import { createInteractiveBashHost } from "@/fragno/runtime-tools/automation-host";
import { createRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";

import { ApiObject } from "../../../workers/api-object";
import { AppInstallationsObject } from "../../../workers/app-installations-object";
import { AppsObject } from "../../../workers/apps-object";
import { AuthObject } from "../../../workers/auth-object";
import { AutomationsObject } from "../../../workers/automations-object";
import { BillingObject } from "../../../workers/billing-object";
import { CodemodeObject } from "../../../workers/codemode-object";
import { McpObject } from "../../../workers/mcp-object";
import { TelegramObject } from "../../../workers/telegram-object";
import { UploadObject } from "../../../workers/upload-object";

const scenarioObjects = {
  API: (input) => new ApiObject(input),
  APPS: (input) => new AppsObject(input),
  APP_INSTALLATIONS: (input) => new AppInstallationsObject(input),
  AUTH: (input) => new AuthObject({ ...input, database: input.getAuthDatabase() }),
  BILLING: (input) => new BillingObject(input),
  AUTOMATIONS: (input) => new AutomationsObject(input),
  CODEMODE: (input) => new CodemodeObject(input),
  MCP: (input) => new McpObject(input),
  TELEGRAM: (input) => new TelegramObject(input),
  UPLOAD: (input) => new UploadObject(input),
} satisfies LocalBackofficeObjects;

// Workflow modules build through a compiler that bundles saved modules.
let codemodeServer: Awaited<ReturnType<typeof createCodemodeTestServer>>;
beforeAll(async () => {
  codemodeServer = await createCodemodeTestServer();
});
afterAll(async () => {
  await codemodeServer?.close();
});

const orgId = "org-1";
const scope = { kind: "org" as const, orgId, jurisdiction: null };

function incidentOpened(id: string, incidentId: string): AutomationEvent {
  return {
    id,
    scopeRestriction: null,
    scope,
    source: "pagerduty",
    eventType: "incident.opened",
    occurredAt: new Date().toISOString(),
    payload: { incidentId },
    actors: createBackofficeSystemExecution(scope).actors,
    subject: { scope },
    causation: { kind: "origin" },
  };
}

/** The line `events.get` prints for the event's one route, as an agent reads it. */
async function routeLine(ctx: BackofficeScenarioContext, eventId: string) {
  const context = createRouteBackedRuntimeContext({
    emitter: { kind: "caller" },
    runtime: ctx.runtime.services,
    kernel: new BackofficeKernel(ctx.runtime.services),
    execution: createBackofficeSystemExecution(scope),
  });
  assert(context.stateBackend);
  const { bash } = await createInteractiveBashHost({
    context: { ...context, stateBackend: context.stateBackend },
  });
  const got = await bash.exec(`events.get --id ${eventId}`);
  expect(got.exitCode, got.stderr).toBe(0);
  return got.stdout.split("\nroutes\n")[1]?.trim();
}

/** A triage per incident, which runs until the incident is resolved. */
function triageScenario(
  name: string,
  existingRun: AutomationStartWorkflowExistingRun,
  steps: Parameters<typeof defineBackofficeScenario>[0]["steps"],
) {
  return defineBackofficeScenario({
    objects: scenarioObjects,
    env: { codemode: createCodemodeNodeExecutor(codemodeServer) },
    name,
    files: backofficeFiles.custom({
      workspace: {
        "automations/triage.workflow.js": `export default defineWorkflow({ name: "triage" }, async (event, step) => {
  await step.waitForEvent("resolved", { type: "resolved" });
});`,
      },
    }),
    setup: ({ given }) => [
      given.organization.exists({ id: orgId, name: "Ada Labs" }),
      given.router.route({
        orgId,
        id: "triage",
        name: "Triage incidents",
        enabled: true,
        priority: 10,
        trigger: {
          kind: "event",
          source: "pagerduty",
          eventType: "incident.opened",
          matcher: null,
        },
        action: {
          kind: "start_workflow",
          authority: { kind: "organization-automation", grants: [] },
          workflowScriptPath: "/workspace/automations/triage.workflow.js",
          instanceIdTemplate: "triage-${event.payload.incidentId}",
          existingRun,
        },
      }),
    ],
    steps,
  });
}

test("a route starts one triage per incident and skips reports of one that has a run", async () => {
  await runBackofficeScenario(
    triageScenario("incident triage keyed by incident", "keep", ({ when, then }) => [
      when.automation.ingestEvent(incidentOpened("opened-1", "INC-1")),
      when.automation.ingestEvent(incidentOpened("opened-2", "INC-1")),
      when.automation.ingestEvent(incidentOpened("opened-3", "INC-2")),
      then.assert("a second report of a running incident skips", async (ctx) => {
        assert.equal(
          await routeLine(ctx, "opened-1"),
          "triage (Triage incidents): completed, workflow_started",
        );
        assert.equal(
          await routeLine(ctx, "opened-2"),
          "triage (Triage incidents): completed, skipped, workflow_instance_exists",
        );
        assert.equal(
          await routeLine(ctx, "opened-3"),
          "triage (Triage incidents): completed, workflow_started",
        );
      }),
      then.workflow.instance({ instanceId: "triage-INC-1", status: "waiting" }),
      when.workflow.sendEvent({
        orgId,
        instanceId: "triage-INC-1",
        type: "resolved",
        payload: {},
      }),
      then.workflow.instance({ instanceId: "triage-INC-1", status: "complete" }),
      when.automation.ingestEvent(incidentOpened("reopened-1", "INC-1")),
      then.assert("a finished triage stays finished", async (ctx) => {
        assert.equal(
          await routeLine(ctx, "reopened-1"),
          "triage (Triage incidents): completed, skipped, workflow_instance_exists",
        );
      }),
      then.workflow.instance({ instanceId: "triage-INC-1", status: "complete" }),
      then.hooks.noFailed({ orgId }),
    ]),
  );
});

test("a route that restarts finished runs triages a reopened incident again", async () => {
  await runBackofficeScenario(
    triageScenario("reopened incidents triaged again", "restart_finished", ({ when, then }) => [
      when.automation.ingestEvent(incidentOpened("opened-1", "INC-1")),
      when.automation.ingestEvent(incidentOpened("opened-2", "INC-1")),
      then.assert("a report while the triage runs skips", async (ctx) => {
        assert.equal(
          await routeLine(ctx, "opened-2"),
          "triage (Triage incidents): completed, skipped, workflow_instance_exists",
        );
      }),
      when.workflow.sendEvent({ orgId, instanceId: "triage-INC-1", type: "resolved", payload: {} }),
      then.workflow.instance({ instanceId: "triage-INC-1", status: "complete" }),
      when.automation.ingestEvent(incidentOpened("reopened-1", "INC-1")),
      then.assert("a reopened incident starts its triage again", async (ctx) => {
        assert.equal(
          await routeLine(ctx, "reopened-1"),
          "triage (Triage incidents): completed, workflow_started",
        );
      }),
      then.workflow.instance({ instanceId: "triage-INC-1", status: "waiting" }),
      then.hooks.noFailed({ orgId }),
    ]),
  );
});
