import { assert, describe, expect, it } from "vitest";

import { column, idColumn, schema } from "@fragno-dev/db/schema";
import Database from "better-sqlite3";
import superjson from "superjson";

import type { OutboxPayload } from "@fragno-dev/db";

import { createLiveQueryCollection } from "@tanstack/db";
import { createNodeSQLitePersistence } from "@tanstack/node-db-sqlite-persistence";

import {
  FRAGNO_OUTBOX_INITIALIZED_METADATA_KEY,
  FRAGNO_OUTBOX_SOURCE_METADATA_KEY,
  type FragnoOutboxSource,
} from "./checkpoint";
import { createFragnoOutboxCoordinator } from "./coordinator";
import { createPersistedFragnoCollectionFactory } from "./persistence";
import type { FragnoCollectionTarget, FragnoOutboxEntry } from "./protocol";
import type { FragnoOutboxStreamingTransport } from "./streaming-transport";

const appSchema = schema("app", (s) =>
  s
    .addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string")))
    .addTable("archivedUsers", (t) =>
      t.addColumn("id", idColumn()).addColumn("name", column("string")),
    ),
);

const COLLECTION_ID = "app.users";
const PERSISTENCE_TIMEOUT_MS = 1_000;

type AppTarget = FragnoCollectionTarget<typeof appSchema, "users" | "archivedUsers">;

type SourceRecreationCase = {
  first: {
    adapterIdentity: string;
    target: AppTarget;
    entry: FragnoOutboxEntry;
  };
  second: {
    adapterIdentity: string;
    target: AppTarget;
    entry: FragnoOutboxEntry;
  };
};

function createInsertEntry(options: {
  namespace?: string;
  table: "users" | "archivedUsers";
  id: string;
  name: string;
}): FragnoOutboxEntry {
  const payload = {
    version: 1,
    mutations: [
      {
        op: "create",
        schema: appSchema.name,
        ...(options.namespace === undefined ? {} : { namespace: options.namespace }),
        table: options.table,
        externalId: options.id,
        versionstamp: "000000000000000000000001",
        values: { name: options.name },
      },
    ],
  } satisfies OutboxPayload;

  return {
    versionstamp: "000000000000000000000001",
    uowId: `uow-${options.id}`,
    payload: superjson.serialize(payload),
  };
}

function createCoordinator(adapterIdentity: string, entry: FragnoOutboxEntry) {
  return createFragnoOutboxCoordinator({
    internalUrl: "https://example.com/_internal",
    pollIntervalMs: 60_000,
    transport: {
      async getAdapterIdentity() {
        return adapterIdentity;
      },
      async list({ afterVersionstamp }) {
        return afterVersionstamp && afterVersionstamp >= entry.versionstamp ? [] : [entry];
      },
    },
  });
}

