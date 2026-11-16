import { afterEach, assert, expect, test, vi } from "vitest";

import type { AutomationEvent } from "@fragno-dev/backoffice-api/v0/events";
import type { CausalFlameNode } from "@fragno-private/design-system/workflow-runs/causal-flame-graph-model";

import {
  createBackofficeRequestExecution,
  createBackofficeSystemExecution,
  type BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import { queryAutomationReplica, readAutomationReplica } from "@/fragno/automation/lofi/testing";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";
import { createInteractiveBashHost } from "@/fragno/runtime-tools/automation-host";
import { createCodemodeRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";
import { projectEventTrace } from "@/routes/backoffice/dashboard/event-traces";

import { AuthObject } from "../../../../workers/auth-object";
import { AutomationsObject } from "../../../../workers/automations-object";
import { UploadObject } from "../../../../workers/upload-object";

const scenarioObjects = {
  API: null,
  AUTH: (input) => new AuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new AutomationsObject(input),
  UPLOAD: (input) => new UploadObject(input),
} satisfies LocalBackofficeObjects;

const orgScope = { kind: "org", orgId: "org-1", jurisdiction: null } as const;

function githubWebhookEvent(input: {
  deliveryId: string;
  githubEvent: string;
  occurredAt: string;
}): AutomationEvent {
  return {
    id: `github:${input.deliveryId}`,
    scopeRestriction: null,
    scope: orgScope,
    source: "github",
    eventType: "webhook.received",
    occurredAt: input.occurredAt,
    payload: {
      deliveryId: input.deliveryId,
      githubEvent: input.githubEvent,
      action: null,
      installationId: "installation-1",
      raw: { body: "the delivery body a browser should never download" },
    },
    actors: {
      initiator: {
        scope: "external",
        source: "github",
        type: "user",
        id: "42",
        role: "initiator",
      },
      principal: null,
      delegation: [],
    },
    subject: {
      scope: { kind: "org", orgId: "org-1", jurisdiction: null },
      installationId: "installation-1",
    },
    causation: { kind: "origin" },
  };
}

const oldWorkflowRun = githubWebhookEvent({
  deliveryId: "old-workflow-run",
  githubEvent: "workflow_run",
  occurredAt: "2026-01-01T00:00:00.000Z",
});
const oldPush = githubWebhookEvent({
  deliveryId: "old-push",
  githubEvent: "push",
  occurredAt: "2026-01-02T00:00:00.000Z",
});
const laterWorkflowRun = githubWebhookEvent({
  deliveryId: "later-workflow-run",
  githubEvent: "workflow_run",
  occurredAt: "2026-03-01T00:00:00.000Z",
});

async function terminal(ctx: BackofficeScenarioContext, execution: BackofficeExecutionContext) {
  const kernel = new BackofficeKernel(ctx.runtime.services);
  return (
    await createInteractiveBashHost({
      context: createCodemodeRouteBackedRuntimeContext({
        emitter: { kind: "caller" },
        runtime: ctx.runtime.services,
        kernel,
        execution,
      }),
    })
  ).bash;
}

/** The signed-in administrator's own terminal request. */
function administratorRequest() {
  return createBackofficeRequestExecution({
    scope: { kind: "system" },
    verifiedRequestAuthority: {
      userId: "admin-1",
      personalScope: { kind: "user" as const, userId: "admin-1", jurisdiction: null },
      role: "admin",
      organization: null,
      administeredMember: null,
      expiresAt: new Date(Date.now() + 60_000),
      scopeRestriction: null,
    },
  });
}

type ReplayedOperation = { op: string; table: string; externalId?: string; externalIds?: string[] };

/** Everything a browser opening the organization for the first time downloads. */
async function replayAutomationEventOperations(ctx: BackofficeScenarioContext) {
  const automations = new BackofficeKernel(ctx.runtime.services).scoped(
    "AUTOMATIONS",
    orgScope,
    ctx.runtime.objects.automations,
  );
  const operations: ReplayedOperation[] = [];
  let afterVersionstamp: string | null = null;
  for (;;) {
    const url = new URL("http://scenario.local/api/automations/_internal/outbox?limit=50");
    if (afterVersionstamp !== null) {
      url.searchParams.set("afterVersionstamp", afterVersionstamp);
    }
    const response = await automations.http.fetch(new Request(url));
    assert.equal(response.status, 200);
    const entries = (await response.json()) as {
      versionstamp: string;
      payload: { json: { operations: ReplayedOperation[] } };
    }[];
    if (entries.length === 0) {
      return operations.filter((operation) => operation.table === "automation_event");
    }
    operations.push(...entries.flatMap((entry) => entry.payload.json.operations));
    afterVersionstamp = entries.at(-1)!.versionstamp;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

test("an administrator deletes old events of one type from storage and sync history", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: scenarioObjects,
      name: "Administrator deletes old GitHub webhook events",
      setup: ({ given }) => [
        given.organization.exists({ id: "org-1", slug: "ada-labs", name: "Ada Labs" }),
        given.auth.user({ id: "admin-1", role: "admin" }),
      ],
      steps: ({ when, then }) => [
        when.automation.ingestEvent(oldWorkflowRun),
        when.automation.ingestEvent(oldPush),
        when.automation.ingestEvent(laterWorkflowRun),
        then.assert("only matching old events leave storage and sync history", async (ctx) => {
          await ctx.drain();
          const browser = ctx.lofi.automations.forOrg("org-1");
          const storedEventIds = async () =>
            (
              await queryAutomationReplica(
                browser,
                `SELECT id FROM events WHERE source = 'github' ORDER BY id`,
              )
            ).map(({ id }) => id);
          expect(await storedEventIds()).toEqual(
            [oldPush.id, oldWorkflowRun.id, laterWorkflowRun.id].sort(),
          );

          const recentTerminal = await terminal(ctx, administratorRequest());
          const deleteOldGitHubWebhooks =
            "admin.events.delete --org ada-labs --source github --event-type webhook.received --before 2026-02-01";

          const unconfirmed = await recentTerminal.exec(deleteOldGitHubWebhooks);
          assert.notEqual(unconfirmed.exitCode, 0);
          expect(unconfirmed.stderr).toContain("--danger");

          // Long ago by occurredAt, but just stored, so their ingestion hooks are still kept.
          const recentlyStored = await recentTerminal.exec(
            `${deleteOldGitHubWebhooks} --danger --dry-run`,
          );
          assert.equal(recentlyStored.exitCode, 0, recentlyStored.stderr);
          expect(recentlyStored.stdout).toContain("Scanned 2, would delete 0.");

          vi.useFakeTimers({ toFake: ["Date"] });
          vi.setSystemTime(Date.now() + 9 * 24 * 60 * 60 * 1000);
          const bash = await terminal(ctx, administratorRequest());

          const workflowRuns = `${deleteOldGitHubWebhooks} --payload-field githubEvent --payload-value workflow_run --danger`;
          const dryRun = await bash.exec(`${workflowRuns} --dry-run`);
          assert.equal(dryRun.exitCode, 0, dryRun.stderr);
          expect(dryRun.stdout).toContain("Scanned 2, would delete 1.");
          await browser.drain();
          expect(await storedEventIds()).toHaveLength(3);

          const filtered = await bash.exec(workflowRuns);
          assert.equal(filtered.exitCode, 0, filtered.stderr);
          expect(filtered.stdout).toContain("Scanned 2, deleted 1.");
          expect(filtered.stdout).toContain("Done.");

          const remaining = await bash.exec(`${deleteOldGitHubWebhooks} --danger`);
          assert.equal(remaining.exitCode, 0, remaining.stderr);
          expect(remaining.stdout).toContain("Scanned 1, deleted 1.");

          await browser.drain();
          expect(await storedEventIds()).toEqual([laterWorkflowRun.id]);

          const replayed = await replayAutomationEventOperations(ctx);
          const deletedIds = [oldWorkflowRun.id, oldPush.id];
          expect(
            replayed.filter(
              (operation) =>
                operation.op !== "truncate" && deletedIds.includes(operation.externalId ?? ""),
            ),
          ).toEqual([]);
          assert(
            replayed.some(
              (operation) =>
                operation.op === "create" && operation.externalId === laterWorkflowRun.id,
            ),
          );
        }),
        then.assert("deferred executions such as agents cannot delete events", async (ctx) => {
          const bash = await terminal(ctx, createBackofficeSystemExecution({ kind: "system" }));
          const result = await bash.exec(
            "admin.events.delete --org ada-labs --source github --event-type webhook.received --before 2026-02-01 --danger",
          );
          assert.notEqual(result.exitCode, 0);
          expect(result.stderr).toContain("Backoffice command unavailable");
        }),
      ],
    }),
  );
});

