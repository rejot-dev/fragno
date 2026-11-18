import { expect, test, assert } from "vitest";

import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AutomationEvent } from "@fragno-dev/backoffice-api/v0/events";
import Database from "better-sqlite3";

import { allLocalObjects } from "@/backoffice-runtime/all-local-objects";
import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";

import { queryAutomationReplica } from "./lofi/testing";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "./scenario";

const orgId = "org-1";
const scope = { kind: "org", orgId, jurisdiction: null } as const;
const start = Date.parse("2026-01-01T00:00:00.000Z");
const at = (second: number) => start + second * 1000;

function event(
  id: string,
  source: string,
  eventType: string,
  second: number,
  { payload, subject }: Pick<AutomationEvent, "payload" | "subject">,
): AutomationEvent {
  return {
    id,
    scopeRestriction: null,
    scope,
    source,
    eventType,
    occurredAt: new Date(at(second)).toISOString(),
    sequence: null,
    payload,
    actors: createBackofficeSystemExecution(scope).actors,
    subject,
    causation: { kind: "origin" },
  };
}

function agentEvent(
  id: string,
  eventType: "agent.created" | "agent.updated" | "agent.deleted" | "agent.stopped",
  agentName: string,
  second: number,
) {
  const definition = {
    agentName,
    description: `${id}.`,
    model: null,
    thinkingLevel: "low",
    permissions: [],
    instructions: "Review carefully.",
    skills: [],
    disabledSkills: [],
    category: null,
    steward: { kind: "members" },
  };
  return event(id, "pi", eventType, second, {
    payload: eventType === "agent.stopped" ? { agentName } : { agentName, definition },
    subject: { scope, agentName },
  });
}

function requestEvent(
  id: string,
  eventType: "queue.added" | "queue.dispatched" | "turn.started" | "turn.aborted",
  agentName: string,
  requestId: string,
  second: number,
  payload: Record<string, unknown>,
) {
  return event(id, "pi", eventType, second, {
    payload: { agentName, ...payload },
    subject: { scope, agentName, requestId },
  });
}

function connectionEvent(
  id: string,
  state: "ready" | "unavailable" | "disconnected",
  connectionId: string,
  second: number,
) {
  const service = connectionId.split("#", 1)[0];
  return event(id, "integrations", `connection.${state}`, second, {
    payload: {
      connectionId,
      service,
      ...(state === "disconnected" ? {} : { name: connectionId, authMethod: null }),
    },
    subject: { scope, service, connectionId },
  });
}

function sandboxEvent(id: string, state: "ready" | "stopped", sandboxId: string, second: number) {
  return event(id, "sandbox", `instance.${state}`, second, {
    payload: {
      sandboxId,
      provider: "cloudflare",
      status: state === "ready" ? "running" : "stopped",
    },
    subject: { scope, sandboxId },
  });
}

/** Counts the `pi` events a deletion would take, which it refuses until the replay kept them. */
async function countDeletablePiEvents(ctx: BackofficeScenarioContext) {
  const { scanned } = await ctx.runtime.objects.automations.for(scope).commands.deleteEventsOfType({
    source: "pi",
    eventType: "turn.aborted",
    occurredBefore: new Date(at(60)),
    storedBefore: new Date(at(60)),
    payloadFilter: null,
    cursor: null,
    dryRun: true,
  });
  return scanned;
}

/** Each Automations object's tables carry the fragment's namespace. */
const automationsTable = (name: string) => `"${name}_automations"`;

/**
 * Runs `use` on each Automations object's database. Only the database shows the kept states, and
 * only it can lose them, as databases did before ingestion kept events in them.
 */
async function eachAutomationsDatabase<T>(
  directory: string,
  use: (database: Database.Database) => T,
) {
  const results: Record<string, T> = {};
  for (const file of (await readdir(directory)).sort()) {
    if (!file.startsWith("automations-") || !file.endsWith(".sqlite")) {
      continue;
    }
    const database = new Database(path.join(directory, file));
    try {
      results[file] = use(database);
    } finally {
      database.close();
    }
  }
  return results;
}

/** The kept states, without the row IDs each write picks. */
function stateRows(directory: string) {
  return eachAutomationsDatabase(directory, (database) =>
    (
      database
        .prepare(
          `SELECT "eventType", "key", "keyPath", "eventId", "payload", "occurredAt", "storedAt"
           FROM ${automationsTable("automation_event_state")} ORDER BY "eventType", "key"`,
        )
        .all() as { payload: string }[]
    ).map((row) => ({ ...row, payload: JSON.parse(row.payload) as unknown })),
  );
}

/**
 * Events stored before their payloads named what they are about: connection events held only its
 * label, and agent events neither the agent nor its queue.
 */
function storeEventsAsBefore(directory: string) {
  return eachAutomationsDatabase(directory, (database) => ({
    integrations: database
      .prepare(
        `UPDATE ${automationsTable("automation_event")}
         SET "payload" = json_remove("payload", '$.connectionId', '$.service')
         WHERE "source" = 'integrations' AND "payload" ->> '$.connectionId' IS NOT NULL`,
      )
      .run().changes,
    pi: database
      .prepare(
        `UPDATE ${automationsTable("automation_event")}
         SET "payload" = json_remove("payload", '$.agentName', '$.queue')
         WHERE "source" = 'pi' AND "payload" ->> '$.agentName' IS NOT NULL`,
      )
      .run().changes,
  }));
}

