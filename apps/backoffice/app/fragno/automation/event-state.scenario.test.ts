import { assert, expect, test, vi } from "vitest";

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AutomationEvent } from "@fragno-dev/backoffice-api/v0/events";
import { SqlAdapter } from "@fragno-dev/db/adapters/sql";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

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

function stockChanged(
  id: string,
  second: number,
  payload: Record<string, unknown>,
  eventType = "stock.changed",
): AutomationEvent {
  return {
    id,
    scopeRestriction: null,
    scope,
    source: "warehouse",
    eventType,
    occurredAt: new Date(start + second * 1000).toISOString(),
    payload,
    actors: createBackofficeSystemExecution(scope).actors,
    subject: null,
    causation: { kind: "origin" },
  };
}

const bolts = (qty: number) => ({ sku: "BOLT", productId: "P-1", qty });
const nuts = (qty: number) => ({ sku: "NUT", productId: "P-2", qty });
const washers = (qty: number) => ({ sku: "WASHER", productId: "P-3", qty });

function ingest(ctx: BackofficeScenarioContext, event: AutomationEvent) {
  return ctx.runtime.objects.automations.for(scope).commands.ingestEvent(event);
}

/** Runs the scenarios on SQLite files, so they cover the state's migration and indexes. */
async function onSqlite(run: (sqliteDataDirectory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "backoffice-event-state-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Runs `meanwhile` once, as the next hook keeping an event's state has read and is about to write:
 * the moment a key path change can land between the two.
 */
function betweenStateReadAndWrite(meanwhile: () => Promise<void>) {
  const createBaseUnitOfWork = SqlAdapter.prototype.createBaseUnitOfWork;
  let pending = true;
  const spy = vi
    .spyOn(SqlAdapter.prototype, "createBaseUnitOfWork")
    .mockImplementation(function (this: SqlAdapter, name, config) {
      return createBaseUnitOfWork.call(this, name, {
        ...config,
        instrumentation: {
          ...config?.instrumentation,
          beforeMutate: (uow) => {
            if (pending && uow.uowName === "automations.keepEventState") {
              pending = false;
              spy.mockRestore();
              return meanwhile();
            }
            return config?.instrumentation?.beforeMutate?.(uow);
          },
        },
      });
    });
}

/** What an agent's codemode program returned. */
async function agent(ctx: BackofficeScenarioContext, code: string) {
  const run = await ctx.runCodemode({ scope, code });
  assert.equal(run.errorDetails, null, JSON.stringify(run.errorDetails));
  return run.result;
}

/** The stock a page reads from the state, once the browser's replica caught up. */
async function stock(ctx: BackofficeScenarioContext) {
  await ctx.drain();
  return await queryAutomationReplica(
    ctx.lofi.automations.forOrg(orgId),
    `SELECT key, keyPath, eventId, payload ->> '$.qty' AS qty FROM event_state
     WHERE source = 'warehouse' AND eventType = 'stock.changed' ORDER BY key`,
  );
}

test("a keyed type keeps each key's latest event as its state, which agents tidy after its key path changes", async () => {
  await onSqlite(async (sqliteDataDirectory) => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: allLocalObjects,
        options: { sqliteDataDirectory },
        name: "warehouse stock kept as event state",
        setup: ({ given }) => [given.organization.exists({ id: orgId, name: "Ada Labs" })],
        steps: ({ when, then }) => [
          // Stored before the type had a key path.
          when.automation.ingestEvent(stockChanged("bolts-120", 1, bolts(120))),
          then.assert("events stored before the type had a key path keep no state", async (ctx) => {
            await agent(
              ctx,
              `async () => await events.catalogCreate({
              source: "warehouse",
              eventType: "stock.changed",
              label: "Stock changed",
              keyPath: "$.sku",
            })`,
            );
            expect(await stock(ctx)).toEqual([]);
          }),
          then.assert("stored events keep their key's latest as its state", async (ctx) => {
            await ingest(ctx, stockChanged("bolts-80", 6, bolts(80)));
            await ingest(ctx, stockChanged("washers-300", 7, washers(300)));
            await expect(ingest(ctx, stockChanged("no-sku", 8, { qty: 3 }))).rejects.toThrow(
              "at its key path $.sku",
            );
            // Delivered late: it occurred before the state's event.
            await ingest(ctx, stockChanged("washers-250", 0, washers(250)));
            expect(await stock(ctx)).toEqual([
              { key: "BOLT", keyPath: "$.sku", eventId: "bolts-80", qty: 80 },
              { key: "WASHER", keyPath: "$.sku", eventId: "washers-300", qty: 300 },
            ]);
          }),
          then.assert("a changed key path leaves the state read with the old one", async (ctx) => {
            // Stored under the old key path; its state is kept only after the path changed.
            await ingest(
              ctx,
              stockChanged("gears-5", 8, { sku: "GEAR", productId: "P-4", qty: 5 }),
            );
            await agent(
              ctx,
              `async () => await events.catalogUpdate({
              source: "warehouse",
              eventType: "stock.changed",
              patch: { keyPath: "$.productId" },
            })`,
            );
            await ingest(ctx, stockChanged("nuts-10", 9, nuts(10)));
            expect(await stock(ctx)).toEqual([
              { key: "BOLT", keyPath: "$.sku", eventId: "bolts-80", qty: 80 },
              { key: "P-2", keyPath: "$.productId", eventId: "nuts-10", qty: 10 },
              { key: "WASHER", keyPath: "$.sku", eventId: "washers-300", qty: 300 },
            ]);
          }),
          then.assert("the agent deletes the states read with the old key path", async (ctx) => {
            expect(
              await agent(
                ctx,
                `async () => {
                const type = { source: "warehouse", eventType: "stock.changed" };
                const { keyPath } = await events.catalogGet(type);
                const { states } = await events.stateList({ ...type, limit: 2 });
                const { states: rest } = await events.stateList(type);
                const stale = rest.filter((state) => state.keyPath !== keyPath);
                return {
                  page: states.map((state) => state.key),
                  ...(await events.stateDelete({
                    ...type,
                    keys: [...stale.map((state) => state.key), "MISSING"],
                  })),
                };
              }`,
              ),
            ).toEqual({ page: ["BOLT", "P-2"], deleted: ["BOLT", "WASHER"] });
            await ingest(ctx, stockChanged("bolts-70", 10, bolts(70)));
            expect(await stock(ctx)).toEqual([
              { key: "P-1", keyPath: "$.productId", eventId: "bolts-70", qty: 70 },
              { key: "P-2", keyPath: "$.productId", eventId: "nuts-10", qty: 10 },
            ]);
          }),
          then.assert(
            "a key path changed while an event's state is being kept leaves it out",
            async (ctx) => {
              await ingest(ctx, stockChanged("springs-3", 11, { sku: "SPRING", productId: "P-5" }));
              betweenStateReadAndWrite(async () => {
                await ctx.runtime.objects.automations.for(scope).commands.updateEventDefinition({
                  source: "warehouse",
                  eventType: "stock.changed",
                  patch: { keyPath: "$.sku" },
                });
              });
              expect(await stock(ctx)).toEqual([
                { key: "P-1", keyPath: "$.productId", eventId: "bolts-70", qty: 70 },
                { key: "P-2", keyPath: "$.productId", eventId: "nuts-10", qty: 10 },
              ]);
            },
          ),
          then.hooks.noFailed({ orgId, fragments: ["automations"] }),
        ],
      }),
    );
  });
});

