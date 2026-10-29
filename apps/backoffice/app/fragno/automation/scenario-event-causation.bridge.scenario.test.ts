import { afterAll, beforeAll, expect, test, vi } from "vitest";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import { createCodemodeTestServer } from "@fragno-dev/codemode/testing/codemode-test-server";
import type { CausalFlameNode } from "@fragno-private/design-system/causal-flame-graph-model";

import { allLocalObjects } from "@/backoffice-runtime/all-local-objects";
import type { BackofficeRuntimeEnv } from "@/backoffice-runtime/backoffice-runtime-env";
import { createNodeBackofficeRuntimeConfiguration } from "@/backoffice-runtime/node/node-runtime-env";
import { readAutomationReplica } from "@/fragno/automation/lofi/testing";
import { projectEventTrace } from "@/routes/backoffice/dashboard/event-traces";

import { buildGitHubAutomationEvent } from "../github";
import { CODEMODE_WORKFLOW } from "./engine/codemode-invocation";
import { backofficeFiles, defineBackofficeScenario, runBackofficeScenario } from "./scenario";

let server: Awaited<ReturnType<typeof createCodemodeTestServer>>;
let runtimeEnv: BackofficeRuntimeEnv;
beforeAll(async () => {
  server = await createCodemodeTestServer();
  runtimeEnv = createNodeBackofficeRuntimeConfiguration({
    bridgeUrl: server.url,
    bridgeApiKey: server.apiKey,
    env: {},
  }).runtimeEnv;
});
afterAll(async () => {
  await server?.close();
});

const scope = { kind: "org" as const, orgId: "org-1", jurisdiction: null };
const webhookEventId = "github-delivery-1";
const issueOpenedEventId = `reclassified:promote-issue-opened:${webhookEventId}`;

function gitHubIssueEvent(hookId: string, issue: { number: number; title: string }) {
  return buildGitHubAutomationEvent({
    scope,
    event: {
      name: "issues",
      payload: { action: "opened", issue: { id: issue.number * 100, ...issue, state: "open" } },
    },
    meta: {
      hookId,
      deliveryId: `delivery-${hookId}`,
      event: "issues",
      action: "opened",
      installationId: "installation-1",
      receivedAt: "2026-10-18T09:00:00.000Z",
    },
  });
}

/** One line per node, siblings in label order, so the tree reads like the flame graph's chain. */
function outline(node: CausalFlameNode, depth = 0): string[] {
  const detail = node.detail === null ? "" : ` (${node.detail})`;
  return [
    `${"  ".repeat(depth)}${node.kind} ${node.label} [${node.status}]${detail}`,
    ...[...node.children]
      .sort((left, right) => left.label.localeCompare(right.label))
      .flatMap((child) => outline(child, depth + 1)),
  ];
}

