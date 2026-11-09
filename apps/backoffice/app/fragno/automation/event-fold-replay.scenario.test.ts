import { expect, test, vi, assert } from "vitest";

import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AutomationEvent } from "@fragno-dev/backoffice-api/v0/events";
import Database from "better-sqlite3";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import { allLocalObjects } from "@/backoffice-runtime/all-local-objects";
import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";

import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "./scenario";

const orgId = "org-1";
const scope = { kind: "org", orgId, jurisdiction: null } as const;
const start = Date.parse("2026-01-01T00:00:00.000Z");
const at = (second: number) => start + second * 1000;

const FOLDED_TABLES = [
  "pi_agent",
  "pi_agent_request",
  "pi_agent_turn",
  "integration_connection",
  "integration_connection_change",
];

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
  };
  return event(id, "pi", eventType, second, {
    payload: eventType === "agent.stopped" ? {} : { definition },
    subject: { scope, agentName },
  });
}

function requestEvent(
  id: string,
  eventType: "queue.added" | "queue.dispatched" | "turn.started" | "turn.completed",
  agentName: string,
  requestId: string,
  second: number,
  payload: Record<string, unknown>,
) {
  return event(id, "pi", eventType, second, {
    payload,
    subject: { scope, agentName, requestId },
  });
}

function connectionEvent(
  id: string,
  state: "ready" | "unavailable" | "disconnected",
  connectionId: string,
  second: number,
) {
  return event(id, "integrations", `connection.${state}`, second, {
    payload: state === "disconnected" ? {} : { name: connectionId, authMethod: null },
    subject: { scope, service: connectionId.split("#", 1)[0], connectionId },
  });
}

/** Counts the `pi` events a deletion would take, which it refuses until the replay folded them. */
async function countDeletablePiEvents(ctx: BackofficeScenarioContext) {
  const { scanned } = await ctx.runtime.objects.automations.for(scope).commands.deleteEventsOfType({
    source: "pi",
    eventType: "turn.completed",
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
 * Runs `use` on each Automations object's database. Only the database shows the folded rows, and
 * only it can lose them, as databases did before ingestion folded events.
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

/** The folded tables' rows by ID, without the bookkeeping columns each write changes. */
function foldedRows(directory: string) {
  return eachAutomationsDatabase(directory, (database) =>
    Object.fromEntries(
      FOLDED_TABLES.map((name) => [
        name,
        (
          database.prepare(`SELECT * FROM ${automationsTable(name)} ORDER BY id`).all() as object[]
        ).map((row) =>
          Object.fromEntries(Object.entries(row).filter(([column]) => !column.startsWith("_"))),
        ),
      ]),
    ),
  );
}

function deleteRows(directory: string, tables: readonly string[]) {
  return eachAutomationsDatabase(directory, (database) => {
    for (const name of tables) {
      database.prepare(`DELETE FROM ${automationsTable(name)}`).run();
    }
  });
}

test("the replay folds stored events as ingestion did, and folding them again changes nothing", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "backoffice-event-fold-replay-"));
  let folded: Awaited<ReturnType<typeof foldedRows>> = {};
  try {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: allLocalObjects,
        name: "events stored before ingestion folded them",
        options: { sqliteDataDirectory: directory },
        setup: ({ given }) => [given.organization.exists({ id: orgId, name: "Ada Labs" })],
        steps: ({ when, then, runner }) => [
          ...[
            agentEvent("reviewer-created", "agent.created", "reviewer", 1),
            agentEvent("reviewer-updated", "agent.updated", "reviewer", 2),
            requestEvent("r1-added", "queue.added", "reviewer", "r1", 3, { type: "prompt" }),
            // Taken from the queue as the turn starts, in the same instant.
            requestEvent("r1-dispatched", "queue.dispatched", "reviewer", "r1", 4, {
              turnRequestId: "r1",
            }),
            requestEvent("r1-started", "turn.started", "reviewer", "r1", 4, {}),
            requestEvent("r1-completed", "turn.completed", "reviewer", "r1", 5, {
              answerEntryId: 1,
            }),
            requestEvent("r2-added", "queue.added", "reviewer", "r2", 6, { type: "steer" }),
            agentEvent("reviewer-stopped", "agent.stopped", "reviewer", 7),
            agentEvent("drafter-created", "agent.created", "drafter", 1),
            // Stored after the deletion that happened later.
            agentEvent("drafter-deleted", "agent.deleted", "drafter", 3),
            requestEvent("r3-started", "turn.started", "drafter", "r3", 2, {}),
            connectionEvent("billing-ready", "ready", "api#billing", 1),
            connectionEvent("billing-down", "unavailable", "api#billing", 2),
            connectionEvent("billing-back", "ready", "api#billing", 3),
            connectionEvent("agensi-ready", "ready", "mcp#agensi", 1),
            connectionEvent("agensi-gone", "disconnected", "mcp#agensi", 2),
          ].map((stored) => when.automation.ingestEvent(stored)),
          runner.drain(),
          then.assert("ingestion folded each event as it stored it", async () => {
            folded = await foldedRows(directory);
            const [org] = Object.values(folded).filter((tables) => tables.pi_agent.length > 0);
            expect(org).toMatchObject({
              pi_agent: [
                { id: "drafter", definition: null, running: 1 },
                { id: "reviewer", latestKind: "stopped", paused: 1, running: 0, steering: 1 },
              ],
              pi_agent_turn: [{ id: "r1-completed", agentName: "reviewer", outcome: "answered" }],
              integration_connection: [
                { id: "api#billing", state: "ready", eventId: "billing-back" },
                { id: "mcp#agensi", state: "disconnected", name: "mcp#agensi" },
              ],
            });
            expect(org?.integration_connection_change).toHaveLength(5);
          }),
          then.assert("the replay starts again on the folded rows", async () => {
            await deleteRows(directory, ["event_fold_replay"]);
          }),
          runner.restartObject({ binding: "AUTOMATIONS", scope }),
          runner.drain(),
          then.assert("folding every event again leaves each row as it was", async () => {
            expect(await foldedRows(directory)).toEqual(folded);
          }),
          then.assert(
            "the folded rows are gone, as before ingestion folded events, and no event they hold is deleted",
            async (ctx) => {
              await deleteRows(directory, [...FOLDED_TABLES, "event_fold_replay"]);
              await expect(countDeletablePiEvents(ctx)).rejects.toThrow("not yet folded");
            },
          ),
          runner.restartObject({ binding: "AUTOMATIONS", scope }),
          runner.drain(),
          then.assert("the replay folds every stored event into the same rows", async (ctx) => {
            expect(await foldedRows(directory)).toEqual(folded);
            assert((await countDeletablePiEvents(ctx)) === 1);
          }),
          then.hooks.noFailed({ orgId, fragments: ["automations"] }),
        ],
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
