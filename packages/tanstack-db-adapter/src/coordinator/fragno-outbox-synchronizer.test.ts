import { assert, describe, expect, it } from "vitest";

import {
  encodeVersionstamp,
  outboxPageAfterVersionstamp,
  versionstampToHex,
} from "@fragno-dev/db/outbox";
import { idColumn, schema } from "@fragno-dev/db/schema";
import superjson from "superjson";

import { shouldApplyOutboxCheckpoint, type FragnoOutboxCheckpoint } from "../checkpoint";
import { createOutboxTestStream } from "../outbox-stream-test-fixture";
import type { FragnoOutboxEntry } from "../protocol";
import {
  FragnoOutboxSynchronizer,
  type FragnoOutboxSubscriber,
} from "./fragno-outbox-synchronizer";

const blogSchema = schema("blog", (builder) =>
  builder
    .addTable("users", (table) => table.addColumn("id", idColumn()))
    .addTable("posts", (table) => table.addColumn("id", idColumn())),
);
const usersTarget = {
  key: "4:blog5:users",
  namespace: "blog",
  schema: blogSchema,
  tableName: "users",
};
const postsTarget = {
  key: "4:blog5:posts",
  namespace: "blog",
  schema: blogSchema,
  tableName: "posts",
};

function outboxEntry(version: number, tables = ["users"]): FragnoOutboxEntry {
  const versionstamp = versionstampToHex(encodeVersionstamp(BigInt(version), 0));
  return {
    versionstamp,
    uowId: `uow-${version}`,
    payload: superjson.serialize({
      version: 2,
      operations: tables.map((table) => ({
        op: "create",
        schema: "blog",
        table,
        externalId: `${table}-${version}`,
        versionstamp,
        values: {},
      })),
    }),
  };
}

function createScenario(
  entries: FragnoOutboxEntry[] = [],
  initialCheckpoint?: FragnoOutboxCheckpoint,
  liveEntries: FragnoOutboxEntry[] = [],
) {
  let checkpoint = initialCheckpoint;
  const requests: Array<string | undefined> = [];
  let body = createOutboxTestStream(entries, liveEntries);
  const batches: string[][] = [];
  const applied: string[] = [];
  let readyCalls = 0;
  const synchronizer = new FragnoOutboxSynchronizer({
    adapterIdentity: "test-adapter",
    fetcher: {
      async openOutboxStream(options) {
        requests.push(options.afterVersionstamp);
        return body;
      },
    },
    checkpointStore: {
      getCheckpoint: () => checkpoint,
      setCheckpoint(value) {
        checkpoint = value;
      },
    },
  });
  const subscriber: FragnoOutboxSubscriber = {
    target: usersTarget,
    apply(delivery) {
      applied.push(...delivery.changes.map((change) => change.key));
    },
    applyBatch(deliveries) {
      batches.push(deliveries.flatMap((delivery) => delivery.changes.map((change) => change.key)));
    },
    truncate() {},
    markReady() {
      readyCalls++;
    },
  };
  synchronizer.register(subscriber);
  return {
    synchronizer,
    subscriber,
    batches,
    applied,
    requests,
    getCheckpoint: () => checkpoint,
    readyCalls: () => readyCalls,
    setBody(value: ReadableStream<Uint8Array>) {
      body = value;
    },
    run: () => synchronizer.streamSession({ onStarted() {}, onCaughtUp() {} }),
  };
}

function checkpointFor(entry: FragnoOutboxEntry): FragnoOutboxCheckpoint {
  return { versionstamp: entry.versionstamp, uowId: entry.uowId };
}

function interruptedStream(entries: FragnoOutboxEntry[]): ReadableStream<Uint8Array> {
  const frames = [
    {
      type: "started",
      protocolVersion: 1,
      adapterIdentity: "test-adapter",
      catchUpTargetVersionstamp: outboxEntry(100).versionstamp,
      catchUpPageSize: 50,
    },
    ...entries.map((entry) => ({ type: "entry", entry })),
  ];
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(new TextEncoder().encode(`${JSON.stringify(frame)}\n`));
      }
      controller.close();
    },
  });
}

