import { assert, describe, test, vi } from "vitest";

import type { AutomationEvent } from "@fragno-dev/backoffice-api/v0/events";
import {
  layoutWorkflowRun,
  reachedWorkflowEndIds,
} from "@fragno-private/design-system/workflow-run-timeline-model";

import { visualizeWorkflowSource } from "@fragno-dev/workflow-visualizer-tokens";

import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import { readAutomationReplica } from "@/fragno/automation/lofi/testing";
import {
  backofficeFiles,
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";

import { ApiObject } from "../../../../../workers/api-object";
import { AuthObject } from "../../../../../workers/auth-object";
import { AutomationsObject } from "../../../../../workers/automations-object";
import { BillingObject } from "../../../../../workers/billing-object";
import { CodemodeObject } from "../../../../../workers/codemode-object";
import { FormsObject } from "../../../../../workers/forms-object";
import { projectWorkflowRunTimeline } from "./workflow-run-timeline-presentation";

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
  AUTH: (input) => new AuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new AutomationsObject(input),
  BILLING: (input) => new BillingObject(input),
  CODEMODE: (input) => new CodemodeObject(input),
  FORMS: (input) => new FormsObject(input),
  MCP: null,
  TELEGRAM: null,
  UPLOAD: null,
} satisfies LocalBackofficeObjects;

const WORKFLOW_PATH = "/workspace/automations/ship-order.workflow.js";
const INSTANCE_ID = "ship-order-run";

const SHIP_ORDER_WORKFLOW = `export default defineWorkflow({ name: "ship-order" }, async (event, step) => {
  const order = await step.do("load order", async () => ({ total: event.payload.total }));
  if (order.total > 100) {
    await step.do("escalate", async () => "escalated");
    return "escalated";
  }
  await step.waitForEvent("approval", { type: "approved", timeout: "1 hour" });
  await step.sleep("cool down", "5 seconds");
  await step.do("ship order", async () => "shipped");
  return "shipped";
});`;

const scope = { kind: "org" as const, orgId: "org-1", jurisdiction: null };

const orderPlaced: AutomationEvent = {
  id: "order-placed-1",
  scopeRestriction: null,
  scope,
  source: "shop",
  eventType: "order.placed",
  occurredAt: "2026-01-01T00:00:00.000Z",
  payload: { total: 42 },
  actors: createBackofficeSystemExecution(scope).actors,
  subject: { scope: { kind: "org", orgId: "org-1", jurisdiction: null } },
  causation: { kind: "origin" },
};

/** Reads the run the way the run page does and flattens the laid-out rows. */
async function timelineRows(ctx: BackofficeScenarioContext) {
  const replica = ctx.lofi.automations.forOrg("org-1");
  await replica.drain();
  const [instance] = await readAutomationReplica(replica.replica, "workflowRuns", {
    type: "instance",
    workflowName: "codemode-script",
    instanceId: INSTANCE_ID,
  });
  assert(instance?.codemode, "Expected the Codemode run to synchronize.");
  const timeline = projectWorkflowRunTimeline({
    instance,
    visualization: visualizeWorkflowSource(instance.codemode.filename, instance.codemode.code),
  });
  const layout = layoutWorkflowRun(timeline.nodes, new Set(), timeline.trigger);
  const reachedEndIds = reachedWorkflowEndIds(layout, timeline.status);

  return {
    status: timeline.status,
    unmappedStepCount: timeline.unmappedStepCount,
    rows: layout.rows.map((row) => {
      switch (row.kind) {
        case "start":
          return `start ${row.trigger}`;
        case "end":
          return `${row.end.reason} ${row.end.label}${reachedEndIds.has(row.id) ? " (reached)" : ""}`;
        case "step": {
          const { timing } = row.step;
          const span =
            timing.kind !== "span"
              ? ""
              : timing.endedAt === null
                ? " open"
                : ` ${Math.round((timing.endedAt - timing.startedAt) / 1000)}s`;
          return `${row.step.label}: ${row.step.status}${span}`;
        }
      }
      throw new Error("Unsupported timeline row.");
    }),
  };
}

describe("workflow run timeline", () => {
  test("draws a Codemode run from the program it executed, with inferred step spans", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "a shipped order shows its waits, inferred work spans, and the branch it skipped",
        files: backofficeFiles.custom({
          workspace: { "automations/ship-order.workflow.js": SHIP_ORDER_WORKFLOW },
        }),
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ when, then }) => [
          when.workflow.createInstance({
            orgId: "org-1",
            instanceId: INSTANCE_ID,
            path: WORKFLOW_PATH,
            event: orderPlaced,
          }),
          then.assert("the run waits for approval", async (ctx) => {
            assert.deepEqual(await timelineRows(ctx), {
              status: "waiting",
              unmappedStepCount: 0,
              rows: [
                "start shop · order.placed",
                "load order: completed 0s",
                "escalate: pending",
                "return early return",
                "approval: waiting open",
                "cool down: pending",
                "ship order: pending",
                "return return",
              ],
            });
          }),
          when.time.advance("30 minutes"),
          when.workflow.sendEvent({
            orgId: "org-1",
            instanceId: INSTANCE_ID,
            type: "approved",
            payload: { by: "ada" },
          }),
          when.time.advance("10 seconds"),
          then.assert("the shipped run skips the escalation", async (ctx) => {
            assert.deepEqual(await timelineRows(ctx), {
              status: "complete",
              unmappedStepCount: 0,
              rows: [
                "start shop · order.placed",
                "load order: completed 0s",
                "escalate: skipped",
                "return early return",
                "approval: completed 1800s",
                "cool down: completed 10s",
                "ship order: completed 0s",
                "return return (reached)",
              ],
            });
          }),
        ],
      }),
    );
  });
});
