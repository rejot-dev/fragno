import { expect, test } from "vitest";

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import {
  openNodeSqliteDatabase,
  openNodeSqliteStorage,
} from "@earendil-works/pi-durable/storage/sqlite/node";
import type { PiAgentConfig } from "@fragno-dev/backoffice-api/v0/pi";

import {
  createRegistry,
  Harness,
  MemoryStorage,
  ROOT_CONVERSATION_ID,
  UsageDoc,
  type UsageState,
} from "@earendil-works/pi-durable";

import type { BillingEventInput } from "@/fragno/billing/contracts";

import { createPiBilling, PiDurableBillingDoc, type PiBilling } from "./billing-extension";

/** Delivers usage through the committed watermark, as an agent's wakeups do. */
async function deliverUsage(billing: PiBilling, harness: Harness, nowEpochMs: number) {
  for (;;) {
    const taskId = await billing.ensure(harness, nowEpochMs, BACKGROUND_CONTEXT);
    if (taskId === null) {
      return;
    }
    harness.resume();
    await harness.waitForTask(taskId, BACKGROUND_CONTEXT);
    await billing.assertNotFailed(harness, taskId, BACKGROUND_CONTEXT);
  }
}

const config: PiAgentConfig = {
  scope: { kind: "project", owner: { kind: "org", orgId: "org-1" }, projectId: "project-1" },
  agentName: "assistant",
};

const committedUsage: UsageState = {
  models: {
    "faux/faux-1": {
      input: 100,
      output: 25,
      cacheRead: 10,
      cacheWrite: 5,
      totalTokens: 140,
      cost: {
        input: 0.0003,
        output: 0.000375,
        cacheRead: 0.000003,
        cacheWrite: 0.00001875,
        total: 0.00069675,
      },
    },
  },
  tools: {},
};

test("durable Pi billing retries the exact event after delivery succeeds before local acknowledgement", async () => {
  const acceptedEvents = new Map<string, BillingEventInput>();
  const attempts: BillingEventInput[] = [];
  let failAfterFirstDelivery = true;
  const billing = createPiBilling({
    config,
    retryDelayMs: () => 0,
    recordLegacyEvent: async () => {
      throw new Error("Unexpected legacy delivery");
    },
    recordEvent: async (event) => {
      attempts.push(structuredClone(event));
      const existing = acceptedEvents.get(event.id);
      if (existing) {
        expect(event).toEqual(existing);
      } else {
        acceptedEvents.set(event.id, structuredClone(event));
      }
      if (failAfterFirstDelivery) {
        failAfterFirstDelivery = false;
        throw new Error("Simulated crash after Billing accepted the event.");
      }
      return { accepted: existing === undefined, eventId: event.id };
    },
  });
  const registry = createRegistry();
  registry.install(billing.extension);
  const harness = await Harness.open(
    new MemoryStorage(),
    { models: createModels(), registry, onReport: () => {} },
    BACKGROUND_CONTEXT,
  );

  try {
    await harness.root(BACKGROUND_CONTEXT);
    await harness.commit(async (tx) => {
      const usage = await tx.doc(UsageDoc, ROOT_CONVERSATION_ID);
      usage.models = committedUsage.models;
    }, BACKGROUND_CONTEXT);

    await deliverUsage(billing, harness, Date.parse("2026-10-03T12:00:00.000Z"));

    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(acceptedEvents).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      scope: config.scope,
      source: "pi-durable",
      eventType: "usage.committed",
      occurredAt: "2026-10-03T12:00:00.000Z",
      metadata: { agentName: "assistant" },
    });
    expect(
      Object.fromEntries(attempts[0].measurements.map(({ meter, quantity }) => [meter, quantity])),
    ).toMatchObject({
      "ai.tokens.input": 100,
      "ai.tokens.total": 140,
      "ai.cost.total": 696_750,
    });

    const billingState = await harness.snapshot(PiDurableBillingDoc, BACKGROUND_CONTEXT);
    expect(billingState).toMatchObject({ activeTaskId: null });
    expect(billingState?.delivered).toMatchObject({ totalTokens: 140, totalNanoUsd: 696_750 });

    await deliverUsage(billing, harness, Date.parse("2026-10-03T12:01:00.000Z"));
    expect(attempts).toHaveLength(2);
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
});