describe("FragnoOutboxSynchronizer stream sessions", () => {
  it.each(["prepare", "batch", "live", "ready"] as const)(
    "preserves subscriber %s failures as application errors",
    async (phase) => {
      const scenario = createScenario([outboxEntry(0)], undefined, [outboxEntry(1)]);
      const failure = new TypeError(`Subscriber ${phase} failed`);
      scenario.synchronizer.register({
        ...scenario.subscriber,
        async prepareCatchUp() {
          if (phase === "prepare") {
            throw failure;
          }
        },
        applyBatch(deliveries) {
          if (phase === "batch") {
            throw failure;
          }
          scenario.subscriber.applyBatch(deliveries);
        },
        apply(delivery) {
          if (phase === "live") {
            throw failure;
          }
          scenario.subscriber.apply(delivery);
        },
        markReady() {
          if (phase === "ready") {
            throw failure;
          }
          scenario.subscriber.markReady();
        },
      });
      await expect(scenario.run()).rejects.toBe(failure);
      expect(scenario.getCheckpoint()).toEqual(
        phase === "prepare" || phase === "batch" ? undefined : checkpointFor(outboxEntry(0)),
      );
      scenario.synchronizer.dispose();
    },
  );

  it.each(["started", "caught-up"] as const)(
    "does not swallow an unowned abort from the %s callback",
    async (phase) => {
      const scenario = createScenario();
      const failure = new DOMException("Callback was aborted independently", "AbortError");
      await expect(
        scenario.synchronizer.streamSession({
          onStarted() {
            if (phase === "started") {
              throw failure;
            }
          },
          onCaughtUp() {
            if (phase === "caught-up") {
              throw failure;
            }
          },
        }),
      ).rejects.toBe(failure);
      scenario.synchronizer.dispose();
    },
  );

  it("applies bounded catch-up batches then live entries on the same response", async () => {
    const scenario = createScenario(
      Array.from({ length: 51 }, (_, index) => outboxEntry(index)),
      undefined,
      [outboxEntry(51)],
    );
    await scenario.run();
    expect(scenario.batches.map((batch) => batch.length)).toEqual([50, 1]);
    expect(scenario.batches.flat()).toEqual(
      Array.from({ length: 51 }, (_, index) => `users-${index}`),
    );
    expect(scenario.applied).toEqual(["users-51"]);
    expect(scenario.getCheckpoint()).toEqual(checkpointFor(outboxEntry(51)));
    assert(scenario.readyCalls() === 1);
    expect(scenario.requests).toEqual([undefined]);
    scenario.synchronizer.dispose();
  });

  it("marks empty collections ready at the caught-up marker", async () => {
    const scenario = createScenario();
    await scenario.run();
    assert(scenario.readyCalls() === 1);
    expect(scenario.getCheckpoint()).toBeUndefined();
    scenario.synchronizer.dispose();
  });

  it("replays an aligned checkpoint without duplicating committed changes", async () => {
    const checkpoint = checkpointFor(outboxEntry(75));
    const scenario = createScenario(
      Array.from({ length: 51 }, (_, index) => outboxEntry(50 + index)),
      checkpoint,
    );
    await scenario.run();
    expect(scenario.requests).toEqual([outboxPageAfterVersionstamp(checkpoint.versionstamp)]);
    expect(scenario.batches.flat()).toEqual(
      Array.from({ length: 25 }, (_, index) => `users-${76 + index}`),
    );
    expect(scenario.getCheckpoint()).toEqual(checkpointFor(outboxEntry(100)));
    scenario.synchronizer.dispose();
  });

  it.each([1, 49, 99])("validates the exact UOW even at page boundary %s", async (version) => {
    const entry = outboxEntry(version);
    const scenario = createScenario([{ ...entry, uowId: "conflicting-uow" }], checkpointFor(entry));
    await expect(scenario.run()).rejects.toThrow("changed from UOW");
    expect(scenario.getCheckpoint()).toEqual(checkpointFor(entry));
    assert(scenario.readyCalls() === 0);
    scenario.synchronizer.dispose();
  });

  it("rejects a missing persisted checkpoint before applying newer entries", async () => {
    const scenario = createScenario([outboxEntry(2)], checkpointFor(outboxEntry(1)));
    await expect(scenario.run()).rejects.toThrow("checkpoint is missing");
    expect(scenario.batches).toEqual([]);
    scenario.synchronizer.dispose();
  });

  it("discards a partial catch-up batch on interruption and recovers on the next session", async () => {
    const scenario = createScenario();
    scenario.setBody(
      interruptedStream(Array.from({ length: 53 }, (_, index) => outboxEntry(index))),
    );
    await expect(scenario.run()).rejects.toThrow("closed unexpectedly");
    expect(scenario.getCheckpoint()).toEqual(checkpointFor(outboxEntry(49)));
    assert(scenario.readyCalls() === 0);
    scenario.setBody(
      createOutboxTestStream(Array.from({ length: 5 }, (_, index) => outboxEntry(49 + index))),
    );
    await scenario.run();
    expect(scenario.batches.map((batch) => batch.length)).toEqual([50, 4]);
    expect(scenario.getCheckpoint()).toEqual(checkpointFor(outboxEntry(53)));
    scenario.synchronizer.dispose();
  });

  it("commits a partial batch at planned rotation without claiming readiness", async () => {
    const scenario = createScenario();
    scenario.setBody(
      interruptedStream([outboxEntry(0), outboxEntry(1)]).pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            controller.enqueue(chunk);
          },
          flush(controller) {
            controller.enqueue(
              new TextEncoder().encode('{"type":"rotate","reason":"lease-expired"}\n'),
            );
          },
        }),
      ),
    );
    await scenario.run();
    expect(scenario.getCheckpoint()).toEqual(checkpointFor(outboxEntry(1)));
    assert(scenario.readyCalls() === 0);
    scenario.setBody(createOutboxTestStream([outboxEntry(1), outboxEntry(2), outboxEntry(3)]));
    await scenario.run();
    expect(scenario.batches).toEqual([
      ["users-0", "users-1"],
      ["users-2", "users-3"],
    ]);
    assert(scenario.readyCalls() === 1);
    scenario.synchronizer.dispose();
  });

  it("rejects a changed adapter identity before applying entries", async () => {
    const scenario = createScenario();
    scenario.setBody(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              JSON.stringify({
                type: "started",
                protocolVersion: 1,
                adapterIdentity: "other",
                catchUpTargetVersionstamp: null,
                catchUpPageSize: 50,
              }) + "\n",
            ),
          );
        },
      }),
    );
    await expect(scenario.run()).rejects.toThrow("adapter identity changed");
    assert(scenario.readyCalls() === 0);
    scenario.synchronizer.dispose();
  });

  it("recovers partial cross-collection commits without applying them twice", async () => {
    const entry = outboxEntry(1, ["users", "posts"]);
    const scenario = createScenario([entry]);
    let usersCheckpoint: FragnoOutboxCheckpoint | undefined;
    let usersApplied = 0;
    let failPosts = true;
    scenario.synchronizer.register({
      ...scenario.subscriber,
      applyBatch(deliveries) {
        for (const delivery of deliveries) {
          if (shouldApplyOutboxCheckpoint(usersCheckpoint, delivery.checkpoint)) {
            usersApplied++;
            usersCheckpoint = delivery.checkpoint;
          }
        }
      },
    });
    const posts: string[] = [];
    scenario.synchronizer.register({
      ...scenario.subscriber,
      target: postsTarget,
      applyBatch(deliveries) {
        if (failPosts) {
          throw new Error("posts failed");
        }
        posts.push(
          ...deliveries.flatMap((delivery) => delivery.changes.map((change) => change.key)),
        );
      },
    });
    await expect(scenario.run()).rejects.toThrow("posts failed");
    expect(scenario.getCheckpoint()).toBeUndefined();
    failPosts = false;
    scenario.setBody(createOutboxTestStream([entry]));
    await scenario.run();
    expect(usersApplied).toBe(1);
    expect(posts).toEqual(["posts-1"]);
    expect(scenario.getCheckpoint()).toEqual(checkpointFor(entry));
    scenario.synchronizer.dispose();
  });

  it("cancels active reads and rejects pending registrations on disposal", async () => {
    const scenario = createScenario();
    let cancelled = false;
    scenario.setBody(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
    );
    const pending = scenario.synchronizer.waitUntilRegistered([postsTarget.key]);
    const pendingRejection = expect(pending).rejects.toThrow("disposed");
    const session = scenario.run();
    await Promise.resolve();
    scenario.synchronizer.dispose();
    await expect(session).rejects.toMatchObject({ name: "AbortError" });
    await pendingRejection;
    assert(cancelled);
    assert(scenario.readyCalls() === 0);
  });

  it("protects replacement registrations when old subscribers unsubscribe", async () => {
    const scenario = createScenario();
    const unregister = scenario.synchronizer.register(scenario.subscriber);
    let calls = 0;
    scenario.synchronizer.register({
      ...scenario.subscriber,
      apply() {
        calls++;
      },
    });
    unregister();
    scenario.synchronizer.applyChanges(usersTarget.key, {
      checkpoint: checkpointFor(outboxEntry(0)),
      changes: [],
    });
    expect(calls).toBe(1);
    scenario.synchronizer.dispose();
  });
});
