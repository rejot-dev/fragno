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
  defineExtension,
  Harness,
  MemoryStorage,
  ROOT_CONVERSATION_ID,
  UsageDoc,
  type UsageState,
} from "@earendil-works/pi-durable";

import { BACKOFFICE_SYSTEM_ACTORS } from "@/backoffice-runtime/context";
import type { BillingEventInput } from "@/fragno/billing/contracts";

import {
  createPiDurableBillingTask,
  flushPiDurableBilling,
  PiDurableBillingDoc,
} from "./pi-durable-billing";

const config: PiAgentConfig = {
  scopeRestriction: null,
  scope: { kind: "project", orgId: "org-1", projectId: "project-1" },
  sessionId: "session-1",
  name: "Billing test",
  model: { provider: "faux", modelId: "faux-1" },
  instructions: "",
  billingOrganizationId: "org-1",
  actors: BACKOFFICE_SYSTEM_ACTORS,
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
  const task = createPiDurableBillingTask({
    config,
    retryDelayMs: () => 0,
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
  registry.install(defineExtension({ name: "durable-billing-test", tasks: [task] }));
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

    await flushPiDurableBilling({
      harness,
      task,
      nowEpochMs: () => Date.parse("2026-10-03T12:00:00.000Z"),
      context: BACKGROUND_CONTEXT,
    });

    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(acceptedEvents).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      scope: config.scope,
      source: "pi-durable",
      eventType: "usage.committed",
      occurredAt: "2026-10-03T12:00:00.000Z",
      metadata: { sessionId: "session-1" },
    });
    expect(
      Object.fromEntries(attempts[0].measurements.map(({ meter, quantity }) => [meter, quantity])),
    ).toMatchObject({
      "ai.tokens.input": 100,
      "ai.tokens.total": 140,
      "ai.cost.total": 696_750,
    });

    const billing = await harness.snapshot(PiDurableBillingDoc, BACKGROUND_CONTEXT);
    expect(billing).toMatchObject({ activeTaskId: null });
    expect(billing?.delivered).toMatchObject({ totalTokens: 140, totalNanoUsd: 696_750 });

    await flushPiDurableBilling({
      harness,
      task,
      nowEpochMs: () => Date.parse("2026-10-03T12:01:00.000Z"),
      context: BACKGROUND_CONTEXT,
    });
    expect(attempts).toHaveLength(2);
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
});

test("durable Pi billing restores an event delivered before its SQLite acknowledgement", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-durable-billing-"));
  const snapshotPath = path.join(directory, "before-acknowledgement.sqlite");
  const acceptedEvents = new Map<string, BillingEventInput>();
  const attempts: BillingEventInput[] = [];
  const database = openNodeSqliteDatabase(":memory:");
  const createTask = () =>
    createPiDurableBillingTask({
      config,
      retryDelayMs: () => 0,
      recordEvent: async (event) => {
        attempts.push(structuredClone(event));
        const existing = acceptedEvents.get(event.id);
        if (existing) {
          expect(event).toEqual(existing);
        } else {
          acceptedEvents.set(event.id, structuredClone(event));
          await (await database).run("VACUUM INTO ?", snapshotPath);
        }
        return { accepted: existing === undefined, eventId: event.id };
      },
    });

  try {
    const sourceTask = createTask();
    const sourceRegistry = createRegistry();
    sourceRegistry.install(defineExtension({ name: "durable-billing-test", tasks: [sourceTask] }));
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
    await flushPiDurableBilling({
      harness: sourceHarness,
      task: sourceTask,
      nowEpochMs: () => Date.parse("2026-10-03T12:00:00.000Z"),
      context: BACKGROUND_CONTEXT,
    });
    await sourceHarness.close(BACKGROUND_CONTEXT);

    const restoredTask = createTask();
    const restoredRegistry = createRegistry();
    restoredRegistry.install(
      defineExtension({ name: "durable-billing-test", tasks: [restoredTask] }),
    );
    const restoredHarness = await Harness.open(
      await openNodeSqliteStorage(snapshotPath),
      { models: createModels(), registry: restoredRegistry },
      BACKGROUND_CONTEXT,
    );
    try {
      await flushPiDurableBilling({
        harness: restoredHarness,
        task: restoredTask,
        nowEpochMs: () => Date.parse("2026-10-03T12:01:00.000Z"),
        context: BACKGROUND_CONTEXT,
      });
      expect(attempts).toHaveLength(2);
      expect(attempts[1]).toEqual(attempts[0]);
      expect(acceptedEvents).toHaveLength(1);
      expect(await restoredHarness.snapshot(PiDurableBillingDoc, BACKGROUND_CONTEXT)).toMatchObject(
        {
          activeTaskId: null,
          delivered: { totalTokens: 140, totalNanoUsd: 696_750 },
        },
      );
    } finally {
      await restoredHarness.close(BACKGROUND_CONTEXT);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

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
  const task = createPiDurableBillingTask({
    config,
    retryDelayMs: () => 0,
    recordEvent: async (event) => {
      events.push(structuredClone(event));
      notifyRecordEventStarted();
      await recordEventMayFinish;
      return { accepted: true, eventId: event.id };
    },
  });
  const registry = createRegistry();
  registry.install(defineExtension({ name: "durable-billing-test", tasks: [task] }));
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

    const flushing = flushPiDurableBilling({
      harness,
      task,
      nowEpochMs: () => Date.parse("2026-10-03T12:00:00.000Z"),
      context: BACKGROUND_CONTEXT,
    });
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
