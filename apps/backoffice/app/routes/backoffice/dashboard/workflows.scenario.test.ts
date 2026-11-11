import { afterAll, assert, beforeAll, describe, test, vi } from "vitest";

import type { AutomationEvent } from "@fragno-dev/backoffice-api/v0/events";
import { createCodemodeNodeExecutor } from "@fragno-dev/codemode/remote/codemode-node-executor";
import { createCodemodeTestServer } from "@fragno-dev/codemode/testing/codemode-test-server";

import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import {
  createCodemodeWorkflowInstanceInput,
  prepareCodemodeWorkflowInstance,
} from "@/fragno/automation/engine/codemode-invocation";
import { readAutomationReplica } from "@/fragno/automation/lofi/testing";
import {
  backofficeFiles,
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";
import { inlineWorkflowProgram } from "@/fragno/codemode/workflow-program";

import { ApiObject } from "../../../../workers/api-object";
import { AppInstallationsObject } from "../../../../workers/app-installations-object";
import { AppsObject } from "../../../../workers/apps-object";
import { AuthObject } from "../../../../workers/auth-object";
import { AutomationsObject } from "../../../../workers/automations-object";
import { BillingObject } from "../../../../workers/billing-object";
import { CodemodeObject } from "../../../../workers/codemode-object";
import { GitHubObject } from "../../../../workers/github-object";
import { GitHubWebhookRouterObject } from "../../../../workers/github-webhook-router-object";
import { McpObject } from "../../../../workers/mcp-object";
import { OtpObject } from "../../../../workers/otp-object";
import { ProjectConnectorObject } from "../../../../workers/project-connector-object";
import { ResendObject } from "../../../../workers/resend-object";
import { TelegramObject } from "../../../../workers/telegram-object";
import { UploadObject } from "../../../../workers/upload-object";
import { projectWorkflowHealthRuns, projectWorkflowList } from "./workflow-health";

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
  API: (input) => new ApiObject(input),
  APPS: (input) => new AppsObject(input),
  APP_INSTALLATIONS: (input) => new AppInstallationsObject(input),
  AUTH: (input) => new AuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new AutomationsObject(input),
  BILLING: (input) => new BillingObject(input),
  CODEMODE: (input) => new CodemodeObject(input),
  GITHUB: (input) => new GitHubObject(input),
  GITHUB_WEBHOOK_ROUTER: (input) => new GitHubWebhookRouterObject(input),
  MCP: (input) => new McpObject(input),
  OTP: (input) => new OtpObject(input),
  PROJECT_CONNECTOR: (input) => new ProjectConnectorObject(input),
  RESEND: (input) => new ResendObject(input),
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
const INVOICE_SYNC = "/workspace/automations/invoice-sync.workflow.js";
const CLOSE_BOOKS = "/workspace/automations/close-books.workflow.js";

/**
 * Posting a batch fails as many times as its event asks, and its one retry rescues a single
 * failure. The store counts the attempts, because the step itself cannot tell them apart. Looking
 * up the customer is optional: the workflow catches its failure and goes on.
 */
const workflows = {
  "automations/invoice-sync.workflow.js": `export default defineWorkflow({ name: "invoice-sync" }, async (event, step) => {
  const invoices = await step.do("fetch invoices", async () => event.payload.invoices);
  if (event.payload.lookupFails) {
    try {
      await step.do("look up customer", async () => {
        throw new Error("customer directory unavailable");
      });
    } catch {}
  }
  if (event.payload.malformed) {
    throw new Error("malformed batch");
  }
  await step.do("post to ledger", { retries: { limit: 1, delay: 0 } }, async () => {
    const key = \`post-attempts-\${event.payload.batch}\`;
    const previous = await context.current.store.get({ key });
    const attempt = Number(previous?.value ?? 0) + 1;
    await context.current.store.set({ key, value: String(attempt) });
    if (attempt <= event.payload.failures) {
      throw new Error(\`ledger rejected batch \${event.payload.batch}\`);
    }
    return invoices.length;
  });
});`,
  "automations/close-books.workflow.js": `export default defineWorkflow({ name: "close-books" }, async (event, step) => {
  await step.do("close", async () => "closed");
});`,
};

const startWorkflow = (workflowScriptPath: string) => ({
  kind: "start_workflow" as const,
  authority: { kind: "organization-automation" as const, grants: [] },
  workflowScriptPath,
  instanceIdTemplate: "run-${event.id}",
});

function syncRequested(
  batch: number,
  payload: { failures: number; malformed: boolean; lookupFails: boolean },
  at: number,
): AutomationEvent {
  return {
    id: `sync-${batch}`,
    scopeRestriction: null,
    scope,
    source: "ledger",
    eventType: "sync.requested",
    occurredAt: new Date(at).toISOString(),
    payload: { batch, invoices: ["INV-1", "INV-2"], ...payload },
    actors: createBackofficeSystemExecution(scope).actors,
    subject: { scope },
    causation: { kind: "origin" },
  };
}

/** A run of a workflow an agent wrote inline, as its Codemode tool starts one. */
function inlineRun(instanceId: string) {
  const { params } = createCodemodeWorkflowInstanceInput({
    prepared: prepareCodemodeWorkflowInstance({
      program: inlineWorkflowProgram({
        filename: "/pi/assistant/tally.workflow.js",
        code: `defineWorkflow({ name: "tally" }, async (event, step) => {
  await step.do("count", async () => 1);
});`,
        modules: {},
      }),
      instanceId,
    }),
    trigger: { type: "manual", payload: {} },
    execution: createBackofficeSystemExecution(scope),
    replyTo: null,
  });
  return { orgId, instanceId, remoteWorkflowName: "tally", params };
}

/** The Workflows tab's list and invoice-sync's latest `limit` runs, in a line each. */
async function readWorkflows(ctx: BackofficeScenarioContext, limit: number) {
  const handle = ctx.lofi.automations.forOrg(orgId);
  await handle.drain();
  const [list, runs] = await Promise.all([
    readAutomationReplica(handle.replica, "workflowList", undefined),
    readAutomationReplica(handle.replica, "workflowScriptRuns", {
      scriptPath: INVOICE_SYNC,
      limit,
    }),
  ]);
  return {
    workflows: projectWorkflowList(list).map(
      ({ name, startedBy, runCount, erroredCount, latestRun }) =>
        `${name} (${startedBy.join(", ")}): ${runCount} runs, ${erroredCount} failed, latest ${latestRun?.status ?? "none"}`,
    ),
    runs: projectWorkflowHealthRuns(runs).map((run) => {
      const steps = run.steps.map((step) => `${step.name} ${step.status}×${step.attempts}`);
      const error =
        run.status === "errored"
          ? ` (${run.error}) at ${run.steps.find((step) => step.id === run.failedStepId)?.name ?? "no step"}`
          : "";
      return `${run.id} ${run.status}${error} by ${run.trigger}: ${steps.join(", ")}`;
    }),
  };
}

describe("workflows", () => {
  test("follows each saved workflow through its runs, down to the step each failed at", async () => {
    const start = Date.now();
    const sync = (
      batch: number,
      payload: { failures: number; malformed: boolean; lookupFails: boolean },
    ) => ({
      orgId,
      instanceId: `run-sync-${batch}`,
      path: INVOICE_SYNC,
      event: syncRequested(batch, payload, start + batch * 60_000),
    });

    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        env: { codemode: createCodemodeNodeExecutor(codemodeServer) },
        name: "invoice syncs complete, recover with a retry, and fail, while the books wait to close",
        files: backofficeFiles.custom({ workspace: workflows }),
        options: { allowErroredWorkflows: true },
        setup: ({ given }) => [
          given.organization.exists({ id: orgId, name: "Ada Labs" }),
          given.router.route({
            orgId,
            id: "sync-on-request",
            name: "Sync on request",
            enabled: true,
            priority: 10,
            trigger: {
              kind: "event",
              source: "ledger",
              eventType: "sync.requested",
              matcher: null,
            },
            action: startWorkflow(INVOICE_SYNC),
          }),
          given.router.route({
            orgId,
            id: "weekly-close",
            name: "Weekly close",
            enabled: true,
            priority: 20,
            trigger: {
              kind: "schedule",
              cadence: { kind: "cron", expression: "0 9 * * 1", timeZone: "Europe/Amsterdam" },
            },
            action: startWorkflow(CLOSE_BOOKS),
          }),
        ],
        steps: ({ when, then }) => [
          then.assert("a workflow a route starts is listed before it runs", async (ctx) => {
            assert.deepEqual(await readWorkflows(ctx, 10), {
              workflows: [
                "close-books (Every Monday at 09:00 Europe/Amsterdam): 0 runs, 0 failed, latest none",
                "invoice-sync (ledger · sync.requested): 0 runs, 0 failed, latest none",
              ],
              runs: [],
            });
          }),
          when.time.advance("1 minute"),
          when.workflow.createInstance(
            sync(1, { failures: 0, malformed: false, lookupFails: false }),
          ),
          when.time.advance("1 minute"),
          when.workflow.createInstance(
            sync(2, { failures: 1, malformed: false, lookupFails: false }),
          ),
          when.time.advance("1 minute"),
          when.workflow.createInstance(
            sync(3, { failures: 2, malformed: false, lookupFails: false }),
          ),
          when.time.advance("1 minute"),
          when.workflow.createInstance(
            sync(4, { failures: 0, malformed: true, lookupFails: false }),
          ),
          then.assert(
            "runs read newest first, with the attempts that rescued one and the step another failed at",
            async (ctx) => {
              assert.deepEqual(await readWorkflows(ctx, 10), {
                workflows: [
                  "close-books (Every Monday at 09:00 Europe/Amsterdam): 0 runs, 0 failed, latest none",
                  "invoice-sync (ledger · sync.requested): 4 runs, 2 failed, latest errored",
                ],
                runs: [
                  "run-sync-4 errored (malformed batch) at no step by ledger · sync.requested: fetch invoices completed×1",
                  "run-sync-3 errored (ledger rejected batch 3) at post to ledger by ledger · sync.requested: fetch invoices completed×1, post to ledger failed×2",
                  "run-sync-2 complete by ledger · sync.requested: fetch invoices completed×1, post to ledger completed×2",
                  "run-sync-1 complete by ledger · sync.requested: fetch invoices completed×1, post to ledger completed×1",
                ],
              });
            },
          ),
          when.workflow.createInstance(inlineRun("run-inline")),
          then.assert(
            "a run linked on its own finds the saved workflow it ran, and an agent's inline run none",
            async (ctx) => {
              const handle = ctx.lofi.automations.forOrg(orgId);
              await handle.drain();
              assert.deepEqual(
                await Promise.all(
                  ["run-sync-2", "run-inline", "run-missing"].map((instanceId) =>
                    readAutomationReplica(handle.replica, "workflowRunScript", { instanceId }),
                  ),
                ),
                [INVOICE_SYNC, null, null],
              );
              // The agent's script is no workflow to follow.
              assert.deepEqual(
                (await readWorkflows(ctx, 1)).workflows.map((line) => line.split(" ", 1)[0]),
                ["close-books", "invoice-sync"],
              );
            },
          ),
          then.assert("the latest runs leave the older ones out", async (ctx) => {
            const { runs } = await readWorkflows(ctx, 2);
            assert.deepEqual(
              runs.map((run) => run.split(" ", 1)[0]),
              ["run-sync-4", "run-sync-3"],
            );
          }),
          when.time.advance("1 minute"),
          when.workflow.createInstance(
            sync(5, { failures: 2, malformed: false, lookupFails: true }),
          ),
          when.time.advance("1 minute"),
          when.workflow.createInstance(
            sync(6, { failures: 0, malformed: true, lookupFails: true }),
          ),
          then.assert(
            "a run that caught a step's failure fails where it ended, at a later step or outside them",
            async (ctx) => {
              const { runs } = await readWorkflows(ctx, 2);
              assert.deepEqual(runs, [
                "run-sync-6 errored (malformed batch) at no step by ledger · sync.requested: fetch invoices completed×1, look up customer failed×1",
                "run-sync-5 errored (ledger rejected batch 5) at post to ledger by ledger · sync.requested: fetch invoices completed×1, look up customer failed×1, post to ledger failed×2",
              ]);
            },
          ),
        ],
      }),
    );
  });
});