test("events record the routes and workflows that caused them back to their origin", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: allLocalObjects,
      name: "events record the routes and workflows that caused them back to their origin",
      env: runtimeEnv,
      files: backofficeFiles.custom({
        workspace: {
          "automations/triage-issue.workflow.js": `export default defineWorkflow(
  { name: "triage-issue" },
  async (event, step) => {
    await step.do("announce triage", async () => {
      await events.fire({
        eventType: "issue.triaged",
        payload: { issueNumber: event.payload.issue.number },
      });
      // A scoped context emits on the workflow's behalf too.
      await context.current.events.fire({
        source: "github",
        eventType: "issue.labeled",
        payload: { issueNumber: event.payload.issue.number },
      });
    });
  },
);`,
          // Already running before the trace starts, so the trace only owns what its event set off.
          "automations/issue-log.workflow.js": `defineWorkflow(
  { name: "issue-log" },
  async (_event, step) => {
    for (let index = 0; index < 2; index += 1) {
      const received = await step.waitForEvent(\`issue \${index}\`, { type: "issue.opened" });
      await step.do(\`record issue \${index}\`, async () => ({
        number: received.payload.payload.issue.number,
      }));
    }
  },
);`,
        },
      }),
      setup: ({ given }) => [
        given.organization.exists({ id: scope.orgId, name: "Ada Labs" }),
        given.router.route({
          orgId: scope.orgId,
          id: "promote-issue-opened",
          name: "Promote opened issues",
          enabled: true,
          priority: 10,
          trigger: {
            kind: "event",
            source: "github",
            eventType: "webhook.received",
            matcher: { path: "$.payload.action", op: "eq", value: "opened" },
          },
          action: {
            kind: "reclassify_event",
            source: "github",
            eventType: "issues.opened",
            payload: { kind: "projection", fields: { issue: "$.payload.issue" } },
          },
        }),
        given.router.route({
          orgId: scope.orgId,
          id: "triage-issue",
          name: "Triage issues",
          enabled: true,
          priority: 20,
          trigger: { kind: "event", source: "github", eventType: "issues.opened", matcher: null },
          action: {
            kind: "start_workflow",
            authority: {
              kind: "organization-automation",
              grants: [BACKOFFICE_PERMISSION.events.emit],
            },
            workflowScriptPath: "/workspace/automations/triage-issue.workflow.js",
            instanceIdTemplate: "triage-issue-42",
          },
        }),
        given.router.route({
          orgId: scope.orgId,
          id: "assist-sender",
          name: "Assist the sender",
          enabled: true,
          priority: 30,
          trigger: { kind: "event", source: "github", eventType: "issues.opened", matcher: null },
          action: {
            kind: "start_workflow",
            authority: { kind: "linked-user", grants: "inherit" },
            workflowScriptPath: "/workspace/automations/triage-issue.workflow.js",
            instanceIdTemplate: "assist-${event.id}",
          },
        }),
        given.router.route({
          orgId: scope.orgId,
          id: "log-issues",
          name: "Log issues",
          enabled: true,
          priority: 40,
          trigger: { kind: "event", source: "github", eventType: "issues.opened", matcher: null },
          action: {
            kind: "send_workflow_event",
            target: { kind: "instance_id", template: "issue-log" },
            eventType: "issue.opened",
          },
        }),
      ],
      steps: ({ when, then }) => [
        when.workflow.createInstance({
          orgId: scope.orgId,
          instanceId: "issue-log",
          path: "/workspace/automations/issue-log.workflow.js",
          event: gitHubIssueEvent("issue-log-start", { number: 1, title: "Start the log" }),
        }),
        when.automation.ingestEvent(
          gitHubIssueEvent(webhookEventId, { number: 42, title: "Flaky deploy check" }),
        ),
        then.workflow.instance({
          workflowName: CODEMODE_WORKFLOW,
          remoteWorkflowName: "triage-issue",
          instanceId: "triage-issue-42",
          status: "complete",
        }),
        then.automation.event({
          scope,
          where: { id: issueOpenedEventId },
          expected: {
            causation: {
              kind: "route",
              routeId: "promote-issue-opened",
              parent: { eventId: webhookEventId, rootEventId: webhookEventId },
            },
          },
        }),
        then.automation.event({
          scope,
          where: { source: "github", eventType: "issue.triaged" },
          expected: {
            payload: { issueNumber: 42 },
            causation: {
              kind: "workflow",
              workflowName: CODEMODE_WORKFLOW,
              instanceId: "triage-issue-42",
              parent: { eventId: issueOpenedEventId, rootEventId: webhookEventId },
            },
          },
        }),
        then.automation.event({
          scope,
          where: { source: "github", eventType: "issue.labeled" },
          expected: {
            causation: {
              kind: "workflow",
              workflowName: CODEMODE_WORKFLOW,
              instanceId: "triage-issue-42",
              parent: { eventId: issueOpenedEventId, rootEventId: webhookEventId },
            },
          },
        }),
        then.assert("the synchronized trace shows the whole chain", async (ctx) => {
          // As the Events tab reads it, from the replica.
          const replica = ctx.lofi.automations.forOrg(scope.orgId);
          await replica.sync();
          const rows = await readAutomationReplica(replica.replica, "eventTrace", {
            rootEventId: webhookEventId,
          });
          const trace = projectEventTrace({ rootEventId: webhookEventId, ...rows });

          expect(trace && outline(trace.root)).toEqual([
            "event github · webhook.received [ok]",
            "  route Promote opened issues [ok] (Reclassified the event)",
            "    event github · issues.opened [ok]",
            "      route Assist the sender [skipped] (Skipped: No external sender linked to a user)",
            "      route Log issues [ok] (Delivered issue.opened to run issue-log)",
            "        workflow issue-log [ok] (Took issue.opened)",
            "          step record issue 0 [ok]",
            "      route Triage issues [ok] (Started a run)",
            "        workflow triage-issue [ok]",
            "          step announce triage [ok]",
            "          event github · issue.labeled [ok] (fired by triage-issue)",
            "          event github · issue.triaged [ok] (fired by triage-issue)",
          ]);

          // Live, a dispatch can synchronize before the run it started.
          const runless = projectEventTrace({
            rootEventId: webhookEventId,
            ...rows,
            runs: [],
            steps: [],
            deliveries: [],
          });
          expect(runless && outline(runless.root)).toEqual([
            "event github · webhook.received [ok]",
            "  route Promote opened issues [ok] (Reclassified the event)",
            "    event github · issues.opened [ok]",
            "      route Assist the sender [skipped] (Skipped: No external sender linked to a user)",
            "      route Log issues [ok] (Delivered issue.opened to run issue-log)",
            "      route Triage issues [ok] (Started a run)",
            "        workflow triage-issue-42 [pending] (The run is no longer recorded)",
            "          event github · issue.labeled [ok] (fired by triage-issue-42)",
            "          event github · issue.triaged [ok] (fired by triage-issue-42)",
          ]);

          const [summary] = await readAutomationReplica(replica.replica, "eventTraceSummaries", {
            limit: 10,
            origins: "all",
          });
          expect(summary).toMatchObject({
            rootEventId: webhookEventId,
            headline: "#42 Flaky deploy check",
            effects: expect.arrayContaining([
              { kind: "workflow", label: "issue-log" },
              { kind: "workflow", label: "triage-issue" },
            ]),
            outcome: { kind: "settled", failedCount: 0 },
          });
        }),
        then.hooks.noFailed({ orgId: scope.orgId, fragments: ["automations"] }),
      ],
    }),
  );
});
