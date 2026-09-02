import { assert, describe, expect, it } from "vitest";

import {
  encodeVersionstamp,
  FRAGNO_OUTBOX_PAGE_SIZE,
  outboxPageAfterVersionstamp,
  versionstampToHex,
} from "@fragno-dev/db/outbox";
import { idColumn, schema } from "@fragno-dev/db/schema";
import superjson from "superjson";

import { shouldApplyOutboxCheckpoint, type FragnoOutboxCheckpoint } from "../checkpoint";
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

function outboxEntry(
  transactionVersion: bigint,
  tables: readonly ("users" | "posts")[] = ["users"],
): FragnoOutboxEntry {
  const versionstamp = versionstampToHex(encodeVersionstamp(transactionVersion, 0));
  return {
    versionstamp,
    uowId: `uow-${transactionVersion}`,
    payload: superjson.serialize({
      version: 2,
      operations: tables.map((table) => ({
        op: "create",
        schema: "blog",
        table,
        externalId: `${table}-${transactionVersion}`,
        versionstamp,
        values: {},
      })),
    }),
  };
}

function subscriber(
  options: {
    target?: FragnoOutboxSubscriber["target"];
    apply?: FragnoOutboxSubscriber["apply"];
    applyBatch?: FragnoOutboxSubscriber["applyBatch"];
    markReady?: FragnoOutboxSubscriber["markReady"];
  } = {},
): FragnoOutboxSubscriber {
  return {
    target: options.target ?? usersTarget,
    apply: options.apply ?? (() => {}),
    applyBatch:
      options.applyBatch ??
      ((deliveries) => {
        for (const delivery of deliveries) {
          options.apply?.(delivery);
        }
      }),
    truncate() {},
    markReady: options.markReady ?? (() => {}),
  };
}

function createSynchronizer(
  options: {
    pages?: FragnoOutboxEntry[][];
    checkpoint?: FragnoOutboxCheckpoint;
    stream?: ReadableStream<Uint8Array>;
  } = {},
) {
  const pages = [...(options.pages ?? [])];
  const requests: Array<{ afterVersionstamp?: string }> = [];
  const streamRequests: Array<{ afterVersionstamp?: string }> = [];
  let checkpoint = options.checkpoint;

  return {
    requests,
    streamRequests,
    getCheckpoint: () => checkpoint,
    synchronizer: new FragnoOutboxSynchronizer({
      fetcher: {
        async listOutbox(request) {
          requests.push({ afterVersionstamp: request.afterVersionstamp });
          return pages.shift() ?? [];
        },
        async openOutboxStream(request) {
          streamRequests.push({ afterVersionstamp: request.afterVersionstamp });
          return options.stream ?? ndjsonStream([]);
        },
      },
      checkpointStore: {
        getCheckpoint: () => checkpoint,
        setCheckpoint(nextCheckpoint) {
          checkpoint = nextCheckpoint;
        },
      },
    }),
  };
}

function ndjsonStream(entries: readonly FragnoOutboxEntry[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const entry of entries) {
        controller.enqueue(encoder.encode(`${JSON.stringify(entry)}\n`));
      }
      controller.close();
    },
  });
}

