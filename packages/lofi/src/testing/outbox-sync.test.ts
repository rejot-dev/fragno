import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  IDBCursor,
  IDBDatabase,
  IDBFactory,
  IDBIndex,
  IDBKeyRange,
  IDBObjectStore,
  IDBOpenDBRequest,
  IDBRequest,
  IDBTransaction,
} from "fake-indexeddb";
import { defineFragment, instantiate } from "@fragno-dev/core";
import {
  InMemoryAdapter,
  getInternalFragment,
  type ImplicitDatabaseDependencies,
  type InternalFragmentInstance,
  type OutboxEntry,
  withDatabase,
} from "@fragno-dev/db";
import { column, FragnoReference, idColumn, referenceColumn, schema } from "@fragno-dev/db/schema";
import { IndexedDbAdapter, LofiClient } from "../mod";

const appSchema = schema("app", (s) => {
  return s
    .addTable("users", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("email", column("string"))
        .addColumn("age", column("integer"))
        .createIndex("idx_email", ["email"], { unique: true })
        .createIndex("idx_age", ["age"]),
    )
    .addTable("posts", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("authorId", referenceColumn())
        .addColumn("title", column("string"))
        .createIndex("idx_author", ["authorId"]),
    )
    .addReference("author", {
      type: "one",
      from: { table: "posts", column: "authorId" },
      to: { table: "users", column: "id" },
    });
});

const fragmentName = "lofi-outbox-sync-test";
const fragmentDef = defineFragment(fragmentName).extend(withDatabase(appSchema)).build();

const createDbName = () => `lofi-outbox-${Math.random().toString(16).slice(2)}`;

type OutboxContext = {
  db: {
    create: (
      table: "users" | "posts",
      values: Record<string, unknown>,
    ) => Promise<{
      internalId?: bigint;
    }>;
  };
  internalFragment: InternalFragmentInstance;
  cleanup: () => Promise<void>;
};

async function buildOutboxContext(): Promise<OutboxContext> {
  const adapter = new InMemoryAdapter({
    idSeed: "lofi-outbox-seed",
  });

  const fragment = instantiate(fragmentDef)
    .withConfig({})
    .withRoutes([])
    .withOptions({ databaseAdapter: adapter, outbox: { enabled: true } })
    .build();

  const deps = fragment.$internal.deps as ImplicitDatabaseDependencies<typeof appSchema>;
  const db = deps.databaseAdapter.createQueryEngine(deps.schema, deps.namespace);

  return {
    db,
    internalFragment: getInternalFragment(adapter),
    cleanup: async () => {
      await adapter.close();
    },
  };
}

async function listOutbox(
  internalFragment: InternalFragmentInstance,
  options?: { afterVersionstamp?: string; limit?: number },
): Promise<OutboxEntry[]> {
  return internalFragment.inContext(async function () {
    return (await this.handlerTx()
      .withServiceCalls(() => [internalFragment.services.outboxService.list(options)] as const)
      .transform(({ serviceResult: [result] }) => result)
      .execute()) as OutboxEntry[];
  });
}