test("what a deleted event set in motion stays in Activity", async () => {
  const reclassify = (input: {
    id: string;
    name: string;
    from: { source: string; eventType: string };
    eventType: string;
  }) =>
    ({
      orgId: "org-1",
      id: input.id,
      name: input.name,
      enabled: true,
      priority: 1,
      trigger: { kind: "event", ...input.from, matcher: null },
      action: {
        kind: "reclassify_event",
        source: "custom",
        eventType: input.eventType,
        payload: { kind: "projection", fields: { deliveryId: "$.payload.deliveryId" } },
      },
    }) as const;
  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: scenarioObjects,
      name: "Activity after old events are deleted",
      setup: ({ given }) => [
        given.organization.exists({ id: "org-1", slug: "ada-labs", name: "Ada Labs" }),
        given.auth.user({ id: "admin-1", role: "admin" }),
      ],
      steps: ({ when, then }) => [
        when.router.createRoute(
          reclassify({
            id: "push",
            name: "Read pushes",
            from: { source: "github", eventType: "webhook.received" },
            eventType: "push.received",
          }),
        ),
        when.router.createRoute(
          reclassify({
            id: "check",
            name: "Check pushes",
            from: { source: "custom", eventType: "push.received" },
            eventType: "push.checked",
          }),
        ),
        when.automation.ingestEvent(oldPush),
        then.assert("a trace keeps what is left of it as its events are deleted", async (ctx) => {
          await ctx.drain();
          const browser = ctx.lofi.automations.forOrg("org-1");
          async function activity() {
            await browser.drain();
            const [all, actedOn, rows] = await Promise.all([
              readAutomationReplica(browser.replica, "eventTraceSummaries", {
                limit: 10,
                origins: "all",
              }),
              readAutomationReplica(browser.replica, "eventTraceSummaries", {
                limit: 10,
                origins: "acted-on",
              }),
              readAutomationReplica(browser.replica, "eventTrace", { rootEventId: oldPush.id }),
            ]);
            assert.deepEqual(actedOn, all);
            const trace = projectEventTrace({ rootEventId: oldPush.id, ...rows });
            assert(trace);
            return {
              listed: all.map(({ rootEventId, trigger }) => ({
                rootEventId,
                trigger: trigger.kind,
              })),
              trace: outline(trace.root),
            };
          }

          vi.useFakeTimers({ toFake: ["Date"] });
          vi.setSystemTime(Date.now() + 9 * 24 * 60 * 60 * 1000);
          const bash = await terminal(ctx, administratorRequest());
          async function deleteEvents(source: string, eventType: string) {
            const deleted = await bash.exec(
              `admin.events.delete --org ada-labs --source ${source} --event-type ${eventType} --before 2100-01-01 --danger`,
            );
            assert.equal(deleted.exitCode, 0, deleted.stderr);
            expect(deleted.stdout).toContain("deleted 1.");
          }

          // The route on a deleted event, and what it caused, hang from the origin.
          await deleteEvents("custom", "push.received");
          expect(await activity()).toEqual({
            listed: [{ rootEventId: oldPush.id, trigger: "event" }],
            trace: [
              "event github · webhook.received [ok]",
              "  route Check pushes [ok] (Reclassified the event)",
              "    event custom · push.checked [ok]",
              "  route Read pushes [ok] (Reclassified the event)",
            ],
          });

          await deleteEvents("github", "webhook.received");
          expect(await activity()).toEqual({
            listed: [{ rootEventId: oldPush.id, trigger: "expired" }],
            trace: [
              "event Expired event [ok]",
              "  route Check pushes [ok] (Reclassified the event)",
              "    event custom · push.checked [ok]",
              "  route Read pushes [ok] (Reclassified the event)",
            ],
          });
        }),
      ],
    }),
  );
});

/** One line per node, siblings in label order. */
function outline(node: CausalFlameNode, depth = 0): string[] {
  const detail = node.detail === null ? "" : ` (${node.detail})`;
  return [
    `${"  ".repeat(depth)}${node.kind} ${node.label} [${node.status}]${detail}`,
    ...[...node.children]
      .sort((left, right) => left.label.localeCompare(right.label))
      .flatMap((child) => outline(child, depth + 1)),
  ];
}