function deleteRows(directory: string, tables: readonly string[]) {
  return eachAutomationsDatabase(directory, (database) => {
    for (const name of tables) {
      database.prepare(`DELETE FROM ${automationsTable(name)}`).run();
    }
  });
}

test("the replay keeps stored events in their states as ingestion did, and keeping them again changes nothing", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "backoffice-event-fold-replay-"));
  let kept: Awaited<ReturnType<typeof stateRows>> = {};
  try {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: allLocalObjects,
        name: "events stored before ingestion kept their states",
        options: { sqliteDataDirectory: directory },
        setup: ({ given }) => [given.organization.exists({ id: orgId, name: "Ada Labs" })],
        steps: ({ when, then, runner }) => [
          ...[
            agentEvent("reviewer-created", "agent.created", "reviewer", 1),
            agentEvent("reviewer-updated", "agent.updated", "reviewer", 2),
            // Started at once, and stopped while it ran, so the next prompt waits.
            requestEvent("r1-dispatched", "queue.dispatched", "reviewer", "r1", 3, {
              queue: { revision: 1, running: 1, queued: 0, steering: 0 },
              turnRequestId: "r1",
            }),
            requestEvent("r1-started", "turn.started", "reviewer", "r1", 3, {}),
            agentEvent("reviewer-stopped", "agent.stopped", "reviewer", 4),
            requestEvent("r2-added", "queue.added", "reviewer", "r2", 5, {
              queue: { revision: 3, running: 1, queued: 1, steering: 0 },
              type: "prompt",
            }),
            requestEvent("r1-aborted", "turn.aborted", "reviewer", "r1", 6, {
              queue: { revision: 4, running: 0, queued: 1, steering: 0 },
            }),
            agentEvent("drafter-created", "agent.created", "drafter", 1),
            // Stored after the deletion that happened later.
            agentEvent("drafter-deleted", "agent.deleted", "drafter", 3),
            requestEvent("r3-started", "turn.started", "drafter", "r3", 2, {}),
            connectionEvent("billing-ready", "ready", "api#billing", 1),
            connectionEvent("billing-down", "unavailable", "api#billing", 2),
            connectionEvent("billing-back", "ready", "api#billing", 3),
            connectionEvent("agensi-ready", "ready", "mcp#agensi", 1),
            connectionEvent("agensi-gone", "disconnected", "mcp#agensi", 2),
            sandboxEvent("dev-ready", "ready", "dev", 1),
            sandboxEvent("dev-stopped", "stopped", "dev", 2),
          ].map((stored) => when.automation.ingestEvent(stored)),
          runner.drain(),
          then.assert(
            "ingestion kept each agent, connection, and sandbox event's state",
            async (ctx) => {
              kept = await stateRows(directory);
              const [states] = Object.values(kept).filter((rows) => rows.length > 0);
              expect(states).toMatchObject([
                { eventType: "agent.created", key: "drafter", eventId: "drafter-created" },
                { eventType: "agent.created", key: "reviewer", eventId: "reviewer-created" },
                { eventType: "agent.deleted", key: "drafter", eventId: "drafter-deleted" },
                { eventType: "agent.stopped", key: "reviewer", eventId: "reviewer-stopped" },
                { eventType: "agent.updated", key: "reviewer", eventId: "reviewer-updated" },
                { eventType: "connection.disconnected", key: "mcp#agensi", eventId: "agensi-gone" },
                { eventType: "connection.ready", key: "api#billing", eventId: "billing-back" },
                { eventType: "connection.ready", key: "mcp#agensi", eventId: "agensi-ready" },
                {
                  eventType: "connection.unavailable",
                  key: "api#billing",
                  eventId: "billing-down",
                  payload: {
                    connectionId: "api#billing",
                    service: "api",
                    name: "api#billing",
                    authMethod: null,
                  },
                },
                {
                  eventType: "instance.ready",
                  key: "dev",
                  keyPath: "$.sandboxId",
                  eventId: "dev-ready",
                },
                { eventType: "instance.stopped", key: "dev", eventId: "dev-stopped" },
                { eventType: "queue.added", key: "reviewer", eventId: "r2-added" },
                { eventType: "queue.dispatched", key: "reviewer", eventId: "r1-dispatched" },
                { eventType: "turn.aborted", key: "reviewer", eventId: "r1-aborted" },
                { eventType: "turn.started", key: "drafter", eventId: "r3-started" },
                { eventType: "turn.started", key: "reviewer", eventId: "r1-started" },
              ]);
              // The drafter is deleted; the reviewer is stopped with the prompt it held back waiting,
              // as the highest revision says.
              expect(
                await queryAutomationReplica(
                  ctx.lofi.automations.forOrg(orgId),
                  `SELECT agentName, latestKind, answering, paused, queued, steering, activity
                 FROM agents WHERE agentName IN ('drafter', 'reviewer')`,
                ),
              ).toEqual([
                {
                  agentName: "reviewer",
                  latestKind: "cut-off",
                  answering: 0,
                  paused: 1,
                  queued: 1,
                  steering: 0,
                  activity: "Stopped",
                },
              ]);
            },
          ),
          then.assert("the replay starts again on the kept states", async () => {
            await deleteRows(directory, ["event_fold_replay"]);
          }),
          runner.restartObject({ binding: "AUTOMATIONS", scope }),
          runner.drain(),
          then.assert("reading every event again leaves each state as it was", async () => {
            expect(await stateRows(directory)).toEqual(kept);
          }),
          then.assert(
            "the states are gone, as before ingestion kept events in them, and no event they hold is deleted",
            async (ctx) => {
              expect(Object.values(await storeEventsAsBefore(directory))).toContainEqual({
                integrations: 5,
                pi: 10,
              });
              await deleteRows(directory, ["automation_event_state", "event_fold_replay"]);
              await expect(countDeletablePiEvents(ctx)).rejects.toThrow(
                "not yet kept in their states",
              );
            },
          ),
          runner.restartObject({ binding: "AUTOMATIONS", scope }),
          runner.drain(),
          then.assert(
            "the replay keeps every stored event in the same states, reading agents and connections off their subjects",
            async (ctx) => {
              // Events stored before they carried the queue leave it out; their agents read as
              // holding nothing until the queue next changes.
              expect(await stateRows(directory)).toEqual(
                Object.fromEntries(
                  Object.entries(kept).map(([file, rows]) => [
                    file,
                    rows.map((row) => {
                      const { queue: _queue, ...payload } = row.payload as Record<string, unknown>;
                      return { ...row, payload };
                    }),
                  ]),
                ),
              );
              assert((await countDeletablePiEvents(ctx)) === 1);
            },
          ),
          then.hooks.noFailed({ orgId, fragments: ["automations"] }),
        ],
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a project's replay tells its organization the connections it keeps again", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "backoffice-event-fold-replay-"));
  const books = (projectId: unknown) =>
    ({ kind: "project", owner: scope, projectId: String(projectId) }) as const;
  /** The name the organization last heard Books' ledger by, or null for no ledger. */
  const ledgerName = async (ctx: BackofficeScenarioContext) => {
    const [wiring] = await queryAutomationReplica(
      ctx.lofi.automations.forOrg(orgId),
      `SELECT payload ->> '$.connections[0].displayName' AS name FROM event_state
       WHERE source = 'automations' AND eventType = 'project.wiring'`,
    );
    return wiring?.name ?? null;
  };
  const route = (name: string) =>
    `async () => router.create({
      id: "book-receipts",
      name: "${name}",
      trigger: { kind: "event", source: "shop", eventType: "received" },
      action: {
        kind: "start_workflow",
        workflowScriptPath: "/workspace/automations/book-receipt.workflow.js",
        instanceIdTemplate: "book-\${event.id}",
        authority: { kind: "organization-automation", grants: [] },
      },
    })`;
  try {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: allLocalObjects,
        name: "Books' ledger connected before ingestion kept connection states",
        options: { sqliteDataDirectory: directory },
        setup: ({ given }) => [given.organization.exists({ id: orgId, name: "Ada Labs" })],
        steps: ({ when, then, runner }) => [
          when.project.create({
            owner: scope,
            name: "Books",
            slug: "books",
            createdByUserId: "owner-1",
            captureIdAs: "books",
          }),
          then.assert("Books connects its ledger", async (ctx) => {
            const booksScope = books(ctx.vars.books);
            await ctx.runtime.objects.automations.for(booksScope).commands.ingestEvent({
              ...connectionEvent("ledger-ready", "ready", "api#ledger", 1),
              scope: booksScope,
              payload: {
                connectionId: "api#ledger",
                service: "api",
                name: "Ledger",
                authMethod: null,
              },
              subject: { scope: booksScope, service: "api", connectionId: "api#ledger" },
            });
          }),
          runner.drain(),
          then.assert("its state is gone, and Books routes without its ledger", async (ctx) => {
            assert.equal(await ledgerName(ctx), "Ledger");
            await eachAutomationsDatabase(directory, (database) => {
              database
                .prepare(
                  `DELETE FROM ${automationsTable("automation_event_state")} WHERE "source" = 'integrations'`,
                )
                .run();
              database.prepare(`DELETE FROM ${automationsTable("event_fold_replay")}`).run();
            });
            await ctx.runCodemode({ scope: books(ctx.vars.books), code: route("Book receipts") });
            await ctx.drain();
            assert.equal(await ledgerName(ctx), null);
          }),
          then.assert("the replay keeps the ledger again, which Books tells", async (ctx) => {
            await ctx.runtime.restartObject({
              binding: "AUTOMATIONS",
              scope: books(ctx.vars.books),
            });
            await ctx.drain();
            assert.equal(await ledgerName(ctx), "Ledger");
          }),
          then.hooks.noFailed({ orgId, fragments: ["automations"] }),
        ],
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