test.each(["owner", "legacy"] as const)(
  "durable Pi billing restores a %s event delivered before its SQLite acknowledgement",
  async (attribution) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pi-durable-billing-"));
    const snapshotPath = path.join(directory, "before-acknowledgement.sqlite");
    const acceptedEvents = new Map<string, BillingEventInput>();
    const attempts: BillingEventInput[] = [];
    const database = openNodeSqliteDatabase(":memory:");
    const destinations: string[] = [];
    async function accept(event: BillingEventInput, destination: string) {
      destinations.push(destination);
      attempts.push(structuredClone(event));
      const existing = acceptedEvents.get(event.id);
      if (existing) {
        expect(event).toEqual(existing);
      } else {
        acceptedEvents.set(event.id, structuredClone(event));
        if (attempts.length === 1) {
          await (await database).run("VACUUM INTO ?", snapshotPath);
        }
      }
      return { accepted: existing === undefined, eventId: event.id };
    }
    const createTask = (destination: string) =>
      createPiBilling({
        config,
        retryDelayMs: () => 0,
        recordEvent: (event) => accept(event, destination),
        recordLegacyEvent: (event) => accept(event, "legacy"),
      });

    try {
      const sourceBilling = createTask("original");
      const sourceRegistry = createRegistry();
      sourceRegistry.install(sourceBilling.extension);
      const sourceHarness = await Harness.open(
        await SqliteStorage.open(await database),
        { models: createModels(), registry: sourceRegistry },
        BACKGROUND_CONTEXT,
      );
      await sourceHarness.root(BACKGROUND_CONTEXT);
      await sourceHarness.commit(async (tx) => {
        const usage = await tx.doc(UsageDoc, ROOT_CONVERSATION_ID);
        usage.models = committedUsage.models;
      }, BACKGROUND_CONTEXT);
      await deliverUsage(sourceBilling, sourceHarness, Date.parse("2026-10-03T12:00:00.000Z"));
      await sourceHarness.close(BACKGROUND_CONTEXT);

      if (attribution === "legacy") {
        // Reproduce the persisted checkpoint written before attribution became required.
        const snapshot = await openNodeSqliteDatabase(snapshotPath);
        await snapshot.run(
          "UPDATE tasks SET record = json_remove(record, '$.state.checkpoint.attribution') WHERE kind = ?",
          JSON.stringify("backoffice.pi.billing-delivery"),
        );
        await snapshot.close();
      }
      const restoredBilling = createTask("owner");
      const restoredRegistry = createRegistry();
      restoredRegistry.install(restoredBilling.extension);
      const restoredHarness = await Harness.open(
        await openNodeSqliteStorage(snapshotPath),
        { models: createModels(), registry: restoredRegistry },
        BACKGROUND_CONTEXT,
      );
      try {
        await deliverUsage(
          restoredBilling,
          restoredHarness,
          Date.parse("2026-10-03T12:01:00.000Z"),
        );
        expect(attempts).toHaveLength(2);
        expect(attempts[1]).toEqual(attempts[0]);
        expect(acceptedEvents).toHaveLength(1);
        expect(destinations).toEqual(["original", attribution]);
        expect(
          await restoredHarness.snapshot(PiDurableBillingDoc, BACKGROUND_CONTEXT),
        ).toMatchObject({
          activeTaskId: null,
          delivered: { totalTokens: 140, totalNanoUsd: 696_750 },
        });
        await restoredHarness.commit(async (tx) => {
          const usage = await tx.doc(UsageDoc, ROOT_CONVERSATION_ID);
          usage.models["faux/faux-1"].input += 10;
          usage.models["faux/faux-1"].totalTokens += 10;
        }, BACKGROUND_CONTEXT);
        await deliverUsage(
          restoredBilling,
          restoredHarness,
          Date.parse("2026-10-03T12:02:00.000Z"),
        );
        expect(destinations).toEqual(["original", attribution, "owner"]);
        expect(acceptedEvents).toHaveLength(2);
        expect(attempts[2].measurements).toContainEqual({
          meter: "ai.tokens.total",
          unit: "token",
          quantity: 10,
        });
      } finally {
        await restoredHarness.close(BACKGROUND_CONTEXT);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("root conversation cancellation does not abort ownerless billing delivery", async () => {
  let releaseRecordEvent = () => {};
  const recordEventMayFinish = new Promise<void>((resolve) => {
    releaseRecordEvent = resolve;
  });
  let notifyRecordEventStarted = () => {};
  const recordEventStarted = new Promise<void>((resolve) => {
    notifyRecordEventStarted = resolve;
  });
  const events: BillingEventInput[] = [];
  const billing = createPiBilling({
    config,
    retryDelayMs: () => 0,
    recordLegacyEvent: async () => {
      throw new Error("Unexpected legacy delivery");
    },
    recordEvent: async (event) => {
      events.push(structuredClone(event));
      notifyRecordEventStarted();
      await recordEventMayFinish;
      return { accepted: true, eventId: event.id };
    },
  });
  const registry = createRegistry();
  registry.install(billing.extension);
  const harness = await Harness.open(
    new MemoryStorage(),
    { models: createModels(), registry },
    BACKGROUND_CONTEXT,
  );

  try {
    const root = await harness.root(BACKGROUND_CONTEXT);
    await harness.commit(async (tx) => {
      const usage = await tx.doc(UsageDoc, ROOT_CONVERSATION_ID);
      usage.models = committedUsage.models;
    }, BACKGROUND_CONTEXT);

    const flushing = deliverUsage(billing, harness, Date.parse("2026-10-03T12:00:00.000Z"));
    await recordEventStarted;
    await root.abort(BACKGROUND_CONTEXT, { background: true });
    releaseRecordEvent();
    await flushing;

    expect(events).toHaveLength(1);
    expect(await harness.snapshot(PiDurableBillingDoc, BACKGROUND_CONTEXT)).toMatchObject({
      activeTaskId: null,
      delivered: { totalTokens: 140 },
    });
  } finally {
    releaseRecordEvent();
    await harness.close(BACKGROUND_CONTEXT);
  }
});
