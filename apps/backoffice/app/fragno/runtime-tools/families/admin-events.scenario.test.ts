import { afterEach, assert, expect, test, vi } from "vitest";

import type { AutomationEvent } from "@fragno-dev/backoffice-api/v0/events";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import {
  createBackofficeRequestExecution,
  createBackofficeSystemExecution,
  type BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import { queryAutomationReplica } from "@/fragno/automation/lofi/testing";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";
import { createInteractiveBashHost } from "@/fragno/runtime-tools/automation-host";
import { createCodemodeRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";

import { AuthObject } from "../../../../workers/auth-object";
import { AutomationsObject } from "../../../../workers/automations-object";
import { FormsObject } from "../../../../workers/forms-object";
import { UploadObject } from "../../../../workers/upload-object";

const scenarioObjects = {
  API: null,
  AUTH: (input) => new AuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new AutomationsObject(input),
  FORMS: (input) => new FormsObject(input),
  UPLOAD: (input) => new UploadObject(input),
} satisfies LocalBackofficeObjects;

const orgScope = { kind: "org", orgId: "org-1" } as const;

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
    subject: { orgId: "org-1", installationId: "installation-1" },
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
    userId: "admin-1",
    verifiedRequestAuthority: {
      role: "admin",
      organizationId: null,
      administeredMemberId: null,
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

          const folded = await recentTerminal.exec(
            "admin.events.delete --org ada-labs --source pi --event-type turn.completed --before 2026-02-01 --danger",
          );
          assert.notEqual(folded.exitCode, 0);
          expect(folded.stderr).toContain("cannot be deleted");

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
