import { assert, describe, test, vi } from "vitest";

import type { AutomationEvent } from "@fragno-dev/backoffice-api/v0/events";
import {
  layoutWorkflowRun,
  reachedWorkflowEndIds,
  type WorkflowRunNode,
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

const MIRROR_PATH = "/workspace/automations/mirror.workflow.js";
const MIRROR_INSTANCE_ID = "mirror-run";

const MIRROR_WORKFLOW = `export default defineWorkflow({ name: "mirror" }, async (event, step) => {
  const plan = await step.do("pin snapshot", async () => ({ count: 3 }));
  for (let i = 0; i < plan.count; i += 1) {
    await step.do("download batch " + i, async () => i);
    await step.sleep("cool down", "5 seconds");
  }
  await step.do("publish", async () => "published");
  return "published";
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

/** The steps of the timeline, outside loops and in them, so every repeated step is expanded. */
function timelineStepIds(nodes: readonly WorkflowRunNode[]): string[] {
  return nodes.flatMap((node) => {
    switch (node.kind) {
      case "step":
        return [node.step.id];
      case "end":
        return [];
      case "section":
      case "loop":
        return timelineStepIds(node.nodes);
      case "try":
        return timelineStepIds([...node.body, ...node.catch, ...node.finally]);
      case "fork":
        return node.branches.flatMap((branch) => timelineStepIds(branch.nodes));
    }
    throw new Error("Unsupported timeline node.");
  });
}

/**
 * Reads the run the way the run page does and flattens the laid-out rows, with every repeated
 * step expanded into its iterations.
 */
async function timelineRows(ctx: BackofficeScenarioContext, instanceId = INSTANCE_ID) {
  const replica = ctx.lofi.automations.forOrg("org-1");
  await replica.drain();
  const [instance] = await readAutomationReplica(replica.replica, "workflowRuns", {
    type: "instance",
    workflowName: "codemode-script",
    instanceId,
  });
  assert(instance?.codemode, "Expected the Codemode run to synchronize.");
  const timeline = projectWorkflowRunTimeline({
    instance,
    visualization: visualizeWorkflowSource(instance.codemode.filename, instance.codemode.code),
  });
  const layout = layoutWorkflowRun(
    timeline.nodes,
    new Set(timelineStepIds(timeline.nodes)),
    timeline.trigger,
  );
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
        case "loop":
          return row.loop.label;
        case "step": {
          const { timing, iterations } = row.step;
          const span =
            timing.kind !== "span"
              ? ""
              : timing.endedAt === null
                ? " open"
                : ` ${Math.round((timing.endedAt - timing.startedAt) / 1000)}s`;
          const indent = "  ".repeat(row.depth);
          // A repeated step's spans are its iterations', which follow it.
          return iterations.length === 0
            ? `${indent}${row.step.label}: ${row.step.status}${span}`
            : `${indent}${row.step.label} ×${iterations.length}: ${row.step.status}`;
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

  test("draws a loop once, under its header, with each step's iterations beneath it", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "a batched mirror shows its loop, and each batch it downloaded",
        files: backofficeFiles.custom({
          workspace: { "automations/mirror.workflow.js": MIRROR_WORKFLOW },
        }),
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ when, then }) => [
          when.workflow.createInstance({
            orgId: "org-1",
            instanceId: MIRROR_INSTANCE_ID,
            path: MIRROR_PATH,
            event: orderPlaced,
          }),
          then.assert("the first iteration cools down", async (ctx) => {
            assert.deepEqual(await timelineRows(ctx, MIRROR_INSTANCE_ID), {
              status: "waiting",
              unmappedStepCount: 0,
              rows: [
                "start shop · order.placed",
                "pin snapshot: completed 0s",
                "for (let i = 0; i < plan.count; i += 1)",
                "download batch … ×1: completed",
                "  download batch 0: completed 0s",
                "cool down ×1: waiting",
                "  cool down: waiting open",
                "publish: pending",
                "return return",
              ],
            });
          }),
          when.time.advance("5 seconds"),
          when.time.advance("5 seconds"),
          when.time.advance("5 seconds"),
          then.assert("every batch reads as an iteration of the loop", async (ctx) => {
            assert.deepEqual(await timelineRows(ctx, MIRROR_INSTANCE_ID), {
              status: "complete",
              unmappedStepCount: 0,
              rows: [
                "start shop · order.placed",
                "pin snapshot: completed 0s",
                "for (let i = 0; i < plan.count; i += 1)",
                "download batch … ×3: completed",
                "  download batch 0: completed 0s",
                "  download batch 1: completed 0s",
                "  download batch 2: completed 0s",
                "cool down ×3: completed",
                "  cool down: completed 5s",
                "  cool down: completed 5s",
                "  cool down: completed 5s",
                "publish: completed 0s",
                "return return (reached)",
              ],
            });
          }),
        ],
      }),
    );
  });
});