async function waitForCollectionReady(collection: { readonly status: string }): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= PERSISTENCE_TIMEOUT_MS) {
    if (collection.status === "ready") {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error("Timed out waiting for the collection to become ready.");
}

async function waitForPersistedSource(
  persistence: ReturnType<typeof createNodeSQLitePersistence>,
  expectedSource: FragnoOutboxSource,
): Promise<void> {
  const adapter = persistence.adapter;
  if (!adapter.loadCollectionMetadata) {
    throw new Error("The persistence adapter does not support collection metadata.");
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt <= PERSISTENCE_TIMEOUT_MS) {
    const metadata = await adapter.loadCollectionMetadata(COLLECTION_ID);
    const source = metadata.find(({ key }) => key === FRAGNO_OUTBOX_SOURCE_METADATA_KEY)?.value;
    if (JSON.stringify(source) === JSON.stringify(expectedSource)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error(`Timed out waiting for persisted source ${JSON.stringify(expectedSource)}.`);
}

async function waitForPersistedInitialization(
  persistence: ReturnType<typeof createNodeSQLitePersistence>,
): Promise<void> {
  const adapter = persistence.adapter;
  if (!adapter.loadCollectionMetadata) {
    throw new Error("The persistence adapter does not support collection metadata.");
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt <= PERSISTENCE_TIMEOUT_MS) {
    const metadata = await adapter.loadCollectionMetadata(COLLECTION_ID);
    if (
      metadata.find(({ key }) => key === FRAGNO_OUTBOX_INITIALIZED_METADATA_KEY)?.value === true
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error("Timed out waiting for persisted Fragno outbox initialization.");
}

async function waitForPersistedRowIds(
  persistence: ReturnType<typeof createNodeSQLitePersistence>,
  expectedIds: string[],
): Promise<void> {
  const adapter = persistence.adapter;
  if (!adapter.scanRows) {
    throw new Error("The persistence adapter does not support scanning rows.");
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt <= PERSISTENCE_TIMEOUT_MS) {
    const rows = await adapter.scanRows(COLLECTION_ID);
    const rowIds = rows.map(({ key }) => String(key)).sort();
    if (JSON.stringify(rowIds) === JSON.stringify([...expectedIds].sort())) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error(`Timed out waiting for persisted rows ${expectedIds.join(", ")}.`);
}

async function runSourceRecreationTest(testCase: SourceRecreationCase): Promise<void> {
  const database = new Database(":memory:");
  const persistence = createNodeSQLitePersistence({ database });
  const createPersistedCollection = createPersistedFragnoCollectionFactory({
    persistence,
    schemaVersion: 1,
  });

  try {
    const firstCoordinator = createCoordinator(
      testCase.first.adapterIdentity,
      testCase.first.entry,
    );
    const firstCollection = createPersistedCollection({
      id: COLLECTION_ID,
      coordinator: firstCoordinator,
      target: testCase.first.target,
    });
    try {
      await Promise.all([firstCollection.preload(), firstCollection.utils.initialSync()]);
      await waitForCollectionReady(firstCollection);
      await waitForPersistedRowIds(persistence, ["stale-user"]);
    } finally {
      await firstCollection.cleanup();
      firstCoordinator.dispose();
    }

    const secondCoordinator = createCoordinator(
      testCase.second.adapterIdentity,
      testCase.second.entry,
    );
    const secondCollection = createPersistedCollection({
      id: COLLECTION_ID,
      coordinator: secondCoordinator,
      target: testCase.second.target,
    });
    try {
      await Promise.all([secondCollection.preload(), secondCollection.utils.initialSync()]);
      await waitForCollectionReady(secondCollection);
      await waitForPersistedRowIds(persistence, ["current-user"]);

      expect(secondCollection.get("stale-user")).toBeUndefined();
      expect(secondCollection.get("current-user")).toMatchObject({
        id: "current-user",
        name: "Current",
      });

      const adapter = persistence.adapter;
      if (!adapter.loadCollectionMetadata) {
        throw new Error("The persistence adapter does not support collection metadata.");
      }
      const metadata = await adapter.loadCollectionMetadata(COLLECTION_ID);
      const source = metadata.find(({ key }) => key === FRAGNO_OUTBOX_SOURCE_METADATA_KEY)?.value as
        | FragnoOutboxSource
        | undefined;
      expect(source).toEqual({
        adapterIdentity: testCase.second.adapterIdentity,
        namespace:
          testCase.second.target.namespace === null
            ? ""
            : (testCase.second.target.namespace ?? appSchema.name),
        table: testCase.second.target.table,
      });
    } finally {
      await secondCollection.cleanup();
      secondCoordinator.dispose();
    }
  } finally {
    database.close();
  }
}

describe("persisted Fragno collection factory", () => {
  it("creates a persisted collection while preserving Fragno synchronization utilities", async () => {
    const database = new Database(":memory:");
    const coordinator = createFragnoOutboxCoordinator({
      internalUrl: "https://example.com/_internal",
      pollIntervalMs: 60_000,
      transport: {
        async getAdapterIdentity() {
          return "adapter-1";
        },
        async list() {
          return [];
        },
      },
    });
    const persistence = createNodeSQLitePersistence({ database });
    const createPersistedCollection = createPersistedFragnoCollectionFactory({
      persistence,
      schemaVersion: 1,
    });
    const users = createPersistedCollection({
      id: COLLECTION_ID,
      coordinator,
      target: { schema: appSchema, table: "users" },
    });

    await Promise.all([users.preload(), users.utils.initialSync()]);
    await waitForCollectionReady(users);
    await waitForPersistedSource(persistence, {
      adapterIdentity: "adapter-1",
      namespace: appSchema.name,
      table: "users",
    });
    await waitForPersistedInitialization(persistence);
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert(users.id === COLLECTION_ID);
    assert(users.utils.getSyncStatus() === "ready");
    expect(users.utils.getCheckpoint()).toBeUndefined();

    await users.cleanup();
    coordinator.dispose();
    database.close();
  });

  it("hydrates an initialized snapshot without waiting for outbox availability", async () => {
    const database = new Database(":memory:");
    const persistence = createNodeSQLitePersistence({ database });
    const createPersistedCollection = createPersistedFragnoCollectionFactory({
      persistence,
      schemaVersion: 1,
    });
    const entry = createInsertEntry({ table: "users", id: "local-user", name: "Local" });
    const initialCoordinator = createCoordinator("adapter-1", entry);
    const initialCollection = createPersistedCollection({
      id: COLLECTION_ID,
      coordinator: initialCoordinator,
      target: { schema: appSchema, table: "users" },
    });

    try {
      await Promise.all([initialCollection.preload(), initialCollection.utils.initialSync()]);
      await waitForPersistedRowIds(persistence, ["local-user"]);
    } finally {
      await initialCollection.cleanup();
      initialCoordinator.dispose();
    }

    let listRequests = 0;
    let streamRequests = 0;
    const unavailableTransport: FragnoOutboxStreamingTransport = {
      async getAdapterIdentity() {
        throw new Error("The persisted source should use supplied bootstrap identity.");
      },
      async list() {
        listRequests += 1;
        throw new Error("The persisted snapshot should not require outbox history.");
      },
      async stream() {
        streamRequests += 1;
        throw new Error("The stream is offline.");
      },
    };
    const offlineCoordinator = createFragnoOutboxCoordinator({
      internalUrl: "https://example.com/_internal",
      bootstrap: { adapterIdentity: "adapter-1" },
      transport: unavailableTransport,
      onError() {},
    });
    const offlineCollection = createPersistedCollection({
      id: COLLECTION_ID,
      coordinator: offlineCoordinator,
      target: { schema: appSchema, table: "users" },
    });

    const localUsers = createLiveQueryCollection((query) =>
      query.from({ user: offlineCollection }).orderBy(({ user }) => user.name, "asc"),
    );

    try {
      await Promise.all([
        offlineCollection.preload(),
        offlineCollection.utils.initialSync(),
        localUsers.preload(),
      ]);
      await waitForCollectionReady(offlineCollection);

      expect([...localUsers.values()]).toEqual([
        expect.objectContaining({ id: "local-user", name: "Local" }),
      ]);
      expect(listRequests).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(streamRequests).toBeGreaterThan(0);
    } finally {
      await localUsers.cleanup();
      await offlineCollection.cleanup();
      offlineCoordinator.dispose();
      database.close();
    }
  });

  it("truncates stale rows and replays history when the adapter identity changes", async () => {
    await runSourceRecreationTest({
      first: {
        adapterIdentity: "adapter-1",
        target: { schema: appSchema, table: "users" },
        entry: createInsertEntry({ table: "users", id: "stale-user", name: "Stale" }),
      },
      second: {
        adapterIdentity: "adapter-2",
        target: { schema: appSchema, table: "users" },
        entry: createInsertEntry({ table: "users", id: "current-user", name: "Current" }),
      },
    });
  });

  it("truncates stale rows and replays history when the target namespace changes", async () => {
    await runSourceRecreationTest({
      first: {
        adapterIdentity: "adapter-1",
        target: { schema: appSchema, table: "users", namespace: "tenant-a" },
        entry: createInsertEntry({
          namespace: "tenant-a",
          table: "users",
          id: "stale-user",
          name: "Stale",
        }),
      },
      second: {
        adapterIdentity: "adapter-1",
        target: { schema: appSchema, table: "users", namespace: "tenant-b" },
        entry: createInsertEntry({
          namespace: "tenant-b",
          table: "users",
          id: "current-user",
          name: "Current",
        }),
      },
    });
  });

  it("truncates stale rows and replays history when the target table changes", async () => {
    await runSourceRecreationTest({
      first: {
        adapterIdentity: "adapter-1",
        target: { schema: appSchema, table: "users" },
        entry: createInsertEntry({ table: "users", id: "stale-user", name: "Stale" }),
      },
      second: {
        adapterIdentity: "adapter-1",
        target: { schema: appSchema, table: "archivedUsers" },
        entry: createInsertEntry({
          table: "archivedUsers",
          id: "current-user",
          name: "Current",
        }),
      },
    });
  });
});