describe("outbox sync integration", () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    globalThis.IDBCursor = IDBCursor;
    globalThis.IDBDatabase = IDBDatabase;
    globalThis.IDBIndex = IDBIndex;
    globalThis.IDBKeyRange = IDBKeyRange;
    globalThis.IDBObjectStore = IDBObjectStore;
    globalThis.IDBOpenDBRequest = IDBOpenDBRequest;
    globalThis.IDBRequest = IDBRequest;
    globalThis.IDBTransaction = IDBTransaction;
  });

  it("syncs outbox entries into IndexedDB and advances the cursor", async () => {
    const { db, internalFragment, cleanup } = await buildOutboxContext();

    try {
      await db.create("users", { email: "alpha@example.com", age: 30 });
      const betaUserId = await db.create("users", { email: "beta@example.com", age: 20 });
      await db.create("users", { email: "gamma@example.com", age: 40 });

      if (!betaUserId.internalId) {
        throw new Error("Expected beta user to include internal id");
      }

      await db.create("posts", {
        title: "Hello",
        authorId: FragnoReference.fromInternal(betaUserId.internalId),
      });

      const expectedEntries = await listOutbox(internalFragment);
      const expectedStamps = expectedEntries.map((entry) => entry.versionstamp);

      const requests: Array<{ after: string | null; limit: string | null }> = [];

      const fetcher = vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(typeof input === "string" ? input : input.toString());
        const afterVersionstamp = url.searchParams.get("afterVersionstamp");
        const limitParam = url.searchParams.get("limit");
        requests.push({
          after: afterVersionstamp,
          limit: limitParam,
        });

        const limit = limitParam ? Number(limitParam) : expectedEntries.length;
        const startIndex = afterVersionstamp
          ? expectedEntries.findIndex((entry) => entry.versionstamp === afterVersionstamp) + 1
          : 0;
        const entries = expectedEntries.slice(startIndex, startIndex + limit);

        return new Response(JSON.stringify(entries), { status: 200 });
      });

      const adapter = new IndexedDbAdapter({
        dbName: createDbName(),
        endpointName: "app",
        schemas: [{ schema: appSchema }],
      });

      const onSyncApplied = vi.fn();
      const client = new LofiClient({
        outboxUrl: "https://example.com/outbox",
        endpointName: "app",
        adapter,
        fetch: fetcher as unknown as typeof fetch,
        limit: 1,
        onSyncApplied,
      });

      const result = await client.syncOnce();

      expect(result.appliedEntries).toBe(expectedEntries.length);
      expect(result.lastVersionstamp).toBe(expectedEntries.at(-1)?.versionstamp);
      expect(await adapter.getMeta("app::outbox")).toBe(expectedEntries.at(-1)?.versionstamp);
      expect(onSyncApplied).toHaveBeenCalledTimes(1);
      expect(onSyncApplied).toHaveBeenCalledWith(result);

      expect(requests).toHaveLength(expectedEntries.length + 1);
      expect(requests[0]?.after).toBeNull();
      expectedStamps.forEach((stamp, index) => {
        expect(requests[index + 1]?.after).toBe(stamp);
      });

      const query = adapter.createQueryEngine(appSchema);
      const ordered = await query.find("users", (b) =>
        b.whereIndex("idx_age").orderByIndex("idx_age", "asc"),
      );
      expect(ordered.map((row) => row.age)).toEqual([20, 30, 40]);

      const count = await query.find("users", (b) => b.whereIndex("idx_age").selectCount());
      expect(count).toBe(3);

      const joined = await query.find("posts", (b) =>
        b.whereIndex("idx_author").join((j) => j.author()),
      );
      expect(joined).toHaveLength(1);
      expect(joined[0].author?.email).toBe("beta@example.com");
    } finally {
      await cleanup();
    }
  });

  it("skips duplicate outbox entries when re-synced", async () => {
    const { db, internalFragment, cleanup } = await buildOutboxContext();

    try {
      await db.create("users", { email: "alpha@example.com", age: 30 });
      await db.create("users", { email: "beta@example.com", age: 20 });

      const expectedEntries = await listOutbox(internalFragment);

      const adapter = new IndexedDbAdapter({
        dbName: createDbName(),
        endpointName: "app",
        schemas: [{ schema: appSchema }],
      });

      const fetcher = vi.fn(
        async () => new Response(JSON.stringify(expectedEntries), { status: 200 }),
      );

      const onSyncApplied = vi.fn();
      const client = new LofiClient({
        outboxUrl: "https://example.com/outbox",
        endpointName: "app",
        adapter,
        fetch: fetcher as unknown as typeof fetch,
        limit: expectedEntries.length + 1,
        onSyncApplied,
      });

      const first = await client.syncOnce();
      expect(first.appliedEntries).toBe(expectedEntries.length);
      expect(onSyncApplied).toHaveBeenCalledTimes(1);

      const second = await client.syncOnce();
      expect(second.appliedEntries).toBe(0);
      expect(onSyncApplied).toHaveBeenCalledTimes(1);

      const query = adapter.createQueryEngine(appSchema);
      const count = await query.find("users", (b) => b.whereIndex("idx_age").selectCount());
      expect(count).toBe(2);
    } finally {
      await cleanup();
    }
  });
});
