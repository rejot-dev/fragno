import { assert, describe, test, vi } from "vitest";

import type { AutomationEvent } from "@fragno-dev/backoffice-api/v0/events";
import {
  layoutWorkflowRun,
  reachedWorkflowEndIds,
} from "@fragno-private/design-system/workflow-run-timeline-model";

import { visualizeWorkflowSource } from "@fragno-dev/workflow-visualizer-tokens";

import { queryOnce } from "@tanstack/react-db";

import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import {
  backofficeFiles,
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";

import { InMemoryApiObject } from "../../../../../workers/api.do";
import { InMemoryAuthObject } from "../../../../../workers/auth.do";
import { InMemoryAutomationsObject } from "../../../../../workers/automations.do";
import { InMemoryFormsObject } from "../../../../../workers/forms.do";
import {
  automationWorkflowRunsFromRecords,
  workflowRunRecordsQuery,
} from "./use-script-workflow-runs";
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
  API: (input) => new InMemoryApiObject(input),
  AUTH: (input) => new InMemoryAuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new InMemoryAutomationsObject(input),
  FORMS: (input) => new InMemoryFormsObject(input),
  MCP: null,
  TELEGRAM: null,
  UPLOAD: null,
} satisfies LocalBackofficeObjects;

const WORKFLOW_PATH = "/workspace/automations/ship-order.workflow.js";
const INSTANCE_ID = "ship-order-run";

const SHIP_ORDER_WORKFLOW = `defineWorkflow({ name: "ship-order" }, async (event, step) => {
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

const scope = { kind: "org" as const, orgId: "org-1" };

const orderPlaced: AutomationEvent = {
  id: "order-placed-1",
  scopeRestriction: null,
  scope,
  source: "shop",
  eventType: "order.placed",
  occurredAt: "2026-01-01T00:00:00.000Z",
  payload: { total: 42 },
  actors: createBackofficeSystemExecution(scope).actors,
  subject: { orgId: "org-1" },
  causation: { kind: "origin" },
};

/** Reads the run the way the run page does and flattens the laid-out rows. */
async function timelineRows(ctx: BackofficeScenarioContext) {
  const database = ctx.tanstack.automations.forOrg("org-1");
  await database.drain();
  const records = await queryOnce((query) =>
    workflowRunRecordsQuery(query, database.collections, {
      type: "instance",
      workflowName: "codemode-script",
      instanceId: INSTANCE_ID,
    }),
  );
  const [instance] = automationWorkflowRunsFromRecords(records);
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