describe("FragnoOutboxSynchronizer", () => {
  it("waits for target subscriptions and protects replacement registrations", async () => {
    const { synchronizer } = createSynchronizer();
    const registered = synchronizer.waitUntilRegistered([usersTarget.key]);
    let appliedBy = "";

    const unregisterFirst = synchronizer.register(
      subscriber({
        apply() {
          appliedBy = "first";
        },
      }),
    );
    await registered;

    const unregisterSecond = synchronizer.register(
      subscriber({
        apply() {
          appliedBy = "second";
        },
      }),
    );
    unregisterFirst();

    const delivery = {
      checkpoint: { versionstamp: "0000000000000001", uowId: "uow-1" },
      changes: [],
    };
    synchronizer.applyChanges(usersTarget.key, delivery);
    assert.equal(appliedBy, "second");

    unregisterSecond();
    expect(() => synchronizer.applyChanges(usersTarget.key, delivery)).toThrow(
      "No Fragno collection is registered",
    );
    synchronizer.dispose();
  });

  it("groups decoded operations by registered physical target", async () => {
    const context = createSynchronizer({ pages: [[outboxEntry(1n)]] });
    let userDelivery: Parameters<FragnoOutboxSubscriber["apply"]>[0] | undefined;
    let postApplyCalls = 0;
    context.synchronizer.register(
      subscriber({
        apply(delivery) {
          userDelivery = delivery;
        },
      }),
    );
    context.synchronizer.register(
      subscriber({
        target: postsTarget,
        apply() {
          postApplyCalls += 1;
        },
      }),
    );

    await context.synchronizer.catchUp();

    expect(userDelivery).toMatchObject({
      checkpoint: {
        versionstamp: outboxEntry(1n).versionstamp,
        uowId: "uow-1",
      },
      changes: [
        {
          type: "insert",
          key: "users-1",
          value: { id: "users-1" },
        },
      ],
    });
    assert.equal(postApplyCalls, 0);
    context.synchronizer.dispose();
  });

  it("delivers each catch-up page once per target with entry and operation order intact", async () => {
    const firstEntry = outboxEntry(1n, ["users", "posts"]);
    const secondEntry = outboxEntry(2n, ["posts", "users"]);
    const context = createSynchronizer({ pages: [[firstEntry, secondEntry]] });
    const userBatches: Parameters<FragnoOutboxSubscriber["applyBatch"]>[0][] = [];
    const postBatches: Parameters<FragnoOutboxSubscriber["applyBatch"]>[0][] = [];
    context.synchronizer.register(
      subscriber({
        applyBatch(deliveries) {
          userBatches.push(deliveries);
        },
      }),
    );
    context.synchronizer.register(
      subscriber({
        target: postsTarget,
        applyBatch(deliveries) {
          postBatches.push(deliveries);
        },
      }),
    );

    await context.synchronizer.catchUp();

    assert.equal(userBatches.length, 1);
    assert.equal(postBatches.length, 1);
    expect(
      userBatches[0]!.map(({ checkpoint, changes }) => ({
        checkpoint,
        keys: changes.map((change) => change.key),
      })),
    ).toEqual([
      {
        checkpoint: { versionstamp: firstEntry.versionstamp, uowId: firstEntry.uowId },
        keys: ["users-1"],
      },
      {
        checkpoint: { versionstamp: secondEntry.versionstamp, uowId: secondEntry.uowId },
        keys: ["users-2"],
      },
    ]);
    expect(
      postBatches[0]!.map(({ checkpoint, changes }) => ({
        checkpoint,
        keys: changes.map((change) => change.key),
      })),
    ).toEqual([
      {
        checkpoint: { versionstamp: firstEntry.versionstamp, uowId: firstEntry.uowId },
        keys: ["posts-1"],
      },
      {
        checkpoint: { versionstamp: secondEntry.versionstamp, uowId: secondEntry.uowId },
        keys: ["posts-2"],
      },
    ]);
    context.synchronizer.dispose();
  });

  it("replays only collections that did not commit before another collection failed", async () => {
    const entry = outboxEntry(1n, ["users", "posts"]);
    let usersCheckpoint: FragnoOutboxCheckpoint | undefined;
    let postsCheckpoint: FragnoOutboxCheckpoint | undefined;
    let userApplyCalls = 0;
    let postApplyCalls = 0;

    const registerSubscribers = (synchronizer: FragnoOutboxSynchronizer, failPosts: boolean) => {
      synchronizer.register(
        subscriber({
          apply({ checkpoint }) {
            if (!shouldApplyOutboxCheckpoint(usersCheckpoint, checkpoint)) {
              return;
            }
            userApplyCalls += 1;
            usersCheckpoint = checkpoint;
          },
        }),
      );
      synchronizer.register(
        subscriber({
          target: postsTarget,
          apply({ checkpoint }) {
            postApplyCalls += 1;
            if (failPosts) {
              throw new Error("posts failed");
            }
            if (shouldApplyOutboxCheckpoint(postsCheckpoint, checkpoint)) {
              postsCheckpoint = checkpoint;
            }
          },
        }),
      );
    };

    const firstAttempt = createSynchronizer({ pages: [[entry]] });
    registerSubscribers(firstAttempt.synchronizer, true);
    await expect(firstAttempt.synchronizer.catchUp()).rejects.toThrow("posts failed");
    assert.equal(firstAttempt.getCheckpoint(), undefined);
    assert.equal(userApplyCalls, 1);
    assert.equal(postApplyCalls, 1);
    firstAttempt.synchronizer.dispose();

    const replay = createSynchronizer({ pages: [[entry]] });
    registerSubscribers(replay.synchronizer, false);
    await replay.synchronizer.catchUp();

    assert.equal(userApplyCalls, 1);
    assert.equal(postApplyCalls, 2);
    expect(replay.getCheckpoint()).toEqual({
      versionstamp: entry.versionstamp,
      uowId: entry.uowId,
    });
    replay.synchronizer.dispose();
  });

  it("streams from the exact catch-up checkpoint and advances it for live entries", async () => {
    const firstEntry = outboxEntry(1n);
    const liveEntry = outboxEntry(2n);
    const context = createSynchronizer({
      pages: [[firstEntry]],
      stream: ndjsonStream([firstEntry, liveEntry]),
    });
    const appliedCheckpoints: FragnoOutboxCheckpoint[] = [];
    let openCalls = 0;
    context.synchronizer.register(
      subscriber({
        apply({ checkpoint }) {
          appliedCheckpoints.push(checkpoint);
        },
      }),
    );

    await context.synchronizer.catchUp();
    await expect(
      context.synchronizer.stream({
        onOpen() {
          openCalls += 1;
        },
      }),
    ).rejects.toThrow("Fragno outbox stream closed unexpectedly");

    expect(context.streamRequests).toEqual([{ afterVersionstamp: firstEntry.versionstamp }]);
    expect(appliedCheckpoints).toEqual([
      { versionstamp: firstEntry.versionstamp, uowId: firstEntry.uowId },
      { versionstamp: liveEntry.versionstamp, uowId: liveEntry.uowId },
    ]);
    expect(context.getCheckpoint()).toEqual({
      versionstamp: liveEntry.versionstamp,
      uowId: liveEntry.uowId,
    });
    assert.equal(openCalls, 1);
    context.synchronizer.dispose();
  });

  it("rejects a streamed UOW that conflicts with the exact checkpoint", async () => {
    const firstEntry = outboxEntry(1n);
    const conflictingEntry = { ...firstEntry, uowId: "conflicting-uow" };
    const context = createSynchronizer({
      pages: [[firstEntry]],
      stream: ndjsonStream([conflictingEntry]),
    });
    context.synchronizer.register(subscriber());

    await context.synchronizer.catchUp();
    await expect(context.synchronizer.stream({ onOpen() {} })).rejects.toThrow(
      `Outbox versionstamp ${firstEntry.versionstamp} changed from UOW`,
    );
    expect(context.getCheckpoint()).toEqual({
      versionstamp: firstEntry.versionstamp,
      uowId: firstEntry.uowId,
    });
    context.synchronizer.dispose();
  });

  it("does not apply a catch-up page that resolves after disposal", async () => {
    let resolvePage!: (entries: FragnoOutboxEntry[]) => void;
    const page = new Promise<FragnoOutboxEntry[]>((resolve) => {
      resolvePage = resolve;
    });
    let markRequestStarted!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      markRequestStarted = resolve;
    });
    let checkpoint: FragnoOutboxCheckpoint | undefined;
    let applyCalls = 0;
    let readyCalls = 0;
    const synchronizer = new FragnoOutboxSynchronizer({
      fetcher: {
        listOutbox: async () => {
          markRequestStarted();
          return page;
        },
        openOutboxStream: async () => ndjsonStream([]),
      },
      checkpointStore: {
        getCheckpoint: () => checkpoint,
        setCheckpoint(nextCheckpoint) {
          checkpoint = nextCheckpoint;
        },
      },
    });
    synchronizer.register(
      subscriber({
        apply() {
          applyCalls += 1;
        },
        markReady() {
          readyCalls += 1;
        },
      }),
    );

    const catchUp = synchronizer.catchUp();
    await requestStarted;
    synchronizer.dispose();
    resolvePage([outboxEntry(1n)]);

    await expect(catchUp).rejects.toMatchObject({ name: "AbortError" });
    assert.equal(applyCalls, 0);
    assert.equal(readyCalls, 0);
    assert.equal(checkpoint, undefined);
  });

  it("aborts an active stream during disposal", async () => {
    let streamCancelled = false;
    const context = createSynchronizer({
      pages: [[]],
      stream: new ReadableStream<Uint8Array>({
        cancel() {
          streamCancelled = true;
        },
      }),
    });
    context.synchronizer.register(subscriber());
    await context.synchronizer.catchUp();
    let markOpened!: () => void;
    const opened = new Promise<void>((resolve) => {
      markOpened = resolve;
    });

    const streaming = context.synchronizer.stream({ onOpen: markOpened });
    await opened;
    context.synchronizer.dispose();

    await expect(streaming).rejects.toMatchObject({ name: "AbortError" });
    assert(streamCancelled);
  });

  it("starts from the aligned page and loops until a partial page", async () => {
    const pageStart = BigInt(FRAGNO_OUTBOX_PAGE_SIZE);
    const initialVersion = pageStart + BigInt(Math.floor(FRAGNO_OUTBOX_PAGE_SIZE / 2));
    const finalVersion = pageStart * 2n;
    const initialCheckpoint = {
      versionstamp: outboxEntry(initialVersion).versionstamp,
      uowId: `uow-${initialVersion}`,
    };
    const firstPage = Array.from({ length: FRAGNO_OUTBOX_PAGE_SIZE }, (_, index) =>
      outboxEntry(pageStart + BigInt(index)),
    );
    const finalPage = [outboxEntry(finalVersion)];
    const context = createSynchronizer({
      pages: [firstPage, finalPage],
      checkpoint: initialCheckpoint,
    });
    let appliedEntries = 0;
    let readyCalls = 0;
    context.synchronizer.register(
      subscriber({
        apply() {
          appliedEntries += 1;
        },
        markReady() {
          readyCalls += 1;
        },
      }),
    );

    await context.synchronizer.catchUp();

    expect(context.requests).toEqual([
      {
        afterVersionstamp: outboxPageAfterVersionstamp(initialCheckpoint.versionstamp),
      },
      { afterVersionstamp: outboxEntry(finalVersion - 1n).versionstamp },
    ]);
    assert.equal(appliedEntries, Number(finalVersion - initialVersion));
    assert.equal(readyCalls, 1);
    expect(context.getCheckpoint()).toEqual({
      versionstamp: outboxEntry(finalVersion).versionstamp,
      uowId: `uow-${finalVersion}`,
    });
    context.synchronizer.dispose();
  });

  it("starts without a cursor when no checkpoint exists", async () => {
    const context = createSynchronizer({ pages: [[outboxEntry(1n)]] });
    let ready = false;
    context.synchronizer.register(
      subscriber({
        markReady() {
          ready = true;
        },
      }),
    );

    await context.synchronizer.catchUp();

    expect(context.requests).toEqual([{ afterVersionstamp: undefined }]);
    assert(ready);
    expect(context.getCheckpoint()).toEqual({
      versionstamp: outboxEntry(1n).versionstamp,
      uowId: "uow-1",
    });
    context.synchronizer.dispose();
  });

  it("rejects an out-of-order page before advancing the checkpoint", async () => {
    const context = createSynchronizer({ pages: [[outboxEntry(2n), outboxEntry(1n)]] });
    context.synchronizer.register(subscriber());

    await expect(context.synchronizer.catchUp()).rejects.toThrow(
      "Fragno outbox page is not strictly ordered",
    );
    assert.equal(context.getCheckpoint(), undefined);
    context.synchronizer.dispose();
  });
});
