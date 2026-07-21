import { assert, describe, expect, it, vi } from "vitest";

import type {
  PersistedCollectionPersistence,
  PersistedTx,
  PersistenceAdapter,
} from "@tanstack/db-sqlite-persistence-core";

import { PersistenceWriteTracker, trackPersistenceWrites } from "./persistence-tracker";

const persistedTransaction = (generation?: string): PersistedTx => ({
  txId: `tx-${generation ?? "rows"}`,
  term: 1,
  seq: 1,
  rowVersion: 1,
  mutations: [],
  collectionMetadataMutations: generation
    ? [{ type: "set", key: "checkpoint", value: { generation } }]
    : [],
});

const checkpointGenerationFromTx = (tx: PersistedTx): string | undefined => {
  const checkpoint = tx.collectionMetadataMutations?.find(
    (mutation) => mutation.type === "set" && mutation.key === "checkpoint",
  );
  if (!checkpoint || checkpoint.type !== "set") {
    return undefined;
  }
  const value = checkpoint.value;
  return typeof value === "object" && value !== null && "generation" in value
    ? String(value.generation)
    : undefined;
};

const createAdapter = (
  applyCommittedTx: PersistenceAdapter["applyCommittedTx"],
): PersistenceAdapter => ({
  loadSubset: async () => [],
  applyCommittedTx,
  ensureIndex: async () => {},
});

describe("PersistenceWriteTracker", () => {
  it("acknowledges only the checkpoint generation carried by the completed write", async () => {
    let completeFirstWrite!: () => void;
    let completeSecondWrite!: () => void;
    const firstWrite = new Promise<void>((resolve) => {
      completeFirstWrite = resolve;
    });
    const secondWrite = new Promise<void>((resolve) => {
      completeSecondWrite = resolve;
    });
    const tracker = new PersistenceWriteTracker(checkpointGenerationFromTx);
    const firstCheckpoint = tracker.waitForCheckpointCommit("leader:1");
    const secondCheckpoint = tracker.waitForCheckpointCommit("leader:2");

    void tracker.trackCommittedTransaction(persistedTransaction("leader:1"), firstWrite);
    void tracker.trackCommittedTransaction(persistedTransaction("leader:2"), secondWrite);

    completeSecondWrite();
    await expect(secondCheckpoint).resolves.toBeUndefined();
    let firstResolved = false;
    void firstCheckpoint.then(() => {
      firstResolved = true;
    });
    await Promise.resolve();
    assert(!firstResolved);

    completeFirstWrite();
    await expect(firstCheckpoint).resolves.toBeUndefined();
    await expect(tracker.waitForIdle()).resolves.toBeUndefined();
  });

  it("rejects the exact checkpoint and reports failed writes when idle is awaited", async () => {
    const failure = new Error("disk full");
    const tracker = new PersistenceWriteTracker(checkpointGenerationFromTx);
    const checkpoint = tracker.waitForCheckpointCommit("leader:1");
    const trackedWrite = tracker.trackCommittedTransaction(
      persistedTransaction("leader:1"),
      Promise.reject(failure),
    );

    await expect(checkpoint).rejects.toThrow("disk full");
    await expect(trackedWrite).rejects.toThrow("disk full");
    await expect(tracker.waitForIdle()).rejects.toEqual(
      expect.objectContaining({
        message: "Failed to persist one or more Fragno stream transactions.",
        errors: [failure],
      }),
    );
    await expect(tracker.waitForIdle()).resolves.toBeUndefined();
  });

  it("rejects pending checkpoint acknowledgments during shutdown", async () => {
    const tracker = new PersistenceWriteTracker(checkpointGenerationFromTx);
    const checkpoint = tracker.waitForCheckpointCommit("leader:1");

    tracker.rejectPendingCheckpointCommits(new Error("closed"));

    await expect(checkpoint).rejects.toThrow("closed");
  });
});

describe("trackPersistenceWrites", () => {
  it("tracks resolved adapters while preserving provider resolution and coordination", async () => {
    const applyCommittedTx = vi.fn(async () => {});
    const adapter = createAdapter(applyCommittedTx);
    const coordinator = {
      getNodeId: () => "node",
      subscribe: () => () => {},
      publish: () => {},
      isLeader: () => true,
      ensureLeadership: async () => {},
      requestEnsurePersistedIndex: async () => {},
    } satisfies NonNullable<PersistedCollectionPersistence["coordinator"]>;
    const persistence: PersistedCollectionPersistence = {
      adapter,
      coordinator,
      resolvePersistenceForCollection: () => persistence,
      resolvePersistenceForMode: () => persistence,
    };
    const tracker = new PersistenceWriteTracker(checkpointGenerationFromTx);
    const tracked = trackPersistenceWrites({ persistence, tracker });
    const resolvedForCollection = tracked.resolvePersistenceForCollection?.({
      collectionId: "source",
      mode: "sync-present",
      schemaVersion: 1,
    });
    const resolvedForMode = tracked.resolvePersistenceForMode?.("sync-present");

    assert(resolvedForCollection);
    assert(resolvedForMode);
    expect(resolvedForCollection).toBe(tracked);
    expect(resolvedForMode).toBe(tracked);
    expect(tracked.coordinator).toBe(coordinator);

    const checkpoint = tracker.waitForCheckpointCommit("leader:1");
    await tracked.adapter.applyCommittedTx("source", persistedTransaction("leader:1"));
    await checkpoint;

    expect(applyCommittedTx).toHaveBeenCalledOnce();
    await expect(tracker.waitForIdle()).resolves.toBeUndefined();
  });
});