test("a package's keyed type keeps its state after the package is uninstalled, until an agent deletes it", async () => {
  const listingId = "system#warehouse";
  await onSqlite(async (sqliteDataDirectory) => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: allLocalObjects,
        options: { sqliteDataDirectory },
        name: "a package's keyed type uninstalled",
        setup: ({ given }) => [given.organization.exists({ id: orgId, name: "Ada Labs" })],
        steps: ({ then }) => [
          then.assert("the package's type keeps state while it is installed", async (ctx) => {
            const automations = ctx.runtime.objects.automations.for(scope);
            expect(
              await automations.commands.applyPackageInstallation({
                installation: {
                  marketplace: { kind: "system" },
                  listingId,
                  version: "1.0.0",
                  installationRoot: "/workspace/warehouse",
                  permissions: [],
                  settings: {},
                },
                operation: "install-1",
                expectedOperation: null,
                routes: [],
                eventDefinitions: [
                  {
                    source: "warehouse",
                    eventType: "stock.changed",
                    label: "Stock changed",
                    keyPath: "$.sku",
                    enabled: true,
                  },
                ],
                actors: createBackofficeSystemExecution(scope).actors,
              }),
            ).toEqual({ ok: true });
            await ingest(ctx, stockChanged("bolts-80", 1, bolts(80)));
            expect(await stock(ctx)).toEqual([
              { key: "BOLT", keyPath: "$.sku", eventId: "bolts-80", qty: 80 },
            ]);
          }),
          then.assert("its state stays until the agent deletes it", async (ctx) => {
            await ctx.runtime.objects.automations
              .for(scope)
              .commands.uninstallPackage({ listingId });
            expect(await stock(ctx)).toEqual([
              { key: "BOLT", keyPath: "$.sku", eventId: "bolts-80", qty: 80 },
            ]);
            await agent(
              ctx,
              `async () => await events.stateDelete({
              source: "warehouse",
              eventType: "stock.changed",
              keys: ["BOLT"],
            })`,
            );
            expect(await stock(ctx)).toEqual([]);
          }),
          then.hooks.noFailed({ orgId, fragments: ["automations"] }),
        ],
      }),
    );
  });
});
